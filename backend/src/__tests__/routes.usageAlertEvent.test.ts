/**
 * ENG-2769 — usage-alert modal outcome events. Asserts what reached the sink and
 * that the key is the billing subject, not the acting member.
 */
import request from "supertest";
import express from "express";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: "member-9", email: "m@example.com", isAdmin: false };
    next();
  },
}));
jest.mock("../services/tokenUsageService", () => ({
  ...jest.requireActual("../services/tokenUsageService"),
  resolveBillingUserId: jest.fn(async () => "owner-1"),
}));

import subscriptionRouter from "../routes/subscription";
import { __setUsageTelemetrySinkForTests } from "../services/llmUsageTelemetry";
import { recordUsageAlertEvent, InvalidAlertEventError } from "../services/llmUsageAlertEventService";

const app = express();
app.use(express.json());
app.use("/api/subscription", subscriptionRouter);

let emitted: { event: string; d: Record<string, unknown> }[] = [];
beforeEach(() => {
  emitted = [];
  __setUsageTelemetrySinkForTests((event, d) => emitted.push({ event, d }));
});
afterAll(() => __setUsageTelemetrySinkForTests(null));

describe("recordUsageAlertEvent", () => {
  it("FAIL: rejects an unknown action and emits nothing", async () => {
    await expect(recordUsageAlertEvent("u", { action: "clicked" })).rejects.toBeInstanceOf(InvalidAlertEventError);
    expect(emitted).toHaveLength(0);
  });
  it("FAIL: rejects an unknown reason", async () => {
    await expect(recordUsageAlertEvent("u", { action: "shown", reason: "x" })).rejects.toBeInstanceOf(InvalidAlertEventError);
  });
  it.each([
    ["shown", "runway_alert_shown"],
    ["dismissed", "runway_alert_dismissed"],
    ["see_options", "runway_alert_see_options"],
    ["book_call", "runway_alert_book_call"],
    ["upgrade", "runway_alert_upgrade"],
    ["contact", "runway_alert_contact"],
  ])("emits %s exactly once keyed on the billing subject", async (action, event) => {
    await recordUsageAlertEvent("member-9", { action, reason: "forecast", estimatedDaysRemaining: 1, percentUsed: 62 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe(event);
    expect(emitted[0].d).toMatchObject({
      billingUserId: "owner-1",
      actingUserId: "member-9",
      reason: "forecast",
      estimatedDaysRemainingAtAlert: 1,
      percentUsed: 62,
    });
  });
  it("drops non-numeric figures instead of recording them", async () => {
    await recordUsageAlertEvent("member-9", { action: "shown", estimatedDaysRemaining: "1" });
    expect(emitted[0].d.estimatedDaysRemainingAtAlert).toBeNull();
    expect(emitted[0].d.reason).toBe("usage");
  });
});

describe("POST /api/subscription/usage-runway/alert-event", () => {
  it("FAIL: invalid action is a 400, not a 500", async () => {
    const res = await request(app).post("/api/subscription/usage-runway/alert-event").send({ action: "nope" });
    expect(res.status).toBe(400);
    expect(emitted).toHaveLength(0);
  });
  it("records the event", async () => {
    const res = await request(app)
      .post("/api/subscription/usage-runway/alert-event")
      .send({ action: "see_options", reason: "forecast", estimatedDaysRemaining: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recorded: 1 });
    expect(emitted.map((e) => e.event)).toEqual(["runway_alert_see_options"]);
  });
});
