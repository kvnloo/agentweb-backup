import request from 'supertest';
import express from 'express';
import connectedAccountsRouter from '../routes/connectedAccounts';
import * as connectedAccountsDb from '../services/connectedAccountsDb';

// Mock dependencies
jest.mock('../services/connectedAccountsDb');
jest.mock('../middleware/auth', () => ({
    authenticateToken: (req: any, res: any, next: any) => {
        req.user = { userId: 'test_user_id' };
        next();
    }
}));
jest.mock('../utils/tokenUtils', () => ({
    getTokenStatus: jest.fn().mockReturnValue('active'),
    formatExpiryMessage: jest.fn().mockReturnValue('Expires in 30 days')
}));
jest.mock('../services/linkedInOutreachService', () => ({
    linkedInOutreachService: {
        getStatusesForAccounts: jest.fn().mockResolvedValue(new Map()),
        deleteAccount: jest.fn().mockResolvedValue(undefined),
    }
}));
jest.mock('../services/fathomApiService', () => ({
    FathomApiService: jest.fn().mockImplementation(() => ({
        validateApiKey: jest.fn().mockResolvedValue(true),
        deleteWebhook: jest.fn().mockResolvedValue(undefined),
    }))
}));
jest.mock('../services/subscriptionService', () => ({
    getAllowedConnectedAccounts: jest.fn().mockResolvedValue([])
}));

const app = express();
app.use(express.json());
app.use('/api/oauth', connectedAccountsRouter);

describe('Connected Accounts Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /connected-accounts', () => {
        it('should correctly map profile_picture_url to profile_image_url', async () => {
            const mockAccounts = [
                {
                    platform: 'meta',
                    account_id: 'act_123',
                    account_name: 'Test Ad Account',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    config: {
                        account_type: 'ad_account',
                        ad_account_id: 'act_123',
                        access_token: 'token',
                        token_expires_at: Date.now() + 100000,
                        profile_picture_url: 'https://example.com/profile.jpg' // Backend field name
                    }
                }
            ];

            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.accounts).toHaveLength(1);

            const account = response.body.accounts[0];
            expect(account.profile_image_url).toBeUndefined(); // Should NOT map from profile_picture_url anymore
        });

        it('should handle missing profile_picture_url', async () => {
            const mockAccounts = [
                {
                    platform: 'meta',
                    account_id: 'act_123',
                    account_name: 'Test Ad Account',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    config: {
                        account_type: 'ad_account',
                        ad_account_id: 'act_123',
                        access_token: 'token',
                        token_expires_at: Date.now() + 100000
                        // missing profile_picture_url
                    }
                }
            ];

            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].profile_image_url).toBeUndefined();
        });

        it('Gmail account with refresh_token shows status=active and expiry_message=Connected', async () => {
            const mockAccounts = [
                {
                    platform: 'gmail',
                    account_id: 'user@gmail.com',
                    account_name: 'Test User',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    config: {
                        account_type: 'gmail',
                        email: 'user@gmail.com',
                        access_token: 'access-token',
                        refresh_token: 'refresh-token',
                        token_expires_at: Date.now() + 3600000,
                        granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
                    }
                }
            ];

            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);
            const { getTokenStatus, formatExpiryMessage } = require('../utils/tokenUtils');

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            const account = response.body.accounts[0];
            expect(account.status).toBe('active');
            expect(account.expiry_message).toBe('Connected');
            expect(getTokenStatus).not.toHaveBeenCalled();
            expect(formatExpiryMessage).not.toHaveBeenCalled();
        });

        it('Gmail account uses picture_url for profile_image_url', async () => {
            const mockAccounts = [
                {
                    platform: 'gmail',
                    account_id: 'user@gmail.com',
                    account_name: 'Test User',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    config: {
                        account_type: 'gmail',
                        email: 'user@gmail.com',
                        access_token: 'access-token',
                        refresh_token: 'refresh-token',
                        token_expires_at: Date.now() + 3600000,
                        picture_url: 'https://example.com/gmail-photo.jpg',
                        granted_scopes: [],
                    }
                }
            ];

            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].profile_image_url).toBe('https://example.com/gmail-photo.jpg');
        });

        it('non-Gmail account without refresh_token delegates status to getTokenStatus', async () => {
            const mockAccounts = [
                {
                    platform: 'linkedin',
                    account_id: 'li-123',
                    account_name: 'LinkedIn User',
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    config: {
                        account_type: 'personal',
                        access_token: 'li-token',
                        token_expires_at: Date.now() + 86400000,
                    }
                }
            ];

            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);
            const { getTokenStatus, formatExpiryMessage } = require('../utils/tokenUtils');

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(getTokenStatus).toHaveBeenCalled();
            expect(formatExpiryMessage).toHaveBeenCalled();
        });

        it('returns 500 when getAccountsByUserIdIncludingOrgShared throws', async () => {
            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockRejectedValue(new Error('DB error'));

            const response = await request(app).get('/api/oauth/connected-accounts');
            expect(response.status).toBe(500);
        });

        it('includes org-shared unipile accounts from other org members', async () => {
            const ownAccount = {
                platform: 'gmail',
                account_id: 'gmail-own',
                account_name: 'My Gmail',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                sharedWithOrg: false,
                config: {
                    account_type: 'gmail',
                    email: 'me@example.com',
                    access_token: 'own-token',
                    refresh_token: 'own-refresh',
                    token_expires_at: Date.now() + 3600000,
                    granted_scopes: [],
                }
            };
            const sharedUnipile = {
                platform: 'unipile',
                account_id: 'uni-shared-001',
                account_name: 'Rui LinkedIn Outreach',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                sharedWithOrg: true,
                config: {
                    account_type: 'personal',
                    unipile_account_id: 'uni-shared-001',
                    access_token: 'uni-token',
                    token_expires_at: 9999999999999,
                }
            };
            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockResolvedValue([ownAccount, sharedUnipile]);
            const { linkedInOutreachService } = require('../services/linkedInOutreachService');
            linkedInOutreachService.getStatusesForAccounts.mockResolvedValue(new Map([['uni-shared-001', 'OK']]));

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            const ids = response.body.accounts.map((a: any) => a.account_id);
            expect(ids).toContain('uni-shared-001');
            expect(ids).toContain('gmail-own');
        });

        it('does not include org-shared accounts when getAccountsByUserIdIncludingOrgShared only returns own accounts', async () => {
            const ownAccount = {
                platform: 'unipile',
                account_id: 'uni-own-001',
                account_name: 'My LinkedIn Outreach',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                sharedWithOrg: false,
                config: {
                    account_type: 'personal',
                    unipile_account_id: 'uni-own-001',
                    access_token: 'own-token',
                    token_expires_at: 9999999999999,
                }
            };
            (connectedAccountsDb.getAccountsByUserIdIncludingOrgShared as jest.Mock).mockResolvedValue([ownAccount]);
            const { linkedInOutreachService } = require('../services/linkedInOutreachService');
            linkedInOutreachService.getStatusesForAccounts.mockResolvedValue(new Map([['uni-own-001', 'OK']]));

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts).toHaveLength(1);
            expect(response.body.accounts[0].account_id).toBe('uni-own-001');
        });
    });

    describe('DELETE /connected-accounts/:platform', () => {
        it('deletes all accounts for a platform and returns success', async () => {
            (connectedAccountsDb.deleteAccount as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app).delete('/api/oauth/connected-accounts/gmail');
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(connectedAccountsDb.deleteAccount).toHaveBeenCalledWith('test_user_id', 'gmail');
        });

        it('returns 500 when deleteAccount throws', async () => {
            (connectedAccountsDb.deleteAccount as jest.Mock).mockRejectedValue(new Error('DB error'));

            const response = await request(app).delete('/api/oauth/connected-accounts/gmail');
            expect(response.status).toBe(500);
        });
    });

    describe('DELETE /connected-accounts/:platform/:accountId', () => {
        it('deletes a specific account by platform and accountId', async () => {
            (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app).delete('/api/oauth/connected-accounts/gmail/user%40gmail.com');
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'gmail', 'user@gmail.com');
        });

        it('returns 500 when deleteAccountById throws', async () => {
            (connectedAccountsDb.deleteAccountById as jest.Mock).mockRejectedValue(new Error('DB error'));

            const response = await request(app).delete('/api/oauth/connected-accounts/gmail/user@gmail.com');
            expect(response.status).toBe(500);
        });
    });
});
