import type { Organization } from "./db";

/**
 * Org authorization — the single place that answers "is this caller allowed to do X
 * in this org".
 *
 * Before this module, 29 call sites hand-rolled the same question three different,
 * mutually incompatible ways: 16 compared `org.ownerUserId === userId`, 11 compared
 * `user.orgRole === "owner"`, and 3 OR'd them together. They agreed only because
 * exactly one line in the codebase ever granted ownership (`routes/org.ts` org
 * creation, to the creator), so the two notions could not diverge. The moment a
 * second owner or an admin can exist they diverge everywhere, which is what made
 * consolidating a prerequisite rather than a cleanup.
 *
 * Two separate facts live here and must not be re-fused:
 *
 *  - AUTHORITY is `User.orgRole`, and every role is plural. An org may have N owners
 *    and N admins. This is what makes departure a non-event: any owner can appoint
 *    another, so no single person leaving can strand an org. (GitHub: "no less than
 *    two people"; Vercel: ">= 2 for continuity"; Google Workspace: "recommend two".)
 *  - BILLING ROOT is `Organization.ownerUserId` — the primary owner, the one the
 *    subscription and pooled quota resolve to. It gates billing and nothing else.
 *    `isBillingRoot()` is the only correct way to ask that question; a role test is
 *    not, because with plural owners a second owner is not the billing root.
 *
 * There is deliberately no transfer-ownership primitive. Succession is
 * promote-then-leave, which is what every system surveyed actually does — none has
 * an atomic transfer.
 */

export type OrgRole = "owner" | "admin" | "member";

const VALID_ROLES: ReadonlySet<string> = new Set<OrgRole>(["owner", "admin", "member"]);

export type OrgPermission =
  /** Destroy the organization. Irreversible, so owner-only — the one thing admins cannot do. */
  | "org:delete"
  /** Rename the org, edit its profile/settings, share settings, analytics config, org memory. */
  | "org:configure"
  /** Invite, remove, approve/reject domain-join requests, change another member's role. */
  | "org:members:manage"
  /** Read the member roster and offboarding previews (another member's asset counts). */
  | "org:members:read"
  /** Read the full org connected-account inventory, including accounts owned by others. */
  | "org:accounts:read"
  /** Share, unshare, or disconnect an org-level connected account. */
  | "org:accounts:manage"
  /** Edit or delete another member's items as an org-level override. */
  | "org:content:manage";

const MEMBER: readonly OrgPermission[] = [];

const ADMIN: readonly OrgPermission[] = [
  "org:configure",
  "org:members:manage",
  "org:members:read",
  "org:accounts:read",
  "org:accounts:manage",
  "org:content:manage",
];

const OWNER: readonly OrgPermission[] = [...ADMIN, "org:delete"];

/**
 * Role -> permissions. Typed as a total Record over OrgRole so that adding a role
 * is a compile error until it has been answered here. That exhaustiveness is the
 * whole anti-drift mechanism: the three-way split this module replaces happened
 * because nothing forced the call sites to agree.
 */
export const ROLE_PERMISSIONS: Readonly<Record<OrgRole, ReadonlySet<OrgPermission>>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
};

export interface AuthzUser {
  userId: string;
  orgId?: string;
  orgRole?: string;
}

export type AuthzOrg = Pick<Organization, "orgId" | "ownerUserId">;

/**
 * The caller's effective role in `org`.
 *
 * `org.ownerUserId` is honored as an owner signal in addition to `orgRole`. That is
 * not belt-and-braces — it is required for correctness, because the two fields are
 * written independently and have already drifted in production twice (the "stale
 * role" repairs in 15a47e29c and a7f320a80). Taking the union means a legitimate
 * owner whose `orgRole` was cleared keeps their access instead of being silently
 * locked out, which is exactly the live bug at orgShareService.ts:141 (its sibling
 * twelve lines above already had this fallback; it did not).
 *
 * For an org with a single owner and no drift — every org today — this returns the
 * same answer all three previous idioms did, which is what makes the migration
 * behavior-preserving.
 */
export function roleOf(user: AuthzUser | null | undefined, org: AuthzOrg | null | undefined): OrgRole {
  if (!user || !org) return "member";
  if (org.ownerUserId && org.ownerUserId === user.userId) return "owner";
  if (typeof user.orgRole === "string" && VALID_ROLES.has(user.orgRole)) {
    return user.orgRole as OrgRole;
  }
  return "member";
}

/**
 * Whether `user` may perform `permission` in `org`.
 *
 * Callers must have already established that the user belongs to this org; this
 * answers authority, not membership. Where a caller has both facts to hand, prefer
 * `canInOrg`, which checks membership too.
 */
export function can(
  user: AuthzUser | null | undefined,
  org: AuthzOrg | null | undefined,
  permission: OrgPermission,
): boolean {
  if (!user || !org) return false;
  return ROLE_PERMISSIONS[roleOf(user, org)].has(permission);
}

/**
 * `can()` plus an explicit same-org membership check. Fails closed when the user
 * carries no `orgId`, or belongs to a different org than the one being acted on —
 * the cross-tenant guard several call sites previously had to remember by hand.
 */
export function canInOrg(
  user: AuthzUser | null | undefined,
  org: AuthzOrg | null | undefined,
  permission: OrgPermission,
): boolean {
  if (!user || !org) return false;
  if (!user.orgId || user.orgId !== org.orgId) return false;
  return can(user, org, permission);
}

/**
 * Whether `user` is the org's billing root — the primary owner whose subscription
 * the org inherits and whose counter pooled token usage lands on.
 *
 * This is deliberately NOT a role test. Billing previously keyed on
 * `orgRole === "member"` as a stand-in for "not the owner", which breaks silently
 * the moment any third role value exists: an admin is neither "member" nor the
 * billing root, so they fall through to their own (empty) subscription and get
 * downgraded to Free with their own quota, with no error and no log. Anchoring on
 * `ownerUserId` is correct for members, admins, and second owners alike.
 */
export function isBillingRoot(
  user: Pick<AuthzUser, "userId"> | null | undefined,
  org: AuthzOrg | null | undefined,
): boolean {
  if (!user || !org?.ownerUserId) return false;
  return org.ownerUserId === user.userId;
}

/**
 * Whether a user in an org should have their subscription and quota resolved
 * through the billing root rather than their own record. True for every org member
 * except the billing root itself.
 */
export function inheritsOrgBilling(
  user: Pick<AuthzUser, "userId" | "orgId"> | null | undefined,
  org: AuthzOrg | null | undefined,
): boolean {
  if (!user?.orgId || !org) return false;
  return !isBillingRoot(user, org);
}

/** Roles that count toward the "an org must always retain an owner" invariant. */
export function isOwnerRole(role: string | undefined | null): boolean {
  return role === "owner";
}

/**
 * `can()` for call sites that hold only a `userId`, loading the caller's record to
 * read their role. Most org routes have already fetched the org but not the user.
 *
 * `userDb` is imported lazily so this module stays free of a runtime dependency on
 * `db.ts` — `db.ts` imports `OrgRole` from here, and while that import is
 * type-only (erased at compile time), keeping the value-level graph acyclic avoids
 * relying on that erasure. Same pattern as agentModeService's dynamic import of
 * orgShareService.
 */
export async function callerCan(
  userId: string | undefined | null,
  org: AuthzOrg | null | undefined,
  permission: OrgPermission,
): Promise<boolean> {
  if (!userId || !org) return false;
  const { userDb } = await import("./db");
  const user = await userDb.getUserById(userId);
  if (!user) return false;
  return can({ userId, orgId: user.orgId, orgRole: user.orgRole }, org, permission);
}
