import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { chatbotDb } from "../services/chatbotService";
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
