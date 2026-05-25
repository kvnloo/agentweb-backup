import type { Organization } from "./db";

const CONFIG_FIELDS = [
  "googleAnalyticsProperties", "primaryAnalyticsPropertyId", "gaFilteredDomains",
  "seoDomains", "clarityProjects", "productDomain",
] as const;

/**
 * Compute the Organization update to migrate analytics config off the owner's
 * user record. Returns null when nothing should change (already migrated, or
 * already self-saved). Idempotent and "only if absent" — never clobbers
 * existing Org fields or an existing shareSettings.analytics.
 */
export function migrateOrg(org: Organization, ownerUser: any): Record<string, any> | null {
  if (org.analyticsConfigSource) return null;

  const updates: Record<string, any> = {};
  for (const f of CONFIG_FIELDS) {
    if ((org as any)[f] === undefined && ownerUser?.[f] !== undefined) {
      updates[f] = ownerUser[f];
    }
  }

  // Legacy singular owner fields → array form. An empty owner array (e.g. the
  // owner only ever used the legacy single-field UI) counts as "no data" here,
  // so the legacy value is still carried — matching the resolver's normaliser.
  if (
    org.googleAnalyticsProperties === undefined &&
    !updates.googleAnalyticsProperties?.length &&
    ownerUser?.googleAnalyticsPropertyId
  ) {
    updates.googleAnalyticsProperties = [
      { propertyId: ownerUser.googleAnalyticsPropertyId, label: "Main Property" },
    ];
  }
  if (
    org.clarityProjects === undefined &&
    !updates.clarityProjects?.length &&
    ownerUser?.clarityProjectId
  ) {
    updates.clarityProjects = [{ projectId: ownerUser.clarityProjectId, label: "Main Project" }];
  }

  updates.analyticsConfigSource = "migrated";

  // Seed shareSettings.analytics only when shareSettings exists but lacks it.
  if (org.shareSettings && (org.shareSettings as any).analytics === undefined) {
    updates.shareSettings = {
      ...org.shareSettings,
      analytics: { enabled: !!(org as any).shareAnalyticsWithOrg, editors: [] },
    };
  }

  return updates;
}
