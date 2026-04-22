import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { createAccount } from '../services/connectedAccountsDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

const router = express.Router();

// ============================================
// Routes
// ============================================

/**
 * GET /init
 * Generates a Unipile Hosted Auth Link for LinkedIn.
 * The frontend opens this URL in a popup window.
 * On success, Unipile redirects to success_redirect_url with ?account_id=xxx
 */
router.get('/init', authenticateToken, async (req: any, res: any) => {
  try {
    const client = await linkedInOutreachService.getClient();
    const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';

    // Unipile requires expiresOn as ISO 8601 string: "YYYY-MM-DDTHH:MM:SS.sssZ"
    const expiresOn = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const authLink = await client.account.createHostedAuthLink({
      type: 'create',
      providers: ['LINKEDIN'],
      // The SDK types expect a branded datetime string; cast to bypass the
      // type mismatch since ISO 8601 is what the Unipile API actually requires.
      expiresOn: expiresOn as any,
      success_redirect_url: `${frontendUrl}/oauth/linkedin-outreach/callback`,
      failure_redirect_url: `${frontendUrl}/oauth/linkedin-outreach/callback?error=connection_failed`,
      api_url: await linkedInOutreachService.getApiUrl(),
    });

    res.json({ success: true, url: authLink.url });

  } catch (error: any) {
    console.error('[LinkedIn Outreach] Error generating auth link:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn Outreach connection', details: error.message });
  }
});



/**
 * POST /save-account
 * Called by the frontend after the popup callback delivers the Unipile account_id.
 * Fetches account details from Unipile and saves the account to the user's profile.
 */
router.post('/save-account', authenticateToken, async (req: any, res: any) => {
  const { unipileAccountId } = req.body;
  const userId = req.user.userId;

  if (!unipileAccountId || typeof unipileAccountId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid unipileAccountId' });
  }

  try {
    // Fetch account details from Unipile to get the LinkedIn username/name
    const unipileAccount = await linkedInOutreachService.getAccount(unipileAccountId);

    if ((unipileAccount as any).type !== 'LINKEDIN') {
      return res.status(400).json({ error: 'Account is not a LinkedIn account' });
    }

    const accountName = unipileAccount.name || 'LinkedIn Account';
    const username: string | undefined = (unipileAccount as any).connection_params?.im?.username;

    const accountInput = {
      account_id: unipileAccountId,
      account_name: accountName,
      config: {
        account_type: 'personal' as const,
        unipile_account_id: unipileAccountId,
        username,
        // Sentinel token values — Unipile manages the real credentials internally
        access_token: `unipile:${unipileAccountId}`,
        token_expires_at: Number.MAX_SAFE_INTEGER,
        scopes: [],
      },
    };

    const account = await createAccount(userId, 'unipile', accountInput);

    // Invalidate the cached connectivity status so the next GET /connected-accounts
    // re-checks Unipile rather than returning the stale "disconnected" result.
    linkedInOutreachService.clearStatusCache(unipileAccountId);

    console.log(`[LinkedIn Outreach] Connected account ${unipileAccountId} for user ${userId}`);
    res.json({ success: true, account });

  } catch (error: any) {
    console.error('[LinkedIn Outreach] Error saving account:', error);
    res.status(500).json({ error: 'Failed to save LinkedIn Outreach account', details: error.message });
  }
});

/**
 * POST /reconnect
 * Generates a Unipile Hosted Auth Link to reconnect an existing (disconnected) LinkedIn account.
 * The frontend opens this URL in a popup window.
 */
router.post('/reconnect', authenticateToken, async (req: any, res: any) => {
  const { unipileAccountId } = req.body;

  if (!unipileAccountId || typeof unipileAccountId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid unipileAccountId' });
  }

  try {
    const client = await linkedInOutreachService.getClient();
    const frontendUrl = process.env.CUSTOMER_FRONTEND_URL || 'http://localhost:5174';
    const expiresOn = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const authLink = await client.account.createHostedAuthLink({
      type: 'reconnect',
      reconnect_account: unipileAccountId,
      expiresOn: expiresOn as any,
      success_redirect_url: `${frontendUrl}/oauth/linkedin-outreach/callback`,
      failure_redirect_url: `${frontendUrl}/oauth/linkedin-outreach/callback?error=connection_failed`,
      api_url: await linkedInOutreachService.getApiUrl(),
    } as any);

    res.json({ success: true, url: authLink.url });
  } catch (error: any) {
    console.error('[LinkedIn Outreach] Error generating reconnect link:', error);
    res.status(500).json({ error: 'Failed to generate reconnect link', details: error.message });
  }
});

export default router;
