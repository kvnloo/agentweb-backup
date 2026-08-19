/**
 * ENG-1332 — the sync backfill must never blindly clobber a satisfaction
 * score an admin has explicitly overridden.
 *
 * scoreSessionIfNeeded already skips adminOverride rows using the session it
 * read from DB, but that read happens once before scoring runs — a
 * concurrent admin override written in between is a TOCTOU race the
 * in-process check can't catch. updateSessionSatisfactionScore must refuse
 * that write at the DB layer too, mirroring the ConditionExpression pattern
 * already used by clearSessionSatisfactionScore.
 */

// Use the shared aws-sdk manual mock (includes S3, DynamoDB, SecretsManager)
jest.mock("aws-sdk");

jest.mock("../services/db", () => ({ userDb: { updateUser: jest.fn() }, taskDb: {} }));

// Stub out heavy transitive imports
jest.mock("../utils/secretsManager", () => ({ getSecret: jest.fn().mockResolvedValue("{}"), getGCSPPrivateKey: jest.fn() }));
jest.mock("@google-cloud/discoveryengine", () => ({ EngineServiceClient: jest.fn(), SearchServiceClient: jest.fn(), protos: {} }));
jest.mock("@google-cloud/storage", () => ({ Storage: jest.fn() }));
jest.mock("openai", () => jest.fn());
jest.mock("../controllers/release", () => ({ getReleases: jest.fn() }));
jest.mock("../services/notionService", () => ({ getUserGuideContent: jest.fn() }));
jest.mock("../controllers/docsController", () => ({ getUserReleaseNotes: jest.fn() }));

import { chatbotDb, dynamodb } from "../services/chatbotService";

const conditionalFailure = () => Object.assign(new Error("The conditional request failed"), {
  code: "ConditionalCheckFailedException",
});

describe("ENG-1332 — satisfaction score writes guard admin overrides", () => {
  let update: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const freshScore = {
    score: 4,
    reason: "Good outcome",
    evaluatedAt: "2026-08-18T14:01:00.000Z",
    evaluatedMessageIndex: 6,
  };

  beforeEach(() => {
    update = jest.spyOn(dynamodb, "update");
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    update.mockRestore();
    errorSpy.mockRestore();
  });

  // FAIL / edge-path tests

  it("is a no-op — not an error — when an admin override landed between read and write", async () => {
    update.mockReturnValueOnce({ promise: () => Promise.reject(conditionalFailure()) } as any);

    await expect(chatbotDb.updateSessionSatisfactionScore("s1", freshScore as any)).resolves.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still surfaces a genuine persistence failure", async () => {
    update.mockReturnValueOnce({
      promise: () => Promise.reject(new Error("ProvisionedThroughputExceededException")),
    } as any);

    await expect(chatbotDb.updateSessionSatisfactionScore("s1", freshScore as any)).rejects.toThrow(
      "ProvisionedThroughputExceededException"
    );
    expect(errorSpy).toHaveBeenCalled();
  });

  it("does not swallow a persistence failure on an explicit override write", async () => {
    update.mockReturnValueOnce({
      promise: () => Promise.reject(new Error("ProvisionedThroughputExceededException")),
    } as any);

    await expect(
      chatbotDb.updateSessionSatisfactionScore("s1", { ...freshScore, adminOverride: true } as any, {
        allowOverride: true,
      })
    ).rejects.toThrow("ProvisionedThroughputExceededException");
  });

  // SUCCESS tests

  it("guards a routine (backfill) write with a ConditionExpression against an existing admin override", async () => {
    update.mockReturnValueOnce({
      promise: () => Promise.resolve({ Attributes: { sessionId: "s1", satisfactionScore: freshScore } }),
    } as any);

    await chatbotDb.updateSessionSatisfactionScore("s1", freshScore as any);

    const params = update.mock.calls[0][0];
    expect(params.ConditionExpression).toBe("attribute_not_exists(satisfactionScore.adminOverride)");
    expect(params.UpdateExpression).toBe("SET satisfactionScore = :score");
  });

  it("lets an explicit admin override write skip the guard entirely", async () => {
    const overrideScore = { ...freshScore, adminOverride: true as const };
    update.mockReturnValueOnce({
      promise: () => Promise.resolve({ Attributes: { sessionId: "s1", satisfactionScore: overrideScore } }),
    } as any);

    await chatbotDb.updateSessionSatisfactionScore("s1", overrideScore as any, { allowOverride: true });

    const params = update.mock.calls[0][0];
    expect(params.ConditionExpression).toBeUndefined();
  });
});
