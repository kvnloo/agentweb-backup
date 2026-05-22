import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";
import { orgDb, userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn(), updateOrg: jest.fn() },
  userDb: { getUserById: jest.fn(), updateUser: jest.fn() },
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

beforeEach(() => jest.clearAllMocks());

test("readAnalyticsConfig from org target", async () => {
  mockOrgDb.getOrgById.mockResolvedValue({
    orgId: "org-1", seoDomains: ["acme.com"],
    googleAnalyticsProperties: [{ propertyId: "1", label: "A" }],
    primaryAnalyticsPropertyId: "1", clarityProjects: [], gaFilteredDomains: [],
  } as any);
  const cfg = await readAnalyticsConfig({ kind: "org", id: "org-1", canEdit: true });
  expect(cfg.seoDomains).toEqual(["acme.com"]);
  expect(cfg.primaryAnalyticsPropertyId).toBe("1");
});

test("readAnalyticsConfig from user target", async () => {
  mockUserDb.getUserById.mockResolvedValue({ userId: "u-1", seoDomains: ["solo.com"] } as any);
  const cfg = await readAnalyticsConfig({ kind: "user", id: "u-1", canEdit: true });
  expect(cfg.seoDomains).toEqual(["solo.com"]);
  expect(cfg.googleAnalyticsProperties).toEqual([]);
});

test("writeAnalyticsConfig to org target sets analyticsConfigSource='self'", async () => {
  await writeAnalyticsConfig({ kind: "org", id: "org-1", canEdit: true }, { seoDomains: ["x.com"] });
  expect(mockOrgDb.updateOrg).toHaveBeenCalledWith("org-1", { seoDomains: ["x.com"], analyticsConfigSource: "self" });
});

test("writeAnalyticsConfig to user target does NOT set analyticsConfigSource", async () => {
  await writeAnalyticsConfig({ kind: "user", id: "u-1", canEdit: true }, { seoDomains: ["x.com"] });
  expect(mockUserDb.updateUser).toHaveBeenCalledWith("u-1", { seoDomains: ["x.com"] });
});
