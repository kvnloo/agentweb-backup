// ENG-2834 AC1: per-org `creatives` share feature (default on) gating the
// ENG-2874 workspace creative library. Off => every member sees only their own.
import express from "express";
import request from "supertest";

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockUpdateShareSettings = jest.fn();
const mockGetOrgMembers = jest.fn();

jest.mock("../services/db", () => ({
  userDb: { getUserById: (...a: any[]) => mockGetUserById(...a) },
  orgDb: {
    getOrgById: (...a: any[]) => mockGetOrgById(...a),
    updateShareSettings: (...a: any[]) => mockUpdateShareSettings(...a),
    getOrgMembers: (...a: any[]) => mockGetOrgMembers(...a),
  },
}));

import routes from "../routes/orgShareSettings";
import {
  TOGGLEABLE_FEATURES,
  OWNED_FEATURES,
  defaultEnabledFor,
  defaultShareSettings,
  isFeatureEffectivelyEnabled,
} from "../services/orgShareService";
import { getWorkspaceAssets, scopeCallerToCreativesSharing } from "../utils/workspaceAssets";

const members = [
  { userId: "alice", orgId: "org-1", displayName: "Alice" },
  { userId: "bob", orgId: "org-1", displayName: "Bob" },
];
const assetsByUser: Record<string, Record<string, any>> = {
  alice: { "t-a": { executions: [{ result_files: [{ url: "a.png" }] }] } },
  bob: { "t-b": { executions: [{ result_files: [{ url: "b.png" }] }] } },
  mallory: { "t-m": { executions: [{ result_files: [{ url: "m.png" }] }] } },
};
const assetDeps = {
  getOrgMembers: async (orgId: string) =>
    orgId === "org-1" ? members : [{ userId: "mallory", orgId: "org-2" }],
  fetchForUser: async (userId: string) => assetsByUser[userId] ?? {},
};
const org = (creatives?: { enabled: boolean; editors: string[] }) => ({
  orgId: "org-1",
  ownerUserId: "alice",
  shareSettings: creatives ? ({ creatives } as any) : undefined,
});

async function libraryFor(userId: string, orgRow: any | (() => Promise<any>)) {
  const getOrg = typeof orgRow === "function" ? orgRow : async () => orgRow;
  const caller = await scopeCallerToCreativesSharing({ userId, orgId: "org-1" }, { getOrg });
  return Object.keys(await getWorkspaceAssets(caller, assetDeps)).sort();
}

describe("creatives share feature definition", () => {
  it("is a toggleable feature that defaults on", () => {
    expect(TOGGLEABLE_FEATURES).toContain("creatives");
    expect(defaultEnabledFor("creatives" as any)).toBe(true);
    expect((defaultShareSettings() as any).creatives).toEqual({ enabled: true, editors: [] });
  });

  it("is not part of member-removal ownership cleanup", () => {
    expect(OWNED_FEATURES).not.toContain("creatives");
    expect(OWNED_FEATURES).toContain("funnels");
    expect(OWNED_FEATURES).toContain("workPlans");
  });

  it("off hides teammates' creatives from the org owner too (no admin override)", () => {
    const off = org({ enabled: false, editors: [] });
    expect(isFeatureEffectivelyEnabled({ userId: "alice", orgId: "org-1", orgRole: "owner" }, off, "creatives" as any)).toBe(false);
    expect(isFeatureEffectivelyEnabled({ userId: "bob", orgId: "org-1", orgRole: "member" }, off, "creatives" as any)).toBe(false);
  });
});

describe("workspace creative library honours the creatives toggle", () => {
  it("member B sees member A's assets when the org never set the toggle (default on)", async () => {
    expect(await libraryFor("bob", org())).toEqual(["t-a", "t-b"]);
  });

  it("member B sees member A's assets when the toggle is explicitly on", async () => {
    expect(await libraryFor("bob", org({ enabled: true, editors: [] }))).toEqual(["t-a", "t-b"]);
  });

  it("each member sees only their own assets when the toggle is off", async () => {
    const off = org({ enabled: false, editors: [] });
    expect(await libraryFor("bob", off)).toEqual(["t-b"]);
    expect(await libraryFor("alice", off)).toEqual(["t-a"]);
  });

  it("falls back to own assets when the org row is missing or unreadable", async () => {
    expect(await libraryFor("bob", null)).toEqual(["t-b"]);
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await libraryFor("bob", async () => { throw new Error("ddb down"); })).toEqual(["t-b"]);
    spy.mockRestore();
  });

  it("never reads the org for a user without one, and never crosses orgs", async () => {
    const getOrg = jest.fn();
    const solo = await scopeCallerToCreativesSharing({ userId: "carol" }, { getOrg });
    expect(solo).toEqual({ userId: "carol" });
    expect(getOrg).not.toHaveBeenCalled();
    // A sharing-on org still cannot surface another org's member.
    expect(await libraryFor("bob", org())).not.toContain("t-m");
  });
});

describe("PATCH /api/orgs/me/share-settings with creatives", () => {
  const legacy = {
    knowledgeBase: { enabled: false, editors: [] },
    htmlTemplates: { enabled: true, editors: [] },
    landingPages: { enabled: false, editors: [] },
    workPlans: { enabled: true, editors: [] },
    skills: { enabled: false, editors: [] },
    analytics: { enabled: false, editors: [] },
    brandGuidelines: { editors: [] },
    marketingStrategy: { editors: [] },
  };
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { (req as any).user = { userId: "alice" }; next(); });
    a.use("/s", routes);
    return a;
  };
  const patch = (shareSettings: any, stored?: any) => {
    mockGetUserById.mockResolvedValueOnce({ userId: "alice", orgId: "org-1", orgRole: "owner" });
    mockGetOrgById.mockResolvedValueOnce({ orgId: "org-1", shareSettings: stored });
    mockGetOrgMembers.mockResolvedValueOnce(members);
    mockUpdateShareSettings.mockResolvedValueOnce("rev-2");
    return request(app()).patch("/s").send({ shareSettings: { ...shareSettings, _revision: "rev-1" } });
  };
  beforeEach(() => {
    [mockGetUserById, mockGetOrgById, mockUpdateShareSettings, mockGetOrgMembers].forEach((m) => m.mockReset());
  });

  it("a portal that predates the feature keeps working and stores the default-on value", async () => {
    const res = await patch(legacy);
    expect(res.status).toBe(200);
    expect(mockUpdateShareSettings.mock.calls[0][1].creatives).toEqual({ enabled: true, editors: [] });
  });

  it("an older portal's save does not silently re-enable a toggle the org turned off", async () => {
    const res = await patch(legacy, { ...legacy, creatives: { enabled: false, editors: [] } });
    expect(res.status).toBe(200);
    expect(mockUpdateShareSettings.mock.calls[0][1].creatives).toEqual({ enabled: false, editors: [] });
  });

  it("persists an explicit off and rejects a malformed value", async () => {
    const ok = await patch({ ...legacy, creatives: { enabled: false, editors: [] } });
    expect(ok.status).toBe(200);
    expect(mockUpdateShareSettings.mock.calls[0][1].creatives.enabled).toBe(false);
    const bad = await patch({ ...legacy, creatives: { enabled: "no", editors: [] } });
    expect(bad.status).toBe(400);
    expect(mockUpdateShareSettings).toHaveBeenCalledTimes(1);
  });
});
