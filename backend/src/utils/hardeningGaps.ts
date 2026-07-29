import type { Skill } from "../services/skillService";

/**
 * ENG-204 completeness detectors — surface skills that still need hardening, so
 * scope stays data-derived (not limited to the skills the report named).
 */

/** High-power tools that publish/send/delete on the user's behalf. */
export const POWER_TOOLS = new Set<string>([
  "linkedin_outreach",
  "linkedin_manage_post",
  "send_email_to_lead",
  "post_on_connected_account",
  "publish_blog_article",
  "delete_leads_by_filter",
  "enrich_leads_execute",
  "import_leads_from_search",
]);

// A skill with send/publish power is "gated" if its prompt carries EITHER the
// outreach volume-caps block OR a publish-approval gate. Matched as substrings
// so both the block headings and an inline min-prompt rule ("PUBLISH GATE:")
// count.
const GATE_MARKERS = ["SAFETY & VOLUME LIMITS", "PUBLISH GATE"];

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
  if (powerToolsOf(skill).length === 0) return false;
  const prompt = skill.systemPrompt || "";
  return !GATE_MARKERS.some((m) => prompt.includes(m));
}
