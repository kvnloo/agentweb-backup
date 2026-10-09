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
  await emailService.sendEmail(
    inbox,
    `WhatsApp message from ${phone}`,
    `From: ${phone}\nAccount: ${account}\n\n${body}`,
    `<p><strong>From:</strong> ${escapeHtml(phone)}<br><strong>Account:</strong> ${escapeHtml(account)}</p>` +
      `<blockquote>${escapeHtml(body).replace(/\n/g, '<br>')}</blockquote>`,
  );
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
