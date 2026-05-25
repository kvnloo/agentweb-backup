import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";
import { orgDb, userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() },
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

beforeEach(() => jest.clearAllMocks());

const ORG_TARGET = { kind: "org" as const, id: "org-1", canEdit: true, canView: true };
const USER_TARGET = { kind: "user" as const, id: "u-1", canEdit: true, canView: true };

test("readAnalyticsConfig from migrated org target reads org record", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", analyticsConfigSource: "migrated", seoDomains: ["acme.com"],
    googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
    primaryAnalyticsPropertyId: "1", clarityProjects: [], gaFilteredDomains: [],
  } as any);
  const cfg = await readAnalyticsConfig(ORG_TARGET);
  expect(cfg.seoDomains).toEqual(["acme.com"]);
  expect(cfg.primaryAnalyticsPropertyId).toBe("1");
  expect(mockUserDb.getUserById).not.toHaveBeenCalled();
});

test("readAnalyticsConfig from un-migrated org target falls back to owner user record", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", ownerUserId: "owner-1",
    // no analyticsConfigSource → un-migrated
  } as any);
  mockUserDb.getUserById.mockResolvedValue({
    userId: "owner-1", seoDomains: ["owner-acme.com"],
    googleAnalyticsProperties: [{ propertyId: "999", label: "Owner GA" }],
    primaryAnalyticsPropertyId: "999",
  } as any);
  const cfg = await readAnalyticsConfig(ORG_TARGET);
  expect(cfg.seoDomains).toEqual(["owner-acme.com"]);
  expect(cfg.googleAnalyticsProperties).toEqual([{ propertyId: "999", label: "Owner GA" }]);
  expect(cfg.primaryAnalyticsPropertyId).toBe("999");
  expect(mockUserDb.getUserById).toHaveBeenCalledWith("owner-1");
});

test("readAnalyticsConfig from migrated org with empty arrays does NOT fall back (deliberately empty)", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", ownerUserId: "owner-1",
    analyticsConfigSource: "migrated",
    googleAnalyticsProperties: [], seoDomains: [], clarityProjects: [],
  } as any);
  const cfg = await readAnalyticsConfig(ORG_TARGET);
  expect(cfg.googleAnalyticsProperties).toEqual([]);
  expect(cfg.seoDomains).toEqual([]);
  expect(mockUserDb.getUserById).not.toHaveBeenCalled();
});

test("readAnalyticsConfig from self-saved org with empty arrays does NOT fall back", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", ownerUserId: "owner-1",
    analyticsConfigSource: "self",
    googleAnalyticsProperties: [], seoDomains: [],
  } as any);
  const cfg = await readAnalyticsConfig(ORG_TARGET);
  expect(cfg.googleAnalyticsProperties).toEqual([]);
  expect(mockUserDb.getUserById).not.toHaveBeenCalled();
});

test("readAnalyticsConfig from un-migrated org with no owner record stays empty (defensive)", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1" } as any);
  mockUserDb.getUserById.mockResolvedValue(null as any);
  const cfg = await readAnalyticsConfig(ORG_TARGET);
  expect(cfg.seoDomains).toEqual([]);
  expect(cfg.googleAnalyticsProperties).toEqual([]);
});

test("readAnalyticsConfig from user target", async () => {
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1", seoDomains: ["solo.com"] } as any);
  const cfg = await readAnalyticsConfig(USER_TARGET);
  expect(cfg.seoDomains).toEqual(["solo.com"]);
  expect(cfg.googleAnalyticsProperties).toEqual([]);
});

test("writeAnalyticsConfig to org target sets analyticsConfigSource='self'", async () => {
  await writeAnalyticsConfig(ORG_TARGET, { seoDomains: ["x.com"] });
  expect(mockOrgDb.updateOrg).toHaveBeenCalledWith("org-1", { seoDomains: ["x.com"], analyticsConfigSource: "self" });
});

test("writeAnalyticsConfig to user target does NOT set analyticsConfigSource", async () => {
  await writeAnalyticsConfig(USER_TARGET, { seoDomains: ["x.com"] });
  expect(mockUserDb.updateUser).toHaveBeenCalledWith("u-1", { seoDomains: ["x.com"] });
});
