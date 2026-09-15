# ENG-502: automatic shadow capture — first production slice

## Shipping boundary

This implements capture → ENG-1550 persistence → authenticated ledger retrieval. It does **not**
complete ENG-502. [ENG-1967](https://linear.app/emmabyaw/issue/ENG-1967) owns adoption-backed,
scheduled evaluation; [ENG-1968](https://linear.app/emmabyaw/issue/ENG-1968) owns supported threshold
learning, deterministic global/client/campaign/channel context, expiry/history, and full-loop proof.
Those changes are not independently deployable yet, so this PR contains no dormant evaluator or
parallel memory store. Keep the PR draft; the controller owns subsequent gates and merging.

**Data-plane gate:** approve the optional `context` attribute on existing `AW-AdsOutcomeLedger`
items and the client-filtered read semantics before merge. No key, index, table provisioning,
backfill, retention, or production data write was performed in development. The attribute is a
new persistence contract even though DynamoDB needs no migration. Existing rows stay readable.

**Copy review:** the new shadow hypothesis/rationale/assumptions are readable through the existing
ledger API; review this wording before making it customer-visible. Tool names, prompts, and health
assessment response text are unchanged. The prediction is explicitly *uncalibrated*, not evidence
that refreshing a creative will recover performance.

## Behavior

The existing `assess_client_health` path detects CTR fatigue using ENG-918 thresholds. For up to three
CTR-drop findings per assessment (stable ad-id order) with complete campaign attribution and two valid reporting windows, it captures
a shadow creative-refresh proposal in ENG-1550. The proposed recovery magnitude is the relative
change from current ad CTR to prior ad CTR. It is a hypothesis, with the confounders and metric
scope recorded; it is not a fitted effect, confidence estimate, or instruction to execute.

Identity includes client, platform account, campaign, ad and reporting window. The existing
conditional create is authoritative. Retry conflicts require a strongly consistent read proving
scope; they retain the first prediction and timestamp even if platform metrics later settle.
A later reporting window is a distinct observation. No approval/adoption is inferred.

Records carry explicit **ad-level** scope. ENG-916 campaign/day snapshots cannot score this metric.
The manual scorer refuses these captures until an attributed evaluator supports their scope.
They remain pending/unreviewed, with a review date after the forecast horizon plus the existing
28-day Meta settling window. This date is not an evaluator, expiry mechanism, or settled-data proof.

Capture uses at most three concurrent proposals and 1.5-second abortable SDK requests (at most
two requests per proposal on a retry). Additional findings remain in the assessment and emit an
explicit omitted-count warning; this bounded first slice does not promise fleet-wide capture.
Capture failure is logged per finding and cannot claim success. Invalid or truncated platform
responses cannot generate a proposal. Existing health output remains available on ledger failure.
Reads exclude another client's new records even if both clients connect the same platform account.
Legacy rows retain the pre-existing account-level visibility contract.

## Acceptance mapping

| ENG-502 criterion | This slice |
| --- | --- |
| 1. Automatic structured capture | Implemented for the shadow CTR-fatigue proposal path |
| 2. Idempotency | Conditional create, stable scope/window identity, verified retry |
| 3–4. Scheduled evaluation, settling/noise/sample gates | ENG-1967; not implemented |
| 5. Supported threshold learning | ENG-1968; not implemented |
| 6. Scoped retrieval and isolation | Client isolation on ledger reads implemented; full context precedence remains ENG-1968 |
| 7. Provenance/confidence/expiry/history for learned items | Capture provenance and uncalibrated/review state only; no learned items yet |
| 8. Safe unavailable path | Implemented; output parity and observable storage failures |
| 9. Tests | Capture/isolation/retries/malformed attribution/rollback/failure covered; evaluator tests remain ENG-1967 |
| 10. Complete real loop verification | Capture/API-read procedure below; evaluation → learning proof remains ENG-1968 |

Numeric predictions remain in the ledger. No account-memory, playbook, threshold, ad-platform,
budget, or destructive write is introduced. Shadow mode is the only capture mode; `off` disables it.

## Reproducible validation

From `backend/`, sequentially (no full-suite run):

```sh
node --max-old-space-size=2048 node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  src/__tests__/eng502.capture.test.ts src/__tests__/clientHealth.test.ts \
  src/__tests__/eng1550.outcomeLedger.test.ts src/__tests__/eng1550.outcomeLedgerDb.test.ts \
  src/__tests__/eng1550.outcomeLedgerRoutes.test.ts src/__tests__/eng918.adsThresholds.test.ts
node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
```

Before implementation, the first four capture tests produced **3 expected failures / 1 passing
existing authorization control**: zero stored rows failed automatic capture, retry, and client
separation assertions. After implementation: **194 passing tests across six suites**, and production
TypeScript no-emit passes. The inherited dependency tree contained extraneous `@types/axios@0.9.36`,
absent from the lockfile. Worktree-local links exclude that obsolete ambient package; shared
`node_modules` and package/lock files were not changed.

Before/after rehearsal compared the original `clientHealthService.ts` from baseline
`c59c293abc13196e73161675ffb1f08c1db8e2f7` with the changed service under identical fixtures:
capture enabled, capture disabled, and storage failure returned deeply equal responses (3/3).
The temporary baseline module was removed afterward. Permanent tests retain enabled/disabled and
failure parity checks. No LLM invocation, provider routing, prompt, tool schema, dispatch, or memory
injection changes are in this slice. Okareo was not run; context-injection parity/Okareo remains an
explicit gate on ENG-1968. This is not a claim of live production verification.

## Real capture smoke after approval and deployment

1. Use the existing authenticated admin Emma tool `assess_client_health` with the exact email of
   an approved client who has a CTR-drop finding and complete ad/campaign attribution. Its backing
   request is `GET /api/client-health/:client_name_or_email`.
2. Confirm the assessment still reports the fatigue finding and normal health result. If no real
   eligible finding exists, report **not exercised**; never create a synthetic production DB row.
3. With that client's own authenticated session, call `GET /api/outcome-ledger/meta/:accountId`.
   Find the new `emma:creative-fatigue` record and verify its client/campaign/ad identity, source
   windows, evidence values/references, assumptions, horizon, review date and unknown adoption.
4. Repeat the assessment within the same reporting window. Read the ledger again: the same id and
   original `createdAt` must remain, with exactly one row per captured scope/window. Concurrent
   retries should produce the same result.
5. Authenticate as a second approved client. A foreign account is denied; on a deliberately shared
   platform account, the first client's contextual records must not appear.
6. Check application logs for `[AdsLearning] capture confirmed` or `capture failed`. Confirm no ad
   write, threshold update, account-memory update, or budget change occurred.
7. Stop at pending/unreviewed. No supported evaluation endpoint exists for these records yet;
   manual scoring must return 409 `attributed_evaluation_required`. Record the missing evaluator
   and full-loop proof against ENG-1967/1968, rather than claiming ENG-502 is done.

## Rollback

Set `ADS_LEARNING_MODE=off` and restart the backend to stop new captures. Keep the additive ledger
reader, context validation, and client filter deployed so captured audit records remain private and
readable. Do **not** roll the whole application back to a reader that discards context or omits its
client filter after records exist. Revert the capture import/call/module only if a code rollback is
needed. No row deletion, table migration, or threshold rollback is needed for this slice.

## Complexity and attribution

One capture adapter plus optional fields on the existing ledger. Reuse the existing fatigue detector,
threshold resolution, conditional write and read API. No new table, index, endpoint, scheduler, LLM,
dependency or memory subsystem. Net complexity increases for structured capture and boundary checks;
the remaining learning loop is intentionally tracked rather than hidden behind no-op scaffolding.

Accountable owner: Harsha Vankayalapati (`harshmoney123`). Execution actor: Astra (`gpt-6-astra`).
Run: `eng502-astra-20260915`. Argusoft branches/PRs were not modified or rebased.

## Local review

CodeRabbit identified two implementation issues: legacy finite numeric strings must remain readable,
and capture must not add unbounded serial latency to health requests. Both are fixed and covered by
regression tests (strict non-numeric rejection retained, three concurrent proposals maximum, SDK
request abort deadlines). Its separate persistence-approval finding is the explicit gate above;
this draft is not a claim that approval exists.
