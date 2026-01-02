/**
 * Unit tests for LinkedIn OAuth routes
 * Tests cover: OAuth endpoints, input validation, error handling
 * Uses supertest for HTTP integration testing
 */
import request from 'supertest';
import express, { Application } from 'express';

// Set required environment variable BEFORE any imports
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';
process.env.VITE_CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

// Mock connectedAccountsDb
jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn(),
}));

// Mock linkedInService
jest.mock('../services/linkedInService', () => ({
  linkedInService: {
    getProfile: jest.fn(),
    getAdminOrganizations: jest.fn(),
    getOrganization: jest.fn(),
    getOrganizationFollowerCount: jest.fn(),
  },
}));

// Mock integrations config
jest.mock('../config/integrations', () => ({
  getLinkedInConfig: jest.fn(),
  getLinkedInOrgConfig: jest.fn(),
}));

// Mock axios
jest.mock('axios');

// Mock auth middleware to authenticate all requests
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'test-user-id', email: 'test@example.com' };
    next();
  },
}));

// Import modules after mocks are set up
import linkedinAuthRouter from '../routes/linkedinAuth';
import { createAccount } from '../services/connectedAccountsDb';
import { linkedInService } from '../services/linkedInService';
import { getLinkedInConfig, getLinkedInOrgConfig } from '../config/integrations';
import axios from 'axios';

// Create test app
const createTestApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/api/oauth/linkedin', linkedinAuthRouter);
  return app;
};

describe('LinkedIn OAuth Routes', () => {
  let app: Application;

  // Cast to mocked types
  const mockCreateAccount = createAccount as jest.MockedFunction<typeof createAccount>;
  const mockLinkedInService = linkedInService as jest.Mocked<typeof linkedInService>;
  const mockGetLinkedInConfig = getLinkedInConfig as jest.MockedFunction<typeof getLinkedInConfig>;
  const mockGetLinkedInOrgConfig = getLinkedInOrgConfig as jest.MockedFunction<typeof getLinkedInOrgConfig>;
  const mockAxios = axios as jest.Mocked<typeof axios>;

  // Mock LinkedIn config
  const mockLinkedInConfigData = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3000/api/oauth/linkedin/callback',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    scopes: ['openid', 'profile', 'email'],
  };

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mock returns
    mockGetLinkedInConfig.mockResolvedValue(mockLinkedInConfigData as any);
    mockGetLinkedInOrgConfig.mockResolvedValue({
      ...mockLinkedInConfigData,
      scopes: ['r_organization_admin', 'w_organization_social'],
    } as any);
  });

  afterAll(() => {
    // Clean up any timers
    jest.useRealTimers();
  });

  // ============================================
  // Personal OAuth Flow Tests
  // ============================================
  describe('Personal OAuth Flow', () => {
    describe('GET /api/oauth/linkedin/init', () => {
      it('should return a valid LinkedIn authorization URL', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/init')
          .expect(200);

        expect(mockGetLinkedInConfig).toHaveBeenCalled();
        expect(response.body.success).toBe(true);
        expect(response.body.url).toContain('https://www.linkedin.com/oauth/v2/authorization');
      });

      it('should include client_id, redirect_uri, state, and scope in URL', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/init')
          .expect(200);

        const url = new URL(response.body.url);
        expect(url.searchParams.get('client_id')).toBe('test-client-id');
        expect(url.searchParams.get('redirect_uri')).toBe(mockLinkedInConfigData.redirectUri);
        expect(url.searchParams.has('state')).toBe(true);
        expect(url.searchParams.get('scope')).toBe('openid profile email');
      });

      it('should return 500 if config fetch fails', async () => {
        mockGetLinkedInConfig.mockRejectedValue(new Error('Config error'));

        const response = await request(app)
          .get('/api/oauth/linkedin/init')
          .expect(500);

        expect(response.body.error).toBe('Failed to initialize LinkedIn OAuth');
      });
    });

    describe('GET /api/oauth/linkedin/callback', () => {
      it('should redirect to frontend with code and state on success', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/callback')
          .query({ code: 'auth-code-123', state: 'state-token' })
          .expect(302);

        expect(response.headers.location).toBe(
          'http://localhost:5174/oauth/linkedin/callback?linkedin_code=auth-code-123&state=state-token'
        );
      });

      it('should redirect with error when LinkedIn returns error', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/callback')
          .query({ error: 'access_denied' })
          .expect(302);

        expect(response.headers.location).toContain('error=linkedin_access_denied');
      });

      it('should redirect with error when no code is provided', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/callback')
          .query({ state: 'some-state' })
          .expect(302);

        expect(response.headers.location).toContain('error=no_code_provided');
      });
    });

    describe('POST /api/oauth/linkedin/connect', () => {
      it('should return 400 if code is missing', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect')
          .send({ state: 'valid-state' })
          .expect(400);

        expect(response.body.error).toBe('Invalid or missing OAuth code');
      });

      it('should return 400 if code is empty string', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect')
          .send({ code: '   ', state: 'valid-state' })
          .expect(400);

        expect(response.body.error).toBe('Invalid or missing OAuth code');
      });

      it('should return 400 if state is missing', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect')
          .send({ code: 'valid-code' })
          .expect(400);

        expect(response.body.error).toBe('Invalid or missing state parameter');
      });

      it('should return 403 for invalid state (CSRF protection)', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect')
          .send({ code: 'valid-code', state: 'invalid-jwt-state' })
          .expect(403);

        expect(response.body.error).toBe('Invalid or expired state parameter. CSRF protection.');
      });
    });
  });

  // ============================================
  // Organization OAuth Flow Tests
  // ============================================
  describe('Organization OAuth Flow', () => {
    describe('GET /api/oauth/linkedin/org/init', () => {
      it('should return LinkedIn organization authorization URL', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/org/init')
          .expect(200);

        expect(mockGetLinkedInOrgConfig).toHaveBeenCalled();
        expect(response.body.success).toBe(true);
        expect(response.body.url).toContain('https://www.linkedin.com/oauth/v2/authorization');
      });

      it('should include organization scopes in URL', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/org/init')
          .expect(200);

        const url = new URL(response.body.url);
        expect(url.searchParams.get('scope')).toBe('r_organization_admin w_organization_social');
      });
    });

    describe('GET /api/oauth/linkedin/org/callback', () => {
      it('should redirect with linkedin_org_code parameter', async () => {
        const response = await request(app)
          .get('/api/oauth/linkedin/org/callback')
          .query({ code: 'org-auth-code', state: 'org-state' })
          .expect(302);

        expect(response.headers.location).toBe(
          'http://localhost:5174/oauth/linkedin/callback?linkedin_org_code=org-auth-code&state=org-state'
        );
      });
    });

    describe('POST /api/oauth/linkedin/connect-pages', () => {
      const mockOrganizations = [
        { urn: 'urn:li:organization:123', id: '123', name: 'Test Company' },
      ];

      it('should return 400 if organizations array is missing', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect-pages')
          .send({ tokenSessionId: 'valid-session-id' })
          .expect(400);

        expect(response.body.error).toBe('No organizations selected');
      });

      it('should return 400 if organizations array is empty', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect-pages')
          .send({ organizations: [], tokenSessionId: 'valid-session-id' })
          .expect(400);

        expect(response.body.error).toBe('No organizations selected');
      });

      it('should return 400 if tokenSessionId is missing', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect-pages')
          .send({ organizations: mockOrganizations })
          .expect(400);

        expect(response.body.error).toBe('Missing token session ID');
      });

      it('should return 401 if token session is invalid or expired', async () => {
        const response = await request(app)
          .post('/api/oauth/linkedin/connect-pages')
          .send({
            organizations: mockOrganizations,
            tokenSessionId: 'nonexistent-session-id',
          })
          .expect(401);

        expect(response.body.error).toBe('Invalid or expired token session. Please reconnect.');
      });
    });
  });

  // ============================================
  // Input Validation Edge Cases
  // ============================================
  describe('Input Validation Edge Cases', () => {
    it('should reject null code', async () => {
      const response = await request(app)
        .post('/api/oauth/linkedin/connect')
        .send({ code: null, state: 'valid-state' })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing OAuth code');
    });

    it('should reject non-string code', async () => {
      const response = await request(app)
        .post('/api/oauth/linkedin/connect')
        .send({ code: 12345, state: 'valid-state' })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing OAuth code');
    });

    it('should reject whitespace-only state', async () => {
      const response = await request(app)
        .post('/api/oauth/linkedin/connect')
        .send({ code: 'valid-code', state: '   ' })
        .expect(400);

      expect(response.body.error).toBe('Invalid or missing state parameter');
    });
  });
});
