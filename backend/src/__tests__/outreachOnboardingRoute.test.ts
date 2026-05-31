/**
 * Integration tests for the outreach prospect-preview onboarding route.
 * Mocks the service layer so we exercise the auth + status-code shaping
 * the route owns, without re-running Unipile + DB plumbing.
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

jest.mock("../services/outreachProspectPreviewService", () => ({
  searchProspectsPreview: jest.fn(),
}));

import outreachOnboardingRoutes from "../routes/outreachOnboarding";
const {
  searchProspectsPreview,
} = require("../services/outreachProspectPreviewService");

const app = express();
app.use(express.json());
app.use("/api/onboarding", outreachOnboardingRoutes);

describe("POST /api/onboarding/outreach/preview-prospects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("401s when the user is not authenticated", async () => {
    const res = await request(app)
      .post("/api/onboarding/outreach/preview-prospects")
      .set("x-no-auth", "1")
      .send({ icp: "Founders" });
    expect(res.status).toBe(401);
    expect(searchProspectsPreview).not.toHaveBeenCalled();
  });

  it("400s with code='no_filters' when service rejects empty input", async () => {
    searchProspectsPreview.mockResolvedValue({
      ok: false,
      error: "no_filters",
    });
    const res = await request(app)
      .post("/api/onboarding/outreach/preview-prospects")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("no_filters");
  });

  it("returns 200 with empty items + noLinkedInAccount=true on no_linkedin_account", async () => {
    searchProspectsPreview.mockResolvedValue({
      ok: false,
      error: "no_linkedin_account",
    });
    const res = await request(app)
      .post("/api/onboarding/outreach/preview-prospects")
      .send({ icp: "Founders", specifications: "B2B SaaS" });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.noLinkedInAccount).toBe(true);
    expect(res.body.linkedinConnected).toBe(false);
  });

  it("502s on unipile_error", async () => {
    searchProspectsPreview.mockResolvedValue({
      ok: false,
      error: "unipile_error",
      message: "Unipile rate limited",
    });
    const res = await request(app)
      .post("/api/onboarding/outreach/preview-prospects")
      .send({ icp: "Founders", specifications: "B2B SaaS" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("unipile_error");
    expect(res.body.message).toContain("rate limited");
  });

  it("returns 200 with mapped items + linkedinConnected on success", async () => {
    searchProspectsPreview.mockResolvedValue({
      ok: true,
      items: [
        {
          id: "janedoe",
          name: "Jane Doe",
          linkedin_url: "https://www.linkedin.com/in/janedoe",
          headline: "Director of Growth",
          location: "Bay Area",
          public_identifier: "janedoe",
        },
      ],
      linkedinConnected: true,
      cursor: "cur-1",
    });
    const res = await request(app)
      .post("/api/onboarding/outreach/preview-prospects")
      .send({
        icp: "Educators",
        specifications: "K-5 Bay Area program directors",
      });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].linkedin_url).toBe(
      "https://www.linkedin.com/in/janedoe",
    );
    expect(res.body.linkedinConnected).toBe(true);
    expect(res.body.cursor).toBe("cur-1");
    expect(searchProspectsPreview).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        icp: "Educators",
        specifications: "K-5 Bay Area program directors",
      }),
    );
  });

  it("500s when the service throws unexpectedly", async () => {
    searchProspectsPreview.mockRejectedValue(new Error("boom"));
    const res = await request(app)
      .post("/api/onboarding/outreach/preview-prospects")
      .send({ icp: "Founders", specifications: "B2B SaaS" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("boom");
  });

  it("ignores non-numeric `limit` field", async () => {
    searchProspectsPreview.mockResolvedValue({
      ok: true,
      items: [],
      linkedinConnected: false,
    });
    await request(app)
      .post("/api/onboarding/outreach/preview-prospects")
      .send({
        icp: "Founders",
        specifications: "B2B SaaS",
        limit: "not-a-number" as any,
      });
    const callArg = searchProspectsPreview.mock.calls[0][1];
    expect(callArg.limit).toBeUndefined();
  });
});
