import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { metaService } from '../services/metaService';
import { safeAutoResolveCredentialDecision } from '../services/approvalInboxCustomerNotify';

jest.mock('axios');
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import metaAuthRouter from '../routes/metaAuth';

// Mock dependencies
jest.mock('../services/metaService');
jest.mock('../services/instagramService');
jest.mock('../services/connectedAccountsDb');
// ENG-1644 gap-closing: /connect-ad-accounts dynamically imports the shared
// safeAutoResolveCredentialDecision wrapper (review fix — no longer the raw
// autoResolveCredentialDecisionOnReconnect directly, consolidated out of 3
// near-identical per-file copies) to auto-resolve a pending reconnect
// decision — mocked here (jest.mock intercepts dynamic imports identically
// to static ones) so tests assert on it directly rather than relying on its
// own real, silent error-swallowing.
jest.mock('../services/approvalInboxCustomerNotify', () => ({
    safeAutoResolveCredentialDecision: jest.fn().mockResolvedValue(undefined),
}));

// In-memory mock for oauthSessionDb so tests don't hit DynamoDB
const mockSessionStore = new Map<string, any>();
jest.mock('../services/db', () => ({
    oauthSessionDb: {
        save: jest.fn().mockImplementation(async (session: any) => {
            mockSessionStore.set(session.sessionId, session);
        }),
        get: jest.fn().mockImplementation(async (sessionId: string, userId: string) => {
            const s = mockSessionStore.get(sessionId);
            if (!s || s.userId !== userId) return null;
            return s;
        }),
        delete: jest.fn().mockImplementation(async (sessionId: string) => {
            mockSessionStore.delete(sessionId);
        }),
    },
}));
jest.mock('../utils/secretsManager', () => ({
    getMetaCredentials: jest.fn().mockResolvedValue({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
    }),
    getInstagramCredentials: jest.fn().mockResolvedValue({
        instagramClientId: 'test_client_id',
        instagramClientSecret: 'test_client_secret',
    })
}));
jest.mock('../middleware/auth', () => ({
    authenticateToken: (req: any, res: any, next: any) => {
        req.user = { userId: 'test_user_id' };
        next();
    }
}));
jest.mock('../config/integrations', () => ({
    getMetaConfig: jest.fn().mockResolvedValue({
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        redirectUri: 'http://localhost/callback',
        scopes: ['ads_management', 'pages_show_list']
    }),
    getMetaFlowConfig: jest.fn().mockImplementation((flow: string) => {
        const scopes = flow === 'instagram'
            ? ['instagram_business_basic', 'instagram_business_content_publish']
            : ['ads_management', 'pages_show_list'];
        return {
            authorizationUrl: 'https://www.facebook.com/v25.0/dialog/oauth',
            tokenUrl: 'https://graph.facebook.com/v25.0/oauth/access_token',
            scopes
        };
    }),
    INTEGRATION_CONFIG: {
        meta: {
            redirectUri: 'http://localhost/callback',
            marketingScopes: ['ads_management', 'pages_show_list'],
            instagramScopes: ['instagram_business_basic']
        },
        // ENG-1644 gap-closing: /connect-ad-accounts now transitively pulls
        // in linkedInAdsService.ts (via approvalInboxCustomerNotify.ts's
        // chatbotService/agentModeService chain), which reads this at
        // module-load time. Real INTEGRATION_CONFIG.linkedinAds.apiVersion
        // is always populated (config/integrations.ts) — this mock just
        // needs to match that shape now, not a real LinkedIn Ads test concern.
        linkedinAds: {
            apiVersion: '202603',
        }
    }
}));

const app = express();
app.use(express.json());
app.use('/auth/meta', metaAuthRouter);

describe('Meta Auth Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSessionStore.clear();
        // ENG-2232: default to "no existing ads sampled" so the wrong-Page
        // cross-check in /connect-ad-accounts is a no-op unless a test opts in —
        // matches the real method's own never-throws-returns-[] contract.
        (metaService.getExistingAdPageIds as jest.Mock).mockResolvedValue([]);
    });

    describe('POST /finalize — getAdAccounts error reporting', () => {
        const finalizeMarketing = async () => {
            (axios.get as jest.Mock).mockResolvedValue({
                data: { access_token: 'valid_access_token', expires_in: 3600 }
            });
            jest.spyOn(jwt, 'verify').mockReturnValue({ userId: 'test_user_id', flow: 'marketing' } as any);
            return request(app)
                .post('/auth/meta/finalize')
                .send({ code: 'valid_code', state: 'valid_state' });
        };

        it('sets adAccountsError and logs via console.error when getAdAccounts throws', async () => {
            const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const metaError: any = new Error('(#200) Requires business_management permission');
            metaError.structuredError = { code: 200, classification: 'PERMISSION_ERROR' };
            (metaService.getAdAccounts as jest.Mock).mockRejectedValue(metaError);

            const res = await finalizeMarketing();

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.adAccounts).toBeUndefined();
            expect(res.body.adAccountsError).toBe(true);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('[Meta Finalize] getAdAccounts failed'),
                expect.objectContaining({
                    code: 200,
                    classification: 'PERMISSION_ERROR',
                    message: expect.stringContaining('business_management')
                })
            );
            consoleErrorSpy.mockRestore();
        });

        it('does not set adAccountsError when getAdAccounts succeeds', async () => {
            (metaService.getAdAccounts as jest.Mock).mockResolvedValue([
                { id: 'act_1', name: 'A', account_id: '1', currency: 'USD', account_status: 1 }
            ]);

            const res = await finalizeMarketing();

            expect(res.status).toBe(200);
            expect(res.body.adAccounts).toHaveLength(1);
            expect(res.body.adAccountsError).toBeUndefined();
        });

        it('does not set adAccountsError when the user genuinely has zero ad accounts', async () => {
            (metaService.getAdAccounts as jest.Mock).mockResolvedValue([]);

            const res = await finalizeMarketing();

            expect(res.status).toBe(200);
            expect(res.body.adAccounts).toBeUndefined();
            expect(res.body.adAccountsError).toBeUndefined();
        });
    });

    describe('POST /connect-ad-accounts', () => {
        it('should connect ad accounts using valid session ID', async () => {
            // 1. Setup: Call /finalize first to generate a valid session ID
            const mockMetaTokenResponse = {
                data: {
                    access_token: 'valid_access_token',
                    expires_in: 3600
                }
            };

            const mockAdAccountsResponse = [
                {
                    account_id: 'act_123',
                    name: 'Test Ad Account',
                    currency: 'USD',
                    account_status: 1
                }
            ];

            // Mock axios for the token exchange in /finalize
            (axios.get as jest.Mock).mockResolvedValue(mockMetaTokenResponse);

            // Mock metaService for fetching accounts in /finalize
            (metaService.getAdAccounts as jest.Mock).mockResolvedValue(mockAdAccountsResponse);
            (metaService.getPages as jest.Mock).mockResolvedValue([]);

            // Mock verifyState to return valid user
            // We need to export/mock verifyState or mock jwt.verify if it's used internally
            // Since verifyState is internal and uses jwt.verify, we can mock jwt.verify
            jest.spyOn(jwt, 'verify').mockReturnValue({ userId: 'test_user_id' } as any);

            // POST /finalize
            const finalizeRes = await request(app)
                .post('/auth/meta/finalize')
                .send({
                    code: 'valid_code',
                    state: 'valid_state'
                });

            expect(finalizeRes.status).toBe(200);
            const tokenSessionId = finalizeRes.body.tokenSessionId;
            expect(tokenSessionId).toBeDefined();

            // 2. Test: Connect Ad Accounts using the session ID
            (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
                platform: 'meta',
                account_id: 'act_123'
            });

            const response = await request(app)
                .post('/auth/meta/connect-ad-accounts')
                .send({
                    tokenSessionId: tokenSessionId,
                    adAccounts: [
                        {
                            account_id: 'act_123',
                            name: 'Test Ad Account',
                            currency: 'USD',
                            account_status: 1
                        }
                    ]
                });

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
                'test_user_id',
                'meta',
                expect.objectContaining({
                    config: expect.objectContaining({
                        access_token: 'valid_access_token'
                    })
                })
            );
            // ENG-1644 gap-closing: a real successful reconnect must try to
            // auto-resolve any matching pending decision for this exact account.
            expect(safeAutoResolveCredentialDecision).toHaveBeenCalledWith('Meta Connect Ad Accounts', 'test_user_id', 'meta', 'act_123');
        });

        it('should reject request without token session ID', async () => {
            const response = await request(app)
                .post('/auth/meta/connect-ad-accounts')
                .send({
                    adAccounts: []
                });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('No ad accounts provided');
        });

        it('should reject request with invalid token session ID', async () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

            const response = await request(app)
                .post('/auth/meta/connect-ad-accounts')
                .send({
                    tokenSessionId: 'invalid_session_id',
                    adAccounts: [{ account_id: '123', name: 'Test' }]
                });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Invalid or expired token session');
            expect(consoleSpy).toHaveBeenCalled();

            consoleSpy.mockRestore();
        });
    });

    describe('GET /init-meta', () => {
        it('should return auth url with correct scopes for facebook flow', async () => {
            const response = await request(app)
                .get('/auth/meta/init?flow=facebook');

            expect(response.status).toBe(200);
            expect(response.body.url).toBeDefined();
            expect(response.body.url).toContain('scope=');
            expect(response.body.url).not.toContain('instagram_business_basic'); // Not an IG flow
        });

        it('should return auth url with instagram scopes for instagram flow', async () => {
            // Modify the mocked config specifically for instagram testing scopes payload
            const integrations = require('../config/integrations');
            integrations.INTEGRATION_CONFIG.meta.instagramScopes = ['instagram_business_basic', 'instagram_business_content_publish'];

            const response = await request(app)
                .get('/auth/meta/init?flow=instagram');

            expect(response.status).toBe(200);
            expect(response.body.url).toBeDefined();
            // It should be injected with the specific IG scopes
            expect(response.body.url).toContain('instagram_business_basic');
        });
    });

    describe('POST /finalize', () => {
        let integrations: any;
        beforeEach(() => {
            jest.clearAllMocks();
            integrations = require('../config/integrations');
        });

        it('should exchange short-lived token for long-lived one if flow is instagram', async () => {
            const mockMetaTokenResponse = {
                data: {
                    access_token: 'short_lived_token',
                    expires_in: 3600
                }
            };

            const mockLongLivedResponse = {
                access_token: 'long_lived_token',
                expires_in: 5184000
            };

            (axios.get as jest.Mock).mockResolvedValue(mockMetaTokenResponse);
            (axios.post as jest.Mock).mockResolvedValue(mockMetaTokenResponse);
            const { instagramService } = require('../services/instagramService');
            instagramService.getLongLivedToken.mockResolvedValue(mockLongLivedResponse);
            jest.spyOn(jwt, 'verify').mockReturnValue({ userId: 'test_user_id', flow: 'instagram' } as any);

            const response = await request(app)
                .post('/auth/meta/finalize')
                .send({
                    code: 'valid_code',
                    state: 'valid_state',
                    flow: 'instagram'
                });

            expect(response.status).toBe(200);
            expect(instagramService.getLongLivedToken).toHaveBeenCalledWith('short_lived_token', 'test_client_secret');
            
            // Note: Since storeTokenSession stores in memory map, we can check if response implies success
            expect(response.body.tokenSessionId).toBeDefined();
        });
    });

    describe('Token Session Caching & Expiry Math', () => {
        let testSessionId: string;

        beforeEach(async () => {
            // Setup a token session to manipulate
            jest.spyOn(jwt, 'verify').mockReturnValue({ userId: 'test_user_id' } as any);
            (axios.get as jest.Mock).mockResolvedValue({
                data: { access_token: 'dynamic_expiry_token', expires_in: 3600 }
            });
            (metaService.getAdAccounts as jest.Mock).mockResolvedValue([]);
            (metaService.getPages as jest.Mock).mockResolvedValue([]);

            const finalizeRes = await request(app)
                .post('/auth/meta/finalize')
                .send({ code: 'valid_code', state: 'valid_state' });

            testSessionId = finalizeRes.body.tokenSessionId;
        });

        it('should strictly retain token payload in memory across multiple sequential requests to fix race-conditions', async () => {
            // Mock createAccount to not fail
            (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({});

            // Request 1: Should not delete session
            const firstRequest = await request(app)
                .post('/auth/meta/connect-ad-accounts')
                .send({ tokenSessionId: testSessionId, adAccounts: [{ account_id: 'act_123', name: 'Test Ad Account' }] });

            expect(firstRequest.status).toBe(200);

            // Request 2: Should successfully retrieve and execute again because the session wasn't dropped
            const secondRequest = await request(app)
                .post('/auth/meta/connect-instagram')
                .send({ tokenSessionId: testSessionId, instagramAccount: { id: 'ig_123', username: 'Test IG Account' } });

            expect(secondRequest.status).toBe(200);
        });

        it('should reject connect-instagram without instagramAccount', async () => {
            const response = await request(app)
                .post('/auth/meta/connect-instagram')
                .send({ tokenSessionId: testSessionId });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('No Instagram account provided');
        });

        it('should reject connect-instagram without tokenSessionId', async () => {
            const response = await request(app)
                .post('/auth/meta/connect-instagram')
                .send({ instagramAccount: { id: 'ig_123', username: 'test' } });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Missing token session ID');
        });

        it('should reject connect-instagram with invalid tokenSessionId', async () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });

            const response = await request(app)
                .post('/auth/meta/connect-instagram')
                .send({ tokenSessionId: 'invalid_session', instagramAccount: { id: 'ig_123', username: 'test' } });

            expect(response.status).toBe(400);
            expect(response.body.error).toBe('Invalid or expired token session');

            consoleSpy.mockRestore();
        });

        it('should apply dynamic token_expires_at arithmetic logic natively for instagram accounts', async () => {
            (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({});

            await request(app)
                .post('/auth/meta/connect-instagram')
                .send({ tokenSessionId: testSessionId, instagramAccount: { id: 'ig_123', username: 'Test IG Account' } });

            expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
                'test_user_id',
                'instagram',
                expect.objectContaining({
                    config: expect.objectContaining({
                        account_type: 'instagram_business',
                        token_expires_at: expect.any(Number) // Assert mathematical assignment occurred
                    })
                })
            );
        });
    });

    /**
     * ENG-629 — persist the scopes Meta actually GRANTED, not the ones requested.
     *
     * Before this, `config.scopes` was set to `flowCfg.scopes` unconditionally, so
     * a connection recorded ads_management/ads_read even when the user unticked
     * them at the consent dialog. That is the defect behind OPS-79: the capability
     * signal was a copy of our own request.
     */
    describe('POST /connect-ad-accounts — granted scope capture (ENG-629)', () => {
        const connectWithGrant = async (granted: string[] | undefined) => {
            (axios.get as jest.Mock).mockResolvedValue({
                data: { access_token: 'valid_access_token', expires_in: 3600 }
            });
            (metaService.getAdAccounts as jest.Mock).mockResolvedValue([
                { account_id: 'act_123', name: 'Test Ad Account', currency: 'USD', account_status: 1 }
            ]);
            (metaService.getPages as jest.Mock).mockResolvedValue([]);
            (metaService.getGrantedScopes as jest.Mock).mockResolvedValue(granted);
            (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
                platform: 'meta',
                account_id: 'act_123'
            });
            jest.spyOn(jwt, 'verify').mockReturnValue({ userId: 'test_user_id', flow: 'marketing' } as any);

            const finalizeRes = await request(app)
                .post('/auth/meta/finalize')
                .send({ code: 'valid_code', state: 'valid_state' });

            return request(app)
                .post('/auth/meta/connect-ad-accounts')
                .send({
                    tokenSessionId: finalizeRes.body.tokenSessionId,
                    adAccounts: [{ account_id: 'act_123', name: 'Test Ad Account', currency: 'USD', account_status: 1 }]
                });
        };

        it('inspects the issued token to discover what Meta actually granted', async () => {
            await connectWithGrant(['ads_read', 'pages_show_list']);

            expect(metaService.getGrantedScopes).toHaveBeenCalledWith('valid_access_token');
        });

        it('stores granted_scopes on the ad account config', async () => {
            const response = await connectWithGrant(['ads_read', 'pages_show_list']);

            expect(response.status).toBe(200);
            expect(connectedAccountsDb.createAccount).toHaveBeenCalledWith(
                'test_user_id',
                'meta',
                expect.objectContaining({
                    config: expect.objectContaining({
                        granted_scopes: ['ads_read', 'pages_show_list']
                    })
                })
            );
        });

        it('records a grant WITHOUT ads scopes truthfully instead of echoing the request', async () => {
            // The OPS-79 consent shape. Previously this stored ads_management anyway.
            const response = await connectWithGrant(['pages_show_list', 'public_profile']);

            expect(response.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.granted_scopes).toEqual(['pages_show_list', 'public_profile']);
            expect(config.granted_scopes).not.toContain('ads_read');
            expect(config.granted_scopes).not.toContain('ads_management');
        });

        it('omits granted_scopes entirely when the grant could not be determined', async () => {
            // Must not write [] — that would read as an authoritative "nothing granted"
            // and lock out a working connection.
            const response = await connectWithGrant(undefined);

            expect(response.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.granted_scopes).toBeUndefined();
        });

        it('still connects the account when scope inspection fails outright', async () => {
            (metaService.getGrantedScopes as jest.Mock).mockRejectedValue(new Error('debug_token down'));
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            const response = await connectWithGrant(undefined);

            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            consoleWarnSpy.mockRestore();
        });

        it('keeps the legacy requested-scopes field for backward compatibility', async () => {
            await connectWithGrant(['ads_read']);

            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.scopes).toEqual(['ads_management', 'pages_show_list']);
        });
    });

    /**
     * ENG-2232 — Page access is a second, independent Meta grant from the ads
     * scope: production account 1209971551106961 had ads_read granted and 0
     * accessible Pages both before AND after the customer reconnected, and
     * nothing probed or recorded that until the first AD_CREATIVE failed —
     * after 4 campaigns and 4 ad sets were already built and approved.
     */
    describe('POST /finalize + /connect-ad-accounts — Page access capture (ENG-2232)', () => {
        const connectWithPages = async (pages: any[] | 'error') => {
            (axios.get as jest.Mock).mockResolvedValue({
                data: { access_token: 'valid_access_token', expires_in: 3600 }
            });
            (metaService.getAdAccounts as jest.Mock).mockResolvedValue([
                { account_id: 'act_123', name: 'Test Ad Account', currency: 'USD', account_status: 1 }
            ]);
            (metaService.getGrantedScopes as jest.Mock).mockResolvedValue(['ads_read']);
            if (pages === 'error') {
                (metaService.getPages as jest.Mock).mockRejectedValue(new Error('Graph API down'));
            } else {
                (metaService.getPages as jest.Mock).mockResolvedValue(pages);
            }
            (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
                platform: 'meta',
                account_id: 'act_123'
            });
            jest.spyOn(jwt, 'verify').mockReturnValue({ userId: 'test_user_id', flow: 'marketing' } as any);

            const finalizeRes = await request(app)
                .post('/auth/meta/finalize')
                .send({ code: 'valid_code', state: 'valid_state' });

            const connectRes = await request(app)
                .post('/auth/meta/connect-ad-accounts')
                .send({
                    tokenSessionId: finalizeRes.body.tokenSessionId,
                    adAccounts: [{ account_id: 'act_123', name: 'Test Ad Account', currency: 'USD', account_status: 1 }]
                });

            return { finalizeRes, connectRes };
        };

        it('probes PAGE LIST during finalize and reports hasMetaPages: false for zero Pages', async () => {
            const { finalizeRes } = await connectWithPages([]);

            expect(metaService.getPages).toHaveBeenCalledWith('valid_access_token');
            expect(finalizeRes.body.hasMetaPages).toBe(false);
        });

        it('reports hasMetaPages: true when at least one Page is accessible', async () => {
            const { finalizeRes } = await connectWithPages([{ id: 'page_1', name: 'My Health Surveys' }]);

            expect(finalizeRes.body.hasMetaPages).toBe(true);
        });

        it('persists has_meta_pages: false on the connected ad account config', async () => {
            const { connectRes } = await connectWithPages([]);

            expect(connectRes.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBe(false);
        });

        it('persists has_meta_pages: true when Pages are accessible', async () => {
            await connectWithPages([{ id: 'page_1', name: 'My Health Surveys' }]);

            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBe(true);
        });

        it('persists accessible_page_ids alongside has_meta_pages (ENG-2232)', async () => {
            await connectWithPages([
                { id: 'page_1', name: 'My Health Surveys' },
                { id: 'page_2', name: 'Other Page' },
            ]);

            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.accessible_page_ids).toEqual(['page_1', 'page_2']);
        });

        it('omits accessible_page_ids (never writes []) when the Page probe itself fails', async () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            await connectWithPages('error');

            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.accessible_page_ids).toBeUndefined();

            consoleWarnSpy.mockRestore();
        });

        it('omits has_meta_pages (never writes false) when the Page probe itself fails', async () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            const { finalizeRes, connectRes } = await connectWithPages('error');

            expect(metaService.getPages).toHaveBeenCalledWith('valid_access_token');
            expect(finalizeRes.body.hasMetaPages).toBeUndefined();
            expect(connectRes.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBeUndefined();

            consoleWarnSpy.mockRestore();
        });

        /**
         * ENG-2232 code review follow-up: the "fall back to the existing
         * account's recorded value" branch above (fix commit 75528ce01) had no
         * test exercising it with a REAL existing value — every prior test left
         * `getAccountById` at its automock default of `undefined`, so this
         * branch always took the "nothing to fall back to" path regardless of
         * whether the fallback logic itself was correct.
         */
        it('falls back to the existing account\'s recorded has_meta_pages when a reconnect\'s probe fails', async () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            (connectedAccountsDb.getAccountById as jest.Mock).mockResolvedValue({
                platform: 'meta',
                account_id: 'act_123',
                config: { has_meta_pages: false, accessible_page_ids: [] },
            });

            const { connectRes } = await connectWithPages('error');

            expect(connectRes.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBe(false);
            expect(config.accessible_page_ids).toEqual([]);

            consoleWarnSpy.mockRestore();
        });

        /**
         * ENG-2232 code review follow-up: getAccountById elsewhere in this
         * codebase (getMetaCredentials) treats the legacy 'facebook' platform
         * value as the same account as 'meta' for backward compatibility with
         * connections made before the platform name was standardized. A lookup
         * scoped to 'meta' alone would silently miss the recorded value on any
         * account still stored under the old name.
         */
        it('finds the existing value even when it is recorded under the legacy \'facebook\' platform value', async () => {
            const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            (connectedAccountsDb.getAccountById as jest.Mock).mockImplementation(
                async (accountId: string, userId: string, platform?: string | string[]) => {
                    const platforms = Array.isArray(platform) ? platform : [platform];
                    if (!platforms.includes('facebook')) return null;
                    return {
                        platform: 'facebook',
                        account_id: accountId,
                        config: { has_meta_pages: false, accessible_page_ids: [] },
                    };
                }
            );

            const { connectRes } = await connectWithPages('error');

            expect(connectRes.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBe(false);

            consoleWarnSpy.mockRestore();
        });
    });

    /**
     * ENG-2232 — the subtler sibling: "at least one Page" isn't the same as
     * "the Page this account's existing ads actually run under". An account
     * can hold access to some unrelated Page while its real ads keep failing.
     */
    describe('POST /connect-ad-accounts — wrong-Page cross-check (ENG-2232)', () => {
        const connectWithPagesAndExistingAds = async (pages: any[], existingAdPageIds: string[]) => {
            (axios.get as jest.Mock).mockResolvedValue({
                data: { access_token: 'valid_access_token', expires_in: 3600 }
            });
            (metaService.getAdAccounts as jest.Mock).mockResolvedValue([
                { account_id: 'act_123', name: 'Test Ad Account', currency: 'USD', account_status: 1 }
            ]);
            (metaService.getGrantedScopes as jest.Mock).mockResolvedValue(['ads_read']);
            (metaService.getPages as jest.Mock).mockResolvedValue(pages);
            (metaService.getExistingAdPageIds as jest.Mock).mockResolvedValue(existingAdPageIds);
            (connectedAccountsDb.createAccount as jest.Mock).mockResolvedValue({
                platform: 'meta',
                account_id: 'act_123'
            });
            jest.spyOn(jwt, 'verify').mockReturnValue({ userId: 'test_user_id', flow: 'marketing' } as any);

            const finalizeRes = await request(app)
                .post('/auth/meta/finalize')
                .send({ code: 'valid_code', state: 'valid_state' });

            const connectRes = await request(app)
                .post('/auth/meta/connect-ad-accounts')
                .send({
                    tokenSessionId: finalizeRes.body.tokenSessionId,
                    adAccounts: [{ account_id: 'act_123', name: 'Test Ad Account', currency: 'USD', account_status: 1 }]
                });

            return { finalizeRes, connectRes };
        };

        it('downgrades has_meta_pages to false and names the Page when existing ads use a Page outside the accessible set', async () => {
            const { connectRes } = await connectWithPagesAndExistingAds(
                [{ id: 'page_unrelated', name: 'Some Other Page' }],
                ['1010991085424542'],
            );

            expect(connectRes.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBe(false);
            expect(config.existing_ads_page_id).toBe('1010991085424542');
        });

        it('keeps has_meta_pages true when the accessible Pages include the one existing ads use', async () => {
            const { connectRes } = await connectWithPagesAndExistingAds(
                [{ id: '1010991085424542', name: 'My Health Surveys' }],
                ['1010991085424542'],
            );

            expect(connectRes.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBe(true);
            expect(config.existing_ads_page_id).toBeUndefined();
        });

        it('keeps has_meta_pages true when no existing-ad Page could be sampled (best-effort, no verdict either way)', async () => {
            const { connectRes } = await connectWithPagesAndExistingAds(
                [{ id: 'page_1', name: 'My Health Surveys' }],
                [],
            );

            expect(connectRes.status).toBe(200);
            const config = (connectedAccountsDb.createAccount as jest.Mock).mock.calls[0][2].config;
            expect(config.has_meta_pages).toBe(true);
        });

        it('does not run the cross-check at all when the login has zero Pages (already false, nothing to tighten)', async () => {
            await connectWithPagesAndExistingAds([], ['1010991085424542']);

            expect(metaService.getExistingAdPageIds).not.toHaveBeenCalled();
        });
    });
});
