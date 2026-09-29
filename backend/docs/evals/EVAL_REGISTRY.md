# Eval registry and audit (ENG-2134)

Part of ENG-2128 (Eval System v2), slice 1. The machine-readable registry is
`backend/src/loops/eval/evalRegistry.ts`; this page records the audit behind it. Audited
2026-09-25 against `origin/main` and read-only production checks.

## Rule: unvalidated graders cannot gate or alert

`mayGate(id)` is true only when the entry carries a `validation` with Cohen's κ ≥ 0.6 on at
least 30 labelled cases and an http(s) link to the run. **No grader qualifies today.** The agreement
harness (ENG-2136) produces those runs; record the result on the entry, with evidence.

Every entry also carries a `version` (ENG-2196): the grader's version constant in code where one
exists (a test keeps the two equal), `prompt-sha256:<12 hex>` for a judge whose prompt lives in
AW-Settings (read 2026-09-28), or `untracked@<date>` when neither code nor config versions it. The
Eval v2 tab lists every grader with its version.

## Inventory

| Id | Surface | Type | Model (family) | Validated |
| --- | --- | --- | --- | --- |
| session-judge-general | agent | LLM judge | gemini-3.5-flash (Gemini) | no |
| session-judge-fangfang | agent | LLM judge | gemini-3.5-flash (Gemini) | no |
| session-judge-matt | agent | LLM judge | gemini-3.5-flash (Gemini) | no |
| session-judge-outcome-b-shadow | agent | LLM judge, outcome rubric B, shadow + sampled, off until OPS-1 | anthropic.claude-sonnet-4-6 (Claude) | no |
| finalize-guard | agent | LLM judge | gemini-3.1-flash-lite (Gemini), off in prod | no |
| agent-run-verdict | agent | code | — | no |
| agent-task-success | agent | code, offline | — | no |
| agent-tool-correctness | agent | code, offline | — | no |
| agent-groundedness-offline | agent | code, offline (finalize-guard lexicon) | — | no |
| agent-reply-length-fixtures | agent | code, offline (ENG-1312 fixtures, placeholder inputs) | — | no |
| okareo-no-hallucinated-capabilities-v2 | agent | LLM judge (Okareo) | unknown | calibration set only |
| enrichment-golden-set | agent | code | — | golden set, CRM enrichment only |
| human-eval-queue | creative | human (free text) | — | no |
| onboarding-quality-pairwise | creative | LLM judge, offline pairwise (customer portal) | claude-sonnet-4-6 (Claude) | no |
| image-prompt-like-rate | creative | human (likes) | — | no |
| landing-page-smoke-test | creative | code | — | deterministic |
| creative-deterministic-gates | creative | code, advisory | — | no |
| creative-rubric-judge | creative | LLM judge, binary ENG-421 criteria per surface (ad image, organic image, ad copy, landing page) + runtime pairwise vs prior best, advisory, off by default | anthropic.claude-sonnet-5 (Claude) | no |
| creative-performance-correlation | creative | outcome: Spearman ρ of rubric score vs settled ad CTR/CPA, read-only report, no data until OPS-3 (ENG-2148) | — | no |
| client-health-assessment | account health | code | — | no |
| renewal-integration-health | account health | code, off in prod | — | no |
| account-health-evaluators | account health | code, log-only | — | no |
| account-health-classifier | account health | code, off until `ACCOUNT_HEALTH_ALERTS_ENABLED` (ENG-2143) | — | no (backtest: precision 0/1, recall 0/8) |
| crm-contact-lifecycle | account health (CRM contacts) | code | — | no |

Sources, consumers and known issues for each entry are in `evalRegistry.ts`.

## Findings

1. **The "Matt Judge" is not an independent judge.** Its prompt in AW-Settings `scoring-judges`
   is byte-identical to `default-scoring-prompt` and runs on the same model. Agreement between
   the general judge and the Matt judge carries no information.
2. **Every session judge is Gemini, and so is the agent default** (`agent_mode_default_model =
   gemini-3.8-flash`). ENG-2128 requires the judge to come from a different family (ENG-2138).
3. **The general judge cannot rank sessions.** ENG-1710/1714: AUC 0.67 against relaxed task
   completion, 83.6% of scores are 5, frustrated vs calm sessions 4.63 vs 4.69.
4. **Scores are a biased sample.** 8,462 of 19,293 sessions (44%) carry a score, written lazily
   when an admin opens the dashboard or `get_chat_history sync=true` backfills. ENG-2144 adds
   a random sampler (below), off until OPS-7 (ENG-2152).
5. **Almost no human labels exist.** 10 sessions carry `satisfactionScore.adminOverride`. No
   κ/agreement code exists anywhere. The Fangfang/Matt judges were never compared with
   Fangfang's or Matt's own judgments.
6. **The Daily Satisfaction Score Report is already paused** (schedule `d0dd32ee…`, last run
   2026-08-18). No alert consumes the satisfaction score today.
7. **The finalize guard is off in production**, so there is no `claim_mismatch` evidence for
   groundedness (shadow evidence: ENG-2150).
8. **Okareo checks live only in Okareo.** No check is defined in the repo or wired to CI; the
   v2 hallucination check's 11/11 is a calibration result, not human agreement.
9. **Nothing scores each generated creative.** In production, creative quality is free-text
   Slack feedback from a single reviewer. The only automated creative comparison is the
   customer portal's offline `scripts/eval-onboarding-quality.ts`: a Claude Sonnet pairwise judge
   that compares two onboarding pipeline versions layer by layer (including creative direction,
   ad images and ad copy) on fixture pairs. ENG-2140 adds `creative-rubric-judge` (ENG-421's
   7 criteria as binary checks), which stays off until its flag is turned on. ENG-2192 extends it,
   under the same flag and sample rate, to organic images, onboarding images and ad copy (stored on
   the AW-Users variants) and deployed landing pages (judged from their generated source), with a
   runtime pairwise verdict against the account's prior best ad; video keyframes are not scored
   yet. ENG-2141 links each
   generated creative to the Meta ad it became and records ad-level daily rows, so
   `creative-performance-correlation` can compare the judge's score with settled CTR/CPA; both
   stay inert until OPS-3 (ENG-2148).
10. **Account health mislabelled activation as risk** — a never-connected ad account read as
    blocked / At Risk. Fixed by ENG-2133.

## Agent graders (ENG-2137)

`loops/eval/agentGraders.ts` grades a session without an LLM: task success from the work plan
(ENG-1710 relaxed rule, with tool evidence for completed steps), tool-call correctness (loop-event
failure classes, plus ad-platform writes never read back — the grader side of ENG-592), groundedness
(finalize-guard lexicon vs successful tool calls) and cost / turns / tokens / tool latency per
successful task. `scripts/evalAgentGraders.ts` runs them read-only over a date range and prints
results per model × task type with n and a Wilson CI. None is validated; pass^k needs the sandbox
(ENG-1906).

## Online sampler (ENG-2144)

`cron/evalV2SamplerCron.ts` runs daily at 17:15 UTC when `EVAL_V2_SAMPLER_ENABLED=true`. It takes a
seeded uniform random sample of `EVAL_V2_SAMPLE_SIZE` (default 50) of the sessions whose last
activity fell on the previous UTC day (AdminUpdatedAtIndex query), grades them with the three
deterministic agent graders above, and writes to `Dev-AW-LoopEvents`:

| loopId | Sort key | Row |
| --- | --- | --- |
| `eval-v2` | `eval_v2_sample_run#<day>` | the day's frame size, seed and sampled session ids |
| `eval-v2` | `eval_v2_scored#<day>#<sessionId>` | one per sampled session: verdicts, reasons, counts, `graders` (`id@version`) |
| `eval-v2-daily` | `<day>#1d`, `<day>#7d` | aggregate per surface × task type × model: n, rate, 95% Wilson CI, `mayGate` per grader; cost and run time per success; spend attribution |
| `eval-v2-daily` | `<day>#<window>#creative` | creative gate pass rate (CI, failing checks) and rubric criteria-passed distribution, from AW-HumanEvalQueue results |
| `eval-v2-daily` | `<day>#<window>#account_health` | account-health state distribution and flip rate, from the classifier's rows in AW-AccountCapabilityRequirements |

**Efficiency (ENG-2196).** Each score carries the session's spend and run wall time. Spend comes
from one bounded query per billing subject on AW-SpendEvents' `BillingUserOccurredAtIndex` (an org
member's spend is billed to the org's billing root). Past 5,000 rows for one subject, that
subject's sessions report spend `truncated`, never a partial sum. Cost per success charges
failures to successes, as `efficiencyMetrics` does. Read-only prod on 2026-09-28: 42.7% of
AW-SpendEvents rows (38.8% of cost) have no session id. That spend is enrichment, X engagement,
landing pages, media generation and bare `agent_task` rows. Interactive and scheduled agent
sessions (`agent_task:interactive`, `agent_task:scheduled:*`) are 100% attributed. So for chat
sessions, the gap is media and landing-page generation that runs inside a session without its id.

**Creative and account health (ENG-2196).** Neither source table has an index by time or kind,
so each is read with a filtered, projected scan that stops at 20,000 evaluated items (on
2026-09-28 the tables held 1,243 and 7 items). A truncated or failed read writes a snapshot with
that status and no numbers. A flip is an account whose row version is above 1 and whose
`stateSince` falls in the window.

Scores are conditional puts on a deterministic key, so each (day, session) is written once; a
finished day is skipped. A live run refuses without the flag; `scripts/evalV2Sample.ts` dry-runs
any day read-only. `GET /api/admin/loops/eval-v2-trend` serves the snapshots to the partner-portal
**Eval v2** tab, which labels every grader "unvalidated" while `mayGate` is false. No alert reads
these rates: none of the graders is validated.

The satisfaction score is no longer a headline. Since ENG-2196, Chat History has no Satisfaction
column by default. The column, the lazy judge scoring that fills it and the admin override appear
only after an admin turns on "Show unvalidated legacy score". The judges and their stored scores
are unchanged, and the Daily Satisfaction Score Report schedule stays paused.

## Shadow outcome judge (ENG-2138)

Decision D1: ENG-1714's outcome rubric B on Claude Sonnet, in shadow, without touching the primary
score. It is one row in AW-Settings `scoring-judges` (id `outcome-judge-b-shadow`, `shadow: true`,
`sampleRate`), appended by OPS-1 (ENG-2146); without the row nothing runs. It uses the custom-judge
path, so it has the same cohort exclusions and appended ENG-* clauses, and writes only
`AW-ChatSessions.judgeScores.outcome-judge-b-shadow` (with `shadow: true` and the model). It scores
only a fixed hash-picked `sampleRate` share of sessions (an admin `force` rescore of one session
bypasses the sample), refuses a Google model, and is metered as system spend
(`outcome_judge_shadow`, per session id) rather than to the customer.

The measured rubric B text was never committed; `services/outcomeJudge.ts` holds a
reconstruction from ENG-1710/1714 and says which parts are reconstructed.
`scripts/evalOutcomeJudge.ts` re-measures it read-only: it judges a seeded sample of sessions
and prints AUC against the deterministic `agent-task-success` label, the share of 5s and
per-model means (aggregates only). The runValidation harness reads its stored scores for κ
against the golden set once labels exist (ENG-2135/2136).

## Offline suite and regression gate (ENG-2145)

`loops/scripts/runOfflineEvalSuite.ts` compares the registered replay cases, the ENG-1312 fixtures,
golden-set agreement and Okareo checks with a versioned baseline (`loops/eval/baselines/*.json`) and
prints pass / regression / unavailable. It fails closed on any evaluator problem. A metric may block
only when its grader passes `mayGate` and `EVAL_GATE_BLOCKING=true`, so today it is report-only.
Prompt, model and skill edits in AW-Settings / AW-Skills make a best-effort write of an `eval_needed`
marker (`Dev-AW-LoopEvents`, loopId `eval-gate`); a failed marker write never fails the edit, so that
edit is then missing from the marker feed. Details: `docs/evals/OFFLINE_EVAL_GATE.md`.

## Account-health classifier backtest (ENG-2143)

Re-run 2026-09-29, read-only, with `scripts/eng2143-account-health-backtest.ts`. The cutoffs were
the audit's (2026-05-01, 05-31, 06-30, 07-30, 08-29), with a 30-day horizon. The unit is an
(account, cutoff) pair, so pooled pairs are not independent accounts. CIs are Wilson 95%.

| | n | churned | predicted at_risk | tp | precision | recall |
| --- | --- | --- | --- | --- | --- | --- |
| Before (main `e2980e11e`) | 93 | 8 | 0 | 0 | n/a | 0.00 [0.00, 0.32] |
| After (behavioural signals) | 93 | 8 | 1 | 0 | 0.00 [0.00, 0.79] | 0.00 [0.00, 0.32] |

Per cutoff (after), as n / churned / predicted / tp:

| Cutoff | n / churned / predicted / tp |
| --- | --- |
| 05-01 | 18 / 4 / 0 / 0 |
| 05-31 | 17 / 2 / 1 / 0 |
| 06-30 | 17 / 0 / 0 / 0 |
| 07-30 | 19 / 1 / 0 / 0 |
| 08-29 | 22 / 1 / 0 / 0 |

**Not validated. The ≥ 0.8 precision target is not met, and it cannot be measured on this data.**
One account was predicted at-risk, and it did not churn.

The signals added, with how many pooled pairs each fired on:

- `spend_drop` (risk): the last 14 days of spend is ≤ 50% of the prior 14 days. It fired on 0
  pairs, because snapshots only start 2026-07-02 for one account and 2026-08-15 or later for the other
  five. No window before 08-29 has a collected prior window, so the trend is never evaluable in
  the backtest.
- `results_drop` (risk): leads stop for 14 days while spend continues, after at least 3 leads in
  the prior window. It fired on 0 pairs, for the same reason.
- `negative_feedback` (risk): at least 3 thumbs-down in 30 days, outnumbering thumbs-up. The
  ratings are image thumbs on sessions (264 in prod, from 2026-03). It fired on 1 pair, which was
  retained.
- `tracking_not_set_up` (activation, never risk): taken from the Meta tracking monitor. The
  monitor keeps no history, so it cannot be backtested.
- `ads_never_connected` (activation) fired on 66 pairs, 4 of which churned. It is activation by
  decision D6, not a churn prediction.

Thresholds were fixed before the run and were not tuned to the 8 churned accounts. Missed
commitments were **not added**:

- The only due-versus-done record is AW-GTMPlan work items.
- All 289 of their due dates fall between 2026-01-14 and 2026-04-10, before every cutoff.
- The DRI defaults to the customer's own email, so they do not record AgentWeb's commitments.

Results against a *promised* outcome are also not measurable. No numeric promise is stored: the
closest is the LLM-extracted `winMetric` text from Fathom sales calls. So `results_drop` compares
against the account's own recent leads instead.

The 18 undated cancellations per cutoff are now placed:

- AW-PaymentHistory keeps no raw Stripe event, and AW-Users no cancel timestamp, so no stored
  field holds `canceled_at`.
- All 18 accounts have no Stripe-sourced payment event since the log began (first row
  2026-04-06), and were created before it.
- Every webhook since then writes one: a cancellation writes `subscription_canceled`, a renewal
  writes `payment_succeeded`.
- So they canceled, and stopped paying, before the log began. The script counts them as
  `canceled_before_payment_log` (already churned) at every cutoff, not as missing positives.

Fixed in the same change: the live sweep and the backtest read ad spend from `account_day`
snapshot rows, which store spend 0 by design. So "ad spend in the last 30 days" was always 0.
Spend now comes from the campaign rows.

Routing is unchanged (decision D8): until `mayGate('account-health-classifier')` is true,
`at_risk` goes to needs-review, never oncall. Revisit when churn positives reach a size where a
precision CI can clear 0.8. With 8 positives it cannot.

## Known false-positive catalogue (session judges)

ENG-47 intermediate message index · ENG-168 greeting-only scored 3 · ENG-392 general judge
diverges on ambiguous paste · ENG-830 no-task floored at 3 · ENG-930 / ENG-995 / ENG-1190 /
ENG-1245 publish-gate holds scored as failures or fabrication · ENG-972 publish refusal and
awaiting-input spreads (open) · ENG-1165 blocked-external charged to goalCompletion · ENG-1223
fabricated output rewarded · ENG-1296 awaiting user reply · ENG-1312 blind to verbosity and
permission-asking · ENG-1669 judge call failures. These sessions seed the agent golden set
(ENG-2135).

## Adding or validating a grader

1. Add an entry to `EVAL_REGISTRY` (id, surface, type, source, model and family, consumers,
   known issues). `evalRegistry.test.ts` checks that ids are unique and code sources exist.
2. Run the agreement harness on the surface's golden set.
3. Record `validation: { kappa, n, date, evidence }`. Only then may alerts or gates read it.
