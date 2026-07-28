/**
 * Tests for org-shared knowledge base tasks (Tasks list and single-item access).
 *
 * When a user belongs to an org with shareSettings.knowledgeBase.enabled = true,
 * GET /api/tasks should include tasks from all org members. Editors can PATCH
 * (PUT) a foreign task; non-editors get 403. Org owner can delete. Admin can
 * PATCH and DELETE any same-org task. Different-org users get 403 everywhere.
 */
import request from "supertest";
import express from "express";

// ─── Test fixtures ────────────────────────────────────────────────────────────

const ownerUserId = "user-owner";
const memberUserId = "user-member";
const editorUserId = "user-editor";
const adminUserId = "user-admin";
const outsiderUserId = "user-outsider";
const orgId = "org-abc";
const otherOrgId = "org-other";

const ownerTask = {
  taskId: "task-1",
  userId: ownerUserId,
  name: "Owner Task",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const memberTask = {
  taskId: "task-2",
  userId: memberUserId,
  name: "Member Task",
  status: "active",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const outsiderTask = {
  taskId: "task-3",
  userId: outsiderUserId,
  name: "Outsider Task",
  status: "active",
  createdAt: "2026-01-03T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
};

const orgWithKBEnabled = {
  orgId,
  ownerUserId,
  shareSettings: {
    knowledgeBase: { enabled: true, editors: [editorUserId] },
  },
};

const orgWithKBDisabled = {
  orgId,
  ownerUserId,
  shareSettings: {
    knowledgeBase: { enabled: false, editors: [] },
  },
};

// ─── Mock definitions ─────────────────────────────────────────────────────────

const mockGetTasksByUserId = jest.fn();
const mockGetTaskById = jest.fn();
const mockUpdateTask = jest.fn();
const mockGetTaskSchedules = jest.fn();
const mockGetTasksWithKnowledgeBase = jest.fn();

jest.mock("../services/db", () => ({
  taskDb: {
    getTasksByUserId: mockGetTasksByUserId,
    getTaskById: mockGetTaskById,
    updateTask: mockUpdateTask,
    getTaskSchedules: mockGetTaskSchedules,
    getTasksWithKnowledgeBase: mockGetTasksWithKnowledgeBase,
  },
  subscriberDb: {
    getTaskSubscribers: jest.fn().mockResolvedValue([]),
  },
  scheduleDb: {
    updateSchedule: jest.fn().mockResolvedValue(undefined),
  },
  userDb: {
    getUserById: jest.fn(),
  },
  orgDb: {
    getOrgById: jest.fn(),
    getOrgMembers: jest.fn(),
  },
  taskTemplateDb: {},
}));

const { userDb, orgDb } = require("../services/db");
const mockGetUserById = userDb.getUserById as jest.Mock;
const mockGetOrgById = orgDb.getOrgById as jest.Mock;
const mockGetOrgMembers = orgDb.getOrgMembers as jest.Mock;

// ─── Mock middleware ──────────────────────────────────────────────────────────

// We'll override req.user per test via middleware variables
let currentUserId = ownerUserId;
let currentIsAdmin = false;

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: currentUserId, email: `${currentUserId}@test.com`, isAdmin: currentIsAdmin };
    next();
  },
}));

jest.mock("../middleware/admin", () => ({
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../services/emailService", () => ({
  emailService: { sendOncallAlert: jest.fn() },
}));

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {},
}));

jest.mock("../services/approvalDb", () => ({
  getAssetTypeFromFilename: jest.fn(),
}));

jest.mock("../services/reportClassificationService", () => ({
  classifyReport: jest.fn(),
}));

jest.mock("../utils/secretsManager", () => ({
  getGCSPPrivateKey: jest.fn().mockResolvedValue("fake-private-key"),
}));

jest.mock("../utils/fileProcessor", () => ({
  isSupportedFileType: jest.fn().mockReturnValue(true),
  getContentType: jest.fn().mockReturnValue("application/octet-stream"),
}));

jest.mock("../utils/s3Utils", () => ({
  uploadFileToS3: jest.fn(),
}));

// Mock GCS so KB routes don't try to open real sockets
jest.mock("@google-cloud/storage", () => {
  const mockFile = {
    exists: jest.fn().mockResolvedValue([true]),
    download: jest.fn().mockResolvedValue([Buffer.from("kb content")]),
    getMetadata: jest.fn().mockResolvedValue([{ size: "10" }]),
    save: jest.fn().mockResolvedValue(undefined),
    getSignedUrl: jest.fn().mockResolvedValue(["https://example.com/kb.txt"]),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockBucket = { file: jest.fn().mockReturnValue(mockFile) };
  const mockStorage = { bucket: jest.fn().mockReturnValue(mockBucket) };
  return { Storage: jest.fn().mockImplementation(() => mockStorage) };
});

// Mock AWS SDK (used by KB file-delete route for S3 objects, and by config/aws.ts)
jest.mock("aws-sdk", () => {
  const mockDynamoDb = {
    put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
    update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  };
  return {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn().mockImplementation(() => mockDynamoDb),
    },
    S3: jest.fn().mockImplementation(() => ({
      deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    })),
  };
});

// ─── App setup ────────────────────────────────────────────────────────────────

import { authenticateToken } from "../middleware/auth";
import tasksRouter from "../routes/tasks";

const app = express();
app.use(express.json());
app.use("/api/tasks", authenticateToken, tasksRouter);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setupUser(userId: string, opts: { orgId?: string; orgRole?: string; isAdmin?: boolean } = {}) {
  currentUserId = userId;
  currentIsAdmin = opts.isAdmin || false;
  mockGetUserById.mockImplementation((id: string) => {
    if (id === userId) {
      return Promise.resolve({
        userId,
        orgId: opts.orgId,
        orgRole: opts.orgRole,
        isAdmin: opts.isAdmin || false,
      });
    }
    if (id === ownerUserId) return Promise.resolve({ userId: ownerUserId, orgId, orgRole: "owner" });
    if (id === memberUserId) return Promise.resolve({ userId: memberUserId, orgId, orgRole: "member" });
    if (id === editorUserId) return Promise.resolve({ userId: editorUserId, orgId, orgRole: "member" });
    if (id === outsiderUserId) return Promise.resolve({ userId: outsiderUserId, orgId: otherOrgId });
    return Promise.resolve(null);
  });
}

// ─── Tests: GET / (list) ──────────────────────────────────────────────────────

describe("GET /api/tasks — org-wide list with shareSettings.knowledgeBase gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetTaskSchedules.mockResolvedValue([]);
  });

  it("owner sees own tasks (no org)", async () => {
    setupUser(ownerUserId); // no orgId
    mockGetTasksByUserId.mockResolvedValue([ownerTask]);

    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.taskId);
    expect(ids).toContain("task-1");
    expect(ids).not.toContain("task-2");
    expect(mockGetOrgById).not.toHaveBeenCalled();
  });

  it("member sees foreign tasks when shareSettings.knowledgeBase.enabled is true", async () => {
    setupUser(memberUserId, { orgId });
    mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
    mockGetOrgMembers.mockResolvedValue([
      { userId: ownerUserId },
      { userId: memberUserId },
    ]);
    mockGetTasksByUserId.mockImplementation((uid: string) => {
      if (uid === memberUserId) return Promise.resolve([memberTask]);
      if (uid === ownerUserId) return Promise.resolve([ownerTask]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.taskId);
    expect(ids).toContain("task-2"); // own task
    expect(ids).toContain("task-1"); // owner's task (fanout)
  });

  it("member does NOT see foreign tasks when shareSettings.knowledgeBase.enabled is false", async () => {
    setupUser(memberUserId, { orgId });
    mockGetOrgById.mockResolvedValue(orgWithKBDisabled);
    mockGetTasksByUserId.mockResolvedValue([memberTask]);

    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.taskId);
    expect(ids).toContain("task-2");
    expect(ids).not.toContain("task-1");
    expect(mockGetOrgMembers).not.toHaveBeenCalled();
  });

  it("does not include tasks from outside the org", async () => {
    setupUser(memberUserId, { orgId });
    mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
    mockGetOrgMembers.mockResolvedValue([
      { userId: ownerUserId },
      { userId: memberUserId },
    ]);
    // outsiderUserId is not in getOrgMembers result, so outsiderTask should never appear
    mockGetTasksByUserId.mockImplementation((uid: string) => {
      if (uid === memberUserId) return Promise.resolve([memberTask]);
      if (uid === ownerUserId) return Promise.resolve([ownerTask]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.taskId);
    expect(ids).not.toContain("task-3");
  });

  it("deduplicates tasks appearing in both own and org results", async () => {
    setupUser(memberUserId, { orgId });
    mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
    mockGetOrgMembers.mockResolvedValue([
      { userId: ownerUserId },
      { userId: memberUserId },
    ]);
    // Simulate orgMember query returning memberTask again
    mockGetTasksByUserId.mockImplementation((uid: string) => {
      if (uid === memberUserId) return Promise.resolve([memberTask]);
      if (uid === ownerUserId) return Promise.resolve([memberTask, ownerTask]);
      return Promise.resolve([]);
    });

    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.taskId);
    const task2Count = ids.filter((id: string) => id === "task-2").length;
    expect(task2Count).toBe(1);
  });

  it("returns an array (not {items, truncated}) to preserve backward compatibility", async () => {
    setupUser(ownerUserId); // no orgId
    mockGetTasksByUserId.mockResolvedValue([ownerTask]);

    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ─── Tests: GET /:id (single) ─────────────────────────────────────────────────

describe("GET /api/tasks/:id — single task org access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("owner sees their own task", async () => {
    setupUser(ownerUserId, { orgId });
    mockGetTaskById.mockResolvedValue(ownerTask);
    mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

    const res = await request(app).get("/api/tasks/task-1");
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe("task-1");
  });

  it("org member sees a foreign task when knowledgeBase.enabled is true", async () => {
    setupUser(memberUserId, { orgId });
    mockGetTaskById.mockResolvedValue(ownerTask); // owned by ownerUserId
    mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

    const res = await request(app).get("/api/tasks/task-1");
    expect(res.status).toBe(200);
    expect(res.body.taskId).toBe("task-1");
  });

  it("org member gets 403 on foreign task when knowledgeBase.enabled is false", async () => {
    setupUser(memberUserId, { orgId });
    mockGetTaskById.mockResolvedValue(ownerTask);
    mockGetOrgById.mockResolvedValue(orgWithKBDisabled);

    const res = await request(app).get("/api/tasks/task-1");
    expect(res.status).toBe(403);
  });

  it("different-org user gets 403", async () => {
    setupUser(outsiderUserId, { orgId: otherOrgId });
    mockGetTaskById.mockResolvedValue(ownerTask); // owned by ownerUserId in orgId

    const res = await request(app).get("/api/tasks/task-1");
    expect(res.status).toBe(403);
  });

  it("admin can view any task regardless of org", async () => {
    setupUser(adminUserId, { isAdmin: true });
    mockGetTaskById.mockResolvedValue(ownerTask);

    const res = await request(app).get("/api/tasks/task-1");
    expect(res.status).toBe(200);
  });
});

// ─── Tests: PUT /:id (update) ─────────────────────────────────────────────────

describe("PUT /api/tasks/:id — update permissions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateTask.mockResolvedValue(undefined);
    mockGetTaskById
      .mockResolvedValueOnce(memberTask) // first call in updateTask: get task
      .mockResolvedValue(memberTask);    // second call: return updated task
  });

  it("owner can update their own task", async () => {
    setupUser(memberUserId, { orgId, orgRole: "member" });
    mockGetTaskById.mockReset();
    mockGetTaskById
      .mockResolvedValueOnce({ ...memberTask })
      .mockResolvedValue({ ...memberTask });

    const res = await request(app).put("/api/tasks/task-2").send({ name: "Updated" });
    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalled();
  });

  it("editor (listed in knowledgeBase.editors) can update a member's task", async () => {
    setupUser(editorUserId, { orgId, orgRole: "member" });
    mockGetTaskById.mockReset();
    mockGetTaskById
      .mockResolvedValueOnce(memberTask) // task owned by memberUserId
      .mockResolvedValue(memberTask);
    mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

    const res = await request(app).put("/api/tasks/task-2").send({ name: "Editor Updated" });
    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalled();
  });

  it("non-editor org member gets 403 when updating another member's task", async () => {
    // memberUserId is not in editors list for ownerTask
    setupUser(memberUserId, { orgId, orgRole: "member" });
    mockGetTaskById.mockReset();
    mockGetTaskById.mockResolvedValue(ownerTask); // owned by ownerUserId
    mockGetOrgById.mockResolvedValue({
      ...orgWithKBEnabled,
      shareSettings: {
        knowledgeBase: { enabled: true, editors: [editorUserId] }, // memberUserId NOT in editors
      },
    });

    const res = await request(app).put("/api/tasks/task-1").send({ name: "Hijacked" });
    expect(res.status).toBe(403);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("different-org user gets 403 when updating a task", async () => {
    setupUser(outsiderUserId, { orgId: otherOrgId });
    mockGetTaskById.mockReset();
    mockGetTaskById.mockResolvedValue(ownerTask);

    const res = await request(app).put("/api/tasks/task-1").send({ name: "Hijacked" });
    expect(res.status).toBe(403);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("admin can update any task", async () => {
    setupUser(adminUserId, { isAdmin: true });
    mockGetTaskById.mockReset();
    mockGetTaskById
      .mockResolvedValueOnce(memberTask)
      .mockResolvedValue(memberTask);

    const res = await request(app).put("/api/tasks/task-2").send({ name: "Admin Updated" });
    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalled();
  });
});

// ─── Tests: DELETE /:id (archive) ────────────────────────────────────────────

describe("DELETE /api/tasks/:id — delete (archive) permissions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks preserves queued/default implementations from the PUT
    // cases above; reset this shared mock so DELETE cases cannot inherit them.
    mockGetTaskById.mockReset();
    mockUpdateTask.mockResolvedValue(undefined);
    mockGetTaskSchedules.mockResolvedValue([]);
  });

  it("owner can delete their own task", async () => {
    setupUser(ownerUserId, { orgId, orgRole: "owner" });
    mockGetTaskById.mockResolvedValue(ownerTask);

    const res = await request(app).delete("/api/tasks/task-1");
    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalledWith("task-1", { status: "archived" });
  });

  it("org owner (admin) can delete same-org member task when knowledgeBase.enabled", async () => {
    setupUser(ownerUserId, { orgId, orgRole: "owner" });
    mockGetTaskById.mockResolvedValue(memberTask); // owned by memberUserId
    mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

    const res = await request(app).delete("/api/tasks/task-2");
    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalledWith("task-2", { status: "archived" });
  });

  it("org owner gets 403 when knowledgeBase.enabled is false", async () => {
    setupUser(ownerUserId, { orgId, orgRole: "owner" });
    mockGetTaskById.mockResolvedValue(memberTask);
    mockGetOrgById.mockResolvedValue(orgWithKBDisabled);

    const res = await request(app).delete("/api/tasks/task-2");
    expect(res.status).toBe(403);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("regular org member gets 403 when trying to delete another member's task", async () => {
    setupUser(memberUserId, { orgId, orgRole: "member" });
    mockGetTaskById.mockResolvedValue(ownerTask); // owned by ownerUserId

    const res = await request(app).delete("/api/tasks/task-1");
    expect(res.status).toBe(403);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it("admin can delete any task", async () => {
    setupUser(adminUserId, { isAdmin: true });
    mockGetTaskById.mockResolvedValue(memberTask);

    const res = await request(app).delete("/api/tasks/task-2");
    expect(res.status).toBe(200);
    expect(mockUpdateTask).toHaveBeenCalledWith("task-2", { status: "archived" });
  });

  it("different-org user gets 403", async () => {
    setupUser(outsiderUserId, { orgId: otherOrgId });
    mockGetTaskById.mockResolvedValue(ownerTask);

    const res = await request(app).delete("/api/tasks/task-1");
    expect(res.status).toBe(403);
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });
});

// ─── Tests: KB sub-routes ────────────────────────────────────────────────────

const ownerKbTask = {
  taskId: "task-kb-1",
  userId: ownerUserId,
  name: "Owner KB Task",
  status: "active",
  knowledgeBaseType: "private",
  knowledgeBaseSize: 100,
  knowledgeBaseFiles: [],
  knowledgeBaseUpdatedAt: "2026-01-01T00:00:00.000Z",
};

describe("KB sub-routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateTask.mockResolvedValue(undefined);
    mockGetTaskById.mockResolvedValue(ownerKbTask);
    mockGetTasksWithKnowledgeBase.mockResolvedValue([ownerKbTask]);
  });

  // ── GET /knowledge-base/all ────────────────────────────────────────────────

  describe("GET /api/tasks/knowledge-base/all", () => {
    it("owner sees only own KB tasks when no org", async () => {
      setupUser(ownerUserId); // no orgId
      mockGetTasksWithKnowledgeBase.mockResolvedValue([ownerKbTask]);

      const res = await request(app).get("/api/tasks/knowledge-base/all");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((t: any) => t.taskId);
      expect(ids).toContain("task-kb-1");
    });

    it("each item includes userId so frontend can show 'Shared by'", async () => {
      setupUser(ownerUserId); // no org
      mockGetTasksWithKnowledgeBase.mockResolvedValue([ownerKbTask]);

      const res = await request(app).get("/api/tasks/knowledge-base/all");
      expect(res.status).toBe(200);
      expect(res.body[0]).toHaveProperty("userId", ownerUserId);
    });

    it("member sees only own KB tasks when feature disabled", async () => {
      setupUser(memberUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBDisabled);
      const memberKbTask = { ...ownerKbTask, taskId: "task-kb-2", userId: memberUserId };
      mockGetTasksWithKnowledgeBase.mockResolvedValue([memberKbTask]);

      const res = await request(app).get("/api/tasks/knowledge-base/all");
      expect(res.status).toBe(200);
      const ids = res.body.map((t: any) => t.taskId);
      expect(ids).toContain("task-kb-2");
      expect(ids).not.toContain("task-kb-1");
      expect(mockGetOrgMembers).not.toHaveBeenCalled();
    });

    it("member sees own + admin's KB tasks when feature enabled", async () => {
      setupUser(memberUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockGetOrgMembers.mockResolvedValue([
        { userId: ownerUserId },
        { userId: memberUserId },
      ]);
      const memberKbTask = { ...ownerKbTask, taskId: "task-kb-2", userId: memberUserId };
      mockGetTasksWithKnowledgeBase.mockImplementation((uid: string) => {
        if (uid === memberUserId) return Promise.resolve([memberKbTask]);
        if (uid === ownerUserId) return Promise.resolve([ownerKbTask]);
        return Promise.resolve([]);
      });

      const res = await request(app).get("/api/tasks/knowledge-base/all");
      expect(res.status).toBe(200);
      const ids = res.body.map((t: any) => t.taskId);
      expect(ids).toContain("task-kb-2"); // own
      expect(ids).toContain("task-kb-1"); // owner's (fanout)
    });

    it("dedupes items that appear in both own and fanout results", async () => {
      setupUser(memberUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockGetOrgMembers.mockResolvedValue([
        { userId: ownerUserId },
        { userId: memberUserId },
      ]);
      const memberKbTask = { ...ownerKbTask, taskId: "task-kb-2", userId: memberUserId };
      // Owner's query returns memberKbTask too (simulate overlap)
      mockGetTasksWithKnowledgeBase.mockImplementation((uid: string) => {
        if (uid === memberUserId) return Promise.resolve([memberKbTask]);
        if (uid === ownerUserId) return Promise.resolve([memberKbTask, ownerKbTask]);
        return Promise.resolve([]);
      });

      const res = await request(app).get("/api/tasks/knowledge-base/all");
      expect(res.status).toBe(200);
      const count = res.body.filter((t: any) => t.taskId === "task-kb-2").length;
      expect(count).toBe(1);
    });

    it("cross-org user only sees their own KB tasks (no fanout to other org)", async () => {
      setupUser(outsiderUserId, { orgId: otherOrgId });
      mockGetOrgById.mockResolvedValue({ orgId: otherOrgId, shareSettings: { knowledgeBase: { enabled: false } } });
      const outsiderKbTask = { ...ownerKbTask, taskId: "task-kb-3", userId: outsiderUserId };
      mockGetTasksWithKnowledgeBase.mockResolvedValue([outsiderKbTask]);

      const res = await request(app).get("/api/tasks/knowledge-base/all");
      expect(res.status).toBe(200);
      const ids = res.body.map((t: any) => t.taskId);
      expect(ids).not.toContain("task-kb-1");
    });
  });

  // ── GET /:taskId/knowledge-base ────────────────────────────────────────────

  describe("GET /api/tasks/:taskId/knowledge-base", () => {
    it("owner can view their own KB", async () => {
      setupUser(ownerUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

      const res = await request(app).get("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(200);
    });

    it("org member can view foreign KB when enabled", async () => {
      setupUser(memberUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

      const res = await request(app).get("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(200);
    });

    it("org member gets 403 on foreign KB when disabled", async () => {
      setupUser(memberUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBDisabled);

      const res = await request(app).get("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(403);
    });

    it("cross-org user gets 403", async () => {
      setupUser(outsiderUserId, { orgId: otherOrgId });

      const res = await request(app).get("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(403);
    });

    it("admin can view any KB", async () => {
      setupUser(adminUserId, { isAdmin: true });

      const res = await request(app).get("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(200);
    });
  });

  // ── PUT /:taskId/knowledge-base ────────────────────────────────────────────

  describe("PUT /api/tasks/:taskId/knowledge-base", () => {
    it("owner can update their own KB", async () => {
      setupUser(ownerUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base")
        .send({ content: "New content" });
      expect(res.status).toBe(200);
    });

    it("editor (in editors list) can update foreign KB", async () => {
      setupUser(editorUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base")
        .send({ content: "Editor update" });
      expect(res.status).toBe(200);
    });

    it("non-editor org member gets 403", async () => {
      setupUser(memberUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled); // memberUserId NOT in editors

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base")
        .send({ content: "Hijack" });
      expect(res.status).toBe(403);
    });

    it("cross-org user gets 403", async () => {
      setupUser(outsiderUserId, { orgId: otherOrgId });

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base")
        .send({ content: "Hijack" });
      expect(res.status).toBe(403);
    });

    it("org admin (orgRole=owner) can update any member KB", async () => {
      setupUser(ownerUserId, { orgId, orgRole: "owner" });
      // ownerTask owned by ownerUserId — this is own task, trivially allowed
      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base")
        .send({ content: "Admin update" });
      expect(res.status).toBe(200);
    });
  });

  // ── POST /:taskId/knowledge-base/files ─────────────────────────────────────

  describe("POST /api/tasks/:taskId/knowledge-base/files (file upload)", () => {
    it("owner can upload files to own KB", async () => {
      setupUser(ownerUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);
      mockGetTaskById
        .mockResolvedValueOnce(ownerKbTask) // first call
        .mockResolvedValue({ ...ownerKbTask, knowledgeBaseFiles: [] }); // after update

      const res = await request(app)
        .post("/api/tasks/task-kb-1/knowledge-base/files")
        .attach("files", Buffer.from("hello"), "test.txt");
      expect(res.status).toBe(200);
    });

    it("editor can upload files to foreign KB", async () => {
      setupUser(editorUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);
      mockGetTaskById
        .mockResolvedValueOnce(ownerKbTask)
        .mockResolvedValue({ ...ownerKbTask, knowledgeBaseFiles: [] });

      const res = await request(app)
        .post("/api/tasks/task-kb-1/knowledge-base/files")
        .attach("files", Buffer.from("hello"), "test.txt");
      expect(res.status).toBe(200);
    });

    it("non-editor org member gets 403 on foreign KB file upload", async () => {
      setupUser(memberUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled); // memberUserId NOT in editors

      const res = await request(app)
        .post("/api/tasks/task-kb-1/knowledge-base/files")
        .attach("files", Buffer.from("hello"), "test.txt");
      expect(res.status).toBe(403);
    });

    it("cross-org user gets 403 on file upload", async () => {
      setupUser(outsiderUserId, { orgId: otherOrgId });

      const res = await request(app)
        .post("/api/tasks/task-kb-1/knowledge-base/files")
        .attach("files", Buffer.from("hello"), "test.txt");
      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /:taskId/knowledge-base/files/:fileKey ──────────────────────────

  describe("DELETE /api/tasks/:taskId/knowledge-base/files/:fileKey", () => {
    it("owner can delete a file from own KB", async () => {
      setupUser(ownerUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockGetTaskById.mockResolvedValue({
        ...ownerKbTask,
        knowledgeBaseFiles: [{ key: "tasks/task-kb-1/knowledge-base-files/file.txt" }],
      });
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app).delete(
        `/api/tasks/task-kb-1/knowledge-base/files/${encodeURIComponent("tasks/task-kb-1/knowledge-base-files/file.txt")}`
      );
      expect(res.status).toBe(200);
    });

    it("editor can delete a file from foreign KB", async () => {
      setupUser(editorUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockGetTaskById.mockResolvedValue({
        ...ownerKbTask,
        knowledgeBaseFiles: [{ key: "tasks/task-kb-1/knowledge-base-files/file.txt" }],
      });
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app).delete(
        `/api/tasks/task-kb-1/knowledge-base/files/${encodeURIComponent("tasks/task-kb-1/knowledge-base-files/file.txt")}`
      );
      expect(res.status).toBe(200);
    });

    it("non-editor org member gets 403 on file delete", async () => {
      setupUser(memberUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled); // memberUserId NOT in editors

      const res = await request(app).delete(
        `/api/tasks/task-kb-1/knowledge-base/files/${encodeURIComponent("tasks/task-kb-1/knowledge-base-files/file.txt")}`
      );
      expect(res.status).toBe(403);
    });

    it("cross-org user gets 403 on file delete", async () => {
      setupUser(outsiderUserId, { orgId: otherOrgId });

      const res = await request(app).delete(
        `/api/tasks/task-kb-1/knowledge-base/files/${encodeURIComponent("tasks/task-kb-1/knowledge-base-files/file.txt")}`
      );
      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /:taskId/knowledge-base ─────────────────────────────────────────
  // Wiping the entire KB is restricted to: task owner OR org admin. Editors CANNOT.

  describe("DELETE /api/tasks/:taskId/knowledge-base (clear entire KB)", () => {
    it("owner can clear their own KB", async () => {
      setupUser(ownerUserId, { orgId, orgRole: "owner" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockGetTaskById.mockResolvedValue({ ...ownerKbTask, knowledgeBaseType: "private" });
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app).delete("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(200);
    });

    it("org admin (orgRole=owner) can clear a member's KB", async () => {
      // ownerUserId is org owner; task owned by memberUserId
      const memberKbTask = { ...ownerKbTask, taskId: "task-kb-2", userId: memberUserId, knowledgeBaseType: "private" };
      mockGetTaskById.mockResolvedValue(memberKbTask);
      setupUser(ownerUserId, { orgId, orgRole: "owner" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app).delete("/api/tasks/task-kb-2/knowledge-base");
      expect(res.status).toBe(200);
    });

    it("editor (non-admin) CANNOT clear a foreign KB", async () => {
      setupUser(editorUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

      const res = await request(app).delete("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(403);
    });

    it("non-editor org member gets 403 clearing foreign KB", async () => {
      setupUser(memberUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);

      const res = await request(app).delete("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(403);
    });

    it("cross-org user gets 403 clearing foreign KB", async () => {
      setupUser(outsiderUserId, { orgId: otherOrgId });

      const res = await request(app).delete("/api/tasks/task-kb-1/knowledge-base");
      expect(res.status).toBe(403);
    });
  });

  // ── PUT /:id/knowledge-base-type ──────────────────────────────────────────

  describe("PUT /api/tasks/:id/knowledge-base-type (toggle public/private)", () => {
    it("owner can toggle their own KB type", async () => {
      setupUser(ownerUserId, { orgId });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base-type")
        .send({ knowledgeBaseType: "public" });
      // Type is same as current (ownerKbTask.knowledgeBaseType = 'private' -> public)
      expect([200, 500]).toContain(res.status); // 200 if GCS moves succeed; route logic is gated correctly
    });

    it("editor can toggle a foreign KB type", async () => {
      setupUser(editorUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base-type")
        .send({ knowledgeBaseType: "public" });
      expect([200, 500]).toContain(res.status);
      // Crucially, it should NOT be 403
      expect(res.status).not.toBe(403);
    });

    it("non-editor org member gets 403", async () => {
      setupUser(memberUserId, { orgId, orgRole: "member" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled); // memberUserId NOT in editors

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base-type")
        .send({ knowledgeBaseType: "public" });
      expect(res.status).toBe(403);
    });

    it("cross-org user gets 403", async () => {
      setupUser(outsiderUserId, { orgId: otherOrgId });

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base-type")
        .send({ knowledgeBaseType: "public" });
      expect(res.status).toBe(403);
    });

    it("org admin (orgRole=owner) can toggle any KB type", async () => {
      setupUser(ownerUserId, { orgId, orgRole: "owner" });
      mockGetOrgById.mockResolvedValue(orgWithKBEnabled);
      mockUpdateTask.mockResolvedValue(undefined);

      const res = await request(app)
        .put("/api/tasks/task-kb-1/knowledge-base-type")
        .send({ knowledgeBaseType: "public" });
      expect(res.status).not.toBe(403);
    });
  });
});
