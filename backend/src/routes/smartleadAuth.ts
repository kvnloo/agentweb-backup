import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth';
import { createAccount, SmartleadConfig } from '../services/connectedAccountsDb';
import { listEmailAccounts, scrubSmartleadSecrets, SmartleadApiError, SmartleadUnexpectedResponseError } from '../services/smartleadService';
import { redactAccountSecrets } from '../utils/accountSecretRedaction';
import { encryptPassword } from '../utils/crypto';
import { NON_EXPIRING_TOKEN_TIMESTAMP } from '../utils/tokenUtils';

const router = express.Router();

// Smartlead has no "who am I" call to key a connection on, so a user has one: reconnecting replaces the key.
// The id carries the user so two org members' shared keys do not collide in the org account listing.
const smartleadAccountId = (userId: string) => `smartlead-${userId}`;

// /connect makes an outbound call with a user-supplied key, so without a limit it is a free Smartlead-key validator.
const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => String(req.user?.userId ?? 'anonymous'),
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many attempts to connect a Smartlead key. Try again in a few minutes.' },
});

// POST /connect — validate a customer's Smartlead API key by listing its mailboxes, then store it
// encrypted as a connected account (ENG-673). API and webhooks need Smartlead Pro or above.
router.post('/connect', authenticateToken, connectLimiter, async (req: any, res) => {
  const userId = req.user.userId;
  const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  if (!apiKey) {
    return res.status(400).json({ error: 'A Smartlead API key is required.' });
  }
  // Real keys are short and have no spaces; anything else is a paste mistake, and a huge value would only bounce off the URL limit.
  if (apiKey.length > 200 || /\s/.test(apiKey)) {
    return res.status(400).json({ error: 'That does not look like a Smartlead API key. Paste only the key.' });
  }

  let mailboxCount: number;
  try {
    // First page only and no retries: this request waits on the user's screen (the portal gives up at 30 s), so it
    // must not sit through 429 backoffs or paging. Validity is all we need; the count is "at least this many".
    mailboxCount = (await listEmailAccounts(apiKey, { maxRetries: 0, maxPages: 1 })).length;
  } catch (error) {
    const status = error instanceof SmartleadApiError ? error.status : undefined;
    // An expired plan and a wrong key can both come back as 401, so the message names both.
    if (status === 401 || status === 403) {
      return res.status(422).json({
        error: 'Smartlead rejected this key. Check it is a current API key from a Smartlead Pro (or higher) account.',
      });
    }
    if (error instanceof SmartleadUnexpectedResponseError) {
      console.error('[Smartlead] Key validation got an unexpected response');
      return res.status(502).json({
        error: 'Smartlead answered in a way we did not expect. Check the key is from a Smartlead Pro (or higher) plan, then try again.',
      });
    }
    if (status === 429) {
      return res.status(429).json({ error: 'Smartlead is rate-limiting requests. Try again in a minute.' });
    }
    console.error('[Smartlead] Key validation failed:', scrubSmartleadSecrets(error instanceof Error ? error.message : String(error), apiKey));
    return res.status(502).json({ error: 'Could not verify the key with Smartlead. Try again shortly.' });
  }

  try {
    const config: SmartleadConfig = {
      account_type: 'api_key',
      access_token: encryptPassword(apiKey, userId),
      token_expires_at: NON_EXPIRING_TOKEN_TIMESTAMP,
      mailbox_count: mailboxCount,
    };
    const accountId = smartleadAccountId(userId);
    // resetSharing: a replaced key is a different credential, so it must be re-shared on purpose.
    const account = await createAccount(userId, 'smartlead', {
      account_id: accountId,
      account_name: 'Smartlead',
      config,
    }, { resetSharing: true });
    return res.json({
      success: true,
      account: redactAccountSecrets(account),
      // A valid key with no mailboxes still connects: they may add mailboxes in Smartlead afterwards.
      ...(mailboxCount === 0 ? { warning: 'This Smartlead account has no email accounts yet. Add mailboxes in Smartlead before sending.' } : {}),
    });
  } catch (error) {
    console.error('[Smartlead] Failed to save connected account:', scrubSmartleadSecrets(error instanceof Error ? error.message : String(error), apiKey));
    return res.status(500).json({ error: 'Failed to save the Smartlead connection.' });
  }
});

export default router;
