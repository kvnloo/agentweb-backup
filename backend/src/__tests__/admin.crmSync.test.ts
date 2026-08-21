import request from "supertest";
import express from "express";
import adminRoutes from "../routes/admin";
import { settingsService } from "../services/settingsService";
import { crmDb, userDb } from "../services/db";
import { waitlistDb } from "../services/waitlistDb";

jest.mock("../middleware/auth", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = {
      userId: "admin-user-1",
      email: "admin@example.com",
      isAdmin: true,
    };
    next();
  },
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

jest.mock("../services/db", () => ({
  userDb: {
    getAllUsers: jest.fn(),
  },
  taskDb: {},
  subscriberDb: {},
  crmDb: {
    getLeadListById: jest.fn(),
    batchCreateLeads: jest.fn(),
  },
}));

jest.mock("../services/waitlistDb", () => ({
  waitlistDb: {
    list: jest.fn(),
  },
}));

jest.mock("../services/chatbotService", () => ({
  chatbotDb: {},
}));

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockWaitlistDb = waitlistDb as jest.Mocked<typeof waitlistDb>;

const app = express();
app.use(express.json());
app.use("/api/admin", adminRoutes);

describe("Admin CRM sync routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWaitlistDb.list.mockResolvedValue({ items: [], lastEvaluatedKey: undefined } as any);
  });

  it("GET /api/admin/crm-sync/:source returns empty config when no setting exists", async () => {
    mockSettingsService.getSetting.mockResolvedValue(null as any);

    const res = await request(app)
      .get("/api/admin/crm-sync/users")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    expect(mockSettingsService.getSetting).toHaveBeenCalledWith("admin_crm_sync_users");
    expect(res.body).toEqual({
      source: "users",
      listId: "",
      lastSyncAt: null,
      autoSync: false,
    });
  });

  it("PUT /api/admin/crm-sync/:source saves listId and preserves prior lastSyncAt", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({
        listId: "old-list",
        lastSyncAt: "2026-02-10T10:00:00.000Z",
      }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "new-list",
      publicAccessEnabled: true,
    } as any);
    mockSettingsService.setSetting.mockResolvedValue(undefined as any);

    const res = await request(app)
      .put("/api/admin/crm-sync/users")
      .set("Authorization", "Bearer test-token")
      .send({ listId: "new-list" })
      .expect(200);

    expect(mockCrmDb.getLeadListById).toHaveBeenCalledWith("new-list");
    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      "admin_crm_sync_users",
      JSON.stringify({
        listId: "new-list",
        lastSyncAt: "2026-02-10T10:00:00.000Z",
      }),
      "Admin CRM sync setting for users",
      "admin@example.com"
    );
    expect(res.body.listId).toBe("new-list");
    expect(res.body.lastSyncAt).toBe("2026-02-10T10:00:00.000Z");
  });

  it("GET /api/admin/crm-sync/:source returns autoSync field", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({
        listId: "list-1",
        autoSync: true,
        lastSyncAt: "2026-03-25T00:00:00.000Z",
      }),
    } as any);

    const res = await request(app)
      .get("/api/admin/crm-sync/users")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    expect(res.body.autoSync).toBe(true);
    expect(res.body.listId).toBe("list-1");
  });

  it("GET /api/admin/crm-sync/:source defaults autoSync to false when not set", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-1" }),
    } as any);

    const res = await request(app)
      .get("/api/admin/crm-sync/users")
      .set("Authorization", "Bearer test-token")
      .expect(200);

    expect(res.body.autoSync).toBe(false);
  });

  it("PUT /api/admin/crm-sync/:source saves autoSync flag", async () => {
    mockSettingsService.getSetting.mockResolvedValue(null as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-1",
      publicAccessEnabled: true,
    } as any);
    mockSettingsService.setSetting.mockResolvedValue(undefined as any);

    const res = await request(app)
      .put("/api/admin/crm-sync/users")
      .set("Authorization", "Bearer test-token")
      .send({ listId: "list-1", autoSync: true })
      .expect(200);

    expect(res.body.autoSync).toBe(true);
    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      "admin_crm_sync_users",
      expect.stringContaining('"autoSync":true'),
      expect.any(String),
      expect.any(String)
    );
  });

  it("PUT /api/admin/crm-sync/:source preserves existing autoSync when not provided", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "old-list", autoSync: true }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "new-list",
      publicAccessEnabled: true,
    } as any);
    mockSettingsService.setSetting.mockResolvedValue(undefined as any);

    const res = await request(app)
      .put("/api/admin/crm-sync/users")
      .set("Authorization", "Bearer test-token")
      .send({ listId: "new-list" })
      .expect(200);

    expect(res.body.autoSync).toBe(true);
    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      "admin_crm_sync_users",
      expect.stringContaining('"autoSync":true'),
      expect.any(String),
      expect.any(String)
    );
  });

  it("POST /api/admin/crm-sync/:source/start performs incremental users sync and updates lastSyncAt on success", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({
        listId: "list-1",
        lastSyncAt: "2026-02-10T00:00:00.000Z",
        autoSync: true,
      }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-1",
      publicAccessEnabled: true,
    } as any);
    mockUserDb.getAllUsers.mockResolvedValue([
      {
        userId: "old-user",
        email: "old@example.com",
        isAdmin: false,
        isActive: true,
        roles: ["customer"],
        createdAt: "2026-02-09T23:00:00.000Z",
      },
      {
        userId: "new-user",
        email: "new@example.com",
        isAdmin: false,
        isActive: true,
        roles: ["customer"],
        createdAt: "2026-02-10T01:00:00.000Z",
      },
    ] as any);
    mockCrmDb.batchCreateLeads.mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 0,
      errorCount: 0,
      errors: [],
    } as any);
    mockSettingsService.setSetting.mockResolvedValue(undefined as any);

    const res = await request(app)
      .post("/api/admin/crm-sync/users/start")
      .set("Authorization", "Bearer test-token")
      .send({ forceFullSync: false })
      .expect(200);

    expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledTimes(1);
    expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledWith(
      "list-1",
      expect.arrayContaining([
        expect.objectContaining({
          email: "new@example.com",
          customFields: expect.objectContaining({
            brandGuidelinesCompletedAt: "",
            chatSessionCount: 0
          })
        }),
      ])
    );
    expect(res.body.attemptedCount).toBe(1);
    expect(res.body.successCount).toBe(1);
    expect(res.body.errorCount).toBe(0);
    expect(typeof res.body.lastSyncAt).toBe("string");
    expect(mockSettingsService.setSetting).toHaveBeenCalledTimes(1);
    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      "admin_crm_sync_users",
      expect.stringContaining('"autoSync":true'),
      expect.any(String),
      expect.any(String)
    );
  });

  // ENG-1002: this route reports attemptedCount outright, so a refused
  // placeholder row must be named or the caller sees attempted > everything
  // reported with no explanation for the difference.
  it("POST /api/admin/crm-sync/:source/start accounts for rows refused as LinkedIn placeholders", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({
        listId: "list-1",
        lastSyncAt: "2026-02-10T00:00:00.000Z",
        autoSync: false,
      }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-1",
      publicAccessEnabled: true,
    } as any);
    mockUserDb.getAllUsers.mockResolvedValue([
      {
        userId: "new-user",
        email: "new@example.com",
        isAdmin: false,
        isActive: true,
        roles: ["customer"],
        createdAt: "2026-02-10T01:00:00.000Z",
      },
      {
        userId: "placeholder-user",
        email: "placeholder@example.com",
        isAdmin: false,
        isActive: true,
        roles: ["customer"],
        createdAt: "2026-02-10T02:00:00.000Z",
      },
    ] as any);
    mockCrmDb.batchCreateLeads.mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 0,
      errorCount: 0,
      anonymizedSkipped: 1,
      errors: [],
    } as any);
    mockSettingsService.setSetting.mockResolvedValue(undefined as any);

    const res = await request(app)
      .post("/api/admin/crm-sync/users/start")
      .set("Authorization", "Bearer test-token")
      .send({ forceFullSync: false })
      .expect(200);

    expect(res.body.attemptedCount).toBe(2);
    expect(res.body.anonymizedSkipped).toBe(1);
    // attempted must equal what the response accounts for.
    expect(res.body.successCount + res.body.errorCount + res.body.anonymizedSkipped).toBe(
      res.body.attemptedCount
    );
    expect(res.body.message).toContain("1 anonymized LinkedIn placeholder(s) skipped");
  });

  it("POST /api/admin/crm-sync/:source/start does not update lastSyncAt when sync has errors", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_waitlist",
      settingValue: JSON.stringify({
        listId: "list-2",
        lastSyncAt: "2026-02-10T00:00:00.000Z",
      }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-2",
      publicAccessEnabled: true,
    } as any);
    mockWaitlistDb.list.mockResolvedValue({
      items: [
        {
          email: "wait@example.com",
          joinedAt: "2026-02-10T12:00:00.000Z",
          status: "pending",
        },
      ],
      lastEvaluatedKey: undefined,
    } as any);
    mockCrmDb.batchCreateLeads.mockResolvedValue({
      successCount: 0,
      newCount: 0,
      mergedCount: 0,
      errorCount: 1,
      errors: ["failed row"],
    } as any);

    const res = await request(app)
      .post("/api/admin/crm-sync/waitlist/start")
      .set("Authorization", "Bearer test-token")
      .send({ forceFullSync: true })
      .expect(200);

    expect(res.body.errorCount).toBe(1);
    expect(res.body.lastSyncAt).toBe("2026-02-10T00:00:00.000Z");
    expect(mockSettingsService.setSetting).not.toHaveBeenCalled();
  });

  it("POST /api/admin/crm-sync/:source/start preserves autoSync flag when updating lastSyncAt", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({
        listId: "list-1",
        lastSyncAt: "2026-02-10T00:00:00.000Z",
        autoSync: true,
      }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-1",
      publicAccessEnabled: true,
    } as any);
    mockUserDb.getAllUsers.mockResolvedValue([
      {
        userId: "u1",
        email: "u1@example.com",
        isAdmin: false,
        isActive: true,
        roles: ["customer"],
        createdAt: "2026-02-10T01:00:00.000Z",
      },
    ] as any);
    mockCrmDb.batchCreateLeads.mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 0,
      errorCount: 0,
      errors: [],
    } as any);
    mockSettingsService.setSetting.mockResolvedValue(undefined as any);

    await request(app)
      .post("/api/admin/crm-sync/users/start")
      .set("Authorization", "Bearer test-token")
      .send({ forceFullSync: false })
      .expect(200);

    expect(mockSettingsService.setSetting).toHaveBeenCalledWith(
      "admin_crm_sync_users",
      expect.stringContaining('"autoSync":true'),
      expect.any(String),
      expect.any(String)
    );
  });
});
