# ENG-502 / ENG-1967 / ENG-1968 — shadow learning loop

**DRAFT — DATA-PLANE APPROVAL REQUIRED. Do not merge or deploy this branch yet.**

The capture-only boundary in the previous revision is superseded. This branch now implements
capture → ledger → scheduled settled evaluation → scoped account-memory guidance → explicitly
reviewed ENG-918 parameter promotion/revert. It performs no autonomous campaign writes or spend
increases. All development writes used an in-memory DynamoDB transport; no production writes,
manual production fixture rows, deployment, or production verification occurred.

## Remaining external gates

1. **Harsha's data-plane approval:** approve the extended ledger context (campaign measurement
   scope and execution receipt), `inconclusive` verdict, atomic ledger/account-memory writes,
   structured account-memory lifecycle metadata, client-filtered legacy read semantics, and
   reviewed threshold/lifecycle transactions. No new table, key, index, retention change or
   backfill. Existing `StatusEvaluationDateIndex` was confirmed **ACTIVE** with a read-only
   `describe-table`; evidence is linked below. Existing ambiguous legacy records stay stored but
   are hidden from client reads. They have no trustworthy client ownership attribution;
   `createdBy` identifies the administrator/execution actor, not the client.
2. **Review new external wording:** campaign hypotheses/assumptions, scoped guidance, tool input
   descriptions, and review/decline error text are new customer/model-visible copy.
3. **Okareo comparison on the changed build:** no Okareo tool is bound in this session. The
   archived local runner was found, but its prerequisite check fails:
   ```sh
   python3 /home/harsha/.claude/plugins/marketplaces/okareo-tools/reps/run_suite.py --help
   # ModuleNotFoundError: No module named 'okareo'
   ```
   This is not a simulation pass. The documented existing production baseline target is
   `emma-prod-anthropic.claude-opus-4-8`; the changed build has not been deployed to an isolated
   comparison target. Do not run against production to substitute for changed-build evidence.
   Keep the receipt-hook/tool-retrieval/memory-filter slice unmerged until the same scenarios
   and checks are compared on baseline and the changed build. No new permanent human gate.
4. After those gates, the ordinary current-head build/CI checks, approved deployment and real
   end-to-end smoke must run. The parent criterion explicitly requiring **production** proof
   remains unfulfilled; deterministic local proof is not production proof.

## Implemented behavior

### Capture and response compatibility

`assess_client_health` captures at most three CTR-fatigue findings in stable ad-id order.
Original ad-level predictions remain ad-level. A companion campaign prediction is created only
when ENG-916 supplies complete, tenant-matching 28-day campaign snapshots (two 14-day windows) with
valid click/impression counts and a campaign CTR decline. No averaging ad CTRs into a campaign
metric. Both record rationale, evidence references, assumptions, uncalibrated prediction,
evaluation horizon, actor, and client/account/campaign/ad/window identity.

All capture I/O, including conflict reads and optional campaign capture, shares **one 100 ms total
deadline**. SDK requests are aborted; a promise deadline remains authoritative even if abort
settles late. Late rejections remain handled. Failure/omission logs never claim successful capture.
The health response stays unchanged. Conditional creates preserve original predictions on retries.

### Execution provenance and scheduled evaluation

The existing confirmed creative-update path records a receipt only after its existing read-back
reports `verified: true`; an API success without read-back proof is insufficient. It matches the
latest pending client/account/ad/window per measurement grain, within a separate 100 ms observer
budget (50 ms maximum for candidate lookup). No receipt authorizes an intervention. An explicit
owner decline records a negative receipt; absence remains **unknown**, never false.

Every 15 minutes, the existing server cron registry runs one bounded GSI page (100 due records).
A process-local cursor rotates pages, and the normal cron switch and shutdown registry apply.
Replicas can race: a transaction conditionally scores the pending row and creates its deterministic
memory projection together. The condition also compares the context, preventing a concurrent
receipt from being overwritten. Failure leaves the row pending; malformed rows and failures emit
observable errors. No duplicate lesson or second verdict on replay.

Meta uses 28 days; Google uses 90. Only campaign CTR is currently supported for scoring; the
production capture/verified-execution adapter is Meta. Ad-level outcomes are honestly unscoreable.
Supported comparisons require complete daily baseline/outcome windows, matching tenant/account/
campaign/platform/currency/timezone, exact data, final-window refresh timestamps, a verified receipt
outside both measurement windows, at least 1,000 impressions and 30 clicks per window, and spend
movement within 20%. Noise is the maximum of binomial uncertainty, that campaign's observed daily
variation, and a 1% relative floor. Direction outside that band is correct/incorrect; small samples,
noise and spend confounding are inconclusive. Missing attribution/data is unscoreable. These are
**observational direction comparisons, not causal treatment-effect claims**.

### Learning, precedence and reversal

Only scoreable campaign outcomes create qualitative lessons in existing `AW-AccountMemory`.
Unscoreable/ad-only outcomes remain in the ledger. Lessons carry outcome/receipt references,
confidence, creation/update/expiry timestamps, review state and bounded reversible history.
Numeric predictions/scores remain in `AW-AdsOutcomeLedger`; parameter history remains in ENG-918.

Retrieval is deterministic: code-owned global policy → client → campaign → channel/playbook.
All persisted layers are scoped to the authenticated client and platform account; omitted campaign
scope never broadens a campaign lesson. Retrieval reads at most 100 stored items and returns at
most 20 ordered items, with explicit truncation logging. Proposed guidance is labelled proposed
and advisory. Expired/reverted guidance is excluded. Generic account-memory readers exclude these
structured lessons, fill ordinary-memory limits across filtered pages (jumping the contiguous learning key range), and reject malformed data. Category-index reads fail explicitly if their bounded page budget is exhausted.
Generic edits/deletes cannot erase their review history.

The loop proposes; **only an explicit authenticated owner review** promotes a parameter. Thirty
independent correct campaign outcomes are required, with duplicate execution receipts and
intersecting observation windows excluded. The median observed CTR drop proposes the existing
`creativeFatigue.ctrDropCriticalPct` parameter. ENG-918 enforces sample size, absolute bounds,
per-cycle movement cap, explicit-user precedence and revert cooldown. New promotions require new
outcomes after the preceding parameter revision; another lesson cannot replay the same batch to
walk the cap. Shared accounts fail closed for client-derived parameter promotion because ENG-918
is account-keyed. Reviewed guidance can be scoped to the client, campaign, or channel.

Threshold and lesson review writes are atomic and compare the prior revisions. Revert uses the
existing ENG-918 default/cooldown/history behavior, and refuses to undo an intervening parameter
change. Automatically learned parameter effects expire after 90 days without deleting history;
explicit user values retain precedence and do not expire. No numeric fitting claims calibrated
causality or permission to spend.

**Bounded-capacity behavior:** receipt matching and promotion inspect at most 100 account ledger
records and refuse incomplete pages. Scoped retrieval logs truncation. These limits deliberately
trade coverage for bounded work; a saturated account does not fabricate receipt/sample evidence.
Capture also logs omitted candidates. This is not a claim of exhaustive fleet capture or retrieval.

## Surfaces

- Existing `assess_client_health`: automatic capture, response unchanged.
- Existing `get_ads_thresholds`: optional `include_learning: true` and `campaign_id` return scoped
  guidance. Without that flag, existing output is unchanged. Retrieval failure preserves parameters
  and returns `learningUnavailable: true`.
- `GET /api/outcome-ledger/:platform/:accountId/learning?campaignId=...`: scoped guidance.
- `POST /api/outcome-ledger/:platform/:accountId/learning/:memoryId/approve` with optional
  `{campaignId, scope: "client" | "campaign" | "channel"}`: explicit reviewed promotion.
- Same path ending `/revert`: conditional rollback, retaining evidence/history.
- `POST /api/outcome-ledger/:platform/:accountId/:recommendationId/decline`: explicit non-adoption.
- Existing manual score route still refuses captured/contextual records.

## Acceptance mapping

| Parent contract | Implementation / evidence |
| --- | --- |
| Real recommendation-producing capture with scope/evidence/actor | Health assessment, ad and supported campaign companions |
| Idempotent recording | Stable scoped identity + conditional create |
| Scheduled adopted/correct/incorrect/inconclusive/unscoreable evaluation | GSI cron, receipt-only adoption, pure evaluator, atomic completion |
| Platform settlement and campaign-specific noise/sample gates | Meta/Google windows; complete-window, sample, spend and uncertainty tests |
| Supported ENG-918 learning, caps, provenance, rollback | 30 independent outcomes; explicit review; atomic promotion/revert; expiry |
| Deterministic global/client/campaign/channel retrieval; tenant isolation | Existing tool + authenticated API; shared-account and foreign-row regressions |
| Qualitative memory versus numeric ledger separation | Existing account-memory table projection; generic injection exclusion |
| Learned lifecycle | References/confidence/timestamps/90-day expiry/review/history |
| Shadow default and no autonomous spend/destructive writes | No campaign writer in loop; only observes existing verified execution |
| Compatibility and honest failures | Total deadline, late rejection test, failure logs, baseline response comparison |
| Tests for isolation/replay/noise/attribution/rollback/failure | 381 focused tests, 14 suites |
| Production end-to-end verification | **Pending approval/deployment**; local full-loop proof passes |

Thus the engineering slices are implemented; **not every ENG-502 acceptance criterion is complete**:
production verification and the required Okareo comparison remain external gates.

## Verification evidence and reproduction

[RED evidence](ENG-502-evidence/red.txt) retains expected behavioral failures before each named
implementation. Major runs: review fixes 5 failed/39 passed; evaluator 10/1; learning 4/2; loop 3/1;
promotion 3/6. Smaller follow-up runs are individually recorded, not inflated to three failures.
[Focused regression](ENG-502-evidence/final-tests.txt): **381 passed / 14 suites**.
[Checks](ENG-502-evidence/checks.txt): production TypeScript no-emit and `git diff --check` passed.
[Parity](ENG-502-evidence/parity-summary.json): against prior head
`61ea656e66e0271ae8075a2cacfc61bf13bb3d5c`, 120 unchanged fixture tests passed and **25 creative-update
response pairs were identical**, including failure/unverified cases. The same existing fixtures
and assertions ran on both modules; temporary baseline modules were removed. Existing health
capture-enabled/off/failure parity tests also remain. This does not replace an LLM simulation.
[GSI metadata](ENG-502-evidence/gsi-readonly.json) and [Okareo prerequisite failure](ENG-502-evidence/okareo-runner.txt).

From `backend/`, sequentially on this host:

```sh
node --max-old-space-size=2048 node_modules/jest/bin/jest.js --silent --runInBand --runTestsByPath \
  src/__tests__/eng502.capture.test.ts src/__tests__/eng502.loop.test.ts \
  src/__tests__/eng1967.evaluator.test.ts src/__tests__/eng1968.learning.test.ts \
  src/__tests__/eng1550.outcomeLedger.test.ts src/__tests__/eng1550.outcomeLedgerDb.test.ts \
  src/__tests__/eng1550.outcomeLedgerRoutes.test.ts src/__tests__/eng918.adsThresholds.test.ts \
  src/__tests__/eng918.adsThresholdsDb.test.ts src/__tests__/eng918.adsThresholdsRoutes.test.ts \
  src/__tests__/eng918.getAdsThresholdsTool.test.ts src/__tests__/clientHealth.test.ts \
  src/__tests__/accountMemory.test.ts src/__tests__/agentModeService.metaAdsCRUD.test.ts
node --max-old-space-size=3072 node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json
```

The loop test uses the real capture, ledger, bounded snapshot reads, receipt observer, evaluator,
account-memory projection and threshold services. Only AWS transport is in memory. Fixture metrics
enter through `adsMetricsDb.putSnapshot`; ledger/memory/threshold records are produced by the actual
services, never manually seeded. It proves both unsupported outcomes staying out of guidance and
supported capture → receipt → due evaluation → scoped retrieval, plus 30-outcome promotion/revert.

Local CodeRabbit reviewed the evolving branch. Applicable findings were fixed: helper extraction,
ordinary-memory pagination, unsupported/ad-scope guidance exclusion, receipt deadline allocation,
baseline date-key normalization, and stale documentation. Its duplicate-function finding did not
match the source (one declaration; TypeScript passes). Its index concern was resolved by read-only
ACTIVE-index evidence, not by provisioning. The second review completed with eight findings (including a duplicate). Fixed its applicable findings: generic-memory key-range starvation, optional campaign review scope, malformed query input, direct evaluator date validation, and threshold revision validation. Its data-plane hold remains. The request to remove the external Okareo command was declined because Harsha explicitly requested the exact command/blocker; the command is historical failure evidence, not a portable setup claim. Missing campaign scope remains intentionally valid for client/channel retrieval, while provided malformed scope is rejected. See [review dispositions](ENG-502-evidence/review.txt). No clean latest-SHA remote-review claim is made.

## Post-approval smoke and rollback

After approval, current-head build/CI, and deployment: invoke `assess_client_health` for an approved
client with a real eligible fatigue finding and complete campaign snapshots; read its ledger as that
client; retry and verify unchanged identity/time. A real, separately approved creative refresh must
produce a **verified** receipt. Wait for distinct post-intervention measurement days and platform
settlement; observe the scheduled verdict and query scoped guidance using the existing tool or API.
Verify a peer on a shared account cannot read the record or guidance. If sufficient independent
outcomes do not exist, record promotion **not exercised**; never seed production DB rows or invent
adoption. No campaign change is authorized by this runbook alone.

Set `ADS_LEARNING_MODE=off` and restart to stop capture, receipt observation and evaluation. Retain
privacy filters, structured-memory exclusion and new verdict/context readers once rows exist.
Revert an approved parameter through the review endpoint while its revision is still current, or use
the existing ENG-918 owner revert surface. Never delete provenance. Do not roll back to a reader
that exposes context-less/shared-client rows or injects unreviewed lessons indiscriminately.

## Complexity and attribution

Net complexity **increases** for the evaluator, receipt adapter, atomic storage adapter, scoped
learning/review and tests. Reuses three existing stores, the existing GSI, server cron registry,
existing creative read-back, and ENG-918 governance. New tables/indexes/dependencies/LLM calls: **0**.
New scheduler: **1**; four authenticated learning/decline surfaces and optional existing-tool inputs.
No parallel memory store. The bounded lookup limits above are explicit, not hidden coverage claims.

Prior commits and immutable run `eng502-astra-20260915` are preserved. Accountable owner remains
Harsha Vankayalapati (`142fef82-4d45-4070-99be-c5debe565ac6`, GitHub `harshmoney123`). Continuation
execution actor: Codex; run `eng502-codex-continuation-20260915`. No Argusoft branches or rows changed.
