/**
 * POST /api/onboarding/outreach/draft-invites
 *
 * The route the onboarding drafts step calls to upgrade its instant template
 * pre-fill to LLM copy composed with the admin-editable system prompt.
 * Service layer is mocked — this owns auth, validation, and status shaping.
 */
import request from "supertest";
import express from "express";

jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: () => ({ promise: jest.fn() }),
      put: () => ({ promise: jest.fn() }),
    })),
  },
}));

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user =
      req.headers["x-no-auth"] === "1"
        ? undefined
        : { userId: "user-1", email: "test@example.com", isAdmin: false };
    next();
  },
}));

jest.mock("../services/outreachInviteDraftService", () => ({
  generateInviteDrafts: jest.fn(),
  DEFAULT_INVITE_CHAR_LIMIT: 200,
}));

// The route resolves the sending account's invite budget (300 Premium / 200
// free) before drafting. Mocked so these tests don't touch Unipile/Dynamo.
const mockListAccounts = jest.fn();
const mockGetCharLimit = jest.fn();
jest.mock("../services/linkedInOutreachService", () => ({
  linkedInOutreachService: {
    listUserOwnedUnipileAccountIds: (...a: any[]) => mockListAccounts(...a),
    getInviteCharLimitForAccount: (...a: any[]) => mockGetCharLimit(...a),
  },
  LinkedInOutreachService: {
    INVITE_MESSAGE_MAX_CHARS: 300,
    INVITE_MESSAGE_MAX_CHARS_FREE: 200,
  },
}));
jest.mock("../services/outreachInvitePromptService", () => ({
  getOutreachInvitePrompt: jest.fn(),
}));
jest.mock("../services/outreachProspectPreviewService", () => ({
  searchProspectsPreview: jest.fn(),
}));
jest.mock("../services/outreachOnboardingSaveService", () => ({
  saveOutreachProspects: jest.fn(),
}));

import outreachOnboardingRoutes from "../routes/outreachOnboarding";
const { generateInviteDrafts } = require("../services/outreachInviteDraftService");

const app = express();
app.use(express.json());
app.use("/api/onboarding", outreachOnboardingRoutes);

const URL = "/api/onboarding/outreach/draft-invites";

const PROSPECTS = [
  { id: "p-1", name: "Jane Doe", company: "Acme Schools" },
  { id: "p-2", name: "John Smith" },
];

beforeEach(() => {
  jest.clearAllMocks();
  generateInviteDrafts.mockResolvedValue({
    drafts: [{ prospectId: "p-1", message: "Hi Jane" }],
    promptVersion: "v3-2026-07-13",
    charLimit: 200,
  });
  mockListAccounts.mockResolvedValue(["acct-1"]);
  mockGetCharLimit.mockResolvedValue(200);
});

describe(`POST ${URL}`, () => {
  it("401s when the user is not authenticated", async () => {
    const res = await request(app)
      .post(URL)
      .set("x-no-auth", "1")
      .send({ prospects: PROSPECTS });
    expect(res.status).toBe(401);
    expect(generateInviteDrafts).not.toHaveBeenCalled();
  });

  it("400s when prospects is missing or not an array", async () => {
    const res = await request(app).post(URL).send({ icpName: "directors" });
    expect(res.status).toBe(400);
    expect(generateInviteDrafts).not.toHaveBeenCalled();
  });

  it("400s when a prospect has no id to key the draft back to", async () => {
    const res = await request(app)
      .post(URL)
      .send({ prospects: [{ name: "No Id" }] });
    expect(res.status).toBe(400);
    expect(generateInviteDrafts).not.toHaveBeenCalled();
  });

  it("returns 200 with an empty list for an empty prospect set (no LLM spend)", async () => {
    const res = await request(app).post(URL).send({ prospects: [] });
    expect(res.status).toBe(200);
    expect(res.body.drafts).toEqual([]);
    expect(res.body.charLimit).toBe(200);
    expect(generateInviteDrafts).not.toHaveBeenCalled();
  });

  it("passes brand + ICP + specs through and returns the drafts", async () => {
    const res = await request(app).post(URL).send({
      prospects: PROSPECTS,
      brandName: "Acme Outbound",
      icpName: "program directors",
      specs: "K-5, Bay Area",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      drafts: [{ prospectId: "p-1", message: "Hi Jane" }],
      promptVersion: "v3-2026-07-13",
      charLimit: 200,
    });

    const [prospects, ctx] = generateInviteDrafts.mock.calls[0];
    expect(prospects).toHaveLength(2);
    expect(ctx).toEqual({
      brandName: "Acme Outbound",
      icpName: "program directors",
      specs: "K-5, Bay Area",
      charLimit: 200,
      userId: "user-1",
    });
  });

  it("drafts to 300 chars for a Premium LinkedIn account", async () => {
    mockGetCharLimit.mockResolvedValue(300);

    const res = await request(app).post(URL).send({ prospects: PROSPECTS });

    expect(res.status).toBe(200);
    const [, ctx] = generateInviteDrafts.mock.calls[0];
    expect(ctx.charLimit).toBe(300);
  });

  it("falls back to the free 200 limit when no LinkedIn account resolves", async () => {
    mockListAccounts.mockResolvedValue([]);

    const res = await request(app).post(URL).send({ prospects: PROSPECTS });

    expect(res.status).toBe(200);
    const [, ctx] = generateInviteDrafts.mock.calls[0];
    expect(ctx.charLimit).toBe(200);
    expect(mockGetCharLimit).not.toHaveBeenCalled();
  });

  it("stays at the free limit when the user owns MULTIPLE accounts (sender ambiguous)", async () => {
    // The real send picks the lead list's assigned account, which doesn't exist
    // yet at draft time. With >1 owned account we can't know which sends, so we
    // must not over-promise a Premium 300-char budget.
    mockListAccounts.mockResolvedValue(["acct-1", "acct-2"]);

    const res = await request(app).post(URL).send({ prospects: PROSPECTS });

    expect(res.status).toBe(200);
    const [, ctx] = generateInviteDrafts.mock.calls[0];
    expect(ctx.charLimit).toBe(200);
    expect(mockGetCharLimit).not.toHaveBeenCalled();
  });

  it("falls back to the free limit when account lookup throws", async () => {
    mockListAccounts.mockRejectedValue(new Error("unipile down"));

    const res = await request(app).post(URL).send({ prospects: PROSPECTS });

    expect(res.status).toBe(200);
    const [, ctx] = generateInviteDrafts.mock.calls[0];
    expect(ctx.charLimit).toBe(200);
  });

  it("caps an oversized batch so one user cannot fan out unbounded LLM work", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: `p-${i}`,
      name: `N ${i}`,
    }));

    const res = await request(app).post(URL).send({ prospects: many });

    expect(res.status).toBe(200);
    const [prospects] = generateInviteDrafts.mock.calls[0];
    expect(prospects.length).toBeLessThanOrEqual(50);
  });

  it("degrades to an empty draft list (200, not 500) when the service throws", async () => {
    generateInviteDrafts.mockRejectedValueOnce(new Error("bedrock down"));

    const res = await request(app).post(URL).send({ prospects: PROSPECTS });

    // The drafts step must never break — the FE keeps its template pre-fill.
    expect(res.status).toBe(200);
    expect(res.body.drafts).toEqual([]);
  });
});
