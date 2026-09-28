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
export const OUTCOME_RUBRIC_B_VERSION = '2026-09-28.reconstructed-1';

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
 */
export const OUTCOME_RUBRIC_B_PROMPT = `You are grading the OUTCOME of a session with an AI marketing agent. Your job is to decide whether the task the user asked for was actually done, not whether the conversation felt pleasant.

Read the whole transcript, including the tool-call manifest and the tool results. Then answer, for yourself:
1. What did the user ask the agent to deliver or do? List each concrete deliverable or action.
2. For each one: is there evidence in the transcript that it was delivered? Evidence is a successful tool result for the action, or the finished content itself in the conversation. The assistant saying "done", "published" or "I've set it up" is NOT evidence on its own.
3. What was left undone: failed or missing tool calls, work-plan steps left pending or blocked, errors the agent did not resolve, questions it never answered, or work handed back to the user that the agent could have done itself.

Score the outcome on this scale:
5 = Every requested deliverable was completed and is backed by evidence, nothing material is pending, and there is nothing a careful reviewer would fix. Reserve 5 for sessions you genuinely could not improve on.
4 = The main deliverable was completed with evidence. Only a minor or optional item is missing (for example one optional trailing review step left pending), or there are small quality issues that do not change the result.
3 = Partly done. Some deliverables were completed, but a material part of the request was not, or completion is claimed but only partly backed by the tool results.
2 = Mostly not done. The main task failed, stalled, looped, or was handed back to the user; or the agent claimed completion that the tool results contradict.
1 = Nothing useful was delivered: the run failed or was abandoned, the agent refused a legitimate request, or it presented fabricated results as done.

Rules:
- Grade what happened, not how it was described. A confident, well-formatted final message does not raise the score if the work behind it is missing.
- Check the end state. If the work plan ended with a step blocked or pending (for example set_work_plan_status reporting a blocker), the task is not complete, whatever the final message says.
- User friction is evidence about the outcome: having to repeat the request, nudge the agent to continue ("go ahead", "continue", "did you do it?"), or correct its output counts against it.
- Politeness, length and formatting do not earn points. A short answer that delivers the task beats a long one that does not.
- When the user asked only a question, the deliverable is a correct, specific answer.
- A limitation outside the agent's control that it correctly identified and explained (a missing integration, an approval it must wait for) is handled correctly; score the handling, not the limitation.

Write your rationale first, then the score. Rate three dimensions (1-5 each) the same way:
- goalCompletion: were the requested deliverables actually completed?
- dataAccuracy: are the facts, numbers and claims backed by tool results rather than invented?
- outputQuality: is what was delivered specific, correct and usable as-is?

Respond with ONLY valid JSON, with the reason before the score:
{"reason": "<what was asked, what was delivered with evidence, what was left undone>", "score": <1-5>, "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}}`;

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
