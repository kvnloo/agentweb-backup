import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { userDb } from "../services/db";
import { settingsService } from "../services/settingsService";

// PUT /api/admin/users/:userId/subscription-type is the MANUAL tier-grant path
// (partner portal). ENG-218 follow-up: when an admin grants a real tier to a
// user who previously churned off Stripe, a stale *terminal* subscription_status
// (e.g. "canceled") left on the record makes the customer-portal subscription
// card render the granted tier as a lapsed/Free plan. This endpoint must clear
// the stale Stripe lifecycle fields so the manual grant is a clean, Stripe-free
// record — WITHOUT disturbing a genuinely active Stripe subscriber.

jest.mock("../services/db", () => ({
  userDb: {
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

// syncUserUpdateToLeadList is fire-and-forget; keep it a no-op for these tests.
jest.mock("../services/crmAutoSyncService", () => ({
  syncNewUserToLeadList: jest.fn(),
  syncUserUpdateToLeadList: jest.fn(),
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockedSettingsService = settingsService as jest.Mocked<typeof settingsService>;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

const userId = "user-1";
const baseUser = {
  userId,
  email: "user@example.com",
  subscriptionType: "Free",
};

// Make "Pro" (and "Free") valid tier names so the endpoint passes validation.
function mockTierCatalog() {
  mockedSettingsService.getSetting.mockResolvedValue({
    settingValue: JSON.stringify([
      { name: "Free" },
      { name: "Pro" },
      { name: "Basic" },
    ]),
  } as any);
}

describe("PUT /api/admin/users/:userId/subscription-type — clear stale Stripe lifecycle on manual grant", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTierCatalog();
    mockUserDb.updateUser.mockImplementation(async (_id, updates) => ({
      ...baseUser,
      ...updates,
    }) as any);
  });

  it.each(["canceled", "unpaid", "incomplete_expired"])(
    "clears subscription_status and current_period_end when granting Pro to a user with terminal status '%s'",
    async (terminalStatus) => {
      mockUserDb.getUserById.mockResolvedValue({
        ...baseUser,
        subscription_status: terminalStatus,
        current_period_end: "2025-01-01T00:00:00.000Z",
      } as any);

      await request(app)
        .put(`/api/admin/users/${userId}/subscription-type`)
        .send({ subscriptionType: "Pro" })
        .expect(200);

      expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
        subscriptionType: "Pro",
        subscription_status: "",
        current_period_end: "",
      });
    }
  );

  it("does NOT clear Stripe fields for an active Stripe subscriber (status preserved)", async () => {
    mockUserDb.getUserById.mockResolvedValue({
      ...baseUser,
      subscriptionType: "Starter",
      subscription_status: "active",
      current_period_end: "2025-01-01T00:00:00.000Z",
    } as any);

    await request(app)
      .put(`/api/admin/users/${userId}/subscription-type`)
      .send({ subscriptionType: "Pro" })
      .expect(200);

    expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
      subscriptionType: "Pro",
    });
  });

  it("does NOT clear Stripe fields for a trialing subscriber (status preserved)", async () => {
    mockUserDb.getUserById.mockResolvedValue({
      ...baseUser,
      subscription_status: "trialing",
    } as any);

    await request(app)
      .put(`/api/admin/users/${userId}/subscription-type`)
      .send({ subscriptionType: "Pro" })
      .expect(200);

    expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
      subscriptionType: "Pro",
    });
  });

  it("leaves the update untouched for a clean manual grant (no existing subscription_status)", async () => {
    mockUserDb.getUserById.mockResolvedValue({ ...baseUser } as any);

    await request(app)
      .put(`/api/admin/users/${userId}/subscription-type`)
      .send({ subscriptionType: "Pro" })
      .expect(200);

    expect(mockUserDb.updateUser).toHaveBeenCalledWith(userId, {
      subscriptionType: "Pro",
    });
  });

  it("still returns the updated user (happy path)", async () => {
    mockUserDb.getUserById.mockResolvedValue({
      ...baseUser,
      subscription_status: "canceled",
    } as any);

    const res = await request(app)
      .put(`/api/admin/users/${userId}/subscription-type`)
      .send({ subscriptionType: "Pro" })
      .expect(200);

    expect(res.body.subscriptionType).toBe("Pro");
    expect(res.body.subscription_status).toBe("");
  });
});
