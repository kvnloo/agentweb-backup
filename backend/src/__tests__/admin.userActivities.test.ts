import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { userDb } from "../services/db";

jest.mock("../services/db", () => ({
  userDb: {
    getUserChatSessions: jest.fn(),
  },
  taskDb: { getTasksByUserId: jest.fn() },
  subscriberDb: {},
  crmDb: {},
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

// Stub out all other services used by admin routes
jest.mock("../services/chatbotService", () => ({
  chatbotDb: {
    getRecentSessionsPage: jest.fn(),
    getChatSession: jest.fn(),
    updateSessionSatisfactionScore: jest.fn(),
    updateSessionJudgeScore: jest.fn(),
  },
}));
jest.mock("../services/sessionScoringService", () => ({
  scoreSessionIfNeeded: jest.fn(),
  scoreSessionWithJudgeIfNeeded: jest.fn(),
  ScoringJudge: {},
}));
jest.mock("../services/settingsService", () => ({
  settingsService: { getSetting: jest.fn(), setSetting: jest.fn() },
}));
jest.mock("../services/emailService", () => ({ emailService: {} }));
jest.mock("../services/resendService", () => ({ resendService: {} }));
jest.mock("../services/gtmPlanNotificationService", () => ({
  sendGTMPlanUpdateNotifications: jest.fn(),
  sendPhaseStatusReport: jest.fn(),
  sendPlanStatusReport: jest.fn(),
}));
jest.mock("../services/gtmPlanService", () => ({
  notifySlackWorkItemCompleted: jest.fn(),
}));
jest.mock("../services/waitlistDb", () => ({ waitlistDb: {} }));
jest.mock("../services/workflowDb", () => ({ workflowDb: {} }));
jest.mock("../utils/dynamoPagination", () => ({ paginatedScan: jest.fn() }));
jest.mock("../utils/crypto", () => ({ encryptPassword: jest.fn() }));
jest.mock("../services/tokenUsageService", () => ({
  grantTokenBonus: jest.fn(),
  getUserTokenUsage: jest.fn(),
  getUserTokenAllowance: jest.fn(),
}));
jest.mock("../services/revenueService", () => ({ getRevenueMetrics: jest.fn() }));
jest.mock("../services/businessFunnelService", () => ({ getBusinessFunnelMetrics: jest.fn() }));
jest.mock("../services/stripeService", () => ({ resyncAllSubscriptionAmounts: jest.fn() }));
jest.mock("../services/crmAutoSyncService", () => ({ syncNewUserToLeadList: jest.fn() }));
jest.mock("../cron/activationAnalysisCron", () => ({ getActivationFields: jest.fn() }));
jest.mock("aws-sdk", () => {
  const mockSecretsManager = jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: "{}" }) }),
  }));
  return { SecretsManager: mockSecretsManager, DynamoDB: { DocumentClient: jest.fn(() => ({})) } };
});

const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("GET /api/admin/users/:userId/activities", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns sessions for a user in the last 30 days", async () => {
    const sessions = [
      {
        sessionId: "session-1",
        title: "Marketing strategy",
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-01T10:30:00Z",
        portalType: "agent",
        sessionType: "regular",
      },
      {
        sessionId: "session-2",
        title: "SEO analysis",
        createdAt: "2026-03-28T09:00:00Z",
        updatedAt: "2026-03-28T09:15:00Z",
        portalType: "agent",
        sessionType: "regular",
      },
    ];
    mockUserDb.getUserChatSessions.mockResolvedValue(sessions);

    const res = await request(app)
      .get("/api/admin/users/user-123/activities")
      .expect(200);

    expect(mockUserDb.getUserChatSessions).toHaveBeenCalledWith("user-123", 30);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].sessionId).toBe("session-1");
    expect(res.body.sessions[0].title).toBe("Marketing strategy");
    expect(res.body.sessions[1].sessionId).toBe("session-2");
  });

  it("returns empty sessions array when user has no activity", async () => {
    mockUserDb.getUserChatSessions.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/admin/users/user-no-activity/activities")
      .expect(200);

    expect(mockUserDb.getUserChatSessions).toHaveBeenCalledWith("user-no-activity", 30);
    expect(res.body.sessions).toEqual([]);
  });

  it("returns 500 when database query fails", async () => {
    mockUserDb.getUserChatSessions.mockRejectedValue(new Error("DynamoDB connection failed"));

    const res = await request(app)
      .get("/api/admin/users/user-123/activities")
      .expect(500);

    expect(res.body.message).toBe("Failed to fetch user activities");
  });

  it("uses the userId from the URL path", async () => {
    mockUserDb.getUserChatSessions.mockResolvedValue([]);

    await request(app)
      .get("/api/admin/users/specific-user-id-456/activities")
      .expect(200);

    expect(mockUserDb.getUserChatSessions).toHaveBeenCalledWith("specific-user-id-456", 30);
  });
});
