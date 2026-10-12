import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { createAccount, LumaConfig } from '../services/connectedAccountsDb';
import { LumaApiService, LumaApiError } from '../services/lumaApiService';
import { redactAccountSecrets } from '../utils/accountSecretRedaction';
import { encryptPassword } from '../utils/crypto';

const router = express.Router();

// POST /connect — validate a Luma calendar API key against Luma, then store it
// encrypted as a connected account (ENG-2338). Keys are per-calendar and need Luma Plus.
router.post('/connect', authenticateToken, async (req: any, res) => {
  const userId = req.user.userId;
  const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  if (!apiKey) {
    return res.status(400).json({ error: 'A Luma API key is required.' });
  }

  let calendar;
  try {
    calendar = await new LumaApiService(apiKey).getCalendar();
  } catch (error) {
    if (error instanceof LumaApiError && error.isAuthFailure) {
      return res.status(401).json({
        error: 'Luma rejected this API key. Check that it is a calendar API key from a Luma Plus calendar.',
      });
    }
    if (error instanceof LumaApiError && error.status === 429) {
      return res.status(429).json({ error: 'Luma is rate-limiting requests. Try again in a minute.' });
    }
    console.error('[Luma] Key validation failed:', error instanceof Error ? error.message : error);
    return res.status(502).json({ error: 'Could not verify the key with Luma. Try again shortly.' });
  }

  try {
    const config: LumaConfig = {
      account_type: 'api_key',
      access_token: encryptPassword(apiKey, userId),
      token_expires_at: Number.MAX_SAFE_INTEGER,
      ...(calendar.url ? { calendar_url: calendar.url } : {}),
    };
    const account = await createAccount(userId, 'luma', {
      account_id: calendar.id,
      account_name: calendar.name,
      config,
    });
    return res.json({ success: true, account: redactAccountSecrets(account) });
  } catch (error) {
    console.error('[Luma] Failed to save connected account:', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'Failed to save the Luma connection.' });
  }
});

export default router;
