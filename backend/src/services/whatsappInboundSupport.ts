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

const COUNTER_ATTEMPTS = 5;

/**
 * Count this forward against the number's hourly allowance.
 *
 * Each increment is a compare-and-swap against the value that was read, so a burst of
 * simultaneous messages cannot all pass the same read and all write the same count: the
 * loser of a swap re-reads and tries again. The one gap is the very first message of an
 * hour, which creates the row with an unconditional write (there is nothing yet to compare
 * against), so two such messages can both create it — an over-admission of one, bounded.
 *
 * Fails OPEN: a fault in the limiter must never cost a customer their message.
 */
async function withinForwardLimit(phone: string): Promise<boolean> {
  const key = forwardCountKey(phone);
  // Epoch SECONDS, and past the hour the key names so it cannot expire mid-window.
  const ttl = () => Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  try {
    for (let attempt = 0; attempt < COUNTER_ATTEMPTS; attempt++) {
      const row = await settingsService.getSetting(key);
      if (!row?.settingValue) {
        await settingsService.setSetting(key, '1', 'WhatsApp support forwards this hour', 'system', ttl());
        return true;
      }
      const used = Number.parseInt(row.settingValue, 10) || 0;
      if (used >= FORWARDS_PER_HOUR) return false;
      try {
        await settingsService.setSettingIfValueMatches(
          key,
          String(used + 1),
          row.settingValue,
          'WhatsApp support forwards this hour',
          'system',
          ttl(),
        );
        return true;
      } catch (error: any) {
        // Lost the swap to a concurrent message: re-read and try again.
        if (error?.code !== 'ConditionalCheckFailedException') throw error;
      }
    }
    // Contended past our patience. Admit it rather than drop a customer's message.
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

async function forwardToTeam(
  phone: string,
  text: string,
  messageType: string,
  mediaDetail: string,
): Promise<void> {
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
  // Media is not attached to the email, so say what it is and where to find it.
  const attachment = mediaDetail
    ? `Attachment: ${mediaDetail}. The file is not attached to this email; open the conversation in WhatsApp Manager to view it.`
    : '';
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
    `From: ${phone}\nAccount: ${account}\n\n${body}${attachment ? `\n\n${attachment}` : ''}`,
    `<p><strong>From:</strong> ${escapeHtml(phone)}<br><strong>Account:</strong> ${escapeHtml(account)}</p>` +
      `<blockquote>${escapeHtml(body).replace(/\n/g, '<br>')}</blockquote>` +
      (attachment ? `<p>${escapeHtml(attachment)}</p>` : ''),
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
  mediaDetail: string = '',
  messageId?: string,
): Promise<void> {
  // A reaction or a delivery artefact is not someone asking for help.
  if (!['text', 'image', 'document', 'audio', 'video'].includes(messageType)) return;

  // Meta redelivers a whole payload when any message in it fails, and can deliver the
  // same message twice. Claim the message id first so a redelivery cannot forward it, or
  // greet the sender, a second time. A failed claim write fails open: better a duplicate
  // than a lost customer message.
  if (messageId) {
    try {
      const first = await settingsService.setSettingIfAbsent(
        `whatsapp:inbound-msg:${messageId}`,
        '1',
        'WhatsApp inbound message already handled (dedupe)',
        'system',
        Math.floor(Date.now() / 1000) + 24 * 60 * 60,
      );
      if (!first) return;
    } catch (e) {
      console.warn(
        '[whatsapp-support] could not record the message id; continuing:',
        e instanceof Error ? e.message : e,
      );
    }
  }

  await forwardToTeam(phone, text, messageType, mediaDetail).catch((e) =>
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
