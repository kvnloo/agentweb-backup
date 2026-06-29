/**
 * Unit tests for Google Drive OAuth routes
 *   GET  /api/oauth/google-drive/init
 *   GET  /api/oauth/google-drive/callback
 *   POST /api/oauth/google-drive/finalize
 *   POST /api/oauth/google-drive/connect
 *
 * All AWS / DB dependencies are mocked so no real infrastructure is needed.
 */

// ---------------------------------------------------------------------------
// Environment — must be set before any module is loaded.
// (jest.mock calls are hoisted above imports; this assignment runs after
//  hoisting but before the require() calls that replace import statements.)
// ---------------------------------------------------------------------------
process.env.JWT_SECRET = 'test-secret';
process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';

// ---------------------------------------------------------------------------
// AWS SDK mock (same boilerplate used across the backend test suite)
// ---------------------------------------------------------------------------
const mockDynamo = () => ({
  put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
  update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  batchWrite: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
});
const mockS3 = () => ({
  upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  putObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  deleteObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  getSignedUrl: jest.fn().mockReturnValue('https://mock-url'),
  headObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  listObjectsV2: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Contents: [] }) }),
});
const awsMock = {
  config: { update: jest.fn() },
  DynamoDB: { DocumentClient: jest.fn(mockDynamo) },
  S3: jest.fn(mockS3),
  EC2: jest.fn(() => ({ describeInstances: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  SSM: jest.fn(() => ({ sendCommand: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  IAM: jest.fn(() => ({ getInstanceProfile: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }) })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
  SES: jest.fn(() => ({})),
};
jest.mock('aws-sdk', () => ({ __esModule: true, default: awsMock, ...awsMock }));

// ---------------------------------------------------------------------------
// Dependency mocks
// ---------------------------------------------------------------------------

jest.mock('../../config/integrations', () => ({
  getGoogleDriveConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    redirectUri: 'http://localhost:3001/api/oauth/google-drive/callback',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  }),
}));

const mockCreateAccount = jest.fn().mockResolvedValue({ platform: 'google_drive', account_id: 'test@example.com' });
const mockGetAccountByPlatform = jest.fn().mockResolvedValue(null);
jest.mock('../../services/connectedAccountsDb', () => ({
  createAccount: (...args: any[]) => mockCreateAccount(...args),
  getAccountByPlatform: (...args: any[]) => mockGetAccountByPlatform(...args),
}));

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: (...args: any[]) => mockAxiosGet(...args),
}));

// Auth middleware: checks for Authorization header so we can test 401 paths too.
jest.mock('../../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = { userId: 'user-123' };
    next();
  },
}));

// ---------------------------------------------------------------------------
// Actual imports
// ---------------------------------------------------------------------------
import request from 'supertest';
import express, { Application } from 'express';
import jwt from 'jsonwebtoken';
import router from '../../routes/googleDriveAuth';

// ---------------------------------------------------------------------------
// Test app setup
// ---------------------------------------------------------------------------
const createApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/', router);
  return app;
};

const VALID_TOKEN = 'Bearer dummy-auth-token'; // accepted by our mock middleware
const JWT_SECRET = 'test-secret';

/** Build a valid OAuth state JWT for the given userId. */
const makeState = (userId: string, expiresIn: jwt.SignOptions['expiresIn'] = '15m') =>
  jwt.sign({ userId, nonce: 'test-nonce-abc' }, JWT_SECRET, { expiresIn });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Google Drive OAuth routes', () => {
  let app: Application;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default axios mocks for success cases
    mockAxiosPost.mockResolvedValue({
      data: {
        access_token: 'ya29.access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.file',
      },
    });
    mockAxiosGet.mockResolvedValue({
      data: { email: 'test@example.com', name: 'Test User', picture: 'https://example.com/pic.jpg' },
    });
    mockCreateAccount.mockResolvedValue({ platform: 'google_drive', account_id: 'test@example.com' });
  });

  // =========================================================================
  // GET /init
  // =========================================================================
  describe('GET /init', () => {
    it('returns 401 when no auth token is provided', async () => {
      const res = await request(app).get('/init');
      expect(res.status).toBe(401);
    });

    it('returns { success: true, url } with valid auth token', async () => {
      const res = await request(app)
        .get('/init')
        .set('Authorization', VALID_TOKEN);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.url).toBe('string');
      expect(res.body.url.length).toBeGreaterThan(0);
    });

    it('URL contains client_id=test-client-id', async () => {
      const res = await request(app)
        .get('/init')
        .set('Authorization', VALID_TOKEN);

      expect(res.body.url).toContain('client_id=test-client-id');
    });

    it('URL contains access_type=offline', async () => {
      const res = await request(app)
        .get('/init')
        .set('Authorization', VALID_TOKEN);

      expect(res.body.url).toContain('access_type=offline');
    });

    it('URL contains prompt=consent', async () => {
      const res = await request(app)
        .get('/init')
        .set('Authorization', VALID_TOKEN);

      expect(res.body.url).toContain('prompt=consent');
    });

    it('URL does NOT contain include_granted_scopes', async () => {
      const res = await request(app)
        .get('/init')
        .set('Authorization', VALID_TOKEN);

      expect(res.body.url).not.toContain('include_granted_scopes');
    });
  });

  // =========================================================================
  // GET /callback
  // =========================================================================
  describe('GET /callback', () => {
    it('redirects to frontend with code and state when code is present', async () => {
      const res = await request(app)
        .get('/callback')
        .query({ code: 'auth-code-123', state: 'state-token-xyz' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('code=auth-code-123');
      expect(res.headers.location).toContain('state=state-token-xyz');
      expect(res.headers.location).toContain('http://localhost:5174/oauth/google-drive/callback');
    });

    it('redirects with error=google_drive_access_denied when Google returns an error', async () => {
      const res = await request(app)
        .get('/callback')
        .query({ error: 'access_denied' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('error=google_drive_access_denied');
    });

    it('passes error_description in the details query param when present', async () => {
      const description = 'The user denied access';
      const res = await request(app)
        .get('/callback')
        .query({ error: 'access_denied', error_description: description });

      expect(res.status).toBe(302);
      const location = res.headers.location as string;
      expect(location).toContain('details=');
      // The description is URL-encoded in the redirect
      expect(decodeURIComponent(location)).toContain(description);
    });
  });

  // =========================================================================
  // POST /finalize
  // =========================================================================
  describe('POST /finalize', () => {
    it('returns 400 when code is missing', async () => {
      const state = makeState('user-123');
      const res = await request(app)
        .post('/finalize')
        .set('Authorization', VALID_TOKEN)
        .send({ state });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/code/i);
    });

    it('returns 400 when state is missing', async () => {
      const res = await request(app)
        .post('/finalize')
        .set('Authorization', VALID_TOKEN)
        .send({ code: 'auth-code-123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/state/i);
    });

    it('returns 403 when state is an invalid JWT', async () => {
      const res = await request(app)
        .post('/finalize')
        .set('Authorization', VALID_TOKEN)
        .send({ code: 'auth-code-123', state: 'not-a-valid-jwt' });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/state/i);
    });

    it('returns 403 when state is signed with the wrong secret', async () => {
      const badState = jwt.sign({ userId: 'user-123', nonce: 'abc' }, 'wrong-secret', { expiresIn: '15m' });
      const res = await request(app)
        .post('/finalize')
        .set('Authorization', VALID_TOKEN)
        .send({ code: 'auth-code-123', state: badState });

      expect(res.status).toBe(403);
    });

    it('returns 422 with insufficient_scopes when granted scopes do not include drive', async () => {
      mockAxiosPost.mockResolvedValueOnce({
        data: {
          access_token: 'ya29.token',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'openid email profile', // no drive scope
        },
      });

      const state = makeState('user-123');
      const res = await request(app)
        .post('/finalize')
        .set('Authorization', VALID_TOKEN)
        .send({ code: 'auth-code-123', state });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('insufficient_scopes');
    });

    it('returns success with tokenSessionId and profile when exchange is valid', async () => {
      const state = makeState('user-123');
      const res = await request(app)
        .post('/finalize')
        .set('Authorization', VALID_TOKEN)
        .send({ code: 'auth-code-123', state });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.tokenSessionId).toBe('string');
      expect(res.body.tokenSessionId.length).toBeGreaterThan(0);
      expect(res.body.profile).toMatchObject({
        email: 'test@example.com',
        name: 'Test User',
      });
    });
  });

  // =========================================================================
  // POST /connect
  // =========================================================================
  describe('POST /connect', () => {
    it('returns 400 when tokenSessionId is missing', async () => {
      const res = await request(app)
        .post('/connect')
        .set('Authorization', VALID_TOKEN)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/tokenSessionId/i);
    });

    it('returns 401 when the token session does not exist', async () => {
      const res = await request(app)
        .post('/connect')
        .set('Authorization', VALID_TOKEN)
        .send({ tokenSessionId: 'nonexistent-session-id' });

      // Session not found → 401 (invalid/expired session)
      expect(res.status).toBe(401);
    });

    it('calls createAccount and returns success when tokenSessionId is valid', async () => {
      // Step 1: finalize to get a real tokenSessionId stored in the in-memory map
      const state = makeState('user-123');
      const finalizeRes = await request(app)
        .post('/finalize')
        .set('Authorization', VALID_TOKEN)
        .send({ code: 'auth-code-123', state });

      expect(finalizeRes.status).toBe(200);
      const { tokenSessionId } = finalizeRes.body;

      // Step 2: connect using the tokenSessionId
      const connectRes = await request(app)
        .post('/connect')
        .set('Authorization', VALID_TOKEN)
        .send({ tokenSessionId });

      expect(connectRes.status).toBe(200);
      expect(connectRes.body.success).toBe(true);
      expect(mockCreateAccount).toHaveBeenCalledTimes(1);
      expect(mockCreateAccount).toHaveBeenCalledWith(
        'user-123',
        'google_drive',
        expect.objectContaining({
          account_id: 'test@example.com',
          account_name: 'Test User',
        })
      );
    });
  });
});
