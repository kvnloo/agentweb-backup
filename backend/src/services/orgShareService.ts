import type { Organization } from "./db";

export type ToggleableFeature =
  | "knowledgeBase" | "htmlTemplates" | "landingPages" | "workPlans" | "skills" | "analytics";
export type AlwaysOnFeature = "brandGuidelines" | "marketingStrategy";
export type Feature = ToggleableFeature | AlwaysOnFeature;

// Features that have user-owned data items needing transfer/delete on member
// removal. Funnels are no longer a separate share-setting (gated by analytics),
// but their items still need ownership cleanup.
export type OwnedFeature = ToggleableFeature | "funnels";

const ALWAYS_ON: ReadonlySet<Feature> = new Set<Feature>(["brandGuidelines", "marketingStrategy"]);

export function isAlwaysOnFeature(f: Feature): boolean { return ALWAYS_ON.has(f); }

// Member-owned features: every org member may create their own items, and only
// the item owner may edit or delete them — there is no editor-delegation. The
// `enabled` toggle still governs visibility: when on, members' items fan out to
// the whole org; when off, each member only sees their own. This makes
// skills/workPlans behave as "personal items, optionally shared org-wide"
// rather than "org-managed items gated to an editor list".
const MEMBER_OWNED: ReadonlySet<Feature> = new Set<Feature>(["skills", "workPlans"]);

export function isMemberOwnedFeature(f: Feature): boolean { return MEMBER_OWNED.has(f); }

// Single source of truth for per-feature share defaults. Used both as the
// runtime fallback when an org's shareSettings (or a specific feature key) is
// absent, and to initialize shareSettings on org creation.
//
// Everything an org can share is now shared by default. An org is a company: the
// point of putting your team in one is that they can see each other's knowledge
// bases, templates, landing pages and analytics. Defaulting these to private meant
// a new team saw an empty product until someone found this settings page, and most
// never did.
//
// This is safe to flip for existing orgs because the runtime gate prefers an
// explicit value over the default (`isFeatureEnabled`: `if (typeof cfg.enabled ===
// "boolean") return cfg.enabled`). An org that deliberately turned something OFF has
// `enabled: false` stored and keeps it off. The default only fills a gap where the
// org never expressed a preference.
//
// Always-on features (brandGuidelines/marketingStrategy) ignore `enabled` entirely,
// so their default is irrelevant to gating but reported as `true` for completeness.
const DEFAULT_ENABLED: Readonly<Record<ToggleableFeature, boolean>> = {
  knowledgeBase: true,
  htmlTemplates: true,
  landingPages: true,
  workPlans: true,
  skills: true,
  analytics: true,
};

// The effective `enabled` default for a feature when no explicit value exists.
export function defaultEnabledFor(f: Feature): boolean {
  if (isAlwaysOnFeature(f)) return true;
  return DEFAULT_ENABLED[f as ToggleableFeature] === true;
}

// A complete shareSettings object using the per-feature defaults. Used to seed
// `shareSettings` when an org is created so the toggle UI and gating agree.
export function defaultShareSettings(): {
  knowledgeBase: { enabled: boolean; editors: string[] };
  htmlTemplates: { enabled: boolean; editors: string[] };
  landingPages: { enabled: boolean; editors: string[] };
  workPlans: { enabled: boolean; editors: string[] };
  skills: { enabled: boolean; editors: string[] };
  analytics: { enabled: boolean; editors: string[] };
  brandGuidelines: { editors: string[] };
  marketingStrategy: { editors: string[] };
} {
  return {
    knowledgeBase:     { enabled: DEFAULT_ENABLED.knowledgeBase, editors: [] },
    htmlTemplates:     { enabled: DEFAULT_ENABLED.htmlTemplates, editors: [] },
    landingPages:      { enabled: DEFAULT_ENABLED.landingPages,  editors: [] },
    workPlans:         { enabled: DEFAULT_ENABLED.workPlans,     editors: [] },
    skills:            { enabled: DEFAULT_ENABLED.skills,        editors: [] },
    analytics:         { enabled: DEFAULT_ENABLED.analytics,     editors: [] },
    brandGuidelines:   { editors: [] },
    marketingStrategy: { editors: [] },
  };
}

export interface ItemLike { userId?: string }
export interface UserLike { userId: string; orgId?: string; orgRole?: "owner" | "member" }
export type OrgLike = Pick<Organization, "orgId" | "ownerUserId" | "shareSettings">;

function configFor(org: OrgLike | null, f: Feature) {
  if (!org?.shareSettings) return undefined;
  return (org.shareSettings as any)[f] as { enabled?: boolean; editors: string[] } | undefined;
}

// Whether a feature is shared with plain members. Honors an explicit
// `enabled` value when present; otherwise falls back to the per-feature
// default. This makes default-on features (skills, workPlans) work even for
// orgs whose `shareSettings` was never written (e.g. created after the
// one-time backfill migration).
function enabledForMembers(org: OrgLike | null, f: Feature): boolean {
  const cfg = configFor(org, f);
  if (cfg && typeof cfg.enabled === "boolean") return cfg.enabled;
  return defaultEnabledFor(f);
}

// Permission model
// ──────────────────────────────────────────────────────────────────────────
// `enabled` controls visibility for **plain members only** — when true, every
// org member sees the item via fanout. Editors and the org owner always see
// and manage org items regardless of `enabled`. Always-on features (BG/MS)
// ignore `enabled` entirely.

function isEditorOrAdmin(user: UserLike, org: OrgLike | null, feature: Feature): boolean {
  if (!user.orgId || !org) return false;
  if (org.ownerUserId === user.userId) return true;
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
  // Member-owned features: visibility is purely the `enabled` toggle. When off,
  // every member (owner included) sees only their own items.
  if (isMemberOwnedFeature(feature)) return enabledForMembers(org, feature);
  if (isEditorOrAdmin(user, org, feature)) return true;       // editors/admin always see
  return enabledForMembers(org, feature);                      // plain members: when shared (explicit or default)
}

export function canEditItem(
  item: ItemLike, user: UserLike, org: OrgLike | null, ownerOrgId: string | undefined, feature: Feature,
): boolean {
  if (item.userId && item.userId === user.userId) return true;
  if (!user.orgId || !org || !ownerOrgId) return false;
  if (ownerOrgId !== user.orgId) return false;
  // Member-owned features (skills/workPlans): edited by the item owner (handled
  // above) or the org owner as an admin override — but NOT listed editors.
  if (isMemberOwnedFeature(feature)) return user.orgRole === "owner";
  return isEditorOrAdmin(user, org, feature);
}

// Whether `user` may create new items of `feature` in `org`.
// - Solo users (no orgId) → allowed (no org to gate against).
// - Org owners / listed editors → allowed regardless of `enabled` toggle.
// - Everyone else → denied.
export function canManageOrgFeature(user: UserLike, org: OrgLike | null, feature: Feature): boolean {
  if (!user.orgId) return true;
  // Member-owned features (skills/workPlans): every org member may create their
  // own items. Sharing/visibility is governed separately by the `enabled` toggle.
  if (isMemberOwnedFeature(feature)) return true;
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
  // Member-owned features: fanout is governed purely by the `enabled` toggle —
  // no owner/editor override, so when off each member sees only their own items.
  if (isMemberOwnedFeature(feature)) return enabledForMembers(org, feature);
  if (isEditorOrAdmin(user, org, feature)) return true;
  return enabledForMembers(org, feature);
}

// Caps used by list-merge endpoints (per spec §5.4)
export const MEMBER_FANOUT_CAP = 100;
export const PER_SOURCE_CAP    = 500;
export const ORG_ITEMS_CAP     = 2000;
export const RESPONSE_CAP      = 1000;

export const TOGGLEABLE_FEATURES: ReadonlyArray<ToggleableFeature> = [
  "knowledgeBase", "htmlTemplates", "landingPages", "workPlans", "skills", "analytics",
];
export const ALWAYS_ON_FEATURES: ReadonlyArray<AlwaysOnFeature> = [
  "brandGuidelines", "marketingStrategy",
];
export const OWNED_FEATURES: ReadonlyArray<OwnedFeature> = [
  ...TOGGLEABLE_FEATURES, "funnels",
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
