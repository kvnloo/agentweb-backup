import type { Skill } from "../skillService";

/**
 * ENG-204 skill-hardening framework — the verbatim universal blocks from the
 * AgentWeb Skills Optimization Report (July 5, 2026) plus a pure, idempotent
 * appender. Skills are DynamoDB rows; this module is the reviewable, testable
 * engine that the dev-first hardening runner uses to mutate `systemPrompt`.
 *
 * Each block has a stable `marker` (its heading). Idempotency is marker-based:
 * a block is appended only if its marker is not already present, so runs are
 * safe to repeat and never double-append.
 */
export interface HardeningBlock {
  key: string;
  /** Stable substring used to detect prior application (idempotency). */
  marker: string;
  /** Verbatim block text appended to a skill's systemPrompt. */
  text: string;
}

const SAFETY = `## SAFETY & VOLUME LIMITS (apply in ALL modes, including scheduled/unattended runs)
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

const FAILURE = `## FAILURE HANDLING
- Per-entity blocker isolation: if one lead/account/step fails, note it and
  CONTINUE with the rest. Only a global unrecoverable error stops the run.
- On tool timeout: keep partial results, retry ONCE with a narrower query,
  then move on. Never retry the identical call more than twice.
- Final report MUST contain a completion ledger: N attempted / N succeeded /
  N failed (with reasons) / N queued. Never state or imply an action
  succeeded unless the tool result confirms it.`;

const CONTEXT = `## CONTEXT FRESHNESS (replace all hardcoded facts)
- Events, dates, capacities, owner assignments: NEVER assume from this
  prompt. At run start, load current values from save_memory/org memory or
  ask the user. If an event date is in the past, STOP and flag it.
- Account owners: derive from list_connected_accounts at runtime. If a named
  owner is no longer connected, queue their items — do not reassign sends.
- ICP criteria, list names, brand facts: ALWAYS load via
  read_market_strategy / read_brand_guidelines for the REQUESTING user's
  org. Never apply another organization's ICP or brand.`;

const LEARN = `## LEARN FROM OUTCOMES
- At the START of an outreach run, review the last run's results:
  list-sent-invitations acceptance, reply engagements, memory notes.
- Prefer message angles with observed acceptance/reply success; note the
  angle used on each send via add_lead_engagement metadata.
- At the END of a run, save_memory one concise learning (what worked / what
  didn't, with numbers) tagged to this skill.`;

const COMPLIANCE = `## COMPLIANCE
- Marketing email sends must include unsubscribe handling and a physical
  mailing address (CAN-SPAM). Honor opt-outs recorded in lead status.
- Never enrich EU leads with fields the user's data-processing terms don't
  cover (GDPR/CCPA) — when unsure, flag rather than proceed.
- Respect platform automation limits (e.g. LinkedIn ToS); the volume caps
  above are ceilings, not targets.`;

const ADS_BUDGET = `## BUDGET & FAILURE STOP CONDITIONS
- Never increase spend or launch/enable a campaign in an unattended run
  without a prior approved plan. Queue the change for human confirmation.
- Per-entity failure isolation: if one campaign/ad/asset fails, note it and
  continue with the rest; only a global unrecoverable error stops the run.
- End with a completion ledger: N attempted / N succeeded / N failed (with
  reasons) / N queued. Never imply a change landed unless the tool confirms.`;

export const BLOCKS: Record<string, HardeningBlock> = {
  safety: { key: "safety", marker: "## SAFETY & VOLUME LIMITS", text: SAFETY },
  failure: { key: "failure", marker: "## FAILURE HANDLING", text: FAILURE },
  context: { key: "context", marker: "## CONTEXT FRESHNESS", text: CONTEXT },
  learn: { key: "learn", marker: "## LEARN FROM OUTCOMES", text: LEARN },
  compliance: { key: "compliance", marker: "## COMPLIANCE", text: COMPLIANCE },
  adsBudget: { key: "adsBudget", marker: "## BUDGET & FAILURE STOP CONDITIONS", text: ADS_BUDGET },
};

/**
 * Append the named blocks to a systemPrompt, idempotently. A block already
 * present (by marker) is skipped. Returns the new prompt and the keys actually
 * appended. Throws on an unknown block key.
 */
export function appendBlocks(
  systemPrompt: string | undefined,
  blockKeys: string[],
): { systemPrompt: string; appended: string[] } {
  let out = systemPrompt || "";
  const appended: string[] = [];
  for (const key of blockKeys) {
    const block = BLOCKS[key];
    if (!block) throw new Error(`Unknown hardening block: ${key}`);
    if (out.includes(block.marker)) continue; // idempotent
    out = `${out.trimEnd()}\n\n${block.text.trim()}\n`;
    appended.push(key);
  }
  // Normalise a leading blank line when the original prompt was empty.
  return { systemPrompt: out.replace(/^\n+/, ""), appended };
}

/**
 * Apply hardening blocks to a copy of a skill. Never mutates the input. Returns
 * the updated skill, whether anything changed, and which blocks were appended.
 */
export function applyHardening(
  skill: Skill,
  blockKeys: string[],
): { skill: Skill; changed: boolean; appended: string[] } {
  const { systemPrompt, appended } = appendBlocks(skill.systemPrompt, blockKeys);
  return {
    skill: { ...skill, systemPrompt },
    changed: appended.length > 0,
    appended,
  };
}

/** A per-skill hardening target: which blocks to append and which tools to add. */
export interface SkillHardeningTarget {
  skillId: string;
  blocks?: string[];
  /** Tool names to add to toolNames (e.g. the Blindspot 5 fixes). */
  addTools?: string[];
}

/**
 * Plan the full change for one skill (blocks + toolNames additions), idempotently.
 * Never mutates the input. `addedTools` excludes tools already declared, so a
 * re-run adds nothing.
 */
export function planSkillChange(
  skill: Skill,
  target: SkillHardeningTarget,
): { skill: Skill; changed: boolean; appended: string[]; addedTools: string[] } {
  const afterBlocks = applyHardening(skill, target.blocks || []);
  const declared = new Set(afterBlocks.skill.toolNames || []);
  const addedTools = (target.addTools || []).filter((t) => t && !declared.has(t));
  const toolNames = addedTools.length
    ? [...(afterBlocks.skill.toolNames || []), ...addedTools]
    : afterBlocks.skill.toolNames;
  return {
    skill: { ...afterBlocks.skill, toolNames },
    changed: afterBlocks.changed || addedTools.length > 0,
    appended: afterBlocks.appended,
    addedTools,
  };
}
