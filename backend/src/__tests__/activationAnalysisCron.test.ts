import { runActivationAnalysis } from '../cron/activationAnalysisCron';
import { userDb, crmDb } from '../services/db';
import { settingsService } from '../services/settingsService';

// Mock dependencies
jest.mock('../services/db', () => ({
    userDb: {
        getAllUsers: jest.fn(),
    },
    crmDb: {
        getLeadListById: jest.fn(),
        batchCreateLeads: jest.fn(),
    },
}));

jest.mock('../services/settingsService', () => ({
    settingsService: {
        getSetting: jest.fn(),
        setSetting: jest.fn(),
    },
}));

describe('ActivationAnalysisCron', () => {
    const mockUserDb = userDb as jest.Mocked<typeof userDb>;
    const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
    const mockSettingsService = settingsService as jest.Mocked<typeof settingsService>;

    beforeEach(() => {
        jest.clearAllMocks();

        // Default mock implementations
        mockSettingsService.getSetting.mockImplementation(async (key: string) => {
            if (key === 'admin_crm_sync_users') {
                return { settingName: key, settingValue: JSON.stringify({ listId: 'test-list-id' }), updatedAt: '', updatedBy: '' };
            }
            return null;
        });

        mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'test-list-id', publicAccessEnabled: true } as any);

        mockCrmDb.batchCreateLeads.mockResolvedValue({
            successCount: 4,
            newCount: 4,
            mergedCount: 0,
            errorCount: 0,
            errors: []
        } as any);
    });

    const RECENT_DATE = new Date().toISOString();
    const OLD_DATE = new Date('2020-01-01T00:00:00Z').toISOString();
    // lastActiveDate falls back to createdAt when lastLoginTime/lastActiveAt are absent
    const RECENT_DATE_DAY = RECENT_DATE.split('T')[0];
    const OLD_DATE_DAY = '2020-01-01';

    it('should correctly process all users and map the new metrics', async () => {
        // chatSessionCount is returned by userDb.getAllUsers() (UserWithCounts)
        mockUserDb.getAllUsers.mockResolvedValue([
            { userId: 'u1', email: 'user1@test.com', createdAt: RECENT_DATE, brandGuidelines: undefined, chatSessionCount: 0 } as any,
            { userId: 'u2', email: 'user2@test.com', createdAt: RECENT_DATE, brandGuidelines: { createdAt: '2026-03-01' }, chatSessionCount: 0 } as any,
            { userId: 'u3', email: 'user3@test.com', createdAt: RECENT_DATE, brandGuidelines: { createdAt: '2026-03-02' }, chatSessionCount: 5 } as any,
            { userId: 'u4', email: 'old@test.com', createdAt: OLD_DATE, brandGuidelines: undefined, chatSessionCount: 0 } as any,
        ]);

        await runActivationAnalysis();

        // Verify it fetches users
        expect(mockUserDb.getAllUsers).toHaveBeenCalled();

        // Verify CRM batch update payload
        expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledWith('test-list-id', expect.arrayContaining([
            expect.objectContaining({
                email: 'user1@test.com',
                customFields: expect.objectContaining({
                    chatSessionCount: 0,
                    brandGuidelinesCompletedAt: '',
                    lastActiveDate: RECENT_DATE_DAY,
                })
            }),
            expect.objectContaining({
                email: 'user2@test.com',
                customFields: expect.objectContaining({
                    chatSessionCount: 0,
                    brandGuidelinesCompletedAt: '2026-03-01',
                    lastActiveDate: RECENT_DATE_DAY,
                })
            }),
            expect.objectContaining({
                email: 'user3@test.com',
                customFields: expect.objectContaining({
                    chatSessionCount: 5,
                    brandGuidelinesCompletedAt: '2026-03-02',
                    lastActiveDate: RECENT_DATE_DAY,
                })
            }),
            expect.objectContaining({
                email: 'old@test.com',
                customFields: expect.objectContaining({
                    chatSessionCount: 0,
                    brandGuidelinesCompletedAt: '',
                    lastActiveDate: OLD_DATE_DAY,
                })
            })
        ]), { origin: 'integration' });

        // Ensure all users are included in the CRM payload
        const batchCreateArgs = mockCrmDb.batchCreateLeads.mock.calls[0][1];
        expect(batchCreateArgs).toHaveLength(4);
    });

    // ENG-1907: a sandbox account never finishes brand onboarding by design, so without
    // this it would be synced into the internal CRM list as a "stuck" customer and nudged.
    it('never syncs a sandbox (eval_) principal into the CRM lead list', async () => {
        mockUserDb.getAllUsers.mockResolvedValue([
            { userId: 'u1', email: 'user1@test.com', createdAt: RECENT_DATE, chatSessionCount: 0 } as any,
            { userId: 'eval_4c4c4c4c-0000-4000-8000-000000000000', email: 'candidate@example.invalid', createdAt: RECENT_DATE, chatSessionCount: 0 } as any,
        ]);

        await runActivationAnalysis();

        expect(mockCrmDb.batchCreateLeads).toHaveBeenCalledTimes(1);
        const [, leads] = mockCrmDb.batchCreateLeads.mock.calls[0];
        expect(leads.map((l: any) => l.email)).toEqual(['user1@test.com']);
    });

    it('should use lastLoginTime for lastActiveDate when available', async () => {
        const loginTime = '2026-03-20T12:00:00Z';
        mockUserDb.getAllUsers.mockResolvedValue([
            { userId: 'u1', email: 'user1@test.com', createdAt: OLD_DATE, lastLoginTime: loginTime, brandGuidelines: undefined, chatSessionCount: 0 } as any,
        ]);

        await runActivationAnalysis();

        const batchCreateArgs = mockCrmDb.batchCreateLeads.mock.calls[0]?.[1];
        expect(batchCreateArgs?.[0]?.customFields?.lastActiveDate).toBe('2026-03-20');
    });

    it('should run CRM update even when autoSync is false', async () => {
        mockSettingsService.getSetting.mockImplementation(async (key: string) => {
            if (key === 'admin_crm_sync_users') {
                return { settingName: key, settingValue: JSON.stringify({ listId: 'test-list-id', autoSync: false }), updatedAt: '', updatedBy: '' };
            }
            return null;
        });

        mockUserDb.getAllUsers.mockResolvedValue([
            { userId: 'u1', email: 'user1@test.com', createdAt: RECENT_DATE, brandGuidelines: undefined, chatSessionCount: 0 } as any
        ]);

        await runActivationAnalysis();

        expect(mockCrmDb.batchCreateLeads).toHaveBeenCalled();
    });

    it('should skip CRM update if listId is not configured', async () => {
        mockSettingsService.getSetting.mockImplementation(async () => {
            return null; // admin_crm_sync_users returns null
        });

        mockUserDb.getAllUsers.mockResolvedValue([
            { userId: 'u1', email: 'user1@test.com', createdAt: RECENT_DATE, brandGuidelines: undefined, chatSessionCount: 0 } as any
        ]);

        await runActivationAnalysis();

        expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
    });

    it('should skip CRM update if lead list does not have public access enabled', async () => {
        mockCrmDb.getLeadListById.mockResolvedValue({ listId: 'test-list-id', publicAccessEnabled: false } as any);

        mockUserDb.getAllUsers.mockResolvedValue([
            { userId: 'u1', email: 'user1@test.com', createdAt: RECENT_DATE, brandGuidelines: undefined, chatSessionCount: 0 } as any
        ]);

        await runActivationAnalysis();

        expect(mockCrmDb.batchCreateLeads).not.toHaveBeenCalled();
    });
});
