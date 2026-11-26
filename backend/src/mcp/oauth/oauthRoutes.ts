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
import { mcpOAuthService } from './oauthService';
import { authenticateToken, getUserFromToken } from '../../middleware/auth';
import {
  classifyMcpClient,
  recordMcpOAuthAuthorized,
  recordMcpOAuthStarted,
  recordMcpOAuthTokenIssued,
} from '../../services/mcpUsageEventsService';
import { getBackendUrl, MCP_RESOURCE_PATH, META_TOOLKIT_MCP_RESOURCE_PATH, withRef } from './authChallenge';
import {
  MCP_CONSENT_SIGNUP_SOURCE,
  normalizeProduct,
  productFromResource,
  readRef,
  validateRef,
  ZOMA_DEVICE_OAUTH_CLIENT_ID,
  type AttributionConfidence,
  type JourneyProduct,
} from '../../services/journeyAttribution';
import { admitZomaAuthorizationSignup } from '../../services/zomaAuthorizationAdmission';
import { isDatabricksRedirectUri } from '../zomaDatabricksReadOnly';
import { waitlistedResponse } from '../../services/zomaAdmission';
import { mintZomaSignupIntent } from '../../services/zomaSignupIntent';
import { trackJourney } from '../../services/journeyTracking';
import { noteProductUse, noteSignup, zomaMilestone } from '../../services/journeyMilestones';

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

// Express query/form parsers can produce arrays or objects for repeated/nested
// parameters. Reject those before URL construction, hashing, or database calls.
function hasOnlyStringParams(params: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => params[key] === undefined || typeof params[key] === 'string');
}

const authorizationParams = ['client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method'];

/**
 * ENG-2906 product attribution for an authorization request. The RFC 8707 `resource` is the
 * explicit signal; the first-party Zoma device client is a reliable endpoint hint. Anything
 * else is `unknown`. Attribution only — it never changes what is authorized.
 */
function authorizationAttribution(clientId: string, resource: unknown): { product: JourneyProduct; confidence: AttributionConfidence } {
  const fromResource = productFromResource(resource);
  if (fromResource.product !== 'unknown') return fromResource;
  if (clientId === ZOMA_DEVICE_OAUTH_CLIENT_ID) return { product: 'zoma', confidence: 'inferred' };
  return fromResource;
}

/**
 * ENG-2906: write-once signup attribution for an account created on the MCP consent page. The
 * register endpoint stamps such rows signupSource "mcp"; any other account (an existing user
 * approving a new client, however recently created) is never treated as a signup here.
 */
function attributeConsentSignup(
  userId: string,
  clientId: string,
  clientType: string,
  attribution: { product: JourneyProduct; confidence: AttributionConfidence },
  ref: string | undefined,
) {
  const zomaDevice = clientId === ZOMA_DEVICE_OAUTH_CLIENT_ID;
  void noteSignup(
    userId,
    {
      product: attribution.product,
      path: zomaDevice ? 'zoma_device' : 'oauth_direct',
      client: zomaDevice ? 'zoma_device' : clientType,
      ref,
      confidence: attribution.confidence,
    },
    { requireSignupSource: MCP_CONSENT_SIGNUP_SOURCE },
  );
}

async function allowZomaSignupAuthorization(product: JourneyProduct, userId: string, res: Response, redirectUri?: string): Promise<boolean> {
  if (product !== 'zoma') return true;
  try {
    const databricksClient = !!redirectUri && isDatabricksRedirectUri(redirectUri);
    if (await admitZomaAuthorizationSignup(userId, { databricksClient }) === 'approved') return true;
    res.status(202).json(waitlistedResponse);
  } catch (error) {
    console.error('[MCP-OAuth] Zoma admission unavailable:', error);
    res.status(503).json({ code: 'admission_unavailable', message: 'Please try again later.' });
  }
  return false;
}

export function setupMcpOAuth(app: express.Express) {
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

  // RFC 9728: one metadata document per protected resource; `resource` must equal the URL
  // the client connected to or MCP clients refuse to start the OAuth flow.
  // ENG-2906: a valid `ref` on this document's URL (from the 401 challenge, or the SDK's
  // path-aware discovery, which keeps the server URL's query) is echoed into `resource`. MCP
  // clients send the metadata's `resource` — not their own server URL — to /oauth/authorize, so
  // this is the only way `?ref=` on the MCP URL reaches the authorization request.
  const protectedResourceMetadata = (resourcePath: string) => (req: Request, res: Response) => {
    const baseUrl = getBackendUrl();

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({
      resource: withRef(`${baseUrl}${resourcePath}`, validateRef(req.query.ref)),
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp:tools'],
      resource_documentation:
        resourcePath === META_TOOLKIT_MCP_RESOURCE_PATH ? `${baseUrl}/api/meta-toolkit/skill.md` : `${baseUrl}/skill.md`,
    });
  };

  app.get('/.well-known/oauth-protected-resource', protectedResourceMetadata(MCP_RESOURCE_PATH));
  app.get(`/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`, protectedResourceMetadata(MCP_RESOURCE_PATH));
  app.get(
    `/.well-known/oauth-protected-resource${META_TOOLKIT_MCP_RESOURCE_PATH}`,
    protectedResourceMetadata(META_TOOLKIT_MCP_RESOURCE_PATH),
  );

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
    if (!hasOnlyStringParams(req.query, ['response_type', ...authorizationParams])) {
      return res.status(400).json({ error: 'invalid_request' });
    }
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
    // ENG-2906: the portal consent page posts back only the standard fields, so remember the
    // product/ref keyed by client + PKCE challenge for the decision. Invalid ref is dropped.
    const resource = typeof req.query.resource === 'string' ? req.query.resource : undefined;
    const attribution = authorizationAttribution(client_id, resource);
    const ref = validateRef(req.query.ref) ?? readRef(resource);
    if (attribution.product !== 'unknown' || ref) {
      try {
        await mcpOAuthService.savePendingAuthorization(client_id, code_challenge, { ...attribution, ...(ref ? { ref } : {}) });
      } catch (error) {
        console.error('[MCP-OAuth] Failed to remember authorization attribution (ignored):', error);
      }
    }
    recordMcpOAuthStarted({
      product: attribution.product,
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
        if (!await allowZomaSignupAuthorization(attribution.product, user.userId, res, actualRedirectUri)) return;
        const clientType = classifyMcpClient({ clientName: client.clientName, userAgent: req.get('user-agent'), redirectUri: actualRedirectUri });
        const { code } = await mcpOAuthService.createAuthorizationCode({
          clientId: client_id,
          userId: user.userId,
          redirectUri: actualRedirectUri,
          scope: scope || 'mcp:tools',
          codeChallenge: code_challenge,
          codeChallengeMethod: code_challenge_method || 'S256',
          product: attribution.product,
          attributionConfidence: attribution.confidence,
          ...(ref ? { ref } : {}),
        });
        attributeConsentSignup(user.userId, client_id, clientType, attribution, ref);

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
    // The deployed consent page forwards this signed intent to /api/auth/register.
    // Never infer Zoma from the generic signupSource=mcp marker (Emma shares it).
    if (attribution.product === 'zoma') consentUrl.searchParams.set('mcp_signup_intent', mintZomaSignupIntent());

    return res.redirect(302, consentUrl.toString());
  });

  // ─── Consent Decision (from frontend consent page) ─────────────────────
  // Accepts BOTH application/json (API clients) and
  // application/x-www-form-urlencoded (browser form POST from the consent
  // page). Body parsing is applied globally in app.ts. JWT can come from
  // the Authorization header OR from a `jwt` field on the form body.

  app.post('/oauth/authorize/decision', authFromBodyOrHeader, async (req: Request, res: Response) => {
    if (!hasOnlyStringParams(req.body, authorizationParams)) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const {
      client_id,
      redirect_uri,
      scope,
      state,
      code_challenge,
      code_challenge_method,
      approved,
    } = req.body;

    // Validate on denial too: an authenticated form must not be an open redirect.
    if (!client_id || !redirect_uri) {
      return res.status(400).json({ error: 'Invalid client_id or redirect_uri' });
    }
    const client = await mcpOAuthService.getClient(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      return res.status(400).json({ error: 'Invalid client_id or redirect_uri' });
    }

    if (!isApproved(approved)) {
      const errorUrl = new URL(redirect_uri);
      errorUrl.searchParams.set('error', 'access_denied');
      if (state) errorUrl.searchParams.set('state', state);
      return res.redirect(302, errorUrl.toString());
    }

    if (!code_challenge || (code_challenge_method && code_challenge_method !== 'S256')) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const userId = (req as any).user.userId;
    let pending: Awaited<ReturnType<typeof mcpOAuthService.takePendingAuthorization>> = null;
    try {
      pending = await mcpOAuthService.takePendingAuthorization(client_id, code_challenge, true);
    } catch (error) {
      console.error('[MCP-OAuth] Failed to read authorization attribution (ignored):', error);
    }
    const attribution = pending ?? authorizationAttribution(client_id, undefined);
    if (!await allowZomaSignupAuthorization(attribution.product, userId, res, redirect_uri)) return;
    const { code } = await mcpOAuthService.createAuthorizationCode({
      clientId: client_id,
      userId,
      redirectUri: redirect_uri,
      scope: scope || 'mcp:tools',
      codeChallenge: code_challenge,
      codeChallengeMethod: code_challenge_method || 'S256',
      product: attribution.product,
      attributionConfidence: attribution.confidence,
      ...(pending?.ref ? { ref: pending.ref } : {}),
    });
    // ENG-2906: an account created on this consent page gets its write-once signup attribution
    // here, where the client and product are finally known.
    const clientType = classifyMcpClient({ clientName: client.clientName, redirectUri: redirect_uri });
    attributeConsentSignup(userId, client_id, clientType, attribution, pending?.ref);
    recordMcpOAuthAuthorized({
      product: attribution.product,
      userId,
      clientId: client_id,
      clientName: client.clientName,
      clientType,
      redirectUri: redirect_uri,
      scope: scope || 'mcp:tools',
    }).catch((error) => console.error('[MCP-OAuth] Failed to record OAuth authorization:', error));

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);
    return res.redirect(302, redirectUrl.toString());
  });

  // ─── Token Endpoint ─────────────────────────────────────────────────────

  app.post('/oauth/token', async (req: Request, res: Response, next: NextFunction) => {
    const { grant_type } = req.body;

    res.setHeader('Cache-Control', 'no-store');

    if (!hasOnlyStringParams(req.body, ['grant_type', 'code', 'redirect_uri', 'client_id', 'client_secret', 'code_verifier', 'refresh_token'])) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    if (grant_type === 'authorization_code') {
      return handleAuthorizationCodeGrant(req, res).catch(next);
    } else if (grant_type === 'refresh_token') {
      return handleRefreshTokenGrant(req, res).catch(next);
    } else {
      return res.status(400).json({ error: 'unsupported_grant_type' });
    }
  });

  console.log('[MCP-OAuth] Routes initialized');
}

// ─── Grant Handlers ───────────────────────────────────────────────────────────

async function handleAuthorizationCodeGrant(req: Request, res: Response) {
  const { code, redirect_uri, client_id, code_verifier } = req.body;

  const effectiveClientId = client_id || extractClientIdFromAuth(req);
  if (!code || !effectiveClientId) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const client = await authenticateOAuthClient(req, res, effectiveClientId);
  if (!client) return;
  // Validate PKCE before the conditional write; the write rechecks the challenge,
  // bindings, expiry and unused state so validation cannot open a redemption race.
  const codeRecord = await mcpOAuthService.consumeAuthorizationCode(code, effectiveClientId, redirect_uri, code_verifier);
  if (!codeRecord) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
  }

  // ENG-2906: product from the code; a legacy/unknown code may still name its resource here
  // (RFC 8707 resource is also sent to the token endpoint).
  let product = normalizeProduct(codeRecord.product);
  if (product === 'unknown') product = productFromResource(req.body.resource).product;

  // Issue tokens
  const tokens = await mcpOAuthService.createTokenPair({
    clientId: codeRecord.clientId,
    userId: codeRecord.userId,
    scope: codeRecord.scope,
    product,
  });
  const clientType = classifyMcpClient({ clientName: client?.clientName, redirectUri: codeRecord.redirectUri });
  void (async () => {
    await noteProductUse(codeRecord.userId, product);
    if (product === 'zoma') {
      await zomaMilestone(codeRecord.userId, 'connected', { emit: 'always', props: { product, clientType, path: 'oauth' } });
    } else {
      await trackJourney({ userId: codeRecord.userId }, 'connected', { product, clientType, path: 'oauth' });
    }
  })();
  recordMcpOAuthTokenIssued({
    product,
    userId: codeRecord.userId,
    clientId: codeRecord.clientId,
    clientName: client?.clientName,
    clientType,
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

  const clientId = req.body.client_id || extractClientIdFromAuth(req);
  if (!clientId) return res.status(400).json({ error: 'invalid_request' });
  if (!await authenticateOAuthClient(req, res, clientId)) return;
  const tokens = await mcpOAuthService.refreshTokens(refresh_token, clientId);
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

async function authenticateOAuthClient(req: Request, res: Response, clientId: string) {
  const basicId = extractClientIdFromAuth(req);
  if (basicId && basicId !== clientId) {
    res.status(401).json({ error: 'invalid_client' });
    return null;
  }
  const client = await mcpOAuthService.getClient(clientId);
  if (!client) {
    res.status(401).json({ error: 'invalid_client' });
    return null;
  }
  const method = client.tokenEndpointAuthMethod;
  if (method !== 'none') {
    const hasBasicAuth = req.headers.authorization?.startsWith('Basic ') === true;
    if ((method === 'client_secret_basic' && (!hasBasicAuth || basicId !== clientId)) ||
        (method === 'client_secret_post' && hasBasicAuth) ||
        !['client_secret_basic', 'client_secret_post'].includes(method)) {
      res.status(401).json({ error: 'invalid_client' });
      return null;
    }
    const secret = extractClientSecret(req);
    if (!secret || !client.clientSecretHash || !mcpOAuthService.validateClientSecret(secret, client.clientSecretHash)) {
      res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed' });
      return null;
    }
  }
  return client;
}

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

