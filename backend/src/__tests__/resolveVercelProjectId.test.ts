// Mock aws-sdk before any imports
const mockUpdate = jest
  .fn()
  .mockReturnValue({ promise: () => Promise.resolve() });
const mockQuery = jest
  .fn()
  .mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => ({
        put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
        update: mockUpdate,
        get: jest
          .fn()
          .mockReturnValue({ promise: () => Promise.resolve({ Item: null }) }),
        query: mockQuery,
        delete: jest
          .fn()
          .mockReturnValue({ promise: () => Promise.resolve() }),
      })),
    },
    SecretsManager: jest.fn().mockImplementation(() => ({
      getSecretValue: jest.fn().mockReturnValue({
        promise: () =>
          Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
      }),
    })),
    S3: jest.fn().mockImplementation(() => ({ putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }) })),
    config: { update: jest.fn() },
  },
  DynamoDB: {
    DocumentClient: jest.fn().mockImplementation(() => ({
      put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
      update: mockUpdate,
      get: jest
        .fn()
        .mockReturnValue({ promise: () => Promise.resolve({ Item: null }) }),
      query: mockQuery,
      delete: jest
        .fn()
        .mockReturnValue({ promise: () => Promise.resolve() }),
    })),
  },
  SecretsManager: jest.fn().mockImplementation(() => ({
    getSecretValue: jest.fn().mockReturnValue({
      promise: () =>
        Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
    }),
  })),
  S3: jest.fn().mockImplementation(() => ({ putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }) })),
  config: { update: jest.fn() },
}));

// Mock secretsManager
jest.mock("../utils/secretsManager", () => ({
  getV0ApiKey: jest.fn().mockResolvedValue("test-v0-api-key"),
  getGitHubOrgToken: jest
    .fn()
    .mockResolvedValue({ token: "test-gh-token", org: "TestOrg" }),
  getVercelToken: jest.fn().mockResolvedValue("test-vercel-token"),
  getSecret: jest.fn().mockResolvedValue('{"apiKey":"test-key"}'),
  secretExists: jest.fn().mockResolvedValue(true),
}));

// Mock v0-sdk
jest.mock("v0-sdk", () => ({
  createClient: () => ({
    chats: {
      create: jest.fn(),
      getById: jest.fn(),
      sendMessage: jest.fn(),
      downloadVersion: jest.fn(),
    },
  }),
}));

// Mock axios
jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
  },
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
}));

// Mock uuid
jest.mock("uuid", () => ({
  v4: () => "test-uuid-1234",
}));

import {
  resolveVercelProjectId,
  GeneratedLandingPage,
} from "../services/v0Service";

function makePage(
  overrides: Partial<GeneratedLandingPage> = {}
): GeneratedLandingPage {
  return {
    id: "page-1",
    userId: "user-1",
    name: "Test Page",
    prompt: "test prompt",
    status: "deployed",
    iterations: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveVercelProjectId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns existing vercelProjectId immediately without querying siblings", async () => {
    const page = makePage({ vercelProjectId: "prj_existing123" });

    const result = await resolveVercelProjectId(page);

    expect(result).toBe("prj_existing123");
    // Should NOT query DynamoDB for siblings
    expect(mockQuery).not.toHaveBeenCalled();
    // Should NOT backfill
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns null when page has no githubRepoUrl", async () => {
    const page = makePage({ githubRepoUrl: undefined });

    const result = await resolveVercelProjectId(page);

    expect(result).toBeNull();
    // Should NOT query DynamoDB for siblings
    expect(mockQuery).not.toHaveBeenCalled();
    // Should NOT backfill
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("resolves from sibling page and backfills via DynamoDB update", async () => {
    const page = makePage({
      id: "page-1",
      userId: "user-1",
      githubRepoUrl: "https://github.com/org/repo",
    });

    const siblingPage = makePage({
      id: "page-2",
      userId: "user-1",
      githubRepoUrl: "https://github.com/org/repo",
      vercelProjectId: "prj_sibling456",
    });

    // paginatedQuery uses dynamodb.query internally
    mockQuery.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({ Items: [page, siblingPage], LastEvaluatedKey: undefined }),
    });

    const result = await resolveVercelProjectId(page);

    expect(result).toBe("prj_sibling456");

    // Should have queried with UserIdIndex
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": "user-1" },
      })
    );

    // Should backfill the page with the resolved vercelProjectId
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        Key: { id: "page-1" },
        UpdateExpression: "SET vercelProjectId = :vpid, updatedAt = :now",
        ExpressionAttributeValues: expect.objectContaining({
          ":vpid": "prj_sibling456",
        }),
      })
    );
  });

  it("returns null when no sibling has vercelProjectId", async () => {
    const page = makePage({
      id: "page-1",
      userId: "user-1",
      githubRepoUrl: "https://github.com/org/repo",
    });

    const sibling1 = makePage({
      id: "page-2",
      userId: "user-1",
      githubRepoUrl: "https://github.com/org/repo",
      // no vercelProjectId
    });

    const sibling2 = makePage({
      id: "page-3",
      userId: "user-1",
      githubRepoUrl: "https://github.com/org/repo",
      // no vercelProjectId
    });

    mockQuery.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({ Items: [page, sibling1, sibling2], LastEvaluatedKey: undefined }),
    });

    const result = await resolveVercelProjectId(page);

    expect(result).toBeNull();
    // Should NOT backfill
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns null when no sibling has matching githubRepoUrl", async () => {
    const page = makePage({
      id: "page-1",
      userId: "user-1",
      githubRepoUrl: "https://github.com/org/repo-a",
    });

    const sibling = makePage({
      id: "page-2",
      userId: "user-1",
      githubRepoUrl: "https://github.com/org/repo-b",
      vercelProjectId: "prj_different789",
    });

    mockQuery.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({ Items: [page, sibling], LastEvaluatedKey: undefined }),
    });

    const result = await resolveVercelProjectId(page);

    expect(result).toBeNull();
    // Should NOT backfill since no matching repo
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
