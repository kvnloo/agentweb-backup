import express, { Request } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getLinkedInConfig, getLinkedInScopesForType, LinkedInAccountType } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { linkedInService } from '../services/linkedInService';
import { authenticateToken } from '../middleware/auth';
import { getJwtSecret } from '../config/jwt';

const router = express.Router();

// ============================================
// Type Definitions (Fix #8)
// ============================================
interface AuthenticatedRequest extends Request {
  user: { userId: string; email: string };
}

// ============================================
// Constants (Fix #9)
// ============================================
const STATE_EXPIRATION = '15m';
const TOKEN_SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

interface StatePayload {
  userId: string;
  nonce: string;
  accountType?: LinkedInAccountType;
}

// Helper to generate signed state with cryptographically secure nonce
const generateState = (userId: string, accountType?: LinkedInAccountType): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload: StatePayload = { userId, nonce, accountType };
  return jwt.sign(payload, getJwtSecret(), { expiresIn: STATE_EXPIRATION });
};

// ============================================
// OAuth URL Builder Helper (Fix #13 - DRY)
// ============================================
const buildOAuthUrl = (config: { authorizationUrl: string; clientId?: string; redirectUri: string; scopes: string[] }, state: string): string => {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId || '',
    redirect_uri: config.redirectUri,
    state: state,
    scope: config.scopes.join(' ')
  });
  return `${config.authorizationUrl}?${params.toString()}`;
};

// Helper to verify state and extract payload
const verifyState = (state: string, userId: string): StatePayload | null => {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as StatePayload;
    if (decoded.userId !== userId) return null;
    return decoded;
  } catch (error) {
    console.error('[OAuth] State verification failed:', error);
    return null;
  }
};

// ============================================
// Token Session Store (Secure server-side storage)
// ============================================
// Stores tokens server-side with a secure session ID to avoid
// passing sensitive tokens via postMessage in the browser.

interface TokenSession {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scopes: string[];
  };
  userId: string;
  expires: number;
}

const tokenSessions = new Map<string, TokenSession>();
// Using TOKEN_SESSION_TTL_MS from constants above

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of tokenSessions.entries()) {
    if (now > session.expires) {
      tokenSessions.delete(sessionId);
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS);

const storeTokenSession = (userId: string, tokens: TokenSession['tokens']): string => {
  const sessionId = crypto.randomBytes(32).toString('hex');
  tokenSessions.set(sessionId, {
    tokens,
    userId,
    expires: Date.now() + TOKEN_SESSION_TTL_MS
  });
  console.log(`[TokenSession] Stored session ${sessionId.substring(0, 8)}... for user ${userId}`);
  return sessionId;
};

const retrieveTokenSession = (sessionId: string, userId: string): TokenSession['tokens'] | null => {
  const session = tokenSessions.get(sessionId);
  if (!session) {
    console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... not found`);
    return null;
  }
  if (session.userId !== userId) {
    console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... userId mismatch`);
    return null;
  }
  if (Date.now() > session.expires) {
    console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... expired`);
    tokenSessions.delete(sessionId);
    return null;
  }
  // One-time use: delete after retrieval
  tokenSessions.delete(sessionId);
  console.log(`[TokenSession] Retrieved and deleted session ${sessionId.substring(0, 8)}...`);
  return session.tokens;
};

// ============================================
// LinkedIn Type-Specific OAuth (Personal or Company)
// ============================================

// LinkedIn OAuth Init
// Accepts optional 'type' query param: 'personal' or 'company'
// Returns authorization URL with type-specific scopes
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    const accountType = req.query.type as LinkedInAccountType | undefined;
    
    const config = await getLinkedInConfig();
    
    // Use type-specific scopes if type is provided
    let scopes = config.scopes;
    if (accountType && (accountType === 'personal' || accountType === 'company')) {
      scopes = getLinkedInScopesForType(accountType);
    }

    // Generate signed state with account type
    const state = generateState(userId, accountType);

    // Build URL with appropriate scopes
    const url = buildOAuthUrl({ ...config, scopes }, state);
    
    res.json({ success: true, url, accountType: accountType || 'unified' });

  } catch (error) {
    console.error('Error initializing LinkedIn OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn OAuth' });
  }
});

// LinkedIn OAuth Callback
// This route is hit by LinkedIn after authorization
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=linkedin_access_denied&details=${error}`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=no_code_provided`);
  }

  // Pass code and state to frontend for finalization
  res.redirect(`${frontendUrl}/oauth/linkedin/callback?code=${code}&state=${state}`);
});

// Finalize LinkedIn OAuth - Exchange code for token and fetch available accounts
router.post('/finalize', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  // Input validation
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  }
  if (!state || typeof state !== 'string' || state.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing state parameter' });
  }

  // Security Check: Verify State and extract payload
  const statePayload = verifyState(state, userId);
  if (!statePayload) {
    return res.status(403).json({ error: 'Invalid or expired state parameter. CSRF protection.' });
  }
  
  const accountType = statePayload.accountType;
  console.log(`[LinkedIn Finalize] Account type from state: ${accountType || 'unified'}`);

  try {
    const config = await getLinkedInConfig();

    console.log('[LinkedIn Finalize] Exchanging code for tokens...');

    // Exchange code for access token
    const tokenResponse = await axios.post(config.tokenUrl, null, {
      params: {
        grant_type: 'authorization_code',
        code: code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri
      },
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data as { access_token: string; refresh_token?: string; expires_in: number };

    // Get the scopes used for this OAuth flow
    const scopesUsed = accountType ? getLinkedInScopesForType(accountType) : config.scopes;

    // Fetch personal profile (for personal type or unified)
    let profile: { sub: string; name: string; email?: string; picture?: string } | null = null;
    
    if (accountType !== 'company') {
      profile = {
        sub: `linkedin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: 'LinkedIn User'
      };
      console.log('[LinkedIn Finalize] Fetching personal profile...');

      const maxRetries = 2;
      let lastError: any;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const apiProfile = await linkedInService.getProfile(access_token);
          profile.sub = apiProfile.sub;
          profile.name = apiProfile.name;
          if (apiProfile.email) profile.email = apiProfile.email;

          // Fetch profile picture separately (with retry)
          for (let picAttempt = 1; picAttempt <= maxRetries; picAttempt++) {
            try {
              const pictureUrl = await linkedInService.getProfilePicture(access_token);
              if (pictureUrl) profile.picture = pictureUrl;
              break;
            } catch (pictureError: any) {
              console.warn(`[LinkedIn Finalize] Picture fetch attempt ${picAttempt}/${maxRetries} failed:`, pictureError.message);
              if (picAttempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * picAttempt));
              }
            }
          }
          
          break;
        } catch (profileError: any) {
          lastError = profileError;
          console.warn(`[LinkedIn Finalize] Profile fetch attempt ${attempt}/${maxRetries} failed:`, profileError.message);
          
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      
      // If all retries failed for personal type, throw error
      if (accountType === 'personal' && profile.sub.startsWith('linkedin_') && lastError) {
        throw new Error(`Failed to fetch LinkedIn profile after ${maxRetries} attempts: ${lastError.message}`);
      }
    }

    // Ensure URN format for profile
    let profileUrn: string | null = null;
    if (profile) {
      profileUrn = profile.sub;
      if (!profileUrn.startsWith('urn:')) {
        profileUrn = `urn:li:person:${profileUrn}`;
      }
    }

    // Fetch organizations (for company type or unified)
    let organizations: any[] = [];
    if (accountType !== 'personal') {
      try {
        organizations = await linkedInService.getAdminOrganizationDetails(access_token);
      } catch (error: any) {
        console.warn('[LinkedIn Finalize] Failed to fetch organizations:', error.message);
        // For company type, this is an error; for unified, we continue
        if (accountType === 'company') {
          throw new Error(`Failed to fetch organizations: ${error.message}`);
        }
      }
    }

    // Store tokens server-side and return session ID
    const tokenSessionId = storeTokenSession(userId, {
      access_token,
      refresh_token,
      expires_in,
      scopes: scopesUsed
    });

    res.json({
      success: true,
      accountType: accountType || 'unified',
      profile: profile ? {
        urn: profileUrn,
        name: profile.name,
        email: profile.email,
        picture: profile.picture
      } : null,
      organizations,
      tokenSessionId
    });

  } catch (error: any) {
    console.error('[LinkedIn Finalize] Error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to finalize LinkedIn connection', ...(details && { details }) });
  }
});

// Connect selected LinkedIn accounts (personal and/or organizations)
router.post('/connect-accounts', authenticateToken, async (req: any, res) => {
  const { personal, organizations, profile, tokenSessionId } = req.body;
  const userId = req.user.userId;

  // Validate at least one account is selected
  if (!personal && (!organizations || !Array.isArray(organizations) || organizations.length === 0)) {
    return res.status(400).json({ error: 'No accounts selected' });
  }

  if (!tokenSessionId) {
    return res.status(400).json({ error: 'Missing token session ID' });
  }

  // Retrieve tokens from secure server-side session
  const tokens = retrieveTokenSession(tokenSessionId, userId);
  if (!tokens) {
    return res.status(401).json({ error: 'Invalid or expired token session. Please reconnect.' });
  }

  try {
    const config = await getLinkedInConfig();
    const connectedAccounts = [];

    // Connect personal account if selected
    if (personal && profile) {
      const accountInput = {
        account_id: profile.urn,
        account_name: profile.name,
        config: {
          account_type: 'personal' as const,
          profile_id: profile.urn,
          profile_image_url: profile.picture,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: Date.now() + (tokens.expires_in * 1000),
          scopes: config.scopes
        }
      };

      const account = await createAccount(userId, 'linkedin', accountInput);
      connectedAccounts.push(account);
    }

    // Connect selected organizations
    if (organizations && Array.isArray(organizations)) {
      for (const org of organizations) {
        const accountInput = {
          account_id: org.urn,
          account_name: org.name,
          config: {
            account_type: 'company_page' as const,
            page_id: org.id,
            organization_id: org.urn,
            profile_image_url: org.logoUrl,
            follower_count: org.followerCount,
            account_handle: org.vanityName,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            token_expires_at: Date.now() + (tokens.expires_in * 1000),
            scopes: config.scopes
          }
        };

        const account = await createAccount(userId, 'linkedin', accountInput);
        connectedAccounts.push(account);
      }
    }

    res.json({ success: true, accounts: connectedAccounts });

  } catch (error: any) {
    console.error('[LinkedIn Connect Accounts] Error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect accounts', ...(details && { details }) });
  }
});

export default router;
