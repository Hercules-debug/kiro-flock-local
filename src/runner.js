/**
 * Model backends for the agent turn.
 *
 * The AWS original shells out to a headless Kiro CLI session over ACP. Here
 * the backend is pluggable. Two are provided:
 *
 *   - `openaiRunner`   any OpenAI-compatible /chat/completions endpoint
 *                      (DeepSeek, OpenAI, a local gateway, ...)
 *   - `scriptedRunner` no model at all: a deterministic stand-in used to
 *                      exercise the coordination machinery offline
 *
 * The runner contract is `({prompt, iteration, agentIndex}) => Promise<string>`.
 */

/** Statuses that mean "the gateway is busy", not "the request is wrong". */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Gateway error codes that are explicitly transient. */
const RETRYABLE_CODES = new Set([
  "no_healthy_account",
  "rate_limit_exceeded",
  "overloaded",
  "server_error",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A model backend error that carries the HTTP status and gateway code, so the
 * agent loop can log the real cause instead of a generic parse failure.
 */
export class ModelError extends Error {
  constructor(message, { status, code, retryable, body } = {}) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.code = code;
    this.retryable = Boolean(retryable);
    this.body = body;
  }
}

function classify(status, bodyText) {
  let code;
  try {
    code = JSON.parse(bodyText)?.error?.code;
  } catch {
    /* not JSON */
  }
  const retryable = RETRYABLE_STATUS.has(status) || (code && RETRYABLE_CODES.has(code));
  return { code, retryable };
}

export function openaiRunner({
  baseURL,
  apiKey,
  model,
  temperature = 0.9,
  // Reasoning models spend this budget on thinking BEFORE the answer, so a
  // tight default silently truncates to empty content. See the length check.
  maxTokens = 6000,
  /** Upper bound for budget escalation when a call comes back truncated. */
  maxTokenCeiling = 24000,
  timeoutMs = 120000,
  headers: extraHeaders = {},
  // Retries exist because a shared gateway returns 503 no_healthy_account in
  // bursts when several agents fire at once. Without backoff a whole cluster
  // fails on the first burst and every agent logs an error line.
  maxRetries = 5,
  baseDelayMs = 1000,
  maxDelayMs = 30000,
}) {
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

  return async function run({ prompt }) {
    let lastErr;
    // Per-call budget. Escalates on truncation and resets for the next call,
    // so one long-thinking turn does not permanently inflate every request.
    let budget = maxTokens;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
            ...extraHeaders,
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: budget,
            messages: [
              {
                role: "system",
                content:
                  "You are one agent in a self-organizing cluster with no orchestrator. " +
                  "Each turn is a fresh session: your only memory is what you read from the shared logs. " +
                  "Do the single highest-value piece of work you can see, then report it as JSON. " +
                  'Reply with ONLY the JSON object: ' +
                  '{"action","result","next_intent","artifact":{"name","content"}}. ' +
                  'Put the full text of any file you produce in artifact.content — describing a file ' +
                  'without emitting its content creates nothing.',
              },
              { role: "user", content: prompt },
            ],
          }),
          signal: ctrl.signal,
        });

        if (!res.ok) {
          const bodyText = await res.text().catch(() => "");
          const { code, retryable } = classify(res.status, bodyText);
          lastErr = new ModelError(
            `HTTP ${res.status}${code ? ` (${code})` : ""}: ${bodyText.slice(0, 200)}`,
            { status: res.status, code, retryable, body: bodyText },
          );
          if (!retryable || attempt === maxRetries) throw lastErr;
        } else {
          const json = await res.json();
          const choice = json?.choices?.[0];
          const text = choice?.message?.content;
          const reasoning = choice?.message?.reasoning_content;

          if (typeof text === "string" && text.trim() !== "") return text;

          // Empty content has two very different causes and they must not be
          // conflated:
          //
          //  - finish_reason "length": a REASONING model spent the whole budget
          //    thinking and never reached the answer.
          //  - anything else: a transient empty or malformed response.
          if (choice?.finish_reason === "length") {
            const rt = json?.usage?.completion_tokens_details?.reasoning_tokens;
            // Thinking length varies per call — the same endpoint answers in
            // 500 tokens once and needs 9000 the next time. Retrying at the
            // SAME budget truncates identically, but a LARGER one usually
            // succeeds, so escalate instead of failing the iteration outright.
            const next = Math.min(maxTokenCeiling, budget * 2);
            if (budget < next && attempt < maxRetries) {
              lastErr = new ModelError(
                `输出被截断（思维链约 ${rt ?? "?"} tokens），提升预算至 ${next} 后重试`,
                { retryable: true, code: "output_truncated" },
              );
              budget = next;
            } else {
              throw new ModelError(
                `模型输出在 max_tokens=${budget} 仍被截断（思维链用掉约 ${rt ?? "?"} tokens）。` +
                  `该模型推理较长，请提高 maxTokens（建议 8000+）。`,
                { retryable: false, code: "output_truncated" },
              );
            }
          } else if (typeof reasoning === "string" && reasoning.trim() !== "") {
            // Reasoning present but no answer: same class of failure.
            throw new ModelError(
              `模型只返回了思维链、没有最终答案（max_tokens=${budget}）。请提高 maxTokens。`,
              { retryable: false, code: "reasoning_only" },
            );
          } else {
            lastErr = new ModelError("模型返回空内容", { retryable: true });
            if (attempt === maxRetries) throw lastErr;
          }
        }
      } catch (err) {
        if (err instanceof ModelError && !err.retryable) throw err;
        if (err instanceof ModelError) lastErr = err;
        else {
          // Network failure or timeout — also worth retrying.
          lastErr = new ModelError(
            err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err),
            { retryable: true },
          );
          if (attempt === maxRetries) throw lastErr;
        }
      } finally {
        clearTimeout(timer);
      }

      // Exponential backoff with full jitter, so a burst of agents does not
      // retry in lockstep and re-exhaust the pool.
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
      await sleep(delay);
    }
    throw lastErr ?? new ModelError("exhausted retries");
  };
}

/**
 * Deterministic offline stand-in. It reads the neighbour tails already
 * embedded in the prompt, picks an angle nobody has taken, and eventually
 * goes idle — so the full convergence path can be exercised without a model.
 */
export function scriptedRunner({ angles = [] } = {}) {
  return async function run({ prompt, iteration, agentIndex }) {
    // What the visible neighbours already produced, read straight out of the
    // prompt the loop assembled. Only the angled agents' own result text is
    // matched, so an agent can tell whether an angle is genuinely covered
    // rather than merely mentioned by a peer's next_intent.
    const covered = new Set();
    // Neighbour lines look like:
    //   - agent-1 [iteration 0, action=write topologies]: produced notes on topologies  -> next_intent: read
    for (const m of prompt.matchAll(/\]: (produced notes on [^\n]*?) {2}-> next_intent:/g)) {
      covered.add(m[1].replace(/^produced notes on\s*/i, "").trim().toLowerCase());
    }
    const idleNeighbours = (prompt.match(/action=idle\]/gi) || []).length;

    const angle = angles.find((a) => !covered.has(a.toLowerCase()));
    // Once every visible angle is covered, or enough neighbours have already
    // gone idle, the correct move is to abstain — that is what lets the
    // cluster converge instead of churning.
    if (angle && idleNeighbours === 0) {
      return JSON.stringify({
        action: `write ${angle}`,
        result: `produced notes on ${angle}`,
        next_intent: "read neighbours and take the next uncovered angle",
      });
    }
    return JSON.stringify({
      action: "idle",
      result: "coverage looks complete across visible neighbours; nothing high-value left to add",
      next_intent: "remain idle unless the direction changes",
    });
  };
}
