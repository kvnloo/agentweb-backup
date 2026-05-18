/**
 * Tests for org-shared HTML templates.
 *
 * GET /api/html-templates should include templates from org members when
 * htmlTemplates sharing is enabled. Authorization (PUT/DELETE) is enforced
 * via canEditItem / canViewItem from orgShareService.
 */
import request from "supertest";
import express from "express";

// ── Constants ────────────────────────────────────────────────────────────────

const mockUserId = "user-1";
const mockOrgMemberId = "user-2";
const mockEditorId = "user-3";
const mockOrgAdminId = "user-4";
const mockOtherOrgUserId = "user-5";
const mockOrgId = "org-abc";
const mockOtherOrgId = "org-xyz";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const myTemplate = {
  templateId: "tpl-1",
  userId: mockUserId,
  type: ["email"] as ("email" | "landing_page")[],
  name: "My Template",
  subject: "Hello",
  html: "<p>Hello</p>",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const memberTemplate = {
  templateId: "tpl-2",
  userId: mockOrgMemberId,
  type: ["email"] as ("email" | "landing_page")[],
  name: "Member Template",
  subject: "Member",
  html: "<p>Member</p>",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const publicTemplate = {
  templateId: "tpl-pub",
  userId: "admin-user",
  type: ["email"] as ("email" | "landing_page")[],
  name: "Public Template",
  html: "<p>Public</p>",
  isPublic: "true" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const otherOrgTemplate = {
  templateId: "tpl-other",
  userId: mockOtherOrgUserId,
  type: ["email"] as ("email" | "landing_page")[],
  name: "Other Org Template",
  html: "<p>Other</p>",
  createdAt: "2026-01-03T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
};

// Org with htmlTemplates sharing enabled; user-3 is an editor
const mockOrgEnabled = {
  orgId: mockOrgId,
  ownerUserId: mockOrgAdminId,
  shareSettings: {
    htmlTemplates: { enabled: true, editors: [mockEditorId] },
  },
};

// Org with htmlTemplates sharing disabled
const mockOrgDisabled = {
  orgId: mockOrgId,
  ownerUserId: mockOrgAdminId,
  shareSettings: {
    htmlTemplates: { enabled: false, editors: [] },
  },
};

// ── Service mocks ─────────────────────────────────────────────────────────────

const mockGetTemplate = jest.fn();
const mockGetTemplatesByOwner = jest.fn();
const mockGetPublicTemplates = jest.fn();
const mockCreateTemplate = jest.fn();
const mockUpdateTemplate = jest.fn();
const mockDeleteTemplate = jest.fn();

jest.mock("../services/htmlTemplateService", () => ({
  htmlTemplateService: {
    getTemplate: mockGetTemplate,
    getTemplatesByOwner: mockGetTemplatesByOwner,
    getPublicTemplates: mockGetPublicTemplates,
    createTemplate: mockCreateTemplate,
    updateTemplate: mockUpdateTemplate,
    deleteTemplate: mockDeleteTemplate,
  },
}));

jest.mock("aws-sdk", () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  },
  config: { update: jest.fn() },
}));

const mockGetUserById = jest.fn();
const mockGetOrgById = jest.fn();
const mockGetOrgMembers = jest.fn();

jest.mock("../services/db", () => ({
  userDb: { getUserById: mockGetUserById },
  orgDb: {
    getOrgById: mockGetOrgById,
    getOrgMembers: mockGetOrgMembers,
  },
}));

// Mock the template parser utilities (used in POST route for variable extraction)
jest.mock("../utils/templateParser", () => ({
  extractVariables: jest.fn().mockReturnValue({ variables: [], arrayVariables: [] }),
  parseTemplateArray: jest.fn().mockReturnValue([]),
}));

// Mock fs for preview route
jest.mock("fs", () => ({
  existsSync: jest.fn().mockReturnValue(false),
  promises: {
    readFile: jest.fn().mockResolvedValue("<html>legacy</html>"),
  },
}));

// ── App setup ─────────────────────────────────────────────────────────────────

import htmlTemplatesRouter from "../routes/htmlTemplates";

// Default app: authenticated as mockUserId (regular non-admin user)
const app = express();
app.use(express.json());
app.use("/api/html-templates", (req: any, _res: any, next: any) => {
  req.user = { userId: mockUserId, email: "user1@example.com", isAdmin: false };
  next();
}, htmlTemplatesRouter);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(userId: string, isAdmin = false) {
  const a = express();
  a.use(express.json());
  a.use("/api/html-templates", (req: any, _res: any, next: any) => {
    req.user = { userId, email: `${userId}@test.com`, isAdmin };
    next();
  }, htmlTemplatesRouter);
  return a;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/html-templates — org sharing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPublicTemplates.mockResolvedValue([]);
    mockGetOrgMembers.mockResolvedValue([
      { userId: mockUserId },
      { userId: mockOrgMemberId },
    ]);
  });

  // Scenario 1: Owner can GET their own templates
  it("owner can GET their own templates", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myTemplate]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.templateId);
    expect(ids).toContain("tpl-1");
  });

  // Scenario 2: Member can GET shared list (own + org-shared) when enabled
  it("includes org members' templates when htmlTemplates.enabled = true", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myTemplate]);
      if (uid === mockOrgMemberId) return Promise.resolve([memberTemplate]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.templateId);
    expect(ids).toContain("tpl-1");
    expect(ids).toContain("tpl-2");
  });

  // Scenario 3: Member sees only own + public when disabled
  it("returns only own + public templates when htmlTemplates.enabled = false", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgDisabled);
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myTemplate]);
      return Promise.resolve([memberTemplate]); // should not appear
    });
    mockGetPublicTemplates.mockResolvedValue([publicTemplate]);

    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.templateId);
    expect(ids).toContain("tpl-1");
    expect(ids).toContain("tpl-pub");
    expect(ids).not.toContain("tpl-2");
  });

  // Scenario 7: Public template is visible to any caller
  it("public templates are included for all callers", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId }); // no orgId
    mockGetTemplatesByOwner.mockResolvedValue([]);
    mockGetPublicTemplates.mockResolvedValue([publicTemplate]);

    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.templateId);
    expect(ids).toContain("tpl-pub");
  });

  it("response is wrapped in { items, truncated } envelope", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockGetTemplatesByOwner.mockResolvedValue([myTemplate]);

    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).toHaveProperty("truncated");
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("deduplicates templates appearing in both own and org results", async () => {
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    // Own and fanout both return myTemplate
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myTemplate]);
      return Promise.resolve([myTemplate]); // duplicate
    });

    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    const occurrences = res.body.items.filter((t: any) => t.templateId === "tpl-1").length;
    expect(occurrences).toBe(1);
  });
});

describe("POST /api/html-templates — create", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Scenario 1: Owner can POST to create
  it("owner can create a template", async () => {
    mockCreateTemplate.mockResolvedValue({
      ...myTemplate,
      templateId: "new-tpl",
    });

    const res = await request(app)
      .post("/api/html-templates")
      .send({
        template_name: "New Template",
        type: ["email"],
        html_content: "<p>New</p>",
        subject: "New Subject",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockCreateTemplate).toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/html-templates")
      .send({ template_name: "Missing fields" }); // no type, no html_content

    expect(res.status).toBe(400);
    expect(mockCreateTemplate).not.toHaveBeenCalled();
  });

  it("returns 400 when type is not a non-empty array", async () => {
    const res = await request(app)
      .post("/api/html-templates")
      .send({ template_name: "T", type: [], html_content: "<p/>" });

    expect(res.status).toBe(400);
  });

  it("returns 403 when non-admin tries to create a public template", async () => {
    const res = await request(app)
      .post("/api/html-templates")
      .send({
        template_name: "T",
        type: ["email"],
        html_content: "<p/>",
        isPublic: true,
      });

    expect(res.status).toBe(403);
  });
});

describe("GET /api/html-templates/:id — view single (org-share-aware)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Scenario 7: Public template is visible to any caller
  it("public template is visible to any caller without org check", async () => {
    mockGetTemplate.mockResolvedValue(publicTemplate);
    // No getUserById needed for public templates
    const res = await request(app).get("/api/html-templates/tpl-pub");
    expect(res.status).toBe(200);
    expect(res.body.templateId).toBe("tpl-pub");
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it("owner can view their own private template", async () => {
    mockGetTemplate.mockResolvedValue(myTemplate);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(app).get("/api/html-templates/tpl-1");
    expect(res.status).toBe(200);
    expect(res.body.templateId).toBe("tpl-1");
  });

  // Scenario 9: Different-org user cannot GET another org's templates
  it("returns 403 when template belongs to a different org", async () => {
    mockGetTemplate.mockResolvedValue(otherOrgTemplate);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOtherOrgUserId) return Promise.resolve({ userId: mockOtherOrgUserId, orgId: mockOtherOrgId });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(null);

    const res = await request(app).get("/api/html-templates/tpl-other");
    expect(res.status).toBe(403);
  });

  it("returns 404 when template does not exist", async () => {
    mockGetTemplate.mockResolvedValue(null);

    const res = await request(app).get("/api/html-templates/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/html-templates/:id — edit (org-share-aware)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Scenario 1: Owner can PUT their own template
  it("owner can edit their own template", async () => {
    mockGetTemplate.mockResolvedValue(myTemplate);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockUpdateTemplate.mockResolvedValue({ ...myTemplate, name: "Updated" });

    const res = await request(app)
      .put("/api/html-templates/tpl-1")
      .send({ name: "Updated" });

    expect(res.status).toBe(200);
    expect(mockUpdateTemplate).toHaveBeenCalled();
  });

  // Scenario 4: Editor (in shareSettings.htmlTemplates.editors) can PUT another member's template
  it("editor in shareSettings.htmlTemplates.editors can edit another member's template", async () => {
    const editorApp = makeApp(mockEditorId);
    mockGetTemplate.mockResolvedValue(memberTemplate);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockEditorId)
        return Promise.resolve({ userId: mockEditorId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId)
        return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockUpdateTemplate.mockResolvedValue({ ...memberTemplate, name: "Editor Updated" });

    const res = await request(editorApp)
      .put("/api/html-templates/tpl-2")
      .send({ name: "Editor Updated" });

    expect(res.status).toBe(200);
    expect(mockUpdateTemplate).toHaveBeenCalled();
  });

  // Scenario 5: Non-editor org member: 403 on PUT
  it("non-editor org member gets 403 when trying to edit another member's template", async () => {
    mockGetTemplate.mockResolvedValue(memberTemplate);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId)
        return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOrgMemberId)
        return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    // user-1 is NOT in the editors list
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(app)
      .put("/api/html-templates/tpl-2")
      .send({ name: "Hijacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateTemplate).not.toHaveBeenCalled();
  });

  // Scenario 6: Admin (orgRole === 'owner') can PUT any same-org template
  it("org admin (orgRole=owner) can edit any same-org member's template", async () => {
    const adminApp = makeApp(mockOrgAdminId);
    mockGetTemplate.mockResolvedValue(memberTemplate);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockOrgAdminId)
        return Promise.resolve({ userId: mockOrgAdminId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId)
        return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockUpdateTemplate.mockResolvedValue({ ...memberTemplate, name: "Admin Updated" });

    const res = await request(adminApp)
      .put("/api/html-templates/tpl-2")
      .send({ name: "Admin Updated" });

    expect(res.status).toBe(200);
    expect(mockUpdateTemplate).toHaveBeenCalled();
  });

  // Scenario 8: Public template PUT returns 403 (admin-managed)
  it("PUT on a public template returns 403 for non-admin", async () => {
    mockGetTemplate.mockResolvedValue(publicTemplate);

    const res = await request(app)
      .put("/api/html-templates/tpl-pub")
      .send({ name: "Hacked" });

    expect(res.status).toBe(403);
    expect(mockUpdateTemplate).not.toHaveBeenCalled();
  });

  it("returns 404 when template does not exist", async () => {
    mockGetTemplate.mockResolvedValue(null);

    const res = await request(app)
      .put("/api/html-templates/ghost")
      .send({ name: "Ghost" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/html-templates/:templateId — delete", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Scenario 1: Owner can DELETE their own template
  it("owner can delete their own template", async () => {
    mockGetTemplate.mockResolvedValue(myTemplate);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockDeleteTemplate.mockResolvedValue(undefined);

    const res = await request(app).delete("/api/html-templates/tpl-1");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockDeleteTemplate).toHaveBeenCalledWith("tpl-1");
  });

  // Scenario 6: Admin (orgRole === 'owner') can DELETE any same-org template
  it("org admin can delete another same-org member's template", async () => {
    const adminApp = makeApp(mockOrgAdminId);
    mockGetTemplate.mockResolvedValue(memberTemplate);
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockOrgAdminId)
        return Promise.resolve({ userId: mockOrgAdminId, orgId: mockOrgId, orgRole: "owner" });
      if (uid === mockOrgMemberId)
        return Promise.resolve({ userId: mockOrgMemberId, orgId: mockOrgId, orgRole: "member" });
      return Promise.resolve(null);
    });
    mockDeleteTemplate.mockResolvedValue(undefined);

    const res = await request(adminApp).delete("/api/html-templates/tpl-2");
    expect(res.status).toBe(200);
    expect(mockDeleteTemplate).toHaveBeenCalled();
  });

  // Scenario 8: Public template DELETE returns 403 (admin-managed)
  it("DELETE on a public template returns 403 for non-admin", async () => {
    mockGetTemplate.mockResolvedValue(publicTemplate);

    const res = await request(app).delete("/api/html-templates/tpl-pub");
    expect(res.status).toBe(403);
    expect(mockDeleteTemplate).not.toHaveBeenCalled();
  });

  it("system admin (isAdmin=true) can delete a public template", async () => {
    const sysAdminApp = makeApp(mockUserId, true); // isAdmin = true
    mockGetTemplate.mockResolvedValue(publicTemplate);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockDeleteTemplate.mockResolvedValue(undefined);

    const res = await request(sysAdminApp).delete("/api/html-templates/tpl-pub");
    expect(res.status).toBe(200);
    expect(mockDeleteTemplate).toHaveBeenCalled();
  });

  it("returns 404 when template does not exist", async () => {
    mockGetTemplate.mockResolvedValue(null);

    const res = await request(app).delete("/api/html-templates/ghost");
    expect(res.status).toBe(404);
  });

  it("regular member cannot delete another org member's template", async () => {
    mockGetTemplate.mockResolvedValue(memberTemplate);
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);

    const res = await request(app).delete("/api/html-templates/tpl-2");
    expect(res.status).toBe(403);
    expect(mockDeleteTemplate).not.toHaveBeenCalled();
  });
});

// Scenario 9: Different-org user cannot GET another org's private templates
describe("Cross-org access prevention", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("user from a different org cannot view a private template from another org", async () => {
    mockGetTemplate.mockResolvedValue(otherOrgTemplate); // belongs to org-xyz
    mockGetUserById.mockImplementation((uid: string) => {
      if (uid === mockUserId)
        return Promise.resolve({ userId: mockUserId, orgId: mockOrgId, orgRole: "member" });
      if (uid === mockOtherOrgUserId)
        return Promise.resolve({ userId: mockOtherOrgUserId, orgId: mockOtherOrgId });
      return Promise.resolve(null);
    });
    mockGetOrgById.mockResolvedValue(null);

    const res = await request(app).get("/api/html-templates/tpl-other");
    expect(res.status).toBe(403);
  });

  it("user from different org does NOT see other org's templates in list", async () => {
    // user-1 is in org-abc; the fanout only gets members of org-abc, not org-xyz
    mockGetUserById.mockResolvedValue({ userId: mockUserId, orgId: mockOrgId });
    mockGetOrgById.mockResolvedValue(mockOrgEnabled);
    mockGetOrgMembers.mockResolvedValue([
      { userId: mockUserId },
      { userId: mockOrgMemberId },
    ]); // only org-abc members, NOT mockOtherOrgUserId
    mockGetTemplatesByOwner.mockImplementation((uid: string) => {
      if (uid === mockUserId) return Promise.resolve([myTemplate]);
      if (uid === mockOrgMemberId) return Promise.resolve([memberTemplate]);
      return Promise.resolve([]);
    });
    mockGetPublicTemplates.mockResolvedValue([]);

    const res = await request(app).get("/api/html-templates");
    expect(res.status).toBe(200);
    const ids = res.body.items.map((t: any) => t.templateId);
    expect(ids).not.toContain("tpl-other");
  });
});
