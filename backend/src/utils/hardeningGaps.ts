import type { Skill } from "../services/skillService";

/**
 * ENG-204 completeness detectors — surface skills that still need hardening, so
 * scope stays data-derived (not limited to the skills the report named).
 */

/**
 * Publish-power tools (post/publish to a real destination) — covered by EITHER
 * the PUBLISH GATE or the SAFETY block. Includes the canonical external-publish
 * tools (`agentToolGatewayService.EXTERNAL_PUBLISH_TOOLS`): publish_blog_article,
 * publish_landing_page_changes. A drift-guard test keeps this a superset of that
 * canonical set, and `isPublishName` below catches any future `publish_*`/
 * `post_on_*` tool by prefix so nothing silently escapes.
 */
export const PUBLISH_TOOLS = new Set<string>([
  "post_on_account",           // MCP alias — posts to a connected social account
  "post_on_connected_account",
  "publish_blog_article",
  "publish_landing_page_changes",
]);

/**
 * Send/delete/enrich/import tools — these carry VOLUME and destructive risk that
 * only the SAFETY & VOLUME LIMITS block governs; a bare publish gate does NOT
 * cover them. Includes the canonical external-send tools
 * (`agentToolGatewayService.EXTERNAL_SEND_TOOLS`: send_email, linkedin_outreach)
 * and the `*_manage_post` tools (multi-item threads + delete/like at volume).
 * `isSendName` below also catches any future `send_email*`/`*_outreach` by prefix.
 */
export const SEND_TOOLS = new Set<string>([
  // Email sends
  "send_email",
  "send_email_to_lead",
  "send_email_from_sender",
  // LinkedIn / X outreach + post management (DMs, threads, replies, deletes)
  "linkedin_outreach",
  "linkedin_manage_post",
  "twitter_outreach",
  "twitter_manage_post",
  // Destructive CRM deletions
  "delete_leads",
  "delete_leads_by_filter",
  "delete_lead_list",
  // Enrichment / import (volume + spend)
  "enrich_leads_execute",
  "import_leads_from_search",
]);

// Internal tools that superficially match a send prefix but are NOT external sends.
const SEND_BENIGN = new Set<string>(["send_for_review"]);

/**
 * Prefix-family classification so a newly-registered send/publish tool cannot
 * silently escape the detector before it is added to the explicit sets above.
 */
export function isPublishName(t: string): boolean {
  return PUBLISH_TOOLS.has(t) || /^publish_/.test(t) || /^post_on_/.test(t);
}
export function isSendName(t: string): boolean {
  if (SEND_BENIGN.has(t)) return false;
  return SEND_TOOLS.has(t) || /^send_email/.test(t) || /_outreach$/.test(t) || /_manage_post$/.test(t);
}
export function isPowerTool(t: string): boolean {
  return isPublishName(t) || isSendName(t);
}

const SAFETY_MARKER = "SAFETY & VOLUME LIMITS";
const PUBLISH_MARKER = "PUBLISH GATE";

/** Blindspot 4: a skill shipped with no usable systemPrompt. */
export function hasEmptyPrompt(skill: Pick<Skill, "systemPrompt">): boolean {
  return !(skill.systemPrompt || "").trim();
}

/** The power tools a skill holds. */
export function powerToolsOf(skill: Pick<Skill, "toolNames">): string[] {
  return (skill.toolNames || []).filter(isPowerTool);
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
  if (tools.some(isSendName) && !hasSafety) return true;
  // Publish tools are covered by either the publish gate or the safety block.
  if (tools.some(isPublishName) && !hasSafety && !hasPublishGate) return true;
  return false;
}
