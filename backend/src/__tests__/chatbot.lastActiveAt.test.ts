/**
 * Tests that createChatSession correctly updates lastActiveAt on the user
 * for real user sessions, and does NOT update it for admin delegate sessions.
 */

// Use the shared aws-sdk manual mock (includes S3, DynamoDB, SecretsManager)
jest.mock("aws-sdk");

// Mock userDb before importing chatbotService
const mockUpdateUser = jest.fn().mockResolvedValue(undefined);
jest.mock("../services/db", () => ({
  userDb: { updateUser: mockUpdateUser },
  taskDb: {},
}));

// Stub out heavy transitive imports
jest.mock("../utils/secretsManager", () => ({ getSecret: jest.fn().mockResolvedValue("{}"), getGCSPPrivateKey: jest.fn() }));
jest.mock("@google-cloud/discoveryengine", () => ({ EngineServiceClient: jest.fn(), SearchServiceClient: jest.fn(), protos: {} }));
jest.mock("@google-cloud/storage", () => ({ Storage: jest.fn() }));
jest.mock("openai", () => jest.fn());
jest.mock("../controllers/release", () => ({ getReleases: jest.fn() }));
jest.mock("../services/notionService", () => ({ getUserGuideContent: jest.fn() }));
jest.mock("../controllers/docsController", () => ({ getUserReleaseNotes: jest.fn() }));

import { chatbotDb } from "../services/chatbotService";

describe("createChatSession — lastActiveAt tracking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateUser.mockResolvedValue(undefined);
  });

  it("updates lastActiveAt when session is created by the real user (no delegateInfo)", async () => {
    await chatbotDb.createChatSession("user-123", undefined, "agent");

    // Give the fire-and-forget a tick to run
    await new Promise(r => setImmediate(r));

    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    expect(mockUpdateUser).toHaveBeenCalledWith("user-123", expect.objectContaining({
      lastActiveAt: expect.any(String),
    }));
  });

  it("does NOT update lastActiveAt when session is created via admin delegate access", async () => {
    const delegateInfo = { adminUserId: "admin-1", adminEmail: "admin@example.com", isDelegated: true };

    await chatbotDb.createChatSession("user-456", undefined, "agent", undefined, undefined, undefined, undefined, undefined, undefined, delegateInfo);

    await new Promise(r => setImmediate(r));

    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("still creates session when lastActiveAt update fails (fire-and-forget)", async () => {
    mockUpdateUser.mockRejectedValue(new Error("DynamoDB error"));

    await expect(chatbotDb.createChatSession("user-123", undefined, "agent")).resolves.toBeDefined();

    await new Promise(r => setImmediate(r));
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });

  it("updates lastActiveAt with an ISO timestamp", async () => {
    await chatbotDb.createChatSession("user-999", undefined, "agent");

    await new Promise(r => setImmediate(r));

    const [[, updateArg]] = mockUpdateUser.mock.calls;
    expect(new Date(updateArg.lastActiveAt).toISOString()).toBe(updateArg.lastActiveAt);
  });
});
