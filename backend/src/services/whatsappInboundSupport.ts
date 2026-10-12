/**
 * What happens to a WhatsApp message that is not a command (ENG-273).
 *
 * Until now anything other than STOP / UNSTOP / "Verify <CODE>" was dropped in silence,
 * which from the customer's side looks like a dead number. Two things happen instead:
 *
 *  1. A fixed greeting, so they know they reached AgentWeb.
 *  2. Their message is forwarded to the team by email, so "our team will get back to
 *     you" is true rather than decorative.
 *
 * This is deliberately NOT a conversation. The reply is a constant string and no model
 * is involved — the webhook's no-chat-session guard still holds.
 */
import { settingsService } from './settingsService';
import { redactPhone, resolveUserIdByPhone, sendText } from './whatsappService';

export const SUPPORT_GREETING =
  'Thanks for contacting AgentWeb! Please share your query here and our team will get ' +
  'back to you. You can also reach us at founders@agentweb.pro.';

/** One greeting per number per 12h — a customer typing five lines gets it once. */
const GREETING_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const greetedKey = (phone: string) => `whatsapp:greeted:${phone}`;

const INBOX_SETTING = 'whatsapp:support-inbox';

/**
 * Where forwarded messages go, in order of precedence:
 *
 *  1. WHATSAPP_SUPPORT_INBOX — an explicit deploy-time choice.
 *  2. The `whatsapp:support-inbox` setting — changeable at runtime, so the inbox can be
 *     pointed at a real support address (or switched on for a staging test) without a
 *     deploy or an infrastructure change.
 *  3. In production only, the address the product already publishes.
 *
 * Everywhere else forwarding is off, so a staging test cannot mail the founders.
 */
export async function supportInbox(): Promise<string | null> {
  const configured = process.env.WHATSAPP_SUPPORT_INBOX?.trim();
  if (configured) return configured;
  try {
    const row = await settingsService.getSetting(INBOX_SETTING);
    const fromSetting = row?.settingValue?.trim();
    if (fromSetting) return fromSetting;
  } catch {
    // Fall through to the default rather than lose the customer's message.
  }
  return process.env.NODE_ENV === 'production' ? 'founders@agentweb.pro' : null;
}

/**
 * Forwards per number per hour. Every non-command message becomes an email, so without a
 * cap one number can fill the team's inbox. The greeting already has a cooldown; this is
 * the same idea for the forward. Generous, because a real customer describing a problem
 * can send many short lines, and past it the messages are dropped from the inbox (they
 * are still in the customer's WhatsApp thread).
 */
const FORWARDS_PER_HOUR = 20;
const forwardCountKey = (phone: string) =>
  `whatsapp:forwards:${phone}:${new Date().toISOString().slice(0, 13)}`;

/**
 * Count this forward against the number's hourly allowance. A read-then-write, so two
 * simultaneous messages can both pass at the boundary and the cap can be exceeded by a
 * message or two — acceptable for an abuse limit. Fails OPEN: a fault in the limiter must
 * never cost a customer their message.
 */
async function withinForwardLimit(phone: string): Promise<boolean> {
  try {
    const key = forwardCountKey(phone);
    const row = await settingsService.getSetting(key);
    const used = Number.parseInt(row?.settingValue ?? '0', 10) || 0;
    if (used >= FORWARDS_PER_HOUR) return false;
    await settingsService.setSetting(
      key,
      String(used + 1),
      'WhatsApp support forwards this hour',
      'system',
      // Epoch SECONDS, and past the hour the key names so it cannot expire mid-window.
      Math.floor(Date.now() / 1000) + 2 * 60 * 60,
    );
    return true;
  } catch {
    return true;
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function greetOncePerCooldown(phone: string): Promise<void> {
  const last = await settingsService.getSetting(greetedKey(phone));
  // Decided from the stored timestamp, not from the row existing: DynamoDB TTL deletion
  // lags by hours, so row-existence would stretch the cooldown unpredictably.
  const lastAt = last?.settingValue ? Date.parse(last.settingValue) : NaN;
  if (Number.isFinite(lastAt) && Date.now() - lastAt < GREETING_COOLDOWN_MS) return;

  // sendText enforces opt-out and the service window itself; an opted-out customer
  // simply gets no greeting.
  await sendText(phone, SUPPORT_GREETING);
  await settingsService.setSetting(
    greetedKey(phone),
    new Date().toISOString(),
    'WhatsApp support greeting last sent',
    'system',
    Math.floor((Date.now() + GREETING_COOLDOWN_MS) / 1000),
  );
}

async function forwardToTeam(phone: string, text: string, messageType: string): Promise<void> {
  const inbox = await supportInbox();
  if (!inbox) return;

  if (!(await withinForwardLimit(phone))) {
    console.warn(
      `[whatsapp-support] ${redactPhone(phone)} exceeded ${FORWARDS_PER_HOUR} forwarded messages this hour — not forwarding`,
    );
    return;
  }

  let account = 'not a connected AgentWeb number';
  try {
    const userId = await resolveUserIdByPhone(phone);
    if (userId) {
      const { userDb } = await import('./db');
      const user: any = await userDb.getUserById(userId);
      account = user?.email ? `${user.email} (user ${userId})` : `user ${userId}`;
    }
  } catch {
    // Attribution is a nicety; the message itself must still go through.
  }

  const body = text.trim() || `[${messageType} message — no text]`;
  const { emailService } = await import('./emailService');
  // sendEmail is best-effort and never throws: it RETURNS 'failed'. Catching around it, as
  // an earlier version did, meant a failed forward was completely silent.
  const outcome = await emailService.sendEmail(
    inbox,
    // Masked in the SUBJECT, full in the body. Subjects are logged by the mail layer
    // (the non-prod guard prints every suppressed one), and a customer's phone number
    // must not reach application logs (CWE-532). The team still gets the full number
    // where they need it — inside the message.
    `WhatsApp message from ${redactPhone(phone)}`,
    `From: ${phone}\nAccount: ${account}\n\n${body}`,
    `<p><strong>From:</strong> ${escapeHtml(phone)}<br><strong>Account:</strong> ${escapeHtml(account)}</p>` +
      `<blockquote>${escapeHtml(body).replace(/\n/g, '<br>')}</blockquote>`,
  );

  if (outcome === 'failed') {
    // The customer has been told the team will get back to them, so a lost forward is not
    // a quiet event. Redacted: the log must not carry the number (CWE-532).
    console.error(
      `[whatsapp-support] could not forward a message from ${redactPhone(phone)} to the support inbox`,
    );
  }
}

/**
 * Never throws: a throw becomes a 500, Meta redelivers, and the team would get the same
 * query forwarded twice. The two halves are independent so a failed greeting cannot
 * swallow the forward, or the reverse.
 */
export async function handleUnrecognizedMessage(
  phone: string,
  text: string,
  messageType: string = 'text',
): Promise<void> {
  // A reaction or a delivery artefact is not someone asking for help.
  if (!['text', 'image', 'document', 'audio', 'video'].includes(messageType)) return;

  await forwardToTeam(phone, text, messageType).catch((e) =>
    console.warn(
      `[whatsapp-support] forwarding a message from ${redactPhone(phone)} failed:`,
      e instanceof Error ? e.message : e,
    ),
  );
  await greetOncePerCooldown(phone).catch((e) =>
    console.warn(
      `[whatsapp-support] greeting ${redactPhone(phone)} failed:`,
      e instanceof Error ? e.message : e,
    ),
  );
}
