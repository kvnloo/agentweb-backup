/**
 * Per-user messaging channel configuration (ENG-273).
 *
 * Deliberately user-facing, unlike Slack channel mapping which is admin-managed in
 * routes/admin.ts. The difference is consent: a Slack channel is a shared room an
 * admin assigns, whereas a WhatsApp destination is someone's personal phone and Meta
 * requires recorded opt-in from that person before the first outbound message. An
 * admin cannot consent on a customer's behalf.
 *
 * There is no "save this number" endpoint, on purpose. A number the user merely typed
 * proves nothing: it may be a typo, or a stranger's, and AgentWeb messages from one
 * shared business number whose quality rating a single unwanted message can damage.
 * Instead the user starts a verification, messages a one-time code to AgentWeb's
 * WhatsApp number, and the webhook binds the SENDER's number to them
 * (whatsappVerificationService). Only that path writes a WhatsApp entry.
 *
 * Writes go through userDb.updateUser on the additive `messagingChannels` field. The
 * legacy slack* fields are never touched here — they stay authoritative for Slack and
 * are folded in at read time by messagingChannelService.normalizeUserChannels.
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { explicitChannels, normalizeUserChannels } from '../services/messagingChannelService';
import { getDisplayPhoneNumber, isOptedOut } from '../services/whatsappService';
import {
  disconnectWhatsApp,
  getVerificationStatus,
  startVerification,
} from '../services/whatsappVerificationService';
import {
  assertCanConnect,
  getPlatformSummary,
  PlatformConflictError,
} from '../services/customerChannelPolicy';

const router = express.Router();

/** GET / — the caller's configured channels, including legacy Slack, normalized. */
router.get('/', authenticateToken, async (req: any, res: any) => {
  try {
    const user = await userDb.getUserById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const channels = normalizeUserChannels(user);
    // Surface the platform-level opt-out alongside the user's own config: a contact
    // who texted STOP is unreachable regardless of what this record says, and the UI
    // must be able to explain that rather than showing a healthy-looking row.
    const enriched = await Promise.all(
      channels.map(async (c) => ({
        ...c,
        ...(c.channel === 'whatsapp'
          ? { optedOut: await isOptedOut(c.destination), verified: !!c.optIn?.verifiedAt }
          : {}),
      })),
    );
    // Which single platform this account is on (ENG-273), from the same policy that
    // refuses a second one — so the portal can explain up front why WhatsApp is not
    // offered to a Slack customer instead of letting them hit the refusal.
    const summary = await getPlatformSummary(user);
    res.json({
      success: true,
      channels: enriched,
      platform: summary.platform,
      platformSource: summary.source,
    });
  } catch (error: any) {
    console.error('[messaging-channels] list failed:', error);
    res.status(500).json({ error: 'Failed to load messaging channels' });
  }
});

/**
 * POST /whatsapp/verification — begin connecting a WhatsApp number.
 *
 * Requires the explicit opt-in acknowledgement in the same request: Meta requires
 * recorded consent before the first outbound message, and the portal copy must name
 * AgentWeb and say what will be sent. The acknowledgement time is kept and becomes the
 * saved entry's `optIn.at`; the verification message itself is the proof of control.
 *
 * Returns the code and a wa.me link that opens WhatsApp with "Verify <CODE>" already
 * typed. The code is a short-lived credential, so the response must never be cached.
 */
router.post('/whatsapp/verification', authenticateToken, async (req: any, res: any) => {
  try {
    if (req.body?.optIn !== true) {
      return res.status(400).json({
        error:
          'Explicit opt-in is required before WhatsApp messages can be sent to this number.',
      });
    }

    // One platform per customer: an account already on Slack cannot also connect
    // WhatsApp. Checked before a code is issued, so they are told now rather than after
    // texting a code that would then be refused.
    const account = await userDb.getUserById(req.user.userId);
    try {
      await assertCanConnect(account, 'whatsapp');
    } catch (conflict: any) {
      if (conflict instanceof PlatformConflictError) {
        return res.status(409).json({ error: conflict.message, code: 'platform_conflict', connected: conflict.connected });
      }
      throw conflict;
    }

    // Resolve the business number BEFORE issuing a code, so a failure here does not
    // leave a live code the user has no way to use.
    let displayDigits: string;
    try {
      displayDigits = await getDisplayPhoneNumber();
    } catch (error: any) {
      console.error('[messaging-channels] display number unavailable:', error?.message ?? error);
      return res.status(503).json({ error: 'WhatsApp is not available right now. Try again shortly.' });
    }

    const { code, expiresAt } = await startVerification(req.user.userId, new Date().toISOString());
    const message = `Verify ${code}`;
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      code,
      expiresAt,
      message,
      displayNumber: `+${displayDigits}`,
      link: `https://wa.me/${displayDigits}?text=${encodeURIComponent(message)}`,
    });
  } catch (error: any) {
    console.error('[messaging-channels] whatsapp verification start failed:', error);
    res.status(500).json({ error: 'Failed to start WhatsApp verification' });
  }
});

/**
 * GET /whatsapp/verification — where the caller's verification stands. Polled by the
 * portal while the user is in WhatsApp sending the code.
 */
router.get('/whatsapp/verification', authenticateToken, async (req: any, res: any) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...(await getVerificationStatus(req.user.userId)) });
  } catch (error: any) {
    console.error('[messaging-channels] whatsapp verification status failed:', error);
    res.status(500).json({ error: 'Failed to load WhatsApp verification status' });
  }
});

/**
 * DELETE /whatsapp — stop sending to the caller's WhatsApp number.
 *
 * Removes the destination rather than disabling it. This is a user asking us to stop
 * holding their phone number, so keeping a disabled copy would be the wrong answer.
 * The platform-level STOP blocklist is separate and deliberately untouched — it
 * outlives this record and must not be cleared by removing a channel.
 */
router.delete('/whatsapp', authenticateToken, async (req: any, res: any) => {
  try {
    const result = await disconnectWhatsApp(req.user.userId);
    if (!result) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, channels: result.channels });
  } catch (error: any) {
    console.error('[messaging-channels] whatsapp delete failed:', error);
    res.status(500).json({ error: 'Failed to remove WhatsApp number' });
  }
});

export default router;
