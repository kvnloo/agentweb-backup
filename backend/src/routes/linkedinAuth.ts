import express, { Request } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import jwksClient from 'jwks-rsa';
import { getLinkedInConfig, getLinkedInOrgConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { linkedInService } from '../services/linkedInService';
import { authenticateToken } from '../middleware/auth';

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

// JWT Secret for signing the state parameter
// REQUIRED: Must be set in environment variables
const STATE_SECRET = process.env.JWT_SECRET;
if (!STATE_SECRET) {
  throw new Error('JWT_SECRET environment variable must be set for OAuth state verification');
}

// ============================================
// LinkedIn JWKS Client for id_token verification (Fix #1)
// ============================================
const linkedInJwksClient = jwksClient({
  jwksUri: 'https://www.linkedin.com/oauth/openid/jwks',
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

const getLinkedInSigningKey = (header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void => {
  if (!header.kid) {
    callback(new Error('No kid in token header'));
    return;
  }
  linkedInJwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
};

// Verify LinkedIn id_token with JWKS
const verifyLinkedInIdToken = async (idToken: string): Promise<{ sub: string; name?: string; email?: string; picture?: string } | null> => {
  return new Promise((resolve) => {
    jwt.verify(idToken, getLinkedInSigningKey, { algorithms: ['RS256'] }, (err, decoded) => {
      if (err) {
        console.warn('[OAuth] LinkedIn id_token verification failed:', err.message);
        resolve(null);
      } else {
        resolve(decoded as { sub: string; name?: string; email?: string; picture?: string });
      }
    });
  });
};

interface StatePayload {
  userId: string;
  nonce: string;
  type: 'personal' | 'organization';
}

// Helper to generate signed state with cryptographically secure nonce
const generateState = (userId: string, type: 'personal' | 'organization'): string => {
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload: StatePayload = { userId, nonce, type };
  return jwt.sign(payload, STATE_SECRET, { expiresIn: STATE_EXPIRATION });
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

// Helper to verify state
const verifyState = (state: string, userId: string): boolean => {
  try {
    const decoded = jwt.verify(state, STATE_SECRET) as StatePayload;
    return decoded.userId === userId;
  } catch (error) {
    console.error('[OAuth] State verification failed:', error);
    return false;
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
// LinkedIn Personal Profile OAuth
// ============================================

// LinkedIn Personal OAuth Init
// Returns the authorization URL to the frontend
router.get('/init', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    const config = await getLinkedInConfig();
    
    // Generate signed state
    const state = generateState(userId, 'personal');
    
    // Build URL using helper
    const url = buildOAuthUrl(config, state);
    res.json({ success: true, url });
    
  } catch (error) {
    console.error('Error initializing LinkedIn OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn OAuth' });
  }
});

// LinkedIn Personal OAuth Callback
// This route is hit by LinkedIn. It renders the popup closer or redirects to frontend.
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=linkedin_access_denied&details=${error}`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=no_code_provided`);
  }

  // Pass the state back to the frontend so it can be sent to /connect
  res.redirect(`${frontendUrl}/oauth/linkedin/callback?linkedin_code=${code}&state=${state}`);
});

// Finalize LinkedIn Personal Connection
router.post('/connect', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  // Input validation
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  }
  if (!state || typeof state !== 'string' || state.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing state parameter' });
  }

  // Security Check: Verify State
  if (!verifyState(state, userId)) {
    return res.status(403).json({ error: 'Invalid or expired state parameter. CSRF protection.' });
  }

  try {
    const config = await getLinkedInConfig();
    
    console.log('[LinkedIn Connect] Exchanging code for tokens...');
    
    // Exchange code
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

    const { access_token, refresh_token, expires_in, id_token } = tokenResponse.data as { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };
    
    // Try to extract profile from id_token first
    let profile: { sub: string; name: string; email?: string; picture?: string } = { 
      sub: `linkedin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: 'LinkedIn User' 
    };
    
    // Verify and extract from id_token using JWKS
    if (id_token) {
      const verifiedPayload = await verifyLinkedInIdToken(id_token);
      if (verifiedPayload) {
        if (verifiedPayload.sub) profile.sub = verifiedPayload.sub;
        if (verifiedPayload.name) profile.name = verifiedPayload.name;
        if (verifiedPayload.email) profile.email = verifiedPayload.email;
        if (verifiedPayload.picture) profile.picture = verifiedPayload.picture;
      }
    }
    
    // Method 2: If id_token didn't have info, try the API call
    if (profile.sub.startsWith('linkedin_')) {
      try {
        const apiProfile = await linkedInService.getProfile(access_token);
        profile.sub = apiProfile.sub;
        profile.name = apiProfile.name;
        if (apiProfile.email) profile.email = apiProfile.email;
        if (apiProfile.picture) profile.picture = apiProfile.picture;
      } catch (profileError: any) {
        console.warn('[LinkedIn Connect] Profile API failed, using fallback.', profileError.message);
      }
    }

    // Ensure URN format for account_id
    let accountId = profile.sub;
    if (!accountId.startsWith('urn:')) {
      accountId = `urn:li:person:${accountId}`;
    }

    // Save to DB
    const accountInput = {
      account_id: accountId,
      account_name: profile.name,
      config: {
        account_type: 'personal' as const,
        profile_id: accountId,
        profile_image_url: profile.picture,
        access_token,
        refresh_token,
        token_expires_at: Date.now() + (expires_in * 1000),
        scopes: config.scopes
      }
    };

    const account = await createAccount(userId, 'linkedin', accountInput);

    res.json({ success: true, account });

  } catch (error: any) {
    console.error('Connect Error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect account', ...(details && { details }) });
  }
});

// ============================================
// LinkedIn Organization/Company Pages OAuth
// ============================================

// LinkedIn Organization OAuth Init
router.get('/org/init', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    const config = await getLinkedInOrgConfig();
    
    const state = generateState(userId, 'organization');
    
    // Build URL using helper
    const url = buildOAuthUrl(config, state);
    res.json({ success: true, url });
  } catch (error) {
    console.error('Error initializing LinkedIn Org OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn Organization OAuth' });
  }
});

// LinkedIn Organization OAuth Callback
router.get('/org/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=linkedin_org_access_denied&details=${error}`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=no_code_provided`);
  }

  // Redirect with org-specific code parameter AND state
  res.redirect(`${frontendUrl}/oauth/linkedin/callback?linkedin_org_code=${code}&state=${state}`);
});

// Get user's admin organizations (after org OAuth)
router.post('/organizations', authenticateToken, async (req: any, res) => {
  const { code, state } = req.body;
  const userId = req.user.userId;

  // Input validation
  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing OAuth code' });
  }
  if (!state || typeof state !== 'string' || state.trim() === '') {
    return res.status(400).json({ error: 'Invalid or missing state parameter' });
  }

  // Security Check: Verify State
  if (!verifyState(state, userId)) {
    return res.status(403).json({ error: 'Invalid or expired state parameter. CSRF protection.' });
  }

  try {
    const config = await getLinkedInOrgConfig();

    
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
      },
      timeout: 15000 // 15 second timeout
    });


    const { access_token, refresh_token, expires_in } = tokenResponse.data as { access_token: string; refresh_token?: string; expires_in: number };
    
    // Get organizations where user is admin
    const aclResponse = await linkedInService.getAdminOrganizations(access_token);

    
    // Filter out any undefined or invalid organization targets
    // Note: LinkedIn API returns 'organization' field, not 'organizationTarget'
    const orgUrns = aclResponse.elements
      .map(acl => (acl as any).organization || acl.organizationTarget)
      .filter((urn): urn is string => urn != null && typeof urn === 'string' && urn.length > 0);
    

    
    // Get details for each organization
    const organizations = await Promise.all(
      orgUrns.map(async (orgUrn: string) => {
        try {
          const orgDetails = await linkedInService.getOrganization(access_token, orgUrn);
          const followerCount = await linkedInService.getOrganizationFollowerCount(access_token, orgUrn);
          return {
            urn: orgUrn,
            id: orgDetails.id,
            name: orgDetails.name,
            vanityName: orgDetails.vanityName,
            logoUrl: orgDetails.logoUrl,
            followerCount,
          };
        } catch (err) {
          console.warn(`Failed to get details for org ${orgUrn}:`, err);
          return {
            urn: orgUrn,
            id: orgUrn.replace('urn:li:organization:', ''),
            name: `Organization ${orgUrn.replace('urn:li:organization:', '')}`,
            followerCount: 0,
          };
        }
      })
    );

    // Store tokens server-side and return session ID (not tokens)
    const tokenSessionId = storeTokenSession(userId, {
      access_token,
      refresh_token,
      expires_in,
      scopes: config.scopes
    });

    res.json({
      success: true,
      organizations,
      tokenSessionId
    });

  } catch (error: any) {
    console.error('Get Organizations Error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to get organizations', ...(details && { details }) });
  }
});

router.post('/connect-pages', authenticateToken, async (req: any, res) => {
  const { organizations, tokenSessionId } = req.body;
  const userId = req.user.userId;

  if (!organizations || !Array.isArray(organizations) || organizations.length === 0) {
    return res.status(400).json({ error: 'No organizations selected' });
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
    const config = await getLinkedInOrgConfig();
    const connectedAccounts = [];

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

    res.json({ success: true, accounts: connectedAccounts });

  } catch (error: any) {
    console.error('Connect Pages Error:', error);
    const details = IS_PRODUCTION ? undefined : error.message;
    res.status(500).json({ error: 'Failed to connect pages', ...(details && { details }) });
  }
});

export default router;
