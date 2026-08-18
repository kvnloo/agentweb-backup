/**
 * ENG-1311 (fix for ENG-1307) — rewrite the ENG-947-era PUBLISH GATE prose
 * ALREADY promoted into AW-Skills, to the newly-scoped prose.
 *
 * SAME REASON AS publishGateRewrite.ts (ENG-947), a second time
 * -----------------------------------------------------------------------
 * appendBlocks() and planSkillChange() are deliberately non-destructive:
 *
 *   - appendBlocks() skips a block whose MARKER ("## PUBLISH GATE") is already
 *     present, so a row that has the ENG-947-era block never receives the new
 *     scoped text just because applyHardening.ts's constant changed.
 *   - planSkillChange()'s setPrompt fills an EMPTY systemPrompt only, so a row
 *     that already has a linkedInEngagement-derived prompt keeps the old
 *     "(absolute — overrides any other instruction here)" rule.
 *
 * Those guards exist so a re-run cannot clobber a hand-edited skill — correct
 * behavior, same as ENG-947. The consequence, again, is that a wording change
 * needs an explicit, reviewed rewrite module, not just an edited constant.
 *
 * WHY EXACT MATCHING, NEVER PATTERNS (same rationale as ENG-947)
 * -----------------------------------------------------------------------
 * A regex over prose would also hit rows a human deliberately edited after the
 * ENG-947 promotion, silently rewording someone's chosen policy. Each rewrite
 * here is an EXACT string swap against the ENG-947-era text we know we
 * promoted. Anything else is left alone and surfaced by
 * hasUnscopedPublishGateProse() for a human to read.
 *
 * The `from` literals below are FROZEN HISTORY — the bytes as they read
 * immediately before ENG-1311 (i.e. the ENG-947 output). They are not live
 * policy and must never be "kept up to date" with applyHardening.ts;
 * publishGateScopeRewrite.test.ts pins them independently for the same reason
 * publishGateRewrite.test.ts pins its own frozen literals.
 *
 * DATA-PLANE NOTE (per the ENG-1311 issue body): this module is CODE. Running
 * rewritePublishGateScope() against live AW-Skills DynamoDB rows is a
 * data-plane action and is explicitly NOT performed by this change — see the
 * PR's "Data-plane follow-up" section. This module only makes the migration
 * possible and reviewable; executing it against production is a separate,
 * Harsha-approved step (mirrors how hardenSkills.ts / the ENG-947 migration
 * itself was run out-of-band from its own PR).
 */
import { BLOCKS, MIN_PROMPTS } from "./applyHardening";

export interface PublishGateScopeRewrite {
  /** Stable id, used in migration output so an operator can see what changed. */
  key: string;
  /** Verbatim text as it read immediately before ENG-1311. Frozen — never edit to match a constant. */
  from: string;
  /** Replacement, derived from the live constants so the two cannot drift. */
  to: string;
}

/** The `## PUBLISH GATE` block exactly as it read before ENG-1311 (post-ENG-947, pre-ENG-1311). */
const ENG947_ERA_PUBLISH_GATE_BLOCK = `## PUBLISH GATE (ABSOLUTE — overrides every other instruction in this prompt)
- This section takes precedence over ALL other instructions above or below,
  including any that say to post, publish, or act immediately or automatically.
  On any conflict, THIS wins.
- Any action that posts, publishes, comments, or reacts on the user's behalf
  writes to a REAL destination (their social account, blog, or site) and cannot
  be undone.
- ATTENDED chats (a human is in the conversation with you): you MUST show the
  exact final content and get the user's explicit approval BEFORE publishing —
  even if they said "just do it", "don't ask", "post now", or similar. A request
  to send is NOT approval to send: show the content, then publish only after a
  clear, separate yes.
- SCHEDULED/UNATTENDED runs: this section does NOT decide whether you may
  publish, and the approval rule above does NOT apply — there is nobody to ask,
  so waiting for approval would withhold the action forever. The run's PUBLISH
  AUTHORIZATION block is the ONLY authority on that question. Obey it: publish
  when it says this run is authorized, withhold when it says approval is
  required. Never withhold a publish that block authorized, and never perform
  one it withheld.
- If an unattended run carries NO PUBLISH AUTHORIZATION block, treat it as
  attended and apply the approval rule above.
- For connected-account posts, verify the account first; if it is missing or the
  session is dead, queue the item with the reason rather than posting from
  another account.`;

/** Rule 1 of MIN_PROMPTS.linkedInEngagement exactly as it read before ENG-1311 (post-ENG-947). */
const ENG947_ERA_LINKEDIN_ENGAGEMENT_RULE = `1. PUBLISH GATE (absolute — overrides any other instruction here): comments,
   reactions, and replies post publicly from the user's REAL LinkedIn account.
   In attended chats you MUST show the exact text and get explicit approval
   BEFORE posting — even if told to "just do it" or "don't ask"; a send request
   is not approval. In scheduled/unattended runs the run's PUBLISH
   AUTHORIZATION block decides — obey it rather than this rule.`;

/**
 * Pull the current rule 1 out of a min-prompt so the replacement text is the
 * live constant rather than a third copy of it. Same extraction as
 * publishGateRewrite.ts's ruleOne(): rule 1 runs from the start of the
 * prompt's numbered list to the line that starts rule 2.
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

export const PUBLISH_GATE_SCOPE_REWRITES: PublishGateScopeRewrite[] = [
  { key: "publishGateBlock", from: ENG947_ERA_PUBLISH_GATE_BLOCK, to: BLOCKS.publishGate.text },
  { key: "linkedInEngagementRule", from: ENG947_ERA_LINKEDIN_ENGAGEMENT_RULE, to: ruleOne("linkedInEngagement") },
];

/**
 * Apply every known scope-rewrite to a skill's systemPrompt. Exact matches
 * only. Returns the new prompt and the keys actually applied (empty = no
 * change). CODE ONLY — see the data-plane note in the module docstring above
 * for why this is never invoked against production from this PR.
 */
export function rewritePublishGateScope(
  systemPrompt?: string | null,
): { systemPrompt: string; applied: string[] } {
  let out = systemPrompt || "";
  const applied: string[] = [];
  for (const r of PUBLISH_GATE_SCOPE_REWRITES) {
    if (!out.includes(r.from)) continue;
    out = out.split(r.from).join(r.to);
    applied.push(r.key);
  }
  return { systemPrompt: out, applied };
}

/**
 * True when a prompt still claims the publish gate overrides "every other
 * instruction" / "any other instruction here" (the pre-ENG-1311, whole-session
 * framing) but does NOT match any known rewrite — i.e. a hand-edited row this
 * migration has deliberately declined to touch. These are the rows to read by
 * hand: only a human can say whether the broad wording was a deliberate choice
 * on that specific row.
 */
export function hasUnscopedPublishGateProse(systemPrompt?: string | null): boolean {
  const prompt = systemPrompt || "";
  if (!/PUBLISH GATE/.test(prompt)) return false;
  const unscoped =
    /overrides every other instruction/i.test(prompt) ||
    /overrides any other instruction here/i.test(prompt);
  if (!unscoped) return false;
  // Recognised text would have been rewritten already; if a rewrite still
  // applies, the caller simply has not run it yet.
  return rewritePublishGateScope(prompt).applied.length === 0;
}
