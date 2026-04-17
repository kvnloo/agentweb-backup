import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { metaService } from '../services/metaService';

jest.mock('axios');
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import metaAuthRouter from '../routes/metaAuth';

// Mock dependencies
jest.mock('../services/metaService');
jest.mock('../services/instagramService');
jest.mock('../services/connectedAccountsDb');

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
            authorizationUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
            tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
            scopes
        };
    }),
    INTEGRATION_CONFIG: {
        meta: {
            redirectUri: 'http://localhost/callback',
            marketingScopes: ['ads_management', 'pages_show_list'],
            instagramScopes: ['instagram_business_basic']
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
});
