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
jest.mock('../services/connectedAccountsDb');
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
    })
}));

const app = express();
app.use(express.json());
app.use('/auth/meta', metaAuthRouter);

describe('Meta Auth Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
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
});
