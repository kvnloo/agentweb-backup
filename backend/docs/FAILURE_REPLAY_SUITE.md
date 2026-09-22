# Failure replay suite

The failure replay suite turns a production incident into a deterministic input/output contract. It runs without credentials or network access. A scheduled caller may pass `fileAutoIssue` (the existing ENG-240 intake seam); failed cases use a stable `Alert Class`, so repeated runs converge on the canonical issue.

## Add a case in 15 minutes or less

1. Copy the `FailureReplayCase` object in `failureReplaySuite.test.ts` (about 2 minutes).
2. Replace `id`, `incident`, `input`, `assert`, and `failure` with the smallest historical reproduction (about 5 minutes). Keep the contract pure; inject adapters instead of calling AWS, Linear, Google, Slack, or an LLM.
3. Add two assertions: the pre-fix contract returns `passed: false`, and the current contract returns `passed: true` (about 5 minutes).
4. Run the focused suite (about 1 minute):

   ```bash
   cd backend
   npm test -- src/__tests__/failureReplaySuite.test.ts
   ```

If the case needs credentials, a server, browser, timer, or live third-party response, first extract a pure contract boundary and replay a captured, redacted value at that boundary. Do not add a live call to this suite.

## Scheduled-run contract

Call `runFailureReplaySuite({ cases, contract, fileIssue })` from the scheduler. The runner:

- collapses duplicate case IDs before execution;
- files only failed cases;
- routes each failure through `fileAutoIssue` using `failure-replay:<case-id>` as the ENG-240 dedupe key; and
- returns deterministic checked/failed/filed/deduped counts for monitoring.

Tests must inject `fileIssue`; this proves filing behavior without touching Linear or any other third party.
