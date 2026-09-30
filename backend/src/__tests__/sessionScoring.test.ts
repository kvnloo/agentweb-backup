import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { chatbotDb, ChatSession } from "../services/chatbotService";
import * as sessionScoringService from "../services/sessionScoringService";

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getRecentSessionsPage: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionSatisfactionScore: jest.fn(),
  },
}));

jest.mock("../services/sessionScoringService", () => ({
  scoreSessionIfNeeded: jest.fn(),
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockScoring = sessionScoringService as jest.Mocked<typeof sessionScoringService>;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("POST /api/admin/chat-sessions/score", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // FAIL tests
  it("returns 400 when sessionIds is empty", async () => {
    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: [] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sessionIds/i);
  });

  it("returns 400 when more than 5 session IDs provided", async () => {
    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["a", "b", "c", "d", "e", "f"] });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/5/);
  });

  it("returns null for session already scored and up-to-date", async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      sessionId: "s1",
      userId: "u1",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      messageCount: 2,
      satisfactionScore: {
        score: 4,
        reason: "Good",
        evaluatedAt: "2026-01-01T00:00:00Z",
        evaluatedMessageIndex: 2,
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as any);

    mockScoring.scoreSessionIfNeeded.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s1"] });

    expect(res.status).toBe(200);
    expect(res.body.scores.s1).toBeNull();
  });

  it("returns null for session with no user messages", async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      sessionId: "s2",
      userId: "u1",
      messages: [{ role: "system", content: "init" }],
      messageCount: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as any);

    mockScoring.scoreSessionIfNeeded.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s2"] });

    expect(res.status).toBe(200);
    expect(res.body.scores.s2).toBeNull();
  });

  // SUCCESS tests
  it("scores a session and returns result", async () => {
    const scoreResult = {
      score: 3,
      reason: "Neutral interaction",
      evaluatedAt: "2026-03-10T00:00:00Z",
      evaluatedMessageIndex: 4,
    };

    mockChatbotDb.getChatSession.mockResolvedValue({
      sessionId: "s3",
      userId: "u1",
      messages: [
        { role: "user", content: "help" },
        { role: "assistant", content: "sure" },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "welcome" },
      ],
      messageCount: 4,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as any);

    mockScoring.scoreSessionIfNeeded.mockResolvedValue(scoreResult);

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s3"] });

    expect(res.status).toBe(200);
    expect(res.body.scores.s3).toEqual(scoreResult);
  });

  it("re-evaluates session when new messages are added", async () => {
    const updatedScore = {
      score: 2,
      reason: "User frustrated after new messages",
      evaluatedAt: "2026-03-10T00:00:00Z",
      evaluatedMessageIndex: 6,
    };

    mockChatbotDb.getChatSession.mockResolvedValue({
      sessionId: "s4",
      userId: "u1",
      messages: [
        { role: "user", content: "help" },
        { role: "assistant", content: "sure" },
        { role: "user", content: "not working" },
        { role: "assistant", content: "try again" },
        { role: "user", content: "still broken" },
        { role: "assistant", content: "sorry" },
      ],
      messageCount: 6,
      satisfactionScore: {
        score: 4,
        reason: "Good",
        evaluatedAt: "2026-01-01T00:00:00Z",
        evaluatedMessageIndex: 4,
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as any);

    mockScoring.scoreSessionIfNeeded.mockResolvedValue(updatedScore);

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s4"] });

    expect(res.status).toBe(200);
    expect(res.body.scores.s4).toEqual(updatedScore);
    expect(res.body.scores.s4.evaluatedMessageIndex).toBe(6);
  });

  it("skips admin-overridden sessions", async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      sessionId: "s5",
      userId: "u1",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" },
      ],
      messageCount: 3,
      satisfactionScore: {
        score: 5,
        reason: "Admin override",
        evaluatedAt: "2026-01-01T00:00:00Z",
        evaluatedMessageIndex: 2,
        adminOverride: true,
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as any);

    mockScoring.scoreSessionIfNeeded.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s5"] });

    expect(res.status).toBe(200);
    expect(res.body.scores.s5).toBeNull();
  });

  // ENG-2222: mirrors the ENG-2216 fix on the sibling judge-score route — a
  // per-session rejection used to be discarded entirely, no log, and `failed`
  // carried only a bare session id with no indication of why. It must now be
  // logged and the reason must be returned in the response.
  const makeScoringSession = (id: string): ChatSession => ({
    sessionId: id,
    userId: "u1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  });

  it("logs the rejection reason and reports it in `failed` instead of swallowing it", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockChatbotDb.getChatSession.mockResolvedValue(makeScoringSession("s1"));
    mockScoring.scoreSessionIfNeeded.mockRejectedValue(new Error("LLM provider timed out"));

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s1"] })
      .expect(200);

    expect(res.body.scores).toEqual({});
    expect(res.body.failed).toEqual([{ sessionId: "s1", reason: "LLM provider timed out" }]);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("s1"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("LLM provider timed out"));

    consoleErrorSpy.mockRestore();
  });

  it("returns scores for sessions that succeed and failed entries for sessions that reject, in the same request", async () => {
    const sessionOk = makeScoringSession("ok");
    const sessionBad = makeScoringSession("bad");
    mockChatbotDb.getChatSession.mockImplementation(async (id: string) =>
      id === "ok" ? sessionOk : sessionBad
    );
    const goodScore = {
      score: 4,
      reason: "good",
      evaluatedAt: "2026-01-01T00:00:00Z",
      evaluatedMessageIndex: 2,
    };
    mockScoring.scoreSessionIfNeeded.mockImplementation(async (session) =>
      session.sessionId === "ok" ? goodScore : Promise.reject(new Error("LLM timeout"))
    );

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["ok", "bad"] })
      .expect(200);

    expect(res.body.scores).toEqual({ ok: goodScore });
    expect(res.body.failed).toEqual([{ sessionId: "bad", reason: "LLM timeout" }]);
  });

  it("stringifies a non-Error rejection reason rather than dropping it", async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(makeScoringSession("s1"));
    mockScoring.scoreSessionIfNeeded.mockRejectedValue("weird non-error rejection");

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s1"] })
      .expect(200);

    expect(res.body.failed).toEqual([{ sessionId: "s1", reason: "weird non-error rejection" }]);
  });

  // CodeRabbit (CWE-532) on ENG-2216: a scoring failure reason can echo back
  // provider response content, which may itself derive from a real session
  // transcript, so it must not reach logs or the API response unbounded.
  it("truncates a very long rejection reason instead of logging/returning it verbatim", async () => {
    mockChatbotDb.getChatSession.mockResolvedValue(makeScoringSession("s1"));
    const longReason = "x".repeat(1000);
    mockScoring.scoreSessionIfNeeded.mockRejectedValue(new Error(longReason));

    const res = await request(app)
      .post("/api/admin/chat-sessions/score")
      .send({ sessionIds: ["s1"] })
      .expect(200);

    expect(res.body.failed).toHaveLength(1);
    expect(res.body.failed[0].sessionId).toBe("s1");
    expect(res.body.failed[0].reason.length).toBeLessThan(longReason.length);
    expect(res.body.failed[0].reason.endsWith("…")).toBe(true);
  });
});

describe("PUT /api/admin/chat-sessions/:sessionId/score", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 400 for invalid score", async () => {
    const res = await request(app)
      .put("/api/admin/chat-sessions/s1/score")
      .send({ score: 6 });

    expect(res.status).toBe(400);
  });

  it("returns 400 for missing score", async () => {
    const res = await request(app)
      .put("/api/admin/chat-sessions/s1/score")
      .send({});

    expect(res.status).toBe(400);
  });

  it("persists admin override score", async () => {
    mockChatbotDb.getChatSession.mockResolvedValue({
      sessionId: "s1",
      userId: "u1",
      messages: [],
      messageCount: 5,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } as any);

    mockChatbotDb.updateSessionSatisfactionScore.mockResolvedValue({
      sessionId: "s1",
    } as any);

    const res = await request(app)
      .put("/api/admin/chat-sessions/s1/score")
      .send({ score: 5, reason: "Actually great" });

    expect(res.status).toBe(200);
    expect(res.body.satisfactionScore.score).toBe(5);
    expect(res.body.satisfactionScore.reason).toBe("Actually great");
    expect(res.body.satisfactionScore.adminOverride).toBe(true);

    expect(mockChatbotDb.updateSessionSatisfactionScore).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        score: 5,
        reason: "Actually great",
        adminOverride: true,
      }),
      { allowOverride: true }
    );
  });
});
