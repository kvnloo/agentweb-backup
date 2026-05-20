/**
 * Tests for org-wide Foreplay integration.
 *
 * Design:
 *   - Org admins / KB editors connect once (org-level storage).
 *   - All org members consume through the shared token via getAccessToken().
 *   - Solo users keep per-user storage and are completely unaffected.
 *   - getAccessToken() follows 3-tier precedence: org → user → platform-wide key.
 */
import request from "supertest";
import express from "express";

// ── Fixed IDs ────────────────────────────────────────────────────────────────
const ORG_ID = "org-foreplay-test";
const OWNER_USER_ID = "user-fp-owner";
const EDITOR_USER_ID = "user-fp-editor";
const MEMBER_USER_ID = "user-fp-member";   // regular org member (not KB editor)
const SOLO_USER_ID = "user-fp-solo";       // no org
const OTHER_ORG_USER_ID = "user-fp-other-org"; // belongs to a different org

const OWNER_ORG_ROLE: "owner" | "member" = "owner";
const MEMBER_ORG_ROLE: "owner" | "member" = "member";

// ── Shared mock state ─────────────────────────────────────────────────────────
/** Simulated DynamoDB user records */
const mockUsers: Record<string, any> = {
  [OWNER_USER_ID]:     { userId: OWNER_USER_ID,     orgId: ORG_ID, orgRole: OWNER_ORG_ROLE },
  [EDITOR_USER_ID]:    { userId: EDITOR_USER_ID,    orgId: ORG_ID, orgRole: MEMBER_ORG_ROLE },
  [MEMBER_USER_ID]:    { userId: MEMBER_USER_ID,    orgId: ORG_ID, orgRole: MEMBER_ORG_ROLE },
  [SOLO_USER_ID]:      { userId: SOLO_USER_ID },
  [OTHER_ORG_USER_ID]: { userId: OTHER_ORG_USER_ID, orgId: "other-org", orgRole: MEMBER_ORG_ROLE },
};

/** Simulated org record — mutated during tests */
let mockOrg: any = {
  orgId: ORG_ID,
  ownerUserId: OWNER_USER_ID,
  shareSettings: {
    knowledgeBase: { enabled: true, editors: [EDITOR_USER_ID] },
    htmlTemplates: { enabled: false, editors: [] },
    landingPages: { enabled: false, editors: [] },
    workPlans: { enabled: false, editors: [] },
    skills: { enabled: false, editors: [] },
    brandGuidelines: { editors: [] },
    marketingStrategy: { editors: [] },
  },
  secrets: {},
};

// ── DB mocks ──────────────────────────────────────────────────────────────────
const mockGetUserById = jest.fn((uid: string) => Promise.resolve(mockUsers[uid] ?? null));
const mockUpdateUser = jest.fn((uid: string, updates: any) => {
  if (updates.secrets !== undefined) {
    if (mockUsers[uid]) mockUsers[uid].secrets = updates.secrets;
  }
  return Promise.resolve({ ...mockUsers[uid], ...updates });
});
const mockGetOrgById = jest.fn((_orgId: string) => Promise.resolve(mockOrg));
const mockSetOrgSecret = jest.fn((orgId: string, key: string, value: string) => {
  if (!mockOrg.secrets) mockOrg.secrets = {};
  mockOrg.secrets[key] = value;
  return Promise.resolve();
});
const mockRemoveOrgSecret = jest.fn((_orgId: string, key: string) => {
  if (mockOrg.secrets) delete mockOrg.secrets[key];
  return Promise.resolve();
});
const mockGetOrgSecret = jest.fn((_orgId: string, key: string) => {
  return Promise.resolve(mockOrg.secrets?.[key] ?? null);
});

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: (uid: string) => mockGetUserById(uid),
    updateUser: (uid: string, updates: any) => mockUpdateUser(uid, updates),
  },
  orgDb: {
    getOrgById: (orgId: string) => mockGetOrgById(orgId),
    setOrgSecret: (orgId: string, key: string, value: string) => mockSetOrgSecret(orgId, key, value),
    removeOrgSecret: (orgId: string, key: string) => mockRemoveOrgSecret(orgId, key),
    getOrgSecret: (orgId: string, key: string) => mockGetOrgSecret(orgId, key),
  },
}));

// ── Crypto mocks ──────────────────────────────────────────────────────────────
// Deterministic encryption: "encrypted:<token>:<id>" — easy to assert
const mockEncryptPassword = jest.fn((pw: string, id: string) => `encrypted:${pw}:${id}`);
const mockDecryptPassword = jest.fn((enc: string) => {
  const parts = enc.split(":");
  return { password: parts[1], userId: parts[2] };
});

jest.mock("../utils/crypto", () => ({
  encryptPassword: (pw: string, id: string) => mockEncryptPassword(pw, id),
  decryptPassword: (enc: string) => mockDecryptPassword(enc),
}));

// ── Platform-wide Foreplay key mock ───────────────────────────────────────────
const mockGetForeplayApiKey = jest.fn(() => Promise.resolve<string | null>("platform-wide-key"));

jest.mock("../utils/secretsManager", () => ({
  getForeplayApiKey: () => mockGetForeplayApiKey(),
}));

// ── Foreplay API mock ─────────────────────────────────────────────────────────
const MOCK_BOARDS = [{ id: "board-1", name: "Acme Ads" }];

jest.mock("axios", () => ({
  get: jest.fn().mockResolvedValue({
    data: {
      data: [{ id: "board-1", name: "Acme Ads" }],
      // usage shape
      credits_used: 10,
      credits_remaining: 90,
      plan: "pro",
    },
  }),
  post: jest.fn(),
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
let currentUserId = OWNER_USER_ID;

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUserId, email: `${currentUserId}@example.com`, isAdmin: false };
    next();
  },
}));

// ── App setup ─────────────────────────────────────────────────────────────────
import { authenticateToken } from "../middleware/auth";
import foreplayRoutes from "../routes/foreplayAuth";

const app = express();
app.use(express.json());
app.use("/api/foreplay", authenticateToken, foreplayRoutes);

// ── Test suites ───────────────────────────────────────────────────────────────
describe("Foreplay org-wide integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset org state
    mockOrg = {
      orgId: ORG_ID,
      ownerUserId: OWNER_USER_ID,
      shareSettings: {
        knowledgeBase: { enabled: true, editors: [EDITOR_USER_ID] },
        htmlTemplates: { enabled: false, editors: [] },
        landingPages: { enabled: false, editors: [] },
        workPlans: { enabled: false, editors: [] },
        skills: { enabled: false, editors: [] },
        brandGuidelines: { editors: [] },
        marketingStrategy: { editors: [] },
      },
      secrets: {},
    };

    // Reset user secrets
    delete mockUsers[OWNER_USER_ID].secrets;
    delete mockUsers[EDITOR_USER_ID].secrets;
    delete mockUsers[MEMBER_USER_ID].secrets;
    delete mockUsers[SOLO_USER_ID].secrets;

    // Restore mock implementations after clearAllMocks
    mockGetUserById.mockImplementation((uid: string) => Promise.resolve(mockUsers[uid] ?? null));
    mockGetOrgById.mockImplementation((_orgId: string) => Promise.resolve(mockOrg));
    mockSetOrgSecret.mockImplementation((orgId: string, key: string, value: string) => {
      if (!mockOrg.secrets) mockOrg.secrets = {};
      mockOrg.secrets[key] = value;
      return Promise.resolve();
    });
    mockRemoveOrgSecret.mockImplementation((_orgId: string, key: string) => {
      if (mockOrg.secrets) delete mockOrg.secrets[key];
      return Promise.resolve();
    });
    mockGetOrgSecret.mockImplementation((_orgId: string, key: string) => {
      return Promise.resolve(mockOrg.secrets?.[key] ?? null);
    });
    mockEncryptPassword.mockImplementation((pw: string, id: string) => `encrypted:${pw}:${id}`);
    mockDecryptPassword.mockImplementation((enc: string) => {
      const parts = enc.split(":");
      return { password: parts[1], userId: parts[2] };
    });
    mockGetForeplayApiKey.mockImplementation(() => Promise.resolve("platform-wide-key"));
    mockUpdateUser.mockImplementation((uid: string, updates: any) => {
      if (updates.secrets !== undefined) {
        if (mockUsers[uid]) mockUsers[uid].secrets = updates.secrets;
      }
      return Promise.resolve({ ...mockUsers[uid], ...updates });
    });

    const axios = require("axios");
    axios.get.mockResolvedValue({
      data: {
        data: [{ id: "board-1", name: "Acme Ads" }],
        credits_used: 10,
        credits_remaining: 90,
        plan: "pro",
      },
    });
  });

  // ── Solo user: per-user storage preserved ──────────────────────────────────
  describe("Solo user (no org)", () => {
    beforeEach(() => { currentUserId = SOLO_USER_ID; });

    it("POST /save-token saves token to user secrets", async () => {
      const res = await request(app)
        .post("/api/foreplay/save-token")
        .send({ token: "fp_solo_token" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Must NOT touch orgDb
      expect(mockSetOrgSecret).not.toHaveBeenCalled();
      // Must write to userDb
      expect(mockUpdateUser).toHaveBeenCalledWith(
        SOLO_USER_ID,
        expect.objectContaining({
          secrets: expect.objectContaining({
            foreplay_api_token: `encrypted:fp_solo_token:${SOLO_USER_ID}`,
          }),
        })
      );
    });

    it("POST /disconnect removes token from user secrets", async () => {
      // Pre-seed a user secret
      mockUsers[SOLO_USER_ID].secrets = {
        foreplay_api_token: `encrypted:fp_solo_token:${SOLO_USER_ID}`,
      };

      const res = await request(app).post("/api/foreplay/disconnect").send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Must NOT touch orgDb
      expect(mockRemoveOrgSecret).not.toHaveBeenCalled();
    });

    it("GET /status returns disconnected when no token and no platform key", async () => {
      mockGetForeplayApiKey.mockImplementationOnce(() => Promise.resolve(null));
      // No secrets on user; platform key returns null
      const res = await request(app).get("/api/foreplay/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });
  });

  // ── Org admin: can connect/disconnect ─────────────────────────────────────
  describe("Org admin (owner)", () => {
    beforeEach(() => { currentUserId = OWNER_USER_ID; });

    it("POST /save-token saves token to org secrets", async () => {
      const res = await request(app)
        .post("/api/foreplay/save-token")
        .send({ token: "fp_org_admin_token" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetOrgSecret).toHaveBeenCalledWith(
        ORG_ID,
        "foreplay_api_token",
        `encrypted:fp_org_admin_token:${ORG_ID}`
      );
      // Must NOT write to userDb (for the token)
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it("POST /disconnect removes token from org secrets", async () => {
      mockOrg.secrets = { foreplay_api_token: "some-encrypted-token" };

      const res = await request(app).post("/api/foreplay/disconnect").send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRemoveOrgSecret).toHaveBeenCalledWith(ORG_ID, "foreplay_api_token");
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });
  });

  // ── KB editor: can connect/disconnect ────────────────────────────────────
  describe("Org KB editor", () => {
    beforeEach(() => { currentUserId = EDITOR_USER_ID; });

    it("POST /save-token succeeds for KB editor", async () => {
      const res = await request(app)
        .post("/api/foreplay/save-token")
        .send({ token: "fp_editor_token" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetOrgSecret).toHaveBeenCalledWith(
        ORG_ID,
        "foreplay_api_token",
        `encrypted:fp_editor_token:${ORG_ID}`
      );
    });

    it("POST /disconnect succeeds for KB editor", async () => {
      mockOrg.secrets = { foreplay_api_token: "enc-token" };

      const res = await request(app).post("/api/foreplay/disconnect").send({});
      expect(res.status).toBe(200);
      expect(mockRemoveOrgSecret).toHaveBeenCalledWith(ORG_ID, "foreplay_api_token");
    });
  });

  // ── Regular org member (not a KB editor): 403 on write routes ────────────
  describe("Regular org member (NOT KB editor)", () => {
    beforeEach(() => { currentUserId = MEMBER_USER_ID; });

    it("POST /save-token returns 403", async () => {
      const res = await request(app)
        .post("/api/foreplay/save-token")
        .send({ token: "fp_member_token" });

      expect(res.status).toBe(403);
      expect(mockSetOrgSecret).not.toHaveBeenCalled();
    });

    it("POST /disconnect returns 403", async () => {
      const res = await request(app).post("/api/foreplay/disconnect").send({});
      expect(res.status).toBe(403);
      expect(mockRemoveOrgSecret).not.toHaveBeenCalled();
    });

    it("GET /status returns connected when org has token", async () => {
      mockOrg.secrets = {
        foreplay_api_token: `encrypted:fp_shared_token:${ORG_ID}`,
      };

      const res = await request(app).get("/api/foreplay/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
    });
  });

  // ── Different-org user: 403 on writes ────────────────────────────────────
  describe("User from a different org", () => {
    let otherMockOrg: any;

    beforeEach(() => {
      currentUserId = OTHER_ORG_USER_ID;

      // Set up a separate org for this user (not owner, no KB edit rights)
      otherMockOrg = {
        orgId: "other-org",
        ownerUserId: "other-org-owner",
        shareSettings: {
          knowledgeBase: { enabled: false, editors: [] },
          htmlTemplates: { enabled: false, editors: [] },
          landingPages: { enabled: false, editors: [] },
          workPlans: { enabled: false, editors: [] },
          skills: { enabled: false, editors: [] },
          brandGuidelines: { editors: [] },
          marketingStrategy: { editors: [] },
        },
        secrets: {},
      };

      mockGetOrgById.mockImplementation((_orgId: string) => {
        if (_orgId === "other-org") return Promise.resolve(otherMockOrg);
        return Promise.resolve(mockOrg);
      });
    });

    it("POST /save-token returns 403", async () => {
      const res = await request(app)
        .post("/api/foreplay/save-token")
        .send({ token: "fp_other_token" });

      expect(res.status).toBe(403);
      expect(mockSetOrgSecret).not.toHaveBeenCalled();
    });

    it("POST /disconnect returns 403", async () => {
      const res = await request(app).post("/api/foreplay/disconnect").send({});
      expect(res.status).toBe(403);
      expect(mockRemoveOrgSecret).not.toHaveBeenCalled();
    });
  });

  // ── getAccessToken resolution order ──────────────────────────────────────
  describe("getAccessToken() resolution", () => {
    // Import AFTER mocks are in place
    let getAccessToken: (userId: string) => Promise<string | null>;
    beforeAll(async () => {
      // Dynamic import to pick up jest mocks
      const mod = await import("../services/foreplayService");
      getAccessToken = mod.getAccessToken;
    });

    it("Tier 1 — returns org token when user is in org with org token", async () => {
      mockOrg.secrets = { foreplay_api_token: `encrypted:org-shared-token:${ORG_ID}` };
      // owner has no personal token
      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBe("org-shared-token");
    });

    it("Tier 1 — org token takes precedence over personal user token", async () => {
      mockOrg.secrets = { foreplay_api_token: `encrypted:org-token:${ORG_ID}` };
      mockUsers[OWNER_USER_ID].secrets = {
        foreplay_api_token: `encrypted:personal-token:${OWNER_USER_ID}`,
      };

      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBe("org-token"); // org wins

      // Cleanup
      delete mockUsers[OWNER_USER_ID].secrets;
    });

    it("Tier 2 — falls back to user personal token when org has no Foreplay token", async () => {
      mockOrg.secrets = {}; // no org token
      mockUsers[OWNER_USER_ID].secrets = {
        foreplay_api_token: `encrypted:personal-fallback:${OWNER_USER_ID}`,
      };

      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBe("personal-fallback");

      // Cleanup
      delete mockUsers[OWNER_USER_ID].secrets;
    });

    it("Tier 3 — falls back to platform-wide key when neither org nor user has a token", async () => {
      mockOrg.secrets = {}; // no org token
      delete mockUsers[OWNER_USER_ID].secrets;

      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBe("platform-wide-key");
    });

    it("Tier 3 — solo user with no personal token returns platform-wide key", async () => {
      delete mockUsers[SOLO_USER_ID].secrets;

      const result = await getAccessToken(SOLO_USER_ID);
      expect(result).toBe("platform-wide-key");
    });

    it("returns personal token for solo user (no orgId)", async () => {
      mockUsers[SOLO_USER_ID].secrets = {
        foreplay_api_token: `encrypted:solo-token:${SOLO_USER_ID}`,
      };

      const result = await getAccessToken(SOLO_USER_ID);
      expect(result).toBe("solo-token");

      // Cleanup
      delete mockUsers[SOLO_USER_ID].secrets;
    });

    it("returns null when platform-wide key is also absent", async () => {
      mockOrg.secrets = {};
      delete mockUsers[OWNER_USER_ID].secrets;
      mockGetForeplayApiKey.mockImplementationOnce(() => Promise.resolve(null));

      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBeNull();
    });
  });
});
