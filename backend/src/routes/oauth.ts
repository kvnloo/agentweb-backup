
import express from 'express';
import axios from 'axios';
import { getLinkedInConfig } from '../config/integrations';
import { createAccount, getAccountsByUserId } from '../services/connectedAccountsDb';
import { linkedInService } from '../services/linkedInService';
import { authenticateToken } from '../middleware/auth';

const router = express.Router();

// LinkedIn OAuth Init
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

// LinkedIn OAuth Callback
// This endpoint receives the authorization code from LinkedIn and redirects to the frontend.
// The frontend then calls /linkedin/connect with the code to complete the OAuth flow.
// NOTE: Authorization codes are single-use, so we DON'T exchange them here.
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

  // NOTE: In production, verify 'state' against user's session to prevent CSRF attacks.
  // For now, we simply redirect to the frontend with the code.
  // The frontend will call POST /linkedin/connect with the code and the user's auth token.
  
  const frontendUrl = process.env.VITE_CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
  res.redirect(`${frontendUrl}/oauth/linkedin/callback?linkedin_code=${code}`);
});

// Finalize LinkedIn Connection (Authenticated)
// Frontend calls this after getting 'code' or if we handle it fully on backend
router.post('/linkedin/connect', authenticateToken, async (req: any, res) => {
  const { code } = req.body;
  const userId = req.user.userId; // user is guaranteed by middleware

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
    let profile: { sub: string; name: string; email?: string } = { 
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
      } catch (profileError: any) {
        console.warn('[LinkedIn Connect] Profile API failed, using fallback. Error:', profileError.code || profileError.message);
      }
    }

    // Save to DB (profile_id from sub)
    const accountConfig = {
      account_id: profile.sub,
      account_name: profile.name,
      account_type: 'personal' as const,
      profile_id: profile.sub,
      access_token,
      refresh_token,
      token_expires_at: Date.now() + (expires_in * 1000),
      scopes: config.scopes
    };

    const account = await createAccount(userId, 'linkedin', accountConfig);

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

// List Connected Accounts
router.get('/connected-accounts', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;

  try {
    const accounts = await getAccountsByUserId(userId);

    const safeAccounts = accounts.map(acc => ({
      platform: acc.platform,
      account_name: acc.config.account_name,
      account_type: acc.config.account_type,
      profile_id: acc.config.profile_id,
      page_id: acc.config.page_id,
      connected_at: acc.config.connected_at
    }));

    res.json({ success: true, accounts: safeAccounts });
  } catch (error) {
    console.error('List Accounts Error:', error);
    res.status(500).json({ error: 'Failed to list connected accounts' });
  }
});

export default router;
