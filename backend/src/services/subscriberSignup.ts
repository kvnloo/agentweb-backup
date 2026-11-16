/**
 * ENG-2991: the parts of the public subscriber sign-up that are not routing.
 *  - which addresses the public form will email (a strict, linear-time check with a length cap: the old pattern backtracked badly on long
 *    input and the body limit is 50 MB);
 *  - how many confirmation emails one address, one mailbox and one task can trigger (the form is public and the email goes out from the
 *    task owner's sender, so it must not be usable as a mail relay);
 *  - the pages the confirmation link shows.
 * The limits are kept in memory per backend instance, like the other limiters in this API; production runs one instance.
 */

// local part: 1-64 characters, no leading, trailing or doubled dot; domain: labels of letters, digits and inner dashes; a top-level domain of
// letters (or the punycode form of an international one)
const ADDRESS = /^(?!\.)(?!.*\.\.)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}(?<!\.)@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;
/** RFC 5321 limit for a mailbox address. */
export const MAX_SIGNUP_EMAIL_LENGTH = 254;

export type SignupEmail = { ok: true; email: string } | { ok: false; reason: 'missing' | 'invalid' };

/** The address typed into the public sign-up form: a plain string, trimmed, within the length limit, of a shape we are willing to email. */
export function parseSignupEmail(value: unknown): SignupEmail {
  if (value === undefined || value === null || value === '') return { ok: false, reason: 'missing' };
  if (typeof value !== 'string') return { ok: false, reason: 'invalid' };
  const email = value.trim();
  if (!email) return { ok: false, reason: 'missing' };
  if (email.length > MAX_SIGNUP_EMAIL_LENGTH || !ADDRESS.test(email)) return { ok: false, reason: 'invalid' };
  return { ok: true, email };
}

/**
 * An address that is already stored (unsubscribe, resubscribe): any non-empty string of a sane length. Deliberately not the sign-up pattern,
 * because an address stored by an import or an older form must always be able to unsubscribe.
 */
export function isStoredEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 320;
}

/** The mailbox behind an address, so `v+1@x.com`, `V@X.com` and (for Gmail) `v.@gmail.com` count as one for the send limits. */
export function canonicalMailbox(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

const HOUR = 60 * 60 * 1000;
/**
 * How many confirmation emails may go out. A cap tied to one address is "quiet": the form answers as for any sign-up, so it cannot be used
 * to find out who subscribes. The others (a whole task, an owner, everyone) are "visible": the form says to try again later, so a person is
 * not left waiting for an email that was never sent.
 */
const CAPS = (taskId: string, ownerId: string, mailbox: string) => [
  { key: `pair:${taskId}:${mailbox}`, limit: 1, windowMs: 30 * 60 * 1000, visible: false },
  { key: `mailbox:${mailbox}`, limit: 5, windowMs: HOUR, visible: false },
  { key: `task:${taskId}`, limit: 300, windowMs: HOUR, visible: true },
  { key: `owner:${ownerId}`, limit: 600, windowMs: HOUR, visible: true },
  { key: 'all', limit: 3000, windowMs: HOUR, visible: true },
];
const sendLog = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number) {
  if (sendLog.size <= 5000 || now - lastSweep < 60 * 1000) return;
  lastSweep = now;
  // Forget what has aged out of every window. The whole-service cap (3000 an hour) bounds how many live keys one hour can create, so the map
  // cannot grow without limit between sweeps.
  for (const [k, times] of sendLog) {
    const fresh = times.filter((t) => now - t < HOUR);
    if (fresh.length === 0) sendLog.delete(k);
    else sendLog.set(k, fresh);
  }
}

export type JoinReservation = { ok: true; release: () => void } | { ok: false; visible: boolean };

/**
 * Reserve the right to send one confirmation email. When a cap is reached the caller answers (quietly, or visibly, see CAPS) and sends
 * nothing; otherwise `release` gives the slot back when the email could not be sent.
 */
export function reserveJoinConfirmation(taskId: string, email: string, ownerId: string, now = Date.now()): JoinReservation {
  sweep(now);
  const caps = CAPS(String(taskId), String(ownerId), canonicalMailbox(email));
  const fresh = (key: string, windowMs: number) => (sendLog.get(key) || []).filter((t) => now - t < windowMs);
  const tripped = caps.find((c) => fresh(c.key, c.windowMs).length >= c.limit);
  if (tripped) {
    console.warn(JSON.stringify({ event: 'subscriber_join_throttled', cap: tripped.key.split(':')[0], taskId: String(taskId) }));
    return { ok: false, visible: tripped.visible };
  }
  for (const c of caps) sendLog.set(c.key, [...fresh(c.key, c.windowMs), now]);
  return {
    ok: true,
    release: () => {
      for (const c of caps) {
        const times = sendLog.get(c.key);
        const i = times ? times.lastIndexOf(now) : -1;
        if (times && i >= 0) times.splice(i, 1);
      }
    },
  };
}

/** For tests: forget every reservation. */
export function resetJoinConfirmationLimits(): void {
  sendLog.clear();
  lastSweep = 0;
}

/** For tests: how many counters are being kept. */
export function trackedJoinKeyCount(): number {
  return sendLog.size;
}

const escapeHtmlText = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export interface ConfirmPageOptions {
  title: string;
  message: string;
  /** A confirm button: a POST to `action` with the signed token in a hidden field. */
  form?: { action: string; token: string; button: string };
}

/** The small standalone page behind the confirmation link (a full document, so no portal is needed). */
export function renderConfirmPage({ title, message, form }: ConfirmPageOptions): string {
  const button = form
    ? `<form method="post" action="${escapeHtmlText(form.action)}" style="margin: 24px 0 0;"><input type="hidden" name="token" value="${escapeHtmlText(form.token)}"><button type="submit" style="background: #3b82f6; color: #fff; border: 0; padding: 12px 22px; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer;">${escapeHtmlText(form.button)}</button></form>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtmlText(title)}</title></head><body style="font-family: Arial, sans-serif; background: #f8f9fa; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0;"><div style="background: #fff; padding: 32px; border-radius: 8px; max-width: 480px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,.1);"><h2 style="color: #1B2549; margin-top: 0;">${escapeHtmlText(title)}</h2><p style="color: #333; line-height: 1.6;">${escapeHtmlText(message)}</p>${button}</div></body></html>`;
}
