import { resolveAnalyticsConfig, resolveConfigTarget } from "../services/analyticsConfigResolver";
import { orgDb, userDb } from "../services/db";

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

const mockOrgDb = orgDb as jest.Mocked<typeof orgDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

beforeEach(() => jest.clearAllMocks());

const migratedOrg = (over: any = {}) => ({
  orgId: "org-1",
  ownerUserId: "owner-1",
  analyticsConfigSource: "migrated",
  googleAnalyticsProperties: [{ propertyId: "111", label: "Org GA" }],
  primaryAnalyticsPropertyId: "111",
  seoDomains: ["acme.com"],
  clarityProjects: [{ projectId: "cl-1", label: "Org Clarity" }],
  gaFilteredDomains: ["staging.acme.com"],
  productDomain: "app.acme.com",
  shareSettings: { analytics: { enabled: true, editors: [] } },
  ...over,
});

describe("resolveAnalyticsConfig", () => {
  test("solo user (no orgId) → own record, source 'self'", async () => {
    const r = await resolveAnalyticsConfig({ userId: "solo-1", googleAnalyticsPropertyId: "777" });
    expect(r.source).toBe("self");
    expect(r.properties).toEqual([{ propertyId: "777", label: "Main Property" }]);
    expect(mockOrgDb.getOrgById).not.toHaveBeenCalled();
  });

  test("org owner, migrated org → org record, source 'self'", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const r = await resolveAnalyticsConfig({ userId: "owner-1", orgId: "org-1" });
    expect(r.source).toBe("self");
    expect(r.properties).toEqual([{ propertyId: "111", label: "Org GA" }]);
    expect(r.primaryPropertyId).toBe("111");
  });

  test("plain member, sharing ON, migrated → org record, source 'org'", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.source).toBe("org");
    expect(r.seoDomains).toEqual(["acme.com"]);
  });

  test("plain member, sharing OFF → empty config", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: false, editors: [] } } }) as any
    );
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.properties).toEqual([]);
    expect(r.seoDomains).toEqual([]);
  });

  test("editor, sharing OFF → still gets org config (Decision 11)", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: false, editors: ["m-1"] } } }) as any
    );
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.source).toBe("org");
    expect(r.properties).toEqual([{ propertyId: "111", label: "Org GA" }]);
  });

  test("un-migrated org → falls back to owner user record; gate reads legacy shareAnalyticsWithOrg", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true,
    } as any);
    mockUserDb.getUserById.mockResolvedValue({
      userId: "owner-1", googleAnalyticsProperties: [{ propertyId: "555", label: "Legacy" }],
    } as any);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.source).toBe("org");
    expect(r.properties).toEqual([{ propertyId: "555", label: "Legacy" }]);
    expect(mockUserDb.getUserById).toHaveBeenCalledWith("owner-1");
  });

  test("un-migrated org, legacy sharing OFF, plain member → empty", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: false,
    } as any);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1" });
    expect(r.properties).toEqual([]);
  });

  test("orgId set but Organization record missing → treat as solo", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null);
    const r = await resolveAnalyticsConfig({ userId: "m-1", orgId: "org-1", googleAnalyticsPropertyId: "9" });
    expect(r.source).toBe("self");
    expect(r.properties).toEqual([{ propertyId: "9", label: "Main Property" }]);
  });

  test("primary falls back to first property when primaryAnalyticsPropertyId unset", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({
        primaryAnalyticsPropertyId: undefined,
        googleAnalyticsProperties: [{ propertyId: "aaa", label: "A" }, { propertyId: "bbb", label: "B" }],
      }) as any
    );
    const r = await resolveAnalyticsConfig({ userId: "owner-1", orgId: "org-1" });
    expect(r.primaryPropertyId).toBe("aaa");
  });

  test("migrated org with a deliberately empty GA4 array → empty, no owner-record fallback (spec 4.4)", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ googleAnalyticsProperties: [], primaryAnalyticsPropertyId: undefined }) as any
    );
    const r = await resolveAnalyticsConfig({ userId: "owner-1", orgId: "org-1" });
    expect(r.properties).toEqual([]);
    expect(r.primaryPropertyId).toBeNull();
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
  });
});

describe("resolveConfigTarget", () => {
  test("solo user → kind 'user', canEdit true, canView true", async () => {
    const t = await resolveConfigTarget({ userId: "solo-1" });
    expect(t).toEqual({ kind: "user", id: "solo-1", canEdit: true, canView: true });
  });

  test("org owner → kind 'org', canEdit + canView true", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const t = await resolveConfigTarget({ userId: "owner-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "org", id: "org-1", canEdit: true, canView: true });
  });

  test("org editor → kind 'org', canEdit + canView true", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: true, editors: ["m-1"] } } }) as any
    );
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "org", id: "org-1", canEdit: true, canView: true });
  });

  test("plain member, sharing ON → canEdit false, canView true", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(migratedOrg() as any);
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "org", id: "org-1", canEdit: false, canView: true });
  });

  test("plain member, sharing OFF → canEdit + canView both false", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: false, editors: [] } } }) as any
    );
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "org", id: "org-1", canEdit: false, canView: false });
  });

  test("owner, sharing OFF → canView still true (owners always see their own org data)", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: false, editors: [] } } }) as any
    );
    const t = await resolveConfigTarget({ userId: "owner-1", orgId: "org-1" });
    expect(t.canEdit).toBe(true);
    expect(t.canView).toBe(true);
  });

  test("editor, sharing OFF → canView still true (Decision 11)", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(
      migratedOrg({ shareSettings: { analytics: { enabled: false, editors: ["m-1"] } } }) as any
    );
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t.canEdit).toBe(true);
    expect(t.canView).toBe(true);
  });

  test("plain member, un-migrated org with legacy shareAnalyticsWithOrg=true → canView true", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: true,
    } as any);
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t.canView).toBe(true);
    expect(t.canEdit).toBe(false);
  });

  test("plain member, un-migrated org with legacy shareAnalyticsWithOrg=false → canView false", async () => {
    mockOrgDb.getOrgById.mockResolvedValue({
      orgId: "org-1", ownerUserId: "owner-1", shareAnalyticsWithOrg: false,
    } as any);
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t.canView).toBe(false);
  });

  test("orgId set but org missing → kind 'user', canEdit + canView true (treat as solo)", async () => {
    mockOrgDb.getOrgById.mockResolvedValue(null);
    const t = await resolveConfigTarget({ userId: "m-1", orgId: "org-1" });
    expect(t).toEqual({ kind: "user", id: "m-1", canEdit: true, canView: true });
  });
});
