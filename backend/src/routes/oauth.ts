
import express from 'express';
import axios from 'axios';
import { getLinkedInConfig, getLinkedInOrgConfig } from '../config/integrations';
import { createAccount, getAccountsByUserId, deleteAccount, deleteAccountById } from '../services/connectedAccountsDb';
import { linkedInService } from '../services/linkedInService';
import { authenticateToken } from '../middleware/auth';
import { getTokenStatus, formatExpiryMessage } from '../utils/tokenUtils';

const router = express.Router();

// ============================================
// LinkedIn Personal Profile OAuth
// ============================================

// LinkedIn Personal OAuth Init
router.get('/linkedin/init', async (req, res) => {
  try {
    const config = await getLinkedInConfig();
    const state = Math.random().toString(36).substring(7); // Simple state for demo. in prod use signed JWT or session
    
    // Construct URL
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId || '',
      redirect_uri: config.redirectUri,
      state: state,
      scope: config.scopes.join(' ')
    });

    res.redirect(`${config.authorizationUrl}?${params.toString()}`);
  } catch (error) {
    console.error('Error initializing LinkedIn OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn OAuth' });
  }
});

// LinkedIn Personal OAuth Callback
router.get('/linkedin/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    const frontendUrl = process.env.VITE_CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=linkedin_access_denied&details=${error}`);
  }

  if (!code) {
    const frontendUrl = process.env.VITE_CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=no_code_provided`);
  }

  const frontendUrl = process.env.VITE_CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
  res.redirect(`${frontendUrl}/oauth/linkedin/callback?linkedin_code=${code}`);
});

// Finalize LinkedIn Personal Connection
router.post('/linkedin/connect', authenticateToken, async (req: any, res) => {
  const { code } = req.body;
  const userId = req.user.userId;

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
    console.log('[LinkedIn Connect] Token exchange successful. Has id_token:', !!id_token);
    
    // Try to extract profile from id_token first (most reliable - no network call needed)
    let profile: { sub: string; name: string; email?: string; picture?: string } = { 
      sub: `linkedin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: 'LinkedIn User' 
    };
    
    // Method 1: Extract from id_token JWT (preferred - no additional API call)
    if (id_token) {
      try {
        const tokenParts = id_token.split('.');
        if (tokenParts.length === 3) {
          const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
          console.log('[LinkedIn Connect] Decoded id_token payload:', { sub: payload.sub, name: payload.name });
          if (payload.sub) profile.sub = payload.sub;
          if (payload.name) profile.name = payload.name;
          if (payload.email) profile.email = payload.email;
          if (payload.picture) profile.picture = payload.picture;
          console.log('[LinkedIn Connect] Profile from id_token:', profile.name, profile.sub);
        }
      } catch (jwtError) {
        console.warn('[LinkedIn Connect] Failed to decode id_token:', jwtError);
      }
    }
    
    // Method 2: If id_token didn't have info, try the API call
    if (profile.sub.startsWith('linkedin_')) {
      try {
        const apiProfile = await linkedInService.getProfile(access_token);
        console.log('[LinkedIn Connect] Profile from API:', apiProfile.name);
        profile.sub = apiProfile.sub;
        profile.name = apiProfile.name;
        if (apiProfile.email) profile.email = apiProfile.email;
        if (apiProfile.picture) profile.picture = apiProfile.picture;
      } catch (profileError: any) {
        console.warn('[LinkedIn Connect] Profile API failed, using fallback. Error:', profileError.code || profileError.message);
      }
    }

    // Ensure URN format for account_id
    let accountId = profile.sub;
    if (!accountId.startsWith('urn:')) {
      accountId = `urn:li:person:${accountId}`;
    }

    // Save to DB (profile_id from sub)
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
    console.error('Error details:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    res.status(500).json({ error: 'Failed to connect account', details: error.message });
  }
});

// ============================================
// LinkedIn Organization/Company Pages OAuth
// ============================================

// LinkedIn Organization OAuth Init
router.get('/linkedin/org/init', async (req, res) => {
  try {
    const config = await getLinkedInOrgConfig();
    const state = 'org_' + Math.random().toString(36).substring(7);
    
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId || '',
      redirect_uri: config.redirectUri,
      state: state,
      scope: config.scopes.join(' ')
    });

    res.redirect(`${config.authorizationUrl}?${params.toString()}`);
  } catch (error) {
    console.error('Error initializing LinkedIn Org OAuth:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn Organization OAuth' });
  }
});

// LinkedIn Organization OAuth Callback
router.get('/linkedin/org/callback', async (req, res) => {
  const { code, error } = req.query;
  const frontendUrl = process.env.VITE_CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

  if (error) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=linkedin_org_access_denied&details=${error}`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/oauth/linkedin/callback?error=no_code_provided`);
  }

  // Redirect with org-specific code parameter
  res.redirect(`${frontendUrl}/oauth/linkedin/callback?linkedin_org_code=${code}`);
});

// Get user's admin organizations (after org OAuth)
router.post('/linkedin/organizations', authenticateToken, async (req: any, res) => {
  const { code } = req.body;
  const userId = req.user.userId;

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
    
    // Get organizations where user is admin (returns LinkedInAclResponse)
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

    // Return organizations and tokens for later use
    res.json({
      success: true,
      organizations,
      // Return tokens encrypted or store in session - for now just return for client to use
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
router.post('/linkedin/connect-pages', authenticateToken, async (req: any, res) => {
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
        account_id: org.urn, // Store full URN (e.g., urn:li:organization:123)
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

// ============================================
// Connected Accounts Management
// ============================================

// List Connected Accounts (with status)
router.get('/connected-accounts', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const accounts = await getAccountsByUserId(userId);

    const accountsWithStatus = accounts.map(acc => {
      const status = getTokenStatus(acc.config.token_expires_at);
      const expiryMessage = formatExpiryMessage(acc.config.token_expires_at);

      return {
        platform: acc.platform,
        account_id: acc.account_id,
        account_name: acc.account_name,
        account_type: acc.config.account_type,
        profile_id: acc.config.profile_id,
        page_id: acc.config.page_id,
        profile_image_url: (acc.config as any).profile_image_url,
        account_handle: (acc.config as any).account_handle,
        follower_count: (acc.config as any).follower_count,
        created_at: acc.created_at,
        // Status fields
        status,
        expires_at: acc.config.token_expires_at,
        expiry_message: expiryMessage,
      };
    });

    res.json({ success: true, accounts: accountsWithStatus });
  } catch (error) {
    console.error('List Accounts Error:', error);
    res.status(500).json({ error: 'Failed to list connected accounts' });
  }
});

// Delete Connected Account by platform (all accounts for that platform)
router.delete('/connected-accounts/:platform', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { platform } = req.params;

  try {
    await deleteAccount(userId, platform);
    res.json({ success: true, message: `${platform} account(s) disconnected` });
  } catch (error) {
    console.error('Delete Account Error:', error);
    res.status(500).json({ error: 'Failed to delete connected account' });
  }
});

// Delete specific Connected Account by platform and account_id
router.delete('/connected-accounts/:platform/:accountId', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const { platform, accountId } = req.params;

  try {
    await deleteAccountById(userId, platform, accountId);
    res.json({ success: true, message: `${platform} account ${accountId} disconnected` });
  } catch (error) {
    console.error('Delete Account By ID Error:', error);
    res.status(500).json({ error: 'Failed to delete connected account' });
  }
});

export default router;

