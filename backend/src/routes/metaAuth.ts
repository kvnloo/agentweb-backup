import express from 'express';
import jwt from 'jsonwebtoken';
import { authenticateToken } from '../middleware/auth';
import { getMetaFlowConfig, MetaFlowType } from '../config/integrations';
import { createAccount } from '../services/connectedAccountsDb';
import { redactAccountSecrets, redactAccountsSecrets } from '../utils/accountSecretRedaction';
import { getJwtSecret } from '../config/jwt';
import { buildMetaConnectUrl } from '../services/metaConnectUrl';
import {
    META_PRECONNECT_INSTRUCTIONS,
    MetaTokenSessionError,
    connectMetaAdAccounts,
    finalizeMetaOAuth,
    retrieveTokenSession,
    safeAutoResolve,
} from '../services/metaOAuthFinalize';
import { ZOMA_META_CALLBACK_PATH } from '../mcp/zomaSetupLinks';

const router = express.Router();

// ============================================
// Helpers
// ============================================

function verifyState(state: string): { userId: string; flow?: MetaFlowType; zoma?: string } {
    const secret = getJwtSecret();
    try {
        return jwt.verify(state, secret) as { userId: string; flow?: MetaFlowType; zoma?: string };
    } catch {
        throw new Error('Invalid or expired state parameter');
    }
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

        const flowCfg = getMetaFlowConfig(flow);
        const url = await buildMetaConnectUrl(userId, flow);

        console.log(`[Meta Init] flow=${flow}, scopes=${flowCfg.scopes.join(',')}`);
        res.json({
            success: true,
            url,
            ...(flow === 'marketing' ? { preconnectInstructions: META_PRECONNECT_INSTRUCTIONS } : {}),
        });

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
                // ENG-2496: a Zoma setup's connect link (signed state carrying `zoma`) finishes
                // server-side for the state's user, independent of any portal session in this
                // browser. Same registered redirect URI, so no Meta app change. Portal states
                // never carry `zoma` and fall through unchanged.
                if (typeof stateData.zoma === 'string' && stateData.zoma) {
                    const forward = new URLSearchParams();
                    for (const key of ['code', 'state', 'error', 'error_reason'] as const) {
                        const value = req.query[key];
                        if (typeof value === 'string') forward.set(key, value);
                    }
                    return res.redirect(302, `${ZOMA_META_CALLBACK_PATH}?${forward.toString()}`);
                }
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

        const flow = (stateData.flow || 'marketing') as string;
        if (flow !== 'marketing' && flow !== 'instagram') {
            return res.status(400).json({ error: `Unknown flow: ${flow}` });
        }
        const result = await finalizeMetaOAuth({ userId, code: code as string, flow });
        return res.json({ success: true, ...result });

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

        const { connectedAccounts, accountsMissingPages } = await connectMetaAdAccounts({
            userId,
            customerEmail: req.user?.email,
            adAccounts,
            tokenSessionId,
        });

        res.json({
            success: true,
            connectedAccounts: redactAccountsSecrets(connectedAccounts),
            ...(accountsMissingPages.length > 0 ? { accountsMissingPages } : {}),
        });

    } catch (error: any) {
        if (error instanceof MetaTokenSessionError) {
            return res.status(400).json({ error: 'Invalid or expired token session' });
        }
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

        // ENG-1644 gap-closing (review fix): missed on the first pass —
        // Instagram is a distinct platform from Meta ad accounts in this
        // reconnect system, same treatment as /connect-ad-accounts above.
        await safeAutoResolve('Meta Connect Instagram', userId, 'instagram', instagramAccount.id);

        res.json({ success: true, connectedAccount: redactAccountSecrets(account) });

    } catch (error: any) {
        console.error('[Meta Connect Instagram] Error:', error);
        res.status(500).json({ error: 'Failed to connect Instagram account' });
    }
});

export default router;
