/**
 * ENG-720: surface hard email bounces as a durable account flag, and detect
 * active accounts whose email domain no longer resolves.
 *
 * The Resend webhook (routes/webhooks.ts, email.bounced) already suppresses
 * bounced CRM *leads*; this covers the other half — the *account* whose own
 * address bounces, which previously produced no operational signal at all.
 * Repairing/contacting a flagged customer stays a human/CS action.
 */

import { promises as dns } from 'dns';
import { userDb } from './db';

const TAG = '[emailDeliverability]';

export type BounceClass = 'hard' | 'soft' | 'unknown';

export interface ResendBounceInfo {
  type?: string;
  subType?: string;
  reason?: string;
}

/**
 * Pure classifier. Hard = permanent failure (Resend "Permanent" type/subType
 * or a 5.x.x enhanced status / 5xx SMTP code in the reason). Soft = transient
 * ("Transient" or 4.x.x/4xx). Anything else is unknown and is NOT treated as
 * hard — one ambiguous bounce must never flag a working account (AC5).
 */
export function classifyResendBounce(bounce: ResendBounceInfo | undefined): BounceClass {
  if (!bounce) return 'unknown';
  const kind = (bounce.type || bounce.subType || '').toLowerCase();
  if (kind === 'permanent') return 'hard';
  if (kind === 'transient' || kind === 'undetermined') return 'soft';
  const reason = bounce.reason || '';
  if (/\b5\.\d+\.\d+\b/.test(reason) || /\b5\d\d\b/.test(reason)) return 'hard';
  if (/\b4\.\d+\.\d+\b/.test(reason) || /\b4\d\d\b/.test(reason)) return 'soft';
  return 'unknown';
}

/**
 * Durably flag the account owning `recipientEmail` as undeliverable. Flag
 * only — never deactivates the account. Idempotent: an already-flagged
 * account is left as-is so the original bounce evidence is preserved.
 * Returns true when a flag was written.
 */
export async function flagUserEmailUndeliverable(
  recipientEmail: string,
  reason: string,
  source: string
): Promise<boolean> {
  const user = await userDb.getUserByEmail(recipientEmail.toLowerCase());
  if (!user) return false;
  if ((user as any).emailUndeliverable) return false;

  await userDb.updateUser(user.userId, {
    emailUndeliverable: true,
    emailUndeliverableReason: reason,
    emailUndeliverableSource: source,
    emailUndeliverableAt: new Date().toISOString(),
  });
  console.log(`${TAG} flagged account ${user.userId} (${recipientEmail}) undeliverable: ${reason}`);
  return true;
}

/**
 * Webhook wire-in: given the recipients of a bounced send and the bounce
 * payload, flag matching accounts when — and only when — the bounce is hard.
 * Never throws; a failure for one recipient does not stop the others.
 */
export async function handleHardBounceRecipients(
  recipients: string[],
  bounce: ResendBounceInfo | undefined
): Promise<void> {
  if (classifyResendBounce(bounce) !== 'hard') return;
  const reason = bounce?.reason || 'hard bounce';
  for (const recipient of recipients) {
    try {
      await flagUserEmailUndeliverable(recipient, reason, 'resend-webhook');
    } catch (err) {
      console.error(`${TAG} failed to flag ${recipient}:`, err);
    }
  }
}

// ─── MX sweep (AC4 — report only) ────────────────────────────────────────────

// Definitive "this domain cannot receive mail" codes. Transient resolver
// failures (timeouts, SERVFAIL, refused) go to `errors` instead — a DNS blip
// must not report a working customer as undeliverable (AC5).
const HARD_DNS_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export interface MxSweepReport {
  activeUsersChecked: number;
  domainsChecked: number;
  undeliverable: Array<{
    domain: string;
    error: string;
    users: Array<{ userId: string; email: string }>;
  }>;
  errors: Array<{ domain: string; error: string }>;
}

export async function sweepUndeliverableDomains(deps?: {
  resolveMx?: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
}): Promise<MxSweepReport> {
  const resolveMx = deps?.resolveMx || ((domain: string) => dns.resolveMx(domain));
  const allUsers = await userDb.getAllUsers();
  const active = (allUsers || []).filter(
    (u: any) => u.isActive !== false && typeof u.email === 'string' && u.email.includes('@')
  );

  const byDomain = new Map<string, Array<{ userId: string; email: string }>>();
  for (const user of active) {
    const domain = user.email.split('@')[1]?.toLowerCase();
    if (!domain) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain)!.push({ userId: user.userId, email: user.email });
  }

  const report: MxSweepReport = {
    activeUsersChecked: active.length,
    domainsChecked: byDomain.size,
    undeliverable: [],
    errors: [],
  };

  for (const [domain, users] of byDomain) {
    try {
      const records = await resolveMx(domain);
      if (!records || records.length === 0) {
        report.undeliverable.push({ domain, error: 'no MX records', users });
      }
    } catch (err: any) {
      const code = err?.code || '';
      if (HARD_DNS_CODES.has(code)) {
        report.undeliverable.push({ domain, error: `${code}: ${err.message}`, users });
      } else {
        report.errors.push({ domain, error: `${code || 'ERR'}: ${err?.message || err}` });
      }
    }
  }

  return report;
}
