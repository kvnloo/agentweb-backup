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

  test("owner lookup failure propagates instead of substituting the caller's profile", async () => {
    // Substituting the caller here is not a harmless read degradation: the
    // write paths merge this value and persist it as the ORG profile, so a
    // transient owner-read failure during an editor's partial save would
    // promote that editor's personal brand to the whole org. Fail instead —
    // the same thing `analyticsConfigResolver` does with its owner lookup.
    const member = { userId: MEMBER_ID, orgId: "org-1", brandGuidelines: ownerBrand };
    mockUserDb.getUserById.mockRejectedValue(new Error("dynamo down"));

    await expect(
      resolveOrgProfileField(member, unpopulatedOrg, "brandGuidelines")
    ).rejects.toThrow("dynamo down");
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

describe("resolveOrgProfileField — missing owner record", () => {
  test("read path degrades to undefined rather than throwing", async () => {
    // getUserById reads the eventually consistent UserIdIndex GSI, so a miss can
    // just be lag. Throwing here would turn that blip into a 500 on /me and the
    // settings pages; nothing is persisted on a read, so degrade and self-heal.
    const member = { userId: MEMBER_ID, orgId: "org-1" };
    mockUserDb.getUserById.mockResolvedValue(undefined as any);

    await expect(
      resolveOrgProfileField(member, unpopulatedOrg, "brandGuidelines")
    ).resolves.toBeUndefined();
  });

  test("write path refuses to build a baseline from a phantom-empty owner", async () => {
    // The caller is about to merge this and persist it as the ORG profile. Once
    // the org record is populated the fallback stops firing for good, so a
    // partial save over a missing owner would mask the owner's real brand
    // permanently — the exact ENG-927 failure this resolver exists to prevent.
    const member = { userId: MEMBER_ID, orgId: "org-1" };
    mockUserDb.getUserById.mockResolvedValue(undefined as any);

    await expect(
      resolveOrgProfileField(member, unpopulatedOrg, "brandGuidelines", { forWrite: true })
    ).rejects.toThrow(/owner .* not found/);
  });

  test("forWrite still resolves normally when the owner IS found", async () => {
    const member = { userId: MEMBER_ID, orgId: "org-1" };
    mockUserDb.getUserById.mockResolvedValue({
      userId: OWNER_ID,
      brandGuidelines: ownerBrand,
    } as any);

    await expect(
      resolveOrgProfileField(member, unpopulatedOrg, "brandGuidelines", { forWrite: true })
    ).resolves.toEqual(ownerBrand);
  });

  test("forWrite does not fire when the caller is the owner (no lookup needed)", async () => {
    const owner = { userId: OWNER_ID, orgId: "org-1", brandGuidelines: ownerBrand };

    await expect(
      resolveOrgProfileField(owner, unpopulatedOrg, "brandGuidelines", { forWrite: true })
    ).resolves.toEqual(ownerBrand);
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });
});
