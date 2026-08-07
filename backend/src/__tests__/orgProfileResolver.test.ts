/**
 * ENG-927 — creating an org must not blank the owner's Brand Guidelines /
 * Market Strategy.
 *
 * `createOrg` only writes structural fields (name, owner, maxMembers,
 * shareSettings); copying the owner's profile onto the org is a separate,
 * dismissible action. Every org-authoritative read of `brandGuidelines` /
 * `marketStrategy` therefore has to fall back to the org OWNER's user record
 * when the org record has not been populated — the same shape
 * `analyticsConfigResolver` already uses for analytics config.
 */

import { resolveOrgProfileField } from "../services/orgProfileResolver";
import { userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const OWNER_ID = "owner-1";
const MEMBER_ID = "member-1";

const ownerBrand = { brandData: { brandName: "Acme" }, attachments: [{ key: "logo" }] };
const ownerStrategy = { businessOverview: "We sell widgets", competitors: [], icp: [] };
const orgBrand = { brandData: { brandName: "Acme Org" }, attachments: [] };

/** Freshly created org: structural fields only, no profile copied over. */
const unpopulatedOrg = { orgId: "org-1", ownerUserId: OWNER_ID };
const populatedOrg = { ...unpopulatedOrg, brandGuidelines: orgBrand };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe("resolveOrgProfileField — FAIL cases (the ENG-927 regression)", () => {
  test("org owner + org record missing brandGuidelines → owner's own record, not undefined", async () => {
    const owner = { userId: OWNER_ID, orgId: "org-1", brandGuidelines: ownerBrand };

    const resolved = await resolveOrgProfileField(owner, unpopulatedOrg, "brandGuidelines");

    expect(resolved).toEqual(ownerBrand);
    // The caller IS the owner — no extra user lookup should be needed.
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });

  test("org owner + org record missing marketStrategy → owner's own record", async () => {
    const owner = { userId: OWNER_ID, orgId: "org-1", marketStrategy: ownerStrategy };

    const resolved = await resolveOrgProfileField(owner, unpopulatedOrg, "marketStrategy");

    expect(resolved).toEqual(ownerStrategy);
  });

  test("org member + org record missing brandGuidelines → the OWNER's record, not the member's", async () => {
    const member = { userId: MEMBER_ID, orgId: "org-1", brandGuidelines: undefined };
    mockUserDb.getUserById.mockResolvedValue({
      userId: OWNER_ID,
      brandGuidelines: ownerBrand,
    } as any);

    const resolved = await resolveOrgProfileField(member, unpopulatedOrg, "brandGuidelines");

    expect(mockUserDb.getUserById).toHaveBeenCalledWith(OWNER_ID);
    expect(resolved).toEqual(ownerBrand);
  });

  test("logs a warning when the owner-record fallback fires", async () => {
    const owner = { userId: OWNER_ID, orgId: "org-1", brandGuidelines: ownerBrand };

    await resolveOrgProfileField(owner, unpopulatedOrg, "brandGuidelines");

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("org-1")
    );
  });
});

describe("resolveOrgProfileField — boundary / error paths", () => {
  test("org record present and populated → org value wins (no fallback, no lookup)", async () => {
    const owner = { userId: OWNER_ID, orgId: "org-1", brandGuidelines: ownerBrand };

    const resolved = await resolveOrgProfileField(owner, populatedOrg, "brandGuidelines");

    expect(resolved).toEqual(orgBrand);
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  test("no org record (solo user, or orgId pointing at a deleted org) → own record", async () => {
    const solo = { userId: "solo-1", brandGuidelines: ownerBrand };

    expect(await resolveOrgProfileField(solo, null, "brandGuidelines")).toEqual(ownerBrand);
    expect(await resolveOrgProfileField(solo, undefined, "brandGuidelines")).toEqual(ownerBrand);
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });

  test("owner record missing / unreadable → undefined rather than a throw", async () => {
    const member = { userId: MEMBER_ID, orgId: "org-1" };
    mockUserDb.getUserById.mockResolvedValue(null as any);

    await expect(
      resolveOrgProfileField(member, unpopulatedOrg, "brandGuidelines")
    ).resolves.toBeUndefined();
  });

  test("owner lookup failure degrades to the caller's own record instead of a 500", async () => {
    const member = { userId: MEMBER_ID, orgId: "org-1", brandGuidelines: ownerBrand };
    mockUserDb.getUserById.mockRejectedValue(new Error("dynamo down"));

    await expect(
      resolveOrgProfileField(member, unpopulatedOrg, "brandGuidelines")
    ).resolves.toEqual(ownerBrand);
  });

  test("nothing to recover (brand-new org, no brand anywhere) → no warning", async () => {
    // This is the ordinary empty state, and the resolver runs on every `/me`.
    // Warning here would bury the real signal — an org shadowing intact data.
    const owner = { userId: OWNER_ID, orgId: "org-1" };

    await expect(
      resolveOrgProfileField(owner, unpopulatedOrg, "brandGuidelines")
    ).resolves.toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  test("org without an ownerUserId → caller's own record", async () => {
    const owner = { userId: OWNER_ID, orgId: "org-1", marketStrategy: ownerStrategy };

    const resolved = await resolveOrgProfileField(
      owner,
      { orgId: "org-1" },
      "marketStrategy"
    );

    expect(resolved).toEqual(ownerStrategy);
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });
});
