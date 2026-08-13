// calendlyWebhookCleanupQueue.ts (transitively imported by connectedAccounts.ts below)
// creates its own AWS.DynamoDB.DocumentClient at MODULE LOAD time for the orphan-webhook
// fallback table (round 16) — this mock must be declared and initialized BEFORE any
// import that would trigger that module chain, since jest.mock('aws-sdk', ...) is
// hoisted above imports but a plain const is not; declaring it after the imports left
// a TDZ window where the hoisted mock factory ran before this const was initialized.
const mockOrphanTableMethods = {
    put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
};
jest.mock('aws-sdk', () => ({
    config: { update: jest.fn() },
    DynamoDB: {
        DocumentClient: jest.fn(() => mockOrphanTableMethods),
    },
}));

import request from 'supertest';
import express from 'express';
import axios from 'axios';
import connectedAccountsRouter, { processCalendlyWebhookCleanupJob } from '../routes/connectedAccounts';
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import { refreshCalendlyAccessToken } from '../routes/calendlyAuth';
import { userDb, orgDb, crmDb } from '../services/db';
import { registerProcessor as mockRegisterProcessor } from '../services/asyncJobQueue';

// Mock dependencies
jest.mock('axios');
jest.mock('../services/connectedAccountsDb');
jest.mock('../services/db', () => ({
    userDb: {
        getUserById: jest.fn(),
    },
    orgDb: {
        getOrgById: jest.fn(),
    },
    crmDb: {
        getLeadListById: jest.fn(),
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
jest.mock('../routes/calendlyAuth', () => ({
    refreshCalendlyAccessToken: jest.fn(),
}));
const mockAssertOwnedMetaPixel = jest.fn();
jest.mock('../services/metaAccountCredentials', () => ({
    assertOwnedMetaPixel: (...a: any[]) => mockAssertOwnedMetaPixel(...a),
}));
const mockEnqueueJob = jest.fn();
const mockUpdateJobPayload = jest.fn();
jest.mock('../services/asyncJobQueue', () => ({
    enqueueJob: (...a: any[]) => mockEnqueueJob(...a),
    updateJobPayload: (...a: any[]) => mockUpdateJobPayload(...a),
    registerProcessor: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/oauth', connectedAccountsRouter);

// connectedAccounts.ts calls registerProcessor at MODULE LOAD time (once, when this
// test file's top-level import above executes) — captured here, before any
// beforeEach's jest.clearAllMocks() has a chance to wipe that one-time call record.
const registeredCleanupProcessorCall = (mockRegisterProcessor as jest.Mock).mock.calls.find(
    (call: any[]) => call[0] === 'calendly_webhook_cleanup',
);

describe('Connected Accounts Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (userDb.getUserById as jest.Mock).mockResolvedValue(null);
        (orgDb.getOrgById as jest.Mock).mockResolvedValue(null);
        mockEnqueueJob.mockResolvedValue('enqueued');
        // updateJobPayload now resolves a boolean (Greptile P1, third pass) — default
        // to success so existing tests that don't care about this specific outcome
        // aren't accidentally exercising the new "both persistence writes failed"
        // branch in processCalendlyWebhookCleanupJob.
        mockUpdateJobPayload.mockResolvedValue(true);
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

        it('surfaces booking_lead_list_id for a Calendly account that has one set', async () => {
            const calendlyWithList = {
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
                    booking_lead_list_id: 'list-1',
                }
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([calendlyWithList]);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].booking_lead_list_id).toBe('list-1');
        });

        it('surfaces attribution_pixel_id/attribution_account_id for a Calendly account that has them set (ENG-1141)', async () => {
            const calendlyWithAttribution = {
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
                    attributionPixelId: 'px-1',
                    attributionAccountId: 'act-1',
                }
            };
            (connectedAccountsDb.getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([calendlyWithAttribution]);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].attribution_pixel_id).toBe('px-1');
            expect(response.body.accounts[0].attribution_account_id).toBe('act-1');
        });

        it('does not set booking_lead_list_id for non-Calendly accounts', async () => {
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
            expect(response.body.accounts[0].booking_lead_list_id).toBeUndefined();
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

        // Greptile P1 on #2291: this route previously used getAccountByPlatform,
        // which only returns the FIRST matching account — but deleteAccount below
        // removes ALL accounts for the platform. A user with more than one Calendly
        // connection would have every subscription but one orphaned.
        it('cleans up the webhook for every Calendly account the user has, not just the first', async () => {
            (connectedAccountsDb.getAccountsByUserId as jest.Mock).mockResolvedValue([
                { platform: 'calendly', account_id: 'a@example.com', config: { access_token: 'token-a', webhook_id: 'https://api.calendly.com/webhook_subscriptions/AAAA' } },
                { platform: 'calendly', account_id: 'b@example.com', config: { access_token: 'token-b', webhook_id: 'https://api.calendly.com/webhook_subscriptions/BBBB' } },
                { platform: 'gmail', account_id: 'c@example.com', config: {} },
            ]);
            (connectedAccountsDb.deleteAccount as jest.Mock).mockResolvedValue(undefined);
            (axios.delete as jest.Mock).mockResolvedValue({ data: {} });

            const response = await request(app).delete('/api/oauth/connected-accounts/calendly');

            expect(response.status).toBe(200);
            expect(axios.delete).toHaveBeenCalledWith(
                'https://api.calendly.com/webhook_subscriptions/AAAA',
                expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-a' }) }),
            );
            expect(axios.delete).toHaveBeenCalledWith(
                'https://api.calendly.com/webhook_subscriptions/BBBB',
                expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token-b' }) }),
            );
            expect(connectedAccountsDb.deleteAccount).toHaveBeenCalledWith('test_user_id', 'calendly');
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

        // Greptile P1 on #2291: disconnect used to delete the local account record
        // (including webhook_id) without ever deleting the actual Calendly-side
        // subscription, orphaning it. A later reconnect then hit "Already Exists"
        // with no local record left to identify and clean it up, permanently
        // stranding the account on "booking tracking disabled". Deleting the
        // remote subscription here, symmetric with how /connect creates it, is
        // what makes a normal disconnect-then-reconnect actually recoverable.
        describe('Calendly webhook cleanup', () => {
            const calendlyAccount = {
                platform: 'calendly',
                account_id: 'jane@customer.com',
                userId: 'test_user_id',
                config: {
                    account_type: 'calendly',
                    access_token: 'access-token-1',
                    refresh_token: 'refresh-token-1',
                    webhook_id: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                    user_uri: 'https://api.calendly.com/users/AAAAAAAAAAAAAAAA',
                },
            };

            it('deletes the remote webhook subscription before deleting the local account', async () => {
                (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                (axios.delete as jest.Mock).mockResolvedValue({ data: {} });

                const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                expect(response.status).toBe(200);
                expect(axios.delete).toHaveBeenCalledWith(
                    'https://api.calendly.com/webhook_subscriptions/AAAA',
                    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer access-token-1' }) }),
                );
                expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');
            });

            it('still deletes the local account when the remote webhook delete fails (non-fatal), and queues a durable retry', async () => {
                (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                (axios.delete as jest.Mock).mockRejectedValue(new Error('token expired'));

                const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                expect(response.status).toBe(200);
                expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');
                // Greptile P1 on #2291 (round 4): the webhook_id would otherwise be lost the
                // moment the local account above is deleted — enqueueing BEFORE that happens
                // is what lets the queue's own poller find and retry the cleanup later.
                expect(mockEnqueueJob).toHaveBeenCalledWith(
                    'calendly_webhook_cleanup',
                    'https://api.calendly.com/webhook_subscriptions/AAAA',
                    expect.objectContaining({ webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA', refreshToken: 'refresh-token-1' }),
                );
            });

            // Greptile P1 on #2291 (round 5): this enqueue is the LAST chance to durably
            // record webhook_id before the account is deleted — if the queue write itself
            // is 'unavailable' (a transient blip, not necessarily the table missing), one
            // retry gives it a real second chance before that identifier is gone for good.
            it('retries the enqueue once when the first attempt reports the queue unavailable', async () => {
                (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                (axios.delete as jest.Mock).mockRejectedValue(new Error('token expired'));
                mockEnqueueJob.mockResolvedValueOnce('unavailable').mockResolvedValueOnce('enqueued');

                const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                expect(response.status).toBe(200);
                expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
                expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');
            });

            // Greptile P1 on #2291 (round 10): if BOTH the remote delete and the durable
            // enqueue retry fail, the local account (the only other copy of webhook_id) is
            // still deleted right after — disconnect intentionally always succeeds locally
            // rather than blocking the user on cleanup. That makes this the last point
            // where "this subscription is now permanently unrecoverable" is observable at
            // all — it must escalate loudly (console.error) rather than warn, so it's
            // actionable/alertable in production monitoring instead of silently lost.
            it('falls back to the orphan-webhook table (and logs an actionable error, not just a warning) when the durable enqueue is still unavailable after the retry', async () => {
                (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                (axios.delete as jest.Mock).mockRejectedValue(new Error('token expired'));
                mockEnqueueJob.mockResolvedValue('unavailable');
                const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

                const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                expect(response.status).toBe(200);
                expect(mockEnqueueJob).toHaveBeenCalledTimes(2);
                // Greptile P1 on #2291 (round 16): the async job queue is itself the thing
                // failing to accept writes here, so a durable fallback that ALSO writes to
                // that same table would have no value — the orphan-webhook table is a
                // genuinely separate table with a real chance of succeeding.
                expect(mockOrphanTableMethods.put).toHaveBeenCalledWith(expect.objectContaining({
                    Item: expect.objectContaining({
                        id: 'test_user_id_https://api.calendly.com/users/AAAAAAAAAAAAAAAA',
                        webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                    }),
                }));
                expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Recorded orphaned webhook'));
                // Disconnect still succeeds locally even though the identifier is only
                // recoverable via the fallback table now, not the local account record.
                expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');

                errorSpy.mockRestore();
            });

            it('logs "LOST webhook cleanup record" when BOTH the durable enqueue and ALL orphan-webhook fallback attempts are unavailable', async () => {
                (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                (axios.delete as jest.Mock).mockRejectedValue(new Error('token expired'));
                mockEnqueueJob.mockResolvedValue('unavailable');
                // Greptile P1 on #2291 (round 23): recordOrphanedCalendlyWebhook now
                // retries with backoff (3 attempts total) rather than a single try — all
                // three must fail to reach the genuinely-exhausted "LOST" outcome.
                mockOrphanTableMethods.put.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('dynamo down too')) });
                const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

                const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                expect(response.status).toBe(200);
                expect(mockOrphanTableMethods.put).toHaveBeenCalledTimes(3);
                expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('LOST webhook cleanup record'), expect.anything());
                expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');

                errorSpy.mockRestore();
            });

            it('recovers on the second backoff attempt when the first orphan-webhook write transiently fails', async () => {
                (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                (axios.delete as jest.Mock).mockRejectedValue(new Error('token expired'));
                mockEnqueueJob.mockResolvedValue('unavailable');
                mockOrphanTableMethods.put
                    .mockReturnValueOnce({ promise: jest.fn().mockRejectedValue(new Error('throttled')) })
                    .mockReturnValueOnce({ promise: jest.fn().mockResolvedValue({}) });
                const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

                const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                expect(response.status).toBe(200);
                expect(mockOrphanTableMethods.put).toHaveBeenCalledTimes(2);
                expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Recorded orphaned webhook'));
                expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('LOST webhook cleanup record'), expect.anything());

                errorSpy.mockRestore();
            });

            it('does not attempt a remote delete when there is no webhook_id (booking tracking was already inactive)', async () => {
                (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue({
                    ...calendlyAccount,
                    config: { account_type: 'calendly', access_token: 'access-token-1' },
                });
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);

                const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                expect(response.status).toBe(200);
                expect(axios.delete).not.toHaveBeenCalled();
            });

            it('does not attempt webhook cleanup for a non-Calendly platform', async () => {
                (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);

                const response = await request(app).delete('/api/oauth/connected-accounts/gmail/user%40gmail.com');

                expect(response.status).toBe(200);
                expect(connectedAccountsDb.getAccountById).not.toHaveBeenCalled();
                expect(axios.delete).not.toHaveBeenCalled();
            });

            // Greptile P1 on #2291: the stored access token is short-lived and this cleanup
            // often runs long after last activity, so an expired-token 401/403 on the first
            // delete attempt is the expected case, not an edge case. Silently accepting it
            // as final used to lose webhook_id along with the local account, permanently
            // stranding the subscription (a later reconnect has nothing left to identify it
            // with — see calendlyAuth.ts). Refreshing once and retrying is what makes this
            // cleanup actually work in the common case instead of only when disconnect
            // happens to follow shortly after a fresh token.
            describe('token refresh on expired-token cleanup failure', () => {
                it('refreshes the token and retries the delete when the first attempt fails with 401', async () => {
                    (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                    (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                    (axios.delete as jest.Mock)
                        .mockRejectedValueOnce({ response: { status: 401 } })
                        .mockResolvedValueOnce({ data: {} });
                    (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                        access_token: 'refreshed-access-token',
                        refresh_token: 'refresh-token-1',
                    });

                    const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                    expect(response.status).toBe(200);
                    expect(refreshCalendlyAccessToken).toHaveBeenCalled();
                    expect(axios.delete).toHaveBeenCalledTimes(2);
                    expect(axios.delete).toHaveBeenNthCalledWith(
                        2,
                        'https://api.calendly.com/webhook_subscriptions/AAAA',
                        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer refreshed-access-token' }) }),
                    );
                    expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');
                });

                it('still deletes the local account when the token refresh itself fails, and queues a durable retry', async () => {
                    (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                    (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                    (axios.delete as jest.Mock).mockRejectedValue({ response: { status: 401 } });
                    (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue(null);

                    const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                    expect(response.status).toBe(200);
                    expect(axios.delete).toHaveBeenCalledTimes(1); // no retry without a successful refresh
                    expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');
                    expect(mockEnqueueJob).toHaveBeenCalledWith(
                        'calendly_webhook_cleanup',
                        'https://api.calendly.com/webhook_subscriptions/AAAA',
                        expect.objectContaining({ webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA', refreshToken: 'refresh-token-1' }),
                    );
                });

                it('does not attempt a token refresh for a non-auth error, but still queues a durable retry', async () => {
                    (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                    (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                    (axios.delete as jest.Mock).mockRejectedValue({ response: { status: 500 } });

                    const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                    expect(response.status).toBe(200);
                    expect(refreshCalendlyAccessToken).not.toHaveBeenCalled();
                    expect(axios.delete).toHaveBeenCalledTimes(1);
                    expect(connectedAccountsDb.deleteAccountById).toHaveBeenCalledWith('test_user_id', 'calendly', 'jane@customer.com');
                    expect(mockEnqueueJob).toHaveBeenCalledWith(
                        'calendly_webhook_cleanup',
                        'https://api.calendly.com/webhook_subscriptions/AAAA',
                        expect.objectContaining({ webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA', refreshToken: 'refresh-token-1' }),
                    );
                });

                it('does not queue a retry when the retried delete (after a successful refresh) still fails', async () => {
                    (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                    (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                    (axios.delete as jest.Mock).mockRejectedValue({ response: { status: 401 } });
                    (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                        access_token: 'refreshed-access-token',
                        refresh_token: 'refresh-token-1',
                    });

                    const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                    expect(response.status).toBe(200);
                    expect(axios.delete).toHaveBeenCalledTimes(2);
                    expect(mockEnqueueJob).toHaveBeenCalledWith(
                        'calendly_webhook_cleanup',
                        'https://api.calendly.com/webhook_subscriptions/AAAA',
                        expect.anything(),
                    );
                });

                // Greptile P1 on #2291 (round 20): the same rotation-loss bug as
                // processCalendlyWebhookCleanupJob, one call site earlier. If Calendly
                // rotates the refresh token on this refresh and the RETRY delete then
                // fails too, the durable queue job must be enqueued with the NEW
                // (rotated) token — not the stale pre-refresh one still on `config` —
                // or that job's own first refresh attempt is guaranteed to fail too.
                it('queues the retry with the ROTATED refresh token, not the stale pre-refresh one, when the retried delete still fails', async () => {
                    (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue(calendlyAccount);
                    (connectedAccountsDb.deleteAccountById as jest.Mock).mockResolvedValue(undefined);
                    (axios.delete as jest.Mock).mockRejectedValue({ response: { status: 401 } });
                    (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                        access_token: 'refreshed-access-token',
                        refresh_token: 'rotated-refresh-token',
                    });

                    const response = await request(app).delete('/api/oauth/connected-accounts/calendly/jane%40customer.com');

                    expect(response.status).toBe(200);
                    expect(mockEnqueueJob).toHaveBeenCalledWith(
                        'calendly_webhook_cleanup',
                        'https://api.calendly.com/webhook_subscriptions/AAAA',
                        expect.objectContaining({ refreshToken: 'rotated-refresh-token' }),
                    );
                });
            });
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

    describe('processCalendlyWebhookCleanupJob (queued webhook cleanup retry)', () => {
        // Greptile P1 on #2291 (round 9, issue 3): this job holds the ONLY
        // remaining durable copy of a webhook_id once disconnect deletes the local
        // account record. The default 5-attempt cap let it go permanently 'failed'
        // and unclaimable, stranding the orphaned subscription forever.
        //
        // ENG-992 (live-tested round): unlimited retries used to be the fix here,
        // but a real permanent (non-transient) failure showed the cost — the job
        // retried every 30s forever with zero escalation. A generous 20-attempt
        // cap (~10 minutes) rides out a real transient failure exactly like
        // unlimited retries would, while still letting a genuinely permanent one
        // go terminally 'failed' and log distinctly (asyncJobQueue.ts). Safe to
        // bound now because round 16's orphan-webhook table + reconnect self-heal
        // is an independent second recovery path that doesn't depend on this
        // job's retry state at all.
        it('is registered with a generous but bounded retry cap, not unlimited retries', () => {
            expect(registeredCleanupProcessorCall).toBeDefined();
            expect(registeredCleanupProcessorCall![1]).toBe(processCalendlyWebhookCleanupJob);
            expect(registeredCleanupProcessorCall![2]).toEqual({ maxAttempts: 20 });
        });

        it('refreshes the token and deletes the webhook', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'refresh-token-1',
            });
            (axios.delete as jest.Mock).mockResolvedValue({ data: {} });

            await processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'refresh-token-1',
            });

            expect(refreshCalendlyAccessToken).toHaveBeenCalledWith('refresh-token-1');
            expect(axios.delete).toHaveBeenCalledWith(
                'https://api.calendly.com/webhook_subscriptions/AAAA',
                expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer fresh-access-token' }) }),
            );
        });

        // Greptile P1 on #2291 (round 20): Calendly may rotate the refresh token on
        // every use. If this job never persists a rotation, a delete failure AFTER
        // a successful refresh leaves every future retry stuck refreshing with the
        // same now-invalid pre-rotation token — burning through its whole retry
        // budget (bounded, ENG-992) without ever having a chance to succeed.
        // Greptile P1 on #2291 (round 22): the persist is only NEEDED when this
        // attempt is about to fail anyway — a successful delete already used a
        // valid access_token in hand and never needs the persisted value at all,
        // so persisting unconditionally (the round-20 ordering) risked a write
        // failure on an attempt that would otherwise have succeeded cleanly.
        it('does NOT persist the rotated token when the delete succeeds — it was never needed', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'rotated-refresh-token',
            });
            (axios.delete as jest.Mock).mockResolvedValue({ data: {} });

            await processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'refresh-token-1',
            });

            expect(mockUpdateJobPayload).not.toHaveBeenCalled();
            expect(mockOrphanTableMethods.put).not.toHaveBeenCalled();
        });

        it('does not touch the durable queue row when the refresh token is unchanged', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'refresh-token-1',
            });
            (axios.delete as jest.Mock).mockResolvedValue({ data: {} });

            await processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'refresh-token-1',
            });

            expect(mockUpdateJobPayload).not.toHaveBeenCalled();
        });

        it('persists the rotated token even when the delete itself then fails, so the next retry uses it', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'rotated-refresh-token',
            });
            (axios.delete as jest.Mock).mockRejectedValue(new Error('calendly down'));

            await expect(processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'refresh-token-1',
            })).rejects.toThrow('calendly down');

            expect(mockUpdateJobPayload).toHaveBeenCalledWith(
                'calendly_webhook_cleanup',
                'https://api.calendly.com/webhook_subscriptions/AAAA',
                { webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA', refreshToken: 'rotated-refresh-token' },
            );
        });

        // Greptile P1 on #2291 (round 22): a single fallible write with one retry
        // (updateJobPayload) still leaves a tail where both attempts fail. Writing
        // the rotation to a SECOND, genuinely independent table (the orphan-webhook
        // store, round 16) as well means that tail requires BOTH tables' writes to
        // fail, not just one.
        it('also persists the rotated token to the orphan-webhook table when userId/userUri are present and the delete fails', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'rotated-refresh-token',
            });
            (axios.delete as jest.Mock).mockRejectedValue(new Error('calendly down'));

            await expect(processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'refresh-token-1',
                userId: 'user-abc',
                userUri: 'https://api.calendly.com/users/XYZ',
            })).rejects.toThrow('calendly down');

            expect(mockOrphanTableMethods.put).toHaveBeenCalledWith(expect.objectContaining({
                Item: expect.objectContaining({
                    id: 'user-abc_https://api.calendly.com/users/XYZ',
                    webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                    refreshToken: 'rotated-refresh-token',
                }),
            }));
        });

        // Greptile P1 on #2291 (third pass): both persistence writes are best-effort by
        // design — but Calendly has already consumed the OLD refresh token by rotating
        // it, so if BOTH writes fail, the new one exists nowhere durable. Every future
        // retry would keep reloading the now-permanently-invalid old token and can never
        // succeed. Confirms the compound failure throws a DISTINCT, diagnosable error
        // instead of the generic (and in this case misleading) deleteError.
        it('throws a distinct error when the rotated token could not be persisted to EITHER the queue payload or the orphan-webhook table', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'rotated-refresh-token',
            });
            (axios.delete as jest.Mock).mockRejectedValue(new Error('calendly down'));
            mockUpdateJobPayload.mockResolvedValue(false);
            mockOrphanTableMethods.put.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('dynamo down too')) });

            await expect(processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'refresh-token-1',
                userId: 'user-abc',
                userUri: 'https://api.calendly.com/users/XYZ',
            })).rejects.toThrow(/rotated the refresh token .* persisting the new token failed in both/);
        });

        it('throws the original deleteError (NOT the distinct compound-failure error) when only ONE of the two persistence writes succeeds', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'rotated-refresh-token',
            });
            (axios.delete as jest.Mock).mockRejectedValue(new Error('calendly down'));
            mockUpdateJobPayload.mockResolvedValue(false);
            // orphan table write still succeeds (default mock) — one durable copy exists.

            await expect(processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'refresh-token-1',
                userId: 'user-abc',
                userUri: 'https://api.calendly.com/users/XYZ',
            })).rejects.toThrow('calendly down');
        });

        it('checks the orphan-webhook table for a fresher refresh token before refreshing, when userId/userUri are present', async () => {
            mockOrphanTableMethods.get.mockReturnValueOnce({
                promise: jest.fn().mockResolvedValue({
                    Item: { refreshToken: 'fresher-token-from-orphan-table' },
                }),
            });
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'fresher-token-from-orphan-table',
            });
            (axios.delete as jest.Mock).mockResolvedValue({ data: {} });

            await processCalendlyWebhookCleanupJob({
                webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                refreshToken: 'stale-token-from-queue-payload',
                userId: 'user-abc',
                userUri: 'https://api.calendly.com/users/XYZ',
            });

            // The STALE queue-payload token was never even tried — the orphan
            // table's fresher one was used instead.
            expect(refreshCalendlyAccessToken).toHaveBeenCalledWith('fresher-token-from-orphan-table');
            expect(refreshCalendlyAccessToken).not.toHaveBeenCalledWith('stale-token-from-queue-payload');
        });

        it('throws (so the poller re-queues it) when there is no refresh token to work with', async () => {
            await expect(
                processCalendlyWebhookCleanupJob({ webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA' }),
            ).rejects.toThrow(/no refresh token/i);
            expect(refreshCalendlyAccessToken).not.toHaveBeenCalled();
        });

        it('throws (so the poller re-queues it) when the token refresh fails', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue(null);

            await expect(
                processCalendlyWebhookCleanupJob({
                    webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                    refreshToken: 'refresh-token-1',
                }),
            ).rejects.toThrow(/could not refresh/i);
            expect(axios.delete).not.toHaveBeenCalled();
        });

        it('throws (so the poller re-queues it) when the delete itself still fails after a successful refresh', async () => {
            (refreshCalendlyAccessToken as jest.Mock).mockResolvedValue({
                access_token: 'fresh-access-token',
                refresh_token: 'refresh-token-1',
            });
            (axios.delete as jest.Mock).mockRejectedValue({ response: { status: 404 } });

            await expect(
                processCalendlyWebhookCleanupJob({
                    webhookId: 'https://api.calendly.com/webhook_subscriptions/AAAA',
                    refreshToken: 'refresh-token-1',
                }),
            ).rejects.toBeDefined();
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

    describe('PATCH /connected-accounts/calendly/:accountId/booking-list', () => {
        it('returns 400 when listId is missing', async () => {
            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/booking-list')
                .send({});

            expect(response.status).toBe(400);
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('returns 404 when the list does not exist', async () => {
            (crmDb.getLeadListById as jest.Mock).mockResolvedValue(null);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/booking-list')
                .send({ listId: 'list-missing' });

            expect(response.status).toBe(404);
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('returns 403 when the list belongs to a different user', async () => {
            (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'someone-else' });

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/booking-list')
                .send({ listId: 'list-1' });

            expect(response.status).toBe(403);
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('persists booking_lead_list_id and returns success when the list is owned by the caller', async () => {
            (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test_user_id' });
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/booking-list')
                .send({ listId: 'list-1' });

            expect(response.status).toBe(200);
            expect(response.body).toEqual(expect.objectContaining({ success: true, booking_lead_list_id: 'list-1' }));
            expect(connectedAccountsDb.updateAccountConfig).toHaveBeenCalledWith(
                'test_user_id', 'calendly', 'cal-1', { booking_lead_list_id: 'list-1' }
            );
        });

        it('returns 404 when the calendly account is not connected to the user', async () => {
            (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test_user_id' });
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockRejectedValue(
                new Error('No calendly account with id "cal-x" connected')
            );

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-x/booking-list')
                .send({ listId: 'list-1' });

            expect(response.status).toBe(404);
        });

        it('returns 500 when updateAccountConfig throws an unexpected error', async () => {
            (crmDb.getLeadListById as jest.Mock).mockResolvedValue({ listId: 'list-1', userId: 'test_user_id' });
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockRejectedValue(new Error('DB down'));

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/booking-list')
                .send({ listId: 'list-1' });

            expect(response.status).toBe(500);
        });
    });

    describe('PATCH /connected-accounts/calendly/:accountId/attribution (ENG-1141)', () => {
        const mockUser = { userId: 'test_user_id', connected_accounts: [] };

        it('returns 400 when pixelId is missing', async () => {
            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ accountId: 'act-1' });

            expect(response.status).toBe(400);
            expect(mockAssertOwnedMetaPixel).not.toHaveBeenCalled();
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('returns 400 when accountId is missing', async () => {
            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ pixelId: 'px-1' });

            expect(response.status).toBe(400);
            expect(mockAssertOwnedMetaPixel).not.toHaveBeenCalled();
        });

        it('returns 404 when the user record cannot be found', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(null);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ pixelId: 'px-1', accountId: 'act-1' });

            expect(response.status).toBe(404);
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('returns 400 when the pixel/account pair is not owned by the caller', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
            mockAssertOwnedMetaPixel.mockRejectedValue(
                new Error('Meta ad account "act-1" is not one of your connected accounts.')
            );

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ pixelId: 'px-1', accountId: 'act-1' });

            expect(response.status).toBe(400);
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('persists attributionPixelId/attributionAccountId and returns success when owned', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
            mockAssertOwnedMetaPixel.mockResolvedValue({ accountId: 'act-1' });
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ pixelId: 'px-1', accountId: 'act-1' });

            expect(response.status).toBe(200);
            expect(response.body).toEqual(expect.objectContaining({
                success: true,
                attributionPixelId: 'px-1',
                attributionAccountId: 'act-1',
            }));
            // attributionDisabled: false rides along — choosing a real pair also clears any
            // previous "don't track" opt-out, so the two controls can't disagree.
            expect(connectedAccountsDb.updateAccountConfig).toHaveBeenCalledWith(
                'test_user_id', 'calendly', 'cal-1',
                { attributionPixelId: 'px-1', attributionAccountId: 'act-1', attributionDisabled: false }
            );
        });

        // ENG-1141 opt-out: leaving the pair unset means "auto-resolve to my first
        // account/pixel", so a customer who connected Calendly purely for scheduling had no
        // way to say "no Meta attribution at all" — they'd silently get CAPI Schedule events
        // fired against whichever ad account happened to come first.
        it('accepts disabled:true as an explicit opt-out, clearing any stored pair', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ disabled: true });

            expect(response.status).toBe(200);
            expect(response.body).toEqual(expect.objectContaining({ success: true, attributionDisabled: true }));
            // No ownership check to run — there is no pixel being claimed.
            expect(mockAssertOwnedMetaPixel).not.toHaveBeenCalled();
            expect(connectedAccountsDb.updateAccountConfig).toHaveBeenCalledWith(
                'test_user_id', 'calendly', 'cal-1',
                { attributionPixelId: undefined, attributionAccountId: undefined, attributionDisabled: true }
            );
        });

        it('clears the opt-out when a real pair is set afterwards', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
            mockAssertOwnedMetaPixel.mockResolvedValue({ accountId: 'act-1' });
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ pixelId: 'px-1', accountId: 'act-1' });

            expect(response.status).toBe(200);
            expect(connectedAccountsDb.updateAccountConfig).toHaveBeenCalledWith(
                'test_user_id', 'calendly', 'cal-1',
                { attributionPixelId: 'px-1', attributionAccountId: 'act-1', attributionDisabled: false }
            );
        });

        it('still rejects a request that is neither a valid pair nor an opt-out', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ disabled: false });

            expect(response.status).toBe(400);
            expect(connectedAccountsDb.updateAccountConfig).not.toHaveBeenCalled();
        });

        it('returns 404 when the calendly account is not connected to the user', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
            mockAssertOwnedMetaPixel.mockResolvedValue({ accountId: 'act-1' });
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockRejectedValue(
                new Error('No calendly account with id "cal-x" connected')
            );

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-x/attribution')
                .send({ pixelId: 'px-1', accountId: 'act-1' });

            expect(response.status).toBe(404);
        });

        it('returns 500 when updateAccountConfig throws an unexpected error', async () => {
            (userDb.getUserById as jest.Mock).mockResolvedValue(mockUser);
            mockAssertOwnedMetaPixel.mockResolvedValue({ accountId: 'act-1' });
            (connectedAccountsDb.updateAccountConfig as jest.Mock).mockRejectedValue(new Error('DB down'));

            const response = await request(app)
                .patch('/api/oauth/connected-accounts/calendly/cal-1/attribution')
                .send({ pixelId: 'px-1', accountId: 'act-1' });

            expect(response.status).toBe(500);
        });
    });
});
