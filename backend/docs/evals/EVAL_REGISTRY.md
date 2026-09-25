# Eval registry and audit (ENG-2134)

Part of ENG-2128 (Eval System v2), slice 1. The machine-readable registry is
`backend/src/loops/eval/evalRegistry.ts`; this page records the audit behind it. Audited
2026-09-25 against `origin/main` and read-only production checks.

## Rule: unvalidated graders cannot gate or alert

`mayGate(id)` is true only when the entry carries a `validation` with Cohen's κ ≥ 0.6 on at
least 30 labelled cases and an http(s) link to the run. **No grader qualifies today.** The agreement
harness (ENG-2136) produces those runs; record the result on the entry, with evidence.

## Inventory

| Id | Surface | Type | Model (family) | Validated |
| --- | --- | --- | --- | --- |
| session-judge-general | agent | LLM judge | gemini-3.5-flash (Gemini) | no |
| session-judge-fangfang | agent | LLM judge | gemini-3.5-flash (Gemini) | no |
| session-judge-matt | agent | LLM judge | gemini-3.5-flash (Gemini) | no |
| finalize-guard | agent | LLM judge | gemini-3.1-flash-lite (Gemini), off in prod | no |
| agent-run-verdict | agent | code | — | no |
| agent-task-success | agent | code, offline | — | no |
| agent-tool-correctness | agent | code, offline | — | no |
| agent-groundedness-offline | agent | code, offline (finalize-guard lexicon) | — | no |
| okareo-no-hallucinated-capabilities-v2 | agent | LLM judge (Okareo) | unknown | calibration set only |
| enrichment-golden-set | agent | code | — | golden set, CRM enrichment only |
| human-eval-queue | creative | human (free text) | — | no |
| onboarding-quality-pairwise | creative | LLM judge, offline pairwise (customer portal) | claude-sonnet-4-6 (Claude) | no |
| image-prompt-like-rate | creative | human (likes) | — | no |
| landing-page-smoke-test | creative | code | — | deterministic |
| creative-deterministic-gates | creative | code, advisory | — | no |
| client-health-assessment | account health | code | — | no |
| renewal-integration-health | account health | code, off in prod | — | no |
| account-health-evaluators | account health | code, log-only | — | no |
| account-health-classifier | account health | code, off until `ACCOUNT_HEALTH_ALERTS_ENABLED` (ENG-2143) | — | no (backtest n too small) |
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
   ad images and ad copy) on fixture pairs.
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
| `eval-v2-daily` | `<day>#1d`, `<day>#7d` | aggregate per surface × task type × model: n, rate, 95% Wilson CI, `mayGate` per grader |

Scores are conditional puts on a deterministic key, so each (day, session) is written once; a
finished day is skipped. A live run refuses without the flag; `scripts/evalV2Sample.ts` dry-runs
any day read-only. `GET /api/admin/loops/eval-v2-trend` serves the snapshots to the partner-portal
**Eval v2** tab, which labels every grader "unvalidated" while `mayGate` is false. No alert reads
these rates: none of the graders is validated.

The satisfaction score is no longer a headline: the chat-history badges moved to the last column,
labelled unvalidated, with neutral colours. The judges and their stored scores are unchanged, and
the Daily Satisfaction Score Report schedule stays paused.

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
