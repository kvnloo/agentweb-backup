import express from 'express';
import request from 'supertest';
import { authenticateToken } from '../../middleware/auth';
import { createAccount } from '../../services/connectedAccountsDb';
import { linkedInOutreachService } from '../../services/linkedInOutreachService';
import linkedInOutreachAuthRouter from '../linkedInOutreachAuth';

// Mock dependencies
jest.mock('../../middleware/auth', () => ({
  authenticateToken: jest.fn((req, res, next) => {
    req.user = { userId: 'user-123' };
    next();
  }),
}));

jest.mock('../../services/connectedAccountsDb', () => ({
  createAccount: jest.fn(),
}));

jest.mock('../../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    getClient: jest.fn(),
    getApiUrl: jest.fn(),
    getAccount: jest.fn(),
    clearStatusCache: jest.fn(),
  },
}));

describe('LinkedIn Outreach Auth Router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/', linkedInOutreachAuthRouter);
  });

  describe('GET /init', () => {
    it('should successfully generate a hosted auth link', async () => {
      const mockAuthLink = { url: 'https://unipile.com/auth-link?id=123' };
      const mockClient = {
        account: {
          createHostedAuthLink: jest.fn().mockResolvedValue(mockAuthLink),
        },
      };

      (linkedInOutreachService.getClient as jest.Mock).mockResolvedValue(mockClient);
      (linkedInOutreachService.getApiUrl as jest.Mock).mockResolvedValue('https://api.unipile.com');

      const response = await request(app).get('/init');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, url: mockAuthLink.url });
      expect(linkedInOutreachService.getClient).toHaveBeenCalled();
      expect(linkedInOutreachService.getApiUrl).toHaveBeenCalled();
      expect(mockClient.account.createHostedAuthLink).toHaveBeenCalledWith({
        type: 'create',
        providers: ['LINKEDIN'],
        expiresOn: expect.any(String),
        success_redirect_url: expect.stringContaining('/oauth/linkedin-outreach/callback'),
        failure_redirect_url: expect.stringContaining('/oauth/linkedin-outreach/callback?error=connection_failed'),
        api_url: 'https://api.unipile.com',
      });
    });

    it('should handle errors generating auth link', async () => {
      const errorMessage = 'Unipile API Error';
      (linkedInOutreachService.getClient as jest.Mock).mockRejectedValue(new Error(errorMessage));

      const response = await request(app).get('/init');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to initialize LinkedIn Outreach connection', details: errorMessage });
    });
  });

  describe('POST /save-account', () => {
    it('should return 400 if unipileAccountId is missing', async () => {
      const response = await request(app).post('/save-account').send({});

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Missing or invalid unipileAccountId' });
    });

    it('should save with fallback name when getAccount returns non-LINKEDIN type on all retries', async () => {
      jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
      const invalidAccount = { type: 'TWITTER' };
      (linkedInOutreachService.getAccount as jest.Mock).mockResolvedValue(invalidAccount);
      const mockCreatedAccount = { id: 'db-acc-1', account_name: 'LinkedIn Account' };
      (createAccount as jest.Mock).mockResolvedValue(mockCreatedAccount);

      const response = await request(app).post('/save-account').send({ unipileAccountId: 'acc-123' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, account: mockCreatedAccount });
      // Retried 3 times before falling back
      expect(linkedInOutreachService.getAccount).toHaveBeenCalledTimes(3);
      expect(createAccount).toHaveBeenCalledWith('user-123', 'unipile', expect.objectContaining({
        account_name: 'LinkedIn Account',
      }));
      jest.restoreAllMocks();
    }, 10000);

    it('should successfully save a valid LinkedIn account', async () => {
      const mockUnipileAccount = {
        type: 'LINKEDIN',
        name: 'John Doe',
        connection_params: {
          im: { username: 'johndoe123' },
        },
      };
      const mockCreatedAccount = { id: 'db-acc-1', account_name: 'John Doe' };

      (linkedInOutreachService.getAccount as jest.Mock).mockResolvedValue(mockUnipileAccount);
      (createAccount as jest.Mock).mockResolvedValue(mockCreatedAccount);

      const response = await request(app).post('/save-account').send({ unipileAccountId: 'acc-123' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ success: true, account: mockCreatedAccount });
      expect(linkedInOutreachService.getAccount).toHaveBeenCalledWith('acc-123');
      expect(linkedInOutreachService.clearStatusCache).toHaveBeenCalledWith('acc-123');
      expect(createAccount).toHaveBeenCalledWith('user-123', 'unipile', {
        account_id: 'acc-123',
        account_name: 'John Doe',
        config: {
          account_type: 'personal',
          unipile_account_id: 'acc-123',
          username: 'johndoe123',
          access_token: 'unipile:acc-123',
          token_expires_at: Number.MAX_SAFE_INTEGER,
          scopes: [],
        }
      });
    });

    it('should return 500 when createAccount throws after getAccount retries are exhausted', async () => {
      jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any; });
      const errorMessage = 'Database error';
      // getAccount always fails — falls through to fallback name; createAccount then throws
      (linkedInOutreachService.getAccount as jest.Mock).mockRejectedValue(new Error('Unipile unavailable'));
      (createAccount as jest.Mock).mockRejectedValue(new Error(errorMessage));

      const response = await request(app).post('/save-account').send({ unipileAccountId: 'acc-123' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Failed to save LinkedIn Outreach account', details: errorMessage });
      jest.restoreAllMocks();
    }, 10000);
  });
});
