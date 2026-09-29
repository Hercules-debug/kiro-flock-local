# kiro-flock-local

A self-organizing multi-agent cluster with **no orchestrator**, ported from
[`aws-samples/sample-kiro-flock`](https://github.com/aws-samples/sample-kiro-flock)
and runnable on a laptop.

The AWS original coordinates clusters of Kiro CLI agents through an S3 bucket:
no supervisor, no message bus, nothing between the agents but an append-only
log each of them reads. That design is excellent and the deployment story is
"one EC2 instance per agent plus a CDK stack". This port keeps the coordination
model byte-for-byte where it matters and swaps the substrate for local
equivalents so the pattern can be studied, tested, and modified without an AWS
account.

```
S3 bucket            ->  a directory
headless Kiro CLI    ->  any OpenAI-compatible endpoint (pluggable)
systemd reap          ->  self-terminating convergence
```

## The idea in one paragraph

An agent wakes up with **no memory of its previous turn**. It reads a direction
file, reads the last line of each visible neighbour's log, and decides on
exactly one contribution. Then it appends one line to its own log and goes back
to sleep. That log line — `{ts, iteration, action, result, next_intent}` — is
the entire coordination message. No broker delivers it, no acknowledgement
comes back. The next agent to read it decides for itself what to do about it.
Nobody assigned the topics, arbitrated the output, or told the cluster it was
done.

## Quick start

```bash
# No model needed: exercises the full coordination machinery offline.
node src/cli.js run --cluster demo --agents 8 --algorithm mesh \
  --direction "Survey coordination failure modes." \
  --scripted --angles failure-modes,topologies,scaling,economics,open-questions

# With a real model (any OpenAI-compatible endpoint).
export FLOCK_BASE_URL=http://127.0.0.1:7863/v1
export FLOCK_API_KEY=...
export FLOCK_MODEL=cn:hy3-b
node src/cli.js run --cluster real --agents 3 \
  --direction "Survey self-organizing coordination." \
  --max-runtime 420
```

Watch a finished or running cluster:

```bash
node src/cli.js watch --cluster demo --agents 8
```

Change the topology on a live cluster (hot-reloaded between iterations):

```bash
node src/cli.js set --cluster demo --algorithm swarm --swarmK 4
```

## The three algorithms

Every iteration starts with the same question — *whose work do I read?* — and
the answer is the coordination algorithm. All three are ported verbatim from
`agent/neighbourSelector.ts`.

| Algorithm | Who each agent reads | Strengths | Ceiling |
|---|---|---|---|
| **amorphous** | a fixed window of ring neighbours, set by `radius` | per-agent cost stays constant as N grows; diversity is preserved because everyone sees only their own slice | a signal moves one hop per iteration, so convergence is slow |
| **mesh** | everyone | fast alignment | diversity collapses onto the first signal; comfortable to ~30 agents |
| **swarm** | the K most recently active peers | follows where the energy is; scales past 100 | if K stays small while N grows, agents pile onto one subtask |

The productive sequence uses all three: open **amorphous** to explore, switch to
**swarm** as a direction forms, finish in **mesh** to align on the output.

Convergence math from the AWS post, implemented in `convergenceEstimate`:
in a ring one iteration carries a signal `2R` positions, so full propagation
takes `ceil(N / 2R)` iterations and consensus roughly two to three times that.

## Failure modes and their controls

The AWS post names four. Each is a design choice, not a safeguard bolted on
afterwards — all four are implemented here.

| Failure mode | Where it comes from | Control in this port |
|---|---|---|
| **Groupthink** | mesh visibility collapses the cluster onto the first signal | open with amorphous; switch to mesh only to align |
| **Drift** | persistent session history builds behavioural momentum | **fresh session every iteration**; state lives only in the shared logs |
| **Hot spots** | swarm with K too small for N starves subtasks | raise K, or switch to amorphous |
| **Carry-over** | stale files from a previous run read as current context | `environment/` is archived to `history/` on every start |

Drift deserves the extra sentence the AWS post gives it. Starting every
iteration with no conversational memory sounds wasteful. It is actually the
control that keeps a thousand independent loops steerable.

## What was changed, and why

Porting is not transcription. Every deliberate difference is listed here.

### Substrate

| AWS | Here | Note |
|---|---|---|
| S3 `GetObject`/`PutObject`/`ListObjectsV2` | `node:fs` | same keys, same shapes: `{cluster}/store/agent-{n}.ndjson` |
| S3 `If-Match` conditional writes | read-then-write under a single-process assumption | see caveat below |
| S3 `LastModified` for swarm ranking | file mtime | identical semantics, ties broken by ascending index |
| headless Kiro CLI over ACP | pluggable `runner` function | `openaiRunner` and a deterministic `scriptedRunner` ship here |
| agents have real file tools | **the harness writes the artifact for them** | see below — this is the one structural difference |

### The one structural difference: how artifacts reach the blackboard

In AWS, an agent is a full Kiro CLI session with working file tools. It writes
its artifact itself and appends its own log line.

Here an agent is a single model call with no tools. That was a real defect in
the first version of this port: agents confidently logged *"Wrote
environment/coordination_patterns.md"* while `environment/` stayed **completely
empty**. The log claimed work that did not exist, which is worse than failing —
the blackboard had messages but no content.

The fix is to make the artifact part of the response contract:

```json
{
  "action": "wrote notes",
  "result": "notes on failure modes",
  "next_intent": "read peers",
  "artifact": { "name": "failure-modes.md", "content": "<the full file text>" }
}
```

The harness writes `content` into the environment directory (with the filename
sanitized against path escape) and records the filename in the log line. So the
shared environment holds real bytes that peers can genuinely read — the property
that matters — while the mechanism differs from upstream.

If you want true parity, give the runner a tool loop. The coordination model is
unchanged either way.

### Behavioural changes

1. **Self-termination.** AWS agents loop until systemd reaps them. Here a
   converging cluster parks itself in `paused` with `reason: "converged"` and
   every agent exits. Without this a locally-run cluster never returns.

2. **The log records transitions, not heartbeats.** Upstream, an agent appends a
   line every iteration. That is harmless when agents are doing real work, but
   a *repeated idle line is not inert*: every peer reads the tail, so each
   duplicate flips every neighbour's signature and wakes the whole cluster to
   reason about a change that did not happen. In an early version this
   feedback loop made a 4-agent cluster burn **~400 model calls doing nothing**.
   An agent that is already idle and would report idle again does not append.

3. **New-information gate.** An idle agent whose visible neighbourhood has not
   changed since its last look does not re-ask the model — there is no new
   signal to reason about. It watches instead. Together with change 2 this took
   an 8-agent all-idle cluster from ~400 calls to **28**.

4. **Bounded in-flight model calls.** Agents are independent loops but share
   one endpoint. A cluster of N firing at once gets `503 no_healthy_account`
   from a gateway whose pool is smaller than N. `maxInflight` (default 3) plus
   staggered starts bounds this. It limits concurrency, not cluster size — the
   topology and the logs are untouched.

5. **Retry with jittered backoff.** Transient gateway statuses and codes
   (`no_healthy_account`, `429`, `5xx`) are retried; `400`-class errors fail
   fast. Jitter matters: without it a burst of agents retries in lockstep and
   re-exhausts the pool.

6. **Honest error reporting.** Upstream (and this port's first draft) collapsed
   every failure into a single opaque message. That hid a gateway outage behind
   a parse error and cost a debugging cycle. Real causes — HTTP status, gateway
   code, truncation — now go into the log line.

7. **Reasoning-model truncation is detected.** A reasoning model spends
   `max_tokens` on thinking *before* the answer. At a tight budget `content`
   comes back empty with `finish_reason: "length"`. Retrying truncates in
   exactly the same place, so this fails fast with an actionable message
   instead of burning retries. Default `maxTokens` raised to 4000.

8. **Runaway guard.** `--max-runtime <s>` hard-stops the cluster. A cluster
   retrying a failing endpoint will otherwise run forever, and if the
   supervising shell dies the process is orphaned and keeps hammering the
   gateway — which is precisely what happened during development and clogged a
   shared model pool for several minutes.

### Known upstream bug, faithfully reproduced

`amorphousNeighbours` underflows when `radius >= concurrency`:

```
N=2, R=3  ->  [-1, 1]      # negative agent index
```

`(agentIndex - d + concurrency) % concurrency` goes below `-concurrency` once
`d >= concurrency`, so the modulo yields a negative index, which would address
`agent--1.ndjson`.

The function body is left **identical to upstream** so the differential test
keeps proving the port matches what it claims to port. The guard lives in
`clampRadius`, used by `selectNeighbours` — the only sanctioned entry point — so
the buggy range is unreachable from the public API. If upstream ever fixes it,
the differential run will flag the divergence and this port can follow.

## Tests

```bash
npm test          # everything
npm run smoke     # coordination invariants, 30 checks
npm run diff      # differential vs the AWS source, 1272 input comparisons
npm run resilience# retry, concurrency limiting, truncation detection
npm run runner    # OpenAI-compatible wire protocol against a mock server
```

### Differential test — the one that matters

`test/diff/` contains `amorphousNeighbours` and `meshNeighbours` extracted
**verbatim** from the upstream TypeScript. The test executes both
implementations over 1272 input combinations (12 cluster sizes × 7 radii × up
to 24 agent indices, plus mesh) and asserts identical output.

This is a much stronger claim than hand-written expected values: it proves the
port equals the thing it claims to port, rather than equalling my memory of it.
It is also how the `radius >= concurrency` bug above was found.

The other suites prove the machinery is internally coherent. **They do not
prove behavioural equivalence with AWS**, because the original needs EC2 and a
Kiro subscription and cannot be run side by side. Treat the coordination model
as faithfully ported and the runtime behaviour as reimplemented.

## Repository layout

```
src/
  store.js       shared environment: append-only logs, direction, state, config
  neighbours.js  the three algorithms + clampRadius guard
  agent.js       observe -> decide -> act -> broadcast loop
  cluster.js     launcher, concurrency limiting, snapshots
  runner.js      model backends (OpenAI-compatible, scripted)
  cli.js         run / watch / set
prompts/
  agent-loop.md  the loop instructions given to every agent
  algorithms/    per-algorithm prompt fragment (amorphous | mesh | swarm)
test/
  smoke.js       coordination invariants
  resilience.js  gateway failure handling
  openai-runner.js  wire protocol against a mock
  diff/          differential test vs the AWS source
clusters/        generated: one directory per cluster
```

## Caveats

- **Single process.** Conditional state writes assume one process owns the
  cluster directory. The AWS version gets real `If-Match` semantics from S3.
  Running two launchers against one cluster directory is not supported.
- **`scriptedRunner` is a stand-in for testing, not a model.** It reads the
  neighbour tails out of the assembled prompt and picks an uncovered angle. It
  is useful for exercising convergence and for CI, and its "contributions" are
  meaningless as content.
- **Convergence under amorphous is not globally knowable.** Each agent sees
  only its own slice, so "the whole cluster is done" is a local judgement there.
  Mesh is where convergence is well defined.
- Not a production system. The AWS post says the same of the original.

## Credit

The design — coordination through shared state, the three topologies, the
bounded neighbour set, the four failure modes, the convergence arithmetic — is
from the AWS Architecture Blog post
[*Scaling patterns for self-organizing multi-agent clusters with Kiro*](https://aws.amazon.com/blogs/architecture/scaling-patterns-for-self-organizing-multi-agent-clusters-with-kiro/)
and the Apache-2.0 reference implementation
[`aws-samples/sample-kiro-flock`](https://github.com/aws-samples/sample-kiro-flock).

This port exists to make that design runnable and testable on a laptop. The
interesting ideas are theirs; the bugs in the localisation are mine.
