/**
 * Smoke test for the coordination invariants.
 *
 * Asserts the properties that make this a self-organizing cluster rather than
 * an orchestrated one, plus the failure-mode controls from the AWS post.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { amorphousNeighbours, meshNeighbours, convergenceEstimate, selectNeighbours, clampRadius } from "../src/neighbours.js";
import { clusterPaths, appendLog, tailLog, readConfig, writeConfig, writeDirection, readState, writeState } from "../src/store.js";
import { runAgent, parseAgentReply, isIdleAction, sanitizeArtifactName } from "../src/agent.js";
import { startCluster, snapshot } from "../src/cluster.js";
import { scriptedRunner } from "../src/runner.js";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "flock-"));

console.log("\nneighbour selection");
t("amorphous radius 1 on a ring of 8 gives 2 neighbours", () => {
  assert.deepEqual(amorphousNeighbours(0, 8, 1), [1, 7]);
});
t("amorphous radius 2 gives 4 neighbours and wraps", () => {
  assert.deepEqual(amorphousNeighbours(0, 8, 2), [2, 6, 1, 7].sort((a, b) => a - b));
});
t("amorphous per-agent cost is constant as N grows", () => {
  assert.equal(amorphousNeighbours(0, 8, 2).length, 4);
  assert.equal(amorphousNeighbours(0, 800, 2).length, 4);
});
t("mesh sees everyone but self", () => {
  const m = meshNeighbours(3, 6);
  assert.equal(m.length, 5);
  assert.ok(!m.includes(3));
});
t("convergence math matches the post (N=100,R=2 -> 25 iterations)", () => {
  const c = convergenceEstimate(100, 2);
  assert.equal(c.propagation, 25);
  assert.equal(c.consensusLow, 50);
});
t("convergence math N=1000,R=4 -> 125", () => {
  assert.equal(convergenceEstimate(1000, 4).propagation, 125);
});
t("clampRadius 挡住上游 R>=N 的负索引下溢", () => {
  assert.equal(clampRadius(2, 3), 1);
  assert.equal(clampRadius(8, 1), 1);
  assert.equal(clampRadius(8, 99), 7);
  assert.equal(clampRadius(1, 5), 0);
});
t("selectNeighbours 在 R>=N 时永不返回负索引", () => {
  for (const c of [2, 3, 5]) {
    for (let i = 0; i < c; i++) {
      const ns = selectNeighbours({ algorithm: "amorphous", agentIndex: i, concurrency: c, radius: 99, swarmK: 2, paths: {} });
      assert.ok(ns.every((x) => x >= 0 && x < c), `N=${c} agent=${i} -> [${ns}]`);
    }
  }
});

console.log("\nshared store");
await ta("append-only log: each append adds exactly one line", async () => {
  const root = tmp();
  const p = clusterPaths(root, "c", 4);
  appendLog(p, 0, { iteration: 0, action: "a", result: "r", next_intent: "n" });
  appendLog(p, 0, { iteration: 1, action: "b", result: "r2", next_intent: "n2" });
  const lines = fs.readFileSync(p.logOf(0), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});
ta("tailLog returns only the last line (what neighbours read)", async () => {
  const root = tmp();
  const p = clusterPaths(root, "c", 4);
  appendLog(p, 0, { iteration: 0, action: "first", result: "x", next_intent: "" });
  appendLog(p, 0, { iteration: 1, action: "second", result: "y", next_intent: "" });
  assert.equal(tailLog(p, 0).action, "second");
});
ta("missing state.json falls back to stopped", async () => {
  const root = tmp();
  const p = clusterPaths(root, "c", 4);
  assert.equal(readState(p).state, "stopped");
});
ta("no config file falls back to defaults", async () => {
  const root = tmp();
  const p = clusterPaths(root, "c", 4);
  assert.equal(readConfig(p, { algorithm: "amorphous" }).algorithm, "amorphous");
});

console.log("\nagent reply parsing");
t("parses bare JSON", () => {
  assert.equal(parseAgentReply('{"action":"write","result":"r","next_intent":"n"}').action, "write");
});
t("parses JSON inside a fenced block", () => {
  const r = parseAgentReply('Here you go:\n```json\n{"action":"idle","result":"r","next_intent":"n"}\n```');
  assert.equal(r.action, "idle");
});
t("parses JSON surrounded by prose", () => {
  assert.equal(parseAgentReply('Sure. {"action":"x","result":"","next_intent":""} Done.').action, "x");
});
t("rejects unparseable output", () => {
  assert.equal(parseAgentReply("no json at all"), null);
});

console.log("\n产物落地与 idle 识别");

t('isIdleAction 识别 idle 的各种写法', () => {
  for (const a of ["idle", "Idle", " IDLE ", "idle — both neighbours converged", "idle (nothing to add)"]) {
    assert.equal(isIdleAction(a), true, `应判定为 idle: ${JSON.stringify(a)}`);
  }
  for (const a of ["write notes", "idling is not my action", "", null, undefined, "IDLEWORK"]) {
    assert.equal(isIdleAction(a), false, `不应判定为 idle: ${JSON.stringify(a)}`);
  }
});

t('sanitizeArtifactName 阻止路径逃逸与非法字符', () => {
  assert.equal(sanitizeArtifactName("notes.md", 0, 0), "notes.md");
  assert.equal(sanitizeArtifactName("/etc/passwd", 0, 0), "passwd.md"); // 无扩展名时补 .md
  assert.equal(sanitizeArtifactName("../../escape.md", 0, 0), "escape.md");
  assert.equal(sanitizeArtifactName("a/b/c.md", 0, 0), "c.md");
  assert.equal(sanitizeArtifactName("", 2, 3), "agent-2-iteration-3.md");
  assert.equal(sanitizeArtifactName("has spaces.md", 0, 0), "has-spaces.md");
  assert.equal(sanitizeArtifactName("noext", 0, 0), "noext.md");
  // must never escape
  for (const bad of ["../../x", "/abs", "..", ".", "////"]) {
    const got = sanitizeArtifactName(bad, 1, 1);
    assert.ok(!got.includes("/") && !got.includes(".."), `逃逸: ${bad} -> ${got}`);
  }
});

console.log("\nagent loop");
await ta("an empty direction does not invent work", async () => {
  const root = tmp();
  const ac = new AbortController();
  const p = clusterPaths(root, "c", 1);
  writeDirection(p, "");
  writeConfig(p, { algorithm: "amorphous", neighbourRadius: 1, swarmK: 2, autopause: false });
  writeState(p, "running", "test");
  let sawPrompt = "";
  await runAgent({
    root, clusterId: "c", n: 0, concurrency: 1,
    defaults: { algorithm: "amorphous", neighbourRadius: 1, swarmK: 2, autopause: false },
    promptDir: path.resolve("prompts"),
    runner: async ({ prompt }) => { sawPrompt = prompt; ac.abort(); return JSON.stringify({ action: "idle", result: "no direction", next_intent: "" }); },
    signal: ac.signal,
  });
  assert.match(sawPrompt, /direction file is empty/i);
});
await ta("neighbours' last lines appear in the prompt", async () => {
  const root = tmp();
  const ac = new AbortController();
  const p = clusterPaths(root, "c", 3);
  writeDirection(p, "do the thing");
  writeConfig(p, { algorithm: "amorphous", neighbourRadius: 1, swarmK: 2, autopause: false });
  writeState(p, "running", "test");
  appendLog(p, 1, { iteration: 0, action: "wrote X", result: "artifact X", next_intent: "do Y" });
  let sawPrompt = "";
  await runAgent({
    root, clusterId: "c", n: 0, concurrency: 3,
    defaults: { algorithm: "amorphous", neighbourRadius: 1, swarmK: 2, autopause: false },
    promptDir: path.resolve("prompts"),
    runner: async ({ prompt }) => { sawPrompt = prompt; ac.abort(); return '{"action":"idle","result":"r","next_intent":""}'; },
    signal: ac.signal,
  });
  assert.match(sawPrompt, /artifact X/);
});
await ta("swarm falls back to the ring at iteration 0 (no logs yet)", async () => {
  const root = tmp();
  const p = clusterPaths(root, "c", 4);
  const picked = selectNeighbours({ algorithm: "swarm", agentIndex: 0, concurrency: 4, radius: 1, swarmK: 2, paths: p });
  assert.deepEqual(picked, [1, 3]);
});

console.log("\nend-to-end cluster");
await ta("cluster converges with no orchestrator and autopauses (mesh)", async () => {
  const root = tmp();
  const ac = new AbortController();
  const angles = ["failure-modes", "topologies", "scaling", "economics", "open-questions"];
  await startCluster({
    root, clusterId: "e2e", concurrency: 6,
    direction: "Survey self-organizing agent clusters.",
    // Mesh, because convergence is only well-defined when every agent can
    // see every other agent's coverage. Under amorphous each agent sees only
    // its own slice, so "the whole cluster is done" is not locally knowable.
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 3, autopause: true },
    runner: scriptedRunner({ angles }),
    signal: ac.signal,
    promptDir: path.resolve("prompts"),
  });
  const snap = snapshot(root, "e2e", 6);
  assert.equal(snap.reported, 6, "every agent must have logged");
  assert.equal(snap.idle, 6, "every agent must end idle (convergence)");
  assert.equal(snap.state, "paused", "autopause must have flipped the cluster");
});
await ta("cluster terminates on its own instead of spinning", async () => {
  const root = tmp();
  const ac = new AbortController();
  let calls = 0;
  const done = await Promise.race([
    startCluster({
      root, clusterId: "term", concurrency: 4, direction: "x",
      config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: true },
      runner: async () => { calls++; return JSON.stringify({ action: "idle", result: "r", next_intent: "" }); },
      signal: ac.signal, promptDir: path.resolve("prompts"),
    }).then(() => "finished"),
    new Promise((r) => setTimeout(() => r("hung"), 5000)),
  ]);
  assert.equal(done, "finished", "cluster must terminate without an abort");
  assert.ok(calls <= 4 * 3, `expected a bounded number of model calls, got ${calls}`);
});
await ta("--max-iterations 会在到达上限时停止 agent", async () => {
  const root = tmp();
  const ac = new AbortController();
  // A runner that always wants to keep working; only the cap can stop it.
  let calls = 0;
  await startCluster({
    root, clusterId: "cap", concurrency: 3, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: false },
    runner: async () => { calls++; return JSON.stringify({ action: "keep going", result: "r", next_intent: "more" }); },
    signal: ac.signal, promptDir: path.resolve("prompts"),
    maxIterations: 2, maxInflight: 3, staggerMs: 0,
  });
  assert.ok(calls <= 3 * 2, `每个 agent 最多 2 轮，实际调用 ${calls} 次`);
});

await ta("收敛后不重复追加 idle 心跳（日志只记状态转移）", async () => {
  const root = tmp();
  const ac = new AbortController();
  await startCluster({
    root, clusterId: "hb", concurrency: 5, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: true },
    runner: async () => JSON.stringify({ action: "idle", result: "r", next_intent: "" }),
    signal: ac.signal, promptDir: path.resolve("prompts"), staggerMs: 0,
  });
  const p2 = clusterPaths(root, "hb", 5);
  for (let i = 0; i < 5; i++) {
    const lines = fs.readFileSync(p2.logOf(i), "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, `agent-${i} 应恰好 1 行（一次状态转移），实际 ${lines.length} 行`);
  }
});

await ta("模型的 artifact 内容真的写入磁盘（黑板有实体）", async () => {
  const root = tmp();
  const ac = new AbortController();
  await startCluster({
    root, clusterId: "art", concurrency: 2, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: true },
    runner: async ({ agentIndex }) => JSON.stringify({
      action: "wrote notes",
      result: "notes",
      next_intent: "read peers",
      artifact: { name: `notes-${agentIndex}.md`, content: `# notes from agent ${agentIndex}\n\nreal bytes\n` },
    }),
    signal: ac.signal, promptDir: path.resolve("prompts"), staggerMs: 0, maxIterations: 1,
  });
  const env = path.join(root, "art", "environment");
  const files = fs.readdirSync(env).sort();
  assert.deepEqual(files, ["notes-0.md", "notes-1.md"], `实际产物: ${files}`);
  assert.match(fs.readFileSync(path.join(env, "notes-0.md"), "utf8"), /real bytes/);
});

await ta("收敛判定认可 'idle — 原因' 这种写法", async () => {
  const root = tmp();
  const ac = new AbortController();
  await startCluster({
    root, clusterId: "idl", concurrency: 3, direction: "x",
    config: { algorithm: "mesh", neighbourRadius: 1, swarmK: 2, autopause: true },
    runner: async () => JSON.stringify({ action: "idle — neighbours converged", result: "done", next_intent: "" }),
    signal: ac.signal, promptDir: path.resolve("prompts"), staggerMs: 0,
  });
  const snap = snapshot(root, "idl", 3);
  assert.equal(snap.idle, 3, `应识别出 3 个 idle，实际 ${snap.idle}`);
  assert.equal(snap.converged, true);
});

await ta("carry-over control: a previous run's artifacts are archived", async () => {
  const root = tmp();
  const ac = new AbortController();
  const p = clusterPaths(root, "co", 2);
  fs.writeFileSync(path.join(p.env, "stale.md"), "old content");
  await startCluster({
    root, clusterId: "co", concurrency: 2, direction: "x",
    config: { algorithm: "amorphous", neighbourRadius: 1, swarmK: 1, autopause: true },
    runner: async () => JSON.stringify({ action: "idle", result: "r", next_intent: "" }),
    signal: ac.signal, promptDir: path.resolve("prompts"),
  });
  const envNow = fs.readdirSync(p.env).filter((f) => f !== ".gitkeep");
  assert.ok(!envNow.includes("stale.md"), "stale artifact must not survive into the new run");
  const hist = fs.readdirSync(path.join(p.base, "history"));
  assert.ok(hist.some((f) => f.endsWith("stale.md")), "stale artifact must be in history/");
});

console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}\n`);
