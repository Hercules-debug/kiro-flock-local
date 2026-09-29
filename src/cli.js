#!/usr/bin/env node
/**
 * kiro-flock-local — a self-organizing agent cluster with no orchestrator.
 *
 * Local port of aws-samples/sample-kiro-flock: the S3 coordination plane
 * becomes a directory, the headless Kiro CLI session becomes a pluggable
 * model backend. Everything that makes it self-organizing is unchanged.
 *
 *   node src/cli.js run   --cluster demo --agents 8 --direction "..." [--algorithm amorphous]
 *   node src/cli.js watch --cluster demo --agents 8
 *   node src/cli.js set   --cluster demo --algorithm swarm
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, readDirection, writeConfig, writeDirection, writeState } from "./store.js";
import { startCluster, snapshot, render, DEFAULT_CONFIG } from "./cluster.js";
import { openaiRunner, scriptedRunner } from "./runner.js";
import { ALGORITHMS } from "./neighbours.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.FLOCK_ROOT || path.resolve(__dirname, "..", "clusters");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function makeRunner(args) {
  if (args.scripted) {
    const angles = String(args.angles ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return { runner: scriptedRunner({ angles }), label: "scripted (no model)" };
  }
  const baseURL = args.baseURL || process.env.FLOCK_BASE_URL;
  const apiKey = args.apiKey || process.env.FLOCK_API_KEY;
  const model = args.model || process.env.FLOCK_MODEL;
  if (!baseURL || !model) {
    console.error(
      "No model configured. Set FLOCK_BASE_URL and FLOCK_MODEL (and FLOCK_API_KEY),\n" +
        "or pass --scripted to exercise the coordination machinery offline.",
    );
    process.exit(2);
  }
  const maxTokens = Number(args["max-tokens"] ?? process.env.FLOCK_MAX_TOKENS ?? 6000);
  return {
    runner: openaiRunner({ baseURL, apiKey, model, maxTokens }),
    label: `${model} @ ${baseURL} (max_tokens=${maxTokens})`,
  };
}

async function cmdRun(args) {
  const clusterId = String(args.cluster ?? "cluster_0");
  const concurrency = Number(args.agents ?? 8);
  const algorithm = String(args.algorithm ?? "amorphous");
  if (!ALGORITHMS.includes(algorithm)) throw new Error(`algorithm must be one of ${ALGORITHMS.join(", ")}`);

  const direction =
    args.direction ??
    (args["direction-file"] ? fs.readFileSync(String(args["direction-file"]), "utf8") : undefined);
  if (direction === undefined) {
    console.error("Provide --direction \"...\" or --direction-file <path>");
    process.exit(2);
  }

  const { runner, label } = makeRunner(args);
  const radius = Number(args.radius ?? (algorithm === "amorphous" ? 1 : DEFAULT_CONFIG.neighbourRadius));
  const swarmK = Number(args.swarmK ?? DEFAULT_CONFIG.swarmK);

  console.log(`cluster=${clusterId} agents=${concurrency} algorithm=${algorithm} radius=${radius}`);
  console.log(`model: ${label}`);
  console.log(`root:  ${ROOT}\n`);

  const ac = new AbortController();
  process.on("SIGINT", () => { console.log("\nstopping…"); ac.abort(); });

  // Runaway guard. A cluster whose agents keep retrying a failing endpoint
  // will happily run forever; if the supervising shell is killed the node
  // process is orphaned and keeps hammering the gateway. A hard wall-clock
  // deadline makes that impossible: the cluster always terminates itself.
  const maxRuntime = Number(args["max-runtime"] ?? 0);
  let deadlineTimer = null;
  if (maxRuntime > 0) {
    deadlineTimer = setTimeout(() => {
      console.log(`\n  [guard] 达到 --max-runtime ${maxRuntime}s，主动停止集群`);
      ac.abort();
    }, maxRuntime * 1000);
    deadlineTimer.unref?.();
  }
  // Belt and braces: make an abrupt parent death take the cluster with it.
  process.on("disconnect", () => ac.abort());

  let printed = 0;
  const started = Date.now();
  const result = await startCluster({
    root: ROOT,
    clusterId,
    direction,
    concurrency,
    config: { algorithm, neighbourRadius: radius, swarmK },
    runner,
    maxInflight: Number(args["max-inflight"] ?? (args.scripted ? concurrency : 3)),
    staggerMs: Number(args.stagger ?? 150),
    maxIterations: Number(args["max-iterations"] ?? 0),
    signal: ac.signal,
    onEvent: (e) => {
      if (e.type === "line") {
        printed++;
        console.log(
          `  [${String(e.n).padStart(2)}] it=${String(e.iteration).padStart(2)} ` +
            `${e.line.action} — ${e.line.result}`,
        );
      } else if (e.type === "autopause") {
        console.log(`\n  autopause: agent-${e.n} observed all visible peers idle ${3}x (flipped=${e.flipped})`);
      } else if (e.type === "artifact") {
        console.log(`  [${String(e.n).padStart(2)}] 写入产物 ${e.path.split("/").pop()} (${e.bytes} 字节)`);
      } else if (e.type === "topology") {
        console.log(`  topology change: ${e.algorithm} -> [${e.neighbours.join(", ")}]`);
      } else if (e.type === "error") {
        const code = e.err?.code ? ` [${e.err.code}]` : "";
        const retryable = e.err?.retryable === false ? " (不可重试)" : "";
        console.log(`  [!] agent-${e.n} it=${e.iteration}${code}${retryable}: ${e.error}`);
      }
    },
  });

  if (deadlineTimer) clearTimeout(deadlineTimer);
  const snap = snapshot(ROOT, clusterId, concurrency);
  console.log(`\n${"─".repeat(78)}`);
  console.log(render(snap));
  console.log(`${"─".repeat(78)}`);
  console.log(`log lines appended: ${printed}   wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const envFiles = fs.readdirSync(path.join(ROOT, clusterId, "environment")).filter((f) => f !== ".gitkeep");
  console.log(`artifacts written: ${envFiles.length}`);
  return result;
}

async function cmdWatch(args) {
  const clusterId = String(args.cluster ?? "cluster_0");
  const concurrency = Number(args.agents ?? 8);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  const snap = snapshot(ROOT, clusterId, concurrency);
  console.log(render(snap));
}

async function cmdSet(args) {
  const clusterId = String(args.cluster ?? "cluster_0");
  const base = path.join(ROOT, clusterId);
  const cfgPath = path.join(base, "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  for (const k of ["algorithm", "neighbourRadius", "swarmK", "loopIntervalSeconds", "autopause"]) {
    if (args[k] !== undefined) cfg[k] = args[k] === "true" ? true : args[k] === "false" ? false : Number(args[k]) || args[k];
  }
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  console.log(`config updated: ${JSON.stringify(cfg)}`);
}

const USAGE = `kiro-flock-local — self-organizing agent clusters, no orchestrator

  run    start a cluster from a single direction file
  watch  print a snapshot of a running/finished cluster
  set    change algorithm/radius/swarmK on a live cluster (hot-reloaded)

Common flags:
  --cluster <id>        cluster name (default cluster_0)
  --agents <n>          cluster size
  --direction "..."     the goal; the path is left to the agents
  --algorithm <a>       ${ALGORITHMS.join(" | ")}
  --radius <r>          ring radius for amorphous
  --swarmK <k>          K for swarm
  --max-tokens <n>      per-call output budget (reasoning models need 6000+)
  --max-runtime <s>     hard stop the cluster after N seconds (0 = no limit)
  --max-iterations <n>  stop each agent after N iterations
  --max-inflight <n>    bound concurrent model calls (default 3)
  --stagger <ms>        delay between agent starts (default 150)
  --scripted            run without a model (offline check)
  --angles a,b,c        angles for --scripted

Env: FLOCK_BASE_URL FLOCK_API_KEY FLOCK_MODEL FLOCK_ROOT`;

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === "run") await cmdRun(args);
  else if (cmd === "watch") await cmdWatch(args);
  else if (cmd === "set") await cmdSet(args);
  else { console.log(USAGE); process.exit(cmd ? 2 : 0); }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
