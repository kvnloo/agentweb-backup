import { agentModeService } from './agentModeService';
import { extractJson } from './util/extractJson';

/**
 * Dedup judge for user-filed requests (report_product_issues + the in-app bug button).
 *
 * Given a new filing and a set of OPEN candidates, find the one that is the *same underlying
 * feature/bug* (reworded is fine). Used to group a new report onto an existing canonical
 * instead of creating a duplicate. The candidate source is the CALLER's choice — features
 * dedup against public Featurebase posts; bugs dedup against private Linear bug canonicals —
 * so this judge is decoupled from where canonicals live.
 *
 * Design notes:
 * - The match decision is a focused LLM judge (not a keyword heuristic, not Emma's freeform
 *   reasoning) with a confidence gate biased toward NEW (a false-merge is worse than a missed
 *   one — periodic review catches the tail).
 * - The judge returns a 1-based INDEX into the shown list (not a free-form id) so it cannot
 *   hallucinate an identifier; we map the index back to the candidate.
 * - Model is sourced from settings via agentModeService.getDedupJudgeModel() — NOT a
 *   hardcoded literal. ENG-9: setting that config value to an `openrouter/<provider>/<model>`
 *   id already routes this call through OpenRouter — no code change needed here.
 * - Best-effort: any error returns null so a filing is never blocked.
 */

const JUDGE_TIMEOUT_MS = 12000;
const MATCH_CONFIDENCE_THRESHOLD = 75; // bias to NEW: only stack on a confident match
export const MAX_CANDIDATES = 30;
// ENG-1335: the substantive ask often sits past a preamble ("REPEAT REQUEST — …", evidence
// tables), so 600 chars routinely cut it off. Still bounded: 30 candidates × 1200 ≈ 9k tokens.
const MAX_TEXT_CHARS = 1200;

export type DedupItemType = 'feature_request' | 'bug';

export interface DedupInput {
  type: DedupItemType;
  title: string;
  description: string;
}

/** A canonical the new filing might match. `ref` is opaque to the judge — the caller keys
 *  its own full objects (post / Linear canonical) by it to recover what it needs. */
export interface DedupCandidate {
  ref: string;
  title: string;
  description: string;
}

interface JudgeVerdict {
  matchedIndex: number | null; // 1-based index into the shown candidate list, or null
  confidence: number; // 0-100
  reason?: string;
}

function buildPrompt(input: DedupInput, candidates: DedupCandidate[]): { system: string; user: string } {
  const kind = input.type === 'bug' ? 'bug report' : 'feature request';
  const system =
    `You are a deduplication judge for a product feedback system. You are given a NEW ${kind} ` +
    `and a numbered list of EXISTING open posts. Decide whether the NEW one is the SAME underlying ` +
    `${input.type === 'bug' ? 'bug' : 'feature/capability'} as one of the existing ones — different wording is fine, ` +
    `but it must be genuinely the same request, not merely the same general area. ` +
    // ENG-1335: compare the SUBSTANTIVE ASK, not the title. The same request reworded across
    // filings ("mark awaiting-reply sessions neutral" vs "add a neutral awaiting-user-input
    // scoring state") shares almost no title tokens; matching on titles filed it six times.
    `Judge by the substantive ask — the concrete behavior or change being requested, as stated in the description — ` +
    `not by title wording: two posts can share no distinctive title words and still be the same request. ` +
    `A post that covers the new one's ask as part of a broader request IS a match. ` +
    `Conversely, two requests that touch the same component but ask for a DIFFERENT change are NOT a match ` +
    `(e.g. "don't penalize a session where the user never replied" vs "resolve the conflict between the publish-approval gate and the judge rubric" are different asks). ` +
    `If it clearly matches one, return that candidate's NUMBER. If it is a different request, or you are unsure, return null. ` +
    `Respond with ONLY JSON: {"matchedIndex": <number or null>, "confidence": <0-100>, "reason": "<short>"}.`;
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.title}\n   ${(c.description || '').slice(0, MAX_TEXT_CHARS).replace(/\s+/g, ' ')}`,
    )
    .join('\n');
  const user =
    `NEW ${kind}:\nTitle: ${input.title}\nDescription: ${input.description.slice(0, MAX_TEXT_CHARS)}\n\n` +
    `EXISTING open posts:\n${list}\n\n` +
    `Return the matching number or null.`;
  return { system, user };
}

/**
 * Returns the candidate to group onto, or null to create a fresh canonical. The caller
 * supplies the open candidates (features: FB posts; bugs: Linear bug canonicals).
 */
export async function findDuplicate(
  input: DedupInput,
  candidates: DedupCandidate[],
  /**
   * Who triggered this filing, for metering (ENG-1961). The judge used to run
   * with no usage context at all, so its spend booked to the `system`
   * placeholder — recorded, but never charged to anyone. Omitted, the call is
   * metered feature-only rather than against an invented user.
   */
  usage?: { userId?: string; sessionId?: string },
): Promise<DedupCandidate | null> {
  try {
    if (candidates.length === 0) return null;

    const model = await agentModeService.getDedupJudgeModel();
    const { system, user } = buildPrompt(input, candidates);

    const llmPromise = agentModeService.callLLM(
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      {
        temperature: 0,
        max_completion_tokens: 120,
        response_format: { type: 'json_object' },
        taskClass: 'nonstandard_consumer',
        usageContext: {
          ...(usage?.userId ? { userId: usage.userId } : {}),
          ...(usage?.sessionId ? { sessionId: usage.sessionId } : {}),
          feature: 'intake_dedup',
        },
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Dedup judge timed out')), JUDGE_TIMEOUT_MS);
    });
    const res = await Promise.race([llmPromise, timeoutPromise]).finally(() => { if (timer) clearTimeout(timer); });

    const raw = res?.choices?.[0]?.message?.content ?? '';
    const verdict = extractJson<JudgeVerdict>(raw);

    if (!verdict || verdict.matchedIndex == null) return null;
    const idx = Number(verdict.matchedIndex);
    if (!Number.isInteger(idx) || idx < 1 || idx > candidates.length) return null;
    if (typeof verdict.confidence === 'number' && verdict.confidence < MATCH_CONFIDENCE_THRESHOLD) return null;

    return candidates[idx - 1];
  } catch (e) {
    console.warn('[dedup] judge failed; treating as new (no match):', e instanceof Error ? e.message : e);
    return null;
  }
}
