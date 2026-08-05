/**
 * ENG-830 — score retraction must be a compare-and-swap, not a blind wipe.
 *
 * The retraction sweep reads a session, decides it is a zero-task session, and
 * then removes the persisted score. Between the read and the write an admin
 * override or a fresh re-score can land on the same row; an unconditional
 * REMOVE would silently destroy it. Every retraction therefore carries a
 * ConditionExpression pinning the score that was actually selected, and a
 * failed condition is a no-op, not an error.
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

const validationFailure = () => Object.assign(new Error("The document path provided in the update expression is invalid"), {
  code: "ValidationException",
});

describe("ENG-830 — retraction is conditional on the score it read", () => {
  let update: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const previousScore = {
    score: 3,
    reason: "Greeting only",
    evaluatedAt: "2026-08-01T00:30:10.474Z",
    evaluatedMessageIndex: 3,
  };

  const previousJudgeScore = {
    score: 3,
    reason: "No task performed",
    evaluatedAt: "2026-08-01T00:30:10.474Z",
    evaluatedMessageIndex: 3,
    judgeName: "Fangfang Judge",
  };

  /** Queue the outcome of each successive dynamodb.update() call. */
  const respond = (...outcomes: Array<"ok" | Error>) => {
    outcomes.forEach(outcome => {
      update.mockReturnValueOnce({
        promise: () => (outcome === "ok" ? Promise.resolve({}) : Promise.reject(outcome)),
      } as any);
    });
  };

  beforeEach(() => {
    update = jest.spyOn(dynamodb, "update");
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    respond("ok", "ok", "ok");
  });

  afterEach(() => {
    update.mockRestore();
    errorSpy.mockRestore();
  });

  describe("satisfaction score", () => {
    it("pins the write to the exact score it read", async () => {
      await expect(chatbotDb.clearSessionSatisfactionScore("s1", previousScore)).resolves.toBe(true);

      const params = update.mock.calls[0][0];
      expect(params.ConditionExpression).toContain("satisfactionScore.evaluatedAt = :prevEvaluatedAt");
      expect(params.ExpressionAttributeValues[":prevEvaluatedAt"]).toBe(previousScore.evaluatedAt);
      expect(params.UpdateExpression).toBe(
        "SET retractedSatisfactionScore = :prev REMOVE satisfactionScore"
      );
    });

    it("refuses to retract a score an admin has overridden", async () => {
      await chatbotDb.clearSessionSatisfactionScore("s1", previousScore);

      expect(update.mock.calls[0][0].ConditionExpression).toContain(
        "attribute_not_exists(satisfactionScore.adminOverride)"
      );
    });

    it("is a no-op — not an error — when the score changed under it", async () => {
      update.mockReset();
      respond(conditionalFailure());

      await expect(chatbotDb.clearSessionSatisfactionScore("s1", previousScore)).resolves.toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("still surfaces a genuine persistence failure", async () => {
      update.mockReset();
      respond(new Error("ProvisionedThroughputExceededException"));

      await expect(chatbotDb.clearSessionSatisfactionScore("s1", previousScore)).rejects.toThrow(
        "ProvisionedThroughputExceededException"
      );
      expect(errorSpy).toHaveBeenCalled();
    });

    it("pins a legacy score with no evaluatedAt to the whole snapshot", async () => {
      // attribute_exists would NOT be invalidated by a replacement write, so the
      // only honest pin left is the score object itself.
      const legacy = { score: 3, reason: "legacy", evaluatedMessageIndex: 3 } as any;

      await chatbotDb.clearSessionSatisfactionScore("s1", legacy);

      const params = update.mock.calls[0][0];
      expect(params.ConditionExpression).toContain("satisfactionScore = :prevSnapshot");
      expect(params.ConditionExpression).not.toContain("attribute_exists(satisfactionScore)");
      expect(params.ExpressionAttributeValues[":prevSnapshot"]).toEqual(legacy);
      expect(params.ExpressionAttributeValues[":prevEvaluatedAt"]).toBeUndefined();
    });
  });

  describe("judge score", () => {
    it("pins the write to the exact judge score it read", async () => {
      await expect(
        chatbotDb.clearSessionJudgeScore("s1", "judge_1", previousJudgeScore)
      ).resolves.toBe(true);

      const params = update.mock.calls[0][0];
      expect(params.ConditionExpression).toContain("#js.#jid.evaluatedAt = :prevEvaluatedAt");
      expect(params.ExpressionAttributeValues[":prevEvaluatedAt"]).toBe(previousJudgeScore.evaluatedAt);
    });

    it("keeps the condition on the map-creation fallback", async () => {
      update.mockReset();
      respond(validationFailure(), "ok");

      await chatbotDb.clearSessionJudgeScore("s1", "judge_1", previousJudgeScore);

      const fallback = update.mock.calls[1][0];
      expect(fallback.UpdateExpression).toBe("SET #rjs = :map REMOVE #js.#jid");
      expect(fallback.ConditionExpression).toContain("#js.#jid.evaluatedAt = :prevEvaluatedAt");
      expect(fallback.ExpressionAttributeValues[":prevEvaluatedAt"]).toBe(previousJudgeScore.evaluatedAt);
    });

    it("pins a legacy judge score with no evaluatedAt to the whole snapshot", async () => {
      const legacy = { score: 3, reason: "legacy", evaluatedMessageIndex: 3, judgeName: "Probe" } as any;

      await chatbotDb.clearSessionJudgeScore("s1", "judge_1", legacy);

      const params = update.mock.calls[0][0];
      expect(params.ConditionExpression).toContain("#js.#jid = :prevSnapshot");
      expect(params.ExpressionAttributeValues[":prevSnapshot"]).toEqual(legacy);
    });

    it("refuses to clobber an archive map another retraction created first", async () => {
      // Two first-time retractions for the same session overlap: both see no
      // retractedJudgeScores map and both reach the fallback. The loser must not
      // replace the whole map with its own single entry.
      update.mockReset();
      respond(validationFailure(), conditionalFailure(), "ok");

      await expect(
        chatbotDb.clearSessionJudgeScore("s1", "judge_1", previousJudgeScore)
      ).resolves.toBe(true);

      expect(update.mock.calls[1][0].ConditionExpression).toContain("attribute_not_exists(#rjs)");
      // ...and once the map exists, the per-key write is retried instead.
      expect(update.mock.calls[2][0].UpdateExpression).toBe("SET #rjs.#jid = :prev REMOVE #js.#jid");
      expect(update.mock.calls[2][0].ConditionExpression).toContain("#js.#jid.evaluatedAt = :prevEvaluatedAt");
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("gives up quietly if the judge score also changed during that retry", async () => {
      update.mockReset();
      respond(validationFailure(), conditionalFailure(), conditionalFailure());

      await expect(
        chatbotDb.clearSessionJudgeScore("s1", "judge_1", previousJudgeScore)
      ).resolves.toBe(false);
      expect(update).toHaveBeenCalledTimes(3);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("is a no-op — not an error — when the judge score changed under it", async () => {
      update.mockReset();
      respond(conditionalFailure());

      await expect(
        chatbotDb.clearSessionJudgeScore("s1", "judge_1", previousJudgeScore)
      ).resolves.toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1); // no fallback attempt after a lost race
    });
  });
});
