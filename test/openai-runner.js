/**
 * Verifies the OpenAI-compatible runner against a local mock server.
 *
 * This covers the wiring that a real endpoint would exercise — request shape,
 * auth header, response parsing, error surfacing, and timeout — without
 * needing an API key.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { openaiRunner } from "../src/runner.js";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    // The runner always posts to <base>/chat/completions, so the failure and
    // slowness cases are selected by a request header rather than by path.
    if (req.headers["x-case"] === "boom") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream exploded" }));
      return;
    }
    if (req.headers["x-case"] === "slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "late" } }] }));
      }, 3000);
      return;
    }
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404).end("nope");
      return;
    }
    const parsed = JSON.parse(body);
    assert.equal(parsed.messages.length, 2, "system + user");
    assert.ok(parsed.messages[1].content.includes("DIRECTION_MARKER"), "prompt must reach the model");
    assert.equal(parsed.model, "test-model");
    assert.equal(req.headers.authorization, "Bearer secret-key");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: '{"action":"write notes","result":"did it","next_intent":"read"}' } }],
      }),
    );
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

let pass = 0;
const ta = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.error(`  ✗ ${name}\n      ${e.message}`); process.exitCode = 1; }
};

console.log("\nopenai-compatible runner (mock server)");

await ta("sends the prompt and parses the reply", async () => {
  const run = openaiRunner({ baseURL: base, apiKey: "secret-key", model: "test-model" });
  const out = await run({ prompt: "DIRECTION_MARKER: survey clusters", iteration: 0, agentIndex: 0 });
  assert.match(out, /write notes/);
});

await ta("trailing slash in baseURL is tolerated", async () => {
  const run = openaiRunner({ baseURL: base + "/", apiKey: "secret-key", model: "test-model" });
  const out = await run({ prompt: "DIRECTION_MARKER", iteration: 0, agentIndex: 0 });
  assert.match(out, /write notes/);
});

await ta("works without an api key (no auth header)", async () => {
  const s2 = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  try {
    const run = openaiRunner({ baseURL: `http://127.0.0.1:${s2.address().port}/v1`, model: "m" });
    assert.equal(await run({ prompt: "p" }), "ok");
  } finally { s2.close(); }
});

await ta("surfaces an HTTP error instead of silently succeeding", async () => {
  const run = openaiRunner({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "m", maxRetries: 0, headers: { "x-case": "boom" } });
  await assert.rejects(() => run({ prompt: "p" }), /HTTP 500/);
});

await ta("times out rather than hanging forever", async () => {
  const run = openaiRunner({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "m", timeoutMs: 300, maxRetries: 0, headers: { "x-case": "slow" } });
  await assert.rejects(() => run({ prompt: "p" }));
});

server.close();
console.log(`\n${pass} passed${process.exitCode ? " (with failures)" : ""}\n`);
