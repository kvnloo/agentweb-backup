import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";

/**
 * Builds an analytics configuration block for Emma's system prompt so she
 * knows which GA4 properties, Search Console domains, and Clarity projects
 * are already set up — without needing to ask the user.
 *
 * GA4 data is sourced via `resolveAnalyticsConfig`, so the block reflects the
 * org owner's shared analytics when org sharing is enabled.
 */
export async function buildUserAnalyticsContext(user: {
  googleAnalyticsProperties?: Array<{ propertyId: string; label: string }>;
  seoDomains?: string[];
  clarityProjects?: Array<{ projectId: string; label: string }>;
  gaFilteredDomains?: string[];
} | null | undefined): Promise<string> {
  if (!user) return "";

  const resolved = await resolveAnalyticsConfig(user);

  const lines: string[] = [];

  if (resolved.properties && resolved.properties.length > 0) {
    lines.push("## Your Analytics Configuration");
    lines.push("");
    lines.push("**Google Analytics (GA4) — already configured:**");
    for (const prop of resolved.properties) {
      lines.push(`- ${prop.label}: Property ID \`${prop.propertyId}\``);
    }
    if (resolved.gaFilteredDomains && resolved.gaFilteredDomains.length > 0) {
      lines.push(`- Filtered domains (excluded from GA4): ${resolved.gaFilteredDomains.join(", ")}`);
    }
  }

  if (user.seoDomains && user.seoDomains.length > 0) {
    if (lines.length === 0) lines.push("## Your Analytics Configuration\n");
    lines.push("");
    lines.push("**Google Search Console — already configured:**");
    for (const domain of user.seoDomains) {
      lines.push(`- ${domain}`);
    }
  }

  if (user.clarityProjects && user.clarityProjects.length > 0) {
    if (lines.length === 0) lines.push("## Your Analytics Configuration\n");
    lines.push("");
    lines.push("**Microsoft Clarity — already configured:**");
    for (const proj of user.clarityProjects) {
      lines.push(`- ${proj.label}: Project ID \`${proj.projectId}\``);
    }
  }

  if (lines.length === 0) return "";

  lines.push("");
  lines.push("When the user asks about analytics setup or tracking, refer to the above — do NOT ask them to provide IDs or credentials that are already configured.");

  return lines.join("\n");
}
