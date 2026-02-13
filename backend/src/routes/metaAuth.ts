import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth';
import { getMetaConfig } from '../config/integrations';
import { metaService } from '../services/metaService';
import { createAccount } from '../services/connectedAccountsDb';
import { MetaAdAccount, MetaPage } from '../types/meta';

const router = express.Router();

// Server-side token session storage (temporary, 10-minute TTL)
const tokenSessions = new Map<string, {
    userId: string;
    access_token: string;
    expires_in?: number;
    scopes: string[];
    timestamp: number;
}>();

// Cleanup expired sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000;

    for (const [sessionId, session] of tokenSessions.entries()) {
        if (now - session.timestamp > TEN_MINUTES) {
            tokenSessions.delete(sessionId);
        }
    }
}, 5 * 60 * 1000);

/**
 * Generate a signed state parameter for CSRF protection
 */
function generateState(userId: string): string {
    const stateData = {
        userId,
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex')
    };

    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not configured');
    }

    return jwt.sign(stateData, secret, { expiresIn: '10m' });
}

/**
 * Verify the state parameter
 */
function verifyState(state: string): { userId: string } {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET is not configured');
    }

    try {
        const decoded = jwt.verify(state, secret) as { userId: string };
        return decoded;
    } catch (error) {
        throw new Error('Invalid or expired state parameter');
    }
}

/**
 * Build OAuth authorization URL
 */
function buildOAuthUrl(config: any, state: string): string {
    const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        state,
        scope: config.scopes.join(','),
        response_type: 'code'
    });

    return `${config.authorizationUrl}?${params.toString()}`;
}

/**
 * Store tokens in server-side session
 */
function storeTokenSession(userId: string, tokens: {
    access_token: string;
    expires_in?: number;
    scopes: string[];
}): string {
    const sessionId = crypto.randomBytes(32).toString('hex');

    tokenSessions.set(sessionId, {
        userId,
        access_token: tokens.access_token,
        expires_in: tokens.expires_in,
        scopes: tokens.scopes,
        timestamp: Date.now()
    });

    return sessionId;
}

/**
 * Retrieve and delete token session
 */
function retrieveTokenSession(sessionId: string, userId: string) {
    const session = tokenSessions.get(sessionId);
    if (!session) {
        console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... not found`);
        return null;
    }

    if (session.userId !== userId) {
        console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... userId mismatch`);
        return null;
    }

    // Check strict expiry (timestamp + 10 mins)
    const TEN_MINUTES = 10 * 60 * 1000;
    if (Date.now() - session.timestamp > TEN_MINUTES) {
        console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... expired`);
        tokenSessions.delete(sessionId);
        return null;
    }

    tokenSessions.delete(sessionId);
    console.log(`[TokenSession] Retrieved and deleted session ${sessionId.substring(0, 8)}...`);
    return session;
}

// ============================================
// OAuth Routes
// ============================================

/**
 * Initialize Meta OAuth flow
 * Single unified OAuth with all scopes (ad accounts + pages)
 */
router.get('/init', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.userId;
        const config = await getMetaConfig();

        // Generate signed state
        const state = generateState(userId);

        // Build URL with all scopes (unified OAuth)
        const url = buildOAuthUrl(config, state);

        res.json({ success: true, url });

    } catch (error) {
        console.error('Error initializing Meta OAuth:', error);
        res.status(500).json({ error: 'Failed to initialize Meta OAuth' });
    }
});


/**
 * Meta OAuth callback
 * Receives authorization code from Meta and redirects to frontend
 */
router.get('/callback', async (req, res) => {
    console.log("---------------------------")
    try {
        const { code, state } = req.query;
        if (!code || !state) {
            return res.redirect(
                `${process.env.CUSTOMER_FRONTEND_URL}/oauth/meta/callback?error=missing_parameters`
            );
        }

        // Redirect to frontend callback page with code and state
        res.redirect(
            `${process.env.CUSTOMER_FRONTEND_URL}/oauth/meta/callback?code=${code}&state=${state}`
        );

    } catch (error) {
        console.error('[Meta Callback] Error:', error);
        res.redirect(
            `${process.env.CUSTOMER_FRONTEND_URL}/oauth/meta/callback?error=server_error`
        );
    }
});

/**
 * Finalize Meta OAuth
 * Exchanges authorization code for access token and fetches accounts/pages
 */
router.post('/finalize', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.userId;
        const { code, state } = req.body;

        if (!code || !state) {
            return res.status(400).json({ error: 'Missing code or state parameter' });
        }

        console.log('[Meta Finalize] Verifying state...');

        // Verify state
        let stateData;
        try {
            stateData = verifyState(state);
        } catch (error) {
            console.error('[Meta Finalize] State verification failed:', error);
            return res.status(400).json({ error: 'Invalid or expired state parameter' });
        }

        if (stateData.userId !== userId) {
            return res.status(403).json({ error: 'User ID mismatch' });
        }

        const config = await getMetaConfig();

        console.log('[Meta Finalize] Exchanging code for tokens...');

        // Exchange code for access token
        const tokenResponse = await axios.get(config.tokenUrl, {
            params: {
                client_id: config.clientId,
                client_secret: config.clientSecret,
                redirect_uri: config.redirectUri,
                code: code
            },
            timeout: 15000
        });

        const { access_token, expires_in } = tokenResponse.data as { access_token: string; expires_in?: number };

        const tokenExpiresAt = expires_in
            ? Date.now() + (expires_in * 1000)
            : Date.now() + (60 * 24 * 60 * 60 * 1000); // Default 60 days


        // Fetch both ad accounts and pages
        let adAccounts: MetaAdAccount[] = [];
        let pages: MetaPage[] = [];

        try {
            console.log('[Meta Finalize] Fetching ad accounts...');
            adAccounts = await metaService.getAdAccounts(access_token);
        } catch (error) {
            console.log('[Meta Finalize] No ad accounts or permission denied');
        }

        try {
            console.log('[Meta Finalize] Fetching pages...');
            pages = await metaService.getPages(access_token);
        } catch (error) {
            console.log('[Meta Finalize] No pages or permission denied');
        }

        // Store tokens server-side and return session ID
        const tokenSessionId = storeTokenSession(userId, {
            access_token,
            expires_in,
            scopes: config.scopes
        });

        res.json({
            success: true,
            adAccounts: adAccounts.length > 0 ? adAccounts : undefined,
            pages: pages.length > 0 ? pages : undefined,
            tokenSessionId
        });

    } catch (error: any) {
        console.error('[Meta Finalize] Error:', error);
        res.status(500).json({
            error: 'Failed to finalize Meta OAuth',
            details: error.message
        });
    }
});

/**
 * Connect Meta Ad Accounts
 * Stores selected ad accounts in user's connected_accounts
 */
router.post('/connect-ad-accounts', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.userId;
        const { adAccounts, tokenSessionId } = req.body;

        if (!adAccounts || !Array.isArray(adAccounts) || adAccounts.length === 0) {
            return res.status(400).json({ error: 'No ad accounts provided' });
        }

        if (!tokenSessionId) {
            return res.status(400).json({ error: 'Missing token session ID' });
        }

        // Retrieve tokens from server-side session
        const session = retrieveTokenSession(tokenSessionId, userId);
        if (!session) {
            return res.status(400).json({ error: 'Invalid or expired token session' });
        }

        const accessToken = session.access_token;
        const scopes = session.scopes || [];

        const connectedAccounts = [];

        for (const adAccount of adAccounts) {
            const accountInput = {
                platform: 'meta' as const,
                account_id: adAccount.account_id,
                account_name: adAccount.name,
                config: {
                    account_type: 'ad_account' as const,
                    ad_account_id: adAccount.account_id,
                    currency: adAccount.currency,
                    account_status: adAccount.account_status,
                    access_token: accessToken,
                    token_expires_at: Date.now() + (60 * 24 * 60 * 60 * 1000), // Default to 60 days
                    scopes,
                }
            };

            const account = await createAccount(userId, 'meta', accountInput);
            connectedAccounts.push(account);
        }

        res.json({
            success: true,
            connectedAccounts
        });

    } catch (error: any) {
        console.error('[Meta Connect Ad Accounts] Error:', error);
        res.status(500).json({
            error: 'Failed to connect Meta ad accounts',
            details: error.message
        });
    }
});

export default router;
