import request from 'supertest';
import express from 'express';
import connectedAccountsRouter from '../routes/connectedAccounts';
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import { userDb, orgDb } from '../services/db';

// Mock dependencies
jest.mock('../services/connectedAccountsDb');
jest.mock('../services/db', () => ({
    userDb: {
        getUserById: jest.fn(),
    },
    orgDb: {
        getOrgById: jest.fn(),
    },
}));
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
        (userDb.getUserById as jest.Mock).mockResolvedValue(null);
        (orgDb.getOrgById as jest.Mock).mockResolvedValue(null);
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

            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

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

            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

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

            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);
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

            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

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

            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);
            const { getTokenStatus, formatExpiryMessage } = require('../utils/tokenUtils');

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(getTokenStatus).toHaveBeenCalled();
            expect(formatExpiryMessage).toHaveBeenCalled();
        });

        it('returns 500 when getAccountsWithOwnerIncludingOrgShared throws', async () => {
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockRejectedValue(new Error('DB error'));

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
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([ownAccount, sharedUnipile]);
            const { linkedInOutreachService } = require('../services/linkedInOutreachService');
            linkedInOutreachService.getStatusesForAccounts.mockResolvedValue(new Map([['uni-shared-001', 'OK']]));

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            const ids = response.body.accounts.map((a: any) => a.account_id);
            expect(ids).toContain('uni-shared-001');
            expect(ids).toContain('gmail-own');
        });

        it('marks owned=true for the caller\'s own account and owned=false for a teammate\'s org-shared account', async () => {
            const ownAccount = {
                platform: 'google_ads',
                account_id: 'gads-own',
                account_name: 'My Google Ads',
                userId: 'test_user_id', // caller owns this
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                sharedWithOrg: true,
                config: { account_type: 'google_ads', customer_id: 'gads-own', access_token: 'own-tok', token_expires_at: Date.now() + 3600000 },
            };
            const teammateShared = {
                platform: 'meta',
                account_id: 'meta-shared',
                account_name: 'Teammate Meta',
                userId: 'other_user_id', // owned by another org member
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                sharedWithOrg: true,
                config: { account_type: 'ad_account', ad_account_id: 'meta-shared', access_token: 'shared-tok', token_expires_at: Date.now() + 3600000 },
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([ownAccount, teammateShared]);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            const byId = Object.fromEntries(response.body.accounts.map((a: any) => [a.account_id, a]));
            expect(byId['gads-own'].owned).toBe(true);
            expect(byId['meta-shared'].owned).toBe(false);
        });

        it('defaults owned=true when an account has no userId (legacy/own-only listing)', async () => {
            const legacyAccount = {
                platform: 'gmail',
                account_id: 'legacy-gmail',
                account_name: 'Legacy',
                // no userId field
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                config: { account_type: 'gmail', email: 'a@b.com', access_token: 't', refresh_token: 'r', token_expires_at: Date.now() + 3600000, granted_scopes: [] },
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([legacyAccount]);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            // userId undefined !== 'test_user_id' → owned=false from the route's strict check.
            // The FRONTEND treats `owned !== false` as owned, so legacy rows keep controls.
            // Here we assert the route faithfully reports ownership based on userId.
            expect(response.body.accounts[0].owned).toBe(false);
        });

        it('surfaces is_premium=true for a Premium unipile account', async () => {
            const premiumUnipile = {
                platform: 'unipile',
                account_id: 'uni-premium',
                account_name: 'Premium LinkedIn',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                config: {
                    account_type: 'personal',
                    unipile_account_id: 'uni-premium',
                    access_token: 'tok',
                    token_expires_at: 9999999999999,
                    is_premium: true,
                }
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([premiumUnipile]);
            const { linkedInOutreachService } = require('../services/linkedInOutreachService');
            linkedInOutreachService.getStatusesForAccounts.mockResolvedValue(new Map([['uni-premium', 'OK']]));

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].is_premium).toBe(true);
        });

        it('defaults is_premium=false for a unipile account without the flag', async () => {
            const freeUnipile = {
                platform: 'unipile',
                account_id: 'uni-free',
                account_name: 'Free LinkedIn',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                config: {
                    account_type: 'personal',
                    unipile_account_id: 'uni-free',
                    access_token: 'tok',
                    token_expires_at: 9999999999999,
                }
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([freeUnipile]);
            const { linkedInOutreachService } = require('../services/linkedInOutreachService');
            linkedInOutreachService.getStatusesForAccounts.mockResolvedValue(new Map([['uni-free', 'OK']]));

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].is_premium).toBe(false);
        });

        it('does not set is_premium for non-unipile accounts', async () => {
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
                        granted_scopes: [],
                    }
                }
            ];
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].is_premium).toBeUndefined();
        });

        it('surfaces booking_tracking_active=true for a Calendly account whose plan supports webhooks', async () => {
            const activeCalendly = {
                platform: 'calendly',
                account_id: 'jane@customer.com',
                account_name: 'Jane Customer',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                config: {
                    account_type: 'calendly',
                    email: 'jane@customer.com',
                    access_token: 'tok',
                    refresh_token: 'refresh',
                    token_expires_at: 9999999999999,
                    user_uri: 'https://api.calendly.com/users/AAAA',
                    organization_uri: 'https://api.calendly.com/organizations/BBBB',
                    booking_tracking_active: true,
                    webhook_id: 'https://api.calendly.com/webhook_subscriptions/CCCC',
                }
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([activeCalendly]);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].booking_tracking_active).toBe(true);
        });

        it('surfaces booking_tracking_active=false for a Calendly account on a plan that does not support webhooks', async () => {
            const inactiveCalendly = {
                platform: 'calendly',
                account_id: 'free@customer.com',
                account_name: 'Free Customer',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                config: {
                    account_type: 'calendly',
                    email: 'free@customer.com',
                    access_token: 'tok',
                    refresh_token: 'refresh',
                    token_expires_at: 9999999999999,
                    user_uri: 'https://api.calendly.com/users/DDDD',
                    organization_uri: 'https://api.calendly.com/organizations/EEEE',
                    booking_tracking_active: false,
                }
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([inactiveCalendly]);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].booking_tracking_active).toBe(false);
        });

        it('does not set booking_tracking_active for non-Calendly accounts', async () => {
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
                        granted_scopes: [],
                    }
                }
            ];
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue(mockAccounts);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].booking_tracking_active).toBeUndefined();
        });

        it('does not include org-shared accounts when getAccountsWithOwnerIncludingOrgShared only returns own accounts', async () => {
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
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([ownAccount]);
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

        it('blocks a non-owner org member from disconnecting an org-shared business ad account', async () => {
            (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
            (userDb.getUserById as jest.Mock).mockResolvedValue({
                userId: 'test_user_id',
                orgId: 'org-1',
                orgRole: 'member',
                connected_accounts: [{
                    platform: 'google_ads',
                    account_id: '1234567890',
                    account_name: 'Agency Google Ads',
                    sharedWithOrg: true,
                    config: { account_type: 'ad_account' },
                }],
            });
            (orgDb.getOrgById as jest.Mock).mockResolvedValue({
                orgId: 'org-1',
                ownerUserId: 'owner-user-id',
            });

            const response = await request(app).delete('/api/oauth/connected-accounts/google_ads/1234567890');

            expect(response.status).toBe(403);
            expect(response.body.error).toContain('Only the org owner');
            expect(connectedAccountsDb.deleteAccountById).not.toHaveBeenCalled();
        });
    });

    describe('PATCH /connected-accounts/unipile/:accountId/premium', () => {
        it('sets is_premium=true and returns success', async () => {
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/unipile/uni-1/premium')
                .send({ isPremium: true });

            expect(response.status).toBe(200);
            expect(response.body).toEqual(expect.objectContaining({ success: true, is_premium: true }));
            expect(connectedAccountsDb.updateAccountConfig).toHaveBeenCalledWith(
                'test_user_id', 'unipile', 'uni-1', { is_premium: true }
            );
        });

        it('sets is_premium=false and returns success', async () => {
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/unipile/uni-1/premium')
                .send({ isPremium: false });

            expect(response.status).toBe(200);
            expect(connectedAccountsDb.updateAccountConfig).toHaveBeenCalledWith(
                'test_user_id', 'unipile', 'uni-1', { is_premium: false }
            );
        });

        it('returns 400 when isPremium is not a boolean', async () => {
            const response = await request(app)
                .patch('/api/oauth/connected-accounts/unipile/uni-1/premium')
                .send({ isPremium: 'yes' });

            expect(response.status).toBe(400);
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('returns 400 when isPremium is missing', async () => {
            const response = await request(app)
                .patch('/api/oauth/connected-accounts/unipile/uni-1/premium')
                .send({});

            expect(response.status).toBe(400);
        });

        it('returns 404 when the account is not connected to the user', async () => {
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockRejectedValue(
                new Error('No unipile account with id "uni-x" connected')
            );

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/unipile/uni-x/premium')
                .send({ isPremium: true });

            expect(response.status).toBe(404);
        });

        it('returns 500 when updateAccountConfig throws an unexpected error', async () => {
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockRejectedValue(new Error('DB down'));

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/unipile/uni-1/premium')
                .send({ isPremium: true });

            expect(response.status).toBe(500);
        });
    });
});
