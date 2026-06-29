import { agentModeService } from './agentModeService';
import { listOpenPosts, OpenPost } from './featurebaseService';
import { extractJson } from './util/extractJson';

/**
 * Dedup judge for user-filed requests (report_product_issues + the in-app bug button).
 *
 * Given a new filing, find an existing OPEN public Featurebase post that is the *same
 * underlying feature/bug* (reworded is fine). Used to stack a new report onto an existing
 * canonical (upvote + private comment) instead of creating a duplicate post.
 *
 * Design notes:
 * - Candidate set = open posts on the board (featurebaseService.listOpenPosts). Closed
 *   (completed/canceled) posts are excluded there.
 * - The match decision is a focused LLM judge (not a keyword heuristic, not Emma's freeform
 *   reasoning) with a confidence gate biased toward NEW (a false-merge is worse than a missed
 *   one — periodic Featurebase "Find Duplicates" catches the tail).
 * - The judge returns a 1-based INDEX into the shown list (not a free-form id) so it cannot
 *   hallucinate an identifier; we map the index back to the post.
 * - Model is sourced from settings via agentModeService.getDedupJudgeModel() — NOT a
 *   hardcoded literal. TODO(ENG-9): route this LLM call through OpenRouter so model choice
 *   is gateway/routing config.
 * - Best-effort: any error returns null so a filing is never blocked.
 */

const JUDGE_TIMEOUT_MS = 12000;
const MATCH_CONFIDENCE_THRESHOLD = 75; // bias to NEW: only stack on a confident match
const MAX_CANDIDATES = 30;
const MAX_TEXT_CHARS = 600; // keep the prompt cheap

export type DedupItemType = 'feature_request' | 'bug';

export interface DedupInput {
  type: DedupItemType;
  title: string;
  description: string;
}

export interface DedupMatch {
  postId: string; // canonical Featurebase post id (for voter + comment stacking)
  title: string;
  url?: string;   // public post URL
}

interface JudgeVerdict {
  matchedIndex: number | null; // 1-based index into the shown candidate list, or null
  confidence: number; // 0-100
  reason?: string;
}

function buildPrompt(input: DedupInput, candidates: OpenPost[]): { system: string; user: string } {
  const kind = input.type === 'bug' ? 'bug report' : 'feature request';
  const system =
    `You are a deduplication judge for a product feedback system. You are given a NEW ${kind} ` +
    `and a numbered list of EXISTING open posts. Decide whether the NEW one is the SAME underlying ` +
    `${input.type === 'bug' ? 'bug' : 'feature/capability'} as one of the existing ones — different wording is fine, ` +
    `but it must be genuinely the same request, not merely the same general area. ` +
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
 * Returns the canonical post to stack onto, or null to create a fresh canonical.
 */
export async function findDuplicateCanonical(input: DedupInput): Promise<DedupMatch | null> {
  try {
    const candidates = await listOpenPosts(MAX_CANDIDATES);
    if (candidates.length === 0) return null;

    const model = await agentModeService.getDedupJudgeModel();
    const { system, user } = buildPrompt(input, candidates);

    const llmPromise = agentModeService.callLLM(
      model,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 0, max_completion_tokens: 120, response_format: { type: 'json_object' } },
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

    const match = candidates[idx - 1];
    return { postId: match.id, title: match.title, url: match.url };
  } catch (e) {
    console.warn('[dedup] judge failed; treating as new (no match):', e instanceof Error ? e.message : e);
    return null;
  }
}
