# Failure replay suite

The failure replay suite turns a production incident into a deterministic input/output contract. It runs without credentials or network access. A scheduled caller may pass `fileAutoIssue` (the existing ENG-240 intake seam); failed cases use a stable `Alert Class`, so repeated runs converge on the canonical issue.

## Add a case in 15 minutes or less

1. Copy an entry of `FAILURE_REPLAY_CATALOG` in `src/loops/eval/failureReplayCatalog.ts` (about 2 minutes).
2. Set `id`, `incident`, `failure` and `graderId` (the eval-registry id of the grader or contract the case exercises), and write `check` as the smallest historical reproduction run against the CURRENT code, returning true while the incident stays fixed (about 5 minutes). Keep it pure; use a synthetic input instead of calling AWS, Linear, Google, Slack, or an LLM.
3. Prove it both ways: temporarily restore the pre-fix code and confirm the case fails, then restore the fix (about 5 minutes).
4. Run the focused suites and record a new offline baseline, since the case count changed (about 3 minutes):

   ```bash
   cd backend
   npx jest src/__tests__/failureReplaySuite.test.ts src/__tests__/failureReplayNightlyCron.test.ts
   npx ts-node --transpile-only src/loops/scripts/runOfflineEvalSuite.ts --target local \
     --write-baseline src/loops/eval/baselines/local-deterministic.json --baseline-id local-deterministic-v<next>
   ```

If the case needs credentials, a server, browser, timer, or live third-party response, first extract a pure contract boundary and replay a captured, redacted value at that boundary. Do not add a live call to this suite.

## Scheduled-run contract

`src/cron/failureReplayNightlyCron.ts` replays the catalog every night at 04:30 UTC when `FAILURE_REPLAY_NIGHTLY_ENABLED=true` (off by default; turning it on in production is an OPS step). It calls `runFailureReplaySuite({ cases, contract, fileIssue })`. The runner:

- collapses duplicate case IDs before execution;
- files only failed cases;
- routes each failure through `fileAutoIssue` using `failure-replay:<case-id>` as the ENG-240 dedupe key; and
- returns deterministic checked/failed/filed/deduped counts for monitoring.

Tests must inject `fileIssue`; this proves filing behavior without touching Linear or any other third party.
