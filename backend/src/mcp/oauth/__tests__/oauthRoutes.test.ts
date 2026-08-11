/**
 * TDD tests for MCP OAuth 2.1 routes.
 *
 * Covers: well-known metadata, client registration, authorize redirect,
 * token exchange, and refresh flow.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockRegisterClient = jest.fn();
const mockGetClient = jest.fn();
const mockCreateAuthorizationCode = jest.fn();
const mockConsumeAuthorizationCode = jest.fn();
const mockCreateTokenPair = jest.fn();
const mockValidateAccessToken = jest.fn();
const mockRefreshTokens = jest.fn();
const mockValidatePkce = jest.fn();
const mockValidateClientSecret = jest.fn();
const mockRecordMcpOAuthStarted = jest.fn();
const mockRecordMcpOAuthAuthorized = jest.fn();
const mockRecordMcpOAuthTokenIssued = jest.fn();

jest.mock('../oauthService', () => ({
  mcpOAuthService: {
    registerClient: (...args: any[]) => mockRegisterClient(...args),
    getClient: (...args: any[]) => mockGetClient(...args),
    createAuthorizationCode: (...args: any[]) => mockCreateAuthorizationCode(...args),
    consumeAuthorizationCode: (...args: any[]) => mockConsumeAuthorizationCode(...args),
    createTokenPair: (...args: any[]) => mockCreateTokenPair(...args),
    validateAccessToken: (...args: any[]) => mockValidateAccessToken(...args),
    refreshTokens: (...args: any[]) => mockRefreshTokens(...args),
    validatePkce: (...args: any[]) => mockValidatePkce(...args),
    validateClientSecret: (...args: any[]) => mockValidateClientSecret(...args),
  },
}));

jest.mock('../../../services/mcpUsageEventsService', () => ({
  classifyMcpClient: jest.fn(({ clientName, userAgent }: any) => {
    const haystack = `${clientName || ''} ${userAgent || ''}`.toLowerCase();
    if (haystack.includes('codex')) return 'codex';
    if (haystack.includes('claude')) return 'claude_code';
    return 'unknown';
  }),
  recordMcpOAuthStarted: (...args: any[]) => mockRecordMcpOAuthStarted(...args),
  recordMcpOAuthAuthorized: (...args: any[]) => mockRecordMcpOAuthAuthorized(...args),
  recordMcpOAuthTokenIssued: (...args: any[]) => mockRecordMcpOAuthTokenIssued(...args),
}));

// Mock authenticateToken middleware — simulates logged-in user
const mockGetUserFromToken = jest.fn();
jest.mock('../../../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user-456', email: 'test@example.com', isAdmin: false };
    next();
  },
  getUserFromToken: (...args: any[]) => mockGetUserFromToken(...args),
}));

// Mock aws-sdk to prevent real AWS calls
jest.mock('aws-sdk', () => ({
  __esModule: true,
  default: {
    config: { update: jest.fn() },
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
        query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
        update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      })),
    },
  },
}));

import express from 'express';
import request from 'supertest';
import { setupMcpOAuth } from '../oauthRoutes';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  setupMcpOAuth(app);
  return app;
}

describe('MCP OAuth Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordMcpOAuthStarted.mockResolvedValue(true);
    mockRecordMcpOAuthAuthorized.mockResolvedValue(true);
    mockRecordMcpOAuthTokenIssued.mockResolvedValue(true);
    mockGetUserFromToken.mockResolvedValue({ user: null });
    process.env.BACKEND_URL = 'https://api.agentweb.pro';
    process.env.CUSTOMER_FRONTEND_URL = 'https://app.agentweb.pro';
    delete process.env.MCP_OAUTH_SKIP_CONSENT;
    app = createTestApp();
  });

  afterEach(() => {
    delete process.env.BACKEND_URL;
    delete process.env.CUSTOMER_FRONTEND_URL;
    delete process.env.MCP_OAUTH_SKIP_CONSENT;
  });

  // ─── Well-Known Metadata ────────────────────────────────────────────────

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('should return RFC 8414 metadata with correct URLs', async () => {
      const res = await request(app)
        .get('/.well-known/oauth-authorization-server')
        .expect(200);

      expect(res.body.issuer).toBe('https://api.agentweb.pro');
      expect(res.body.authorization_endpoint).toBe('https://api.agentweb.pro/oauth/authorize');
      expect(res.body.token_endpoint).toBe('https://api.agentweb.pro/oauth/token');
      expect(res.body.registration_endpoint).toBe('https://api.agentweb.pro/oauth/register');
      expect(res.body.response_types_supported).toEqual(['code']);
      expect(res.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
      expect(res.body.scopes_supported).toEqual(['mcp:tools']);
      expect(res.headers['cache-control']).toBe('public, max-age=3600');
    });

    it('should build URLs dynamically from BACKEND_URL', async () => {
      process.env.BACKEND_URL = 'https://custom.api.example.com';
      const customApp = createTestApp();

      const res = await request(customApp)
        .get('/.well-known/oauth-authorization-server')
        .expect(200);

      expect(res.body.issuer).toBe('https://custom.api.example.com');
      expect(res.body.authorization_endpoint).toBe('https://custom.api.example.com/oauth/authorize');
    });
  });

  describe('GET /.well-known/oauth-protected-resource', () => {
    it.each([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ])('should return MCP protected resource metadata from %s', async (path) => {
      const res = await request(app)
        .get(path)
        .expect(200);

      expect(res.body).toEqual({
        resource: 'https://api.agentweb.pro/mcp',
        authorization_servers: ['https://api.agentweb.pro'],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:tools'],
        resource_documentation: 'https://api.agentweb.pro/skill.md',
      });
      expect(res.headers['cache-control']).toBe('public, max-age=3600');
    });
  });

  // ─── Client Registration ────────────────────────────────────────────────

  describe('POST /oauth/register', () => {
    it('should register a client and return 201', async () => {
      mockRegisterClient.mockResolvedValue({
        clientId: 'new-client-id',
        clientName: 'Test MCP Client',
        redirectUris: ['https://example.com/callback'],
        grantTypes: ['authorization_code', 'refresh_token'],
        responseTypes: ['code'],
        tokenEndpointAuthMethod: 'none',
        scope: 'mcp:tools',
      });

      const res = await request(app)
        .post('/oauth/register')
        .send({
          redirect_uris: ['https://example.com/callback'],
          client_name: 'Test MCP Client',
        })
        .expect(201);

      expect(res.body.client_id).toBe('new-client-id');
      expect(res.body.client_name).toBe('Test MCP Client');
      expect(res.body.redirect_uris).toEqual(['https://example.com/callback']);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('should return 400 when redirect_uris is missing', async () => {
      const res = await request(app)
        .post('/oauth/register')
        .send({ client_name: 'Bad Client' })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when client_name is missing', async () => {
      const res = await request(app)
        .post('/oauth/register')
        .send({ redirect_uris: ['https://example.com/callback'] })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when service throws validation error', async () => {
      mockRegisterClient.mockRejectedValue(new Error('Redirect URIs must use HTTPS'));

      const res = await request(app)
        .post('/oauth/register')
        .send({
          redirect_uris: ['http://insecure.com/callback'],
          client_name: 'Insecure Client',
        })
        .expect(400);

      expect(res.body.error).toContain('HTTPS');
    });
  });

  // ─── Authorization Endpoint ─────────────────────────────────────────────

  describe('GET /oauth/authorize', () => {
    it('should redirect to consent page with correct params', async () => {
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        clientName: 'Test Client',
        redirectUris: ['https://example.com/callback'],
        tokenEndpointAuthMethod: 'none',
      });

      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          scope: 'mcp:tools',
          state: 'random-state',
          code_challenge: 'test-challenge',
          code_challenge_method: 'S256',
        })
        .expect(302);

      const location = res.headers.location;
      expect(location).toContain('https://app.agentweb.pro/oauth/authorize');
      expect(location).toContain('client_id=client-123');
      expect(location).toContain('state=random-state');
      expect(location).toContain('utm_source=mcp');
      expect(location).toContain('utm_medium=unknown');
      expect(location).toContain('mcp_client_id=client-123');
      expect(location).toContain('mcp_signup_intent=');
      expect(mockRecordMcpOAuthStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'client-123',
          clientName: 'Test Client',
          clientType: 'unknown',
          redirectUri: 'https://example.com/callback',
          scope: 'mcp:tools',
        })
      );
    });

    it('should return 400 when client_id is missing', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          redirect_uri: 'https://example.com/callback',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        })
        .expect(400);

      expect(res.body.error).toBeDefined();
    });

    it('should return 400 when client not found', async () => {
      mockGetClient.mockResolvedValue(null);

      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'nonexistent',
          redirect_uri: 'https://example.com/callback',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        })
        .expect(400);

      expect(res.body.error).toContain('client');
    });

    it('should return 400 when redirect_uri does not match registered URIs', async () => {
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        redirectUris: ['https://registered.com/callback'],
      });

      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'client-123',
          redirect_uri: 'https://evil.com/callback',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        })
        .expect(400);

      expect(res.body.error).toContain('redirect_uri');
    });

    it('should return 400 when PKCE code_challenge is missing', async () => {
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        redirectUris: ['https://example.com/callback'],
      });

      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
        })
        .expect(400);

      expect(res.body.error).toContain('code_challenge');
    });

    // These three tests lock in the fix for the consent bypass: the dev
    // auto-approve path must never short-circuit consent unless BOTH the
    // explicit env flag is set AND a real authenticated user is resolved.
    // Previously NODE_ENV=development alone was enough, which fired on
    // staging and minted anonymous "dev-user" tokens.
    it('should redirect to consent page when MCP_OAUTH_SKIP_CONSENT is unset, even with a valid JWT', async () => {
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        clientName: 'Test Client',
        redirectUris: ['https://example.com/callback'],
      });
      mockGetUserFromToken.mockResolvedValue({
        user: { userId: 'real-user-1', email: 'u@example.com', isAdmin: false },
      });

      const res = await request(app)
        .get('/oauth/authorize')
        .set('Authorization', 'Bearer valid-jwt')
        .query({
          response_type: 'code',
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          scope: 'mcp:tools',
          state: 'xyz',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        })
        .expect(302);

      expect(res.headers.location).toContain('https://app.agentweb.pro/oauth/authorize');
      expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
    });

    it('should redirect to consent page (NOT issue a code) when skip-consent flag is set but request is unauthenticated', async () => {
      process.env.MCP_OAUTH_SKIP_CONSENT = 'true';
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        clientName: 'Test Client',
        redirectUris: ['https://example.com/callback'],
      });
      mockGetUserFromToken.mockResolvedValue({ user: null });

      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          response_type: 'code',
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          scope: 'mcp:tools',
          state: 'xyz',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        })
        .expect(302);

      expect(res.headers.location).toContain('https://app.agentweb.pro/oauth/authorize');
      expect(mockCreateAuthorizationCode).not.toHaveBeenCalled();
    });

    it('should auto-approve with the real userId when skip-consent flag is set AND the caller is authenticated', async () => {
      process.env.MCP_OAUTH_SKIP_CONSENT = 'true';
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        clientName: 'Test Client',
        redirectUris: ['https://example.com/callback'],
      });
      mockGetUserFromToken.mockResolvedValue({
        user: { userId: 'real-user-42', email: 'u@example.com', isAdmin: false },
      });
      mockCreateAuthorizationCode.mockResolvedValue({ code: 'generated-code' });

      const res = await request(app)
        .get('/oauth/authorize')
        .set('Authorization', 'Bearer valid-jwt')
        .query({
          response_type: 'code',
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          scope: 'mcp:tools',
          state: 'xyz',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
        })
        .expect(302);

      expect(res.headers.location).toBe(
        'https://example.com/callback?code=generated-code&state=xyz'
      );
      expect(mockCreateAuthorizationCode).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'real-user-42' })
      );
      // Regression guard: never pass the literal "dev-user" fallback.
      expect(mockCreateAuthorizationCode).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'dev-user' })
      );
    });
  });

  // ─── Consent Decision ───────────────────────────────────────────────────

  describe('POST /oauth/authorize/decision', () => {
    it('should redirect with code on approval', async () => {
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        redirectUris: ['https://example.com/callback'],
      });
      mockCreateAuthorizationCode.mockResolvedValue({ code: 'auth-code-123' });

      const res = await request(app)
        .post('/oauth/authorize/decision')
        .send({
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          scope: 'mcp:tools',
          state: 'random-state',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          approved: true,
        })
        .expect(302);

      const location = res.headers.location;
      expect(location).toContain('https://example.com/callback');
      expect(location).toContain('code=auth-code-123');
      expect(location).toContain('state=random-state');
      expect(mockRecordMcpOAuthAuthorized).toHaveBeenCalledWith({
        userId: 'user-456',
        clientId: 'client-123',
        clientName: undefined,
        clientType: 'unknown',
        redirectUri: 'https://example.com/callback',
        scope: 'mcp:tools',
      });
    });

    it('should redirect with error=access_denied on denial', async () => {
      const res = await request(app)
        .post('/oauth/authorize/decision')
        .send({
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          state: 'random-state',
          approved: false,
        })
        .expect(302);

      const location = res.headers.location;
      expect(location).toContain('error=access_denied');
      expect(location).toContain('state=random-state');
    });

    // Form POST path: the consent page submits an HTML <form> so the
    // browser can natively follow the cross-origin 302 (fetch can't).
    // Form POSTs coerce everything to strings and can't set custom
    // headers, so we have to accept `approved` as a string and read the
    // JWT from a body field.

    it('should accept form-urlencoded body with approved=true (browser form POST path)', async () => {
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        redirectUris: ['https://example.com/callback'],
      });
      mockCreateAuthorizationCode.mockResolvedValue({ code: 'auth-code-form' });

      const res = await request(app)
        .post('/oauth/authorize/decision')
        .type('form')
        .send({
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          scope: 'mcp:tools',
          state: 'form-state',
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          approved: 'true', // string, not boolean — form encoding
          jwt: 'dummy-jwt-value', // authenticateToken mock ignores it, but the middleware should still copy it to the auth header
        })
        .expect(302);

      const location = res.headers.location;
      expect(location).toContain('https://example.com/callback');
      expect(location).toContain('code=auth-code-form');
      expect(location).toContain('state=form-state');
    });

    it('should reject form-urlencoded body with approved="false" (string, not boolean)', async () => {
      // Regression guard: a naive `if (!approved)` would treat the
      // string "false" as truthy and mistakenly approve the request.
      const res = await request(app)
        .post('/oauth/authorize/decision')
        .type('form')
        .send({
          client_id: 'client-123',
          redirect_uri: 'https://example.com/callback',
          state: 'deny-state',
          approved: 'false',
          jwt: 'dummy-jwt-value',
        })
        .expect(302);

      const location = res.headers.location;
      expect(location).toContain('error=access_denied');
      expect(location).toContain('state=deny-state');
    });
  });

  // ─── Token Exchange ─────────────────────────────────────────────────────

  describe('POST /oauth/token', () => {
    it('should exchange authorization code for tokens', async () => {
      mockConsumeAuthorizationCode.mockResolvedValue({
        code: 'valid-code',
        clientId: 'client-123',
        userId: 'user-456',
        redirectUri: 'https://example.com/callback',
        scope: 'mcp:tools',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      });
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        tokenEndpointAuthMethod: 'none',
      });
      mockValidatePkce.mockReturnValue(true);
      mockCreateTokenPair.mockResolvedValue({
        accessToken: 'access-token-123',
        refreshToken: 'refresh-token-123',
        tokenType: 'Bearer',
        expiresIn: 3600,
        scope: 'mcp:tools',
      });

      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: 'valid-code',
          redirect_uri: 'https://example.com/callback',
          client_id: 'client-123',
          code_verifier: 'test-verifier',
        })
        .expect(200);

      expect(res.body.access_token).toBe('access-token-123');
      expect(res.body.refresh_token).toBe('refresh-token-123');
      expect(res.body.token_type).toBe('Bearer');
      expect(mockRecordMcpOAuthTokenIssued).toHaveBeenCalledWith({
        userId: 'user-456',
        clientId: 'client-123',
        clientName: undefined,
        clientType: 'unknown',
        redirectUri: 'https://example.com/callback',
        scope: 'mcp:tools',
      });
      expect(res.body.expires_in).toBe(3600);
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('should return 400 for invalid authorization code', async () => {
      mockConsumeAuthorizationCode.mockResolvedValue(null);

      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: 'bad-code',
          redirect_uri: 'https://example.com/callback',
          client_id: 'client-123',
          code_verifier: 'verifier',
        })
        .expect(400);

      expect(res.body.error).toBe('invalid_grant');
    });

    it('should return 400 when PKCE verification fails', async () => {
      mockConsumeAuthorizationCode.mockResolvedValue({
        code: 'valid-code',
        clientId: 'client-123',
        userId: 'user-456',
        redirectUri: 'https://example.com/callback',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      });
      mockGetClient.mockResolvedValue({
        clientId: 'client-123',
        tokenEndpointAuthMethod: 'none',
      });
      mockValidatePkce.mockReturnValue(false);

      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          code: 'valid-code',
          redirect_uri: 'https://example.com/callback',
          client_id: 'client-123',
          code_verifier: 'wrong-verifier',
        })
        .expect(400);

      expect(res.body.error).toBe('invalid_grant');
    });

    it('should refresh tokens with valid refresh_token grant', async () => {
      mockRefreshTokens.mockResolvedValue({
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        tokenType: 'Bearer',
        expiresIn: 3600,
        scope: 'mcp:tools',
      });

      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          refresh_token: 'old-refresh-token',
        })
        .expect(200);

      expect(res.body.access_token).toBe('new-access');
      expect(res.body.refresh_token).toBe('new-refresh');
    });

    it('should return 400 for invalid refresh token', async () => {
      mockRefreshTokens.mockResolvedValue(null);

      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          refresh_token: 'bad-refresh',
        })
        .expect(400);

      expect(res.body.error).toBe('invalid_grant');
    });

    it('should return 400 for unsupported grant_type', async () => {
      const res = await request(app)
        .post('/oauth/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
        })
        .expect(400);

      expect(res.body.error).toBe('unsupported_grant_type');
    });
  });
});
