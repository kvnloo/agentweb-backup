/**
 * Integration tests for the outreach onboarding CRM-save route.
 *
 * Mocks the service layer (`saveOutreachProspects`) so we exercise the
 * auth + status-code shaping the route owns, without re-running the
 * crmDb lead-list / batch-create plumbing. The service itself is unit
 * tested separately in `outreachOnboardingSaveService.test.ts`.
 */
import request from "supertest";
import express from "express";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    if (req.headers["x-no-auth"] === "1") {
      req.user = undefined;
    } else {
      req.user = {
        userId: "user-1",
        email: "test@example.com",
        isAdmin: false,
      };
    }
    next();
  },
}));

jest.mock("../services/outreachOnboardingSaveService", () => ({
  saveOutreachProspects: jest.fn(),
}));

import outreachOnboardingRoutes from "../routes/outreachOnboarding";
const {
  saveOutreachProspects,
} = require("../services/outreachOnboardingSaveService");

const app = express();
app.use(express.json());
app.use("/api/onboarding", outreachOnboardingRoutes);

const validProspect = {
  id: "janedoe",
  name: "Jane Doe",
  linkedin_url: "https://www.linkedin.com/in/janedoe",
  headline: "Director of Growth",
  company: "Acme",
};

describe("POST /api/onboarding/outreach/save", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("401s when the user is not authenticated", async () => {
    const res = await request(app)
      .post("/api/onboarding/outreach/save")
      .set("x-no-auth", "1")
      .send({ icpId: "icp-1", prospects: [validProspect], drafts: {} });
    expect(res.status).toBe(401);
    expect(saveOutreachProspects).not.toHaveBeenCalled();
  });

  it("400s with code='no_prospects' when prospects array is empty", async () => {
    saveOutreachProspects.mockResolvedValue({
      ok: false,
      error: "no_prospects",
    });
    const res = await request(app)
      .post("/api/onboarding/outreach/save")
      .send({ icpId: "icp-1", prospects: [], drafts: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("no_prospects");
    // Empty prospects should be rejected at the route before hitting the
    // service, so the service is never invoked.
    expect(saveOutreachProspects).not.toHaveBeenCalled();
  });

  it("400s when prospects is missing / malformed", async () => {
    const res = await request(app)
      .post("/api/onboarding/outreach/save")
      .send({ icpId: "icp-1", drafts: {} });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("no_prospects");
    expect(saveOutreachProspects).not.toHaveBeenCalled();
  });

  it("502s when the underlying CRM service reports a crm_error", async () => {
    saveOutreachProspects.mockResolvedValue({
      ok: false,
      error: "crm_error",
      message: "DynamoDB unavailable",
    });
    const res = await request(app)
      .post("/api/onboarding/outreach/save")
      .send({ icpId: "icp-1", prospects: [validProspect], drafts: {} });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("crm_error");
    expect(res.body.message).toContain("DynamoDB");
  });

  it("returns 200 with leadListId on success", async () => {
    saveOutreachProspects.mockResolvedValue({
      ok: true,
      leadListId: "list_123",
    });
    const res = await request(app)
      .post("/api/onboarding/outreach/save")
      .send({
        icpId: "icp-1",
        prospects: [validProspect],
        drafts: { janedoe: "Hi Jane, loved your work at Acme." },
      });
    expect(res.status).toBe(200);
    expect(res.body.leadListId).toBe("list_123");
    expect(saveOutreachProspects).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        icpId: "icp-1",
        prospects: expect.arrayContaining([
          expect.objectContaining({ id: "janedoe" }),
        ]),
        drafts: expect.objectContaining({
          janedoe: "Hi Jane, loved your work at Acme.",
        }),
      }),
    );
  });

  it("500s when the service throws unexpectedly", async () => {
    saveOutreachProspects.mockRejectedValue(new Error("boom"));
    const res = await request(app)
      .post("/api/onboarding/outreach/save")
      .send({ icpId: "icp-1", prospects: [validProspect], drafts: {} });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("boom");
  });
});
