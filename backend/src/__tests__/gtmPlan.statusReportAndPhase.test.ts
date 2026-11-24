import request from "supertest";
import express from "express";

// ENG-2840 W2-4. Two route behaviours the MCP GTM tools depend on:
//  1. the status report routes answer for what happened ("sent" only when an email was accepted);
//  2. PUT /:planId/phases/:phaseId exists (the tool called it before it did: 404 for every key).

const mockGet = jest.fn();
const mockUpdate = jest.fn();

jest.mock("aws-sdk", () => {
  const mockDocClient = { query: jest.fn(), get: mockGet, put: jest.fn(), update: mockUpdate, delete: jest.fn(), scan: jest.fn() };
  return {
    DynamoDB: { DocumentClient: jest.fn(() => mockDocClient) },
    S3: jest.fn(() => ({})),
    SecretsManager: jest.fn(() => ({ getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: "{}" }) }) })),
    config: { update: jest.fn() },
  };
});

let signedInUser = "user-123";
jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: signedInUser, email: "user@example.com", isAdmin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

jest.mock("../services/settingsService", () => ({ settingsService: { getSetting: jest.fn(), setSetting: jest.fn() } }));

jest.mock("../services/gtmPlanNotificationService", () => ({
  sendGTMPlanUpdateNotifications: jest.fn(),
  sendPhaseStatusReport: jest.fn(),
  sendPlanStatusReport: jest.fn(),
}));

import gtmPlanRoutes from "../routes/gtmPlan";
import { sendPhaseStatusReport, sendPlanStatusReport } from "../services/gtmPlanNotificationService";

const mockPhaseReport = sendPhaseStatusReport as jest.Mock;
const mockPlanReport = sendPlanStatusReport as jest.Mock;

const app = express();
app.use(express.json());
app.use("/api/gtm-plan", gtmPlanRoutes);

const plan = () => ({
  planId: "plan-1",
  userId: "user-123",
  title: "Plan",
  status: "in_progress",
  dri: "plan-poc@example.com",
  phases: [
    { id: "phase-1", title: "Phase 1", description: "first", dri: "p1@example.com", dueDate: "2026-12-01", status: "completed", workItems: [{ id: "item-1", title: "I1", status: "completed" }] },
    { id: "phase-2", title: "Phase 2", description: null, dri: null, dueDate: null, status: "in_progress", workItems: [] },
  ],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function servePlan(item: any) {
  mockGet.mockReturnValue({ promise: jest.fn().mockResolvedValue({ Item: item }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  signedInUser = "user-123";
  mockUpdate.mockImplementation((params: any) => ({
    promise: jest.fn().mockResolvedValue({ Attributes: { ...plan(), phases: params.ExpressionAttributeValues[":phases"], updatedAt: params.ExpressionAttributeValues[":updatedAt"] } }),
  }));
});

describe("send-status-report answers for what happened", () => {
  describe("plan report", () => {
    it("400 with success:false when nothing was sent because nobody could be emailed (it used to answer 'sent successfully')", async () => {
      servePlan(plan());
      mockPlanReport.mockResolvedValue({ recipients: 0, sent: 0, failed: 0 });
      const res = await request(app).post("/api/gtm-plan/plan-1/send-status-report").send({ notifications: {}, message: "hi" }).expect(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain("Nothing was emailed");
      expect(JSON.stringify(res.body)).not.toContain("successfully");
    });

    it("502 when the mail service refused every email", async () => {
      servePlan(plan());
      mockPlanReport.mockResolvedValue({ recipients: 2, sent: 0, failed: 2 });
      const res = await request(app).post("/api/gtm-plan/plan-1/send-status-report").send({ notifications: { notifyUser: true, notifyPlanPoc: true } }).expect(502);
      expect(res.body).toEqual({ success: false, error: expect.stringContaining("Nothing was delivered") });
    });

    it("200 with the counts when emails were accepted, and a partial send shows what failed", async () => {
      servePlan(plan());
      mockPlanReport.mockResolvedValue({ recipients: 3, sent: 2, failed: 1 });
      const res = await request(app).post("/api/gtm-plan/plan-1/send-status-report").send({ notifications: { notifyUser: true, notifyPlanPoc: true, notifyPhasePocs: true } }).expect(200);
      expect(res.body).toMatchObject({ success: true, sent: 2, failed: 1, suppressed: 0 });
      expect(res.body.message).toContain("2 of 3");
    });

    it("a send held back by the non-production email guard is not reported as sent", async () => {
      servePlan(plan());
      mockPlanReport.mockResolvedValue({ recipients: 2, sent: 0, failed: 0, suppressed: 2 });
      const res = await request(app).post("/api/gtm-plan/plan-1/send-status-report").send({ notifications: { notifyUser: true } }).expect(200);
      expect(res.body).toMatchObject({ success: true, sent: 0, suppressed: 2 });
      expect(res.body.message).toContain("NOT delivered");
    });

    it("passes the chosen options and the message through unchanged", async () => {
      servePlan(plan());
      mockPlanReport.mockResolvedValue({ recipients: 1, sent: 1, failed: 0 });
      await request(app).post("/api/gtm-plan/plan-1/send-status-report").send({ notifications: { notifyUser: true }, message: "Weekly" }).expect(200);
      expect(mockPlanReport).toHaveBeenCalledWith(expect.objectContaining({ planId: "plan-1" }), { notifyUser: true, message: "Weekly" }, undefined);
    });

    it("still refuses another user's plan (403) and a missing plan (404) before sending anything", async () => {
      servePlan({ ...plan(), userId: "someone-else" });
      await request(app).post("/api/gtm-plan/plan-1/send-status-report").send({ notifications: { notifyUser: true } }).expect(403);
      servePlan(undefined);
      await request(app).post("/api/gtm-plan/plan-1/send-status-report").send({ notifications: { notifyUser: true } }).expect(404);
      expect(mockPlanReport).not.toHaveBeenCalled();
    });
  });

  describe("phase report", () => {
    it("400 when nothing was sent, 502 when everything was refused, 200 with counts otherwise", async () => {
      servePlan(plan());
      mockPhaseReport.mockResolvedValueOnce({ recipients: 0, sent: 0, failed: 0 });
      const none = await request(app).post("/api/gtm-plan/plan-1/phases/phase-1/send-status-report").send({ notifications: {} }).expect(400);
      expect(none.body.success).toBe(false);

      mockPhaseReport.mockResolvedValueOnce({ recipients: 1, sent: 0, failed: 1 });
      await request(app).post("/api/gtm-plan/plan-1/phases/phase-1/send-status-report").send({ notifications: { notifyPhasePoc: true } }).expect(502);

      mockPhaseReport.mockResolvedValueOnce({ recipients: 1, sent: 1, failed: 0 });
      const ok = await request(app).post("/api/gtm-plan/plan-1/phases/phase-1/send-status-report").send({ notifications: { notifyPhasePoc: true } }).expect(200);
      expect(ok.body).toMatchObject({ success: true, sent: 1, failed: 0 });
    });

    it("a send held back by the non-production email guard is not reported as sent", async () => {
      servePlan(plan());
      mockPhaseReport.mockResolvedValueOnce({ recipients: 1, sent: 0, failed: 0, suppressed: 1 });
      const res = await request(app).post("/api/gtm-plan/plan-1/phases/phase-1/send-status-report").send({ notifications: { notifyPhasePoc: true } }).expect(200);
      expect(res.body).toMatchObject({ success: true, sent: 0, suppressed: 1 });
      expect(res.body.message).toContain("NOT delivered");
    });

    it("404 for a phase that is not in the plan, without sending", async () => {
      servePlan(plan());
      await request(app).post("/api/gtm-plan/plan-1/phases/phase-zzz/send-status-report").send({ notifications: { notifyUser: true } }).expect(404);
      expect(mockPhaseReport).not.toHaveBeenCalled();
    });
  });
});

describe("PUT /api/gtm-plan/:planId/phases/:phaseId", () => {
  const put = (body: any, path = "/api/gtm-plan/plan-1/phases/phase-1") => request(app).put(path).send(body);

  it("changes only the named fields of that phase and leaves the other phase, the work items and the phase status alone", async () => {
    servePlan(plan());
    const res = await put({ title: "  Launch  ", dri: "new@example.com" }).expect(200);
    expect(res.body.success).toBe(true);
    const written = mockUpdate.mock.calls[0][0];
    expect(written.Key).toEqual({ planId: "plan-1" });
    expect(written.UpdateExpression).toBe("SET #phases = :phases, #updatedAt = :updatedAt");
    const phases = written.ExpressionAttributeValues[":phases"];
    expect(phases[0]).toEqual({ ...plan().phases[0], title: "Launch", dri: "new@example.com" });
    // a completed phase stays completed after a rename (its status is derived from its work items, not from this route)
    expect(phases[0].status).toBe("completed");
    expect(phases[0].workItems).toEqual(plan().phases[0].workItems);
    expect(phases[1]).toEqual(plan().phases[1]);
    expect(res.body.data.phases[0].title).toBe("Launch");
  });

  it("an empty string clears description, dri and dueDate", async () => {
    servePlan(plan());
    await put({ description: "", dri: "", dueDate: "" }).expect(200);
    const phase = mockUpdate.mock.calls[0][0].ExpressionAttributeValues[":phases"][0];
    expect(phase).toMatchObject({ description: null, dri: null, dueDate: null });
    expect(phase.title).toBe("Phase 1");
  });

  it("400 when nothing to change is sent, or the title is empty or not text; nothing is read or written", async () => {
    const nothing = await put({}).expect(400);
    expect(nothing.body.error).toContain("Nothing to update");
    await put({ status: "completed" }).expect(400);
    await put({ title: "   " }).expect(400);
    await put({ title: 42 }).expect(400);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("400 when description, dri or dueDate is not text; nothing is read or written", async () => {
    for (const body of [{ description: 5 }, { description: { a: 1 } }, { dri: ["x"] }, { dri: 7 }, { dueDate: 20261231 }, { dueDate: { a: 1 } }, { description: true }]) {
      const res = await put(body).expect(400);
      expect(res.body.error).toMatch(/must be text/);
    }
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("null clears description, dri and dueDate like an empty string", async () => {
    servePlan(plan());
    await put({ description: null, dri: null, dueDate: null }).expect(200);
    expect(mockUpdate.mock.calls[0][0].ExpressionAttributeValues[":phases"][0]).toMatchObject({ description: null, dri: null, dueDate: null });
  });

  it("404 for a missing plan or phase, 403 for another user's plan; nothing is written", async () => {
    servePlan(undefined);
    await put({ title: "X" }).expect(404);
    servePlan(plan());
    await put({ title: "X" }, "/api/gtm-plan/plan-1/phases/phase-zzz").expect(404);
    servePlan({ ...plan(), userId: "someone-else" });
    await put({ title: "X" }).expect(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not shadow the work item route: PUT .../work-items/:id still reaches its own handler", async () => {
    servePlan(plan());
    // an unknown work item id is that route's own 404 ("Work item not found"); the phase route would have answered 400 for this body
    const res = await request(app).put("/api/gtm-plan/plan-1/phases/phase-1/work-items/item-zzz").send({ status: "completed" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Work item not found");
  });
});
