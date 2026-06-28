import { agentModeService } from './agentModeService';
import { listOpenCanonicals, OpenCanonical, LinearItemType } from './linearService';
import { extractJson } from './util/extractJson';

/**
 * Dedup judge for user-filed requests (report_product_issues).
 *
 * Given a new filing, find an existing OPEN canonical Linear issue of the same type
 * that is the *same underlying feature/bug* (reworded is fine). Used to stack a new
 * report onto an existing item (upvote + comment) instead of creating a duplicate.
 *
 * Design notes:
 * - Type-scoped + open-only candidate set comes from linearService.listOpenCanonicals.
 * - The match decision is a focused LLM judge (not a keyword heuristic, not Emma's
 *   freeform reasoning) with a confidence gate biased toward NEW (a false-merge is
 *   worse than a missed one — periodic Featurebase "Find Duplicates" catches the tail).
 * - Model is sourced from settings via agentModeService.getDedupJudgeModel() — NOT a
 *   hardcoded literal. TODO(ENG-9): route this LLM call through OpenRouter so model
 *   choice is gateway/routing config.
 * - Best-effort: any error returns null so a filing is never blocked.
 */

const JUDGE_TIMEOUT_MS = 12000;
const MATCH_CONFIDENCE_THRESHOLD = 75; // bias to NEW: only stack on a confident match
const MAX_CANDIDATES = 30;
const MAX_TEXT_CHARS = 600; // keep the prompt cheap

export interface DedupInput {
  type: LinearItemType;
  title: string;
  description: string;
}

export interface DedupMatch {
  identifier: string; // canonical Linear identifier, e.g. ENG-42
  issueId: string;    // canonical internal uuid (for comments)
  title: string;
  featurebasePostUrl?: string;
}

interface JudgeVerdict {
  matchedIdentifier: string | null;
  confidence: number; // 0-100
  reason?: string;
}

function buildPrompt(input: DedupInput, candidates: OpenCanonical[]): { system: string; user: string } {
  const kind = input.type === 'bug' ? 'bug report' : 'feature request';
  const system =
    `You are a deduplication judge for a product feedback system. You are given a NEW ${kind} ` +
    `and a numbered list of EXISTING open ${kind}s. Decide whether the NEW one is the SAME underlying ` +
    `${input.type === 'bug' ? 'bug' : 'feature/capability'} as one of the existing ones — different wording is fine, ` +
    `but it must be genuinely the same request, not merely the same general area. ` +
    `If it clearly matches one, return that candidate's identifier. If it is a different request, or you are unsure, return null. ` +
    `Respond with ONLY JSON: {"matchedIdentifier": "<identifier or null>", "confidence": <0-100>, "reason": "<short>"}.`;
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. [${c.identifier}] ${c.title}\n   ${(c.description || '').slice(0, MAX_TEXT_CHARS).replace(/\s+/g, ' ')}`,
    )
    .join('\n');
  const user =
    `NEW ${kind}:\nTitle: ${input.title}\nDescription: ${input.description.slice(0, MAX_TEXT_CHARS)}\n\n` +
    `EXISTING open ${kind}s:\n${list}\n\n` +
    `Return the matching identifier or null.`;
  return { system, user };
}

/**
 * Returns the canonical to stack onto, or null to create a fresh canonical.
 */
export async function findDuplicateCanonical(input: DedupInput): Promise<DedupMatch | null> {
  try {
    const candidates = await listOpenCanonicals(input.type, MAX_CANDIDATES);
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
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Dedup judge timed out')), JUDGE_TIMEOUT_MS),
    );
    const res = await Promise.race([llmPromise, timeoutPromise]);

    const raw = res?.choices?.[0]?.message?.content ?? '';
    const verdict = extractJson<JudgeVerdict>(raw);

    if (!verdict || !verdict.matchedIdentifier || verdict.matchedIdentifier === 'null') return null;
    if (typeof verdict.confidence === 'number' && verdict.confidence < MATCH_CONFIDENCE_THRESHOLD) return null;

    // Only trust an identifier the judge was actually shown (guard against hallucination).
    const match = candidates.find((c) => c.identifier === verdict.matchedIdentifier);
    if (!match) return null;

    return {
      identifier: match.identifier,
      issueId: match.issueId,
      title: match.title,
      featurebasePostUrl: match.featurebasePostUrl,
    };
  } catch (e) {
    console.warn('[dedup] judge failed; treating as new (no match):', e instanceof Error ? e.message : e);
    return null;
  }
}
