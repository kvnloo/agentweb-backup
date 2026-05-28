# Google Ads Integration — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Google Ads OAuth account connection, full ad management + reporting service layer, 2 agent tools, and Settings UI platform card.

**Architecture:** OAuth2 flow mirrors the LinkedIn Ads pattern (init → callback → finalize → connect). Service layer calls the Google Ads REST API v18 via `axios` with `Authorization: Bearer`, `developer-token`, and `login-customer-id` headers. Two emma tools expose campaign management and reporting to the AI agent.

**Tech Stack:** Node.js/TypeScript, Express, `axios` (already installed), `google-auth-library` ^9.15.1 (already installed), Google Ads REST API v18 (`https://googleads.googleapis.com/v18`), DynamoDB, React/TypeScript (customer-portal)

---

## File Map

**New backend files:**
- `backend/src/routes/googleAdsAuth.ts` — OAuth: init, callback, finalize, connect, disconnect
- `backend/src/routes/googleAds.ts` — REST: list accounts, list campaigns
- `backend/src/services/googleAdsService.ts` — Google Ads API wrapper (all service methods)
- `backend/src/__tests__/googleAdsAuth.test.ts`
- `backend/src/__tests__/googleAdsService.test.ts`
- `backend/src/__tests__/googleAdsTools.test.ts`
- `backend/src/__tests__/googleAdsRoutes.test.ts`

**New frontend files:**
- `customer-portal/src/pages/GoogleAdsOAuthCallback.tsx` — OAuth popup callback page (calls /finalize, sends postMessage)
- `customer-portal/src/components/settings/GoogleAdsAccountModal.tsx`
- `customer-portal/src/__tests__/settings/GoogleAdsAccountModal.test.tsx`

**Modified files:**
- `backend/src/services/connectedAccountsDb.ts:7` — add `'google_ads'` to `PlatformType`
- `backend/src/utils/secretsManager.ts` — add `GoogleAdsCredentials` + `getGoogleAdsCredentials()`
- `backend/src/config/integrations.ts` — add `INTEGRATION_CONFIG.google_ads` + `getGoogleAdsConfig()`
- `backend/src/app.ts` — register `googleAdsAuth` and `googleAds` routes
- `backend/src/emma/tools.ts` — add `call_google_ads_api` + `call_google_ads_reporting_api`
- `backend/src/services/agentModeService.ts` — add tool handler methods
- `backend/src/docs/agentModeSystemPrompt.ts` — add Google Ads workflow instructions
- `customer-portal/src/App.tsx` — register `/oauth/google-ads/callback` route
- `customer-portal/src/pages/Settings.tsx` — add Google Ads platform card + postMessage handler

---

## Task 1: Foundation — PlatformType + Secrets Manager

**Files:**
- Modify: `backend/src/services/connectedAccountsDb.ts:7`
- Modify: `backend/src/utils/secretsManager.ts`

- [ ] **Step 1: Add `'google_ads'` to PlatformType**

In `backend/src/services/connectedAccountsDb.ts`, find line 7:
```typescript
export type PlatformType = 'linkedin' | 'unipile' | 'meta' | 'twitter' | 'instagram' | 'gmail' | 'youtube' | 'fathom' | 'linkedin_ads' | 'hubspot' | 'attio';
```
Change to:
```typescript
export type PlatformType = 'linkedin' | 'unipile' | 'meta' | 'twitter' | 'instagram' | 'gmail' | 'youtube' | 'fathom' | 'linkedin_ads' | 'hubspot' | 'attio' | 'google_ads';
```

- [ ] **Step 2: Add `GoogleAdsCredentials` interface and `getGoogleAdsCredentials()` to secretsManager.ts**

Find the end of `getYouTubeCredentials()` in `backend/src/utils/secretsManager.ts` and add after it:

```typescript
export interface GoogleAdsCredentials {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  managerCustomerId: string;
}

export async function getGoogleAdsCredentials(): Promise<GoogleAdsCredentials> {
  try {
    const environment = process.env.NODE_ENV || 'development';
    const secretName = environment === 'production'
      ? 'prod/AgentWeb/GoogleAds'
      : 'dev/AgentWeb/GoogleAds';

    const secretString = await getSecret(secretName);

    if (!secretString || secretString.trim() === '') {
      throw new Error('Google Ads credentials secret is empty');
    }

    const credentials = JSON.parse(secretString) as GoogleAdsCredentials;

    if (!credentials.clientId || !credentials.clientSecret || !credentials.developerToken || !credentials.managerCustomerId) {
      throw new Error('Google Ads credentials missing required fields');
    }

    return credentials;
  } catch (error) {
    console.error('Error fetching Google Ads credentials from Secrets Manager:', error);
    throw new Error('Failed to fetch Google Ads credentials from Secrets Manager');
  }
}
```

- [ ] **Step 3: Verify TypeScript compilation**

```bash
cd backend && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/connectedAccountsDb.ts backend/src/utils/secretsManager.ts
git commit -m "feat: add google_ads PlatformType and secrets manager credentials"
```

---

## Task 2: OAuth Config

**Files:**
- Modify: `backend/src/config/integrations.ts`

- [ ] **Step 1: Add `google_ads` to `INTEGRATION_CONFIG`**

In `backend/src/config/integrations.ts`, find the `INTEGRATION_CONFIG` object and add after the `youtube` entry:

```typescript
google_ads: {
  redirectUri: `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/oauth/google-ads/callback`,
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  scopes: [
    'https://www.googleapis.com/auth/adwords',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ],
},
```

- [ ] **Step 2: Add `GoogleAdsOAuthConfig` interface and `getGoogleAdsConfig()` function**

After the `getYouTubeConfig()` function, add:

```typescript
export interface GoogleAdsOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  authorizationUrl: string;
  tokenUrl: string;
}

let cachedGoogleAdsConfig: GoogleAdsOAuthConfig | null = null;
let googleAdsConfigCacheExpiresAt = 0;
const GOOGLE_ADS_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getGoogleAdsConfig(): Promise<GoogleAdsOAuthConfig> {
  if (cachedGoogleAdsConfig && Date.now() < googleAdsConfigCacheExpiresAt) {
    return cachedGoogleAdsConfig;
  }
  const credentials = await getGoogleAdsCredentials();
  cachedGoogleAdsConfig = {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: INTEGRATION_CONFIG.google_ads.redirectUri,
    scopes: INTEGRATION_CONFIG.google_ads.scopes,
    authorizationUrl: INTEGRATION_CONFIG.google_ads.authorizationUrl,
    tokenUrl: INTEGRATION_CONFIG.google_ads.tokenUrl,
  };
  googleAdsConfigCacheExpiresAt = Date.now() + GOOGLE_ADS_CONFIG_CACHE_TTL_MS;
  return cachedGoogleAdsConfig;
}
```

Also add `getGoogleAdsCredentials` to the import from `secretsManager.ts` at the top of `integrations.ts`.

- [ ] **Step 3: Verify TypeScript compilation**

```bash
cd backend && npx tsc --noEmit
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add backend/src/config/integrations.ts
git commit -m "feat: add Google Ads OAuth config"
```

---

## Task 3: OAuth Routes

**Files:**
- Create: `backend/src/routes/googleAdsAuth.ts`
- Create: `backend/src/__tests__/googleAdsAuth.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/googleAdsAuth.test.ts`:

```typescript
jest.mock('../config/integrations', () => ({
  getGoogleAdsConfig: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3001/api/oauth/google-ads/callback',
    scopes: ['https://www.googleapis.com/auth/adwords'],
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
  }),
}));

const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: (...args: any[]) => mockAxiosGet(...args),
}));

jest.mock('../services/connectedAccountsDb', () => ({
  createAccount: jest.fn().mockResolvedValue({ platform: 'google_ads', account_id: '1234567890' }),
  deleteAccountById: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listAccessibleAccounts: jest.fn().mockResolvedValue([
      { customerId: '1234567890', name: 'Test Account', currency: 'USD' },
    ]),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
}));

import request from 'supertest';
import express from 'express';
import router from '../routes/googleAdsAuth';
import { createAccount, deleteAccountById } from '../services/connectedAccountsDb';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const app = express();
app.use(express.json());
app.use('/', router);

const makeState = (userId: string, expiresIn: jwt.SignOptions['expiresIn'] = '15m') =>
  jwt.sign({ userId, nonce: 'abc123' }, JWT_SECRET, { expiresIn });

beforeEach(() => {
  jest.clearAllMocks();
  mockAxiosPost.mockResolvedValue({
    data: { access_token: 'gads-token', refresh_token: 'gads-refresh', expires_in: 3600 },
  });
});

describe('GET /init', () => {
  it('returns a Google OAuth URL', async () => {
    const res = await request(app).get('/init').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.url).toContain('accounts.google.com');
    expect(res.body.url).toContain('adwords');
  });
});

describe('GET /callback', () => {
  it('redirects to frontend with code and state on success', async () => {
    const res = await request(app)
      .get('/callback?code=auth-code&state=somestate')
      .expect(302);
    expect(res.headers.location).toContain('code=auth-code');
    expect(res.headers.location).toContain('state=somestate');
  });

  it('redirects to frontend with error on access_denied', async () => {
    const res = await request(app)
      .get('/callback?error=access_denied')
      .expect(302);
    expect(res.headers.location).toContain('error=google_ads_access_denied');
  });
});

describe('POST /finalize', () => {
  it('returns adAccounts and tokenSessionId on success', async () => {
    const state = makeState('user-123');
    const res = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.adAccounts).toHaveLength(1);
    expect(res.body.tokenSessionId).toBeDefined();
  });

  it('returns 403 for invalid state', async () => {
    const res = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state: 'bad-state' })
      .expect(403);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });

  it('returns 400 for missing code', async () => {
    const state = makeState('user-123');
    const res = await request(app)
      .post('/finalize')
      .send({ state })
      .expect(400);
    expect(res.body.error).toMatch(/missing/i);
  });
});

describe('POST /connect', () => {
  it('stores the selected account and returns success', async () => {
    const state = makeState('user-123');
    const finalizeRes = await request(app)
      .post('/finalize')
      .send({ code: 'auth-code', state })
      .expect(200);

    const res = await request(app)
      .post('/connect')
      .send({
        tokenSessionId: finalizeRes.body.tokenSessionId,
        customerId: '1234567890',
        accountName: 'Test Account',
        currency: 'USD',
      })
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(createAccount).toHaveBeenCalledWith('user-123', 'google_ads', expect.objectContaining({
      account_id: '1234567890',
    }));
  });

  it('returns 401 for invalid tokenSessionId', async () => {
    const res = await request(app)
      .post('/connect')
      .send({ tokenSessionId: 'bad-session', customerId: '123' })
      .expect(401);
    expect(res.body.error).toMatch(/invalid or expired/i);
  });
});

describe('DELETE /disconnect', () => {
  it('removes the account', async () => {
    const res = await request(app)
      .delete('/disconnect')
      .send({ customerId: '1234567890' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(deleteAccountById).toHaveBeenCalledWith('user-123', 'google_ads', '1234567890');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (module not found)**

```bash
cd backend && npx jest googleAdsAuth --no-coverage 2>&1 | tail -20
```
Expected: fails with `Cannot find module '../routes/googleAdsAuth'`

- [ ] **Step 3: Create `backend/src/routes/googleAdsAuth.ts`**

```typescript
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getGoogleAdsConfig } from '../config/integrations';
import { createAccount, deleteAccountById } from '../services/connectedAccountsDb';
import { googleAdsService } from '../services/googleAdsService';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const STATE_SECRET = process.env.JWT_SECRET;
if (!STATE_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set for OAuth state verification');
}

interface StatePayload { userId: string; nonce: string; }

const generateState = (userId: string): string =>
  jwt.sign({ userId, nonce: crypto.randomBytes(16).toString('hex') } as StatePayload, STATE_SECRET, { expiresIn: STATE_EXPIRATION });

const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, STATE_SECRET) as StatePayload;
    return decoded.userId === userId ? decoded : null;
  } catch { return null; }
};

interface TokenSession {
  tokens: { access_token: string; refresh_token?: string; expires_in: number; };
  adAccounts: { customerId: string; name: string; currency: string; }[];
  userId: string;
  expires: number;
}

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of tokenSessions.entries()) {
    if (now > s.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const storeTokenSession = (userId: string, tokens: TokenSession['tokens'], adAccounts: TokenSession['adAccounts']): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, adAccounts, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): TokenSession | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId);
  return session;
};

// GET /init
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getGoogleAdsConfig();
    const state = generateState(req.user.userId);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    res.json({ success: true, url: `${config.authorizationUrl}?${params.toString()}` });
  } catch (error: any) {
    console.error('[Google Ads OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize Google Ads OAuth' });
  }
});

// GET /callback
router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
  if (error) return res.redirect(`${frontendUrl}/oauth/google-ads/callback?error=google_ads_access_denied&details=${error}`);
  if (!code) return res.redirect(`${frontendUrl}/oauth/google-ads/callback?error=no_code_provided`);
  res.redirect(`${frontendUrl}/oauth/google-ads/callback?code=${code}&state=${state}`);
});

// POST /finalize
router.post('/finalize', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  if (!code || typeof code !== 'string') return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  if (!state || typeof state !== 'string') return res.status(400).json({ error: 'Invalid or missing state parameter' });

  const statePayload = verifyState(state, userId);
  if (!statePayload) return res.status(403).json({ error: 'Invalid or expired state parameter' });

  try {
    const config = await getGoogleAdsConfig();
    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string; refresh_token?: string; expires_in: number;
    };

    const adAccounts = await googleAdsService.listAccessibleAccounts(access_token);
    const tokenSessionId = storeTokenSession(userId, { access_token, refresh_token, expires_in }, adAccounts);

    res.json({ success: true, adAccounts, tokenSessionId });
  } catch (error: any) {
    console.error('[Google Ads OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Google Ads connection', ...(details && { details }) });
  }
});

// POST /connect
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId, customerId, accountName, currency } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId || !customerId) return res.status(400).json({ error: 'Missing tokenSessionId or customerId' });

  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });

  try {
    const tokenExpiresAt = Date.now() + session.tokens.expires_in * 1000;
    await createAccount(userId, 'google_ads', {
      account_id: customerId,
      account_name: accountName || customerId,
      config: {
        customer_id: customerId,
        currency: currency || 'USD',
        access_token: session.tokens.access_token,
        refresh_token: session.tokens.refresh_token,
        token_expires_at: tokenExpiresAt,
      },
    });
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Google Ads OAuth /connect]', error);
    res.status(500).json({ error: 'Failed to save Google Ads account' });
  }
});

// DELETE /disconnect
router.delete('/disconnect', authenticateToken, async (req: any, res) => {
  const { customerId } = req.body;
  const userId = req.user.userId;
  if (!customerId) return res.status(400).json({ error: 'Missing customerId' });
  try {
    await deleteAccountById(userId, 'google_ads', customerId);
    res.json({ success: true });
  } catch (error: any) {
    console.error('[Google Ads OAuth /disconnect]', error);
    res.status(500).json({ error: 'Failed to disconnect Google Ads account' });
  }
});

export default router;
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd backend && npx jest googleAdsAuth --no-coverage 2>&1 | tail -20
```
Expected: all tests pass

- [ ] **Step 5: Verify TypeScript compilation**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/googleAdsAuth.ts backend/src/__tests__/googleAdsAuth.test.ts
git commit -m "feat: add Google Ads OAuth routes (init/callback/finalize/connect/disconnect)"
```

---

## Task 4: OAuth Callback Page + App.tsx Route

**Files:**
- Create: `customer-portal/src/pages/GoogleAdsOAuthCallback.tsx`
- Modify: `customer-portal/src/App.tsx`

The OAuth popup flow requires a dedicated callback page — the same pattern as `LinkedInAdsOAuthCallback.tsx`. The page receives `/oauth/google-ads/callback?code=...&state=...`, calls `/finalize`, and sends a `postMessage` to the opener window. Settings.tsx then handles the postMessage to show the account selector modal.

- [ ] **Step 1: Create `customer-portal/src/pages/GoogleAdsOAuthCallback.tsx`**

```typescript
import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { buildApiUrl } from '@/config';
import { useAuth } from '@/contexts/AuthContext';

export default function GoogleAdsOAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { token, loading } = useAuth();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Processing Google Ads authentication...');
  const hasHandled = useRef(false);

  useEffect(() => {
    if (loading) return;
    if (hasHandled.current) return;

    const handle = async () => {
      hasHandled.current = true;
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const error = searchParams.get('error');

      if (error) {
        setStatus('error');
        setMessage(`Authentication failed: ${error}`);
        window.opener?.postMessage({ type: 'GOOGLE_ADS_OAUTH_ERROR', error }, window.location.origin);
        setTimeout(() => window.close(), 2000);
        return;
      }

      if (!code || !state) {
        setStatus('error');
        setMessage('Missing authorization code or state parameter');
        window.opener?.postMessage({ type: 'GOOGLE_ADS_OAUTH_ERROR', error: 'missing_parameters' }, window.location.origin);
        setTimeout(() => window.close(), 2000);
        return;
      }

      try {
        if (!token) throw new Error('session_expired');

        const response = await axios.post(
          buildApiUrl('/api/oauth/google-ads/finalize'),
          { code, state },
          { headers: { Authorization: `Bearer ${token}` } }
        );

        if (response.data.success) {
          setStatus('success');
          setMessage('Connected! Closing window...');
          window.opener?.postMessage(
            {
              type: 'GOOGLE_ADS_AUTH_SUCCESS',
              adAccounts: response.data.adAccounts,
              tokenSessionId: response.data.tokenSessionId,
            },
            window.location.origin
          );
          window.close();
        } else {
          throw new Error('Failed to finalize authentication');
        }
      } catch (err: any) {
        if (err.message === 'session_expired' || err.response?.status === 401) {
          setStatus('error');
          setMessage('Your session has expired. Please log in again.');
          window.opener?.postMessage({ type: 'FORCE_LOGOUT' }, window.location.origin);
          setTimeout(() => window.close(), 3000);
          return;
        }
        setStatus('error');
        setMessage(err.response?.data?.error || err.message || 'Authentication failed');
        window.opener?.postMessage(
          { type: 'GOOGLE_ADS_OAUTH_ERROR', error: err.response?.data?.error || err.message },
          window.location.origin
        );
        setTimeout(() => window.close(), 2000);
      }
    };

    handle();
  }, [searchParams, navigate, token, loading]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="max-w-md w-full p-8 space-y-6 text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="w-16 h-16 mx-auto text-[#4285F4] animate-spin" />
            <h2 className="text-2xl font-semibold">Connecting Google Ads</h2>
            <p className="text-muted-foreground">{message}</p>
          </>
        )}
        {status === 'success' && (
          <>
            <CheckCircle2 className="w-16 h-16 mx-auto text-green-500" />
            <h2 className="text-2xl font-semibold text-green-600">Success!</h2>
            <p className="text-muted-foreground">{message}</p>
          </>
        )}
        {status === 'error' && (
          <>
            <XCircle className="w-16 h-16 mx-auto text-red-500" />
            <h2 className="text-2xl font-semibold text-red-600">Error</h2>
            <p className="text-muted-foreground">{message}</p>
            <button onClick={() => window.close()} className="mt-4 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">
              Close Window
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Register route in `customer-portal/src/App.tsx`**

Find where `LinkedInAdsOAuthCallback` is imported and registered, add alongside it:

```typescript
// import (near LinkedInAdsOAuthCallback import)
import GoogleAdsOAuthCallback from "@/pages/GoogleAdsOAuthCallback";

// route (near /oauth/linkedin-ads/callback route)
<Route path="/oauth/google-ads/callback" element={<GoogleAdsOAuthCallback />} />
```

- [ ] **Step 3: Add postMessage handler in `Settings.tsx`**

In the `handleOAuthMessage` function in Settings.tsx, add these two cases alongside the other platform handlers:

```typescript
} else if (event.data.type === 'GOOGLE_ADS_AUTH_SUCCESS') {
  setGoogleAdsAccounts(event.data.adAccounts || []);
  setGoogleAdsSessionId(event.data.tokenSessionId);
  setShowGoogleAdsModal(true);
  setIsConnectingGoogleAds(false);
} else if (event.data.type === 'GOOGLE_ADS_OAUTH_ERROR') {
  setIsConnectingGoogleAds(false);
  toast({
    title: 'Google Ads Connection Failed',
    description: event.data.error || 'Failed to connect Google Ads account',
    variant: 'destructive',
  });
}
```

**Important:** Remove the incorrect `useEffect` URL-param-based callback handler described in Task 11 — the postMessage approach above is the correct pattern for this codebase.

- [ ] **Step 4: Verify TypeScript compilation**

```bash
cd customer-portal && npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add customer-portal/src/pages/GoogleAdsOAuthCallback.tsx customer-portal/src/App.tsx customer-portal/src/pages/Settings.tsx
git commit -m "feat: add Google Ads OAuth callback page and postMessage handler"
```

---

## Task 5: Register Backend Routes

**Files:**
- Modify: `backend/src/app.ts`

- [ ] **Step 1: Add imports**

In `backend/src/app.ts`, add after the `youtubeAuthRoutes` import:
```typescript
import googleAdsAuthRoutes from "./routes/googleAdsAuth";
import googleAdsRoutes from "./routes/googleAds";
```

- [ ] **Step 2: Register routes**

After `app.use("/api/oauth/youtube", youtubeAuthRoutes);` add:
```typescript
app.use("/api/oauth/google-ads", googleAdsAuthRoutes);
app.use("/api/google-ads", googleAdsRoutes);
```

- [ ] **Step 3: Verify TypeScript compilation**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/app.ts
git commit -m "feat: register Google Ads routes in app.ts"
```

---

## Task 6: Service Foundation — HTTP Helper + Account Listing

**Files:**
- Create: `backend/src/services/googleAdsService.ts`
- Create: `backend/src/__tests__/googleAdsService.test.ts` (foundation tests)

- [ ] **Step 1: Write failing tests for service foundation**

Create `backend/src/__tests__/googleAdsService.test.ts`:

```typescript
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();
jest.mock('axios', () => ({
  post: (...args: any[]) => mockAxiosPost(...args),
  get: (...args: any[]) => mockAxiosGet(...args),
}));

jest.mock('../utils/secretsManager', () => ({
  getGoogleAdsCredentials: jest.fn().mockResolvedValue({
    clientId: 'test-client-id',
    clientSecret: 'test-secret',
    developerToken: 'test-dev-token',
    managerCustomerId: '9999999999',
  }),
}));

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn().mockResolvedValue({
      userId: 'user-123',
      connected_accounts: [
        {
          platform: 'google_ads',
          account_id: '1234567890',
          account_name: 'Test Account',
          config: {
            customer_id: '1234567890',
            currency: 'USD',
            access_token: 'valid-token',
            refresh_token: 'refresh-token',
            token_expires_at: Date.now() + 3600 * 1000,
          },
        },
      ],
    }),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
  // normalizeAccounts is NOT exported — do not mock it here
}));

import { GoogleAdsService } from '../services/googleAdsService';

let service: GoogleAdsService;
beforeEach(() => {
  jest.clearAllMocks();
  service = new GoogleAdsService();
});

describe('listAccessibleAccounts', () => {
  it('calls listAccessibleCustomers and returns parsed accounts', async () => {
    mockAxiosGet.mockResolvedValueOnce({
      data: { resourceNames: ['customers/1234567890'] },
    });
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          customer: { id: '1234567890', descriptiveName: 'Test Account', currencyCode: 'USD' },
        }],
      },
    });

    const accounts = await service.listAccessibleAccounts('test-access-token');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toEqual({ customerId: '1234567890', name: 'Test Account', currency: 'USD' });
  });

  it('returns empty array if no accessible customers', async () => {
    mockAxiosGet.mockResolvedValueOnce({ data: { resourceNames: [] } });
    const accounts = await service.listAccessibleAccounts('test-access-token');
    expect(accounts).toHaveLength(0);
  });
});

describe('getAccountCredentials', () => {
  it('returns credentials for a connected account', async () => {
    const creds = await service.getAccountCredentials('user-123', '1234567890');
    expect(creds.accessToken).toBe('valid-token');
    expect(creds.customerId).toBe('1234567890');
    expect(creds.currency).toBe('USD');
  });

  it('throws if customerId not in connected accounts', async () => {
    await expect(service.getAccountCredentials('user-123', 'wrong-id'))
      .rejects.toThrow('Google Ads account not found in your connected accounts');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | tail -10
```
Expected: fails with `Cannot find module '../services/googleAdsService'`

- [ ] **Step 3: Create `backend/src/services/googleAdsService.ts`**

```typescript
import axios from 'axios';
import { getGoogleAdsCredentials } from '../utils/secretsManager';
import { userDb, User } from './db';                          // sibling in services/
import { updateAccountTokens } from './connectedAccountsDb'; // sibling in services/

const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com/v18';
const TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdAccount {
  customerId: string;
  name: string;
  currency: string;
}

export interface GoogleAdsCampaign {
  resourceName: string;
  id: string;
  name: string;
  status: string;
  type: string;
}

export interface GoogleAdsBudget {
  resourceName: string;
  id: string;
}

export interface GoogleAdsCredentials {
  accessToken: string;
  customerId: string;
  currency: string;
}

export class GoogleAdsService {
  // Single-flight refresh guard: userId → in-flight promise
  private refreshInFlight = new Map<string, Promise<string>>();

  // ── Internal HTTP helper ─────────────────────────────────────────────────

  private async callApi(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    loginCustomerId: string,
    body?: any
  ): Promise<any> {
    const secrets = await getGoogleAdsCredentials();
    const response = method === 'GET'
      ? await axios.get(`${GOOGLE_ADS_API_BASE}${path}`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': secrets.developerToken,
            'login-customer-id': loginCustomerId,
          },
        })
      : await axios.post(`${GOOGLE_ADS_API_BASE}${path}`, body, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'developer-token': secrets.developerToken,
            'login-customer-id': loginCustomerId,
            'Content-Type': 'application/json',
          },
        });
    return response.data;
  }

  private async search(customerId: string, accessToken: string, query: string): Promise<any[]> {
    const data = await this.callApi('POST', `/customers/${customerId}/googleAds:search`, accessToken, customerId, { query });
    return data.results || [];
  }

  private async mutate(customerId: string, accessToken: string, resource: string, operations: any[]): Promise<any> {
    return this.callApi('POST', `/customers/${customerId}/${resource}:mutate`, accessToken, customerId, { operations });
  }

  private makeAuthError(message: string): Error {
    const err = new Error(message);
    (err as any).isGoogleAdsAuthError = true;
    return err;
  }

  // ── Token refresh (single-flight) ────────────────────────────────────────

  private async refreshAccessToken(userId: string, accountId: string, refreshToken: string): Promise<string> {
    const key = `${userId}:${accountId}`;
    if (this.refreshInFlight.has(key)) {
      return this.refreshInFlight.get(key)!;
    }
    const promise = (async () => {
      const secrets = await getGoogleAdsCredentials();
      const response = await axios.post(TOKEN_REFRESH_URL, new URLSearchParams({
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const { access_token, expires_in } = response.data as { access_token: string; expires_in: number };
      await updateAccountTokens(userId, 'google_ads', {
        access_token,
        token_expires_at: Date.now() + expires_in * 1000,
      }, accountId);
      return access_token;
    })();
    this.refreshInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.refreshInFlight.delete(key);
    }
  }

  // ── Account credentials + ownership validation ───────────────────────────

  async getAccountCredentials(userId: string, customerId: string): Promise<GoogleAdsCredentials> {
    const user = await userDb.getUserById(userId);
    if (!user) throw this.makeAuthError('User not found');

    const accounts: any[] = Array.isArray(user.connected_accounts)
      ? user.connected_accounts
      : user.connected_accounts ? [user.connected_accounts] : [];

    const account = accounts.find(
      (a: any) => a.platform === 'google_ads' && a.config?.customer_id === customerId
    );
    if (!account) throw this.makeAuthError('Google Ads account not found in your connected accounts. Connect it in Settings.');

    let accessToken = account.config.access_token;
    const isExpired = account.config.token_expires_at && Date.now() > account.config.token_expires_at - 60_000;
    if (isExpired && account.config.refresh_token) {
      accessToken = await this.refreshAccessToken(userId, customerId, account.config.refresh_token);
    }

    return { accessToken, customerId, currency: account.config.currency || 'USD' };
  }

  // ── Account listing (used during OAuth finalize) ─────────────────────────

  async listAccessibleAccounts(accessToken: string): Promise<GoogleAdAccount[]> {
    const secrets = await getGoogleAdsCredentials();
    const response = await axios.get(`${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': secrets.developerToken,
      },
    });

    const resourceNames: string[] = response.data.resourceNames || [];
    if (resourceNames.length === 0) return [];

    const accounts: GoogleAdAccount[] = [];
    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const results = await this.search(customerId, accessToken,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1'
        );
        if (results.length > 0) {
          const c = results[0].customer;
          accounts.push({ customerId: String(c.id), name: c.descriptiveName || customerId, currency: c.currencyCode || 'USD' });
        }
      } catch {
        accounts.push({ customerId, name: customerId, currency: 'USD' });
      }
    }
    return accounts;
  }
}

export const googleAdsService = new GoogleAdsService();
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | tail -10
```
Expected: foundation tests pass

- [ ] **Step 5: Verify TypeScript compilation**

```bash
cd backend && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/googleAdsService.ts backend/src/__tests__/googleAdsService.test.ts
git commit -m "feat: add Google Ads service foundation (HTTP helper, auth, account listing)"
```

---

## Task 7: Service — Budget + Campaign CRUD

**Files:**
- Modify: `backend/src/services/googleAdsService.ts`
- Modify: `backend/src/__tests__/googleAdsService.test.ts`

- [ ] **Step 1: Add tests for budget + campaign methods**

Append to `backend/src/__tests__/googleAdsService.test.ts`:

```typescript
describe('createBudget', () => {
  it('sends mutate request and returns resource name', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/campaignBudgets/456' }] },
    });
    const budget = await service.createBudget('user-123', '1234567890', {
      amountMicros: 10_000_000,
      name: 'Test Budget',
    });
    expect(budget.resourceName).toBe('customers/123/campaignBudgets/456');
    const callBody = mockAxiosPost.mock.calls[0][1];
    expect(callBody.operations[0].create.amountMicros).toBe('10000000');
    expect(callBody.operations[0].create.deliveryMethod).toBe('STANDARD');
  });
});

describe('listCampaigns', () => {
  it('returns campaigns from GAQL search', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          campaign: { resourceName: 'customers/123/campaigns/1', id: '1', name: 'Search Campaign', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
        }],
      },
    });
    const campaigns = await service.listCampaigns('user-123', '1234567890');
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0].name).toBe('Search Campaign');
    expect(campaigns[0].type).toBe('SEARCH');
  });
});

describe('createCampaign', () => {
  it('creates a SEARCH campaign with correct body', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/campaigns/2' }] },
    });
    const campaign = await service.createCampaign('user-123', '1234567890', {
      name: 'Test Search',
      type: 'SEARCH',
      budgetResourceName: 'customers/123/campaignBudgets/456',
      biddingStrategy: 'MAXIMIZE_CONVERSIONS',
      locationTargetIds: [2840],
      status: 'PAUSED',
    });
    expect(campaign.resourceName).toBe('customers/123/campaigns/2');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.advertisingChannelType).toBe('SEARCH');
    expect(body.operations[0].create.maximizeConversions).toBeDefined();
  });

  it('creates a PERFORMANCE_MAX campaign', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/campaigns/3' }] },
    });
    await service.createCampaign('user-123', '1234567890', {
      name: 'PMax Campaign',
      type: 'PERFORMANCE_MAX',
      budgetResourceName: 'customers/123/campaignBudgets/456',
      biddingStrategy: 'MAXIMIZE_CONVERSION_VALUE',
      locationTargetIds: [2840],
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.advertisingChannelType).toBe('PERFORMANCE_MAX');
  });
});

describe('pauseCampaign / resumeCampaign', () => {
  it('pauses a campaign', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.pauseCampaign('user-123', '1234567890', 'customers/123/campaigns/1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.status).toBe('PAUSED');
  });

  it('resumes a campaign', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.resumeCampaign('user-123', '1234567890', 'customers/123/campaigns/1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].update.status).toBe('ENABLED');
  });
});

describe('searchLocations', () => {
  it('returns location suggestions', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        geoTargetConstantSuggestions: [{
          geoTargetConstant: { id: '2840', name: 'United States', countryCode: 'US', targetType: 'Country' },
        }],
      },
    });
    const locations = await service.searchLocations('user-123', '1234567890', 'United States', 'en');
    expect(locations).toHaveLength(1);
    expect(locations[0].id).toBe('2840');
    expect(locations[0].name).toBe('United States');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | grep -E "FAIL|PASS|✓|✕|×" | head -20
```
Expected: new tests fail with `service.createBudget is not a function`

- [ ] **Step 3: Add budget + campaign methods to `googleAdsService.ts`**

Add these methods inside the `GoogleAdsService` class after `listAccessibleAccounts`:

```typescript
// ── Budgets ──────────────────────────────────────────────────────────────

async createBudget(userId: string, customerId: string, params: {
  name: string;
  amountMicros: number;
}): Promise<{ resourceName: string }> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const data = await this.mutate(customerId, accessToken, 'campaignBudgets', [{
    create: {
      name: params.name,
      amountMicros: String(params.amountMicros),
      deliveryMethod: 'STANDARD',
    },
  }]);
  return { resourceName: data.results[0].resourceName };
}

// ── Campaigns ────────────────────────────────────────────────────────────

async listCampaigns(userId: string, customerId: string): Promise<GoogleAdsCampaign[]> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const results = await this.search(customerId, accessToken,
    'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign ORDER BY campaign.id'
  );
  return results.map((r: any) => ({
    resourceName: r.campaign.resourceName,
    id: String(r.campaign.id),
    name: r.campaign.name,
    status: r.campaign.status,
    type: r.campaign.advertisingChannelType,
  }));
}

async createCampaign(userId: string, customerId: string, params: {
  name: string;
  type: 'SEARCH' | 'DISPLAY' | 'PERFORMANCE_MAX';
  budgetResourceName: string;
  biddingStrategy: 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA' | 'TARGET_ROAS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_IMPRESSION_SHARE' | 'MANUAL_CPC';
  biddingStrategyTarget?: number;
  locationTargetIds: number[];
  status?: 'ENABLED' | 'PAUSED';
}): Promise<{ resourceName: string }> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);

  const biddingField: Record<string, any> = {};
  if (params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') biddingField.maximizeConversions = {};
  else if (params.biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') biddingField.maximizeConversionValue = {};
  else if (params.biddingStrategy === 'TARGET_CPA') biddingField.targetCpa = { targetCpaMicros: String(Math.round((params.biddingStrategyTarget || 0) * 1_000_000)) };
  else if (params.biddingStrategy === 'TARGET_ROAS') biddingField.targetRoas = { targetRoas: params.biddingStrategyTarget || 1 };
  else if (params.biddingStrategy === 'TARGET_IMPRESSION_SHARE') biddingField.targetImpressionShare = {};
  else if (params.biddingStrategy === 'MANUAL_CPC') biddingField.manualCpc = {};

  const data = await this.mutate(customerId, accessToken, 'campaigns', [{
    create: {
      name: params.name,
      advertisingChannelType: params.type,
      campaignBudget: params.budgetResourceName,
      status: params.status || 'PAUSED',
      ...biddingField,
    },
  }]);

  const campaignResourceName = data.results[0].resourceName;

  // Set geo targeting if locationTargetIds provided
  if (params.locationTargetIds.length > 0) {
    await this.mutate(customerId, accessToken, 'campaignCriteria', params.locationTargetIds.map(id => ({
      create: {
        campaign: campaignResourceName,
        location: { geoTargetConstant: `geoTargetConstants/${id}` },
      },
    })));
  }

  return { resourceName: campaignResourceName };
}

async updateCampaign(userId: string, customerId: string, campaignResourceName: string, params: {
  name?: string;
  status?: 'ENABLED' | 'PAUSED';
}): Promise<void> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const updateMask: string[] = [];
  const update: any = { resourceName: campaignResourceName };
  if (params.name) { update.name = params.name; updateMask.push('name'); }
  if (params.status) { update.status = params.status; updateMask.push('status'); }
  await this.mutate(customerId, accessToken, 'campaigns', [{ update, updateMask: updateMask.join(',') }]);
}

async pauseCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
  return this.updateCampaign(userId, customerId, campaignResourceName, { status: 'PAUSED' });
}

async resumeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
  return this.updateCampaign(userId, customerId, campaignResourceName, { status: 'ENABLED' });
}

// ── Location search ───────────────────────────────────────────────────────

async searchLocations(userId: string, customerId: string, query: string, locale: string = 'en'): Promise<{ id: string; name: string; countryCode: string; targetType: string }[]> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const secrets = await getGoogleAdsCredentials();
  const response = await axios.post(`${GOOGLE_ADS_API_BASE}/geoTargetConstants:suggest`, { locale, query }, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': secrets.developerToken,
    },
  });
  return (response.data.geoTargetConstantSuggestions || []).map((s: any) => ({
    id: String(s.geoTargetConstant.id),
    name: s.geoTargetConstant.name,
    countryCode: s.geoTargetConstant.countryCode,
    targetType: s.geoTargetConstant.targetType,
  }));
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | tail -10
```
Expected: all tests pass

- [ ] **Step 5: Verify TypeScript compilation + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/services/googleAdsService.ts backend/src/__tests__/googleAdsService.test.ts
git commit -m "feat: add Google Ads budget + campaign CRUD to service"
```

---

## Task 8: Service — Ad Groups, Keywords, Ads

**Files:**
- Modify: `backend/src/services/googleAdsService.ts`
- Modify: `backend/src/__tests__/googleAdsService.test.ts`

- [ ] **Step 1: Add tests**

Append to `backend/src/__tests__/googleAdsService.test.ts`:

```typescript
describe('createAdGroup', () => {
  it('creates an ad group for Search campaign', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/adGroups/789' }] },
    });
    const ag = await service.createAdGroup('user-123', '1234567890', {
      name: 'Test Ad Group',
      campaignResourceName: 'customers/123/campaigns/1',
      type: 'SEARCH_STANDARD',
    });
    expect(ag.resourceName).toBe('customers/123/adGroups/789');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.type).toBe('SEARCH_STANDARD');
  });
});

describe('addKeywords', () => {
  it('adds keywords with correct match types', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}, {}] } });
    await service.addKeywords('user-123', '1234567890', 'customers/123/adGroups/789', [
      { text: 'buy shoes', matchType: 'BROAD' },
      { text: 'running shoes', matchType: 'PHRASE' },
    ]);
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations).toHaveLength(2);
    expect(body.operations[0].create.keyword.matchType).toBe('BROAD');
    expect(body.operations[1].create.keyword.matchType).toBe('PHRASE');
  });
});

describe('addNegativeKeywords', () => {
  it('adds campaign-level negative keywords', async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { results: [{}] } });
    await service.addNegativeKeywords('user-123', '1234567890',
      { campaignResourceName: 'customers/123/campaigns/1' },
      [{ text: 'free', matchType: 'BROAD' }]
    );
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.campaign).toBe('customers/123/campaigns/1');
    expect(body.operations[0].create.keyword.text).toBe('free');
  });
});

describe('createAd (Responsive Search Ad)', () => {
  it('creates RSA with headlines and descriptions', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/adGroupAds/1' }] },
    });
    await service.createAd('user-123', '1234567890', {
      adGroupResourceName: 'customers/123/adGroups/789',
      type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['Headline 1', 'Headline 2', 'Headline 3'],
      descriptions: ['Description 1', 'Description 2'],
      finalUrl: 'https://example.com',
    });
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.ad.responsiveSearchAd.headlines).toHaveLength(3);
    expect(body.operations[0].create.ad.finalUrls[0]).toBe('https://example.com');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | grep -E "FAIL|✕|×" | head -10
```

- [ ] **Step 3: Add methods to `googleAdsService.ts`**

Add inside the `GoogleAdsService` class:

```typescript
// ── Ad Groups ────────────────────────────────────────────────────────────

async listAdGroups(userId: string, customerId: string, campaignResourceName: string): Promise<any[]> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const results = await this.search(customerId, accessToken,
    `SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status, ad_group.type FROM ad_group WHERE ad_group.campaign = '${campaignResourceName}'`
  );
  return results.map((r: any) => ({
    resourceName: r.adGroup.resourceName,
    id: String(r.adGroup.id),
    name: r.adGroup.name,
    status: r.adGroup.status,
    type: r.adGroup.type,
  }));
}

async createAdGroup(userId: string, customerId: string, params: {
  name: string;
  campaignResourceName: string;
  type: 'SEARCH_STANDARD' | 'DISPLAY_STANDARD';
  cpcBidMicros?: number;
}): Promise<{ resourceName: string }> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const data = await this.mutate(customerId, accessToken, 'adGroups', [{
    create: {
      name: params.name,
      campaign: params.campaignResourceName,
      status: 'ENABLED',
      type: params.type,
      ...(params.cpcBidMicros && { cpcBidMicros: String(params.cpcBidMicros) }),
    },
  }]);
  return { resourceName: data.results[0].resourceName };
}

async updateAdGroup(userId: string, customerId: string, adGroupResourceName: string, params: {
  name?: string;
  status?: 'ENABLED' | 'PAUSED';
  cpcBidMicros?: number;
}): Promise<void> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const updateMask: string[] = [];
  const update: any = { resourceName: adGroupResourceName };
  if (params.name) { update.name = params.name; updateMask.push('name'); }
  if (params.status) { update.status = params.status; updateMask.push('status'); }
  if (params.cpcBidMicros) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
  await this.mutate(customerId, accessToken, 'adGroups', [{ update, updateMask: updateMask.join(',') }]);
}

// ── Keywords ─────────────────────────────────────────────────────────────

async addKeywords(userId: string, customerId: string, adGroupResourceName: string, keywords: {
  text: string;
  matchType: 'BROAD' | 'PHRASE' | 'EXACT';
}[]): Promise<void> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
    create: {
      adGroup: adGroupResourceName,
      status: 'ENABLED',
      keyword: { text: kw.text, matchType: kw.matchType },
    },
  })));
}

async addNegativeKeywords(userId: string, customerId: string, target: {
  campaignResourceName?: string;
  adGroupResourceName?: string;
}, keywords: { text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }[]): Promise<void> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  if (target.campaignResourceName) {
    await this.mutate(customerId, accessToken, 'campaignCriteria', keywords.map(kw => ({
      create: {
        campaign: target.campaignResourceName,
        negative: true,
        keyword: { text: kw.text, matchType: kw.matchType },
      },
    })));
  } else if (target.adGroupResourceName) {
    await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
      create: {
        adGroup: target.adGroupResourceName,
        negative: true,
        keyword: { text: kw.text, matchType: kw.matchType },
      },
    })));
  }
}

// ── Ads ──────────────────────────────────────────────────────────────────

async listAds(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const results = await this.search(customerId, accessToken,
    `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type FROM ad_group_ad WHERE ad_group_ad.ad_group = '${adGroupResourceName}'`
  );
  return results.map((r: any) => ({
    resourceName: r.adGroupAd.resourceName,
    adId: String(r.adGroupAd.ad.id),
    status: r.adGroupAd.status,
    type: r.adGroupAd.ad.type,
  }));
}

async createAd(userId: string, customerId: string, params: {
  adGroupResourceName: string;
  type: 'RESPONSIVE_SEARCH_AD' | 'RESPONSIVE_DISPLAY_AD';
  headlines: string[];
  descriptions: string[];
  finalUrl: string;
  imageAssetResourceNames?: string[];
}): Promise<{ resourceName: string }> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);

  let adContent: any;
  if (params.type === 'RESPONSIVE_SEARCH_AD') {
    adContent = {
      responsiveSearchAd: {
        headlines: params.headlines.map(text => ({ text })),
        descriptions: params.descriptions.map(text => ({ text })),
      },
    };
  } else {
    adContent = {
      responsiveDisplayAd: {
        headlines: params.headlines.map(text => ({ text })),
        descriptions: params.descriptions.map(text => ({ text })),
        ...(params.imageAssetResourceNames && {
          marketingImages: params.imageAssetResourceNames.map(asset => ({ asset })),
        }),
      },
    };
  }

  const data = await this.mutate(customerId, accessToken, 'adGroupAds', [{
    create: {
      adGroup: params.adGroupResourceName,
      status: 'ENABLED',
      ad: { ...adContent, finalUrls: [params.finalUrl] },
    },
  }]);
  return { resourceName: data.results[0].resourceName };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | tail -10
```

- [ ] **Step 5: Verify TypeScript compilation + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/services/googleAdsService.ts backend/src/__tests__/googleAdsService.test.ts
git commit -m "feat: add Google Ads ad group, keyword, and ad methods to service"
```

---

## Task 9: Service — Assets, Asset Groups, Reporting

**Files:**
- Modify: `backend/src/services/googleAdsService.ts`
- Modify: `backend/src/__tests__/googleAdsService.test.ts`

- [ ] **Step 1: Add tests**

Append to `backend/src/__tests__/googleAdsService.test.ts`:

```typescript
describe('uploadAsset', () => {
  it('uploads an image and returns resource name', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: { results: [{ resourceName: 'customers/123/assets/1' }] },
    });
    const result = await service.uploadAsset('user-123', '1234567890', {
      type: 'IMAGE',
      name: 'hero.jpg',
      data: Buffer.from('fake-image-data'),
    });
    expect(result).toBe('customers/123/assets/1');
    const body = mockAxiosPost.mock.calls[0][1];
    expect(body.operations[0].create.type).toBe('IMAGE');
    expect(body.operations[0].create.imageAsset.data).toBeDefined();
  });
});

describe('queryReporting', () => {
  it('runs GAQL and returns results', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{ campaign: { id: '1', name: 'Test' }, metrics: { impressions: '1000' } }],
      },
    });
    const results = await service.queryReporting('user-123', '1234567890',
      'SELECT campaign.id, campaign.name, metrics.impressions FROM campaign WHERE segments.date DURING LAST_30_DAYS',
    );
    expect(results).toHaveLength(1);
    expect(results[0].metrics.impressions).toBe('1000');
  });
});

describe('getQuickMetrics', () => {
  it('returns formatted metrics summary', async () => {
    mockAxiosPost.mockResolvedValueOnce({
      data: {
        results: [{
          campaign: { id: '1', name: 'Test Campaign', status: 'ENABLED' },
          metrics: { impressions: '5000', clicks: '200', costMicros: '1000000000', conversions: '10' },
        }],
      },
    });
    const summary = await service.getQuickMetrics('user-123', '1234567890', { datePreset: 'LAST_30_DAYS' });
    expect(summary.campaigns).toHaveLength(1);
    expect(summary.campaigns[0].name).toBe('Test Campaign');
    expect(summary.campaigns[0].spendFormatted).toBe('1000.00');
    expect(summary.campaigns[0].ctr).toBeCloseTo(4.0);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | grep -E "✕|×|FAIL" | head -10
```

- [ ] **Step 3: Add methods to `googleAdsService.ts`**

```typescript
// ── Assets ───────────────────────────────────────────────────────────────

async uploadAsset(userId: string, customerId: string, asset: {
  type: 'IMAGE' | 'LOGO' | 'VIDEO';
  name: string;
  data: Buffer | string;
}): Promise<string> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  const base64Data = Buffer.isBuffer(asset.data)
    ? asset.data.toString('base64')
    : Buffer.from(asset.data as string, 'binary').toString('base64');

  const assetContent: any = {};
  if (asset.type === 'IMAGE' || asset.type === 'LOGO') {
    assetContent.imageAsset = { data: base64Data };
  } else {
    assetContent.youtubeVideoAsset = { youtubeVideoId: asset.data as string };
  }

  const data = await this.mutate(customerId, accessToken, 'assets', [{
    create: { name: asset.name, type: asset.type, ...assetContent },
  }]);
  return data.results[0].resourceName;
}

// ── Asset Groups (PMax) ───────────────────────────────────────────────────

// Text assets (headlines, descriptions) must be created as TEXT asset resources
// first, then linked to the asset group. Passing raw strings directly to
// assetGroupAssets:mutate will return a 400 from the API.
private async createTextAsset(customerId: string, accessToken: string, text: string): Promise<string> {
  const data = await this.mutate(customerId, accessToken, 'assets', [{
    create: { name: text.substring(0, 50), type: 'TEXT', textAsset: { text } },
  }]);
  return data.results[0].resourceName;
}

async createAssetGroup(userId: string, customerId: string, params: {
  name: string;
  campaignResourceName: string;
  headlines: string[];
  longHeadlines: string[];
  descriptions: string[];
  squareImageAssets: string[];
  landscapeImageAssets: string[];
  logoAssets: string[];
  videoAssets?: string[];
  finalUrl: string;
}): Promise<{ resourceName: string }> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);

  // Step 1: Create asset group container
  const assetGroupData = await this.mutate(customerId, accessToken, 'assetGroups', [{
    create: {
      name: params.name,
      campaign: params.campaignResourceName,
      status: 'ENABLED',
      finalUrls: [params.finalUrl],
    },
  }]);
  const assetGroupResourceName = assetGroupData.results[0].resourceName;

  // Step 2: Create text assets (headlines + descriptions) as TEXT type resources
  const headlineResourceNames = await Promise.all(params.headlines.map(t => this.createTextAsset(customerId, accessToken, t)));
  const longHeadlineResourceNames = await Promise.all(params.longHeadlines.map(t => this.createTextAsset(customerId, accessToken, t)));
  const descriptionResourceNames = await Promise.all(params.descriptions.map(t => this.createTextAsset(customerId, accessToken, t)));

  // Step 3: Link all assets to the asset group
  type AssetFieldType = 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION' | 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE' | 'LOGO' | 'YOUTUBE_VIDEO';
  const assetLinkOps: any[] = [];

  const addLinks = (resourceNames: string[], fieldType: AssetFieldType) => {
    for (const asset of resourceNames) {
      assetLinkOps.push({ create: { assetGroup: assetGroupResourceName, asset, fieldType } });
    }
  };

  addLinks(headlineResourceNames, 'HEADLINE');
  addLinks(longHeadlineResourceNames, 'LONG_HEADLINE');
  addLinks(descriptionResourceNames, 'DESCRIPTION');
  addLinks(params.squareImageAssets, 'SQUARE_MARKETING_IMAGE');
  addLinks(params.landscapeImageAssets, 'MARKETING_IMAGE');
  addLinks(params.logoAssets, 'LOGO');
  if (params.videoAssets) addLinks(params.videoAssets, 'YOUTUBE_VIDEO');

  if (assetLinkOps.length > 0) {
    await this.mutate(customerId, accessToken, 'assetGroupAssets', assetLinkOps);
  }

  return { resourceName: assetGroupResourceName };
}

// ── Reporting ─────────────────────────────────────────────────────────────

async queryReporting(userId: string, customerId: string, gaqlQuery: string): Promise<any[]> {
  const { accessToken } = await this.getAccountCredentials(userId, customerId);
  return this.search(customerId, accessToken, gaqlQuery);
}

async getQuickMetrics(userId: string, customerId: string, options: {
  campaignIds?: string[];
  datePreset?: string;
}): Promise<{ campaigns: any[]; totals: any; currency: string }> {
  const { accessToken, currency } = await this.getAccountCredentials(userId, customerId);
  const dateClause = options.datePreset ? `DURING ${options.datePreset}` : 'DURING LAST_30_DAYS';
  const whereClause = options.campaignIds?.length
    ? `WHERE campaign.id IN (${options.campaignIds.join(',')}) AND segments.date ${dateClause.replace('DURING ', 'DURING ')}`
    : `WHERE segments.date ${dateClause}`;

  const query = `SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc FROM campaign ${whereClause} ORDER BY metrics.cost_micros DESC`;
  const results = await this.search(customerId, accessToken, query);

  const campaigns = results.map((r: any) => {
    const m = r.metrics;
    const spend = Number(m.costMicros || 0) / 1_000_000;
    const clicks = Number(m.clicks || 0);
    const impressions = Number(m.impressions || 0);
    return {
      id: String(r.campaign.id),
      name: r.campaign.name,
      status: r.campaign.status,
      impressions,
      clicks,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      spendFormatted: spend.toFixed(2),
      conversions: Number(m.conversions || 0),
      avgCpc: clicks > 0 ? (spend / clicks).toFixed(2) : '0.00',
    };
  });

  const totals = campaigns.reduce((acc, c) => ({
    impressions: acc.impressions + c.impressions,
    clicks: acc.clicks + c.clicks,
    spend: acc.spend + parseFloat(c.spendFormatted),
    conversions: acc.conversions + c.conversions,
  }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });

  return { campaigns, totals, currency };
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
cd backend && npx jest googleAdsService --no-coverage 2>&1 | tail -10
```

- [ ] **Step 5: Verify TypeScript compilation + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/services/googleAdsService.ts backend/src/__tests__/googleAdsService.test.ts
git commit -m "feat: add Google Ads assets, asset groups, and reporting to service"
```

---

## Task 10: REST Routes

**Files:**
- Create: `backend/src/routes/googleAds.ts`
- Create: `backend/src/__tests__/googleAdsRoutes.test.ts`
- Modify: `backend/src/app.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/googleAdsRoutes.test.ts`:

```typescript
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listCampaigns: jest.fn().mockResolvedValue([
      { id: '1', name: 'Test Campaign', status: 'ENABLED', type: 'SEARCH', resourceName: 'customers/123/campaigns/1' },
    ]),
  },
}));

jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { userId: 'user-123' };
    next();
  },
}));

import request from 'supertest';
import express from 'express';
import router from '../routes/googleAds';

const app = express();
app.use(express.json());
app.use('/', router);

describe('GET /campaigns', () => {
  it('returns campaigns for a customer', async () => {
    const res = await request(app)
      .get('/campaigns?customerId=1234567890')
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.campaigns).toHaveLength(1);
    expect(res.body.campaigns[0].name).toBe('Test Campaign');
  });

  it('returns 400 if customerId is missing', async () => {
    const res = await request(app).get('/campaigns').expect(400);
    expect(res.body.error).toMatch(/customerId/i);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd backend && npx jest googleAdsRoutes --no-coverage 2>&1 | tail -10
```

- [ ] **Step 3: Create `backend/src/routes/googleAds.ts`**

```typescript
import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { googleAdsService } from '../services/googleAdsService';

const router = express.Router();
router.use(authenticateToken);

// GET /api/google-ads/campaigns?customerId=<id>
router.get('/campaigns', async (req: any, res) => {
  const { customerId } = req.query;
  if (!customerId || typeof customerId !== 'string') {
    return res.status(400).json({ error: 'customerId query parameter is required' });
  }
  try {
    const campaigns = await googleAdsService.listCampaigns(req.user.userId, customerId);
    res.json({ success: true, campaigns });
  } catch (error: any) {
    if (error.isGoogleAdsAuthError) return res.status(401).json({ error: error.message });
    console.error('[Google Ads /campaigns]', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

export default router;
```

- [ ] **Step 4: Register in `app.ts`**

Add import after `googleAdsAuthRoutes` import:
```typescript
import googleAdsRoutes from "./routes/googleAds";
```

Add registration after `app.use("/api/oauth/google-ads", googleAdsAuthRoutes);`:
```typescript
app.use("/api/google-ads", googleAdsRoutes);
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
cd backend && npx jest googleAdsRoutes --no-coverage 2>&1 | tail -10
```

- [ ] **Step 6: Verify TypeScript compilation + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/routes/googleAds.ts backend/src/__tests__/googleAdsRoutes.test.ts backend/src/app.ts
git commit -m "feat: add Google Ads REST routes and register in app.ts"
```

---

## Task 11: Agent Tools

**Files:**
- Modify: `backend/src/emma/tools.ts`
- Modify: `backend/src/services/agentModeService.ts`
- Modify: `backend/src/docs/agentModeSystemPrompt.ts`
- Create: `backend/src/__tests__/googleAdsTools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/__tests__/googleAdsTools.test.ts`:

```typescript
jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    listCampaigns: jest.fn().mockResolvedValue([{ id: '1', name: 'Test', status: 'ENABLED', type: 'SEARCH' }]),
    createBudget: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaignBudgets/1' }),
    createCampaign: jest.fn().mockResolvedValue({ resourceName: 'customers/123/campaigns/1' }),
    pauseCampaign: jest.fn().mockResolvedValue(undefined),
    resumeCampaign: jest.fn().mockResolvedValue(undefined),
    addKeywords: jest.fn().mockResolvedValue(undefined),
    queryReporting: jest.fn().mockResolvedValue([{ campaign: { id: '1' }, metrics: { clicks: '100' } }]),
    getQuickMetrics: jest.fn().mockResolvedValue({
      campaigns: [{ id: '1', name: 'Test', impressions: 5000, clicks: 200, ctr: 4.0, spendFormatted: '100.00', conversions: 5, avgCpc: '0.50' }],
      totals: { impressions: 5000, clicks: 200, spend: 100, conversions: 5 },
      currency: 'USD',
    }),
    searchLocations: jest.fn().mockResolvedValue([{ id: '2840', name: 'United States', countryCode: 'US', targetType: 'Country' }]),
    getAccountCredentials: jest.fn().mockResolvedValue({ accessToken: 'token', customerId: '123', currency: 'USD' }),
  },
}));

import { AgentModeService } from '../services/agentModeService';

let service: AgentModeService;
beforeEach(() => {
  jest.clearAllMocks();
  service = new AgentModeService();
});

describe('handleCallGoogleAdsApi', () => {
  it('handles CAMPAIGN LIST action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'LIST',
    });
    expect(result.success).toBe(true);
    expect(result.campaigns).toHaveLength(1);
  });

  it('handles CAMPAIGN PAUSE action', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'PAUSE',
      campaign_resource_name: 'customers/123/campaigns/1',
    });
    expect(result.success).toBe(true);
  });

  it('returns error for missing required params', async () => {
    const result = await service.handleCallGoogleAdsApi('user-123', {
      customer_id: '1234567890',
      entity_type: 'CAMPAIGN',
      action: 'PAUSE',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/campaign_resource_name/i);
  });
});

describe('handleCallGoogleAdsReportingApi', () => {
  it('handles dashboard mode', async () => {
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'dashboard',
    });
    expect(result.success).toBe(true);
    expect(result.formattedMarkdown).toContain('Test');
  });

  it('handles raw mode with GAQL query', async () => {
    const result = await service.handleCallGoogleAdsReportingApi('user-123', {
      customer_id: '1234567890',
      mode: 'raw',
      query: 'SELECT campaign.id FROM campaign',
    });
    expect(result.success).toBe(true);
    expect(result.results).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd backend && npx jest googleAdsTools --no-coverage 2>&1 | tail -10
```
Expected: fails with `service.handleCallGoogleAdsApi is not a function`

- [ ] **Step 3: Add handler methods to `agentModeService.ts`**

Find a logical grouping (near the Meta Ads methods) and add:

```typescript
// ── Google Ads Tool Handlers ──────────────────────────────────────────────

public async handleCallGoogleAdsApi(userId: string, args: {
  customer_id: string;
  entity_type: 'BUDGET' | 'CAMPAIGN' | 'AD_GROUP' | 'KEYWORD' | 'AD' | 'ASSET' | 'ASSET_GROUP' | 'LOCATION';
  action: string;
  [key: string]: any;
}): Promise<any> {
  try {
    const { customer_id, entity_type, action } = args;

    if (entity_type === 'CAMPAIGN') {
      if (action === 'LIST') {
        const campaigns = await googleAdsService.listCampaigns(userId, customer_id);
        return { success: true, campaigns };
      }
      if (action === 'PAUSE') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required for PAUSE action' };
        await googleAdsService.pauseCampaign(userId, customer_id, args.campaign_resource_name);
        return { success: true, message: `Campaign paused` };
      }
      if (action === 'RESUME') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required for RESUME action' };
        await googleAdsService.resumeCampaign(userId, customer_id, args.campaign_resource_name);
        return { success: true, message: `Campaign resumed` };
      }
      if (action === 'CREATE') {
        if (!args.budget_resource_name || !args.name || !args.type || !args.bidding_strategy) {
          return { success: false, error: 'name, type, budget_resource_name, bidding_strategy, and location_target_ids are required to create a campaign' };
        }
        const campaign = await googleAdsService.createCampaign(userId, customer_id, {
          name: args.name,
          type: args.type,
          budgetResourceName: args.budget_resource_name,
          biddingStrategy: args.bidding_strategy,
          biddingStrategyTarget: args.bidding_strategy_target,
          locationTargetIds: args.location_target_ids || [],
          status: args.status || 'PAUSED',
        });
        return { success: true, campaignResourceName: campaign.resourceName };
      }
    }

    if (entity_type === 'BUDGET' && action === 'CREATE') {
      if (!args.name || !args.amount_micros) return { success: false, error: 'name and amount_micros are required to create a budget' };
      const budget = await googleAdsService.createBudget(userId, customer_id, { name: args.name, amountMicros: args.amount_micros });
      return { success: true, budgetResourceName: budget.resourceName };
    }

    if (entity_type === 'KEYWORD' && action === 'ADD') {
      if (!args.ad_group_resource_name || !args.keywords) return { success: false, error: 'ad_group_resource_name and keywords array are required' };
      await googleAdsService.addKeywords(userId, customer_id, args.ad_group_resource_name, args.keywords);
      return { success: true, message: `Added ${args.keywords.length} keyword(s)` };
    }

    if (entity_type === 'LOCATION' && action === 'SEARCH') {
      if (!args.query) return { success: false, error: 'query is required for LOCATION SEARCH' };
      const locations = await googleAdsService.searchLocations(userId, customer_id, args.query, args.locale || 'en');
      return { success: true, locations };
    }

    if (entity_type === 'AD_GROUP') {
      if (action === 'LIST') {
        if (!args.campaign_resource_name) return { success: false, error: 'campaign_resource_name is required' };
        const adGroups = await googleAdsService.listAdGroups(userId, customer_id, args.campaign_resource_name);
        return { success: true, adGroups };
      }
      if (action === 'CREATE') {
        if (!args.name || !args.campaign_resource_name || !args.type) return { success: false, error: 'name, campaign_resource_name, and type are required' };
        const adGroup = await googleAdsService.createAdGroup(userId, customer_id, {
          name: args.name,
          campaignResourceName: args.campaign_resource_name,
          type: args.type,
          cpcBidMicros: args.cpc_bid_micros,
        });
        return { success: true, adGroupResourceName: adGroup.resourceName };
      }
    }

    return { success: false, error: `Unsupported entity_type=${entity_type} action=${action}` };
  } catch (error: any) {
    if (error.isGoogleAdsAuthError) return { success: false, error: error.message, authError: true };
    console.error('[AgentMode] handleCallGoogleAdsApi error:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}

public async handleCallGoogleAdsReportingApi(userId: string, args: {
  customer_id: string;
  mode: 'raw' | 'dashboard';
  query?: string;
  campaign_ids?: string[];
  date_preset?: string;
}): Promise<any> {
  try {
    if (args.mode === 'dashboard') {
      const summary = await googleAdsService.getQuickMetrics(userId, args.customer_id, {
        campaignIds: args.campaign_ids,
        datePreset: args.date_preset || 'LAST_30_DAYS',
      });
      const { campaigns, totals, currency } = summary;
      const rows = campaigns.map(c =>
        `| ${c.name} | ${c.status} | ${c.impressions.toLocaleString()} | ${c.clicks.toLocaleString()} | ${c.ctr.toFixed(2)}% | ${currency} ${c.spendFormatted} | ${c.conversions} | ${c.avgCpc} |`
      ).join('\n');
      const formattedMarkdown = `## Google Ads Performance\n\n| Campaign | Status | Impressions | Clicks | CTR | Spend | Conversions | Avg CPC |\n|---|---|---|---|---|---|---|---|\n${rows}\n\n**Totals:** ${totals.impressions.toLocaleString()} impressions · ${totals.clicks.toLocaleString()} clicks · ${currency} ${totals.spend.toFixed(2)} spend · ${totals.conversions} conversions`;
      return { success: true, formattedMarkdown, summary };
    }

    if (args.mode === 'raw') {
      if (!args.query) return { success: false, error: 'query is required for raw mode' };
      const results = await googleAdsService.queryReporting(userId, args.customer_id, args.query);
      return { success: true, results, totalRows: results.length };
    }

    return { success: false, error: 'mode must be "raw" or "dashboard"' };
  } catch (error: any) {
    if (error.isGoogleAdsAuthError) return { success: false, error: error.message, authError: true };
    console.error('[AgentMode] handleCallGoogleAdsReportingApi error:', error);
    return { success: false, error: error.message || 'Unknown error' };
  }
}
```

Also add the import for `googleAdsService` at the top of `agentModeService.ts`:
```typescript
import { googleAdsService } from './googleAdsService';
```

- [ ] **Step 4: Register tools in `backend/src/emma/tools.ts`**

Add at the end of the file, before any closing exports:

```typescript
// ── Google Ads Tools ────────────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'call_google_ads_api',
  definition: {
    name: 'call_google_ads_api',
    description: `Manage Google Ads entities via the Google Ads API.

WORKFLOW — always follow this order:
1. BUDGET → CREATE (required before campaign)
2. CAMPAIGN → CREATE (use budgetResourceName from step 1)
3. AD_GROUP → CREATE (Search + Display only; skip for PMax)
4. KEYWORD → ADD (Search only)
5. AD → CREATE (Search + Display only; for PMax use ASSET_GROUP instead)

COST UNITS: All monetary values in MICROS of the account's native currency (1,000,000 micros = 1 currency unit).
CONFIRMATION: Always present a plan to the user and get confirmation before executing any write action (CREATE, UPDATE, PAUSE, RESUME) — this spends real money.

ACTION MATRIX:
  BUDGET        → CREATE (params: name, amount_micros)
  CAMPAIGN      → LIST, CREATE, PAUSE, RESUME
  AD_GROUP      → LIST, CREATE, UPDATE  (Search + Display only)
  KEYWORD       → ADD, ADD_NEGATIVE  (Search only)
  AD            → LIST, CREATE  (Search + Display only)
  ASSET         → UPLOAD  (Display + PMax)
  ASSET_GROUP   → CREATE  (PMax only)
  LOCATION      → SEARCH  (find location_target_ids by name before campaign creation)

CAMPAIGN CREATE params: name, type (SEARCH|DISPLAY|PERFORMANCE_MAX), budget_resource_name, bidding_strategy, location_target_ids (required — use LOCATION SEARCH first), status (default PAUSED)
BIDDING STRATEGIES: MAXIMIZE_CONVERSIONS | TARGET_CPA | TARGET_ROAS | MAXIMIZE_CONVERSION_VALUE | TARGET_IMPRESSION_SHARE | MANUAL_CPC`,
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Google Ads customer ID (numeric). Use list_connected_accounts(platform="google_ads") to get this.' },
        entity_type: { type: 'string', enum: ['BUDGET', 'CAMPAIGN', 'AD_GROUP', 'KEYWORD', 'AD', 'ASSET', 'ASSET_GROUP', 'LOCATION'], description: 'Entity type to act on.' },
        action: { type: 'string', description: 'Action to perform. See ACTION MATRIX above.' },
        name: { type: 'string', description: 'Name for the entity being created.' },
        type: { type: 'string', description: 'Campaign type (SEARCH|DISPLAY|PERFORMANCE_MAX) or ad group type (SEARCH_STANDARD|DISPLAY_STANDARD).' },
        budget_resource_name: { type: 'string', description: 'Budget resource name from BUDGET CREATE. Required for CAMPAIGN CREATE.' },
        amount_micros: { type: 'number', description: 'Budget amount in micros. $10/day = 10000000.' },
        bidding_strategy: { type: 'string', description: 'Bidding strategy for campaign creation.' },
        bidding_strategy_target: { type: 'number', description: 'Target value for CPA/ROAS strategies (in micros for CPA, as a multiplier for ROAS).' },
        location_target_ids: { type: 'array', items: { type: 'number' }, description: 'Geo target constant IDs. Use LOCATION SEARCH to find IDs.' },
        campaign_resource_name: { type: 'string', description: 'Campaign resource name (e.g. customers/123/campaigns/456). Required for PAUSE/RESUME.' },
        ad_group_resource_name: { type: 'string', description: 'Ad group resource name. Required for KEYWORD ADD and AD CREATE.' },
        keywords: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, matchType: { type: 'string', enum: ['BROAD', 'PHRASE', 'EXACT'] } }, required: ['text', 'matchType'] }, description: 'Keywords to add.' },
        query: { type: 'string', description: 'Location search query (for LOCATION SEARCH action).' },
        status: { type: 'string', enum: ['ENABLED', 'PAUSED'], description: 'Entity status. Defaults to PAUSED for new campaigns.' },
      },
      required: ['customer_id', 'entity_type', 'action'],
    },
  },
  execute: async (args: any, context: any) => {
    return await agentModeService.handleCallGoogleAdsApi(context?.userId, args);
  },
});

emmaToolRegistry.register({
  name: 'call_google_ads_reporting_api',
  definition: {
    name: 'call_google_ads_reporting_api',
    description: `Fetch Google Ads performance data.

TWO MODES:
- mode="dashboard": Returns a pre-formatted markdown table with spend, impressions, clicks, CTR, conversions, avg CPC. Best for "how are my campaigns doing?" questions.
- mode="raw": Runs a custom GAQL query and returns raw results. Use for custom metrics, breakdowns, or keyword-level data.

COST DISPLAY: cost_micros from API ÷ 1,000,000 = spend in account currency (check currency field in response).

GAQL EXAMPLES:
  Campaign performance:
    SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date DURING LAST_30_DAYS

  Keyword performance:
    SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, metrics.clicks, metrics.cost_micros, metrics.average_cpc FROM keyword_view WHERE segments.date DURING LAST_30_DAYS

  Ad group performance:
    SELECT ad_group.id, ad_group.name, metrics.impressions, metrics.clicks, metrics.cost_micros FROM ad_group WHERE segments.date DURING LAST_30_DAYS`,
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Google Ads customer ID. Use list_connected_accounts(platform="google_ads").' },
        mode: { type: 'string', enum: ['raw', 'dashboard'], description: '"dashboard" for formatted markdown summary. "raw" for custom GAQL query.' },
        query: { type: 'string', description: 'GAQL query string. Required for mode="raw".' },
        campaign_ids: { type: 'array', items: { type: 'string' }, description: 'Filter dashboard to specific campaign IDs. Omit for all campaigns.' },
        date_preset: { type: 'string', enum: ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_30_DAYS', 'LAST_90_DAYS', 'THIS_MONTH', 'LAST_MONTH', 'THIS_YEAR'], description: 'Date range preset. Defaults to LAST_30_DAYS.' },
      },
      required: ['customer_id', 'mode'],
    },
  },
  execute: async (args: any, context: any) => {
    return await agentModeService.handleCallGoogleAdsReportingApi(context?.userId, args);
  },
});
```

- [ ] **Step 5: Add system prompt instructions**

In `backend/src/docs/agentModeSystemPrompt.ts`, find the Meta ads workflow instruction and add after it:

```typescript
`  - **Google Ads workflow**: Use list_connected_accounts(platform='google_ads') to get customer_id first.
    For reporting: call_google_ads_reporting_api(mode='dashboard') for quick summary, mode='raw' for custom GAQL.
    For campaign creation: BUDGET CREATE → CAMPAIGN CREATE → AD_GROUP CREATE → KEYWORD ADD / AD CREATE (Search/Display).
    For PMax: BUDGET CREATE → CAMPAIGN CREATE → ASSET_GROUP CREATE (skip AD_GROUP/KEYWORD/AD).
    Always LOCATION SEARCH before CAMPAIGN CREATE to resolve location names to IDs.
    NEVER fabricate metrics — only report what tools return.
    Cost values from API are in micros — divide by 1,000,000 for currency display.
    ALWAYS get user confirmation before any write action (create, pause, resume campaigns) — this spends real money.`,
```

- [ ] **Step 6: Run tests — expect PASS**

```bash
cd backend && npx jest googleAdsTools --no-coverage 2>&1 | tail -10
```

- [ ] **Step 7: Run full test suite + coverage check**

```bash
cd backend && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary 2>&1 | tail -30
```
Expected: ≥95% on statements, branches, functions, lines. Fix any gaps before continuing.

- [ ] **Step 8: Verify TypeScript compilation + commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/emma/tools.ts backend/src/services/agentModeService.ts backend/src/docs/agentModeSystemPrompt.ts backend/src/__tests__/googleAdsTools.test.ts
git commit -m "feat: add Google Ads agent tools (call_google_ads_api + call_google_ads_reporting_api)"
```

---

## Task 12: Settings UI

**Files:**
- Create: `customer-portal/src/components/settings/GoogleAdsAccountModal.tsx`
- Create: `customer-portal/src/__tests__/settings/GoogleAdsAccountModal.test.tsx`
- Modify: `customer-portal/src/pages/Settings.tsx`

- [ ] **Step 1: Write failing tests for the modal**

Create `customer-portal/src/__tests__/settings/GoogleAdsAccountModal.test.tsx`:

```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { GoogleAdsAccountModal } from '@/components/settings/GoogleAdsAccountModal';

const defaultProps = {
  open: true,
  onOpenChange: jest.fn(),
  adAccounts: [
    { customerId: '1234567890', name: 'Test Ad Account', currency: 'USD' },
    { customerId: '9876543210', name: 'Another Account', currency: 'EUR' },
  ],
  tokenSessionId: 'session-abc123',
  onConnect: jest.fn(),
  isLoading: false,
};

describe('GoogleAdsAccountModal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders when open', () => {
    render(<GoogleAdsAccountModal {...defaultProps} />);
    expect(screen.getByText('Connect Google Ads Account')).toBeInTheDocument();
    expect(screen.getByText('Test Ad Account')).toBeInTheDocument();
    expect(screen.getByText('Another Account')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(<GoogleAdsAccountModal {...defaultProps} open={false} />);
    expect(screen.queryByText('Connect Google Ads Account')).not.toBeInTheDocument();
  });

  it('shows account IDs and currencies', () => {
    render(<GoogleAdsAccountModal {...defaultProps} />);
    expect(screen.getByText('1234567890')).toBeInTheDocument();
    expect(screen.getByText('USD')).toBeInTheDocument();
  });

  it('calls onConnect with selected account on confirm', () => {
    render(<GoogleAdsAccountModal {...defaultProps} />);
    fireEvent.click(screen.getByText('Test Ad Account'));
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(defaultProps.onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: '1234567890' }),
      'session-abc123'
    );
  });

  it('shows loading state', () => {
    render(<GoogleAdsAccountModal {...defaultProps} isLoading={true} />);
    expect(screen.getByRole('button', { name: /connect/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd customer-portal && npx jest GoogleAdsAccountModal --no-coverage 2>&1 | tail -10
```

- [ ] **Step 3: Create `GoogleAdsAccountModal.tsx`**

Create `customer-portal/src/components/settings/GoogleAdsAccountModal.tsx`:

```typescript
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, BarChart3 } from 'lucide-react';

interface GoogleAdAccount {
  customerId: string;
  name: string;
  currency: string;
}

interface GoogleAdsAccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  adAccounts: GoogleAdAccount[];
  tokenSessionId: string;
  onConnect: (account: GoogleAdAccount, sessionId: string) => void;
  isLoading: boolean;
}

export function GoogleAdsAccountModal({
  open,
  onOpenChange,
  adAccounts,
  tokenSessionId,
  onConnect,
  isLoading,
}: GoogleAdsAccountModalProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selectedAccount = adAccounts.find(a => a.customerId === selectedId) || null;

  const handleConnect = () => {
    if (!selectedAccount) return;
    onConnect(selectedAccount, tokenSessionId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect Google Ads Account</DialogTitle>
          <DialogDescription>Select the Google Ads account you want to connect.</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2 max-h-64 overflow-y-auto">
          {adAccounts.map(account => (
            <button
              key={account.customerId}
              onClick={() => setSelectedId(account.customerId)}
              className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-colors ${
                selectedId === account.customerId
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:bg-muted'
              }`}
            >
              <BarChart3 className="h-5 w-5 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{account.name}</p>
                <p className="text-sm text-muted-foreground">{account.customerId} · {account.currency}</p>
              </div>
              {selectedId === account.customerId && (
                <span className="text-primary text-sm font-medium">Selected</span>
              )}
            </button>
          ))}
          {adAccounts.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No Google Ads accounts found.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>Cancel</Button>
          <Button onClick={handleConnect} disabled={!selectedAccount || isLoading}>
            {isLoading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Connecting...</> : 'Connect'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run modal tests — expect PASS**

```bash
cd customer-portal && npx jest GoogleAdsAccountModal --no-coverage 2>&1 | tail -10
```

- [ ] **Step 5: Add Google Ads platform card to `Settings.tsx`**

In `customer-portal/src/pages/Settings.tsx`:

**Add import** (near other modal imports):
```typescript
import { GoogleAdsAccountModal } from "@/components/settings/GoogleAdsAccountModal";
```

**Add state** (near other platform state declarations):
```typescript
const [isConnectingGoogleAds, setIsConnectingGoogleAds] = useState(false);
const [showGoogleAdsModal, setShowGoogleAdsModal] = useState(false);
const [googleAdsAccounts, setGoogleAdsAccounts] = useState<{ customerId: string; name: string; currency: string }[]>([]);
const [googleAdsSessionId, setGoogleAdsSessionId] = useState('');
```

**Add connected account filter** (near `connectedAdAccounts`):
```typescript
const connectedGoogleAdsAccounts = accounts.filter(a => a.platform === 'google_ads');
```

**Add OAuth init handler** (near `startMetaOAuth`):
```typescript
const handleGoogleAdsClick = async () => {
  if (!token) return;
  setIsConnectingGoogleAds(true);
  try {
    const authResponse = await axios.get(
      buildApiUrl('/api/oauth/google-ads/init'),
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (authResponse.data.success && authResponse.data.url) {
      const popup = openOAuthPopup(authResponse.data.url);
      if (popup) {
        const pollInterval = setInterval(() => {
          if (popup.closed) {
            clearInterval(pollInterval);
            setIsConnectingGoogleAds(false);
          }
        }, 500);
      }
    }
  } catch (error: any) {
    setIsConnectingGoogleAds(false);
    toast({ title: 'Error', description: 'Failed to start Google Ads authentication', variant: 'destructive' });
  }
};
```

**Add connect handler**:
```typescript
const handleGoogleAdsConnect = async (account: { customerId: string; name: string; currency: string }, sessionId: string) => {
  if (!token) return;
  setIsConnectingGoogleAds(true);
  try {
    await axios.post(
      buildApiUrl('/api/oauth/google-ads/connect'),
      { tokenSessionId: sessionId, customerId: account.customerId, accountName: account.name, currency: account.currency },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    setShowGoogleAdsModal(false);
    await fetchAccounts();
    toast({ title: 'Google Ads connected', description: `Connected ${account.name}` });
  } catch {
    toast({ title: 'Error', description: 'Failed to connect Google Ads account', variant: 'destructive' });
  } finally {
    setIsConnectingGoogleAds(false);
  }
};
```

**Add platform card** (after the Meta platform card block, inside the integrations grid):
```typescript
{isPlatformAllowed('google_ads') && (
  <div id="platform-card-google_ads" className={highlightCls('google_ads')}>
    <PlatformCard
      platform="google_ads"
      name="Google Ads"
      description="Launch and manage Search, Display, and Performance Max campaigns"
      icon={
        <svg className="w-10 h-10" viewBox="0 0 48 48" aria-label="Google Ads">
          <title>Google Ads</title>
          <path fill="#4285F4" d="M9 36L24 9l5.2 9L17.4 36z"/>
          <path fill="#FBBC05" d="M39 36H17.4l5.8-10h15.8z"/>
          <circle fill="#34A853" cx="9" cy="36" r="5"/>
        </svg>
      }
      isConnected={connectedGoogleAdsAccounts.length > 0}
      connectedCount={connectedGoogleAdsAccounts.length}
      isLoading={isConnectingGoogleAds}
      onClick={handleGoogleAdsClick}
    />
  </div>
)}
```

**Add modal** (at the bottom of the JSX, near other modals):
```typescript
<GoogleAdsAccountModal
  open={showGoogleAdsModal}
  onOpenChange={setShowGoogleAdsModal}
  adAccounts={googleAdsAccounts}
  tokenSessionId={googleAdsSessionId}
  onConnect={handleGoogleAdsConnect}
  isLoading={isConnectingGoogleAds}
/>
```

- [ ] **Step 6: Run customer-portal tests**

```bash
cd customer-portal && npm test -- --no-coverage 2>&1 | tail -20
```
Expected: all tests pass

- [ ] **Step 7: Run coverage check**

```bash
cd customer-portal && npm run test:coverage -- --coverageReporters=text 2>&1 | tail -15
```

- [ ] **Step 8: Verify TypeScript compilation**

```bash
cd customer-portal && npx tsc --noEmit
```

- [ ] **Step 9: Commit**

```bash
git add customer-portal/src/components/settings/GoogleAdsAccountModal.tsx \
        customer-portal/src/__tests__/settings/GoogleAdsAccountModal.test.tsx \
        customer-portal/src/pages/Settings.tsx
git commit -m "feat: add Google Ads settings UI (platform card + account selector modal)"
```

---

## Final Verification

- [ ] **Run full backend test suite with coverage**

```bash
cd backend && npm run test:coverage -- --coverageReporters=text --coverageReporters=json-summary 2>&1 | tail -20
```
Expected: ≥95% on all metrics

- [ ] **Run full customer-portal test suite**

```bash
cd customer-portal && npm test 2>&1 | tail -10
```

- [ ] **Final TypeScript compilation check (both repos)**

```bash
cd backend && npx tsc --noEmit && echo "backend OK"
cd customer-portal && npx tsc --noEmit && echo "customer-portal OK"
```

- [ ] **Final commit summary**

All commits on `harshit/google-ads-integration`. Push when ready:
```bash
git push origin harshit/google-ads-integration
git -C customer-portal push origin harshit/google-ads-integration
```
