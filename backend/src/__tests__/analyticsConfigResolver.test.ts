import { resolveAnalyticsConfig } from "../services/analyticsConfigResolver";
import { orgDb, userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const ownerUser = {
  userId: "owner-1",
  googleAnalyticsProperties: [{ propertyId: "111", label: "Owner GA" }],
  gaFilteredDomains: ["staging.acme.com"],
  productDomain: "app.acme.com",
  seoDomains: ["acme.com"],
  clarityProjects: [{ projectId: "cl-1", label: "Owner Clarity" }],
};

beforeEach(() => jest.clearAllMocks());

test("member in org with flag ON and owner GA4 → owner bundle, source 'org'", async () => {
  const member = { userId: "m-1", orgId: "org-1", googleAnalyticsProperties: [{ propertyId: "999", label: "Member GA" }] };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);
  mockUserDb.getUserById.mockResolvedValue(ownerUser as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("org");
  expect(r.properties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
  expect(r.primaryPropertyId).toBe("111");
  expect(r.gaFilteredDomains).toEqual(["staging.acme.com"]);
  expect(r.productDomain).toBe("app.acme.com");
  expect(r.seoDomains).toEqual(["acme.com"]);
  expect(r.clarityProjects).toEqual([{ projectId: "cl-1", label: "Owner Clarity" }]);
});

test("member in org with flag OFF → own config, source 'self'", async () => {
  const member = { userId: "m-1", orgId: "org-1", googleAnalyticsProperties: [{ propertyId: "999", label: "Member GA" }] };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: false } as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("self");
  expect(r.properties).toEqual([{ propertyId: "999", label: "Member GA" }]);
  expect(mockUserDb.getUserById).not.toHaveBeenCalled();
});

test("user with no org → own config, source 'self'", async () => {
  const solo = { userId: "solo-1", googleAnalyticsPropertyId: "777" };
  const r = await resolveAnalyticsConfig(solo);
  expect(r.source).toBe("self");
  expect(r.properties).toEqual([{ propertyId: "777", label: "Main Property" }]);
  expect(r.primaryPropertyId).toBe("777");
  expect(mockOrgDb.getOrgById).not.toHaveBeenCalled();
});

test("flag ON but owner has no GA4 → defensive fallback to self", async () => {
  const member = { userId: "m-1", orgId: "org-1", googleAnalyticsProperties: [{ propertyId: "999", label: "Member GA" }] };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: "owner-1" } as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("self");
  expect(r.properties).toEqual([{ propertyId: "999", label: "Member GA" }]);
});

test("legacy-only owner (googleAnalyticsPropertyId) normalises into properties", async () => {
  const member = { userId: "m-1", orgId: "org-1" };
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);
  mockUserDb.getUserById.mockResolvedValue({ userId: "owner-1", googleAnalyticsPropertyId: "555" } as any);

  const r = await resolveAnalyticsConfig(member);

  expect(r.source).toBe("org");
  expect(r.properties).toEqual([{ propertyId: "555", label: "Main Property" }]);
  expect(r.primaryPropertyId).toBe("555");
});

test("org owner with flag ON → own bundle, source 'self' (no indicator for the owner)", async () => {
  const owner = { ...ownerUser, orgId: "org-1" }; // ownerUser.userId === "owner-1"
  mockOrgDb.getOrgById.mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any);

  const r = await resolveAnalyticsConfig(owner);

  expect(r.source).toBe("self"); // the owner's own data — drives "no indicator" in the UI
  expect(r.properties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
  expect(mockUserDb.getUserById).not.toHaveBeenCalled();
});
