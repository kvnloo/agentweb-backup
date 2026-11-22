import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth';
import { createAccount, LumaConfig } from '../services/connectedAccountsDb';
import { LumaApiService, LumaApiError } from '../services/lumaApiService';
import { redactAccountSecrets } from '../utils/accountSecretRedaction';
import { encryptPassword } from '../utils/crypto';
import { NON_EXPIRING_TOKEN_TIMESTAMP } from '../utils/tokenUtils';

const router = express.Router();

// /connect makes an outbound call with a user-supplied key, so without a limit it is a free Luma-key validator.
// Keyed by user (this runs after authenticateToken), generous for a human retyping a key.
const connectLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => String(req.user?.userId ?? 'anonymous'),
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Too many attempts to connect a Luma key. Try again in a few minutes.' },
});

// POST /connect — validate a Luma calendar API key against Luma, then store it
// encrypted as a connected account (ENG-2338). Keys are per-calendar and need Luma Plus.
router.post('/connect', authenticateToken, connectLimiter, async (req: any, res) => {
  const userId = req.user.userId;
  const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
  if (!apiKey) {
    return res.status(400).json({ error: 'A Luma API key is required.' });
  }

  let calendar;
  try {
    calendar = await new LumaApiService(apiKey).getCalendar();
  } catch (error) {
    if (error instanceof LumaApiError && (error.isAuthFailure || error.isForbidden)) {
      return res.status(422).json({
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
      token_expires_at: NON_EXPIRING_TOKEN_TIMESTAMP,
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
