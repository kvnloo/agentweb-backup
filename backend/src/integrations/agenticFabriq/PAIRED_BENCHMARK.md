# Pre-canary paired benchmark

`runPairedBenchmark` in `pairedBenchmark.ts` runs below the LLM. Its two injected
adapters call the existing direct email service and the reviewed vendor bridge,
respectively, against the same fixed fixture. The runner imports no service,
reads no secrets, enables no feature flag, and makes no network call on import.
The focused test uses synthetic adapters: its passing result is harness evidence,
not vendor compatibility, live latency, or authorization to start a canary.

## Design

- Only `search`, `list`, and `get` are accepted, before either adapter is called.
  Inputs, account binding, and fixture identifiers stay in adapter closures.
  Adapters must call the tool/service directly, never a chat session or LLM.
- Set `samples` explicitly (1–10,000 per action/cache stratum). Each action is
  measured in cold and warm strata. Within each stratum pairs alternate direct /
  vendor (AB), vendor / direct (BA), starting with AB. Use an even sample count
  for exactly balanced order. There is no concurrency or automatic retry.
- Each arm resets through `prepare(action)` before each cold attempt or warm
  primer. Reset must clear all relevant local token, discovery, and connection
  caches; it must never revoke a real credential or mutate a mailbox. Remote
  vendor caches cannot be controlled by this harness: record their limits in the
  experiment notes and never claim a server-cold measurement from a local reset.
- A warm measurement immediately follows an explicitly recorded primer. Reset or
  primer failure remains in the report; the subsequent measurement is marked
  failed without executing when its primer failed. Those failure durations are
  retained, so interpret latency together with failures and equivalence, never
  as a speed-only decision. Cold totals include reset; warm totals exclude primer.
- `context.stage(name, asyncWork)` records durations in `finally`, including
  failures. Instrument actual authorization, token, discovery, transport/body
  consumption, and normalization at the corresponding adapter boundaries.
  Supported labels are fixed: `prepare`, `authorize`, `token`, `discovery`,
  `transport`, `normalize`. Absent stages mean uninstrumented, not zero time;
  nested stage durations overlap and must not be summed as total latency.
- The comparator receives both successful outputs only in memory, along with
  the action. Canonicalize the reviewed response shapes and compare message
  identity sets/order, requested field values and pagination semantics as
  appropriate. Never equate “both succeeded” with equivalent. A false result is
  `different`; either arm failing or comparator throwing is `inconclusive`.
  Mutable mailbox drift can explain a mismatch but must not be silently ignored.
- Reports retain every primer and measured attempt, pair index/order, action,
  cache stratum, arm, status, whether execution began, fixed failure stage, duration, and semantic verdict.
  They retain no outputs, fixture inputs, exception messages, identifiers,
  response hashes, tokens, mailbox content, or endpoint paths. Do not add adapter
  logging of those values.
- Summaries are separate for every action/cache/arm and use nearest-rank p50/p95
  across all measured attempts, including failures. p99 is `inconclusive` below
  100 actual measured executions per stratum (failed primers do not inflate this count). At 100 it is an empirical percentile only, not a
  statistical confidence claim. Primer durations are available in attempts but
  excluded from summary percentiles. A latency claim also needs successful,
  semantically equivalent pairs; failures cannot count as a performance win.

## Offline validation

From `backend/`:

```sh
node node_modules/.bin/jest --runInBand --runTestsByPath src/integrations/agenticFabriq/__tests__/pairedBenchmark.test.ts
```

Tests inject a monotonic clock for reproducible output, synthetic response
fixtures, and failures. Production measurements should use the default monotonic
`performance.now()` clock. There is intentionally no automatic live runner:
review exact vendor descriptors and schema compatibility, bind both adapters to
the same approved read-only mailbox fixture, and review the comparator before
running a canary. Unknown vendor identities/schemas remain fail-closed.
