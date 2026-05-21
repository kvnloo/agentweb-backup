import { orgDb, userDb } from "./db";

export interface ResolvedAnalyticsConfig {
  properties: Array<{ propertyId: string; label: string }>;
  primaryPropertyId: string | null;
  gaFilteredDomains: string[];
  productDomain?: string;
  seoDomains: string[];
  clarityProjects: Array<{ projectId: string; label: string }>;
  source: "org" | "self";
}

/** Normalise GA4 properties (new array form, falling back to legacy single field). */
function normaliseProperties(u: any): Array<{ propertyId: string; label: string }> {
  if (u?.googleAnalyticsProperties && u.googleAnalyticsProperties.length > 0) {
    return u.googleAnalyticsProperties;
  }
  if (u?.googleAnalyticsPropertyId) {
    return [{ propertyId: u.googleAnalyticsPropertyId, label: "Main Property" }];
  }
  return [];
}

/** Normalise Clarity projects (new array form, falling back to legacy single field). */
function normaliseClarity(u: any): Array<{ projectId: string; label: string }> {
  if (u?.clarityProjects && u.clarityProjects.length > 0) return u.clarityProjects;
  if (u?.clarityProjectId) return [{ projectId: u.clarityProjectId, label: "Main Project" }];
  return [];
}

function buildBundle(u: any, source: "org" | "self"): ResolvedAnalyticsConfig {
  const properties = normaliseProperties(u);
  return {
    properties,
    primaryPropertyId: properties[0]?.propertyId ?? null,
    gaFilteredDomains: u?.gaFilteredDomains ?? [],
    productDomain: u?.productDomain,
    seoDomains: u?.seoDomains ?? [],
    clarityProjects: normaliseClarity(u),
    source,
  };
}

/**
 * Resolve the analytics configuration that should drive every analytics surface
 * for `user`. When the user is in an org whose owner has shared analytics AND
 * the owner has at least one GA4 property, the org owner's bundle is returned
 * (`source: 'org'`). Otherwise the user's own bundle is returned (`source: 'self'`).
 */
export async function resolveAnalyticsConfig(user: any): Promise<ResolvedAnalyticsConfig> {
  if (user?.orgId) {
    const org = await orgDb.getOrgById(user.orgId);
    if (org?.shareAnalyticsWithOrg === true && org.ownerUserId) {
      const owner =
        org.ownerUserId === user.userId ? user : await userDb.getUserById(org.ownerUserId);
      if (owner && normaliseProperties(owner).length > 0) {
        // The org owner viewing their own shared config is still "self" — the
        // "Showing organization analytics" indicator is for members only.
        const src = org.ownerUserId === user.userId ? "self" : "org";
        return buildBundle(owner, src);
      }
    }
  }
  return buildBundle(user, "self");
}
