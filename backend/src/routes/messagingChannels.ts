/**
 * Per-user messaging channel configuration (ENG-273).
 *
 * Deliberately user-facing, unlike Slack channel mapping which is admin-managed in
 * routes/admin.ts. The difference is consent: a Slack channel is a shared room an
 * admin assigns, whereas a WhatsApp destination is someone's personal phone and Meta
 * requires recorded opt-in from that person before the first outbound message. An
 * admin cannot consent on a customer's behalf.
 *
 * Writes go through userDb.updateUser on the additive `messagingChannels` field. The
 * legacy slack* fields are never touched here — they stay authoritative for Slack and
 * are folded in at read time by messagingChannelService.normalizeUserChannels.
 */

import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { userDb } from '../services/db';
import { normalizeUserChannels } from '../services/messagingChannelService';
import { toE164, isOptedOut } from '../services/whatsappService';

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
        ...(c.channel === 'whatsapp' ? { optedOut: await isOptedOut(c.destination) } : {}),
      })),
    );
    res.json({ success: true, channels: enriched });
  } catch (error: any) {
    console.error('[messaging-channels] list failed:', error);
    res.status(500).json({ error: 'Failed to load messaging channels' });
  }
});

/**
 * PUT /whatsapp — set (or replace) the caller's WhatsApp destination.
 *
 * Requires an explicit opt-in acknowledgement in the same request. Meta requires
 * recorded consent before the first outbound message, and accepting a phone number
 * without it would create a destination we are not allowed to message.
 */
router.put('/whatsapp', authenticateToken, async (req: any, res: any) => {
  try {
    const { phone, optIn, source } = req.body ?? {};

    if (optIn !== true) {
      return res.status(400).json({
        error:
          'Explicit opt-in is required before WhatsApp messages can be sent to this number.',
      });
    }

    const e164 = typeof phone === 'string' ? toE164(phone) : null;
    if (!e164) {
      return res.status(400).json({
        error:
          'Enter a valid phone number including its country code (for example +1 415 555 0123).',
      });
    }

    const user = await userDb.getUserById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Replace any existing WhatsApp entry; keep every other channel untouched.
    const others = normalizeUserChannels(user).filter((c) => c.channel !== 'whatsapp');
    const messagingChannels = [
      ...others,
      {
        channel: 'whatsapp' as const,
        destination: e164,
        enabled: true,
        optIn: {
          at: new Date().toISOString(),
          source: typeof source === 'string' && source ? source : 'settings_ui',
        },
      },
    ];

    await userDb.updateUser(req.user.userId, { messagingChannels } as any);
    res.json({ success: true, channels: messagingChannels });
  } catch (error: any) {
    console.error('[messaging-channels] whatsapp save failed:', error);
    res.status(500).json({ error: 'Failed to save WhatsApp number' });
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
    const user = await userDb.getUserById(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const messagingChannels = normalizeUserChannels(user).filter((c) => c.channel !== 'whatsapp');
    await userDb.updateUser(req.user.userId, { messagingChannels } as any);
    res.json({ success: true, channels: messagingChannels });
  } catch (error: any) {
    console.error('[messaging-channels] whatsapp delete failed:', error);
    res.status(500).json({ error: 'Failed to remove WhatsApp number' });
  }
});

export default router;
