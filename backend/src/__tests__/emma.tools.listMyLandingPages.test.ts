// Mock aws-sdk before any imports
const mockQuery = jest
  .fn()
  .mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) });

const mockS3 = {
  putObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  getObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Body: Buffer.from('') }) }),
  deleteObject: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  getSignedUrlPromise: jest.fn().mockResolvedValue('https://s3.example.com/signed'),
};

const mockDocClient = () => ({
  put: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  update: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  get: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Item: null }) }),
  query: mockQuery,
  delete: jest.fn().mockReturnValue({ promise: () => Promise.resolve() }),
  scan: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Items: [] }) }),
  batchGet: jest.fn().mockReturnValue({ promise: () => Promise.resolve({ Responses: {} }) }),
  createSet: jest.fn((arr: any[]) => ({ values: arr })),
});

const mockSecretsManager = () => ({
  getSecretValue: jest.fn().mockReturnValue({
    promise: () =>
      Promise.resolve({ SecretString: '{"apiKey":"test-key"}' }),
  }),
});

jest.mock("aws-sdk", () => ({
  __esModule: true,
  default: {
    DynamoDB: { DocumentClient: jest.fn().mockImplementation(mockDocClient) },
    SecretsManager: jest.fn().mockImplementation(mockSecretsManager),
    S3: jest.fn().mockImplementation(() => mockS3),
    config: { update: jest.fn() },
  },
  DynamoDB: { DocumentClient: jest.fn().mockImplementation(mockDocClient) },
  SecretsManager: jest.fn().mockImplementation(mockSecretsManager),
  S3: jest.fn().mockImplementation(() => mockS3),
  config: { update: jest.fn() },
}));

// Mock secretsManager
jest.mock("../utils/secretsManager", () => ({
  getV0ApiKey: jest.fn().mockResolvedValue("test-v0-api-key"),
  getSecret: jest.fn().mockResolvedValue('{"apiKey":"test-key"}'),
  secretExists: jest.fn().mockResolvedValue(true),
}));

// Mock v0-sdk
jest.mock("v0-sdk", () => ({
  createClient: () => ({
    projects: { create: jest.fn() },
    chats: { create: jest.fn(), getById: jest.fn(), sendMessage: jest.fn() },
    deployments: { create: jest.fn() },
  }),
}));

// Mock uuid
jest.mock("uuid", () => ({
  v4: () => "test-uuid-1234",
}));

import { emmaToolRegistry } from "../emma/registry";

// Load tools (side effect)
import "../emma/tools";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("list_my_landing_pages tool", () => {
  const tool = emmaToolRegistry.getTool("list_my_landing_pages");

  it("tool is registered", () => {
    expect(tool).toBeDefined();
    expect(tool!.definition.name).toBe("list_my_landing_pages");
  });

  // FAIL tests
  it("FAIL: throws when userId is missing from context", async () => {
    await expect(tool!.execute({}, {})).rejects.toThrow(
      "Authentication required"
    );
  });

  it("FAIL: throws when context is undefined", async () => {
    await expect(tool!.execute({}, undefined)).rejects.toThrow(
      "Authentication required"
    );
  });

  it("FAIL: returns empty array when user has no landing pages", async () => {
    mockQuery.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: [] }),
    });

    const result = await tool!.execute({}, { userId: "user-no-pages" });
    expect(result.landingPages).toEqual([]);
    expect(result.count).toBe(0);
  });

  // SUCCESS tests
  it("SUCCESS: returns landing pages with githubRepoUrl for authenticated user", async () => {
    const mockPages = [
      {
        id: "page-1",
        userId: "user-1",
        name: "My SaaS Page",
        status: "deployed",
        githubRepoUrl: "https://github.com/AgentWebPro/lp-my-saas",
        deployedUrl: "https://my-saas.vercel.app",
      },
      {
        id: "page-2",
        userId: "user-1",
        name: "Product Landing",
        status: "draft",
        githubRepoUrl: "https://github.com/AgentWebPro/lp-product",
        deployedUrl: undefined,
      },
    ];

    mockQuery.mockReturnValueOnce({
      promise: () => Promise.resolve({ Items: mockPages }),
    });

    const result = await tool!.execute({}, { userId: "user-1" });
    expect(result.landingPages).toHaveLength(2);
    expect(result.count).toBe(2);
    expect(result.landingPages[0]).toEqual({
      id: "page-1",
      name: "My SaaS Page",
      status: "deployed",
      githubRepoUrl: "https://github.com/AgentWebPro/lp-my-saas",
      deployedUrl: "https://my-saas.vercel.app",
    });
    expect(result.landingPages[1]).toEqual({
      id: "page-2",
      name: "Product Landing",
      status: "draft",
      githubRepoUrl: "https://github.com/AgentWebPro/lp-product",
      deployedUrl: undefined,
    });
  });

  it("SUCCESS: does not return other users' landing pages (query uses userId)", async () => {
    // The DynamoDB query uses KeyConditionExpression with userId,
    // so only the requesting user's pages are returned
    mockQuery.mockReturnValueOnce({
      promise: () =>
        Promise.resolve({
          Items: [
            {
              id: "page-3",
              userId: "user-2",
              name: "User 2 Page",
              status: "deployed",
              githubRepoUrl: "https://github.com/AgentWebPro/lp-u2",
              deployedUrl: "https://u2.vercel.app",
            },
          ],
        }),
    });

    const result = await tool!.execute({}, { userId: "user-2" });
    // Verify the query was called with the correct userId
    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        ExpressionAttributeValues: { ":userId": "user-2" },
      })
    );
    expect(result.landingPages).toHaveLength(1);
    expect(result.landingPages[0].id).toBe("page-3");
  });
});
