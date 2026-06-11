// Mock aws-sdk before any imports
const mockPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockGet = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockDelete = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });
const mockScan = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });

jest.mock("aws-sdk", () => {
  return {
    __esModule: true,
    default: {
      DynamoDB: {
        DocumentClient: jest.fn(() => ({
          put: mockPut,
          get: mockGet,
          update: mockUpdate,
          delete: mockDelete,
          query: mockQuery,
          scan: mockScan,
        })),
      },
      SecretsManager: jest.fn(() => ({
        getSecretValue: jest.fn().mockReturnValue({
          promise: () => Promise.resolve({ SecretString: '{"token":"test-vercel-token"}' }),
        }),
      })),
    },
  };
});

// Mock axios for Vercel API calls
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosDelete = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => mockAxiosPost(...args),
    get: (...args: any[]) => mockAxiosGet(...args),
    delete: (...args: any[]) => mockAxiosDelete(...args),
  },
}));

// Mock secretsManager
jest.mock("../utils/secretsManager", () => ({
  getVercelToken: jest.fn().mockResolvedValue("test-vercel-token"),
}));

import {
  addSubdomain,
  addCustomDomain,
  removeDomain,
  listDomains,
  getDomain,
  verifyDomain,
  generateSubdomain,
  CustomDomainRecord,
} from "../services/customDomainService";

describe("customDomainService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("generateSubdomain", () => {
    it("should generate a valid subdomain from brand name", () => {
      const result = generateSubdomain("My Cool Brand");
      expect(result).toBe("my-cool-brand");
    });

    it("should strip special characters", () => {
      const result = generateSubdomain("Brand! @#$% Name");
      expect(result).toBe("brand-name");
    });

    it("should handle empty input with fallback", () => {
      const result = generateSubdomain("");
      expect(result).toMatch(/^page-/);
    });

    it("should truncate long names", () => {
      const longName = "a".repeat(100);
      const result = generateSubdomain(longName);
      expect(result.length).toBeLessThanOrEqual(63);
    });
  });

  describe("addSubdomain", () => {
    it("should create a subdomain record and add domain to Vercel", async () => {
      mockAxiosPost.mockResolvedValueOnce({ data: { domain: "mysite.agentwebforms.com" } });

      const result = await addSubdomain("user-123", "vercel-proj-id", "mysite");

      expect(result).toMatchObject({
        userId: "user-123",
        domain: "mysite.agentwebforms.com",
        type: "subdomain",
        status: "active",
        vercelProjectId: "vercel-proj-id",
      });
      expect(result.id).toBeDefined();

      // Should have called Vercel API
      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining("vercel.com"),
        expect.objectContaining({ name: "mysite.agentwebforms.com" }),
        expect.any(Object)
      );

      // Should have saved to DynamoDB
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining("AW-CustomDomains"),
          Item: expect.objectContaining({
            userId: "user-123",
            domain: "mysite.agentwebforms.com",
            type: "subdomain",
          }),
        })
      );
    });

    it("should reject invalid subdomain characters", async () => {
      await expect(addSubdomain("user-123", "proj-id", "my site!")).rejects.toThrow(
        /invalid subdomain/i
      );
    });

    it("should reject subdomains that are too long", async () => {
      const longSubdomain = "a".repeat(64);
      await expect(addSubdomain("user-123", "proj-id", longSubdomain)).rejects.toThrow();
    });
  });

  describe("addCustomDomain", () => {
    it("should create a custom domain record with pending_verification status", async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: {
          name: "landing.example.com",
          verified: false,
          verification: [{ type: "TXT", domain: "_vercel.landing.example.com", value: "vc-domain-verify=abc123" }],
        },
      });

      const result = await addCustomDomain("user-123", "vercel-proj-id", "landing.example.com");

      expect(result).toMatchObject({
        userId: "user-123",
        domain: "landing.example.com",
        type: "custom",
        status: "pending_verification",
        vercelProjectId: "vercel-proj-id",
      });
      expect(result.verificationRecords).toBeDefined();
      expect(result.verificationRecords!.length).toBeGreaterThan(0);
    });

    it("should stay pending_verification when Vercel reports ownership-verified but DNS is still misconfigured", async () => {
      // Vercel returns verified:true on add based on ownership alone, before the
      // customer has pointed any DNS records at Vercel.
      mockAxiosPost.mockResolvedValueOnce({
        data: { name: "landing.example.com", verified: true },
      });
      // The config endpoint reports misconfigured: true (DNS not yet pointed).
      mockAxiosGet.mockResolvedValueOnce({
        data: { misconfigured: true },
      });

      const result = await addCustomDomain("user-123", "proj-id", "landing.example.com");
      expect(result.status).toBe("pending_verification");
      // Config endpoint must have been consulted.
      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining("/v6/domains/landing.example.com/config"),
        expect.any(Object)
      );
    });

    it("should mark as active only when verified AND DNS is correctly configured", async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: { name: "landing.example.com", verified: true },
      });
      mockAxiosGet.mockResolvedValueOnce({
        data: { misconfigured: false },
      });

      const result = await addCustomDomain("user-123", "proj-id", "landing.example.com");
      expect(result.status).toBe("active");
      expect(result.verificationRecords).toBeUndefined();
    });

    it("should stay pending_verification (not crash) when the config check fails", async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: { name: "landing.example.com", verified: true },
      });
      mockAxiosGet.mockRejectedValueOnce(new Error("network error"));

      const result = await addCustomDomain("user-123", "proj-id", "landing.example.com");
      expect(result.status).toBe("pending_verification");
    });

    it("should reject invalid domain formats", async () => {
      await expect(addCustomDomain("user-123", "proj-id", "not a domain")).rejects.toThrow(
        /invalid domain/i
      );
    });

    it("should treat a 409 (domain already on THIS project) as success", async () => {
      // Vercel rejects the add because the domain already exists...
      mockAxiosPost.mockRejectedValueOnce({ response: { status: 409 } });
      // ...but a GET confirms it's on this project (pending DNS).
      mockAxiosGet.mockResolvedValueOnce({
        data: {
          name: "landing.example.com",
          verified: false,
          verification: [{ type: "TXT", domain: "_vercel.landing.example.com", value: "vc=abc" }],
        },
      });

      const result = await addCustomDomain("user-123", "proj-id", "landing.example.com");
      expect(result.status).toBe("pending_verification");
      expect(result.verificationRecords!.length).toBeGreaterThan(0);
      // Confirmed via the project-scoped domain GET.
      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining("/projects/proj-id/domains/landing.example.com"),
        expect.any(Object)
      );
    });

    it("should reuse the existing DynamoDB record id on a re-add (no duplicate)", async () => {
      mockAxiosPost.mockRejectedValueOnce({ response: { status: 409 } });
      mockAxiosGet.mockResolvedValueOnce({
        data: { name: "landing.example.com", verified: false, verification: [] },
      });
      // An existing record for this user+domain is already stored.
      mockQuery.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Items: [
              {
                id: "existing-dom-id",
                userId: "user-123",
                domain: "landing.example.com",
                type: "custom",
                status: "pending_verification",
                vercelProjectId: "proj-id",
                createdAt: "2024-01-01T00:00:00.000Z",
                updatedAt: "2024-01-01T00:00:00.000Z",
              },
            ],
          }),
      });

      const result = await addCustomDomain("user-123", "proj-id", "landing.example.com");
      expect(result.id).toBe("existing-dom-id");
      expect(result.createdAt).toBe("2024-01-01T00:00:00.000Z");
    });

    it("should propagate the original 409 when the domain is on a DIFFERENT project", async () => {
      mockAxiosPost.mockRejectedValueOnce({ response: { status: 409 } });
      // GET fails (domain not on this project) — the original 409 must surface
      // so the route returns "already in use on another project".
      mockAxiosGet.mockRejectedValueOnce({ response: { status: 404 } });

      await expect(
        addCustomDomain("user-123", "proj-id", "landing.example.com")
      ).rejects.toMatchObject({ response: { status: 409 } });
    });
  });

  describe("removeDomain", () => {
    it("should remove domain from Vercel and delete DynamoDB record", async () => {
      mockGet.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "dom-123",
              userId: "user-123",
              domain: "mysite.agentwebforms.com",
              vercelProjectId: "proj-id",
              type: "subdomain",
              status: "active",
            },
          }),
      });
      mockAxiosDelete.mockResolvedValueOnce({ data: {} });

      await removeDomain("dom-123", "user-123");

      // Should call Vercel delete
      expect(mockAxiosDelete).toHaveBeenCalledWith(
        expect.stringContaining("vercel.com"),
        expect.any(Object)
      );

      // Should delete from DynamoDB
      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining("AW-CustomDomains"),
          Key: { id: "dom-123" },
        })
      );
    });

    it("should throw if domain not found", async () => {
      mockGet.mockReturnValueOnce({
        promise: () => Promise.resolve({ Item: undefined }),
      });

      await expect(removeDomain("dom-999", "user-123")).rejects.toThrow(/not found/i);
    });

    it("should throw if user doesn't own the domain", async () => {
      mockGet.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "dom-123",
              userId: "other-user",
              domain: "test.agentwebforms.com",
              vercelProjectId: "proj-id",
              type: "subdomain",
              status: "active",
            },
          }),
      });

      await expect(removeDomain("dom-123", "user-123")).rejects.toThrow(/not found|unauthorized/i);
    });
  });

  describe("listDomains", () => {
    it("should return domains for a user", async () => {
      const mockDomains: CustomDomainRecord[] = [
        {
          id: "dom-1",
          userId: "user-123",
          domain: "mysite.agentwebforms.com",
          type: "subdomain",
          status: "active",
          vercelProjectId: "proj-1",
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
        {
          id: "dom-2",
          userId: "user-123",
          domain: "landing.example.com",
          type: "custom",
          status: "pending_verification",
          vercelProjectId: "proj-1",
          createdAt: "2024-01-02",
          updatedAt: "2024-01-02",
        },
      ];
      mockQuery.mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: mockDomains }),
      });

      const result = await listDomains("user-123");
      expect(result).toHaveLength(2);
      expect(result[0].domain).toBe("mysite.agentwebforms.com");
    });

    it("should filter by vercelProjectId if provided", async () => {
      mockQuery.mockReturnValueOnce({
        promise: () => Promise.resolve({ Items: [] }),
      });

      await listDomains("user-123", "proj-specific");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          ExpressionAttributeValues: expect.objectContaining({
            ":userId": "user-123",
            ":projectId": "proj-specific",
          }),
        })
      );
    });
  });

  describe("getDomain", () => {
    it("should return a domain by id", async () => {
      mockGet.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "dom-1",
              userId: "user-123",
              domain: "mysite.agentwebforms.com",
              type: "subdomain",
              status: "active",
              vercelProjectId: "proj-1",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          }),
      });

      const result = await getDomain("dom-1", "user-123");
      expect(result).toBeDefined();
      expect(result!.domain).toBe("mysite.agentwebforms.com");
    });

    it("should return null if not found or wrong user", async () => {
      mockGet.mockReturnValueOnce({
        promise: () => Promise.resolve({ Item: undefined }),
      });

      const result = await getDomain("dom-999", "user-123");
      expect(result).toBeNull();
    });
  });

  describe("verifyDomain", () => {
    it("should check Vercel verification status and update record", async () => {
      mockGet.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "dom-1",
              userId: "user-123",
              domain: "landing.example.com",
              type: "custom",
              status: "pending_verification",
              vercelProjectId: "proj-1",
              createdAt: "2024-01-01",
              updatedAt: "2024-01-01",
            },
          }),
      });

      // First GET: domain status (verified). Second GET: config (not misconfigured).
      mockAxiosGet
        .mockResolvedValueOnce({ data: { name: "landing.example.com", verified: true } })
        .mockResolvedValueOnce({ data: { misconfigured: false } });

      const result = await verifyDomain("dom-1", "user-123");
      expect(result.verified).toBe(true);
      expect(result.status).toBe("active");

      // Should update DynamoDB
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          TableName: expect.stringContaining("AW-CustomDomains"),
          Key: { id: "dom-1" },
        })
      );
    });

    it("should NOT mark active when ownership-verified but DNS still misconfigured", async () => {
      mockGet.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "dom-1",
              userId: "user-123",
              domain: "landing.example.com",
              type: "custom",
              status: "pending_verification",
              vercelProjectId: "proj-1",
            },
          }),
      });

      mockAxiosGet
        .mockResolvedValueOnce({ data: { name: "landing.example.com", verified: true } })
        .mockResolvedValueOnce({ data: { misconfigured: true } });

      const result = await verifyDomain("dom-1", "user-123");
      expect(result.verified).toBe(false);
      expect(result.status).toBe("pending_verification");
      // Must not have flipped the record to active.
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("should return not verified when DNS is not configured", async () => {
      mockGet.mockReturnValueOnce({
        promise: () =>
          Promise.resolve({
            Item: {
              id: "dom-1",
              userId: "user-123",
              domain: "landing.example.com",
              type: "custom",
              status: "pending_verification",
              vercelProjectId: "proj-1",
            },
          }),
      });

      mockAxiosGet.mockResolvedValueOnce({
        data: {
          name: "landing.example.com",
          verified: false,
          verification: [{ type: "TXT", domain: "_vercel.landing.example.com", value: "vc-domain-verify=abc" }],
        },
      });

      const result = await verifyDomain("dom-1", "user-123");
      expect(result.verified).toBe(false);
      expect(result.status).toBe("pending_verification");
    });
  });
});
