import request from "supertest";
import express from "express";

const mockCreate = jest.fn();
const mockCustomersCreate = jest.fn();

jest.mock("../services/stripeClientFactory", () => ({
  createStripeClient: () => ({
    checkout: { sessions: { create: mockCreate } },
    customers: { create: mockCustomersCreate },
  }),
}));

jest.mock("../services/db", () => ({
  orgDb: { getOrgById: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));

// Real isAdmin runs; auth stub sets req.user from a test header.
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "admin-1", isAdmin: req.headers["x-test-admin"] === "1" };
    next();
  },
}));

import router from "../routes/adminCustomSubscriptionLinks";
import { orgDb, userDb } from "../services/db";

const app = express();
app.use(express.json());
app.use("/api/admin", router);

const path = "/api/admin/custom-subscription-links";
const valid = { orgId: "org-1", label: "Growth retainer", amountUsd: 1500, frequency: "quarter" };

describe("POST /api/admin/custom-subscription-links (ENG-2428)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.FRONTEND_URL = "https://app.example";
    (orgDb.getOrgById as jest.Mock).mockResolvedValue({ orgId: "org-1", ownerUserId: "owner-1" });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: "owner-1", stripe_customer_id: "cus_123" });
    mockCreate.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.com/c/cs_1", expires_at: 1760000000 });
  });

  it("AC1: non-admin gets 403 and Stripe is never called", async () => {
    const res = await request(app).post(path).send(valid);
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["amount <= 0", { amountUsd: 0 }],
    ["negative amount", { amountUsd: -5 }],
    ["unknown frequency", { frequency: "fortnight" }],
    ["empty label", { label: "  " }],
    ["sub-minimum amount (builder rejects)", { amountUsd: 0.1 }],
  ])("AC2: %s gets 400 and Stripe is never called", async (_n, patch) => {
    const res = await request(app).post(path).set("x-test-admin", "1").send({ ...valid, ...patch });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("AC3: account with no Stripe customer gets 4xx and no customer is created", async () => {
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: "owner-1" });
    const res = await request(app).post(path).set("x-test-admin", "1").send(valid);
    expect(res.status).toBe(409);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockCustomersCreate).not.toHaveBeenCalled();
  });

  it("unknown org gets 404", async () => {
    (orgDb.getOrgById as jest.Mock).mockResolvedValue(null);
    const res = await request(app).post(path).set("x-test-admin", "1").send(valid);
    expect(res.status).toBe(404);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("AC4: valid quarter request creates one session with exact params and returns the URL", async () => {
    const res = await request(app).post(path).set("x-test-admin", "1").send(valid);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: "https://checkout.stripe.com/c/cs_1",
      sessionId: "cs_1",
      expiresAt: new Date(1760000000 * 1000).toISOString(),
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const params = mockCreate.mock.calls[0][0];
    expect(params.mode).toBe("subscription");
    expect(params.customer).toBe("cus_123");
    expect(params.customer_creation).toBeUndefined();
    expect(params.line_items).toEqual([
      {
        quantity: 1,
        price_data: expect.objectContaining({
          currency: "usd",
          unit_amount: 150000,
          product_data: expect.objectContaining({ name: "Growth retainer" }),
          recurring: { interval: "month", interval_count: 3 },
        }),
      },
    ]);
    expect(params.metadata).toEqual(
      expect.objectContaining({ orgId: "org-1", createdBy: "admin-1", linkLabel: "Growth retainer" })
    );
    expect(params.metadata.source).toBeTruthy();
  });

  it("AC4: one_time uses payment mode with no recurring", async () => {
    await request(app).post(path).set("x-test-admin", "1").send({ ...valid, frequency: "one_time" });
    const params = mockCreate.mock.calls[0][0];
    expect(params.mode).toBe("payment");
    expect(params.line_items[0].price_data.recurring).toBeUndefined();
  });

  it("Stripe failure returns 502", async () => {
    mockCreate.mockRejectedValue(new Error("stripe down"));
    const res = await request(app).post(path).set("x-test-admin", "1").send(valid);
    expect(res.status).toBe(502);
  });
});
