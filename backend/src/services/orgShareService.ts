import type { Organization } from "./db";

export type ToggleableFeature =
  | "knowledgeBase" | "htmlTemplates" | "landingPages" | "workPlans" | "skills";
export type AlwaysOnFeature = "brandGuidelines" | "marketingStrategy";
export type Feature = ToggleableFeature | AlwaysOnFeature;

const ALWAYS_ON: ReadonlySet<Feature> = new Set<Feature>(["brandGuidelines", "marketingStrategy"]);

export function isAlwaysOnFeature(f: Feature): boolean { return ALWAYS_ON.has(f); }

export interface ItemLike { userId?: string }
export interface UserLike { userId: string; orgId?: string; orgRole?: "owner" | "member" }
export type OrgLike = Pick<Organization, "orgId" | "ownerUserId" | "shareSettings">;

function configFor(org: OrgLike | null, f: Feature) {
  if (!org?.shareSettings) return undefined;
  return (org.shareSettings as any)[f] as { enabled?: boolean; editors: string[] } | undefined;
}

export function canViewItem(
  item: ItemLike, user: UserLike, org: OrgLike | null, ownerOrgId: string | undefined, feature: Feature,
): boolean {
  if (item.userId && item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  if (isAlwaysOnFeature(feature)) return true;
  return configFor(org, feature)?.enabled === true;
}

export function canEditItem(
  item: ItemLike, user: UserLike, org: OrgLike | null, ownerOrgId: string | undefined, feature: Feature,
): boolean {
  if (item.userId && item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  if (user.orgRole === "owner") return true;
  const cfg = configFor(org, feature);
  if (!cfg) return false;
  if (!isAlwaysOnFeature(feature) && cfg.enabled !== true) return false;
  return Array.isArray(cfg.editors) && cfg.editors.includes(user.userId);
}

// Caps used by list-merge endpoints (per spec §5.4)
export const MEMBER_FANOUT_CAP = 100;
export const PER_SOURCE_CAP    = 500;
export const ORG_ITEMS_CAP     = 2000;
export const RESPONSE_CAP      = 1000;

export const TOGGLEABLE_FEATURES: ReadonlyArray<ToggleableFeature> = [
  "knowledgeBase", "htmlTemplates", "landingPages", "workPlans", "skills",
];
export const ALWAYS_ON_FEATURES: ReadonlyArray<AlwaysOnFeature> = [
  "brandGuidelines", "marketingStrategy",
];
