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
  /**
   * Tools this block's text instructs Emma to call. They MUST be in the skill's
   * toolNames or the block would reference tools the skill lacks (Blindspot 5),
   * so planSkillChange auto-adds them whenever the block is applied.
   */
  requiredTools: string[];
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
  safety: { key: "safety", marker: "## SAFETY & VOLUME LIMITS", text: SAFETY, requiredTools: ["list_connected_accounts"] },
  failure: { key: "failure", marker: "## FAILURE HANDLING", text: FAILURE, requiredTools: [] },
  context: { key: "context", marker: "## CONTEXT FRESHNESS", text: CONTEXT, requiredTools: ["list_connected_accounts", "read_market_strategy", "read_brand_guidelines", "save_memory"] },
  learn: { key: "learn", marker: "## LEARN FROM OUTCOMES", text: LEARN, requiredTools: ["add_lead_engagement", "save_memory"] },
  compliance: { key: "compliance", marker: "## COMPLIANCE", text: COMPLIANCE, requiredTools: [] },
  adsBudget: { key: "adsBudget", marker: "## BUDGET & FAILURE STOP CONDITIONS", text: ADS_BUDGET, requiredTools: [] },
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

/**
 * Minimum-viable prompts for Blindspot 4 (skills shipped with an EMPTY
 * systemPrompt). Basic Subscription and Google Calendar are the report's
 * verbatim text; Meeting Intelligence and CRM Draft are drafted to the report's
 * "min prompt with write-gates" spec (flagged for review — not verbatim).
 */
export const MIN_PROMPTS: Record<string, string> = {
  basicSubscription: `You are Emma operating with the Basic-tier toolset. Rules:
1. PUBLISH GATE: post_on_connected_account, publish_blog_article, and
   comment/react tools publish to the user's REAL accounts. Always show the
   final content and get explicit approval before publishing. In scheduled
   runs, save as draft and notify instead.
2. BRAND FIRST: before generating any content, load read_brand_guidelines
   and read_market_strategy; match voice, banned phrases, and ICP.
3. RESEARCH BEFORE ASKING: use you_search_web / perform_deep_research /
   search_knowledge_base before asking the user for facts you can find.
4. DELIVERABLES: content >300 words -> create as a file/artifact, not chat.
5. LEDGER: end multi-step tasks with attempted/succeeded/failed/queued.`,

  googleCalendar: `You are Emma managing the user's Google Calendar. Rules:
1. CONFIRM before any create/update/delete: show the full event details
   (title, date/time, timezone, attendees) and get explicit approval before writing.
2. NEVER delete without first listing exactly what will be deleted.
3. In scheduled/unattended runs, do not create/update/delete without a prior
   approved plan; surface the proposed change for confirmation instead.`,

  meetingIntelligence: `You are Emma providing meeting intelligence: summarizing and extracting
insights, action items, and decisions from the user's meetings. Rules:
1. Ground every summary, action item, and quote in the actual meeting data from
   your tools; never invent attendees, decisions, or quotes.
2. Before any action that writes or sends (tasks, emails, calendar entries from a
   meeting), show the draft and get explicit approval; in scheduled runs, save as
   draft and notify instead.
3. End multi-step work with a completion ledger (attempted/succeeded/failed/queued).`,

  crmDraft: `You are Emma drafting CRM content (emails, messages, notes) for the user's leads.
Rules:
1. DRAFT ONLY: produce drafts for review; do NOT send, publish, or modify lead
   records unless the user explicitly approves the specific action.
2. BRAND FIRST: load read_brand_guidelines / read_market_strategy and match voice,
   banned phrases, and ICP before drafting.
3. Ground personalization in real lead/CRM data from your tools; never invent
   facts about a lead.
4. End multi-step work with a completion ledger (attempted/succeeded/failed/queued).`,
};

/** A per-skill hardening target: set a min-prompt, append blocks, and/or add tools. */
export interface SkillHardeningTarget {
  skillId: string;
  /** Key into MIN_PROMPTS — sets systemPrompt ONLY if the skill's prompt is empty. */
  setPrompt?: string;
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
): { skill: Skill; changed: boolean; promptSet: boolean; appended: string[]; addedTools: string[] } {
  let working = skill;
  let promptSet = false;
  if (target.setPrompt) {
    const text = MIN_PROMPTS[target.setPrompt];
    if (!text) throw new Error(`Unknown min-prompt: ${target.setPrompt}`);
    // Fill an EMPTY prompt only — never overwrite an existing systemPrompt.
    if (!(skill.systemPrompt || "").trim()) {
      working = { ...skill, systemPrompt: text };
      promptSet = true;
    }
  }
  const afterBlocks = applyHardening(working, target.blocks || []);
  const declared = new Set(afterBlocks.skill.toolNames || []);
  // Every applied block's required tools must be present too (whether the block
  // was just appended or already there), else the block references tools the
  // skill lacks. Combine with explicit addTools, dedupe, drop already-declared.
  const blockTools = (target.blocks || []).flatMap((k) => BLOCKS[k]?.requiredTools || []);
  const want = [...(target.addTools || []), ...blockTools];
  const addedTools = want.filter((t, i) => t && !declared.has(t) && want.indexOf(t) === i);
  const toolNames = addedTools.length
    ? [...(afterBlocks.skill.toolNames || []), ...addedTools]
    : afterBlocks.skill.toolNames;
  return {
    skill: { ...afterBlocks.skill, toolNames },
    changed: promptSet || afterBlocks.changed || addedTools.length > 0,
    promptSet,
    appended: afterBlocks.appended,
    addedTools,
  };
}
