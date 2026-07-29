import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authenticateToken } from '../middleware/auth';
import { getMetaCredentials, getInstagramCredentials } from '../utils/secretsManager';
import { getMetaFlowConfig, INTEGRATION_CONFIG, MetaFlowType } from '../config/integrations';
import { metaService } from '../services/metaService';
import { instagramService } from '../services/instagramService';
import { createAccount } from '../services/connectedAccountsDb';
import { oauthSessionDb } from '../services/db';
import { MetaAdAccount, MetaInstagramAccount } from '../types/meta';
import { getJwtSecret } from '../config/jwt';

const router = express.Router();

// Token sessions are stored in DynamoDB (AW-OAuthSessions) with a 10-minute TTL
// to survive across multiple backend instances behind the load balancer.

// ============================================
// Helpers
// ============================================

function generateState(userId: string, extra: Record<string, any> = {}): string {
    return jwt.sign({ userId, ...extra, timestamp: Date.now(), nonce: crypto.randomBytes(16).toString('hex') }, getJwtSecret(), { expiresIn: '10m' });
}

function verifyState(state: string): { userId: string; flow?: MetaFlowType } {
    const secret = getJwtSecret();
    try {
        return jwt.verify(state, secret) as { userId: string; flow?: MetaFlowType };
    } catch {
        throw new Error('Invalid or expired state parameter');
    }
}

function buildOAuthUrl(params: { authorizationUrl: string; clientId: string; redirectUri: string; scopes: string[]; state: string }): string {
    const searchParams = new URLSearchParams({
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        state: params.state,
        scope: params.scopes.join(','),
        response_type: 'code'
    });
    return `${params.authorizationUrl}?${searchParams.toString()}`;
}

async function storeTokenSession(userId: string, tokens: { access_token: string; expires_in?: number; scopes: string[]; granted_scopes?: string[]; flow: MetaFlowType }): Promise<string> {
    const sessionId = crypto.randomBytes(32).toString('hex');
    await oauthSessionDb.save({ sessionId, userId, ...tokens });
    return sessionId;
}

async function retrieveTokenSession(sessionId: string, userId: string) {
    const session = await oauthSessionDb.get(sessionId, userId);
    if (!session) {
        console.warn(`[TokenSession] Session ${sessionId.substring(0, 8)}... not found or userId mismatch`);
        return null;
    }
    console.log(`[TokenSession] Retrieved session ${sessionId.substring(0, 8)}...`);
    return session;
}

// ============================================
// Routes
// ============================================

/**
 * Initialize Meta OAuth flow.
 * Query param: ?flow=marketing|instagram
 *
 * marketing  — Facebook Login, ads scopes
 * instagram  — Instagram Business Login (instagram.com dialog), IG-specific scopes
 */
router.get('/init', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.userId;
        const rawFlow = req.query.flow as string | undefined;
        const flow: MetaFlowType = (rawFlow === 'instagram' || rawFlow === 'marketing') ? rawFlow : 'marketing';

        // Use Instagram credentials for Instagram Business Login, Facebook App creds for marketing/pages
        const creds = flow === 'instagram'
            ? await getInstagramCredentials()
            : await getMetaCredentials();
        const flowCfg = getMetaFlowConfig(flow);
        const redirectUri = flow === 'instagram'
            ? INTEGRATION_CONFIG.meta.instagramRedirectUri
            : INTEGRATION_CONFIG.meta.redirectUri;
        const clientId = flow === 'instagram'
            ? creds.instagramClientId
            : creds.clientId;
        const state = generateState(userId, { flow });

        const url = buildOAuthUrl({
            authorizationUrl: flowCfg.authorizationUrl,
            clientId: clientId,
            redirectUri,
            scopes: flowCfg.scopes,
            state
        });

        console.log(`[Meta Init] flow=${flow}, scopes=${flowCfg.scopes.join(',')}`);
        res.json({ success: true, url });

    } catch (error) {
        console.error('[Meta Init] Error:', error);
        res.status(500).json({ error: 'Failed to initialize Meta OAuth' });
    }
});

/**
 * Meta / Instagram OAuth callback
 * Shared across all 3 flows — redirects to frontend callback page.
 */
router.get('/callback', async (req, res) => {
    try {
        const { code, state } = req.query;
        let flow = 'marketing';
        
        if (state) {
            try {
                const stateData = verifyState(state as string);
                if (stateData.flow) flow = stateData.flow;
            } catch (e) {
                // Ignore state errors here, will be caught in /finalize
            }
        }
        
        const frontendPath = flow === 'instagram' ? '/oauth/instagram/callback' : '/oauth/meta/callback';
        
        if (!code || !state) {
            return res.redirect(`${process.env.CUSTOMER_FRONTEND_URL}${frontendPath}?error=missing_parameters`);
        }
        res.redirect(`${process.env.CUSTOMER_FRONTEND_URL}${frontendPath}?code=${code}&state=${state}`);
    } catch (error) {
        console.error('[Meta Callback] Error:', error);
        res.redirect(`${process.env.CUSTOMER_FRONTEND_URL}/oauth/meta/callback?error=server_error`);
    }
});

/**
 * Finalize Meta OAuth
 * Exchanges code for token and fetches the appropriate accounts based on flow.
 *
 * Response shape varies by flow:
 *   marketing:  { flow, adAccounts (with instagramAccounts per account), tokenSessionId }
 *   pages:      { flow, pages (with instagram_business_account per page), tokenSessionId }
 *   instagram:  { flow, instagramAccounts: [single IG account], tokenSessionId }
 */
router.post('/finalize', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.userId;
        const { code, state } = req.body;

        if (!code || !state) {
            return res.status(400).json({ error: 'Missing code or state parameter' });
        }

        let stateData: { userId: string; flow?: MetaFlowType };
        try {
            stateData = verifyState(state);
        } catch (error) {
            return res.status(400).json({ error: 'Invalid or expired state parameter' });
        }

        if (stateData.userId !== userId) {
            return res.status(403).json({ error: 'User ID mismatch' });
        }

        const flow: MetaFlowType = stateData.flow || 'marketing';
        // Use Instagram credentials for Instagram Business Login, Facebook App creds for marketing/pages
        const creds = flow === 'instagram'
            ? await getInstagramCredentials()
            : await getMetaCredentials();
        const flowCfg = getMetaFlowConfig(flow);
        const redirectUri = flow === 'instagram' 
            ? INTEGRATION_CONFIG.meta.instagramRedirectUri 
            : INTEGRATION_CONFIG.meta.redirectUri;
        const clientId = flow === 'instagram'
            ? creds.instagramClientId
            : creds.clientId;
        const clientSecret = flow === 'instagram'
            ? creds.instagramClientSecret
            : creds.clientSecret;
        console.log(`[Meta Finalize] flow=${flow} — exchanging code for token...`);

        // Exchange code for access token
        // Instagram Business Login requires POST with form-encoded body (not GET)
        // Facebook Login (marketing/pages) uses GET with query params
        let tokenResponse: any;
        if (flow === 'instagram') {
            const params = new URLSearchParams();
            params.append('client_id', clientId);
            params.append('client_secret', clientSecret);
            params.append('grant_type', 'authorization_code');
            params.append('redirect_uri', redirectUri);
            params.append('code', code as string);

            tokenResponse = await axios.post(flowCfg.tokenUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 15000
            });
        } else {
            tokenResponse = await axios.get(flowCfg.tokenUrl, {
                params: {
                    client_id: creds.clientId,
                    client_secret: creds.clientSecret,
                    redirect_uri: redirectUri,
                    code
                },
                timeout: 15000
            });
        }

        let { access_token, expires_in } = tokenResponse.data as { access_token: string; expires_in?: number };

        if (flow === 'instagram') {
            try {
                console.log('[Meta Finalize] Exchanging short-lived Instagram token for a long-lived one...');
                const longLived = await instagramService.getLongLivedToken(access_token, clientSecret);
                if (longLived && longLived.access_token) {
                    access_token = longLived.access_token;
                    expires_in = longLived.expires_in;
                    console.log(`[Meta Finalize] Successfully obtained long-lived token (expires_in: ${expires_in})`);
                }
            } catch (err: any) {
                console.warn('[Meta Finalize] Failed to exchange for long-lived token, falling back to short-lived:', err?.message || err);
            }
        }

        // Ask Meta what it ACTUALLY granted. `flowCfg.scopes` is only what we
        // requested — the user can untick individual permissions at the consent
        // dialog and still receive a token, so storing the request as if it were
        // the grant records an unverified claim (ENG-629 / OPS-79). Best-effort:
        // a failure here must never block connecting the account.
        let granted_scopes: string[] | undefined;
        try {
            granted_scopes = await metaService.getGrantedScopes(access_token);
            console.log(
                `[Meta Finalize] granted scopes: ${granted_scopes ? granted_scopes.join(',') : '(undetermined)'}`
            );
        } catch (err: any) {
            console.warn(`[Meta Finalize] Could not determine granted scopes: ${err?.message ?? err}`);
        }

        const tokenSessionId = await storeTokenSession(userId, {
            access_token,
            expires_in,
            scopes: flowCfg.scopes,
            ...(granted_scopes ? { granted_scopes } : {}),
            flow
        });

        // ── Flow: marketing ──────────────────────────────────────────────────
        if (flow === 'marketing') {
            let adAccounts: MetaAdAccount[] = [];
            let adAccountsError = false;
            try {
                adAccounts = await metaService.getAdAccounts(access_token);
                console.log(`[Meta Finalize] Found ${adAccounts.length} ad account(s) for user ${userId}`);
            } catch (error: any) {
                // Surface a flag (no details) so the frontend can distinguish "Meta call
                // failed" from "user genuinely has zero ad accounts".
                adAccountsError = true;
                const structured = error?.structuredError;
                console.error(`[Meta Finalize] getAdAccounts failed for user ${userId}`, {
                    code: structured?.code ?? null,
                    classification: structured?.classification ?? null,
                    message: error?.message ?? String(error),
                    fbtrace_id: structured?.fbtrace_id ?? null,
                });
            }

            return res.json({
                success: true,
                flow,
                adAccounts: adAccounts.length > 0 ? adAccounts : undefined,
                adAccountsError: adAccountsError || undefined,
                tokenSessionId
            });
        }

        // ── Flow: instagram ───────────────────────────────────────────────────
        if (flow === 'instagram') {
            let igAccount: MetaInstagramAccount | null = null;
            try {
                // Method C: fetch IG account from Instagram Graph API
                igAccount = await instagramService.getInstagramBusinessMe(access_token);
            } catch (error) {
                console.log('[Meta Finalize] Failed to fetch Instagram account:', error);
            }

            return res.json({
                success: true,
                flow,
                instagramAccounts: igAccount ? [igAccount] : undefined,
                tokenSessionId
            });
        }

        return res.status(400).json({ error: `Unknown flow: ${flow}` });

    } catch (error: any) {
        console.error('[Meta Finalize] Error:', error);
        res.status(500).json({ error: 'Failed to finalize Meta OAuth' });
    }
});

/**
 * Connect Meta Ad Accounts (flow=marketing)
 * Stores selected ad accounts including optional instagram_user_id.
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

        const session = await retrieveTokenSession(tokenSessionId, userId);
        if (!session) {
            return res.status(400).json({ error: 'Invalid or expired token session' });
        }

        const connectedAccounts = [];
        for (const adAccount of adAccounts) {
            const account = await createAccount(userId, 'meta', {
                account_id: adAccount.account_id,
                account_name: adAccount.name,
                config: {
                    account_type: 'ad_account',
                    ad_account_id: adAccount.account_id,
                    currency: adAccount.currency,
                    account_status: adAccount.account_status,
                    access_token: session.access_token,
                    token_expires_at: session.expires_in ? Date.now() + (session.expires_in * 1000) : Date.now() + (60 * 24 * 60 * 60 * 1000),
                    scopes: session.scopes,
                    // Authoritative capability signal, read back by getMetaAdsScopeState.
                    // Omitted (not []) when undetermined, so "we could not ask" never
                    // masquerades as "nothing was granted" (ENG-629).
                    ...(session.granted_scopes ? { granted_scopes: session.granted_scopes } : {}),
                }
            });
            connectedAccounts.push(account);
        }

        res.json({ success: true, connectedAccounts });

    } catch (error: any) {
        console.error('[Meta Connect Ad Accounts] Error:', error);
        res.status(500).json({ error: 'Failed to connect Meta ad accounts' });
    }
});

/**
 * Connect Instagram Business Account (flow=instagram)
 * Stores IG account from Instagram Business Login (Method C).
 */
router.post('/connect-instagram', authenticateToken, async (req: any, res) => {
    try {
        const userId = req.user.userId;
        const { instagramAccount, tokenSessionId } = req.body;

        if (!instagramAccount) {
            return res.status(400).json({ error: 'No Instagram account provided' });
        }
        if (!tokenSessionId) {
            return res.status(400).json({ error: 'Missing token session ID' });
        }

        const session = await retrieveTokenSession(tokenSessionId, userId);
        if (!session) {
            return res.status(400).json({ error: 'Invalid or expired token session' });
        }

        const account = await createAccount(userId, 'instagram', {
            account_id: instagramAccount.id,
            account_name: instagramAccount.username || instagramAccount.name || instagramAccount.id,
            config: {
                account_type: 'instagram_business',
                instagram_account_id: instagramAccount.id,
                username: instagramAccount.username,
                access_token: session.access_token, // Instagram User Token
                token_expires_at: session.expires_in ? Date.now() + (session.expires_in * 1000) : Date.now() + (60 * 24 * 60 * 60 * 1000),
                scopes: session.scopes
            }
        });

        res.json({ success: true, connectedAccount: account });

    } catch (error: any) {
        console.error('[Meta Connect Instagram] Error:', error);
        res.status(500).json({ error: 'Failed to connect Instagram account' });
    }
});

export default router;
