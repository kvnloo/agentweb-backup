/**
 * WhatsApp Cloud API inbound webhook (ENG-273).
 *
 * Mounted with express.raw() in app.ts BEFORE express.json(), alongside the other
 * signed webhooks (Stripe, HubSpot, Linear, Featurebase). The raw Buffer is required:
 * Meta signs the exact payload bytes, and re-serializing a parsed body changes key
 * order and whitespace, so the HMAC would be computed over different bytes.
 *
 * ── Why the signature is not optional here ───────────────────────────────────
 * An unsigned POST to this endpoint would let anyone forge an inbound message. That
 * is not just noise: an inbound message OPENS A 24-HOUR FREE-MESSAGING WINDOW for
 * the sender's number, and a forged "STOP" would silence a real customer. So this
 * route fails closed — no secret, no processing.
 *
 * ── What this route deliberately does NOT do ─────────────────────────────────
 * routes/slack.ts opens an Emma chat session on inbound events. This route must not.
 * Since 2026-01-15 WhatsApp's Business Solution Terms prohibit general-purpose AI
 * assistants where the AI is the primary functionality being provided. Structured
 * notifications and approvals are fine; piping a conversational agent onto WhatsApp
 * is not, and would put AgentWeb's business number at risk. A test in
 * whatsappWebhook.test.ts asserts this file never imports a session-creating service.
 */

import express from 'express';
import crypto from 'crypto';
import { getWhatsAppCredentials } from '../utils/secretsManager';
import { recordInboundMessage, recordOptOut, recordOptIn } from '../services/whatsappService';

const router = express.Router();

/**
 * Opt-out keywords must match the WHOLE message, not appear anywhere in it —
 * "please stop by the office tomorrow" is not an opt-out request, and treating it
 * as one silently cuts a customer off from every future notification.
 */
const STOP_KEYWORDS = new Set(['stop', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_KEYWORDS = new Set(['unstop', 'start', 'resubscribe']);

/** Meta reports `from` without a leading '+'. Normalize so window/opt-out keys agree. */
const toKeyPhone = (from: string): string => (from.startsWith('+') ? from : `+${from}`);

function verifySignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * GET — Meta's subscription challenge. Echoes hub.challenge when the verify token
 * matches the one stored with our credentials.
 */
router.get('/', async (req, res) => {
  try {
    const { webhookVerifyToken } = await getWhatsAppCredentials();
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === webhookVerifyToken) {
      return res.status(200).send(String(challenge ?? ''));
    }
    return res.sendStatus(403);
  } catch (error) {
    console.error('[whatsapp-webhook] verification failed:', error);
    return res.sendStatus(403);
  }
});

/**
 * POST — inbound messages and delivery statuses.
 *
 * Processing happens BEFORE the acknowledgement, deliberately. The work is one or two
 * DynamoDB writes (single-digit ms), well inside Meta's delivery timeout, and acking
 * first would mean a failed write is silently lost — for a STOP, that is a compliance
 * failure we would never learn about.
 *
 * Failure handling splits by kind, because Meta retries non-2xx with backoff:
 *   - unparseable payload  -> 200. It will never succeed; retrying is pure noise.
 *   - handler/storage error -> 500. Transient, and a retry is exactly what we want
 *     for an opt-out we failed to record.
 */
router.post('/', async (req, res) => {
  let raw: Buffer;
  try {
    raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

    const { appSecret } = await getWhatsAppCredentials();
    if (!verifySignature(raw, req.header('X-Hub-Signature-256'), appSecret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
  } catch (error) {
    // Credentials unavailable — fail closed rather than processing unverified input.
    console.error('[whatsapp-webhook] could not verify signature:', error);
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload: any;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    // Poison payload — a retry can only fail the same way.
    console.warn('[whatsapp-webhook] ignoring unparseable payload');
    return res.status(200).json({ ok: false, error: 'unparseable payload' });
  }

  try {
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        // `statuses` are OUR outbound messages being delivered/read. They are
        // deliberately not handled here: treating one as inbound would open a service
        // window and let us send free-form text to someone who never wrote to us.
        for (const message of change?.value?.messages ?? []) {
          await handleInboundMessage(message);
        }
      }
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error(
      '[whatsapp-webhook] processing failed — returning 500 so Meta retries:',
      error instanceof Error ? error.message : error,
    );
    return res.status(500).json({ error: 'processing failed' });
  }
});

async function handleInboundMessage(message: any): Promise<void> {
  const from = message?.from;
  if (typeof from !== 'string' || !from) return;
  const phone = toKeyPhone(from);

  // Any inbound message opens the 24-hour service window, including a STOP —
  // that is what makes the opt-out confirmation deliverable.
  await recordInboundMessage(phone);

  const text: string = message?.text?.body ?? '';
  const normalized = text.trim().toLowerCase();
  if (STOP_KEYWORDS.has(normalized)) {
    await recordOptOut(phone);
    console.log(`[whatsapp-webhook] opt-out recorded for ${phone}`);
  } else if (START_KEYWORDS.has(normalized)) {
    await recordOptIn(phone, 'unstop_keyword');
    console.log(`[whatsapp-webhook] opt-in recorded for ${phone}`);
  }
}

export default router;
