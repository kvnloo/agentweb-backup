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
import {
  recordInboundMessage,
  recordOptOut,
  recordOptIn,
  redactPhone,
  sendText,
  sendOptOutConfirmation,
  OPT_IN_CONFIRMATION,
} from '../services/whatsappService';
import {
  disconnectWhatsAppForNumber,
  handleVerificationMessage,
  resumeVerificationAfterStart,
} from '../services/whatsappVerificationService';
import { handleApprovalButtonTap, lookupApprovalMessage } from '../services/approvalChannelNotifier';
import { notifyOwnerUnreachable } from '../services/whatsappOwnerNotices';
import { handleUnrecognizedMessage } from '../services/whatsappInboundSupport';

const router = express.Router();

/** Log a failed delivery receipt by message id and Meta error code. Never the number. */
async function handleFailedStatus(status: any): Promise<void> {
  if (status?.status !== 'failed') return;
  const err = status?.errors?.[0];
  console.error(
    `[whatsapp-webhook] outbound message …${String(status?.id ?? 'unknown').slice(-8)} FAILED to deliver ` +
      `(code ${err?.code ?? 'unknown'}: ${err?.title ?? err?.message ?? 'no detail'})`,
  );
  // The send API only confirms ACCEPTANCE. If the dropped message was an approval request,
  // its owner would otherwise wait for ever, so tell them by email. Best-effort: this is a
  // delivery receipt, and nothing here may fail the webhook or open a service window.
  try {
    const ref = status?.id ? await lookupApprovalMessage(String(status.id)) : null;
    if (ref?.userId) {
      // Only while that approval is still waiting. A receipt for one already answered, or
      // cancelled by STOP, would make the email say results are "on hold" when they are not.
      const { approvalDb } = await import('../services/approvalDb');
      const approval = await approvalDb.getApproval(ref.assetUrl);
      if (approval && approval.userId === ref.userId && approval.status === 'pending') {
        await notifyOwnerUnreachable(ref.userId);
      }
    }
  } catch (e) {
    console.warn(
      '[whatsapp-webhook] could not act on a failed delivery receipt:',
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Opt-out keywords must match the WHOLE message, not appear anywhere in it —
 * "please stop by the office tomorrow" is not an opt-out request, and treating it
 * as one silently cuts a customer off from every future notification.
 */
const STOP_KEYWORDS = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'stop all',
  'please stop',
  'stop please',
  'stop messages',
]);
const START_KEYWORDS = new Set(['unstop', 'start', 'resubscribe']);

/**
 * Lower-case, trim, and drop trailing punctuation so "Stop." and "STOP!" are the same
 * request as "stop". Still a whole-message match: "please stop by the office" is not.
 */
const normalizeKeyword = (text: string): string =>
  text
    // NFKC folds fullwidth letters ("ＳＴＯＰ") to ASCII.
    .normalize('NFKC')
    .toLowerCase()
    // Anything that is not a letter, digit or space — punctuation, quotes, emoji, zero-width
    // characters — is noise around the word: "Stop 🛑", "\"stop\"" and "stop…" all mean stop.
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

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
  let ourPhoneNumberId: string;
  try {
    raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));

    const { appSecret, phoneNumberId } = await getWhatsAppCredentials();
    // String(): the secret is plain JSON.parse output, so a phoneNumberId written as a
    // JSON number would never strictly equal Meta's string id and every event would be
    // dropped. Meta always sends it as a string.
    ourPhoneNumberId = String(phoneNumberId).trim();
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
        // One Meta app can serve several business numbers, and the app-level callback
        // receives events for ALL of them, all signed with the same app secret. The
        // signature therefore says "from Meta", not "for this environment": the sandbox
        // test number's traffic arrives here too once the app points at production. Only
        // the number this environment sends from is ours to act on. Anything else is
        // acknowledged (a retry would only be dropped again) and ignored. A change with no
        // phone_number_id cannot be attributed, so it is ignored too.
        const target = change?.value?.metadata?.phone_number_id;
        if (target == null || String(target) !== ourPhoneNumberId) {
          if (change?.value?.messages?.length || change?.value?.statuses?.length) {
            console.warn(
              target == null
                ? '[whatsapp-webhook] ignoring an event that does not say which number it is for'
                : `[whatsapp-webhook] ignoring an event for another number (phone_number_id …${String(target).slice(-4)})`,
            );
          }
          continue;
        }
        // `statuses` are OUR outbound messages being delivered/read. They are never
        // treated as inbound — that would open a service window and let us send free-form
        // text to someone who never wrote to us. A FAILED one is only logged, loudly: the
        // send API confirms acceptance, not delivery, so this is the one place a message
        // that was accepted and then dropped can be seen.
        for (const status of change?.value?.statuses ?? []) {
          await handleFailedStatus(status);
        }
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

/**
 * A tapped button, in whichever of the two shapes Meta sends.
 *
 * Non-template interactive buttons return the `id` WE set, which is the useful case.
 * TEMPLATE quick-replies do not: Meta fills `button.payload` with the button's own
 * LABEL, so the label is all that comes back and the action has to be inferred from it.
 * Either way the only link to what was being approved is `context.id` — the id of the
 * message the button sat on — so a tap without it cannot be attributed and is ignored.
 */
function readButtonTap(
  message: any,
): { action: string; contextMessageId: string } | null {
  const contextMessageId = message?.context?.id;
  if (typeof contextMessageId !== 'string' || !contextMessageId) return null;

  if (message?.type === 'interactive' && message?.interactive?.type === 'button_reply') {
    const action = message.interactive.button_reply?.id;
    return typeof action === 'string' && action ? { action, contextMessageId } : null;
  }

  if (message?.type === 'button') {
    const action = message.button?.payload ?? message.button?.text;
    return typeof action === 'string' && action ? { action, contextMessageId } : null;
  }

  return null;
}

/**
 * What a media message carries that the team needs to act on it: its caption, and enough
 * to find the file (its type, filename and Meta's media id). The file itself is not
 * fetched or attached — downloading needs the Graph token and would put customer media in
 * email — so the hand-off says where to look instead of just "[image message]".
 */
const MEDIA_KINDS = new Set(['image', 'document', 'audio', 'video']);

function readMediaDetails(message: any): { caption: string; detail: string } {
  const kind = message?.type;
  // Text messages also carry an object under their own type (`text: { body }`), so the
  // kind has to be a media one — otherwise plain text is described as an attachment.
  if (typeof kind !== 'string' || !MEDIA_KINDS.has(kind)) return { caption: '', detail: '' };
  const media = message?.[kind];
  if (!media || typeof media !== 'object') return { caption: '', detail: '' };
  const caption = typeof media.caption === 'string' ? media.caption : '';
  const parts: string[] = [String(kind)];
  if (typeof media.filename === 'string' && media.filename) parts.push(`file "${media.filename}"`);
  if (typeof media.id === 'string' && media.id) parts.push(`media id ${media.id}`);
  return { caption, detail: parts.join(', ') };
}

async function handleInboundMessage(message: any): Promise<void> {
  const from = message?.from;
  if (typeof from !== 'string' || !from) return;
  const phone = toKeyPhone(from);

  // Any inbound message opens the 24-hour service window, including a STOP —
  // that is what makes the opt-out confirmation deliverable.
  await recordInboundMessage(phone);

  // A tapped button carries no text body, so it must be read before the text branches
  // below — otherwise it falls through to the verification parser and is dropped.
  const tap = readButtonTap(message);
  if (tap) {
    await handleApprovalButtonTap({
      phone,
      approvalMessageId: tap.contextMessageId,
      action: tap.action,
    });
    return;
  }

  const text: string = message?.text?.body ?? '';
  const normalized = normalizeKeyword(text);
  if (STOP_KEYWORDS.has(normalized)) {
    await recordOptOut(phone);
    console.log(`[whatsapp-webhook] opt-out recorded for ${redactPhone(phone)}`);
    // STOP also ends the connection: the account that held this number drops to "no
    // platform" on its own, so nothing is left half-connected and nobody has to disconnect
    // it by hand. Done BEFORE the confirmation so a Meta redelivery after a failure here
    // does not send the confirmation twice. A storage error throws, so the webhook 500s.
    const disconnectedUserId = await disconnectWhatsAppForNumber(phone);
    if (disconnectedUserId) {
      console.log(
        `[whatsapp-webhook] WhatsApp disconnected from user ${disconnectedUserId} after STOP from ${redactPhone(phone)}`,
      );
    }
    // Acknowledged only AFTER the opt-out is recorded, and never allowed to throw:
    // recording is the compliance-critical half, and a silent STOP is indistinguishable
    // — to the person who sent it — from one that was dropped on the floor.
    await sendOptOutConfirmation(phone).catch((e) =>
      console.warn(
        `[whatsapp-webhook] opt-out confirmation to ${redactPhone(phone)} failed:`,
        e instanceof Error ? e.message : e,
      ),
    );
  } else if (START_KEYWORDS.has(normalized)) {
    await recordOptIn(phone, 'unstop_keyword');
    console.log(`[whatsapp-webhook] opt-in recorded for ${redactPhone(phone)}`);
    // If the customer had already typed a connection code while still opted out, START
    // finishes that connection (and replies "You're connected"), so they do not have to type
    // the code again. A storage error throws and the webhook 500s; every step is idempotent.
    const connected = await resumeVerificationAfterStart(phone);
    if (!connected) {
      // Plain sendText here, not the opt-out bypass: by this point the number is opted
      // back in, so the ordinary guards are exactly the ones that should apply.
      await sendText(phone, OPT_IN_CONFIRMATION).catch((e) =>
        console.warn(
          `[whatsapp-webhook] opt-in confirmation to ${redactPhone(phone)} failed:`,
          e instanceof Error ? e.message : e,
        ),
      );
    }
  } else {
    // "Verify <CODE>" binds this sender's number to the portal user who holds the code.
    // A fixed command only. Anything else is handed to the support hand-off (a fixed
    // greeting plus a forward to the team, no model involved), so this never becomes an
    // AI conversation.
    const wasVerification = await handleVerificationMessage(text, phone);
    if (!wasVerification) {
      // Not a command at all. Greet, and pass the message to the team — a fixed reply
      // and an email, never a model, so this stays a support hand-off and not a chat.
      const media = readMediaDetails(message);
      await handleUnrecognizedMessage(phone, text || media.caption, message?.type ?? 'text', media.detail, message?.id);
    }
  }
}

export default router;
