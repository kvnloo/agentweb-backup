import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getYouTubeConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';

const router = express.Router();

const STATE_EXPIRATION = '15m';
const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ── State JWT ──────────────────────────────────────────────────────────────

interface StatePayload {
  userId: string;
  nonce: string;
}

const generateState = (userId: string): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ userId, nonce } as StatePayload, getJwtSecret(), { expiresIn: STATE_EXPIRATION });
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

// ── Token session store (server-side, one-time use) ────────────────────────

interface TokenSession {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    granted_scopes: string[];
  };
  channel: {
    id: string;
    title: string;
    thumbnail?: string;
    subscriberCount?: number;
    videoCount?: number;
  };
  profile: {
    email: string;
    name: string;
    picture?: string;
  };
  userId: string;
  expires: number;
}

const tokenSessions = new Map<string, TokenSession>();

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of tokenSessions.entries()) {
    if (now > session.expires) tokenSessions.delete(id);
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

const storeTokenSession = (
  userId: string,
  tokens: TokenSession['tokens'],
  channel: TokenSession['channel'],
  profile: TokenSession['profile']
): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, { tokens, channel, profile, userId, expires: Date.now() + TOKEN_SESSION_TTL_MS });
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): Pick<TokenSession, 'tokens' | 'channel' | 'profile'> | null => {
  const session = tokenSessions.get(sessionId);
  if (!session || session.userId !== userId || Date.now() > session.expires) {
    tokenSessions.delete(sessionId);
    return null;
  }
  tokenSessions.delete(sessionId); // one-time use
  return { tokens: session.tokens, channel: session.channel, profile: session.profile };
};

// ── GET /init — build Google authorization URL with YouTube scopes ──────

router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const config = await getYouTubeConfig();
    const state = generateState(req.user.userId);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error: any) {
    console.error('[YouTube OAuth /init]', error);
    res.status(500).json({ error: 'Failed to initialize YouTube OAuth' });
  }
});

// ── GET /callback — receive redirect from Google, forward to frontend ───

router.get('/callback', (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/youtube/callback?error=youtube_access_denied&details=${error}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/youtube/callback?error=no_code_provided`);
  }

  res.redirect(`${frontendUrl}/oauth/youtube/callback?code=${code}&state=${state}`);
});

// ── POST /finalize — exchange code for tokens, fetch channel info ───────

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
    const config = await getYouTubeConfig();

    // Exchange authorization code for tokens
    const tokenResponse = await axios.post(config.tokenUrl, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in, scope } = tokenResponse.data as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope: string;
    };

    // Validate that required YouTube scopes were granted
    const grantedScopes = (scope || '').split(' ').filter(Boolean);
    const hasYouTubeWrite = grantedScopes.some(s => s.includes('/youtube') && !s.includes('readonly'));
    const hasYouTubeRead = grantedScopes.some(s => s.includes('youtube'));
    const missingScopes = [
      ...(!hasYouTubeRead ? ['https://www.googleapis.com/auth/youtube.readonly'] : []),
      ...(!hasYouTubeWrite ? ['https://www.googleapis.com/auth/youtube'] : []),
    ];
    if (missingScopes.length > 0) {
      return res.status(422).json({
        error: 'insufficient_scopes',
        message: 'Required YouTube permissions were not granted. Please try again and allow all requested permissions.',
        missingScopes,
        grantedScopes,
      });
    }

    // Fetch user's Google profile
    const profileResponse = await axios.get(config.profileUrl, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const { email, name, picture } = profileResponse.data as {
      email: string;
      name: string;
      picture?: string;
    };

    // Fetch YouTube channel info
    const channelsResponse = await axios.get(config.channelsUrl, {
      params: { part: 'snippet,statistics', mine: true },
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const channels = (channelsResponse.data as any).items || [];
    if (channels.length === 0) {
      return res.status(422).json({
        error: 'no_channel',
        message: 'No YouTube channel found for this Google account. Please create a YouTube channel first.',
      });
    }

    const channel = channels[0];
    const channelInfo = {
      id: channel.id,
      title: channel.snippet.title,
      thumbnail: channel.snippet.thumbnails?.default?.url,
      subscriberCount: parseInt(channel.statistics?.subscriberCount || '0', 10),
      videoCount: parseInt(channel.statistics?.videoCount || '0', 10),
    };

    // Store tokens server-side (never expose to frontend)
    const tokenSessionId = storeTokenSession(
      userId,
      { access_token, refresh_token, expires_in, granted_scopes: grantedScopes },
      channelInfo,
      { email, name, picture }
    );

    res.json({
      success: true,
      channel: channelInfo,
      profile: { email, name, picture },
      grantedScopes,
      tokenSessionId,
    });
  } catch (error: any) {
    console.error('[YouTube OAuth /finalize]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize YouTube connection', ...(details && { details }) });
  }
});

// ── POST /connect — persist tokens to connected accounts ──────────────────

router.post('/connect', authenticateToken, async (req: any, res) => {
  const { tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing tokenSessionId' });
  }

  const session = retrieveTokenSession(tokenSessionId, userId);
  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const { tokens, channel, profile } = session;

    const account = await createAccount(userId, 'youtube', {
      account_id: channel.id,
      account_name: channel.title,
      config: {
        account_type: 'channel',
        channel_id: channel.id,
        channel_name: channel.title,
        picture_url: channel.thumbnail,
        subscriber_count: channel.subscriberCount,
        video_count: channel.videoCount,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: Date.now() + tokens.expires_in * 1000,
        granted_scopes: tokens.granted_scopes,
      },
    });

    res.json({ success: true, account });
  } catch (error: any) {
    console.error('[YouTube OAuth /connect]', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect YouTube account', ...(details && { details }) });
  }
});

export default router;
