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
const mockGetProjectDomain = jest.fn();
const mockSetPageSubdomain = jest.fn();
const mockRemovePageSubdomainFromVercel = jest.fn();

jest.mock("../services/customDomainService", () => ({
  addSubdomain: (...args: any[]) => mockAddSubdomain(...args),
  addCustomDomain: (...args: any[]) => mockAddCustomDomain(...args),
  removeDomain: (...args: any[]) => mockRemoveDomain(...args),
  listDomains: (...args: any[]) => mockListDomains(...args),
  getDomain: (...args: any[]) => mockGetDomain(...args),
  verifyDomain: (...args: any[]) => mockVerifyDomain(...args),
  generateSubdomain: (...args: any[]) => mockGenerateSubdomain(...args),
  getProjectDomain: (...args: any[]) => mockGetProjectDomain(...args),
  setPageSubdomain: (...args: any[]) => mockSetPageSubdomain(...args),
  removePageSubdomainFromVercel: (...args: any[]) => mockRemovePageSubdomainFromVercel(...args),
}));

// Mock v0Service for updateSubdomainMiddleware
const mockUpdateSubdomainMiddleware = jest.fn();
jest.mock("../services/v0Service", () => ({
  updateSubdomainMiddleware: (...args: any[]) => mockUpdateSubdomainMiddleware(...args),
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

  describe("GET /api/domains/project-domain", () => {
    it("returns the active project domain", async () => {
      mockGetProjectDomain.mockResolvedValueOnce({
        domain: "mysite.com",
        status: "active",
      });

      const res = await request(app).get("/api/domains/project-domain?vercelProjectId=proj-1");
      expect(res.status).toBe(200);
      expect(res.body.domain).toBe("mysite.com");
      expect(mockGetProjectDomain).toHaveBeenCalledWith("test-user-123", "proj-1");
    });

    it("returns null when no active project domain", async () => {
      mockGetProjectDomain.mockResolvedValueOnce(null);

      const res = await request(app).get("/api/domains/project-domain?vercelProjectId=proj-1");
      expect(res.status).toBe(200);
      expect(res.body.domain).toBeNull();
    });

    it("returns 400 if vercelProjectId is missing", async () => {
      const res = await request(app).get("/api/domains/project-domain");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/domains/page-subdomain", () => {
    const VALID_BODY = {
      vercelProjectId: "proj-1",
      landingPageId: "lp-1",
      subdomainPrefix: "pricing",
      mainDomain: "mysite.com",
    };

    beforeEach(() => {
      mockSetPageSubdomain.mockResolvedValue({ fullDomain: "pricing.mysite.com" });
      mockUpdateSubdomainMiddleware.mockResolvedValue(undefined);
      mockDynamoInstance.query.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });
      mockDynamoInstance.get.mockReturnValue({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "lp-1",
              userId: "test-user-123",
              slug: "pricing",
              githubRepoUrl: "https://github.com/AgentWebPro/lp-test-abc",
              vercelProjectId: "proj-1",
            },
          }),
      });
      mockDynamoInstance.update.mockReturnValue({ promise: () => Promise.resolve() });
    });

    it("returns 201 with fullDomain and customDomainUrl on success", async () => {
      const res = await request(app)
        .post("/api/domains/page-subdomain")
        .send(VALID_BODY);

      expect(res.status).toBe(201);
      expect(res.body.fullDomain).toBe("pricing.mysite.com");
      expect(res.body.customDomainUrl).toBe("https://pricing.mysite.com/pricing");
    });

    it("calls setPageSubdomain with correct args", async () => {
      await request(app).post("/api/domains/page-subdomain").send(VALID_BODY);
      expect(mockSetPageSubdomain).toHaveBeenCalledWith(
        "test-user-123",
        "proj-1",
        "pricing",
        "mysite.com"
      );
    });

    it("calls updateSubdomainMiddleware with built domain map", async () => {
      await request(app).post("/api/domains/page-subdomain").send(VALID_BODY);
      expect(mockUpdateSubdomainMiddleware).toHaveBeenCalledWith(
        "AgentWebPro/lp-test-abc",
        { "pricing.mysite.com": "/pricing" }
      );
    });

    it("returns 400 if subdomainPrefix missing", async () => {
      const res = await request(app)
        .post("/api/domains/page-subdomain")
        .send({ ...VALID_BODY, subdomainPrefix: undefined });
      expect(res.status).toBe(400);
    });

    it("returns 400 if mainDomain missing", async () => {
      const res = await request(app)
        .post("/api/domains/page-subdomain")
        .send({ ...VALID_BODY, mainDomain: undefined });
      expect(res.status).toBe(400);
    });

    it("returns 404 if landing page not found", async () => {
      mockDynamoInstance.get.mockReturnValueOnce({
        promise: () => Promise.resolve({ Item: undefined }),
      });
      const res = await request(app)
        .post("/api/domains/page-subdomain")
        .send(VALID_BODY);
      expect(res.status).toBe(404);
    });

    it("root page (no slug) gets customDomainUrl without path suffix", async () => {
      mockDynamoInstance.get.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "lp-1",
              userId: "test-user-123",
              githubRepoUrl: "https://github.com/AgentWebPro/lp-test-abc",
              vercelProjectId: "proj-1",
              // no slug
            },
          }),
      });
      const res = await request(app)
        .post("/api/domains/page-subdomain")
        .send(VALID_BODY);
      expect(res.status).toBe(201);
      expect(res.body.customDomainUrl).toBe("https://pricing.mysite.com");
    });
  });

  describe("DELETE /api/domains/page-subdomain/:landingPageId", () => {
    beforeEach(() => {
      mockRemovePageSubdomainFromVercel.mockResolvedValue(undefined);
      mockUpdateSubdomainMiddleware.mockResolvedValue(undefined);
      mockDynamoInstance.get.mockReturnValue({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "lp-1",
              userId: "test-user-123",
              slug: "pricing",
              subdomainPrefix: "pricing",
              githubRepoUrl: "https://github.com/AgentWebPro/lp-test-abc",
              vercelProjectId: "proj-1",
            },
          }),
      });
      mockDynamoInstance.query.mockReturnValue({
        promise: () => Promise.resolve({ Items: [] }),
      });
      mockDynamoInstance.update.mockReturnValue({ promise: () => Promise.resolve() });
    });

    it("removes the subdomain and returns 200", async () => {
      const res = await request(app)
        .delete("/api/domains/page-subdomain/lp-1")
        .send({ mainDomain: "mysite.com" });

      expect(res.status).toBe(200);
      expect(mockRemovePageSubdomainFromVercel).toHaveBeenCalledWith(
        "proj-1",
        "pricing.mysite.com"
      );
    });

    it("returns 400 if mainDomain is missing", async () => {
      const res = await request(app)
        .delete("/api/domains/page-subdomain/lp-1")
        .send({});
      expect(res.status).toBe(400);
    });

    it("returns 404 if landing page not found", async () => {
      mockDynamoInstance.get.mockReturnValueOnce({
        promise: () => Promise.resolve({ Item: undefined }),
      });
      const res = await request(app)
        .delete("/api/domains/page-subdomain/lp-99")
        .send({ mainDomain: "mysite.com" });
      expect(res.status).toBe(404);
    });

    it("returns 400 if page has no subdomainPrefix set", async () => {
      mockDynamoInstance.get.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "lp-1",
              userId: "test-user-123",
              vercelProjectId: "proj-1",
              // no subdomainPrefix
            },
          }),
      });
      const res = await request(app)
        .delete("/api/domains/page-subdomain/lp-1")
        .send({ mainDomain: "mysite.com" });
      expect(res.status).toBe(400);
    });
  });
});
