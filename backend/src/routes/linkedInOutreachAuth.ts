import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { createAccount } from '../services/connectedAccountsDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { clearDisconnectFlag } from '../services/linkedInConnectionHealth';

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

    console.log(`[LinkedIn Outreach] Hosted auth link generated (type=create) for user ${req.user.userId}`);
    res.json({ success: true, url: authLink.url });

  } catch (error: any) {
    console.error('[LinkedIn Outreach] Error generating auth link:', error);
    res.status(500).json({ error: 'Failed to initialize LinkedIn Outreach connection', details: error.message });
  }
});



/**
 * Fetch Unipile account details with up to maxRetries attempts, backing off between each.
 * A newly-created Unipile account may not be fully provisioned for a second or two after
 * the hosted-auth callback fires, so we retry rather than failing immediately.
 */
async function fetchAccountWithRetry(
  accountId: string,
  maxRetries = 3,
  delayMs = 1500
): Promise<{ name: string; username?: string } | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const account = await linkedInOutreachService.getAccount(accountId);
      if ((account as any).type === 'LINKEDIN') {
        return {
          name: (account as any).name || '',
          username: (account as any).connection_params?.im?.username,
        };
      }
      console.warn(`[LinkedIn Outreach] getAccount attempt ${attempt}: unexpected type "${(account as any).type}" for ${accountId}`);
    } catch (err: any) {
      console.warn(`[LinkedIn Outreach] getAccount attempt ${attempt} failed for ${accountId}: ${err.message}`);
    }
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  return null;
}

/**
 * POST /save-account
 * Called by the frontend after the popup callback delivers the Unipile account_id.
 * Fetches account details from Unipile (with retry) and saves the account to the user's
 * profile. If Unipile is still provisioning the account, we fall back to a placeholder
 * name rather than failing — the name updates on the next connected-accounts load.
 */
router.post('/save-account', authenticateToken, async (req: any, res: any) => {
  const { unipileAccountId } = req.body;
  const userId = req.user.userId;

  if (!unipileAccountId || typeof unipileAccountId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid unipileAccountId' });
  }

  try {
    // Fetch account details with retry — new accounts may not be provisioned immediately.
    const accountDetails = await fetchAccountWithRetry(unipileAccountId);

    const accountName = accountDetails?.name || 'LinkedIn Account';
    const username = accountDetails?.username;

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
    //
    // That cache is per-process, and production runs more than one instance, so this
    // alone only convinces whichever instance happened to serve the reconnect. Clear
    // the persisted flag too (ENG-1197) — that is the copy the other instance and the
    // scheduled runner read, and leaving it set is how an account stays "disconnected"
    // in-app after the customer has genuinely reconnected it.
    linkedInOutreachService.clearStatusCache(unipileAccountId);
    await clearDisconnectFlag(userId, unipileAccountId);

    console.log(`[LinkedIn Outreach] Connected account ${unipileAccountId} (name: "${accountName}") for user ${userId}`);
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

    console.log(`[LinkedIn Outreach] Hosted auth link generated (type=reconnect, account=${unipileAccountId}) for user ${req.user.userId}`);
    res.json({ success: true, url: authLink.url });
  } catch (error: any) {
    console.error('[LinkedIn Outreach] Error generating reconnect link:', error);
    res.status(500).json({ error: 'Failed to generate reconnect link', details: error.message });
  }
});

/**
 * POST /callback-event
 * ENG-1272: fired by the hosted-auth popup (UnipileLinkedInCallback) the moment it
 * lands, before it postMessages the opener and closes — regardless of whether the
 * connection succeeded or failed. Best-effort and silent by design: a customer
 * dispute about whether they reconnected currently has no trace to check either way,
 * and this is the only point where Unipile's own success/failure verdict ever
 * reaches our backend at all (the popup gets it via redirect query params; nothing
 * about that redirect is otherwise visible to us).
 */
router.post('/callback-event', authenticateToken, async (req: any, res: any) => {
  const { status, unipileAccountId, error } = req.body;
  const userId = req.user.userId;

  if (status !== 'success' && status !== 'failure') {
    return res.status(400).json({ error: 'Missing or invalid status' });
  }

  // This log is meant to be a trustworthy evidence trail for exactly the kind
  // of "did the customer actually reconnect" dispute ENG-1272 raised, so the
  // caller-supplied fields are JSON-encoded rather than interpolated raw —
  // stringifying a string still just prints the string, but it also fixes
  // width, escapes newlines, and defuses a non-string payload, so an
  // authenticated caller can't forge what looks like a second, separate log
  // line or corrupt the format others may grep against.
  console.log(
    `[LinkedIn Outreach] Callback observed: status=${status} user=${userId} `
    + `account=${JSON.stringify(unipileAccountId ?? 'n/a')} error=${JSON.stringify(error ?? 'n/a')}`,
  );
  res.json({ success: true });
});

export default router;
