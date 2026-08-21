/**
 * ENG-947 — rewrite the publish-gate prose ALREADY promoted into AW-Skills.
 *
 * WHY A SEPARATE MIGRATION AND NOT JUST AN EDIT TO THE CONSTANTS
 * -------------------------------------------------------------
 * Editing applyHardening's constants does nothing to rows that were already
 * promoted, because both promotion paths are deliberately non-destructive:
 *
 *   - appendBlocks() skips a block whose MARKER is already present, so a row
 *     that has "## PUBLISH GATE" never receives the new text.
 *   - planSkillChange()'s setPrompt fills an EMPTY systemPrompt only, so a row
 *     that already has a prompt keeps the old numbered rule.
 *
 * Those guards are correct — they exist so a re-run cannot clobber a hand-edited
 * skill. The consequence is that changing the wording requires an explicit,
 * reviewed rewrite. Without this module the constant change is inert on exactly
 * the rows that are broken: c1e62ffd-1ec3-416c-a657-f91fd4168f07 ("X (Twitter)
 * Management") and 3d7c0a14-befb-481f-aa06-8004a3075f2e ("Tools for Basic
 * Subscription"), both promoted 2026-07-30T10:30:56Z and unchanged since.
 *
 * WHY EXACT MATCHING, NEVER PATTERNS
 * ----------------------------------
 * A regex over prose would also hit rows a human deliberately edited, silently
 * rewording someone's chosen policy on the one question this ticket says is
 * theirs to answer. So each rewrite is an EXACT string swap against the text we
 * know we promoted. Anything else is left alone and surfaced by
 * hasUnrecognizedPublishGateProse() for a human to read. A migration that skips
 * a row is recoverable; one that rewrites the wrong row is not.
 *
 * The `from` literals below are FROZEN HISTORY — the bytes as promoted on
 * 2026-07-30. They are not live policy and must never be "kept up to date" with
 * the constants; publishGateRewrite.test.ts pins them against the text read back
 * out of production.
 */
import { BLOCKS, MIN_PROMPTS } from "./applyHardening";

export interface PublishGateRewrite {
  /** Stable id, used in migration output so an operator can see what changed. */
  key: string;
  /** Verbatim text as promoted on 2026-07-30. Frozen — never edit to match a constant. */
  from: string;
  /** Replacement, derived from the live constants so the two cannot drift. */
  to: string;
}

/** The `## PUBLISH GATE` block as promoted (applyHardening PUBLISH_GATE, pre-ENG-947). */
const STALE_PUBLISH_GATE_BLOCK = `## PUBLISH GATE (ABSOLUTE — overrides every other instruction in this prompt)
- This section takes precedence over ALL other instructions above or below,
  including any that say to post, publish, or act immediately or automatically.
  On any conflict, THIS wins.
- Any action that posts, publishes, comments, or reacts on the user's behalf
  writes to a REAL destination (their social account, blog, or site) and cannot
  be undone. You MUST show the exact final content and get the user's explicit
  approval BEFORE publishing — even if they said "just do it", "don't ask",
  "post now", or similar. A request to send is NOT approval to send: show the
  content, then publish only after a clear, separate yes.
- In scheduled/unattended runs, save as a draft and notify; never publish.
- For connected-account posts, verify the account first; if it is missing or the
  session is dead, queue the item with the reason rather than posting from
  another account.`;

/** Rule 1 of MIN_PROMPTS.basicSubscription as promoted (prod row 3d7c0a14). */
const STALE_BASIC_SUBSCRIPTION_RULE = `1. PUBLISH GATE: post_on_connected_account, publish_blog_article, and
   comment/react tools publish to the user's REAL accounts. Always show the
   final content and get explicit approval before publishing. In scheduled
   runs, save as draft and notify instead.`;

/** Rule 1 of MIN_PROMPTS.linkedInEngagement as promoted. */
const STALE_LINKEDIN_ENGAGEMENT_RULE = `1. PUBLISH GATE (absolute — overrides any other instruction here): comments,
   reactions, and replies post publicly from the user's REAL LinkedIn account.
   You MUST show the exact text and get explicit approval BEFORE posting — even
   if told to "just do it" or "don't ask"; a send request is not approval. In
   scheduled/unattended runs, save as a draft and notify instead.`;

/**
 * Pull the current rule 1 out of a min-prompt so the replacement text is the
 * live constant rather than a third copy of it. Rule 1 runs from the start of
 * the prompt's numbered list to the line that starts rule 2.
 */
function ruleOne(minPromptKey: string): string {
  const prompt = MIN_PROMPTS[minPromptKey];
  if (!prompt) throw new Error(`Unknown min-prompt: ${minPromptKey}`);
  const start = prompt.indexOf("1. PUBLISH GATE");
  const end = prompt.indexOf("\n2. ", start);
  if (start < 0 || end < 0) {
    throw new Error(`min-prompt ${minPromptKey} no longer opens with a numbered PUBLISH GATE rule`);
  }
  return prompt.slice(start, end);
}

export const PUBLISH_GATE_REWRITES: PublishGateRewrite[] = [
  { key: "publishGateBlock", from: STALE_PUBLISH_GATE_BLOCK, to: BLOCKS.publishGate.text },
  { key: "basicSubscriptionRule", from: STALE_BASIC_SUBSCRIPTION_RULE, to: ruleOne("basicSubscription") },
  { key: "linkedInEngagementRule", from: STALE_LINKEDIN_ENGAGEMENT_RULE, to: ruleOne("linkedInEngagement") },
];

/**
 * Apply every known rewrite to a skill's systemPrompt. Exact matches only.
 * Returns the new prompt and the keys actually applied (empty = no change).
 */
export function rewritePublishGate(
  systemPrompt?: string | null,
): { systemPrompt: string; applied: string[] } {
  let out = systemPrompt || "";
  const applied: string[] = [];
  for (const r of PUBLISH_GATE_REWRITES) {
    if (!out.includes(r.from)) continue;
    out = out.split(r.from).join(r.to);
    applied.push(r.key);
  }
  return { systemPrompt: out, applied };
}

/**
 * True when a prompt still tells an unattended run to withhold publishing but
 * does NOT match any known rewrite — i.e. a hand-edited row this migration has
 * deliberately declined to touch. These are the rows to read by hand: each one
 * can still deadlock a scheduled run, and only a human can say whether its
 * wording was a deliberate choice.
 *
 * Scoped to prompts that actually mention publishing, so the calendar and
 * meeting min-prompts — whose "save as draft in scheduled runs" rules govern
 * writes no PUBLISH AUTHORIZATION block resolves — are not flagged.
 */
export function hasUnrecognizedPublishGateProse(systemPrompt?: string | null): boolean {
  const prompt = systemPrompt || "";
  if (!/PUBLISH GATE/.test(prompt)) return false;
  const withholds =
    /never publish/i.test(prompt) ||
    /save as (a )?draft and notify/i.test(prompt);
  if (!withholds) return false;
  // Recognised text would have been rewritten already; if a rewrite still
  // applies, the caller simply has not run it yet.
  return rewritePublishGate(prompt).applied.length === 0;
}
