import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getInstagramConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { instagramService } from '../services/instagramService';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// ============================================
// Constants
// ============================================
const STATE_EXPIRATION = '15m';
const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const STATE_SECRET = process.env.JWT_SECRET;
if (!STATE_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set for OAuth state verification');
}

// ============================================
// State Management (CSRF protection)
// ============================================

interface StatePayload {
  userId: string;
  nonce: string;
}

const generateState = (userId: string): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload: StatePayload = { userId, nonce };
  return jwt.sign(payload, STATE_SECRET, { expiresIn: STATE_EXPIRATION });
};

const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, STATE_SECRET) as StatePayload;
    if (decoded.userId !== userId) return null;
    return decoded;
  } catch (error) {
    console.error('[Instagram OAuth] State verification failed:', error);
    return null;
  }
};

// ============================================
// Token Session Store (Secure server-side storage)
// ============================================

interface InstagramAccount {
  instagram_account_id: string;
  username: string;
  name: string;
  profile_picture_url?: string;
  followers_count: number;
  media_count: number;
  account_type: 'business' | 'creator';
  facebook_page_id: string;
  facebook_page_name: string;
  facebook_page_access_token: string;
}

interface TokenSession {
  userAccessToken: string;
  accounts: InstagramAccount[];
  userId: string;
  scopes: string[];
  tokenExpiresIn: number;
  expires: number;
}

const tokenSessions = new Map<string, TokenSession>();

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of tokenSessions.entries()) {
    if (now > session.expires) {
      tokenSessions.delete(sessionId);
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS);

const storeTokenSession = (userId: string, data: Omit<TokenSession, 'userId' | 'expires'>): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, {
    ...data,
    userId,
    expires: Date.now() + TOKEN_SESSION_TTL_MS,
  });
  console.log(`[Instagram TokenSession] Stored session ${sessionId.substring(0, 8)}... for user ${userId}`);
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): TokenSession | null => {
  const session = tokenSessions.get(sessionId);
  if (!session) {
    console.warn(`[Instagram TokenSession] Session ${sessionId.substring(0, 8)}... not found`);
    return null;
  }
  if (session.userId !== userId) {
    console.warn(`[Instagram TokenSession] Session ${sessionId.substring(0, 8)}... userId mismatch`);
    return null;
  }
  if (Date.now() > session.expires) {
    console.warn(`[Instagram TokenSession] Session ${sessionId.substring(0, 8)}... expired`);
    tokenSessions.delete(sessionId);
    return null;
  }
  // One-time use: delete after retrieval
  tokenSessions.delete(sessionId);
  console.log(`[Instagram TokenSession] Retrieved and deleted session ${sessionId.substring(0, 8)}...`);
  return session;
};

// ============================================
// Routes
// ============================================

// Initialize Instagram OAuth (via Facebook Login)
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    const config = await getInstagramConfig();

    const state = generateState(userId);

    console.log(`[Instagram Init] appId: ${config.appId}, configId: ${config.configId}, redirectUri: ${config.redirectUri}`);

    const params = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: config.redirectUri,
      state: state,
      config_id: config.configId,
      response_type: 'code',
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;

    res.json({ success: true, url });
  } catch (error) {
    console.error('Error initializing Instagram OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize Instagram OAuth' });
  }
});

// Instagram OAuth Callback (redirect from Facebook)
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/instagram/callback?error=instagram_access_denied&details=${error}`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/instagram/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/instagram/callback?code=${code}&state=${state}`);
});

// Finalize Instagram OAuth
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
    const config = await getInstagramConfig();

    console.log('[Instagram Finalize] Exchanging code for tokens...');

    // Step 1: Exchange code for short-lived user access token
    const tokenResponse = await axios.get(config.tokenUrl, {
      params: {
        client_id: config.appId,
        client_secret: config.appSecret,
        redirect_uri: config.redirectUri,
        code: code,
      },
    });

    const tokenData = tokenResponse.data as any;
    const shortLivedToken = tokenData.access_token;

    // Step 2: Exchange for long-lived token (60 days)
    console.log('[Instagram Finalize] Exchanging for long-lived token...');
    const longLivedData = await instagramService.exchangeForLongLivedToken(
      shortLivedToken,
      config.appId,
      config.appSecret
    );

    const userAccessToken = longLivedData.access_token;
    const tokenExpiresIn = longLivedData.expires_in;

    // Step 3: Discover Facebook Pages
    console.log('[Instagram Finalize] Discovering Facebook Pages...');
    const pages = await instagramService.getPages(userAccessToken);

    if (!pages || pages.length === 0) {
      return res.status(400).json({
        error: 'No Facebook Pages found. Instagram Business/Creator accounts must be linked to a Facebook Page.',
      });
    }

    // Step 4: Find Instagram accounts for each Page
    console.log(`[Instagram Finalize] Checking ${pages.length} pages for Instagram accounts...`);
    const instagramAccounts: InstagramAccount[] = [];

    for (const page of pages) {
      try {
        const igAccount = await instagramService.getInstagramAccountForPage(page.id, page.access_token);
        if (igAccount) {
          // Fetch Instagram profile details
          const profile = await instagramService.getProfile(igAccount.id, page.access_token);
          instagramAccounts.push({
            instagram_account_id: igAccount.id,
            username: profile.username,
            name: profile.name,
            profile_picture_url: profile.profile_picture_url,
            followers_count: profile.followers_count,
            media_count: profile.media_count,
            account_type: 'business', // Meta Graph API returns business/creator accounts
            facebook_page_id: page.id,
            facebook_page_name: page.name,
            facebook_page_access_token: page.access_token,
          });
        }
      } catch (err: any) {
        console.warn(`[Instagram Finalize] Failed to check page ${page.name} (${page.id}):`, err.message);
      }
    }

    if (instagramAccounts.length === 0) {
      return res.status(400).json({
        error: 'No Instagram Business or Creator accounts found linked to your Facebook Pages. Please connect an Instagram account to one of your Facebook Pages first.',
      });
    }

    // Store tokens server-side
    const tokenSessionId = storeTokenSession(userId, {
      userAccessToken,
      accounts: instagramAccounts,
      scopes: config.scopes,
      tokenExpiresIn,
    });

    res.json({
      success: true,
      accounts: instagramAccounts.map(acc => ({
        instagram_account_id: acc.instagram_account_id,
        username: acc.username,
        name: acc.name,
        profile_picture_url: acc.profile_picture_url,
        followers_count: acc.followers_count,
        media_count: acc.media_count,
        facebook_page_name: acc.facebook_page_name,
      })),
      tokenSessionId,
    });
  } catch (error: any) {
    console.error('[Instagram Finalize] Error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize Instagram connection', ...(details && { details }) });
  }
});

// Connect selected Instagram accounts
router.post('/connect-accounts', authenticateToken, async (req: any, res) => {
  const { selectedAccountIds, tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!selectedAccountIds || !Array.isArray(selectedAccountIds) || selectedAccountIds.length === 0) {
    return res.status(400).json({ error: 'No accounts selected' });
  }

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing token session ID' });
  }

  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const connectedAccounts = [];

    for (const igAccountId of selectedAccountIds) {
      const accountData = session.accounts.find(a => a.instagram_account_id === igAccountId);
      if (!accountData) {
        console.warn(`[Instagram Connect] Account ${igAccountId} not found in session`);
        continue;
      }

      const accountInput = {
        account_id: accountData.instagram_account_id,
        account_name: accountData.name || accountData.username,
        config: {
          account_type: accountData.account_type as 'business' | 'creator',
          instagram_account_id: accountData.instagram_account_id,
          facebook_page_id: accountData.facebook_page_id,
          facebook_page_access_token: accountData.facebook_page_access_token,
          username: accountData.username,
          profile_picture_url: accountData.profile_picture_url,
          followers_count: accountData.followers_count,
          access_token: session.userAccessToken,
          token_expires_at: Date.now() + (session.tokenExpiresIn * 1000),
          scopes: session.scopes,
        },
      };

      const account = await createAccount(userId, 'instagram', accountInput);
      connectedAccounts.push(account);
    }

    res.json({ success: true, accounts: connectedAccounts });
  } catch (error: any) {
    console.error('[Instagram Connect Accounts] Error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect accounts', ...(details && { details }) });
  }
});

// ============================================
// Facebook Webhook Verification & Events
// ============================================

// Facebook sends a GET request to verify the webhook callback URL.
// The verify token is stored in AWS Secrets Manager alongside the Instagram app credentials.
router.get('/webhook', async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode !== 'subscribe') {
    return res.status(403).send('Forbidden');
  }

  try {
    const config = await getInstagramConfig();
    const expectedToken = config.webhookVerifyToken;

    if (!expectedToken) {
      console.error('[Instagram Webhook] No webhookVerifyToken found in secrets');
      return res.status(500).send('Server misconfigured');
    }

    if (token === expectedToken) {
      console.log('[Instagram Webhook] Verification successful');
      return res.status(200).send(challenge);
    }

    console.warn('[Instagram Webhook] Verification failed - token mismatch');
    res.status(403).send('Forbidden');
  } catch (error) {
    console.error('[Instagram Webhook] Error fetching verify token:', error);
    res.status(500).send('Internal error');
  }
});

// Facebook sends POST requests for actual webhook events
router.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object === 'instagram') {
    console.log('[Instagram Webhook] Received event:', JSON.stringify(body, null, 2));

    // Process each entry
    for (const entry of body.entry || []) {
      // Handle various webhook fields (messaging, comments, etc.)
      if (entry.messaging) {
        for (const event of entry.messaging) {
          console.log('[Instagram Webhook] Messaging event:', event);
        }
      }
      if (entry.changes) {
        for (const change of entry.changes) {
          console.log('[Instagram Webhook] Change event:', change.field, change.value);
        }
      }
    }

    // Must respond 200 quickly or Facebook will retry
    return res.status(200).send('EVENT_RECEIVED');
  }

  // Not an Instagram event
  console.warn('[Instagram Webhook] Unknown object type:', body.object);
  res.status(404).send('Not Found');
});

export default router;
