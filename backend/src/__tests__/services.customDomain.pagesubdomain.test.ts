// Shared DynamoDB instance — returned by every DocumentClient construction so
// all service modules share the same mock regardless of import order.
const mockDynamoInstance = {
  put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({}) }),
  update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  query: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
};

const mockS3Instance = {
  upload: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Location: "https://s3.example.com/file" }) }),
  getObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Body: Buffer.from("") }) }),
};
const MockS3 = jest.fn().mockImplementation(() => mockS3Instance);

jest.mock("aws-sdk", () => ({
  __esModule: true,
  S3: MockS3,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => mockDynamoInstance),
    },
    S3: MockS3,
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ SecretString: '{"token":"test","org":"AgentWebPro"}' }) }),
    })),
    config: { update: jest.fn() },
  },
}));

jest.mock("../utils/secretsManager", () => ({
  getVercelToken: jest.fn().mockResolvedValue("test-vercel-token"),
  getGitHubOrgToken: jest.fn().mockResolvedValue({ token: "gh-token", org: "AgentWebPro" }),
}));

const mockAxiosPost = jest.fn();
const mockAxiosDelete = jest.fn();
const mockAxiosGet = jest.fn();
const mockAxiosPatch = jest.fn();
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: (...args: any[]) => mockAxiosPost(...args),
    delete: (...args: any[]) => mockAxiosDelete(...args),
    get: (...args: any[]) => mockAxiosGet(...args),
    patch: (...args: any[]) => mockAxiosPatch(...args),
  },
}));

import {
  getProjectDomain,
  setPageSubdomain,
  removePageSubdomainFromVercel,
} from "../services/customDomainService";
import { updateSubdomainMiddleware } from "../services/v0Service";

describe("getProjectDomain", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the active custom domain for a project", async () => {
    mockDynamoInstance.query.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Items: [
            {
              id: "d1",
              type: "custom",
              status: "active",
              domain: "mysite.com",
              vercelProjectId: "proj-1",
              userId: "user-1",
            },
          ],
        }),
    });
    const result = await getProjectDomain("user-1", "proj-1");
    expect(result?.domain).toBe("mysite.com");
  });

  it("returns null when no active custom domain exists", async () => {
    mockDynamoInstance.query.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [] }),
    });
    const result = await getProjectDomain("user-1", "proj-1");
    expect(result).toBeNull();
  });

  it("ignores pending_verification domains", async () => {
    mockDynamoInstance.query.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Items: [
            {
              id: "d2",
              type: "custom",
              status: "pending_verification",
              domain: "mysite.com",
              vercelProjectId: "proj-1",
              userId: "user-1",
            },
          ],
        }),
    });
    const result = await getProjectDomain("user-1", "proj-1");
    expect(result).toBeNull();
  });
});

describe("setPageSubdomain", () => {
  beforeEach(() => jest.clearAllMocks());

  it("adds subdomain to Vercel and returns the full domain", async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: {} });
    const result = await setPageSubdomain("user-1", "proj-1", "pricing", "mysite.com");
    expect(result.fullDomain).toBe("pricing.mysite.com");
    expect(mockAxiosPost).toHaveBeenCalledWith(
      expect.stringContaining("/v10/projects/proj-1/domains"),
      { name: "pricing.mysite.com" },
      expect.objectContaining({ headers: expect.any(Object) })
    );
  });

  it("rejects an invalid subdomain prefix", async () => {
    await expect(
      setPageSubdomain("user-1", "proj-1", "Invalid Prefix!", "mysite.com")
    ).rejects.toThrow("Invalid subdomain");
  });

  it("treats Vercel 409 conflict as success", async () => {
    const conflictErr = { response: { status: 409 } };
    mockAxiosPost.mockRejectedValueOnce(conflictErr);
    const result = await setPageSubdomain("user-1", "proj-1", "pricing", "mysite.com");
    expect(result.fullDomain).toBe("pricing.mysite.com");
  });

  it("propagates non-409 Vercel errors", async () => {
    const serverErr = { response: { status: 500 }, message: "Server error" };
    mockAxiosPost.mockRejectedValueOnce(serverErr);
    await expect(
      setPageSubdomain("user-1", "proj-1", "pricing", "mysite.com")
    ).rejects.toMatchObject({ response: { status: 500 } });
  });
});

describe("removePageSubdomainFromVercel", () => {
  beforeEach(() => jest.clearAllMocks());

  it("deletes the domain from Vercel", async () => {
    mockAxiosDelete.mockResolvedValueOnce({ data: {} });
    await removePageSubdomainFromVercel("proj-1", "pricing.mysite.com");
    expect(mockAxiosDelete).toHaveBeenCalledWith(
      expect.stringContaining("/v9/projects/proj-1/domains/pricing.mysite.com"),
      expect.any(Object)
    );
  });

  it("ignores Vercel 404 (already removed)", async () => {
    mockAxiosDelete.mockRejectedValueOnce({ response: { status: 404 } });
    await expect(
      removePageSubdomainFromVercel("proj-1", "pricing.mysite.com")
    ).resolves.not.toThrow();
  });
});

describe("updateSubdomainMiddleware", () => {
  const REPO = "AgentWebPro/lp-test-abc123";
  const DOMAIN_MAP = { "pricing.mysite.com": "/pricing" };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosGet.mockResolvedValue({ data: { object: { sha: "base-sha-111" } } });
    mockAxiosPost
      .mockResolvedValueOnce({ data: { sha: "blob-domainmap-sha" } })
      .mockResolvedValueOnce({ data: { sha: "blob-middleware-sha" } })
      .mockResolvedValueOnce({ data: { sha: "tree-sha-222" } })
      .mockResolvedValueOnce({ data: { sha: "commit-sha-333" } });
    mockAxiosPatch.mockResolvedValue({ data: {} });
  });

  it("commits domainMap.ts and middleware.ts to the repo", async () => {
    await updateSubdomainMiddleware(REPO, DOMAIN_MAP);

    expect(mockAxiosGet).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/git/ref/heads/main`,
      expect.any(Object)
    );
    expect(mockAxiosPost).toHaveBeenCalledTimes(4);
    expect(mockAxiosPatch).toHaveBeenCalledWith(
      `https://api.github.com/repos/${REPO}/git/refs/heads/main`,
      { sha: "commit-sha-333" },
      expect.any(Object)
    );
  });

  it("includes both middleware.ts and domainMap.ts in the tree", async () => {
    await updateSubdomainMiddleware(REPO, DOMAIN_MAP);

    const treeCall = mockAxiosPost.mock.calls.find((call) =>
      call[0].includes("/git/trees")
    );
    expect(treeCall).toBeDefined();
    const paths = treeCall![1].tree.map((item: any) => item.path);
    expect(paths).toContain("domainMap.ts");
    expect(paths).toContain("middleware.ts");
  });

  it("embeds all domain entries in the domainMap blob", async () => {
    await updateSubdomainMiddleware(REPO, {
      "pricing.mysite.com": "/pricing",
      "contact.mysite.com": "/contact-us",
    });

    const blobCall = mockAxiosPost.mock.calls[0];
    const content = Buffer.from(blobCall[1].content, "base64").toString("utf-8");
    expect(content).toContain('"pricing.mysite.com"');
    expect(content).toContain('"/pricing"');
    expect(content).toContain('"contact.mysite.com"');
  });
});
