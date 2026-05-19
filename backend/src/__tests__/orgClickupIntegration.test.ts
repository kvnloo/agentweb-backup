/**
 * Tests for org-wide ClickUp integration.
 *
 * Design:
 *   - Org admins / KB editors connect once (org-level storage).
 *   - All org members consume through the shared token via getAccessToken().
 *   - Solo users keep per-user storage and are completely unaffected.
 */
import request from "supertest";
import express from "express";

// ── Fixed IDs ────────────────────────────────────────────────────────────────
const ORG_ID = "org-clickup-test";
const OWNER_USER_ID = "user-owner";
const EDITOR_USER_ID = "user-editor";
const MEMBER_USER_ID = "user-member";   // regular org member (not KB editor)
const SOLO_USER_ID = "user-solo";       // no org
const OTHER_ORG_USER_ID = "user-other-org"; // belongs to a different org

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

/** Per-user secrets map — mutated during tests */
const mockUserSecrets: Record<string, Record<string, string>> = {
  [SOLO_USER_ID]: {},
};

// ── DB mocks ──────────────────────────────────────────────────────────────────
const mockGetUserById = jest.fn((uid: string) => Promise.resolve(mockUsers[uid] ?? null));
const mockUpdateUser = jest.fn((uid: string, updates: any) => {
  if (updates.secrets !== undefined) {
    mockUserSecrets[uid] = updates.secrets;
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
    getUserById: mockGetUserById,
    updateUser: mockUpdateUser,
  },
  orgDb: {
    getOrgById: mockGetOrgById,
    setOrgSecret: mockSetOrgSecret,
    removeOrgSecret: mockRemoveOrgSecret,
    getOrgSecret: mockGetOrgSecret,
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
  encryptPassword: mockEncryptPassword,
  decryptPassword: mockDecryptPassword,
}));

// ── ClickUp API mock ──────────────────────────────────────────────────────────
const MOCK_WORKSPACES = [{ id: "ws-1", name: "Acme Workspace", avatar: null }];

jest.mock("axios", () => ({
  get: jest.fn().mockResolvedValue({ data: { teams: [{ id: "ws-1", name: "Acme Workspace", avatar: null }] } }),
  post: jest.fn(),
}));

// ── ClickUp config mock ───────────────────────────────────────────────────────
jest.mock("../config/integrations", () => ({
  getClickUpConfig: jest.fn().mockResolvedValue({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:3001/api/clickup/callback",
    authorizationUrl: "https://app.clickup.com/api",
    tokenUrl: "https://api.clickup.com/api/v2/oauth/token",
  }),
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
// We replace the middleware per-test using a module-level variable
let currentUserId = OWNER_USER_ID;

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUserId, email: `${currentUserId}@example.com`, isAdmin: false };
    next();
  },
}));

// ── App setup ─────────────────────────────────────────────────────────────────
import { authenticateToken } from "../middleware/auth";
import clickupRoutes from "../routes/clickupAuth";

const app = express();
app.use(express.json());
app.use("/api/clickup", authenticateToken, clickupRoutes);

// ── Helper — simulates a stored token session in clickupAuth.ts ───────────────
// Rather than calling /finalize (which hits ClickUp OAuth), we exercise /connect
// with a real tokenSessionId. But since tokenSessions is module-private, we
// exercise /save-token (the PAT route) which doesn't require a session.

// ── Test suites ───────────────────────────────────────────────────────────────
describe("ClickUp org-wide integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset org secrets before each test
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
    mockUpdateUser.mockImplementation((uid: string, updates: any) => {
      if (updates.secrets !== undefined) {
        if (mockUsers[uid]) mockUsers[uid].secrets = updates.secrets;
      }
      return Promise.resolve({ ...mockUsers[uid], ...updates });
    });
  });

  // ── Solo user: per-user storage preserved ──────────────────────────────────
  describe("Solo user (no org)", () => {
    beforeEach(() => { currentUserId = SOLO_USER_ID; });

    it("POST /save-token saves token to user secrets", async () => {
      const res = await request(app)
        .post("/api/clickup/save-token")
        .send({ token: "pk_solo_token" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Must NOT touch orgDb
      expect(mockSetOrgSecret).not.toHaveBeenCalled();
      // Must write to userDb
      expect(mockUpdateUser).toHaveBeenCalledWith(
        SOLO_USER_ID,
        expect.objectContaining({
          secrets: expect.objectContaining({
            clickup_access_token: `encrypted:pk_solo_token:${SOLO_USER_ID}`,
          }),
        })
      );
    });

    it("POST /disconnect removes token from user secrets", async () => {
      // Pre-seed a user secret
      mockUsers[SOLO_USER_ID].secrets = {
        clickup_access_token: `encrypted:pk_solo_token:${SOLO_USER_ID}`,
      };

      const res = await request(app).post("/api/clickup/disconnect").send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // Must NOT touch orgDb
      expect(mockRemoveOrgSecret).not.toHaveBeenCalled();
    });

    it("GET /status returns disconnected when no token", async () => {
      mockUsers[SOLO_USER_ID].secrets = {};
      const res = await request(app).get("/api/clickup/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });
  });

  // ── Org admin: can connect/disconnect ─────────────────────────────────────
  describe("Org admin (owner)", () => {
    beforeEach(() => { currentUserId = OWNER_USER_ID; });

    it("POST /save-token saves token to org secrets", async () => {
      const res = await request(app)
        .post("/api/clickup/save-token")
        .send({ token: "pk_org_admin_token" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetOrgSecret).toHaveBeenCalledWith(
        ORG_ID,
        "clickup_access_token",
        `encrypted:pk_org_admin_token:${ORG_ID}`
      );
      // Must NOT write to userDb (for the token)
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });

    it("POST /disconnect removes token from org secrets", async () => {
      mockOrg.secrets = { clickup_access_token: "some-encrypted-token" };

      const res = await request(app).post("/api/clickup/disconnect").send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockRemoveOrgSecret).toHaveBeenCalledWith(ORG_ID, "clickup_access_token");
      expect(mockUpdateUser).not.toHaveBeenCalled();
    });
  });

  // ── KB editor: can connect/disconnect ────────────────────────────────────
  describe("Org KB editor", () => {
    beforeEach(() => { currentUserId = EDITOR_USER_ID; });

    it("POST /save-token succeeds for KB editor", async () => {
      const res = await request(app)
        .post("/api/clickup/save-token")
        .send({ token: "pk_editor_token" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockSetOrgSecret).toHaveBeenCalledWith(
        ORG_ID,
        "clickup_access_token",
        `encrypted:pk_editor_token:${ORG_ID}`
      );
    });

    it("POST /disconnect succeeds for KB editor", async () => {
      mockOrg.secrets = { clickup_access_token: "enc-token" };

      const res = await request(app).post("/api/clickup/disconnect").send({});
      expect(res.status).toBe(200);
      expect(mockRemoveOrgSecret).toHaveBeenCalledWith(ORG_ID, "clickup_access_token");
    });
  });

  // ── Regular org member (not a KB editor): 403 on write routes ────────────
  describe("Regular org member (NOT KB editor)", () => {
    beforeEach(() => { currentUserId = MEMBER_USER_ID; });

    it("POST /save-token returns 403", async () => {
      const res = await request(app)
        .post("/api/clickup/save-token")
        .send({ token: "pk_member_token" });

      expect(res.status).toBe(403);
      expect(mockSetOrgSecret).not.toHaveBeenCalled();
    });

    it("POST /disconnect returns 403", async () => {
      const res = await request(app).post("/api/clickup/disconnect").send({});
      expect(res.status).toBe(403);
      expect(mockRemoveOrgSecret).not.toHaveBeenCalled();
    });

    it("GET /status returns connected when org has token", async () => {
      // Org has a shared token
      mockOrg.secrets = {
        clickup_access_token: `encrypted:pk_shared_token:${ORG_ID}`,
      };

      const res = await request(app).get("/api/clickup/status");
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
    });

    it("GET /workspace/:teamId/docs succeeds when org has token", async () => {
      mockOrg.secrets = {
        clickup_access_token: `encrypted:pk_shared_token:${ORG_ID}`,
      };

      // Mock listDocs (via axios which is already mocked for the teams call)
      const axios = require("axios");
      axios.get.mockImplementation((url: string, _opts: any) => {
        if (url.includes("/docs")) {
          return Promise.resolve({ data: { docs: [] } });
        }
        return Promise.resolve({ data: { teams: MOCK_WORKSPACES } });
      });

      const res = await request(app).get("/api/clickup/workspace/ws-1/docs");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("docs");
    });
  });

  // ── getAccessToken resolution order ──────────────────────────────────────
  describe("getAccessToken() resolution", () => {
    // Import AFTER mocks are in place
    let getAccessToken: (userId: string) => Promise<string | null>;
    beforeAll(async () => {
      // Dynamic import to pick up jest mocks
      const mod = await import("../services/clickupService");
      getAccessToken = mod.getAccessToken;
    });

    it("returns org token when user is in org with org token (even if user has no personal token)", async () => {
      mockOrg.secrets = { clickup_access_token: `encrypted:org-shared-token:${ORG_ID}` };
      // owner has no personal token
      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBe("org-shared-token");
    });

    it("returns org token over personal token (org precedence)", async () => {
      // Both org and user have tokens
      mockOrg.secrets = { clickup_access_token: `encrypted:org-token:${ORG_ID}` };
      mockUsers[OWNER_USER_ID].secrets = {
        clickup_access_token: `encrypted:personal-token:${OWNER_USER_ID}`,
      };

      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBe("org-token"); // org wins

      // Cleanup
      delete mockUsers[OWNER_USER_ID].secrets;
    });

    it("falls back to user personal token when org has no ClickUp token", async () => {
      mockOrg.secrets = {}; // no org token
      mockUsers[OWNER_USER_ID].secrets = {
        clickup_access_token: `encrypted:personal-fallback:${OWNER_USER_ID}`,
      };

      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBe("personal-fallback");

      // Cleanup
      delete mockUsers[OWNER_USER_ID].secrets;
    });

    it("returns null for org user when neither org nor user has a token", async () => {
      mockOrg.secrets = {};
      delete mockUsers[OWNER_USER_ID].secrets;

      const result = await getAccessToken(OWNER_USER_ID);
      expect(result).toBeNull();
    });

    it("returns personal token for solo user (no orgId)", async () => {
      mockUsers[SOLO_USER_ID].secrets = {
        clickup_access_token: `encrypted:solo-token:${SOLO_USER_ID}`,
      };

      const result = await getAccessToken(SOLO_USER_ID);
      expect(result).toBe("solo-token");

      // Cleanup
      delete mockUsers[SOLO_USER_ID].secrets;
    });

    it("returns null for solo user with no token", async () => {
      mockUsers[SOLO_USER_ID].secrets = {};
      const result = await getAccessToken(SOLO_USER_ID);
      expect(result).toBeNull();
    });
  });
});
