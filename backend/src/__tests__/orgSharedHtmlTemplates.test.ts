/**
 * Tests for org-shared HTML templates (settings-based storage).
 *
 * GET  /api/html-templates       — fanout when shareSettings.htmlTemplates.enabled
 * GET  /api/html-templates/:id   — view with canViewItem check
 * POST /api/html-templates       — create (always own row)
 * PUT  /api/html-templates/:id   — update with canEditItem check
 * DELETE /api/html-templates/:id — owner or org owner only; editors cannot delete
 */
import request from "supertest";
import express from "express";

// ── Fixed test IDs ───────────────────────────────────────────────────────────
const mockUserId      = "user-1";
const mockOrgMemberId = "user-2";
const mockEditorId    = "user-3";
const mockOrgId       = "org-abc";

// ── Shared template fixtures ─────────────────────────────────────────────────
const myTpl = {
  template_id:   "tpl-1",
  template_name: "My Template",
  type:          ["email"],
  html_content:  "<p>Hi</p>",
  subject:       "Hi",
  variables:     [],
  arrayVariables:[],
  created_at:    "2026-01-01T00:00:00.000Z",
  updated_at:    "2026-01-01T00:00:00.000Z",
};

const memberTpl = {
  template_id:   "tpl-2",
  template_name: "Member Template",
  type:          ["email"],
  html_content:  "<p>Hello</p>",
  subject:       "Hello",
  variables:     [],
  arrayVariables:[],
  created_at:    "2026-01-02T00:00:00.000Z",
  updated_at:    "2026-01-02T00:00:00.000Z",
};

// ── Org fixture helpers ───────────────────────────────────────────────────────
const orgEnabled = {
  orgId: mockOrgId,
  ownerUserId: "org-owner",
  shareSettings: { htmlTemplates: { enabled: true, editors: [mockEditorId] } },
};
const orgDisabled = {
  orgId: mockOrgId,
  ownerUserId: "org-owner",
  shareSettings: { htmlTemplates: { enabled: false, editors: [] } },
};
const orgNoEditors = {
  orgId: mockOrgId,
  ownerUserId: "org-owner",
  shareSettings: { htmlTemplates: { enabled: true, editors: [] } },
};

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockGetTemplatesByOwner  = jest.fn();
const mockGetPublicTemplates   = jest.fn();
const mockGetTemplate          = jest.fn();
const mockGetPublicTemplate    = jest.fn();
const mockCreateTemplate       = jest.fn();
const mockUpdateTemplate       = jest.fn();
const mockDeleteTemplate       = jest.fn();
const mockTransferAllTemplates = jest.fn();
const mockDeleteAllTemplates   = jest.fn();

jest.mock("../services/htmlTemplateService", () => ({
  htmlTemplateService: {
    getTemplatesByOwner:  mockGetTemplatesByOwner,
    getPublicTemplates:   mockGetPublicTemplates,
    getTemplate:          mockGetTemplate,
    getPublicTemplate:    mockGetPublicTemplate,
    createTemplate:       mockCreateTemplate,
    updateTemplate:       mockUpdateTemplate,
    deleteTemplate:       mockDeleteTemplate,
    transferAllTemplates: mockTransferAllTemplates,
    deleteAllTemplates:   mockDeleteAllTemplates,
  },
}));

const mockGetUserById  = jest.fn();
const mockGetOrgById   = jest.fn();
const mockGetOrgMembers= jest.fn();
jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
  orgDb:  { getOrgById: mockGetOrgById, getOrgMembers: mockGetOrgMembers },
}));

// orgShareService — use real implementation (covers canViewItem, canEditItem, listOrgVisibleItems)
jest.unmock("../services/orgShareService");

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
    next();
  },
}));

import { authenticateToken } from "../middleware/auth";
import htmlTemplatesRouter from "../routes/htmlTemplates";

const app = express();
app.use(express.json());
app.use("/api/html-templates", authenticateToken, htmlTemplatesRouter);

// ── App with editor as the authenticated user ─────────────────────────────────
const editorApp = express();
editorApp.use(express.json());
editorApp.use("/api/html-templates", (req: any, _res: any, next: any) => {
  req.user = { userId: mockEditorId, email: "editor@example.com", isAdmin: false };
  next();
}, htmlTemplatesRouter);

// ── App with org owner as the authenticated user ──────────────────────────────
const orgOwnerUserId = "user-org-owner";
const orgOwnerApp = express();
orgOwnerApp.use(express.json());
orgOwnerApp.use("/api/html-templates", (req: any, _res: any, next: any) => {
  req.user = { userId: orgOwnerUserId, email: "orgowner@example.com", isAdmin: false };
  next();
}, htmlTemplatesRouter);

// ── Shared beforeEach ─────────────────────────────────────────────────────────
beforeEach(() => {
  jest.clearAllMocks();
  mockGetPublicTemplates.mockResolvedValue([]);
  mockGetOrgMembers.mockResolvedValue([
    { userId: mockUserId },
    { userId: mockOrgMemberId },
    { userId: mockEditorId },
  ]);
});

// ────────────────────────────────────────────────────────────────────────────
// GET / — list templates with fanout
// ────────────────────────────────────────────────────────────────────────────
describe("GET /api/html-templates — org sharing", () => {
  it("includes org members' templates when shareSettings.htmlTemplates.enabled is true", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(orgEnabled);
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId)      return Promise.resolve([myTpl]);
      if (uid === mockOrgMemberId) return Promise.resolve([memberTpl]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/html-templates");

    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.template_id);
    expect(ids).toContain("tpl-1");
    expect(ids).toContain("tpl-2");
  });

  it("does NOT include other-member templates when sharing is disabled", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(orgDisabled);
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myTpl]);
      return Promise.resolve([memberTpl]);
    });

    const res = await request(app).get("/api/html-templates");

    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.template_id);
    expect(ids).toContain("tpl-1");
    expect(ids).not.toContain("tpl-2");
  });

  it("returns only own templates when user is not in an org", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockGetTemplatesByOwner.mockResolvedValue([myTpl]);

    const res = await request(app).get("/api/html-templates");

    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.template_id);
    expect(ids).toContain("tpl-1");
    expect(ids).not.toContain("tpl-2");
    expect(mockGetOrgById).not.toHaveBeenCalled();
  });

  it("deduplicates templates that appear in both own and fanout results", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(orgEnabled);
    // caller's own result includes tpl-1; fanout for user-2 also returns tpl-1 + tpl-2
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId)      return Promise.resolve([myTpl]);
      if (uid === mockOrgMemberId) return Promise.resolve([myTpl, memberTpl]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/html-templates");

    expect(res.status).toBe(200);
    const tpl1Count = res.body.items.filter((t: any) => t.template_id === "tpl-1").length;
    expect(tpl1Count).toBe(1);
  });

  it("includes public templates regardless of org membership", async () => {
    const pubTpl = { ...memberTpl, template_id: "pub-1" };
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no org
    mockGetTemplatesByOwner.mockResolvedValue([myTpl]);
    mockGetPublicTemplates.mockResolvedValue([pubTpl]);

    const res = await request(app).get("/api/html-templates");

    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.template_id);
    expect(ids).toContain("pub-1");
    expect(res.body.items.find((t: any) => t.template_id === "pub-1").isPublic).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /?type=… — filter by template type
// ────────────────────────────────────────────────────────────────────────────
describe("GET /api/html-templates — type filter", () => {
  const emailTpl: any = { ...myTpl, template_id: "email-only", type: ["email"] };
  const lpTpl:    any = { ...myTpl, template_id: "lp-only",    type: ["landing_page"] };
  const bothTpl:  any = { ...myTpl, template_id: "both",       type: ["email", "landing_page"] };

  beforeEach(() => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // solo user — skip fanout
    mockGetTemplatesByOwner.mockImplementation((uid: string) =>
      uid === mockUserId ? Promise.resolve([emailTpl, lpTpl, bothTpl]) : Promise.resolve([]),
    );
    mockGetPublicTemplates.mockResolvedValue([]);
  });

  it("returns only email-typed templates when ?type=email", async () => {
    const res = await request(app).get("/api/html-templates?type=email");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.template_id).sort();
    expect(ids).toEqual(["both", "email-only"]);
  });

  it("returns only landing_page-typed templates when ?type=landing_page", async () => {
    const res = await request(app).get("/api/html-templates?type=landing_page");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.template_id).sort();
    expect(ids).toEqual(["both", "lp-only"]);
  });

  it("returns an empty list when ?type=<unknown>", async () => {
    const res = await request(app).get("/api/html-templates?type=bogus");
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("returns all templates when no ?type is provided", async () => {
    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.template_id).sort();
    expect(ids).toEqual(["both", "email-only", "lp-only"]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// POST / — create template
// ────────────────────────────────────────────────────────────────────────────
describe("POST /api/html-templates — create", () => {
  it("creates a template and returns 201", async () => {
    mockCreateTemplate.mockResolvedValue({
      ...myTpl,
      template_id: "new-tpl",
    });

    const res = await request(app).post("/api/html-templates").send({
      template_name: "My Template",
      type: ["email"],
      html_content: "<p>Hi</p>",
      subject: "Hi",
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.template.template_id).toBe("new-tpl");
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when html_content is missing", async () => {
    const res = await request(app).post("/api/html-templates").send({
      template_name: "Incomplete",
      type: ["email"],
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when template_name is missing", async () => {
    const res = await request(app).post("/api/html-templates").send({
      html_content: "<p>x</p>",
      type: ["email"],
    });

    expect(res.status).toBe(400);
  });

  it("accepts short field aliases (name + html)", async () => {
    mockCreateTemplate.mockResolvedValue({ ...myTpl, template_id: "alias-tpl" });

    const res = await request(app).post("/api/html-templates").send({
      name: "Alias Template",
      html: "<p>x</p>",
    });

    expect(res.status).toBe(201);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  // ── Org-level create gating ─────────────────────────────────────────────
  it("solo user (no orgId) can create — no gating", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockCreateTemplate.mockResolvedValue({ ...myTpl, template_id: "solo-tpl" });

    const res = await request(app).post("/api/html-templates").send({
      template_name: "Solo Template",
      type: ["email"],
      html_content: "<p>x</p>",
    });

    expect(res.status).toBe(201);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("org owner can always create", async () => {
    mockGetUserById.mockResolvedValue({ userId: orgOwnerUserId, orgId: mockOrgId, orgRole: "owner" });
    mockGetOrgById.mockResolvedValue(orgDisabled); // even with sharing disabled
    mockCreateTemplate.mockResolvedValue({ ...myTpl, template_id: "owner-tpl" });

    const res = await request(orgOwnerApp).post("/api/html-templates").send({
      template_name: "Owner Template",
      type: ["email"],
      html_content: "<p>x</p>",
    });

    expect(res.status).toBe(201);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("listed editor can create when shareSettings.htmlTemplates.enabled is true", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(orgEnabled); // enabled + editors=[editorId]
    mockCreateTemplate.mockResolvedValue({ ...myTpl, template_id: "editor-tpl" });

    const res = await request(editorApp).post("/api/html-templates").send({
      template_name: "Editor Template",
      type: ["email"],
      html_content: "<p>x</p>",
    });

    expect(res.status).toBe(201);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });

  it("non-editor org member gets 403 on create", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(orgEnabled); // user-1 not in editors

    const res = await request(app).post("/api/html-templates").send({
      template_name: "Member Attempt",
      type: ["email"],
      html_content: "<p>x</p>",
    });

    expect(res.status).toBe(403);
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("editor can create even when shareSettings.htmlTemplates.enabled is false", async () => {
    // `enabled` only gates visibility for plain members; editors have create
    // rights regardless of the toggle.
    mockGetUserById.mockResolvedValue({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue({
      ...orgDisabled,
      shareSettings: { htmlTemplates: { enabled: false, editors: [mockEditorId] } },
    });
    mockCreateTemplate.mockResolvedValue({ ...myTpl, template_id: "editor-disabled-tpl" });

    const res = await request(editorApp).post("/api/html-templates").send({
      template_name: "Editor Disabled",
      type: ["email"],
      html_content: "<p>x</p>",
    });

    expect(res.status).toBe(201);
    expect(mockCreateTemplate).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /:templateId — update
// ────────────────────────────────────────────────────────────────────────────
describe("PUT /api/html-templates/:templateId — update", () => {
  it("allows the template owner to update their own template", async () => {
    mockUpdateTemplate.mockResolvedValue({ ...myTpl, template_name: "Updated" });

    const res = await request(app)
      .put("/api/html-templates/tpl-1")
      .send({ template_name: "Updated" });

    expect(res.status).toBe(200);
    expect(res.body.template.template_name).toBe("Updated");
    expect(mockUpdateTemplate).toHaveBeenCalledWith(
      "tpl-1",
      mockUserId,
      expect.objectContaining({ template_name: "Updated" }),
      "user1@example.com",
    );
  });

  it("returns 404 when template is not found", async () => {
    mockUpdateTemplate.mockResolvedValue(null);

    const res = await request(app)
      .put("/api/html-templates/no-such")
      .send({ template_name: "x" });

    expect(res.status).toBe(404);
  });

  it("editor in editors list can update another member's template via ?ownerUserId=", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockEditorId) return Promise.resolve({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockUserId)   return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      ...orgEnabled,
      shareSettings: { htmlTemplates: { enabled: true, editors: [mockEditorId] } },
    });
    mockGetTemplate.mockResolvedValue(myTpl); // owned by user-1
    mockUpdateTemplate.mockResolvedValue({ ...myTpl, template_name: "Editor Updated" });

    const res = await request(editorApp)
      .put(`/api/html-templates/tpl-1?ownerUserId=${mockUserId}`)
      .send({ template_name: "Editor Updated" });

    expect(res.status).toBe(200);
    expect(mockUpdateTemplate).toHaveBeenCalled();
  });

  it("non-editor org member gets 403 when updating another member's template", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId)      return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(orgNoEditors);
    mockGetTemplate.mockResolvedValue(memberTpl); // owned by user-2

    const res = await request(app)
      .put(`/api/html-templates/tpl-2?ownerUserId=${mockOrgMemberId}`)
      .send({ template_name: "Hijacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateTemplate).not.toHaveBeenCalled();
  });

  it("org owner can update any same-org member's template", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === orgOwnerUserId)  return Promise.resolve({ userId: orgOwnerUserId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(orgNoEditors);
    mockGetTemplate.mockResolvedValue(memberTpl); // owned by user-2
    mockUpdateTemplate.mockResolvedValue({ ...memberTpl, template_name: "Owner Updated" });

    const res = await request(orgOwnerApp)
      .put(`/api/html-templates/tpl-2?ownerUserId=${mockOrgMemberId}`)
      .send({ template_name: "Owner Updated" });

    expect(res.status).toBe(200);
    expect(mockUpdateTemplate).toHaveBeenCalled();
  });

  it("cross-org member cannot update another org's template (403)", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId)      return Promise.resolve({ userId: mockUserId, orgId: "org-different", orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue({
      orgId: "org-different",
      ownerUserId: "x",
      shareSettings: { htmlTemplates: { enabled: true, editors: [mockUserId] } },
    });
    mockGetTemplate.mockResolvedValue(memberTpl); // owned by user-2 in org-abc

    const res = await request(app)
      .put(`/api/html-templates/tpl-2?ownerUserId=${mockOrgMemberId}`)
      .send({ template_name: "Cross-org hack" });

    expect(res.status).toBe(403);
    expect(mockUpdateTemplate).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /:templateId — delete
// ────────────────────────────────────────────────────────────────────────────
describe("DELETE /api/html-templates/:templateId — delete", () => {
  it("allows the template owner to delete their own template", async () => {
    mockDeleteTemplate.mockResolvedValue(true);

    const res = await request(app).delete("/api/html-templates/tpl-1");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDeleteTemplate).toHaveBeenCalledWith("tpl-1", mockUserId, "user1@example.com");
  });

  it("returns 404 when template is not found", async () => {
    mockDeleteTemplate.mockResolvedValue(false);

    const res = await request(app).delete("/api/html-templates/no-such");

    expect(res.status).toBe(404);
  });

  it("org owner can delete another member's template via ?ownerUserId=", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === orgOwnerUserId)  return Promise.resolve({ userId: orgOwnerUserId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    // Set this test's own org. Without it, the `org-different` fixture from the
    // preceding cross-org test leaks in (mockResolvedValue, no reset), so the
    // caller's orgId and the org being tested disagree. That used to be
    // invisible because roleOf ignored org identity entirely — which is the
    // bug ENG-954's tenant guard closes, so the leak now surfaces as a 403.
    mockGetOrgById.mockResolvedValue(orgEnabled);
    mockDeleteTemplate.mockResolvedValue(true);

    const res = await request(orgOwnerApp)
      .delete(`/api/html-templates/tpl-2?ownerUserId=${mockOrgMemberId}`);

    expect(res.status).toBe(200);
    expect(mockDeleteTemplate).toHaveBeenCalledWith("tpl-2", mockOrgMemberId, "orgowner@example.com");
  });

  it("editor cannot delete another member's template (403)", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockEditorId)    return Promise.resolve({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });

    const res = await request(editorApp)
      .delete(`/api/html-templates/tpl-2?ownerUserId=${mockOrgMemberId}`);

    expect(res.status).toBe(403);
    expect(mockDeleteTemplate).not.toHaveBeenCalled();
  });

  it("regular org member cannot delete another member's template (403)", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId)      return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });

    const res = await request(app)
      .delete(`/api/html-templates/tpl-2?ownerUserId=${mockOrgMemberId}`);

    expect(res.status).toBe(403);
    expect(mockDeleteTemplate).not.toHaveBeenCalled();
  });

  it("cross-org owner cannot delete a template in a different org (403)", async () => {
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === orgOwnerUserId)  return Promise.resolve({ userId: orgOwnerUserId, orgId: "org-different", orgRole: "owner" });
      if (uid === mockOrgMemberId) return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });

    const res = await request(orgOwnerApp)
      .delete(`/api/html-templates/tpl-2?ownerUserId=${mockOrgMemberId}`);

    expect(res.status).toBe(403);
    expect(mockDeleteTemplate).not.toHaveBeenCalled();
  });
});
