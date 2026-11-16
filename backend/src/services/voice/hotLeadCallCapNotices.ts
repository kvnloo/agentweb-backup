import { getLimitStore } from './limitStore';
import { localMonth, limitTimeZone, MONTH_TTL_S } from './hotLeadCallLimits';
import type { HotLeadCallConfig } from '../hotLeadCallConfig';

/**
 * Customer and alarm notices of the monthly cap (ENG-2783). The org owner gets ONE email at 80% and ONE at 100% of the
 * cap per org-local month, de-duplicated by a claim in the limit store (hlc#notify#80# / hlc#notify#100#). Best-effort
 * by construction: nothing here ever throws, and the call path does not await it.
 */

type NoticePercent = 80 | 100;

// The error's name only: a send error's message can carry the recipient's address. Kept local rather than imported from
// callFinalisation.ts, whose imports (db, attempts, usage metering) this lazily loaded path must not pull in.
const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'error');

export const noticeKey = (percent: NoticePercent, orgId: string, month: string): string => `hlc#notify#${percent}#${orgId}#${month}`;
/** The count at which the 80% notice is due: ceil(0.8 * cap), written in integers so 0.8 * 5 never lands on 4.000000001. */
export const eightyPercentOf = (cap: number): number => Math.ceil((cap * 4) / 5);

export const noticeCopy = {
  80: (used: number, cap: number) => ({
    subject: 'Your hot-lead calling is at 80% of this month\'s limit',
    body: `Hot-lead calling has used ${used} of your ${cap} automatic calls this month. Calls pause at ${cap} and resume on the 1st. Leads are still captured and you still get the usual alerts.`,
  }),
  100: (_used: number, cap: number) => ({
    subject: 'Automatic hot-lead calls are paused until the 1st',
    body: `Your organization reached its ${cap} automatic hot-lead calls for this month, so automatic calls are paused until the 1st. New leads are still captured and you will still get the alert, so you can call them yourself. Contact AgentWeb support if you need a higher limit.`,
  }),
};

async function sendOwnerEmail(ownerUserId: string | undefined, subject: string, body: string): Promise<'sent' | 'failed' | 'skipped'> {
  if (!ownerUserId) return 'skipped';
  // Lazy: the call path must not load the email stack unless a notice is actually due.
  const [{ userDb }, { emailService }] = await Promise.all([import('../db'), import('../emailService')]);
  const owner = await userDb.getUserById(ownerUserId);
  const to = typeof owner?.email === 'string' ? owner.email.trim() : '';
  if (!to) return 'skipped';
  // The non-production guard lives in resendService.sendEmail (every send funnels through it), so tests and dev stay quiet.
  const outcome = await emailService.sendEmail(to, subject, body, `<p>${emailService.escapeHtml(body)}</p>`);
  return outcome === 'failed' ? 'failed' : 'sent';
}

async function notifyOnce(percent: NoticePercent, input: { orgId: string; ownerUserId?: string; config: HotLeadCallConfig; used: number; now: Date }): Promise<void> {
  const { orgId, config, used, now } = input;
  const month = localMonth(limitTimeZone(config), now);
  const key = noticeKey(percent, orgId, month);
  const token = `${percent}#${now.getTime()}`;
  const nowS = Math.floor(now.getTime() / 1000);
  const store = getLimitStore();
  if (!await store.claim(key, token, nowS + MONTH_TTL_S, nowS)) return; // already told this month
  console.warn(`[hotLeadCall] org monthly cap ${percent}% ${orgId}`);
  let outcome: 'sent' | 'failed' | 'skipped';
  try {
    const { subject, body } = noticeCopy[percent](used, config.maxCallsPerMonth);
    outcome = await sendOwnerEmail(input.ownerUserId, subject, body);
  } catch (err) {
    console.warn(`[hotLeadCall] monthly cap ${percent}% notice failed`, { orgId, error: errorName(err) });
    outcome = 'failed';
  }
  if (outcome === 'skipped') console.warn(`[hotLeadCall] monthly cap ${percent}% notice not sent: no owner email`, { orgId });
  if (outcome !== 'failed') return;
  if (percent === 80) {
    // Retried at the next crossing: bounded, because each lead that counts is itself bounded by the hourly cap.
    await store.release(key, token);
  } else {
    // Kept: every refused lead after the cap would otherwise redo lookup + send + release during a provider outage.
    // The alarm fallback is this line (no address).
    console.warn(`[hotLeadCall] monthly cap 100% notice failed ${orgId}`);
  }
}

/**
 * Fire-and-forget: sends the 80% notice once the month's count has reached ceil(0.8 * cap) (`used` >= the threshold,
 * not ==, because two racing leads can both read past it) and the 100% notice when the cap refused a lead. A cap of 1 to 4
 * has no separate 80% notice (ceil(0.8 * cap) would be the cap itself): only the 100% notice is sent.
 * The returned promise never rejects; the caller must not await it on the call path.
 */
export function notifyMonthlyCap(input: {
  orgId: string; ownerUserId?: string; config: HotLeadCallConfig; now?: Date;
  event: { kind: 'counted'; used: number | undefined } | { kind: 'refused' };
}): Promise<void> {
  const now = input.now ?? new Date();
  const { event, config } = input;
  const run = async (): Promise<void> => {
    if (event.kind === 'refused') {
      await notifyOnce(100, { ...input, used: config.maxCallsPerMonth, now });
      return;
    }
    const threshold = eightyPercentOf(config.maxCallsPerMonth);
    if (event.used !== undefined && threshold < config.maxCallsPerMonth && event.used >= threshold) {
      await notifyOnce(80, { ...input, used: event.used, now });
    }
  };
  return run().catch(err => {
    console.warn('[hotLeadCall] monthly cap notice failed', { orgId: input.orgId, error: errorName(err) });
  });
}
