/**
 * Agent loop: observe -> decide -> act -> broadcast, via the shared store.
 *
 * Port of kiro-flock `agent/agentLoop.ts`. The AWS version drives a headless
 * Kiro CLI session over ACP; here the "model turn" is an injected `runner`
 * function so the loop stays backend-agnostic and testable without a model.
 *
 * Preserved behaviours from the reference:
 *   - fresh session every iteration (the drift control)
 *   - re-read config each iteration so algorithm/radius/swarmK hot-reload
 *   - state machine: starting -> running; paused slows to a poll
 *   - autopause after every visible agent reports idle N times running
 *   - the log line is the only coordination message
 */
import fs from "node:fs";
import path from "node:path";
import {
  appendLog,
  clusterPaths,
  readConfig,
  readDirection,
  readDirective,
  readState,
  tailLog,
  writeStateConditional,
} from "./store.js";
import { selectNeighbours } from "./neighbours.js";

const PAUSE_POLL_INTERVAL_MS = 2_000;
/** How often an idle agent re-checks the logs when nothing has changed. */
const WATCH_POLL_INTERVAL_MS = 250;
const AUTOPAUSE_THRESHOLD = 3;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Assemble the per-iteration prompt. Rebuilt every turn so the algorithm
 * fragment and neighbour list always match current state.
 */
export function buildPrompt({
  n,
  clusterId,
  paths,
  neighbours,
  algorithm,
  direction,
  neighbourTails,
  directive,
  loopInstructions,
  algorithmFragment,
}) {
  const header = [
    `You are agent-${n} in cluster "${clusterId}".`,
    `Your direction file is: ${paths.direction}`,
    `Your log file is: ${paths.logOf(n)}`,
    `Your environment directory is: ${paths.env}`,
    `Follow your agent loop prompt instructions.`,
  ].join("\n");

  const dirBlock = direction.trim()
    ? `\n\n## Direction (the goal — the path is yours)\n\n${direction.trim()}\n`
    : `\n\n## Direction\n\nThe direction file is empty. Do not invent a goal; report idle.\n`;

  const neighboursBlock =
    neighbours.length === 0
      ? `\n\n## Neighbours\n\nYou have no visible neighbours this iteration. Work from the direction alone, or go idle.\n`
      : `\n\n## What your neighbours last did\n\n${neighbours
          .map((i) => {
            const t = neighbourTails[i];
            if (!t) return `- agent-${i}: (no log yet)`;
            return `- agent-${i} [iteration ${t.iteration}, action=${t.action}]: ${t.result}  -> next_intent: ${t.next_intent}`;
          })
          .join("\n")}\n`;

  const directiveBlock = directive
    ? `\n\n## Per-Agent Directive (PRIORITY — act on this)\n\n${directive}\n`
    : "";

  return [
    header,
    dirBlock,
    neighboursBlock,
    directiveBlock,
    `\n\n## Algorithm\n\n${algorithmFragment}\n`,
    `\n\n## Instructions\n\n${loopInstructions}\n`,
    `\n\n## Required output\n\n` +
      `Respond with a single JSON object and nothing else:\n` +
      `{"action":"<short verb phrase>","result":"<what you produced>","next_intent":"<what you intend next>",` +
      `"artifact":{"name":"<file.md>","content":"<the full file text>"}}\n\n` +
      `The \`artifact\` field is how your work reaches the cluster. The harness writes\n` +
      `\`content\` to \`<your environment directory>/<name>\` on your behalf so peers can\n` +
      `read it next iteration. Describing a file without emitting its content creates\n` +
      `nothing — if \`artifact\` is absent, no file is written. Always include\n` +
      `\`artifact\` when you produce substantive work.\n\n` +
      `Use {"action":"idle","result":"<why>","next_intent":"remain idle unless the direction changes"} ` +
      `(no artifact) if you have nothing to add.\n`,
  ].join("");
}


/**
 * Is this action an abstention? Models write "idle", but also
 * "idle — both neighbours converged" or "Idle". An exact === "idle" test
 * silently misses every one of those, which made a converged cluster report
 * 0 idle agents. Match on the leading word instead.
 */
export function isIdleAction(action) {
  if (typeof action !== "string") return false;
  return /^idle\b/i.test(action.trim());
}

/**
 * Turn a model-proposed filename into a safe basename inside the environment
 * directory. Models emit absolute paths, "../" escapes, and bare prose; only a
 * flat, sanitized name is allowed to land on disk.
 */
export function sanitizeArtifactName(name, agentIndex, iteration) {
  const fallback = `agent-${agentIndex}-iteration-${iteration}.md`;
  if (typeof name !== "string" || name.trim() === "") return fallback;
  let base = path.basename(name.trim().replace(/\\/g, "/"));
  base = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (base === "" || base === "." || base === "..") return fallback;
  if (!/\.[A-Za-z0-9]+$/.test(base)) base += ".md";
  return base.slice(0, 120);
}

/** Tolerant JSON extraction — models wrap JSON in prose or fences. */
export function parseAgentReply(text) {
  if (typeof text !== "string") return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const braced = text.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);
  candidates.push(text);
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (o && typeof o === "object" && typeof o.action === "string") {
        const out = {
          action: String(o.action).trim(),
          result: String(o.result ?? "").trim(),
          next_intent: String(o.next_intent ?? "").trim(),
        };
        // The artifact is the actual work product. Accept the documented
        // {name, content} shape, and tolerate a bare string body since models
        // drift on nested objects.
        const a = o.artifact;
        if (a && typeof a === "object" && typeof a.content === "string" && a.content.trim() !== "") {
          out.artifact = { name: String(a.name ?? "").trim(), content: a.content };
        } else if (typeof a === "string" && a.trim() !== "") {
          out.artifact = { name: "", content: a };
        }
        return out;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

export function loadPrompts(promptDir, algorithm) {
  const read = (f) => fs.readFileSync(path.join(promptDir, f), "utf8");
  return {
    loopInstructions: read("agent-loop.md"),
    algorithmFragment: read(`algorithms/${algorithm}.md`),
  };
}

/**
 * Run one agent until shutdown. `runner({prompt, iteration, agentIndex})`
 * returns the model's raw text (or an already-parsed object).
 */
export async function runAgent({
  root,
  clusterId,
  n,
  concurrency,
  defaults,
  runner,
  promptDir,
  signal,
  onEvent = () => {},
  /** Stop this agent after N iterations (0/undefined = unlimited). */
  maxIterations = 0,
}) {
  const paths = clusterPaths(root, clusterId, concurrency);
  let consecutiveAllIdle = 0;
  let iteration = 0;
  // Signature of the last neighbourhood this agent actually reasoned about.
  let lastSignature = null;
  let currentNeighbours = selectNeighbours({
    algorithm: defaults.algorithm,
    agentIndex: n,
    concurrency,
    radius: defaults.neighbourRadius,
    swarmK: defaults.swarmK,
    paths,
  });

  while (!signal.aborted) {
    if (maxIterations > 0 && iteration >= maxIterations) {
      onEvent({ type: "exit", n, reason: "max-iterations" });
      return { n, iterations: iteration, reason: "max-iterations" };
    }
    // --- between-iteration state machine -------------------------------
    const state = readState(paths);
    if (state.state === "stopped" || state.state === "stopping") {
      onEvent({ type: "exit", n, reason: state.state });
      return { n, iterations: iteration, reason: state.state };
    }
    if (state.state === "paused") {
      // An operator-driven pause (or autopause) is a parking state: the
      // cluster is still live and may be resumed, so poll. A pause reached
      // by convergence is terminal — every visible agent already reported
      // idle, so there is no work that could arrive. Exit instead of
      // spinning forever.
      if (state.reason === "converged" || state.reason === "autopause") {
        onEvent({ type: "exit", n, reason: state.reason });
        return { n, iterations: iteration, reason: state.reason };
      }
      await sleep(PAUSE_POLL_INTERVAL_MS, signal);
      continue;
    }
    if (state.state === "starting") {
      writeStateConditional(
        paths,
        { state: "running", transitionedAt: new Date().toISOString(), transitionedBy: `agent-${n}` },
        "starting",
      );
    }

    // --- hot-reload config each iteration ------------------------------
    const cfg = readConfig(paths, defaults);
    if (cfg.algorithm !== defaults.algorithm || cfg.neighbourRadius !== defaults.neighbourRadius) {
      currentNeighbours = selectNeighbours({
        algorithm: cfg.algorithm,
        agentIndex: n,
        concurrency,
        radius: cfg.neighbourRadius,
        swarmK: cfg.swarmK,
        paths,
      });
      onEvent({ type: "topology", n, algorithm: cfg.algorithm, neighbours: currentNeighbours });
    }

    // --- new-information gate -------------------------------------------
    // If this agent's own last line is already "idle" and nothing in its
    // visible neighbourhood has changed since it last looked, there is no new
    // signal to reason about. Re-asking the model would burn a call and append
    // an identical idle line — the log would fill with duplicates while the
    // cluster waits for a late peer. Watch instead.
    const myTail = tailLog(paths, n);
    const observedNow = {
      self: myTail ? `${myTail.iteration}:${myTail.action}` : null,
      peers: currentNeighbours.map((i) => {
        const t = tailLog(paths, i);
        return `${i}:${t ? `${t.iteration}:${t.action}` : "-"}`;
      }),
    };
    const signature = JSON.stringify(observedNow);
    if (myTail && isIdleAction(myTail.action) && signature === lastSignature) {
      await sleep(WATCH_POLL_INTERVAL_MS, signal);
      continue;
    }
    lastSignature = signature;

    const { loopInstructions, algorithmFragment } = loadPrompts(promptDir, cfg.algorithm);
    const direction = readDirection(paths);
    const neighbourTails = {};
    for (const i of currentNeighbours) neighbourTails[i] = tailLog(paths, i);

    const prompt = buildPrompt({
      n,
      clusterId,
      paths,
      neighbours: currentNeighbours,
      algorithm: cfg.algorithm,
      direction,
      neighbourTails,
      directive: readDirective(paths, n),
      loopInstructions,
      algorithmFragment,
    });

    // --- one fresh session, no memory of prior iterations ---------------
    let entry = null;
    let failure = null;
    try {
      const reply = await runner({ prompt, iteration, agentIndex: n, clusterId });
      entry = typeof reply === "string" ? parseAgentReply(reply) : reply;
      if (!entry) failure = `unparseable model output: ${String(reply).slice(0, 160)}`;
    } catch (err) {
      failure = String(err?.message ?? err);
      onEvent({ type: "error", n, iteration, error: failure, err });
    }
    if (!entry) {
      // The real cause goes into the log line. Collapsing every failure into
      // "unparseable output" once hid a gateway outage (HTTP 503) behind a
      // parse error and cost a debugging cycle; never do that again.
      entry = {
        action: "error",
        result: failure ? failure.slice(0, 300) : "model turn failed",
        next_intent: "retry next iteration",
      };
    }

    // --- materialize the artifact ---------------------------------------
    // An agent with no file-writing tool can only *describe* its output. This
    // harness writes what the agent returns, so the shared environment holds
    // real bytes that peers can actually read. Without this the log claims
    // work that does not exist and the blackboard is empty.
    let artifactPath = null;
    if (entry.artifact) {
      const safe = sanitizeArtifactName(entry.artifact.name, n, iteration);
      artifactPath = path.join(paths.env, safe);
      fs.writeFileSync(artifactPath, entry.artifact.content, "utf8");
      onEvent({ type: "artifact", n, iteration, path: artifactPath, bytes: entry.artifact.content.length });
    }

    // The log records STATE TRANSITIONS, not heartbeats. Re-appending "idle"
    // when the agent is already idle is not just noise: every peer reads the
    // tail, so each duplicate flips every neighbour's signature and wakes the
    // whole cluster to reason about a change that did not happen. That
    // feedback loop is what made a 4-agent cluster burn ~400 model calls to
    // do nothing. Append only when the state actually moves.
    const wasIdle = isIdleAction(myTail?.action);
    const stillIdle = isIdleAction(entry.action);
    let line = null;
    if (!(wasIdle && stillIdle)) {
      line = appendLog(paths, n, { iteration, ...entry, artifact: artifactPath ? path.basename(artifactPath) : undefined });
      onEvent({ type: "line", n, iteration, line });
    } else {
      onEvent({ type: "idle-repeat", n, iteration });
    }

    // --- autopause: everyone visible idle N times running --------------
    if (cfg.autopause !== false) {
      const visible = [n, ...currentNeighbours];
      const tails = visible.map((i) => tailLog(paths, i));
      const everyoneVisible = tails.every((t) => t !== null);
      const allIdle = everyoneVisible && tails.every((t) => isIdleAction(t.action));
      consecutiveAllIdle = allIdle ? consecutiveAllIdle + 1 : 0;
      if (consecutiveAllIdle >= AUTOPAUSE_THRESHOLD) {
        const flipped = writeStateConditional(
          paths,
          {
            state: "paused",
            transitionedAt: new Date().toISOString(),
            transitionedBy: `agent-${n}`,
            reason: "autopause",
          },
          "running",
        );
        onEvent({ type: "autopause", n, flipped });
        // Paused because everyone visible is idle: this agent has no work
        // left and nothing new can arrive without an operator transition.
        // Exit rather than poll, so the cluster shuts down on its own.
        return { n, iterations: iteration + 1, reason: "autopause" };
      }
    }

    // --- convergence exit ----------------------------------------------
    // An agent that is itself idle while every peer it can see is also idle
    // has nothing left to do. The AWS deployment leaves such an agent
    // running until systemd reaps it; locally we exit cleanly so a cluster
    // terminates on its own without anyone telling it that it is done.
    if (cfg.autopause !== false && isIdleAction(entry.action)) {
      const visible = [n, ...currentNeighbours];
      const tails = visible.map((i) => tailLog(paths, i));
      const allIdle = tails.every((t) => t !== null && isIdleAction(t.action));
      if (allIdle && tails.length > 1) {
        // Park the cluster in the same terminal state autopause uses, so a
        // converged run and an autopaused run are indistinguishable to the
        // operator. Whoever wins the conditional write is the one recorded.
        writeStateConditional(
          paths,
          {
            state: "paused",
            transitionedAt: new Date().toISOString(),
            transitionedBy: `agent-${n}`,
            reason: "converged",
          },
          "running",
        );
        onEvent({ type: "converged", n, iteration });
        return { n, iterations: iteration + 1, reason: "converged" };
      }
    }

    iteration += 1;
    if (signal.aborted) break;
    await sleep(Math.max(0, (cfg.loopIntervalSeconds ?? 0) * 1000), signal);
  }

  return { n, iterations: iteration, reason: "aborted" };
}
