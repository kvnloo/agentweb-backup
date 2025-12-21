import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { chatbotDb } from "../services/chatbotService";

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getRecentSessionsPage: jest.fn(),
    getChatSession: jest.fn(),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

const mockChatbotDb = chatbotDb as jest.Mocked<typeof chatbotDb>;

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

    expect(mockChatbotDb.getRecentSessionsPage).toHaveBeenCalledWith(30, undefined);
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledTimes(2);
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith("session-1");
    expect(mockChatbotDb.getChatSession).toHaveBeenCalledWith("session-2");

    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.sessions[0].sessionId).toBe("session-2");
    expect(res.body.sessions[0].messages).toHaveLength(2);
    expect(res.body.sessions[0].messages[0].content).toBe("hello");
    expect(res.body.sessions[1].sessionId).toBe("session-1");
    expect(res.body.sessions[1].messages[0].content).toBe("from-messages-table");
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

    expect(mockChatbotDb.getRecentSessionsPage).toHaveBeenCalledWith(30, lastEvaluatedKey);
    expect(res.body.sessions).toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
  });
});
