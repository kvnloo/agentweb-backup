import { migrateOrg } from "../services/analyticsConfigMigration";

const owner = {
  userId: "owner-1",
  googleAnalyticsProperties: [{ propertyId: "111", label: "Owner GA" }],
  seoDomains: ["acme.com"],
  clarityProjects: [{ projectId: "cl-1", label: "C" }],
};

test("copies owner config onto an un-migrated org and stamps the marker", () => {
  const u = migrateOrg({ orgId: "o", ownerUserId: "owner-1", shareAnalyticsWithOrg: true } as any, owner as any);
  expect(u).not.toBeNull();
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
  expect(u!.seoDomains).toEqual(["acme.com"]);
  expect(u!.analyticsConfigSource).toBe("migrated");
});

test("already-migrated org → null (idempotent)", () => {
  expect(migrateOrg({ orgId: "o", ownerUserId: "owner-1", analyticsConfigSource: "migrated" } as any, owner as any)).toBeNull();
});

test("self-saved org → null (never re-touched)", () => {
  expect(migrateOrg({ orgId: "o", ownerUserId: "owner-1", analyticsConfigSource: "self" } as any, owner as any)).toBeNull();
});

test("does not overwrite an Org field that is already set", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1", seoDomains: ["already.com"] } as any,
    owner as any,
  );
  expect(u!.seoDomains).toBeUndefined(); // already.com left untouched
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "111", label: "Owner GA" }]);
});

test("seeds shareSettings.analytics from legacy boolean when absent", () => {
  const existing = {
    knowledgeBase: { enabled: false, editors: [] }, htmlTemplates: { enabled: false, editors: [] },
    landingPages: { enabled: false, editors: [] }, workPlans: { enabled: false, editors: [] },
    skills: { enabled: false, editors: [] },
    brandGuidelines: { editors: [] }, marketingStrategy: { editors: [] },
  };
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1", shareAnalyticsWithOrg: true, shareSettings: existing } as any,
    owner as any,
  );
  expect(u!.shareSettings.analytics).toEqual({ enabled: true, editors: [] });
});

test("does NOT clobber a pre-existing shareSettings.analytics", () => {
  const existing = { analytics: { enabled: true, editors: ["x"] } };
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1", shareAnalyticsWithOrg: false, shareSettings: existing } as any,
    owner as any,
  );
  expect(u!.shareSettings).toBeUndefined(); // analytics already present → left alone
});

test("legacy singular owner fields normalise into arrays", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1" } as any,
    { userId: "owner-1", googleAnalyticsPropertyId: "999", clarityProjectId: "ul99x99x" } as any,
  );
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "999", label: "Main Property" }]);
  expect(u!.clarityProjects).toEqual([{ projectId: "ul99x99x", label: "Main Project" }]);
});

test("legacy clarityProjectId is carried even when owner has an empty clarityProjects array", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1" } as any,
    { userId: "owner-1", clarityProjects: [], clarityProjectId: "ownerclar01" } as any,
  );
  expect(u!.clarityProjects).toEqual([{ projectId: "ownerclar01", label: "Main Project" }]);
});

test("legacy googleAnalyticsPropertyId is carried even when owner has an empty googleAnalyticsProperties array", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1" } as any,
    { userId: "owner-1", googleAnalyticsProperties: [], googleAnalyticsPropertyId: "999" } as any,
  );
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "999", label: "Main Property" }]);
});

test("a non-empty owner array wins over the legacy singular field", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1" } as any,
    {
      userId: "owner-1",
      clarityProjects: [{ projectId: "real-1", label: "Real" }],
      clarityProjectId: "stale-legacy",
      googleAnalyticsProperties: [{ propertyId: "real-ga", label: "Real GA" }],
      googleAnalyticsPropertyId: "stale-ga",
    } as any,
  );
  expect(u!.clarityProjects).toEqual([{ projectId: "real-1", label: "Real" }]);
  expect(u!.googleAnalyticsProperties).toEqual([{ propertyId: "real-ga", label: "Real GA" }]);
});

test("an empty owner array with no legacy field stays empty (genuinely empty)", () => {
  const u = migrateOrg(
    { orgId: "o", ownerUserId: "owner-1" } as any,
    { userId: "owner-1", clarityProjects: [], googleAnalyticsProperties: [] } as any,
  );
  expect(u!.clarityProjects).toEqual([]);
  expect(u!.googleAnalyticsProperties).toEqual([]);
});
