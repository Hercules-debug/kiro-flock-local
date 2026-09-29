/**
 * Cluster launcher and live dashboard.
 *
 * The operator writes ONE direction file, starts the cluster, and assigns
 * nothing else. Everything after that is read from the shared store.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clusterPaths, readConfig, readState, readLog, writeConfig, writeDirection, writeState } from "./store.js";
import { selectNeighbours, convergenceEstimate, ALGORITHMS } from "./neighbours.js";
import { runAgent, isIdleAction } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.resolve(__dirname, "..", "prompts");

export const DEFAULT_CONFIG = {
  algorithm: "amorphous",
  neighbourRadius: 1,
  swarmK: 3,
  loopIntervalSeconds: 0,
  autopause: true,
};

/**
 * Compose a cluster: write the direction, seed config/state, and start N
 * agent loops. No task assignment happens here — that is the whole point.
 */
export async function startCluster({
  root,
  clusterId,
  direction,
  concurrency,
  config = {},
  runner,
  signal,
  onEvent = () => {},
  promptDir = PROMPT_DIR,
  /** Max model calls in flight across the whole cluster. */
  maxInflight = 3,
  /** Delay between starting successive agents, to soften the opening burst. */
  staggerMs = 150,
  /** Per-agent iteration cap (0 = unlimited). */
  maxIterations = 0,
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const paths = clusterPaths(root, clusterId, concurrency);

  if (direction !== undefined) writeDirection(paths, direction);
  writeConfig(paths, cfg);
  writeState(paths, "starting", "operator");
  // Archive carry-over: stale artifacts from a previous run must not be read
  // as current context. Mirrors the AWS "carry-over" failure mode.
  const history = path.join(paths.base, "history");
  fs.mkdirSync(history, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of fs.readdirSync(paths.env)) {
    if (f === ".gitkeep") continue;
    fs.renameSync(path.join(paths.env, f), path.join(history, `${stamp}__${f}`));
  }

  // Wrap the runner in a shared semaphore. Agents are independent loops, but
  // they all call the same model endpoint; a cluster of N firing at once
  // exhausts a shared gateway (503 no_healthy_account) and every agent logs an
  // error. The limit bounds in-flight model calls, not cluster size — the
  // topology and the logs are unaffected.
  const limitedRunner = withConcurrencyLimit(runner, maxInflight);
  onEvent({
    type: "start",
    clusterId,
    concurrency,
    algorithm: cfg.algorithm,
    radius: cfg.neighbourRadius,
    maxInflight,
  });

  const tasks = [];
  for (let n = 0; n < concurrency; n++) {
    tasks.push(
      runAgent({
        root,
        clusterId,
        n,
        concurrency,
        defaults: cfg,
        runner: limitedRunner,
        promptDir,
        signal,
        onEvent,
        maxIterations,
      }),
    );
    // Stagger first turns slightly so the opening burst does not arrive in the
    // same millisecond. Later iterations are naturally desynchronised.
    if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs));
  }
  const results = await Promise.allSettled(tasks);
  return { clusterId, results, paths };
}

/**
 * Bound the number of model calls in flight. Queued calls run in FIFO order.
 */
export function withConcurrencyLimit(fn, limit) {
  if (!limit || limit <= 0) return fn;
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { args, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(() => fn(args))
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  const wrapped = (args) => {
    if (active < limit) {
      active++;
      return Promise.resolve()
        .then(() => fn(args))
        .finally(() => {
          active--;
          next();
        });
    }
    return new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject });
    });
  };
  wrapped.stats = () => ({ active, queued: queue.length, limit });
  return wrapped;
}

/** Dump a snapshot of the cluster: state, config, and per-agent last lines. */
export function snapshot(root, clusterId, concurrency) {
  const paths = clusterPaths(root, clusterId, concurrency);
  const cfg = readConfig(paths, DEFAULT_CONFIG);
  const state = readState(paths);
  const agents = [];
  for (let n = 0; n < concurrency; n++) {
    const log = readLog(paths, n);
    agents.push({ n, entries: log.length, last: log[log.length - 1] ?? null });
  }
  const idle = agents.filter((a) => isIdleAction(a.last?.action)).length;
  const reported = agents.filter((a) => a.last !== null).length;
  return { clusterId, state: state.state, config: cfg, agents, idle, reported, converged: reported > 0 && idle === reported };
}

/** Render the dashboard as plain text — the local analogue of the web panel. */
export function render(snap) {
  const lines = [];
  const { propagation, consensusLow, consensusHigh } = convergenceEstimate(
    snap.agents.length,
    snap.config.neighbourRadius,
  );
  lines.push(`cluster ${snap.clusterId}  state=${snap.state}  algorithm=${snap.config.algorithm}  radius=${snap.config.neighbourRadius}`);
  lines.push(`convergence: propagate ${propagation} iterations, consensus ${consensusLow}-${consensusHigh}`);
  lines.push(`progress: ${snap.reported}/${snap.agents.length} reported, ${snap.idle} idle`);
  lines.push("");
  for (const a of snap.agents) {
    const short = (s, w) => (s.length > w ? s.slice(0, w - 1) + "…" : s);
    if (!a.last) lines.push(`  agent-${a.n}  (no log yet)`);
    else
      lines.push(
        `  agent-${a.n}  it=${String(a.last.iteration).padStart(2)}  ` +
          `${short(a.last.action, 26).padEnd(27)} ${short(a.last.result, 62)}`,
      );
  }
  return lines.join("\n");
}
