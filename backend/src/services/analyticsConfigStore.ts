import { orgDb, userDb } from "./db";
import type { ConfigTarget } from "./analyticsConfigResolver";
import type { AnalyticsConfigValue } from "./analyticsConfigValidator";

export interface StoredAnalyticsConfig {
  seoDomains: string[];
  googleAnalyticsProperties: Array<{ propertyId: string; label: string }>;
  primaryAnalyticsPropertyId: string | null;
  gaFilteredDomains: string[];
  clarityProjects: Array<{ projectId: string; label: string }>;
  productDomain: string | null;
}

function shape(rec: any): StoredAnalyticsConfig {
  return {
    seoDomains: rec?.seoDomains ?? [],
    googleAnalyticsProperties: rec?.googleAnalyticsProperties ?? [],
    primaryAnalyticsPropertyId: rec?.primaryAnalyticsPropertyId ?? null,
    gaFilteredDomains: rec?.gaFilteredDomains ?? [],
    clarityProjects: rec?.clarityProjects ?? [],
    productDomain: rec?.productDomain ?? null,
  };
}

/**
 * Read the editable analytics config from the target record. For un-migrated
 * Orgs (no `analyticsConfigSource`), falls back to the owner's user record so
 * the Settings tab and admin SEO/AEO dialog don't render an empty form
 * pre-migration — mirroring the resolver behaviour used by `/seo`.
 */
export async function readAnalyticsConfig(target: ConfigTarget): Promise<StoredAnalyticsConfig> {
  if (target.kind === "user") {
    return shape(await userDb.getUserById(target.id));
  }
  const org = await orgDb.getOrgById(target.id);
  if (org?.analyticsConfigSource) return shape(org);
  const owner = org?.ownerUserId ? await userDb.getUserById(org.ownerUserId) : null;
  return shape(owner ?? org);
}

/**
 * Write the provided fields to the target record. Uses attribute-level updates
 * (orgDb.updateOrg / userDb.updateUser both build per-field UpdateExpressions),
 * so concurrent section saves never clobber each other. Org writes also stamp
 * `analyticsConfigSource: "self"` so the resolver trusts the Org record.
 */
export async function writeAnalyticsConfig(
  target: ConfigTarget,
  fields: Partial<AnalyticsConfigValue>,
): Promise<void> {
  if (target.kind === "org") {
    await orgDb.updateOrg(target.id, { ...fields, analyticsConfigSource: "self" } as any);
  } else {
    await userDb.updateUser(target.id, fields as any);
  }
}
