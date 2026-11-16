/**
 * The ONE Meta connection alert: a customer HAD a working Meta connection and it is gone
 * (token expired / invalidated). Requested by Harsha 2026-11-07:
 *  - only real expiries of an existing connection — never "this account should connect Meta"
 *    style inferences from onboarding intent or plan;
 *  - plain facts only, no guessed "next actor" / recommended-action text;
 *  - sent to a fixed ops list (AW-Settings `meta_connection_alert_emails`, default Matt,
 *    Francisco, Manan, Anurag), NOT the founders and NOT the generic oncall list;
 *  - at most once per ad account per week, deduped in DynamoDB so every backend instance
 *    shares it (the old in-memory dedupe re-sent the same alert ~65 times a week).
 */

import { settingsService } from './settingsService';
import { emailService } from './emailService';

export const META_CONNECTION_ALERT_EMAILS_SETTING = 'meta_connection_alert_emails';
export const DEFAULT_META_CONNECTION_ALERT_EMAILS = [
  'matthew@agentweb.pro',
  'francisco@agentweb.pro',
  'mvarma@argusoft.com',
  'aseth@argusoft.com',
];
export const META_CONNECTION_ALERT_DEDUPE_SECONDS = 7 * 24 * 60 * 60;

export interface MetaConnectionExpiredInput {
  accountId: string;
  accountName?: string;
  customerEmail?: string;
  userId?: string;
  /** Epoch ms the stored token expired, when known. */
  expiredAt?: number;
  /** Meta's error, verbatim. */
  error?: string;
  now?: number;
}

/** Returns true only when an email was actually sent. Never throws. */
export async function sendMetaConnectionExpiredAlert(input: MetaConnectionExpiredInput): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production') return false;
  const now = input.now ?? Date.now();
  try {
    const claimed = await settingsService.setSettingIfAbsent(
      `meta_connection_expired_alert:${input.accountId}`,
      new Date(now).toISOString(),
      'Dedupe marker for the Meta connection expired alert',
      'system',
      Math.floor(now / 1000) + META_CONNECTION_ALERT_DEDUPE_SECONDS,
    );
    if (!claimed) return false;

    const recipients = await settingsService.getJsonArraySetting<string>(
      META_CONNECTION_ALERT_EMAILS_SETTING,
      DEFAULT_META_CONNECTION_ALERT_EMAILS,
    );
    const who = input.customerEmail || input.userId || 'unknown customer';
    const account = `${input.accountName || 'Meta ad account'} (${input.accountId})`;
    const lines = [
      `Customer: ${who}`,
      `Ad account: ${account}`,
      `Token expired: ${input.expiredAt ? new Date(input.expiredAt).toISOString() : 'unknown'}`,
      `Meta error: ${input.error || 'none recorded'}`,
    ];
    const subject = `Meta connection expired: ${who} — ${account}`;
    const text = lines.join('\n');
    const html = `<div style="font-family: Arial, sans-serif;">${lines
      .map((l) => `<p style="margin:4px 0;">${emailService.escapeHtml(l)}</p>`)
      .join('')}</div>`;
    return (await emailService.sendEmail(recipients, subject, text, html)) === 'sent';
  } catch (error) {
    console.error(`[MetaConnectionExpiredAlert] failed for ${input.accountId}:`, error);
    return false;
  }
}
