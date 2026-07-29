import type { Skill } from "../services/skillService";

/**
 * ENG-204 completeness detectors — surface skills that still need hardening, so
 * scope stays data-derived (not limited to the skills the report named).
 */

/**
 * Publish-power tools (post/publish to a real destination) — covered by EITHER
 * the PUBLISH GATE or the SAFETY block.
 */
export const PUBLISH_TOOLS = new Set<string>([
  "post_on_connected_account",
  "publish_blog_article",
]);

/**
 * Send/delete/enrich/import tools — these carry VOLUME and destructive risk that
 * only the SAFETY & VOLUME LIMITS block governs; a bare publish gate does NOT
 * cover them.
 */
export const SEND_TOOLS = new Set<string>([
  "linkedin_outreach",
  "linkedin_manage_post",
  "send_email_to_lead",
  "delete_leads_by_filter",
  "enrich_leads_execute",
  "import_leads_from_search",
]);

/** All high-power tools (union). */
export const POWER_TOOLS = new Set<string>([...PUBLISH_TOOLS, ...SEND_TOOLS]);

const SAFETY_MARKER = "SAFETY & VOLUME LIMITS";
const PUBLISH_MARKER = "PUBLISH GATE";

/** Blindspot 4: a skill shipped with no usable systemPrompt. */
export function hasEmptyPrompt(skill: Pick<Skill, "systemPrompt">): boolean {
  return !(skill.systemPrompt || "").trim();
}

/** The power tools a skill holds (intersection of its toolNames with POWER_TOOLS). */
export function powerToolsOf(skill: Pick<Skill, "toolNames">): string[] {
  return (skill.toolNames || []).filter((t) => POWER_TOOLS.has(t));
}

/**
 * Blindspot 1: skill holds a send/write/delete tool but its prompt has no
 * SAFETY & VOLUME LIMITS block — i.e. uncapped send power.
 */
export function needsSafetyBlock(skill: Pick<Skill, "toolNames" | "systemPrompt">): boolean {
  const tools = skill.toolNames || [];
  const prompt = skill.systemPrompt || "";
  const hasSafety = prompt.includes(SAFETY_MARKER);
  const hasPublishGate = prompt.includes(PUBLISH_MARKER);
  // Send/delete/enrich tools need the volume-caps block specifically.
  if (tools.some((t) => SEND_TOOLS.has(t)) && !hasSafety) return true;
  // Publish tools are covered by either the publish gate or the safety block.
  if (tools.some((t) => PUBLISH_TOOLS.has(t)) && !hasSafety && !hasPublishGate) return true;
  return false;
}
