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

export interface ConfigTarget {
  kind: "org" | "user";
  id: string;
  canEdit: boolean;
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
  const explicitPrimary =
    typeof u?.primaryAnalyticsPropertyId === "string" &&
    properties.some((p) => p.propertyId === u.primaryAnalyticsPropertyId)
      ? u.primaryAnalyticsPropertyId
      : null;
  return {
    properties,
    primaryPropertyId: explicitPrimary ?? properties[0]?.propertyId ?? null,
    gaFilteredDomains: u?.gaFilteredDomains ?? [],
    productDomain: u?.productDomain,
    seoDomains: u?.seoDomains ?? [],
    clarityProjects: normaliseClarity(u),
    source,
  };
}

const EMPTY_BUNDLE: ResolvedAnalyticsConfig = {
  properties: [], primaryPropertyId: null, gaFilteredDomains: [],
  productDomain: undefined, seoDomains: [], clarityProjects: [], source: "self",
};

/** True when org-wide analytics sharing is on, reading the new location with a legacy fallback. */
function isSharingEnabled(org: any): boolean {
  return org?.shareSettings?.analytics?.enabled ?? org?.shareAnalyticsWithOrg ?? false;
}

/**
 * Resolve the analytics configuration that drives every analytics surface for
 * `user`. Org users read the Organization record (falling back to the owner's
 * user record for un-migrated orgs). Plain members get an empty config when
 * sharing is off; the owner and analytics editors always get the config.
 */
export async function resolveAnalyticsConfig(user: any): Promise<ResolvedAnalyticsConfig> {
  if (!user?.orgId) return buildBundle(user, "self");

  const org = await orgDb.getOrgById(user.orgId);
  if (!org) return buildBundle(user, "self"); // orgId set but no Org record → treat as solo

  const isOwner = org.ownerUserId === user.userId;
  const isEditor =
    Array.isArray(org.shareSettings?.analytics?.editors) &&
    org.shareSettings!.analytics!.editors.includes(user.userId);

  if (!isOwner && !isEditor && !isSharingEnabled(org)) {
    return { ...EMPTY_BUNDLE };
  }

  let configSource: any;
  if (org.analyticsConfigSource) {
    configSource = org;
  } else {
    console.warn(`[resolveAnalyticsConfig] org ${org.orgId} not migrated — using owner-record fallback`);
    configSource = isOwner ? user : await userDb.getUserById(org.ownerUserId);
  }

  return buildBundle(configSource, isOwner ? "self" : "org");
}

/**
 * Resolve where `user`'s analytics config is edited and whether they may edit
 * it. Org users target the Organization record; only the owner and analytics
 * editors may edit. Solo users target their own user record.
 */
export async function resolveConfigTarget(user: any): Promise<ConfigTarget> {
  if (!user?.orgId) return { kind: "user", id: user.userId, canEdit: true };

  const org = await orgDb.getOrgById(user.orgId);
  if (!org) return { kind: "user", id: user.userId, canEdit: true };

  const isOwner = org.ownerUserId === user.userId;
  const isEditor =
    Array.isArray(org.shareSettings?.analytics?.editors) &&
    org.shareSettings!.analytics!.editors.includes(user.userId);

  return { kind: "org", id: org.orgId, canEdit: isOwner || isEditor };
}
