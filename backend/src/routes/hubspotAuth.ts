import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getHubSpotConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';
import { storeOAuthSession, retrieveOAuthSession } from '../services/oauthTokenSessionStore';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

type HubSpotAccountType = 'crm' | 'marketing';

interface StatePayload {
  userId: string;
  nonce: string;
  accountType: HubSpotAccountType;
}

const generateState = (userId: string, accountType: HubSpotAccountType): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce, accountType } as StatePayload, getJwtSecret(), { expiresIn: STATE_EXPIRATION });
};

const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as StatePayload;
    if (decoded.userId !== userId) return null;
    return decoded;
  } catch {
    return null;
  }
};

// The pending session held between /finalize and /connect. It lives in the shared,
// DynamoDB-backed store (AW-Settings via oauthTokenSessionStore) — NOT a process-local Map —
// so /connect can land on a different Elastic Beanstalk instance than /finalize without the
// user seeing "Please reconnect" (the cross-instance bug ALB stickiness was masking). ENG-162.
interface HubSpotSessionData {
  tokens: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  hubInfo: {
    hub_id: number;
    hub_domain: string;
    user: string;
  };
  accountType: HubSpotAccountType;
  grantedScopes: string[];
}

// GET /init
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const accountType: HubSpotAccountType = req.query.accountType === 'marketing' ? 'marketing' : 'crm';
    const config = await getHubSpotConfig();
    const state = generateState(req.user.userId, accountType);

    // `scope` must only ever contain the base CRM scopes — every scope listed
    // here is registered as "Required" on the HubSpot app, so anything placed
    // in `scope` blocks the auth flow for accounts without that entitlement
    // (e.g. a CRM-only portal choking on marketing.campaigns.*). Marketing-only
    // scopes go through `optional_scope` instead: requested opportunistically
    // for accountType=marketing, granted only if the portal actually has
    // Marketing Hub, and never sent at all for accountType=crm.
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
    });
    if (accountType === 'marketing') {
      params.set('optional_scope', config.marketingOnlyScopes.join(' '));
    }

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[HubSpot OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize HubSpot OAuth' });
  }
});

// GET /callback — HubSpot redirects here after user authorizes
router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/hubspot/callback?error=hubspot_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/hubspot/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/hubspot/callback?code=${code}&state=${state}`);
});

// POST /finalize
router.post('/finalize', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  }
  if (!state || typeof state !== 'string' || state.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing state parameter' });
  }

  const statePayload = verifyState(state, userId);
  if (!statePayload) {
    return res.status(403).json({ error: 'Invalid or expired state parameter. CSRF protection.' });
  }

  try {
    const config = await getHubSpotConfig();

    // Exchange authorization code for tokens
    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Fetch HubSpot portal info + granted scopes using the access token
    const tokenInfoResponse = await axios.get(`${config.tokenInfoUrl}/${access_token}`);
    const { hub_id, hub_domain, user, scopes: rawGrantedScopes } = tokenInfoResponse.data as {
      hub_id: number;
      hub_domain: string;
      user: string;
      scopes: string | string[] | undefined;
    };

    const accountType = statePayload.accountType ?? 'crm';
    const requestedScopes = accountType === 'marketing' ? config.marketingScopes : config.scopes;
    const grantedScopes: string[] = Array.isArray(rawGrantedScopes)
      ? rawGrantedScopes
      : typeof rawGrantedScopes === 'string'
        ? rawGrantedScopes.split(/[\s,]+/).filter(Boolean)
        : [];
    const missingScopes = requestedScopes.filter(s => !grantedScopes.includes(s));

    const tokenSessionId = await storeOAuthSession<HubSpotSessionData>(userId, 'hubspot', {
      tokens: { access_token, refresh_token, expires_in },
      hubInfo: { hub_id, hub_domain, user },
      accountType,
      grantedScopes,
    });

    res.json({ success: true, tokenSessionId, missingScopes });
  } catch (error: any) {
    console.error('[HubSpot OAuth /finalize]', error?.response?.data || error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize HubSpot connection', ...(details && { details }) });
  }
});

// POST /connect
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  try {
    const session = await retrieveOAuthSession<HubSpotSessionData>(tokenSessionId, userId, 'hubspot');
    if (!session) {
      return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
    }

    const { tokens, hubInfo, accountType, grantedScopes } = session;

    const account = await createAccount(userId, 'hubspot', {
      account_id: String(hubInfo.hub_id),
      account_name: hubInfo.hub_domain || `HubSpot Portal ${hubInfo.hub_id}`,
      config: {
        account_type: 'oauth',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + (tokens.expires_in * 1000),
        hub_id: hubInfo.hub_id,
        hub_domain: hubInfo.hub_domain,
        hubspot_account_type: accountType,
        granted_scopes: grantedScopes,
      },
    });

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[HubSpot OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect HubSpot account', ...(details && { details }) });
  }
});

export default router;
