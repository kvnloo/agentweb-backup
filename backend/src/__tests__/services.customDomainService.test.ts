// Mock aws-sdk before any imports
const mockPut = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockGet = jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) });
const mockUpdate = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockDelete = jest.fn().mockReturnValue({ promise: () => Promise.resolve() });
const mockQuery = jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });

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

    it("stores landingPageId on the domain record when provided", async () => {
      mockAxiosPost.mockResolvedValueOnce({ data: { domain: "mysite.agentwebforms.com" } });

      const result = await addSubdomain("user-123", "vercel-proj-id", "mysite", "lp-42");

      expect(result.landingPageId).toBe("lp-42");
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({ landingPageId: "lp-42" }),
        })
      );
    });

    it("does not set landingPageId when not provided", async () => {
      mockAxiosPost.mockResolvedValueOnce({ data: { domain: "mysite.agentwebforms.com" } });

      const result = await addSubdomain("user-123", "vercel-proj-id", "mysite");

      expect(result.landingPageId).toBeUndefined();
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

    it("should mark as active if Vercel says already verified", async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: { name: "landing.example.com", verified: true },
      });

      const result = await addCustomDomain("user-123", "proj-id", "landing.example.com");
      expect(result.status).toBe("active");
    });

    it("should reject invalid domain formats", async () => {
      await expect(addCustomDomain("user-123", "proj-id", "not a domain")).rejects.toThrow(
        /invalid domain/i
      );
    });

    it("throws with 'already in use' message when Vercel returns 409", async () => {
      const conflictError = new Error("Request failed with status code 409");
      (conflictError as any).response = { status: 409 };
      mockAxiosPost.mockRejectedValueOnce(conflictError);

      await expect(addCustomDomain("user-123", "proj-id", "taken.example.com")).rejects.toThrow(
        /already in use/i
      );
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

    it("throws and does not delete DynamoDB record when Vercel returns a non-404 error", async () => {
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
      const vercelError = new Error("Request failed with status code 403");
      (vercelError as any).response = { status: 403 };
      mockAxiosDelete.mockRejectedValueOnce(vercelError);

      await expect(removeDomain("dom-123", "user-123")).rejects.toThrow(/vercel/i);
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it("still removes DynamoDB record when Vercel returns 404 (already gone)", async () => {
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
      const notFound = new Error("Not Found");
      (notFound as any).response = { status: 404 };
      mockAxiosDelete.mockRejectedValueOnce(notFound);

      await removeDomain("dom-123", "user-123");

      expect(mockDelete).toHaveBeenCalledWith(
        expect.objectContaining({ Key: { id: "dom-123" } })
      );
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

      mockAxiosGet.mockResolvedValueOnce({
        data: { name: "landing.example.com", verified: true },
      });

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

  describe('addCustomDomain with landingPageId', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('stores landingPageId on the record when provided', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: { verified: false, verification: [{ type: 'TXT', domain: '_vercel.example.com', value: 'vc-domain-verify=abc' }] },
      });

      const result = await addCustomDomain('user-1', 'prj_123', 'landing.example.com', 'lp-42');

      expect(result.landingPageId).toBe('lp-42');
      expect(mockPut).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({ landingPageId: 'lp-42' }),
        })
      );
    });

    it('omits landingPageId when not provided', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: { verified: false, verification: [] },
      });

      const result = await addCustomDomain('user-1', 'prj_123', 'landing.example.com');

      expect(result.landingPageId).toBeUndefined();
    });
  });

  describe('verifyDomain returns updated record', () => {
    it('returns the updated record with landingPageId on successful verification', async () => {
      mockGet.mockReturnValueOnce({
        promise: () => Promise.resolve({
          Item: {
            id: 'dom-1',
            userId: 'user-1',
            domain: 'landing.example.com',
            type: 'custom',
            status: 'pending_verification',
            vercelProjectId: 'prj_123',
            landingPageId: 'lp-42',
            verificationRecords: [{ type: 'TXT', domain: '_vercel.landing.example.com', value: 'vc-domain-verify=abc' }],
            createdAt: '2026-05-25T00:00:00Z',
            updatedAt: '2026-05-25T00:00:00Z',
          },
        }),
      });

      mockAxiosGet.mockResolvedValueOnce({ data: { verified: true } });

      const result = await verifyDomain('dom-1', 'user-1');

      expect(result.verified).toBe(true);
      expect(result.record).toMatchObject({
        id: 'dom-1',
        landingPageId: 'lp-42',
        domain: 'landing.example.com',
        status: 'active',
      });
    });

    it('returns the record even when domain was already active (idempotent rerun)', async () => {
      mockGet.mockReturnValueOnce({
        promise: () => Promise.resolve({
          Item: {
            id: 'dom-1',
            userId: 'user-1',
            domain: 'landing.example.com',
            type: 'custom',
            status: 'active',
            vercelProjectId: 'prj_123',
            landingPageId: 'lp-42',
            createdAt: '2026-05-25T00:00:00Z',
            updatedAt: '2026-05-25T00:00:00Z',
          },
        }),
      });

      mockAxiosGet.mockResolvedValueOnce({ data: { verified: true } });

      const result = await verifyDomain('dom-1', 'user-1');

      expect(result.verified).toBe(true);
      expect(result.record.status).toBe('active');
      expect(result.record.verificationRecords).toBeUndefined();
    });
  });
});
