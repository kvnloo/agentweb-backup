import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { chatbotDb } from "../services/chatbotService";
import { settingsService } from "../services/settingsService";
import * as sessionScoringService from "../services/sessionScoringService";

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getRecentSessionsPage: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionSatisfactionScore: jest.fn(),
    updateSessionJudgeScore: jest.fn(),
  },
}));

jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock("../services/sessionScoringService", () => ({
  scoreSessionIfNeeded: jest.fn(),
  scoreSessionWithJudgeIfNeeded: jest.fn(),
  ScoringJudge: {},
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;
const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockScoreSessionIfNeeded = sessionScoringService.scoreSessionIfNeeded as jest.MockedFunction<typeof sessionScoringService.scoreSessionIfNeeded>;
const mockScoreSessionWithJudgeIfNeeded = sessionScoringService.scoreSessionWithJudgeIfNeeded as jest.MockedFunction<typeof sessionScoringService.scoreSessionWithJudgeIfNeeded>;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("Admin chat sessions endpoint", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("hydrates sessions with messages from the messages table", async () => {
    const baseSessions = [
      {
        sessionId: "session-2",
        userId: "user-2",
        createdAt: "2024-01-03T00:00:00Z",
        updatedAt: "2024-01-04T00:00:00Z",
        messages: [],
      },
      {
        sessionId: "session-1",
        userId: "user-1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        messages: [{ role: "user", content: "legacy" }],
      },
    ];

    mockChatbotDb.getRecentSessionsPage.mockResolvedValue({
      sessions: baseSessions as any,
      lastEvaluatedKey: undefined,
    });
    mockChatbotDb.getChatSession.mockImplementation(async (sessionId: string) => {
      if (sessionId === "session-1") {
        return {
          ...baseSessions[1],
          messages: [{ role: "assistant", content: "from-messages-table" }],
        } as any;
      }
      if (sessionId === "session-2") {
        return {
          ...baseSessions[0],
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "world" },
          ],
        } as any;
      }
      return null;
    });

    const res = await request(app).get("/api/admin/chat-sessions").expect(200);

    expect(mockChatbotDb.getRecentSessionsPage).toHaveBeenCalledWith(30, undefined, undefined);
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledTimes(2);
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith("session-1");
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith("session-2");

    // session-1 has only assistant messages, so it should be filtered out
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.sessions[0].sessionId).toBe("session-2");
    expect(res.body.sessions[0].messages).toHaveLength(2);
    expect(res.body.sessions[0].messages[0].content).toBe("hello");
  });

  it("filters out sessions with no user messages", async () => {
    const baseSessions = [
      {
        sessionId: "empty-session",
        userId: "user-1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        messages: [],
      },
      {
        sessionId: "assistant-only",
        userId: "user-2",
        createdAt: "2024-01-02T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        messages: [],
      },
      {
        sessionId: "real-session",
        userId: "user-3",
        createdAt: "2024-01-03T00:00:00Z",
        updatedAt: "2024-01-03T00:00:00Z",
        messages: [],
      },
    ];

    mockChatbotDb.getRecentSessionsPage.mockResolvedValue({
      sessions: baseSessions as any,
      lastEvaluatedKey: undefined,
    });
    mockChatbotDb.getChatSession.mockImplementation(async (sessionId: string) => {
      if (sessionId === "empty-session") {
        return { ...baseSessions[0], messages: [] } as any;
      }
      if (sessionId === "assistant-only") {
        return {
          ...baseSessions[1],
          messages: [{ role: "assistant", content: "auto greeting" }],
        } as any;
      }
      if (sessionId === "real-session") {
        return {
          ...baseSessions[2],
          messages: [
            { role: "assistant", content: "hello" },
            { role: "user", content: "hi there" },
          ],
        } as any;
      }
      return null;
    });

    const res = await request(app).get("/api/admin/chat-sessions").expect(200);

    // Only the session with a user message should be returned
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].sessionId).toBe("real-session");
  });

  it("passes the decoded cursor to pagination queries", async () => {
    const lastEvaluatedKey = { sessionId: "session-99" };
    const cursor = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString("base64");

    mockChatbotDb.getRecentSessionsPage.mockResolvedValue({
      sessions: [],
      lastEvaluatedKey: undefined,
    });

    const res = await request(app)
      .get(`/api/admin/chat-sessions?cursor=${encodeURIComponent(cursor)}`)
      .expect(200);

    expect(mockChatbotDb.getRecentSessionsPage).toHaveBeenCalledWith(30, lastEvaluatedKey, undefined);
    expect(res.body.sessions).toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
  });

  describe("sync mode", () => {
    const makeSession = (id: string) => ({
      sessionId: id,
      userId: "user-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });

    beforeEach(() => {
      const session = makeSession("s1");
      mockChatbotDb.getRecentSessionsPage.mockResolvedValue({
        sessions: [session] as any,
        lastEvaluatedKey: undefined,
      });
      mockChatbotDb.getChatSession.mockResolvedValue(session as any);
      mockScoreSessionIfNeeded.mockResolvedValue(null);
      mockScoreSessionWithJudgeIfNeeded.mockResolvedValue(null);
    });

    it("calls scoreSessionIfNeeded for each session when sync=true", async () => {
      mockSettingsService.getSetting.mockResolvedValue(null as any);

      await request(app)
        .get("/api/admin/chat-sessions?sync=true")
        .expect(200);

      expect(mockScoreSessionIfNeeded).toHaveBeenCalledTimes(1);
    });

    it("does not call scoring when sync is not set", async () => {
      await request(app).get("/api/admin/chat-sessions").expect(200);

      expect(mockScoreSessionIfNeeded).not.toHaveBeenCalled();
    });

    it("scores sessions with all configured judges when sync=true", async () => {
      const judges = [
        { id: "judge-1", name: "Fangfang", systemPrompt: "Rate quality", createdAt: "2024-01-01", updatedAt: "2024-01-01" },
        { id: "judge-2", name: "Speed", systemPrompt: "Rate speed", createdAt: "2024-01-01", updatedAt: "2024-01-01" },
      ];
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: "scoring-judges",
        settingValue: JSON.stringify(judges),
      } as any);

      await request(app)
        .get("/api/admin/chat-sessions?sync=true")
        .expect(200);

      // Should score with both judges
      expect(mockScoreSessionWithJudgeIfNeeded).toHaveBeenCalledTimes(2);
      expect(mockScoreSessionWithJudgeIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1" }),
        expect.objectContaining({ id: "judge-1" })
      );
      expect(mockScoreSessionWithJudgeIfNeeded).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1" }),
        expect.objectContaining({ id: "judge-2" })
      );
    });

    it("re-fetches sessions after judge scoring to include new scores", async () => {
      const judges = [{ id: "j1", name: "Judge", systemPrompt: "p", createdAt: "2024-01-01", updatedAt: "2024-01-01" }];
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: "scoring-judges",
        settingValue: JSON.stringify(judges),
      } as any);

      // After scoring, getChatSession is called again to refresh
      // First call is for hydration, second is for refresh after scoring
      const refreshedSession = {
        ...makeSession("s1"),
        judgeScores: { j1: { score: 4, reason: "good", evaluatedAt: "2024-01-01", evaluatedMessageIndex: 2, judgeName: "Judge" } },
      };
      mockChatbotDb.getChatSession
        .mockResolvedValueOnce(makeSession("s1") as any) // hydration
        .mockResolvedValueOnce(refreshedSession as any); // refresh after scoring

      const res = await request(app)
        .get("/api/admin/chat-sessions?sync=true")
        .expect(200);

      // getChatSession called twice: once for hydration, once for refresh
      expect(mockChatbotDb.getChatSession).toHaveBeenCalledTimes(2);
      expect(res.body.sessions[0].judgeScores).toEqual(refreshedSession.judgeScores);
    });

    it("continues scoring other sessions if one judge scoring fails", async () => {
      const sessions = [makeSession("s1"), makeSession("s2")];
      mockChatbotDb.getRecentSessionsPage.mockResolvedValue({
        sessions: sessions as any,
        lastEvaluatedKey: undefined,
      });
      mockChatbotDb.getChatSession.mockImplementation(async (id: string) =>
        sessions.find((s) => s.sessionId === id) as any
      );

      const judges = [{ id: "j1", name: "Judge", systemPrompt: "p", createdAt: "2024-01-01", updatedAt: "2024-01-01" }];
      mockSettingsService.getSetting.mockResolvedValue({
        settingName: "scoring-judges",
        settingValue: JSON.stringify(judges),
      } as any);

      mockScoreSessionWithJudgeIfNeeded
        .mockRejectedValueOnce(new Error("LLM timeout"))
        .mockResolvedValueOnce(null);

      const res = await request(app)
        .get("/api/admin/chat-sessions?sync=true")
        .expect(200);

      // Both sessions scored despite first failure
      expect(mockScoreSessionWithJudgeIfNeeded).toHaveBeenCalledTimes(2);
      expect(res.body.sessions).toHaveLength(2);
    });

    it("skips judge scoring when no judges are configured", async () => {
      mockSettingsService.getSetting.mockResolvedValue(null as any);

      await request(app)
        .get("/api/admin/chat-sessions?sync=true")
        .expect(200);

      expect(mockScoreSessionWithJudgeIfNeeded).not.toHaveBeenCalled();
    });

    it("re-fetches sessions after default scoring even when no judges are configured", async () => {
      // Bug: when sync=true but judges=[],  scoreSessionIfNeeded writes a new score to DB
      // but the response returns the stale in-memory object (satisfactionScore: null).
      mockSettingsService.getSetting.mockResolvedValue(null as any);

      const newScore = { score: 2, reason: "poor", evaluatedAt: "2024-01-01T01:00:00Z", evaluatedMessageIndex: 2, dimensions: { goalCompletion: 2, dataAccuracy: 2, outputQuality: 2 } };
      mockScoreSessionIfNeeded.mockResolvedValue(newScore as any);

      // First call: hydration; second call: re-fetch after scoring
      const baseSession = makeSession("s1");
      const refreshedSession = { ...baseSession, satisfactionScore: newScore };
      let callCount = 0;
      mockChatbotDb.getChatSession.mockImplementation(async (_id: string) => {
        callCount++;
        return callCount === 1 ? (baseSession as any) : (refreshedSession as any);
      });

      const res = await request(app)
        .get("/api/admin/chat-sessions?sync=true")
        .expect(200);

      // Must re-fetch regardless of whether judges exist, so the newly scored session is returned
      expect(mockChatbotDb.getChatSession).toHaveBeenCalledTimes(2);
      expect(res.body.sessions[0].satisfactionScore).toEqual(newScore);
    });

  });

  describe("sessionId search", () => {
    it("returns the specific session when sessionId param is provided and session exists", async () => {
      const session = {
        sessionId: "abc-123",
        userId: "user-1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      };

      mockChatbotDb.getChatSession.mockResolvedValue(session as any);

      const res = await request(app)
        .get("/api/admin/chat-sessions?sessionId=abc-123")
        .expect(200);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith("abc-123");
      expect(mockChatbotDb.getRecentSessionsPage).not.toHaveBeenCalled();
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].sessionId).toBe("abc-123");
      expect(res.body.nextCursor).toBeNull();
    });

    it("returns empty results when sessionId param is provided but session does not exist", async () => {
      mockChatbotDb.getChatSession.mockResolvedValue(null);

      const res = await request(app)
        .get("/api/admin/chat-sessions?sessionId=nonexistent-id")
        .expect(200);

      expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith("nonexistent-id");
      expect(mockChatbotDb.getRecentSessionsPage).not.toHaveBeenCalled();
      expect(res.body.sessions).toHaveLength(0);
      expect(res.body.nextCursor).toBeNull();
    });

    it("filters out session found by ID if it has no user messages", async () => {
      const session = {
        sessionId: "no-user-msgs",
        userId: "user-1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
        messages: [{ role: "assistant", content: "auto greeting" }],
      };

      mockChatbotDb.getChatSession.mockResolvedValue(session as any);

      const res = await request(app)
        .get("/api/admin/chat-sessions?sessionId=no-user-msgs")
        .expect(200);

      expect(res.body.sessions).toHaveLength(0);
      expect(res.body.nextCursor).toBeNull();
    });

    it("ignores sessionId param when it is empty string and uses normal pagination", async () => {
      mockChatbotDb.getRecentSessionsPage.mockResolvedValue({
        sessions: [],
        lastEvaluatedKey: undefined,
      });

      await request(app)
        .get("/api/admin/chat-sessions?sessionId=")
        .expect(200);

      expect(mockChatbotDb.getRecentSessionsPage).toHaveBeenCalled();
      expect(mockChatbotDb.getChatSession).not.toHaveBeenCalled();
    });
  });
});
