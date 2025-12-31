import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { getLinkedInConfig, getLinkedInOrgConfig } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { linkedInService } from '../services/linkedInService';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// JWT Secret for signing the state parameter
// Use a dedicated secret or fall back to the main JWT secret
const STATE_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

interface StatePayload {
  userId: string;
  nonce: string;
  type: 'personal' | 'organization';
}

// Helper to generate signed state
const generateState = (userId: string, type: 'personal' | 'organization'): string => {
  const nonce = Math.random().toString(36).substring(7);
  const payload: StatePayload = { userId, nonce, type };
  // Short expiration (e.g., 15 minutes) to prevent replay
  return jwt.sign(payload, STATE_SECRET, { expiresIn: '15m' });
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
    
    // Construct URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId || '',
      redirect_uri: config.redirectUri,
      state: state,
      scope: config.scopes.join(' ')
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
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
  const frontendUrl = process.env.VITE_CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

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

  // Security Check: Verify State
  if (!state || !verifyState(state, userId)) {
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

    const { access_token, refresh_token, expires_in, id_token } = tokenResponse.data;
    
    // Try to extract profile from id_token first
    let profile: { sub: string; name: string; email?: string; picture?: string } = { 
      sub: `linkedin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: 'LinkedIn User' 
    };
    
    // Method 1: Extract from id_token JWT
    if (id_token) {
      try {
        const tokenParts = id_token.split('.');
        if (tokenParts.length === 3) {
          const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
          if (payload.sub) profile.sub = payload.sub;
          if (payload.name) profile.name = payload.name;
          if (payload.email) profile.email = payload.email;
          if (payload.picture) profile.picture = payload.picture;
        }
      } catch (jwtError) {
        console.warn('[LinkedIn Connect] Failed to decode id_token:', jwtError);
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
    res.status(500).json({ error: 'Failed to connect account', details: error.message });
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
    
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId || '',
      redirect_uri: config.redirectUri,
      state: state,
      scope: config.scopes.join(' ')
    });

    const url = `${config.authorizationUrl}?${params.toString()}`;
    res.json({ success: true, url });
  } catch (error) {
    console.error('Error initializing LinkedIn Org OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn Organization OAuth' });
  }
});

// LinkedIn Organization OAuth Callback
router.get('/org/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const frontendUrl = process.env.VITE_CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

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

  // Security Check: Verify State
  if (!state || !verifyState(state, userId)) {
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
      }
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;
    
    // Get organizations where user is admin
    const aclResponse = await linkedInService.getAdminOrganizations(access_token);
    const orgUrns = aclResponse.elements.map(acl => acl.organizationTarget);
    
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

    res.json({
      success: true,
      organizations,
      _tokens: {
        access_token,
        refresh_token,
        expires_in,
        scopes: config.scopes
      }
    });

  } catch (error: any) {
    console.error('Get Organizations Error:', error);
    res.status(500).json({ error: 'Failed to get organizations', details: error.message });
  }
});

// Connect selected company pages
// State validation not strictly needed here if we trust the tokens? 
// Actually this is a separate step post-OAuth. The tokens are passed in.
// We verify the user logic normally via authenticateToken.
router.post('/connect-pages', authenticateToken, async (req: any, res) => {
  const { organizations, tokens } = req.body;
  const userId = req.user.userId;

  if (!organizations || !Array.isArray(organizations) || organizations.length === 0) {
    return res.status(400).json({ error: 'No organizations selected' });
  }

  if (!tokens || !tokens.access_token) {
    return res.status(400).json({ error: 'Missing access tokens' });
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
    res.status(500).json({ error: 'Failed to connect pages', details: error.message });
  }
});

export default router;
