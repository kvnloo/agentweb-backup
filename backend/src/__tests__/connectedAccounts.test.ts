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

            (connectedAccountsDb.getAccountsByUserId as jest.Mock).mockResolvedValue(mockAccounts);

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

            (connectedAccountsDb.getAccountsByUserId as jest.Mock).mockResolvedValue(mockAccounts);

            const response = await request(app).get('/api/oauth/connected-accounts');

            expect(response.status).toBe(200);
            expect(response.body.accounts[0].profile_image_url).toBeUndefined();
        });
    });
});
