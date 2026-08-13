/**
 * MCP OAuth 2.1 Routes
 *
 * Implements:
 * - GET  /.well-known/oauth-authorization-server  (RFC 8414 metadata)
 * - POST /oauth/register                          (RFC 7591 dynamic client registration)
 * - GET  /oauth/authorize                         (authorization endpoint → consent redirect)
 * - POST /oauth/authorize/decision                (consent callback, creates auth code)
 * - POST /oauth/token                             (token exchange + refresh)
 */

import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { mcpOAuthService } from './oauthService';
import { authenticateToken, getUserFromToken } from '../../middleware/auth';
import { getJwtSecret } from '../../config/jwt';
import {
  classifyMcpClient,
  recordMcpOAuthAuthorized,
  recordMcpOAuthStarted,
  recordMcpOAuthTokenIssued,
} from '../../services/mcpUsageEventsService';

/**
 * Middleware: accept the user's JWT either from the Authorization header
 * (standard API client path) or from a `jwt` field on the request body
 * (browser form POST path — the consent page submits an HTML form so it
 * can follow the cross-origin 302 redirect, and form POSTs can't set
 * custom headers). Copies the body value into req.headers.authorization
 * so the existing authenticateToken middleware Just Works downstream.
 */
function authFromBodyOrHeader(req: Request, res: Response, next: NextFunction) {
  if (!req.headers.authorization && req.body?.jwt) {
    req.headers.authorization = `Bearer ${req.body.jwt}`;
  }
  return authenticateToken(req, res, next);
}

/**
 * Normalize the `approved` field across JSON (boolean) and form POST
 * (string "true"/"false") payloads. Form POSTs coerce everything to
 * strings, so a naive `if (!approved)` would treat the string "false" as
 * truthy.
 */
function isApproved(value: unknown): boolean {
  return value === true || value === 'true';
}

export function setupMcpOAuth(app: express.Express) {
  const computeBindingHash = (value: string): string => {
    return crypto.createHash("sha256").update(value).digest("hex");
  };

  const clientIpFromRequest = (req: Request): string => {
    const forwarded = req.headers["x-forwarded-for"];
    const direct = req.ip || req.socket.remoteAddress || "";
    if (Array.isArray(forwarded)) {
      return forwarded[0]?.split(",")[0]?.trim() || direct;
    }
    if (typeof forwarded === "string") {
      return forwarded.split(",")[0]?.trim() || direct;
    }
    return direct || "";
  };

  // ─── Well-Known Metadata (RFC 8414) ─────────────────────────────────────

  app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
    const baseUrl = getBackendUrl();

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['mcp:tools'],
      service_documentation: `${baseUrl}/docs/agent-api`,
    });
  });

  const protectedResourceMetadata = (_req: Request, res: Response) => {
    const baseUrl = getBackendUrl();

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
      resource_documentation: `${baseUrl}/skill.md`,
    });
  };

  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceMetadata);

  // ─── Dynamic Client Registration (RFC 7591) ────────────────────────────
  // Body parser is applied globally in app.ts (express.json + urlencoded)
  // so we don't need a per-route parser here any more.

  app.post('/oauth/register', async (req: Request, res: Response) => {
    const { redirect_uris, client_name, grant_types, response_types, token_endpoint_auth_method, scope } = req.body;

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'redirect_uris is required and must be a non-empty array' });
    }
    if (!client_name || typeof client_name !== 'string' || client_name.trim() === '') {
      return res.status(400).json({ error: 'client_name is required' });
    }

    try {
      const result = await mcpOAuthService.registerClient({
        redirectUris: redirect_uris,
        clientName: client_name,
        grantTypes: grant_types,
        responseTypes: response_types,
        tokenEndpointAuthMethod: token_endpoint_auth_method,
        scope,
      });

      res.setHeader('Cache-Control', 'no-store');
      return res.status(201).json({
        client_id: result.clientId,
        ...(result.clientSecret && { client_secret: result.clientSecret }),
        client_name: result.clientName,
        redirect_uris: result.redirectUris,
        grant_types: result.grantTypes,
        response_types: result.responseTypes,
        token_endpoint_auth_method: result.tokenEndpointAuthMethod,
        scope: result.scope,
      });
    } catch (error: any) {
      return res.status(400).json({ error: error.message });
    }
  });

  // ─── Authorization Endpoint ─────────────────────────────────────────────

  app.get('/oauth/authorize', async (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
    } = req.query as Record<string, string>;

    // Validate required params
    if (response_type !== 'code') {
      return res.status(400).json({ error: 'response_type must be "code"' });
    }
    if (!client_id) {
      return res.status(400).json({ error: 'client_id is required' });
    }
    if (!code_challenge) {
      return res.status(400).json({ error: 'code_challenge is required (PKCE mandatory)' });
    }
    if (code_challenge_method && code_challenge_method !== 'S256') {
      return res.status(400).json({ error: 'code_challenge_method must be S256' });
    }

    // Validate client
    const client = await mcpOAuthService.getClient(client_id);
    if (!client) {
      return res.status(400).json({ error: 'Unknown client_id' });
    }

    // Validate redirect_uri against registered URIs
    if (redirect_uri && !client.redirectUris.includes(redirect_uri)) {
      return res.status(400).json({ error: 'redirect_uri does not match registered URIs' });
    }

    const actualRedirectUri = redirect_uri || client.redirectUris[0];
    recordMcpOAuthStarted({
      clientId: client_id,
      clientName: client.clientName,
      clientType: classifyMcpClient({ clientName: client.clientName, userAgent: req.get('user-agent'), redirectUri: actualRedirectUri }),
      redirectUri: actualRedirectUri,
      scope: scope || 'mcp:tools',
      userAgent: req.get('user-agent'),
    }).catch((error) => console.error('[MCP-OAuth] Failed to record OAuth start:', error));

    // Local-dev auto-approve: skip the consent page and issue a code directly.
    // Gated behind an explicit opt-in flag (NOT NODE_ENV) so a forgotten staging
    // env can never short-circuit consent. Also requires a real authenticated
    // user — we refuse to mint anonymous tokens tied to a fake "dev-user" ID,
    // which previously let any unauthenticated caller obtain mcp:tools tokens.
    if (process.env.MCP_OAUTH_SKIP_CONSENT === 'true') {
      const { user } = await getUserFromToken(req);
      if (user) {
        const { code } = await mcpOAuthService.createAuthorizationCode({
          clientId: client_id,
          userId: user.userId,
          redirectUri: actualRedirectUri,
          scope: scope || 'mcp:tools',
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method || 'S256',
        });

        const redirectUrl = new URL(actualRedirectUri);
        redirectUrl.searchParams.set('code', code);
        if (state) redirectUrl.searchParams.set('state', state);
        return res.redirect(302, redirectUrl.toString());
      }
      // Flag set but no authenticated user → fall through to consent page.
    }

    // Default: redirect to customer portal consent page
    const consentUrl = new URL('/oauth/authorize', process.env.CUSTOMER_FRONTEND_URL || 'https://app.agentweb.pro');
    consentUrl.searchParams.set('client_id', client_id);
    consentUrl.searchParams.set('client_name', client.clientName);
    consentUrl.searchParams.set('redirect_uri', actualRedirectUri);
    consentUrl.searchParams.set('scope', scope || 'mcp:tools');
    if (state) consentUrl.searchParams.set('state', state);
    consentUrl.searchParams.set('code_challenge', code_challenge);
    consentUrl.searchParams.set('code_challenge_method', code_challenge_method || 'S256');
    consentUrl.searchParams.set('source', 'mcp');
    consentUrl.searchParams.set('utm_source', 'mcp');
    consentUrl.searchParams.set('utm_medium', classifyMcpClient({ clientName: client.clientName, userAgent: req.get('user-agent'), redirectUri: actualRedirectUri }));
    consentUrl.searchParams.set('mcp_client_id', client_id);
    // Short-lived, signed proof for the inline signup page. The registration
    // endpoint accepts MCP attribution only with this server-minted intent,
    // so a normal public signup cannot spoof acquisition source.
    const signupIntentId = crypto.randomBytes(24).toString('hex');
    const signupIntentBinding = crypto.randomBytes(24).toString('hex');
    const intentContext = {
      userAgentHash: computeBindingHash(req.get('user-agent') || ''),
      ipHash: computeBindingHash(clientIpFromRequest(req)),
    };
    try {
      await mcpOAuthService.createSignupIntent(
        signupIntentId,
        client_id,
        intentContext.userAgentHash,
        intentContext.ipHash,
        computeBindingHash(signupIntentBinding),
      );
    } catch (error) {
      console.error('[MCP-OAuth] Failed to store signup intent:', error);
      return res.status(503).json({ error: 'Unable to initialize MCP signup flow' });
    }

    const signupIntent = jwt.sign(
      {
        purpose: 'mcp_signup',
        clientId: client_id,
        intentId: signupIntentId,
        intentBinding: signupIntentBinding,
      },
      getJwtSecret(),
      { expiresIn: '15m' },
    );
    consentUrl.searchParams.set('mcp_signup_intent', signupIntent);

    return res.redirect(302, consentUrl.toString());
  });

  // ─── Consent Decision (from frontend consent page) ─────────────────────
  // Accepts BOTH application/json (API clients) and
  // application/x-www-form-urlencoded (browser form POST from the consent
  // page). Body parsing is applied globally in app.ts. JWT can come from
  // the Authorization header OR from a `jwt` field on the form body.

  app.post('/oauth/authorize/decision', authFromBodyOrHeader, async (req: Request, res: Response) => {
    const {
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
      approved,
    } = req.body;

    if (!isApproved(approved)) {
      const errorUrl = new URL(redirect_uri);
      errorUrl.searchParams.set('error', 'access_denied');
      if (state) errorUrl.searchParams.set('state', state);
      return res.redirect(302, errorUrl.toString());
    }

    // Validate client and redirect_uri
    const client = await mcpOAuthService.getClient(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      return res.status(400).json({ error: 'Invalid client_id or redirect_uri' });
    }

    const userId = (req as any).user.userId;
    const { code } = await mcpOAuthService.createAuthorizationCode({
      clientId: client_id,
      userId,
      redirectUri: redirect_uri,
      scope: scope || 'mcp:tools',
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256',
    });
    recordMcpOAuthAuthorized({
      userId,
      clientId: client_id,
      clientName: client.clientName,
      clientType: classifyMcpClient({ clientName: client.clientName, redirectUri: redirect_uri }),
      redirectUri: redirect_uri,
      scope: scope || 'mcp:tools',
    }).catch((error) => console.error('[MCP-OAuth] Failed to record OAuth authorization:', error));

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    return res.redirect(302, redirectUrl.toString());
  });

  // ─── Token Endpoint ─────────────────────────────────────────────────────

  app.post('/oauth/token', async (req: Request, res: Response) => {
    const { grant_type } = req.body;

    res.setHeader('Cache-Control', 'no-store');

    if (grant_type === 'authorization_code') {
      return handleAuthorizationCodeGrant(req, res);
    } else if (grant_type === 'refresh_token') {
      return handleRefreshTokenGrant(req, res);
    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
  });

  console.log('[MCP-OAuth] Routes initialized');
}

// ─── Grant Handlers ───────────────────────────────────────────────────────────

async function handleAuthorizationCodeGrant(req: Request, res: Response) {
  const { code, redirect_uri, client_id, code_verifier } = req.body;

  // Consume the authorization code (single-use)
  const codeRecord = await mcpOAuthService.consumeAuthorizationCode(code);
  if (!codeRecord) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
  }

  // Validate client_id matches
  const effectiveClientId = client_id || extractClientIdFromAuth(req);
  if (effectiveClientId && codeRecord.clientId !== effectiveClientId) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
  }

  // Validate redirect_uri matches
  if (redirect_uri && codeRecord.redirectUri !== redirect_uri) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
  }

  // Validate client auth if confidential
  const client = await mcpOAuthService.getClient(codeRecord.clientId);
  if (client && client.clientSecretHash) {
    const secret = extractClientSecret(req);
    if (!secret || !mcpOAuthService.validateClientSecret(secret, client.clientSecretHash)) {
      return res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed' });
    }
  }

  // Validate PKCE
  if (!code_verifier) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier is required' });
  }

  const pkceValid = mcpOAuthService.validatePkce(
    code_verifier,
    codeRecord.codeChallenge,
    codeRecord.codeChallengeMethod
  );
  if (!pkceValid) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
  }

  // Issue tokens
  const tokens = await mcpOAuthService.createTokenPair({
    clientId: codeRecord.clientId,
    userId: codeRecord.userId,
    scope: codeRecord.scope,
  });
  recordMcpOAuthTokenIssued({
    userId: codeRecord.userId,
    clientId: codeRecord.clientId,
    clientName: client?.clientName,
    clientType: classifyMcpClient({ clientName: client?.clientName, redirectUri: codeRecord.redirectUri }),
    redirectUri: codeRecord.redirectUri,
    scope: codeRecord.scope,
  }).catch((error) => console.error('[MCP-OAuth] Failed to record OAuth token issue:', error));

  return res.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    scope: tokens.scope,
  });
}

async function handleRefreshTokenGrant(req: Request, res: Response) {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token is required' });
  }

  const tokens = await mcpOAuthService.refreshTokens(refresh_token);
  if (!tokens) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
  }

  return res.json({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: tokens.tokenType,
    expires_in: tokens.expiresIn,
    scope: tokens.scope,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractClientIdFromAuth(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const [clientId] = decoded.split(':');
    return clientId;
  }
  return undefined;
}

function extractClientSecret(req: Request): string | undefined {
  // client_secret_basic (Authorization header)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const parts = decoded.split(':');
    return parts[1];
  }
  // client_secret_post (body)
  return req.body.client_secret;
}

function getBackendUrl(): string {
  return process.env.BACKEND_URL || 'https://api.agentweb.pro';
}
