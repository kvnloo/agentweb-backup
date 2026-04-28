import { syncNewUserToLeadList, syncUserUpdateToLeadList } from "../services/crmAutoSyncService";
import { settingsService } from "../services/settingsService";
import { crmDb } from "../services/db";

jest.mock("../services/settingsService", () => ({
  settingsService: {
    getSetting: jest.fn(),
    setSetting: jest.fn(),
  },
}));

jest.mock("../services/db", () => ({
  crmDb: {
    getLeadListById: jest.fn(),
    batchCreateLeads: jest.fn(),
    getLeadByEmail: jest.fn(),
    updateLead: jest.fn(),
  },
}));

const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

describe("crmAutoSyncService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const testUser = {
    userId: "user-1",
    email: "new@example.com",
    fullName: "Jane Doe",
    roles: ["customer"],
    isAdmin: false,
    createdAt: "2026-03-25T10:00:00.000Z",
    subscriptionType: "Free",
  };

  it("does nothing when no CRM sync setting exists", async () => {
    mockSettingsService.getSetting.mockResolvedValue(null as any);

    await syncNewUserToLeadList(testUser);

    expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
  });

  it("does nothing when autoSync is false", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-1", autoSync: false }),
    } as any);

    await syncNewUserToLeadList(testUser);

    expect(mockCrmDb.getLeadListById).not.toHaveBeenCalled();
    expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
  });

  it("does nothing when autoSync is not set (undefined)", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-1" }),
    } as any);

    await syncNewUserToLeadList(testUser);

    expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
  });

  it("does nothing when lead list does not exist", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-1", autoSync: true }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue(null as any);

    await syncNewUserToLeadList(testUser);

    expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
  });

  it("does nothing when lead list has public access disabled", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-1", autoSync: true }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-1",
      publicAccessEnabled: false,
    } as any);

    await syncNewUserToLeadList(testUser);

    expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
  });

  it("syncs user to lead list when autoSync is enabled", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-1", autoSync: true }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-1",
      publicAccessEnabled: true,
    } as any);
    mockCrmDb.batchCreateLeads.mockResolvedValue({
      successCount: 1,
      newCount: 1,
      mergedCount: 0,
      errorCount: 0,
      errors: [],
    } as any);

    await syncNewUserToLeadList(testUser);

    expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledWith("list-1", [
      expect.objectContaining({
        email: "new@example.com",
        firstName: "Jane",
        lastName: "Doe",
        customFields: expect.objectContaining({
          source: "admin_users",
          userId: "user-1",
          roles: "customer",
          isAdmin: "no",
          subscriptionType: "Free",
          chatSessionCount: 0,
          brandGuidelinesCompletedAt: "",
          lastActiveDate: "2026-03-25",
        }),
      }),
    ]);
  });

  it("does not throw when batchCreateLeads fails", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-1", autoSync: true }),
    } as any);
    mockCrmDb.getLeadListById.mockResolvedValue({
      listId: "list-1",
      publicAccessEnabled: true,
    } as any);
    mockCrmDb.batchCreateLeads.mockRejectedValue(new Error("DynamoDB error"));

    // Should not throw
    await expect(syncNewUserToLeadList(testUser)).resolves.toBeUndefined();
  });
});

describe("syncUserUpdateToLeadList", () => {
  const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;
  const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;

  const enabledSetting = {
    settingName: "admin_crm_sync_users",
    settingValue: JSON.stringify({ listId: "list-99", autoSync: true }),
  };
  const enabledList = { listId: "list-99", publicAccessEnabled: true };
  const existingLead = {
    leadId: "lead-abc",
    email: "user@example.com",
    customFields: { subscriptionType: "Free", source: "admin_users" },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("updates subscriptionType in the CRM lead when it changes", async () => {
    mockSettingsService.getSetting.mockResolvedValue(enabledSetting as any);
    mockCrmDb.getLeadListById.mockResolvedValue(enabledList as any);
    mockCrmDb.getLeadByEmail.mockResolvedValue(existingLead as any);
    mockCrmDb.updateLead.mockResolvedValue({} as any);

    await syncUserUpdateToLeadList("user@example.com", { subscriptionType: "Super Premium" });

    expect(mockCrmDb.updateLead).toHaveBeenCalledWith("list-99", "lead-abc", {
      customFields: expect.objectContaining({
        subscriptionType: "Super Premium",
        source: "admin_users",
      }),
    });
  });

  it("updates subscription_status in the CRM lead", async () => {
    mockSettingsService.getSetting.mockResolvedValue(enabledSetting as any);
    mockCrmDb.getLeadListById.mockResolvedValue(enabledList as any);
    mockCrmDb.getLeadByEmail.mockResolvedValue(existingLead as any);
    mockCrmDb.updateLead.mockResolvedValue({} as any);

    await syncUserUpdateToLeadList("user@example.com", { subscription_status: "canceled" });

    expect(mockCrmDb.updateLead).toHaveBeenCalledWith("list-99", "lead-abc", {
      customFields: expect.objectContaining({ subscription_status: "canceled" }),
    });
  });

  it("converts isActive=false to 'no' in customFields", async () => {
    mockSettingsService.getSetting.mockResolvedValue(enabledSetting as any);
    mockCrmDb.getLeadListById.mockResolvedValue(enabledList as any);
    mockCrmDb.getLeadByEmail.mockResolvedValue(existingLead as any);
    mockCrmDb.updateLead.mockResolvedValue({} as any);

    await syncUserUpdateToLeadList("user@example.com", { isActive: false });

    expect(mockCrmDb.updateLead).toHaveBeenCalledWith("list-99", "lead-abc", {
      customFields: expect.objectContaining({ isActive: "no" }),
    });
  });

  it("converts roles array to comma-separated string", async () => {
    mockSettingsService.getSetting.mockResolvedValue(enabledSetting as any);
    mockCrmDb.getLeadListById.mockResolvedValue(enabledList as any);
    mockCrmDb.getLeadByEmail.mockResolvedValue(existingLead as any);
    mockCrmDb.updateLead.mockResolvedValue({} as any);

    await syncUserUpdateToLeadList("user@example.com", { roles: ["free", "customer"] });

    expect(mockCrmDb.updateLead).toHaveBeenCalledWith("list-99", "lead-abc", {
      customFields: expect.objectContaining({ roles: "free,customer" }),
    });
  });

  it("does nothing when autoSync is disabled", async () => {
    mockSettingsService.getSetting.mockResolvedValue({
      settingName: "admin_crm_sync_users",
      settingValue: JSON.stringify({ listId: "list-99", autoSync: false }),
    } as any);

    await syncUserUpdateToLeadList("user@example.com", { subscriptionType: "Pro" });

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it("does nothing when lead does not exist in the list", async () => {
    mockSettingsService.getSetting.mockResolvedValue(enabledSetting as any);
    mockCrmDb.getLeadListById.mockResolvedValue(enabledList as any);
    mockCrmDb.getLeadByEmail.mockResolvedValue(null as any);

    await syncUserUpdateToLeadList("unknown@example.com", { subscriptionType: "Pro" });

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it("does nothing when no fields are supplied", async () => {
    mockSettingsService.getSetting.mockResolvedValue(enabledSetting as any);
    mockCrmDb.getLeadListById.mockResolvedValue(enabledList as any);
    mockCrmDb.getLeadByEmail.mockResolvedValue(existingLead as any);

    await syncUserUpdateToLeadList("user@example.com", {});

    expect(mockCrmDb.updateLead).not.toHaveBeenCalled();
  });

  it("does not throw when updateLead fails", async () => {
    mockSettingsService.getSetting.mockResolvedValue(enabledSetting as any);
    mockCrmDb.getLeadListById.mockResolvedValue(enabledList as any);
    mockCrmDb.getLeadByEmail.mockResolvedValue(existingLead as any);
    mockCrmDb.updateLead.mockRejectedValue(new Error("DynamoDB error"));

    await expect(
      syncUserUpdateToLeadList("user@example.com", { subscriptionType: "Pro" })
    ).resolves.toBeUndefined();
  });
});
