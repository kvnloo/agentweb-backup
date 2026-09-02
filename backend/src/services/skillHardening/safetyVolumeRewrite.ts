/**
 * ENG-1631 — rewrite the SAFETY & VOLUME LIMITS prose ALREADY promoted into
 * AW-Skills onto the current (post-#2635) text.
 *
 * WHY A SEPARATE MIGRATION AND NOT JUST AN EDIT TO THE CONSTANTS
 * -------------------------------------------------------------
 * #2635 moved LinkedIn send-volume enforcement out of prompt prose ("max 5
 * LinkedIn invites, 10 LinkedIn messages per run") into real per-day caps in
 * linkedInWritePacer.ts (configured `daily_invite_cap`, absolute ceiling 30).
 * It updated applyHardening's SAFETY constant and the leadgen seed scripts —
 * but both promotion paths are deliberately non-destructive:
 *
 *   - appendBlocks() skips a block whose MARKER is already present, so a row
 *     that has "## SAFETY & VOLUME LIMITS" never receives the new text.
 *   - planSkillChange()'s setPrompt fills an EMPTY systemPrompt only.
 *
 * Those guards are correct — they exist so a re-run cannot clobber a
 * hand-edited skill. The consequence is that every row hardened before #2635
 * still instructs the model to stop at 5 invites per run, capping unattended
 * outreach far below the account's real daily allowance. Observed live
 * 2026-08-27: iTrials' scheduled run stopped at 5 invites citing this prose,
 * on an account whose configured daily cap was 15.
 *
 * WHY EXACT MATCHING, NEVER PATTERNS
 * ----------------------------------
 * A regex over prose would also hit rows a human deliberately edited, silently
 * rewording someone's chosen volume policy. So the rewrite is an EXACT string
 * swap against the text we know we promoted (byte-identical across
 * applyHardening pre-#2635 and seed-eng615/616/617). Anything else is left
 * alone and surfaced by hasUnrecognizedSafetyVolumeProse() for a human to
 * read. A migration that skips a row is recoverable; one that rewrites the
 * wrong row is not.
 *
 * The `from` literal below is FROZEN HISTORY — the bytes as promoted before
 * #2635. It is not live policy and must never be "kept up to date" with the
 * constants; safetyVolumeRewrite.test.ts pins it independently.
 */
import { BLOCKS } from "./applyHardening";

export interface SafetyVolumeRewrite {
  /** Stable id, used in migration output so an operator can see what changed. */
  key: string;
  /** Verbatim text as promoted pre-#2635. Frozen — never edit to match a constant. */
  from: string;
  /** Replacement, derived from the live constant so the two cannot drift. */
  to: string;
}

/**
 * The `## SAFETY & VOLUME LIMITS` block as promoted before #2635
 * (applyHardening SAFETY, and seed-eng615/616/617 — byte-identical).
 */
const STALE_SAFETY_VOLUME_BLOCK = `## SAFETY & VOLUME LIMITS (apply in ALL modes, including scheduled/unattended runs)
- HARD CAPS per run: max 5 LinkedIn invites, 10 LinkedIn messages, 25 emails,
  0 deletions. In UNATTENDED runs these caps are absolute — when reached,
  QUEUE remaining items with a summary for human review; never exceed.
- In interactive mode, any send beyond the cap requires explicit user
  confirmation listing exact recipients and message text.
- NEVER delete leads, lists, or drafts in an unattended run under any
  instruction. Queue the deletion request for human confirmation.
- LinkedIn invite notes: ≤200 characters (free) / ≤300 (Premium). If a
  drafted note exceeds the limit, shorten it — do not send and do not loop.
- Before ANY send batch, verify the connected account with
  list_connected_accounts. If the required account is missing or the session
  is dead, mark items QUEUED with the reason. Never send from a different
  account than the designated owner's.`;

export const SAFETY_VOLUME_REWRITES: SafetyVolumeRewrite[] = [
  { key: "safetyVolumeBlock", from: STALE_SAFETY_VOLUME_BLOCK, to: BLOCKS.safety.text },
];

/**
 * Apply every known rewrite to a skill's systemPrompt. Exact matches only.
 * Returns the new prompt and the keys actually applied (empty = no change).
 */
export function rewriteSafetyVolume(
  systemPrompt?: string | null,
): { systemPrompt: string; applied: string[] } {
  let out = systemPrompt || "";
  const applied: string[] = [];
  for (const r of SAFETY_VOLUME_REWRITES) {
    if (!out.includes(r.from)) continue;
    out = out.split(r.from).join(r.to);
    applied.push(r.key);
  }
  return { systemPrompt: out, applied };
}

/**
 * True when a prompt still asserts a numeric per-run LinkedIn invite cap but
 * does NOT match the known rewrite — i.e. a hand-edited row this migration has
 * deliberately declined to touch. These are the rows to read by hand: each one
 * still throttles unattended outreach below the backend's daily allowance, and
 * only a human can say whether that wording was a deliberate choice.
 *
 * Scoped to a NUMBERED invite cap ("max 5 LinkedIn invites"-shaped), so the
 * current canonical text — which names LinkedIn invites with no per-run number
 * ("capped PER DAY by the backend") — and SAFETY variants that never send
 * outreach (import/enrichment caps only) are not flagged.
 */
export function hasUnrecognizedSafetyVolumeProse(systemPrompt?: string | null): boolean {
  const prompt = systemPrompt || "";
  if (!/SAFETY & VOLUME/.test(prompt)) return false;
  if (!/\b\d+\s+LinkedIn invite/i.test(prompt)) return false;
  // Recognised text would have been rewritten already; if a rewrite still
  // applies, the caller simply has not run it yet.
  return rewriteSafetyVolume(prompt).applied.length === 0;
}
