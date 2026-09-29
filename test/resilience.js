/**
 * Tests for the gateway-resilience layer.
 *
 * These encode the failure that actually happened: six agents firing at once
 * got `HTTP 503 no_healthy_account` from a shared gateway, and the agent loop
 * reported it as an unparseable-output error. The fixes under test are
 * retry-with-backoff, a bounded in-flight limit, and honest error reporting.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { openaiRunner, ModelError } from "../src/runner.js";
import { withConcurrencyLimit } from "../src/cluster.js";

let pass = 0;
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const ok = (res, content = '{"action":"a","result":"r","next_intent":"n"}') => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
};

console.log("\n重试与退避");

await ta("503 no_healthy_account 会被重试，最终成功", async () => {
  let calls = 0;
  const s = http.createServer((req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "no_healthy_account", message: "pool empty" } }));
      return;
    }
    ok(res);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({
      baseURL: `http://127.0.0.1:${s.address().port}/v1`,
      model: "m", maxRetries: 5, baseDelayMs: 10, maxDelayMs: 30,
    });
    const out = await run({ prompt: "p" });
    assert.match(out, /"action"/);
    assert.equal(calls, 3, "should have retried exactly twice");
  } finally { s.close(); }
});

await ta("重试耗尽后抛出带 code 的 ModelError（不是裸错误）", async () => {
  const s = http.createServer((req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "no_healthy_account" } }));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({
      baseURL: `http://127.0.0.1:${s.address().port}/v1`,
      model: "m", maxRetries: 2, baseDelayMs: 5, maxDelayMs: 10,
    });
    await assert.rejects(
      () => run({ prompt: "p" }),
      (e) => e instanceof ModelError && e.status === 503 && e.code === "no_healthy_account",
    );
  } finally { s.close(); }
});

await ta("400 参数错误不重试（快速失败）", async () => {
  let calls = 0;
  const s = http.createServer((req, res) => {
    calls++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "invalid_request" } }));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({
      baseURL: `http://127.0.0.1:${s.address().port}/v1`,
      model: "m", maxRetries: 5, baseDelayMs: 5, maxDelayMs: 10,
    });
    await assert.rejects(() => run({ prompt: "p" }), (e) => e.retryable === false);
    assert.equal(calls, 1, "a 400 must not be retried");
  } finally { s.close(); }
});

console.log("\n推理模型截断检测");

await ta("截断时逐次提升预算重试，而非原地重试", async () => {
  // A reasoning model's thinking length varies per call. Retrying at the SAME
  // budget truncates in the same place; escalating the budget is what actually
  // rescues the turn. Assert the budget grows on each attempt.
  const budgets = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      budgets.push(JSON.parse(body).max_tokens);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking…" } }],
        usage: { completion_tokens_details: { reasoning_tokens: 111 } },
      }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({
      baseURL: `http://127.0.0.1:${s.address().port}/v1`,
      model: "m", maxTokens: 100, maxTokenCeiling: 1000, maxRetries: 3, baseDelayMs: 5, maxDelayMs: 10,
    });
    await assert.rejects(() => run({ prompt: "p" }), (e) => e.code === "output_truncated");
    assert.deepEqual(budgets, [100, 200, 400, 800], `预算应递增，实际 ${budgets}`);
  } finally { s.close(); }
});

await ta("预算提升后成功时立即返回", async () => {
  let calls = 0;
  const s = http.createServer((req, res) => {
    calls++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const budget = JSON.parse(body).max_tokens;
      if (budget < 400) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "…" } }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"action":"a","result":"r","next_intent":"n"}' } }] }));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({
      baseURL: `http://127.0.0.1:${s.address().port}/v1`,
      model: "m", maxTokens: 100, maxTokenCeiling: 2000, maxRetries: 4, baseDelayMs: 5, maxDelayMs: 10,
    });
    assert.match(await run({ prompt: "p" }), /"action"/);
    assert.equal(calls, 3, "两次截断后第三次成功");
  } finally { s.close(); }
});

await ta("只有思维链没有答案时也报明确错误", async () => {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: "  ", reasoning_content: "thought" } }],
    }));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({ baseURL: `http://127.0.0.1:${s.address().port}/v1`, model: "m", maxRetries: 0 });
    await assert.rejects(() => run({ prompt: "p" }), (e) => e.code === "reasoning_only");
  } finally { s.close(); }
});

await ta("正常返回内容时不受影响", async () => {
  const s = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { content: '{"action":"a","result":"r","next_intent":"n"}', reasoning_content: "thought" } }],
    }));
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({ baseURL: `http://127.0.0.1:${s.address().port}/v1`, model: "m", maxRetries: 0 });
    assert.match(await run({ prompt: "p" }), /"action"/);
  } finally { s.close(); }
});

console.log("\n并发限流");

await ta("并发上限被严格遵守", async () => {
  let inflight = 0;
  let peak = 0;
  const fn = async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 20));
    inflight--;
  };
  const limited = withConcurrencyLimit(fn, 3);
  await Promise.all(Array.from({ length: 20 }, () => limited({})));
  assert.ok(peak <= 3, `peak in-flight was ${peak}, must be <= 3`);
  assert.equal(peak, 3, "should actually use the full allowance");
});

await ta("限流下所有调用都会完成（不丢任务）", async () => {
  let done = 0;
  const limited = withConcurrencyLimit(async () => { done++; }, 2);
  await Promise.all(Array.from({ length: 15 }, () => limited({})));
  assert.equal(done, 15);
});

await ta("6 个 agent 同时打 503 网关，限流后全部成功", async () => {
  // Reproduces the exact production failure, then proves the fix: a gateway
  // that rejects anything beyond 2 concurrent requests.
  let inflight = 0, peak = 0, rejected = 0;
  const s = http.createServer(async (req, res) => {
    inflight++;
    peak = Math.max(peak, inflight);
    if (inflight > 2) {
      rejected++;
      inflight--;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "no_healthy_account" } }));
      return;
    }
    await new Promise((r) => setTimeout(r, 30));
    inflight--;
    ok(res);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({
      baseURL: `http://127.0.0.1:${s.address().port}/v1`,
      model: "m", maxRetries: 8, baseDelayMs: 10, maxDelayMs: 60,
    });
    const limited = withConcurrencyLimit(run, 2);
    const out = await Promise.all(
      Array.from({ length: 6 }, () => limited({ prompt: "p" })),
    );
    assert.equal(out.length, 6);
    assert.ok(out.every((o) => /"action"/.test(o)), "every agent must get a usable reply");
    assert.ok(peak <= 2, `gateway saw ${peak} concurrent, limit was 2`);
  } finally { s.close(); }
});

console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}\n`);
