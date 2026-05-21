import type { Organization } from "./db";

export type ToggleableFeature =
  | "knowledgeBase" | "htmlTemplates" | "landingPages" | "workPlans" | "skills" | "funnels";
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

// Permission model
// ──────────────────────────────────────────────────────────────────────────
// `enabled` controls visibility for **plain members only** — when true, every
// org member sees the item via fanout. Editors and the org owner always see
// and manage org items regardless of `enabled`. Always-on features (BG/MS)
// ignore `enabled` entirely.

function isEditorOrAdmin(user: UserLike, org: OrgLike | null, feature: Feature): boolean {
  if (!user.orgId || !org) return false;
  if (user.orgRole === "owner") return true;
  const cfg = configFor(org, feature);
  return Array.isArray(cfg?.editors) && cfg!.editors.includes(user.userId);
}

export function canViewItem(
  item: ItemLike, user: UserLike, org: OrgLike | null, ownerOrgId: string | undefined, feature: Feature,
): boolean {
  if (item.userId && item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  if (isAlwaysOnFeature(feature)) return true;
  if (isEditorOrAdmin(user, org, feature)) return true;       // editors/admin always see
  return configFor(org, feature)?.enabled === true;            // plain members: only when shared
}

export function canEditItem(
  item: ItemLike, user: UserLike, org: OrgLike | null, ownerOrgId: string | undefined, feature: Feature,
): boolean {
  if (item.userId && item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  return isEditorOrAdmin(user, org, feature);
}

// Whether `user` may create new items of `feature` in `org`.
// - Solo users (no orgId) → allowed (no org to gate against).
// - Org owners / listed editors → allowed regardless of `enabled` toggle.
// - Everyone else → denied.
export function canManageOrgFeature(user: UserLike, org: OrgLike | null, feature: Feature): boolean {
  if (!user.orgId) return true;
  if (!org) return false;
  return isEditorOrAdmin(user, org, feature);
}

// Whether `user` should receive the org-wide fanout for `feature`. Editors and
// the org owner always do; plain members only when sharing is enabled.
// Used by list endpoints to compute the `featureEnabled` arg passed to
// listOrgVisibleItems.
export function isFeatureEffectivelyEnabled(
  user: UserLike,
  org: OrgLike | null,
  feature: Feature,
): boolean {
  if (!org) return false;
  if (isAlwaysOnFeature(feature)) return true;
  if (isEditorOrAdmin(user, org, feature)) return true;
  return configFor(org, feature)?.enabled === true;
}

// Caps used by list-merge endpoints (per spec §5.4)
export const MEMBER_FANOUT_CAP = 100;
export const PER_SOURCE_CAP    = 500;
export const ORG_ITEMS_CAP     = 2000;
export const RESPONSE_CAP      = 1000;

export const TOGGLEABLE_FEATURES: ReadonlyArray<ToggleableFeature> = [
  "knowledgeBase", "htmlTemplates", "landingPages", "workPlans", "skills", "funnels",
];
export const ALWAYS_ON_FEATURES: ReadonlyArray<AlwaysOnFeature> = [
  "brandGuidelines", "marketingStrategy",
];

export interface ListOrgVisibleArgs<T> {
  callerUserId: string;
  orgId: string;
  featureEnabled: boolean;
  getOwnerItems: () => Promise<T[]>;
  getMemberIds:  () => Promise<string[]>;
  getItemsForOwner: (ownerUserId: string) => Promise<T[]>;
  getId: (item: T) => string;
}

export interface ListOrgVisibleResult<T> { items: T[]; truncated: boolean; }

export async function listOrgVisibleItems<T>(args: ListOrgVisibleArgs<T>): Promise<ListOrgVisibleResult<T>> {
  const own = await args.getOwnerItems();
  if (!args.featureEnabled) {
    return { items: own.slice(0, RESPONSE_CAP), truncated: own.length >= PER_SOURCE_CAP };
  }
  const allMembers = await args.getMemberIds();
  const others = allMembers.filter(uid => uid !== args.callerUserId);
  const truncatedFanout = others.length > MEMBER_FANOUT_CAP;
  const fanoutTargets = truncatedFanout ? others.slice(0, MEMBER_FANOUT_CAP) : others;
  const perMember = await Promise.all(fanoutTargets.map(args.getItemsForOwner));
  const orgItems = perMember.flat();
  const truncatedItems = orgItems.length >= ORG_ITEMS_CAP || own.length >= PER_SOURCE_CAP;
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const i of [...own, ...orgItems.slice(0, ORG_ITEMS_CAP)]) {
    const k = args.getId(i);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(i);
    if (merged.length >= RESPONSE_CAP) break;
  }
  return { items: merged, truncated: truncatedFanout || truncatedItems };
}
