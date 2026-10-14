import {
  runShadowJudgeSample,
  isShadowJudgeSamplerEnabled,
  resolveShadowJudgeSampleSize,
  DEFAULT_SHADOW_JUDGE_SAMPLE_SIZE,
  SHADOW_JUDGE_SAMPLER_FLAG,
} from "../cron/shadowJudgeSamplerCron";
import { settingsService } from "../services/settingsService";
import { chatbotDb } from "../services/chatbotService";
import { scoreSessionWithJudgeIfNeeded } from "../services/sessionScoringService";
import { listSessionsUpdatedBetween } from "../loops/eval/agentGraderLoader";

jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn() },
}));

jest.mock("../services/chatbotService", () => ({
  chatbotDb: { getChatSession: jest.fn() },
}));

jest.mock("../services/sessionScoringService", () => ({
  scoreSessionWithJudgeIfNeeded: jest.fn(),
}));

jest.mock("../loops/eval/agentGraderLoader", () => ({
  listSessionsUpdatedBetween: jest.fn(),
}));

jest.mock("../cron/evalV2SamplerCron", () => ({
  productionGraderTables: () => ({ sessions: "AW-ChatSessions" }),
  queryOnlyReader: () => ({}),
}));

const mockGetSetting = settingsService.getSetting as jest.Mock;
const mockGetChatSession = chatbotDb.getChatSession as jest.Mock;
const mockScoreWithJudge = scoreSessionWithJudgeIfNeeded as jest.Mock;
const mockListSessions = listSessionsUpdatedBetween as jest.Mock;

const SAMPLE_DATE = "2026-10-06";
const judgesRow = (judges: Array<Record<string, unknown>>) => ({
  settingValue: JSON.stringify(judges),
});

describe("ENG-2189/2138/2146 shadow judge sampler", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("refuses when disabled and not a dry run", async () => {
    const result = await runShadowJudgeSample({ enabled: false, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });
    expect(result).toEqual({ status: "refused", reason: "flag_off" });
    expect(mockGetSetting).not.toHaveBeenCalled();
  });

  it("refuses for a day that is not over yet", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: today });
    expect(result.status).toBe("refused");
    expect(result.reason).toBe("day_not_over");
  });

  it("runs with zero shadow judges and never lists sessions or scores anything", async () => {
    mockGetSetting.mockResolvedValue(judgesRow([{ id: "fangfang", shadow: false }, { id: "matt" }]));

    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(result).toEqual({ status: "ran", sampleDate: SAMPLE_DATE, frameSize: 0, sampled: 0, shadowJudgeCount: 0, scored: 0, errors: 0 });
    expect(mockListSessions).not.toHaveBeenCalled();
    expect(mockScoreWithJudge).not.toHaveBeenCalled();
  });

  it("never scores a non-shadow judge even when shadow judges are also configured", async () => {
    mockGetSetting.mockResolvedValue(
      judgesRow([{ id: "fangfang", shadow: false }, { id: "outcome-judge-b-shadow", shadow: true }])
    );
    mockListSessions.mockResolvedValue([{ sessionId: "s1" }]);
    mockGetChatSession.mockResolvedValue({ sessionId: "s1", messages: [], messageCount: 2 });
    mockScoreWithJudge.mockResolvedValue({ score: 4 });

    await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(mockScoreWithJudge).toHaveBeenCalledTimes(1);
    const judgeArg = mockScoreWithJudge.mock.calls[0][1];
    expect(judgeArg.id).toBe("outcome-judge-b-shadow");
  });

  it("dry run lists sessions but never calls the scorer", async () => {
    mockGetSetting.mockResolvedValue(judgesRow([{ id: "outcome-judge-b-shadow", shadow: true }]));
    mockListSessions.mockResolvedValue([{ sessionId: "s1" }, { sessionId: "s2" }]);
    mockGetChatSession.mockResolvedValue({ sessionId: "s1", messages: [], messageCount: 2 });

    const result = await runShadowJudgeSample({ enabled: false, dryRun: true, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(result.status).toBe("ran");
    expect(mockScoreWithJudge).not.toHaveBeenCalled();
  });

  it("counts a score only when scoreSessionWithJudgeIfNeeded actually returns one (the shadow sampleRate can skip it)", async () => {
    mockGetSetting.mockResolvedValue(judgesRow([{ id: "outcome-judge-b-shadow", shadow: true }]));
    mockListSessions.mockResolvedValue([{ sessionId: "s1" }, { sessionId: "s2" }]);
    mockGetChatSession.mockResolvedValue({ sessionId: "s1", messages: [], messageCount: 2 });
    mockScoreWithJudge.mockResolvedValueOnce({ score: 3 }).mockResolvedValueOnce(null);

    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(result.scored).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("isolates a judge failure on one session from the rest of the run", async () => {
    mockGetSetting.mockResolvedValue(judgesRow([{ id: "outcome-judge-b-shadow", shadow: true }]));
    mockListSessions.mockResolvedValue([{ sessionId: "s1" }, { sessionId: "s2" }]);
    mockGetChatSession.mockResolvedValue({ sessionId: "s1", messages: [], messageCount: 2 });
    // Fails on the first pass and again on the ENG-2138 retry, so it still ends as one error.
    mockScoreWithJudge.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ score: 5 }).mockRejectedValueOnce(new Error("boom again"));

    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(result.errors).toBe(1);
    expect(result.scored).toBe(1);
  });

  it("isolates a session-load failure, continuing to the next session", async () => {
    mockGetSetting.mockResolvedValue(judgesRow([{ id: "outcome-judge-b-shadow", shadow: true }]));
    mockListSessions.mockResolvedValue([{ sessionId: "s1" }, { sessionId: "s2" }]);
    mockGetChatSession.mockRejectedValueOnce(new Error("dynamo down")).mockResolvedValueOnce({ sessionId: "s2", messages: [], messageCount: 2 });
    mockScoreWithJudge.mockResolvedValue({ score: 2 });

    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(result.errors).toBe(1);
    expect(result.scored).toBe(1);
  });

  it("skips a session that no longer exists without counting it as an error", async () => {
    mockGetSetting.mockResolvedValue(judgesRow([{ id: "outcome-judge-b-shadow", shadow: true }]));
    mockListSessions.mockResolvedValue([{ sessionId: "s1" }]);
    mockGetChatSession.mockResolvedValue(null);

    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(result.errors).toBe(0);
    expect(result.scored).toBe(0);
    expect(mockScoreWithJudge).not.toHaveBeenCalled();
  });

  it("samples at most sampleSize sessions from a larger frame", async () => {
    mockGetSetting.mockResolvedValue(judgesRow([{ id: "outcome-judge-b-shadow", shadow: true }]));
    mockListSessions.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ sessionId: `s${i}` })));
    mockGetChatSession.mockResolvedValue({ sessionId: "sX", messages: [], messageCount: 2 });
    mockScoreWithJudge.mockResolvedValue({ score: 3 });

    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 5, sampleDate: SAMPLE_DATE });

    expect(result.frameSize).toBe(20);
    expect(result.sampled).toBe(5);
    expect(mockGetChatSession).toHaveBeenCalledTimes(5);
  });

  it("an invalid or blank env sample size falls back to the default", () => {
    expect(resolveShadowJudgeSampleSize(undefined)).toBe(DEFAULT_SHADOW_JUDGE_SAMPLE_SIZE);
    expect(resolveShadowJudgeSampleSize("")).toBe(DEFAULT_SHADOW_JUDGE_SAMPLE_SIZE);
    expect(resolveShadowJudgeSampleSize("not-a-number")).toBe(DEFAULT_SHADOW_JUDGE_SAMPLE_SIZE);
  });

  it("the env sample size is clamped to [1, 200]", () => {
    expect(resolveShadowJudgeSampleSize("0")).toBe(1);
    expect(resolveShadowJudgeSampleSize("-5")).toBe(1);
    expect(resolveShadowJudgeSampleSize("10000")).toBe(200);
    expect(resolveShadowJudgeSampleSize("42")).toBe(42);
  });

  it("is enabled only by the exact string true", () => {
    expect(isShadowJudgeSamplerEnabled({})).toBe(false);
    expect(isShadowJudgeSamplerEnabled({ [SHADOW_JUDGE_SAMPLER_FLAG]: "True" } as any)).toBe(false);
    expect(isShadowJudgeSamplerEnabled({ [SHADOW_JUDGE_SAMPLER_FLAG]: "1" } as any)).toBe(false);
    expect(isShadowJudgeSamplerEnabled({ [SHADOW_JUDGE_SAMPLER_FLAG]: "true" } as any)).toBe(true);
  });

  describe("ENG-2138 one in-run retry of failed sessions", () => {
    const setup = (sessionIds: string[]) => {
      mockGetSetting.mockResolvedValue(judgesRow([{ id: "outcome-judge-b-shadow", shadow: true }]));
      mockListSessions.mockResolvedValue(sessionIds.map((sessionId) => ({ sessionId })));
      mockGetChatSession.mockImplementation(async (id: string) => ({ sessionId: id, messages: [], messageCount: 2 }));
    };
    const run = () => runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    it("a first-attempt failure that succeeds on retry counts as scored and recovered, not as an error", async () => {
      setup(["s1"]);
      mockScoreWithJudge.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ score: 4 });

      const result = await run();

      expect(mockScoreWithJudge).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ scored: 1, errors: 0, retried: 1, recovered: 1 });
    });

    it("fails twice: counted once as an error, attempted exactly twice (retry bounded to one pass)", async () => {
      setup(["s1"]);
      mockScoreWithJudge.mockRejectedValue(new Error("bad json"));

      const result = await run();

      expect(mockScoreWithJudge).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ scored: 0, errors: 1, retried: 1, recovered: 0 });
    });

    it("retries only after the main loop, and only the failed sessions", async () => {
      setup(["s1", "s2"]);
      const order: string[] = [];
      mockScoreWithJudge.mockImplementation(async (session: any) => {
        order.push(session.sessionId);
        if (session.sessionId === order[0] && order.length === 1) throw new Error("boom");
        return { score: 3 };
      });

      const result = await run();

      expect(order).toHaveLength(3);
      expect(order[2]).toBe(order[0]);
      expect(result).toMatchObject({ scored: 2, errors: 0, retried: 1, recovered: 1 });
    });

    it("does not retry a session that was skipped or already scored (null result)", async () => {
      setup(["s1"]);
      mockScoreWithJudge.mockResolvedValue(null);

      const result = await run();

      expect(mockScoreWithJudge).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ scored: 0, errors: 0, retried: 0, recovered: 0 });
    });

    it("a null result on the retry is not a recovery and the failure stays an error", async () => {
      setup(["s1"]);
      mockScoreWithJudge.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(null);

      const result = await run();

      expect(result).toMatchObject({ scored: 0, errors: 1, retried: 1, recovered: 0 });
    });

    it("does not retry a session-load failure (existing classification is unchanged)", async () => {
      setup(["s1"]);
      mockGetChatSession.mockRejectedValueOnce(new Error("dynamo down"));

      const result = await run();

      expect(mockScoreWithJudge).not.toHaveBeenCalled();
      expect(result).toMatchObject({ errors: 1, retried: 0, recovered: 0 });
    });
  });

  it("a broken scoring-judges setting is treated as zero shadow judges, not a crash", async () => {
    mockGetSetting.mockResolvedValue({ settingValue: "not valid json" });

    const result = await runShadowJudgeSample({ enabled: true, dryRun: false, sampleSize: 10, sampleDate: SAMPLE_DATE });

    expect(result).toEqual({ status: "ran", sampleDate: SAMPLE_DATE, frameSize: 0, sampled: 0, shadowJudgeCount: 0, scored: 0, errors: 0 });
  });
});
