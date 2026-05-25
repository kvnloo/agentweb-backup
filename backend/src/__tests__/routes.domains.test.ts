// Capture the DynamoDB mock instance so individual tests can override behavior
let mockDynamoInstance: any = null;

// Mock aws-sdk before any imports
jest.mock("aws-sdk", () => {
  return {
    __esModule: true,
    default: {
      DynamoDB: {
        DocumentClient: jest.fn().mockImplementation(() => {
          mockDynamoInstance = {
            put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
            get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
            update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
            delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
            query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
            scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
          };
          return mockDynamoInstance;
        }),
      },
      SecretsManager: jest.fn(() => ({
        getSecretValue: jest.fn().mockReturnValue({
          promise: () => Promise.resolve({ SecretString: '{"token":"test"}' }),
        }),
      })),
      config: { update: jest.fn() },
    },
  };
});

// Mock the customDomainService
const mockAddSubdomain = jest.fn();
const mockAddCustomDomain = jest.fn();
const mockRemoveDomain = jest.fn();
const mockListDomains = jest.fn();
const mockGetDomain = jest.fn();
const mockVerifyDomain = jest.fn();
const mockGenerateSubdomain = jest.fn();

jest.mock("../services/customDomainService", () => ({
  addSubdomain: (...args: any[]) => mockAddSubdomain(...args),
  addCustomDomain: (...args: any[]) => mockAddCustomDomain(...args),
  removeDomain: (...args: any[]) => mockRemoveDomain(...args),
  listDomains: (...args: any[]) => mockListDomains(...args),
  getDomain: (...args: any[]) => mockGetDomain(...args),
  verifyDomain: (...args: any[]) => mockVerifyDomain(...args),
  generateSubdomain: (...args: any[]) => mockGenerateSubdomain(...args),
}));

// Mock subscriptionService for tier-gate tests
const mockUserHasFeature = jest.fn();
jest.mock("../services/subscriptionService", () => ({
  userHasFeature: (...args: any[]) => mockUserHasFeature(...args),
}));

// Mock authorizeLandingPageAccess for landing-page ownership checks
const mockAuthorizeLandingPageAccess = jest.fn();
jest.mock("../routes/landingPageGeneration", () => ({
  authorizeLandingPageAccess: (...args: any[]) => mockAuthorizeLandingPageAccess(...args),
}));

// Mock auth middleware
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "test-user-123" };
    next();
  },
  AuthenticatedRequest: {},
}));

import express from "express";
import request from "supertest";
import domainRoutes from "../routes/domains";

const app = express();
app.use(express.json());
app.use("/api/domains", domainRoutes);

describe("Domain API Routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserHasFeature.mockResolvedValue(true); // default allow — per-test can override
  });

  describe("GET /api/domains", () => {
    it("should return user domains", async () => {
      mockListDomains.mockResolvedValueOnce([
        {
          id: "dom-1",
          userId: "test-user-123",
          domain: "mysite.agentwebforms.com",
          type: "subdomain",
          status: "active",
          vercelProjectId: "proj-1",
        },
      ]);

      const res = await request(app).get("/api/domains");
      expect(res.status).toBe(200);
      expect(res.body.domains).toHaveLength(1);
      expect(res.body.domains[0].domain).toBe("mysite.agentwebforms.com");
    });

    it("should filter by projectId query param", async () => {
      mockListDomains.mockResolvedValueOnce([]);

      await request(app).get("/api/domains?projectId=proj-1");
      expect(mockListDomains).toHaveBeenCalledWith("test-user-123", "proj-1");
    });
  });

  describe("POST /api/domains/subdomain", () => {
    it("should add a subdomain", async () => {
      mockAddSubdomain.mockResolvedValueOnce({
        id: "dom-new",
        domain: "coolsite.agentwebforms.com",
        type: "subdomain",
        status: "active",
      });

      const res = await request(app)
        .post("/api/domains/subdomain")
        .send({ vercelProjectId: "proj-1", subdomain: "coolsite" });

      expect(res.status).toBe(201);
      expect(res.body.domain).toBe("coolsite.agentwebforms.com");
      expect(mockAddSubdomain).toHaveBeenCalledWith("test-user-123", "proj-1", "coolsite");
    });

    it("should return 400 if vercelProjectId missing", async () => {
      const res = await request(app)
        .post("/api/domains/subdomain")
        .send({ subdomain: "coolsite" });

      expect(res.status).toBe(400);
    });

    it("should return 400 if subdomain missing", async () => {
      const res = await request(app)
        .post("/api/domains/subdomain")
        .send({ vercelProjectId: "proj-1" });

      expect(res.status).toBe(400);
    });

    it("FAIL: DB update for customDomainUrl throws → still returns 201 (non-fatal)", async () => {
      mockAddSubdomain.mockResolvedValueOnce({
        id: "dom-new",
        domain: "mysite.agentwebforms.com",
        type: "subdomain",
        status: "active",
      });
      // Make the DynamoDB update fail (simulates ConditionalCheckFailedException)
      mockDynamoInstance.update.mockReturnValueOnce({
        promise: () => Promise.reject(new Error("ConditionalCheckFailedException")),
      });

      const res = await request(app)
        .post("/api/domains/subdomain")
        .send({ vercelProjectId: "proj-1", subdomain: "mysite", landingPageId: "page-123" });

      expect(res.status).toBe(201);
      expect(res.body.domain).toBe("mysite.agentwebforms.com");
    });

    it("SUCCESS: root page (no slug) gets customDomainUrl without path", async () => {
      mockAddSubdomain.mockResolvedValueOnce({
        id: "dom-new",
        domain: "mysite.agentwebforms.com",
        type: "subdomain",
        status: "active",
      });
      // DB get returns root page (no slug)
      mockDynamoInstance.get.mockReturnValueOnce({
        promise: () => Promise.resolve({ Item: { id: "page-root", userId: "test-user-123" } }),
      });

      await request(app)
        .post("/api/domains/subdomain")
        .send({ vercelProjectId: "proj-1", subdomain: "mysite", landingPageId: "page-root" });

      const updateCall = mockDynamoInstance.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[":url"]).toBe("https://mysite.agentwebforms.com");
    });

    it("SUCCESS: sub-page (has slug) gets customDomainUrl with /{slug} path", async () => {
      mockAddSubdomain.mockResolvedValueOnce({
        id: "dom-new",
        domain: "mysite.agentwebforms.com",
        type: "subdomain",
        status: "active",
      });
      // DB get returns sub-page with a slug
      mockDynamoInstance.get.mockReturnValueOnce({
        promise: () => Promise.resolve({ Item: { id: "page-sub", userId: "test-user-123", slug: "pricing-page" } }),
      });

      await request(app)
        .post("/api/domains/subdomain")
        .send({ vercelProjectId: "proj-1", subdomain: "mysite", landingPageId: "page-sub" });

      const updateCall = mockDynamoInstance.update.mock.calls[0][0];
      expect(updateCall.ExpressionAttributeValues[":url"]).toBe("https://mysite.agentwebforms.com/pricing-page");
    });
  });

  describe("POST /api/domains/custom", () => {
    it("should add a custom domain", async () => {
      mockAddCustomDomain.mockResolvedValueOnce({
        id: "dom-new",
        domain: "landing.example.com",
        type: "custom",
        status: "pending_verification",
        verificationRecords: [
          { type: "TXT", domain: "_vercel.landing.example.com", value: "vc-domain-verify=abc" },
        ],
      });

      const res = await request(app)
        .post("/api/domains/custom")
        .send({ vercelProjectId: "proj-1", domain: "landing.example.com" });

      expect(res.status).toBe(201);
      expect(res.body.domain).toBe("landing.example.com");
      expect(res.body.status).toBe("pending_verification");
      expect(res.body.verificationRecords).toBeDefined();
    });

    it("should return 400 if domain missing", async () => {
      const res = await request(app)
        .post("/api/domains/custom")
        .send({ vercelProjectId: "proj-1" });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /api/domains/:id", () => {
    it("should delete a domain", async () => {
      mockRemoveDomain.mockResolvedValueOnce(undefined);

      const res = await request(app).delete("/api/domains/dom-123");
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/deleted|removed/i);
      expect(mockRemoveDomain).toHaveBeenCalledWith("dom-123", "test-user-123");
    });

    it("should return 404 if domain not found", async () => {
      mockRemoveDomain.mockRejectedValueOnce(new Error("Domain not found"));

      const res = await request(app).delete("/api/domains/dom-999");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/domains/:id/verify", () => {
    it("should check domain verification", async () => {
      mockVerifyDomain.mockResolvedValueOnce({
        verified: true,
        status: "active",
      });

      const res = await request(app).post("/api/domains/dom-123/verify");
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(true);
    });

    it("should return pending verification with DNS instructions", async () => {
      mockVerifyDomain.mockResolvedValueOnce({
        verified: false,
        status: "pending_verification",
        verificationRecords: [
          { type: "TXT", domain: "_vercel.example.com", value: "vc-domain-verify=abc" },
        ],
      });

      const res = await request(app).post("/api/domains/dom-123/verify");
      expect(res.status).toBe(200);
      expect(res.body.verified).toBe(false);
      expect(res.body.verificationRecords).toBeDefined();
    });
  });

  describe("GET /api/domains/:id", () => {
    it("should return a single domain", async () => {
      mockGetDomain.mockResolvedValueOnce({
        id: "dom-1",
        domain: "mysite.agentwebforms.com",
        type: "subdomain",
        status: "active",
      });

      const res = await request(app).get("/api/domains/dom-1");
      expect(res.status).toBe(200);
      expect(res.body.domain).toBe("mysite.agentwebforms.com");
    });

    it("should return 404 if not found", async () => {
      mockGetDomain.mockResolvedValueOnce(null);

      const res = await request(app).get("/api/domains/dom-999");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/domains/custom — tier gate", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("returns 403 when user lacks custom-domain feature", async () => {
      mockUserHasFeature.mockResolvedValueOnce(false);

      const res = await request(app)
        .post("/api/domains/custom")
        .send({ vercelProjectId: "prj_123", domain: "landing.example.com" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/higher-tier/i);
      expect(mockAddCustomDomain).not.toHaveBeenCalled();
    });

    it("proceeds when user has custom-domain feature", async () => {
      mockUserHasFeature.mockResolvedValueOnce(true);
      mockAddCustomDomain.mockResolvedValueOnce({
        id: "dom-1",
        userId: "test-user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "pending_verification",
        vercelProjectId: "prj_123",
        verificationRecords: [],
        createdAt: "now",
        updatedAt: "now",
      });

      const res = await request(app)
        .post("/api/domains/custom")
        .send({ vercelProjectId: "prj_123", domain: "landing.example.com" });

      expect(res.status).toBe(201);
      expect(mockAddCustomDomain).toHaveBeenCalledWith("test-user-123", "prj_123", "landing.example.com", undefined);
    });
  });

  describe("POST /api/domains/custom — landingPageId ownership", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockUserHasFeature.mockResolvedValue(true);
    });

    it("returns 403 when caller does not own the landing page", async () => {
      mockAuthorizeLandingPageAccess.mockResolvedValueOnce({
        ok: false,
        status: 403,
        error: "Not authorized to edit this landing page",
      });

      const res = await request(app)
        .post("/api/domains/custom")
        .send({ vercelProjectId: "prj_123", domain: "landing.example.com", landingPageId: "lp-other" });

      expect(res.status).toBe(403);
      expect(mockAddCustomDomain).not.toHaveBeenCalled();
    });

    it("passes landingPageId to addCustomDomain when ownership check passes", async () => {
      mockAuthorizeLandingPageAccess.mockResolvedValueOnce({
        ok: true,
        page: { id: "lp-42", userId: "test-user-123", slug: null },
      });
      mockAddCustomDomain.mockResolvedValueOnce({
        id: "dom-1",
        userId: "test-user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "pending_verification",
        vercelProjectId: "prj_123",
        landingPageId: "lp-42",
        createdAt: "now",
        updatedAt: "now",
      });

      const res = await request(app)
        .post("/api/domains/custom")
        .send({ vercelProjectId: "prj_123", domain: "landing.example.com", landingPageId: "lp-42" });

      expect(res.status).toBe(201);
      expect(mockAddCustomDomain).toHaveBeenCalledWith("test-user-123", "prj_123", "landing.example.com", "lp-42");
    });
  });
});
