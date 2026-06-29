import express from 'express';
import crypto from 'crypto';

const router = express.Router();

/**
 * Linear webhook -> resolve bridge.
 *
 * When a bug-canonical Linear issue transitions to a completed state, notify every reporter whose
 * private Featurebase card is grouped onto it (intakeService.notifyCanonicalResolved reads the
 * canonical's `[reporter-ticket #N <email>]` comments, emails each reporter, and flips their card
 * to Completed).
 *
 * Mounted with express.raw() in app.ts (BEFORE express.json) so req.body is the raw Buffer —
 * required to verify Linear's HMAC-SHA256 `linear-signature` over the exact payload bytes.
 * Set LINEAR_WEBHOOK_SECRET to enforce the signature (skipped only if unset, e.g. local).
 */
router.post('/linear/webhook', async (req, res) => {
  try {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

    const secret = process.env.LINEAR_WEBHOOK_SECRET || '';
    if (secret) {
      const sig = req.header('linear-signature') || '';
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const ok =
        sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) return res.status(401).json({ error: 'invalid signature' });
    }

    const payload = JSON.parse(raw.toString('utf8'));
    const completed =
      payload?.type === 'Issue' &&
      (payload?.action === 'update' || payload?.action === 'create') &&
      payload?.data?.state?.type === 'completed' &&
      payload?.data?.id;

    if (completed) {
      const { notifyCanonicalResolved } = await import('../services/intakeService');
      const r = await notifyCanonicalResolved(payload.data.id, payload.data.title || undefined);
      return res.json({ ok: true, notified: r.ticketNumbers.length, ticketNumbers: r.ticketNumbers });
    }
    return res.json({ ok: true, notified: 0 });
  } catch (e) {
    // Return 200 so Linear doesn't retry-storm on our own errors; log for diagnosis.
    console.error('[linear-webhook] error:', e instanceof Error ? e.message : e);
    return res.status(200).json({ ok: false });
  }
});

export default router;
