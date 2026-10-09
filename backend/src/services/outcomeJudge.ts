/**
 * Shadow outcome judge (ENG-2138, ENG-2128 T6; decision D1).
 *
 * The production session judge (gemini-3.5-flash, AW-Settings `default-scoring-model`) is the
 * agent's own family and cannot tell a finished task from an unfinished one: ENG-1710/1714
 * measured AUC 0.67 against task completion with 83.6% of scores at 5. The same A/B measured
 * outcome rubric B on claude-sonnet-4.6 at AUC 0.79 with 2.6% at 5. D1: run rubric B on Sonnet
 * in shadow, write it to a new field, never touch the primary score, sample to bound cost.
 *
 * A shadow judge is one row in AW-Settings `scoring-judges` with `shadow: true`. It goes through
 * the custom-judge path (`scoreSessionWithJudgeIfNeeded`), so it gets the same cohort
 * exclusions and appended ENG-* clauses as every judge, and it writes only
 * `AW-ChatSessions.judgeScores[<judge id>]`; `satisfactionScore` is never read or written by it.
 * On top of that path a shadow judge:
 *   - runs only on its sample: a fixed share (`sampleRate`, 0..1) of sessions, picked by a hash
 *     of judge id + session id, so a session is either always or never in the sample however
 *     often the lazy scoring paths touch it. A missing or 0 rate means it never runs;
 *   - uses its own model (`llmModel`, default Sonnet 4.6, the model rubric B was measured on),
 *     not the per-org `scoring_judge` role (#3067): a per-org override would make shadow scores
 *     incomparable across orgs, and could route them back to the agent's family;
 *   - refuses a Google model, or a model the registry does not know (the agent default is Gemini);
 *   - is metered as system spend (`outcome_judge_shadow`, with the session id, no user id), so
 *     the cost per judged session is in AW-SpendEvents and never charged to a customer.
 *
 * Inert until OPS-1 (ENG-2146) appends the row; `buildOutcomeShadowJudgeRow` produces it.
 */
import { LLM_MODEL_REGISTRY } from './agentMode/llmModelRegistry';
import type { ScoringJudge } from './sessionScoringService';
import { seededRandom } from '../loops/eval/evalV2Sampler';

export const OUTCOME_SHADOW_JUDGE_ID = 'outcome-judge-b-shadow';
export const OUTCOME_SHADOW_JUDGE_NAME = 'Outcome Judge (shadow)';
/** The model rubric B was measured on in ENG-1710 (via OpenRouter; still served, `legacy` in the picker only). */
export const DEFAULT_OUTCOME_JUDGE_MODEL = 'anthropic.claude-sonnet-4-6';
/** Metering feature for shadow-judge calls: cost per judged session is AW-SpendEvents by this feature + session id. */
export const OUTCOME_JUDGE_SHADOW_FEATURE = 'outcome_judge_shadow';
export const OUTCOME_RUBRIC_B_VERSION = '2026-10-09.reconstructed-3';

/** Providers the agent runs on by default (`agent_mode_default_model` = gemini-3.8-flash). */
const AGENT_DEFAULT_PROVIDERS = new Set<string>(['google']);

/**
 * Rubric B, RECONSTRUCTED. The measured text (`RECOMMENDED_PROMPT_B.txt`, ~4 KB) lives only on
 * Harsha's machine and the swarm host (`judge-ab/prompts/B_outcome.txt`) and was never committed.
 * What is recovered from ENG-1710/ENG-1714 and kept here: B grades the outcome (was the requested
 * task actually delivered), not the user's mood; it is the variant without mandatory evidence
 * quotes (that was C) and without a separate terminal-state question (that was D); it pushes
 * scores off 5 (2.6% at 5); it counts a delivered task with one optional trailing plan step left
 * pending as done (the relaxed label); and it names a `set_work_plan_status` blocker as a miss
 * (one of the two real judge misses in the spot-check). The anchors, wording and the
 * rationale-before-score order are this file's reconstruction, not the measured text; the offline
 * replay (scripts/evalOutcomeJudge.ts) re-measures it before any promotion. The output keeps
 * the JSON contract every judge shares (score, reason, three dimensions), so the appended ENG-*
 * clauses and parsing apply unchanged.
 *
 * reconstructed-2 (ENG-2189) adds three binary criteria in `dimensions`: arguedWithInstruction,
 * escalatedWhenNotRequired and failedToEscalate. They are the golden-set agent criteria of the
 * same names, so their agreement with human labels can be measured.
 *
 * reconstructed-3 (ENG-2138, 2026-10-09): the replay (ENG-2356, 2026-10-08) measured
 * reconstructed-2 at AUC 0.58 and 28.6% at 5 — far short of the original's measured 0.79 / 2.6%,
 * and barely separating success (mean 4.20) from failure (mean 4.00) sessions. Of 77 scored
 * sessions, 22 were labelled failures and NONE scored 1 or 2 — the model never used the bottom of
 * its own scale. reconstructed-2 asked the model to form a holistic impression and pick a score;
 * this version instead makes the score a mechanical function of an itemised checklist the model
 * must write before scoring, because the holistic framing is exactly where the leniency entered.
 * This is a reasoned revision, not a re-measurement: it has not yet been validated by
 * scripts/evalOutcomeJudge.ts (that requires OPENROUTER_API_KEY, which this build-side identity
 * cannot read — see ENG-2138's open comment). It should not be treated as passing until that
 * replay confirms it, and the original un-reconstructed prompt (Harsha's machine / the swarm
 * host's judge-ab/prompts/B_outcome.txt) remains the better fix if it can be recovered, since it
 * is proven rather than inferred.
 */
export const OUTCOME_RUBRIC_B_PROMPT = `You are grading the OUTCOME of a session with an AI marketing agent. Your job is to decide whether the task the user asked for was actually done, not whether the conversation felt pleasant.

Most sessions have at least one gap. Do not round up out of politeness, and do not let a confident, well-formatted final message substitute for evidence — that is precisely the failure mode this rubric exists to catch.

Read the whole transcript, including the tool-call manifest and the tool results. Then, before you score anything, write a checklist:
1. List each concrete deliverable or action the user asked for, one per line.
2. For each one, mark it DELIVERED, PARTIAL, or NOT DELIVERED. DELIVERED requires a successful tool result for the action, or the finished content itself in the conversation. The assistant saying "done", "published" or "I've set it up" is NOT evidence on its own — if that is the only support, mark it PARTIAL. If the work plan ended with a step blocked or pending (for example set_work_plan_status reporting a blocker), that deliverable is NOT DELIVERED whatever the final message says.
3. Note separately: failed or missing tool calls, errors the agent did not resolve, questions it never answered, work handed back to the user that the agent could have done itself, and user friction (having to repeat the request, nudge the agent to continue, or correct its output).

The score is a direct function of that checklist. Do not override it with a holistic impression:
- Any deliverable marked NOT DELIVERED → score 1 or 2. Use 1 only when nothing useful was delivered at all, or the agent refused a legitimate request, or it presented fabricated results as done; otherwise 2.
- No deliverable NOT DELIVERED, but at least one marked PARTIAL, or a material part of the request untouched → score 3.
- Every deliverable DELIVERED, but a minor or optional item is missing (for example one optional trailing review step left pending) or there are small quality issues that do not change the result → score 4.
- Every deliverable DELIVERED with evidence, nothing material pending, nothing a careful reviewer would fix → score 5. Reserve 5 for sessions where your own checklist shows zero gaps — if you had to think about whether something counts, it is not a 5.

Rules:
- A limitation outside the agent's control that it correctly identified and explained (a missing integration, an approval it must wait for) is handled correctly; score the handling, not the limitation.
- When the user asked only a question, the deliverable is a correct, specific answer; "DELIVERED" means the answer is actually correct, not merely that one was given.
- Politeness, length and formatting do not earn points and are not part of the checklist.

Write the checklist first, then the reason (a brief summary of the checklist, not a replacement for it), then the score the checklist requires. Rate three dimensions (1-5 each) the same way — derive them from the checklist, not a separate impression:
- goalCompletion: were the requested deliverables actually completed? This should track the checklist directly (DELIVERED-heavy → high, NOT DELIVERED present → low).
- dataAccuracy: are the facts, numbers and claims backed by tool results rather than invented?
- outputQuality: is what was delivered specific, correct and usable as-is?

Then answer three yes/no questions about how the agent handled the user, as true or false in the same "dimensions" object. Each is false when its situation did not arise.
- arguedWithInstruction: the user gave an explicit instruction that involved no spending, publishing, sending or irreversible action, and the agent argued, pushed back or substituted its own plan instead of doing it. Doing the task and noting a concern in one sentence is not arguing. Neither is a required safety refusal, or one clarifying question about a genuinely ambiguous instruction.
- escalatedWhenNotRequired: the agent handed the problem to a human when it could have resolved it itself. Handing off means filing it with report_product_issues, telling the user to contact support or the team, or asking the user to do the work themselves. "Could have resolved it" means the tool or data it needed was available, a retry or another approach would have worked, or the request was within its capabilities.
- failedToEscalate: the agent hit a problem it could not resolve itself (a tool that kept failing, a platform bug, a missing capability or integration, or the user reporting something broken), and it neither filed it with report_product_issues nor told the user plainly what was blocked and what they or the team need to do. For example, it kept retrying, claimed success, or stopped without explanation.

Respond with ONLY valid JSON, with the reason before the score:
{"reason": "<what was asked, what was delivered with evidence, what was left undone>", "score": <1-5>, "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>, "arguedWithInstruction": <true|false>, "escalatedWhenNotRequired": <true|false>, "failedToEscalate": <true|false>}}`;

/** The judge's sample share, clamped to [0, 1]; missing or not a number is 0 (never runs). */
export function shadowSampleRate(judge: Pick<ScoringJudge, 'sampleRate'>): number {
  const rate = judge.sampleRate;
  return typeof rate === 'number' && Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0;
}

/**
 * Whether `sessionId` is in the shadow judge's sample. Deterministic per (judge, session), so
 * the lazy scoring paths, which may touch a session many times, cannot widen the sample.
 */
export function isInShadowSample(judge: Pick<ScoringJudge, 'id' | 'sampleRate'>, sessionId: string): boolean {
  const rate = shadowSampleRate(judge);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return seededRandom(`${judge.id}:${sessionId}`)() < rate;
}

/** Throws unless the model is registered and not from the agent's default family. */
export function assertOutcomeJudgeModelAllowed(model: string): void {
  const provider = LLM_MODEL_REGISTRY[model]?.provider;
  if (!provider || AGENT_DEFAULT_PROVIDERS.has(provider)) {
    throw new Error(
      `Shadow judge model '${model}' is ${provider ? `from ${provider}, the agent's default family` : 'not in the model registry'}; ` +
        'a shadow outcome judge must come from a different family than the agent (ENG-2128 principle 1).',
    );
  }
}

/** The `scoring-judges` row OPS-1 (ENG-2146) appends. */
export function buildOutcomeShadowJudgeRow(opts: { sampleRate: number; now?: Date; model?: string }): ScoringJudge {
  const at = (opts.now ?? new Date()).toISOString();
  return {
    id: OUTCOME_SHADOW_JUDGE_ID,
    name: OUTCOME_SHADOW_JUDGE_NAME,
    systemPrompt: OUTCOME_RUBRIC_B_PROMPT,
    llmModel: opts.model ?? DEFAULT_OUTCOME_JUDGE_MODEL,
    shadow: true,
    sampleRate: opts.sampleRate,
    createdAt: at,
    updatedAt: at,
  };
}
