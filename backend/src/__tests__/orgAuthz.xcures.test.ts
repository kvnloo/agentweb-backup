/**
 * ENG-954 — org access control, exercised against the customer situation that
 * drove it plus the orgs that must not notice it happened.
 *
 * xCures asked for two admins twice. The first time (2026-06-18) they removed
 * Tyler, their IT lead, because "we can't have 2 owners/admins". The second time
 * (2026-08-07) Patrick was explicit that transferring away from Filipe was not an
 * acceptable answer: "Eric wants access as an Admin so he can understand what is
 * going on. Filipe needs access as an Admin to do the real work."
 *
 * So the contract these tests pin is: Filipe gives up nothing, Eric gains real
 * authority, Tyler would have been a third, and no other org's users change at all.
 */

import {
  can, canInOrg, roleOf, isBillingRoot, inheritsOrgBilling, isOwnerRole,
  ROLE_PERMISSIONS,
  type OrgPermission, type OrgRole,
} from "../services/orgAuthz";
import type { Organization } from "../services/db";

// ── xCures, as it would be after this change ────────────────────────────────
// Filipe remains ownerUserId: he is both an owner and the billing root, and
// nothing about promoting Eric touches either fact.
const xcures = { orgId: "org-xcures", ownerUserId: "u-filipe", name: "xCures" } as Organization;

const filipe  = { userId: "u-filipe",  orgId: "org-xcures", orgRole: "owner"  as const }; // ops
const eric    = { userId: "u-eric",    orgId: "org-xcures", orgRole: "admin"  as const }; // gatekeeper
const tyler   = { userId: "u-tyler",   orgId: "org-xcures", orgRole: "admin"  as const }; // IT
const georgia = { userId: "u-georgia", orgId: "org-xcures", orgRole: "member" as const }; // minion
const sophie  = { userId: "u-sophie",  orgId: "org-xcures", orgRole: "member" as const }; // minion

// ── An unrelated org that must be completely unaffected ─────────────────────
const haven = { orgId: "org-haven", ownerUserId: "u-juan", name: "Haven" } as Organization;
const juan  = { userId: "u-juan",  orgId: "org-haven", orgRole: "owner"  as const };
const priya = { userId: "u-priya", orgId: "org-haven", orgRole: "member" as const };

// ── A legacy org untouched by the migration: one owner, no admins ───────────
// Every org in production looks like this today. It must behave identically.
const legacy      = { orgId: "org-legacy", ownerUserId: "u-legacy-owner", name: "Legacy" } as Organization;
const legacyOwner = { userId: "u-legacy-owner", orgId: "org-legacy", orgRole: "owner"  as const };
const legacyMate  = { userId: "u-legacy-mate",  orgId: "org-legacy", orgRole: "member" as const };

const ALL_PERMISSIONS: OrgPermission[] = [
  "org:delete", "org:configure", "org:members:manage", "org:members:read",
  "org:accounts:read", "org:accounts:manage", "org:content:manage",
];

const ADMIN_PERMISSIONS = ALL_PERMISSIONS.filter((p) => p !== "org:delete");

describe("xCures: Patrick's actual ask — Eric gets admin, Filipe gives up nothing", () => {
  it("Filipe keeps every authority he had before, including deleting the org", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(can(filipe, xcures, p)).toBe(true);
    }
  });

  it("Filipe is still the billing root — promoting Eric does not move the subscription", () => {
    expect(isBillingRoot(filipe, xcures)).toBe(true);
    expect(isBillingRoot(eric, xcures)).toBe(false);
    expect(inheritsOrgBilling(filipe, xcures)).toBe(false);
  });

  it("Eric can do the operational work he was blocked on — config, members, accounts, content", () => {
    for (const p of ADMIN_PERMISSIONS) {
      expect(can(eric, xcures, p)).toBe(true);
    }
  });

  it("Eric cannot delete the org — the one thing reserved to owners", () => {
    expect(can(eric, xcures, "org:delete")).toBe(false);
  });

  it("Tyler would have been a third admin — nobody has to be removed to make room", () => {
    expect(can(tyler, xcures, "org:members:manage")).toBe(true);
    expect(can(tyler, xcures, "org:configure")).toBe(true);
    expect(can(tyler, xcures, "org:delete")).toBe(false);
    // Three people holding real authority in one org, which is the whole ask.
    const authorities = [filipe, eric, tyler].filter((u) => can(u, xcures, "org:members:manage"));
    expect(authorities).toHaveLength(3);
  });

  it("Eric reads the full connected-account inventory — the PHI/integration question he gates", () => {
    expect(can(eric, xcures, "org:accounts:read")).toBe(true);
    expect(can(georgia, xcures, "org:accounts:read")).toBe(false);
  });

  it("the minions are unchanged: no org authority, as before", () => {
    for (const minion of [georgia, sophie]) {
      for (const p of ALL_PERMISSIONS) {
        expect(can(minion, xcures, p)).toBe(false);
      }
    }
  });
});

describe("no single departure can strand the org", () => {
  it("an org with two owners survives either one leaving", () => {
    const ericPromoted = { ...eric, orgRole: "owner" as const };
    const owners = [filipe, ericPromoted].filter((u) => isOwnerRole(roleOf(u, xcures)));
    expect(owners).toHaveLength(2);
    // Whoever goes, someone who can still administer and delete remains.
    for (const leaver of owners) {
      const remaining = owners.filter((u) => u.userId !== leaver.userId);
      expect(remaining.length).toBeGreaterThan(0);
      expect(remaining.every((u) => can(u, xcures, "org:delete"))).toBe(true);
    }
  });

  it("succession needs no transfer primitive: promote, then leave", () => {
    // Before: Eric is an admin and cannot delete the org.
    expect(can(eric, xcures, "org:delete")).toBe(false);
    // Filipe promotes him. That is the entire succession mechanism.
    const ericAsOwner = { ...eric, orgRole: "owner" as const };
    expect(can(ericAsOwner, xcures, "org:delete")).toBe(true);
    // Filipe can now depart without the org losing an owner.
    expect(isOwnerRole(roleOf(ericAsOwner, xcures))).toBe(true);
  });

  it("an admin alone is not an owner — promotion is a deliberate act, not a side effect", () => {
    expect(isOwnerRole(roleOf(eric, xcures))).toBe(false);
    expect(isOwnerRole(roleOf(tyler, xcures))).toBe(false);
  });
});

describe("billing: the silent-downgrade trap this change had to avoid", () => {
  // subscriptionService/tokenUsageService/auth previously tested `orgRole === "member"`
  // as a stand-in for "not the owner". An admin is neither, so the first teammate
  // promoted would have fallen through to their own empty subscription: Free tier,
  // own quota, no error, no log.
  it("an admin still inherits the org subscription — not downgraded to their own", () => {
    expect(inheritsOrgBilling(eric, xcures)).toBe(true);
    expect(inheritsOrgBilling(tyler, xcures)).toBe(true);
  });

  it("a second OWNER also inherits — role is not the billing signal, ownerUserId is", () => {
    const ericAsOwner = { ...eric, orgRole: "owner" as const };
    expect(isBillingRoot(ericAsOwner, xcures)).toBe(false);
    expect(inheritsOrgBilling(ericAsOwner, xcures)).toBe(true);
  });

  it("plain members inherit exactly as they always did", () => {
    expect(inheritsOrgBilling(georgia, xcures)).toBe(true);
    expect(inheritsOrgBilling(sophie, xcures)).toBe(true);
  });

  it("a solo user with no org inherits nothing and is nobody's billing root", () => {
    const solo = { userId: "u-solo" };
    expect(inheritsOrgBilling(solo, xcures)).toBe(false);
    expect(isBillingRoot(solo, xcures)).toBe(false);
  });

  it("exactly one billing root per org, regardless of how many owners there are", () => {
    const ericAsOwner = { ...eric, orgRole: "owner" as const };
    const roots = [filipe, ericAsOwner, tyler, georgia].filter((u) => isBillingRoot(u, xcures));
    expect(roots).toHaveLength(1);
    expect(roots[0].userId).toBe("u-filipe");
  });
});

describe("no other org is affected", () => {
  it("xCures admins have no authority whatsoever in Haven", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(canInOrg(eric, haven, p)).toBe(false);
      expect(canInOrg(tyler, haven, p)).toBe(false);
      expect(canInOrg(filipe, haven, p)).toBe(false);
    }
  });

  it("Haven's owner has no authority in xCures", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(canInOrg(juan, xcures, p)).toBe(false);
    }
  });

  it("Haven's own users behave exactly as before — owner full, member none", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(canInOrg(juan, haven, p)).toBe(true);
      expect(canInOrg(priya, haven, p)).toBe(false);
    }
  });

  it("billing roots do not leak across orgs", () => {
    expect(isBillingRoot(juan, xcures)).toBe(false);
    expect(isBillingRoot(filipe, haven)).toBe(false);
    expect(isBillingRoot(juan, haven)).toBe(true);
  });

  it("a matching userId in a different org is still denied — orgId is checked, not just the role", () => {
    const impostor = { userId: "u-eric", orgId: "org-haven", orgRole: "admin" as const };
    expect(canInOrg(impostor, xcures, "org:configure")).toBe(false);
  });
});

describe("existing single-owner orgs: byte-for-byte the same behavior", () => {
  it("the legacy owner keeps every permission", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(can(legacyOwner, legacy, p)).toBe(true);
    }
  });

  it("the legacy member gets none, exactly as before", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(can(legacyMate, legacy, p)).toBe(false);
    }
  });

  it("an org where no user row carries orgRole at all still recognises its owner", () => {
    // Org creation writes ownerUserId and orgRole in two separate, untransacted
    // writes, so a crash between them leaves an owner with no role. That org must
    // still be administrable by its owner.
    const roleless = { userId: "u-legacy-owner", orgId: "org-legacy" };
    expect(roleOf(roleless, legacy)).toBe("owner");
    expect(can(roleless, legacy, "org:delete")).toBe(true);
  });

  it("a drifted owner is not locked out — ownerUserId and orgRole are unioned", () => {
    // Production has seen this twice (the "stale role" repairs 15a47e29c, a7f320a80).
    // orgShareService.ts:141 denied these users while its sibling at :113 allowed them.
    const drifted = { userId: "u-legacy-owner", orgId: "org-legacy", orgRole: "member" as const };
    expect(roleOf(drifted, legacy)).toBe("owner");
    expect(can(drifted, legacy, "org:content:manage")).toBe(true);
  });
});

describe("the predicate fails closed", () => {
  it("denies when the org is missing", () => {
    expect(can(filipe, null, "org:configure")).toBe(false);
    expect(roleOf(filipe, null)).toBe("member");
  });

  it("denies when the user is missing", () => {
    expect(can(null, xcures, "org:configure")).toBe(false);
    expect(can(undefined, xcures, "org:configure")).toBe(false);
  });

  it("treats an unrecognised role as a plain member rather than trusting it", () => {
    const bogus = { userId: "u-x", orgId: "org-xcures", orgRole: "superadmin" };
    expect(roleOf(bogus, xcures)).toBe("member");
    expect(can(bogus, xcures, "org:configure")).toBe(false);
  });

  it("canInOrg denies a user carrying no orgId even if their role claims authority", () => {
    const orphan = { userId: "u-x", orgRole: "owner" as const };
    expect(canInOrg(orphan, xcures, "org:configure")).toBe(false);
  });

  it("an org with no ownerUserId does not silently promote anyone", () => {
    const ownerless = { orgId: "org-x", ownerUserId: "" } as Organization;
    expect(roleOf({ userId: "u-x", orgId: "org-x" }, ownerless)).toBe("member");
    expect(isBillingRoot({ userId: "u-x" }, ownerless)).toBe(false);
  });
});

describe("the role table is exhaustive and ordered", () => {
  it("owner strictly contains admin, which strictly contains member", () => {
    const owner = ROLE_PERMISSIONS.owner;
    const admin = ROLE_PERMISSIONS.admin;
    const member = ROLE_PERMISSIONS.member;
    for (const p of admin) expect(owner.has(p)).toBe(true);
    for (const p of member) expect(admin.has(p)).toBe(true);
    expect(owner.size).toBeGreaterThan(admin.size);
    expect(admin.size).toBeGreaterThan(member.size);
  });

  it("org:delete is the only thing separating owner from admin", () => {
    const extra = [...ROLE_PERMISSIONS.owner].filter((p) => !ROLE_PERMISSIONS.admin.has(p));
    expect(extra).toEqual(["org:delete"]);
  });

  it("every declared permission is answered for every role", () => {
    const roles: OrgRole[] = ["owner", "admin", "member"];
    for (const role of roles) {
      expect(ROLE_PERMISSIONS[role]).toBeInstanceOf(Set);
      for (const p of ALL_PERMISSIONS) {
        expect(typeof ROLE_PERMISSIONS[role].has(p)).toBe("boolean");
      }
    }
  });
});
