import { getLimitStore } from './limitStore';
import { DAY_S, utcDay } from './hotLeadCallLimits';
import { eightyPercentOf } from './hotLeadCallCapNotices';

/**
 * Operator alert for the platform-wide daily call ceiling (ENG-2783). At 80% and 100% of the cap, once per level per UTC
 * day (claims `hlc#notify#g80#<date>` / `hlc#notify#g100#<date>` in the limit store), it logs an ERROR line carrying a stable
 * marker (the alarm hook) and, when HOT_LEAD_CALL_ALERT_EMAIL is set, emails that address. Same discipline as the org notices
 * (hotLeadCallCapNotices.ts): nothing here throws, the call path does not await it, a failed send keeps the claim at both levels
 * (the marker logs once per level per day). No lead data, phone numbers or org names: counts only.
 */

type Level = 80 | 100;

const errorName = (err: unknown): string => (err instanceof Error ? err.name : 'error');
export const platformNoticeKey = (level: Level, date: string): string => `hlc#notify#g${level}#${date}`;
export const platformMarker = (level: Level): string => `[hotLeadCall] PLATFORM daily cap ${level}%`;

const copy = (level: Level, used: number, cap: number, date: string) => level === 80
  ? { subject: 'Hot-lead calling is at 80% of the platform daily limit', body: `Hot-lead calling has attempted ${used} of the platform-wide ${cap} lead calls allowed for ${date} (UTC). Calls to new leads pause at ${cap} until the next UTC day. To raise the limit set HOT_LEAD_CALL_PLATFORM_DAILY_MAX.` }
  : { subject: 'Hot-lead calling hit the platform daily limit', body: `Hot-lead calling reached the platform-wide limit of ${cap} lead calls attempted for ${date} (UTC). New leads are skipped (reason platform_daily_cap) until the next UTC day. Check for a spike or abuse before raising HOT_LEAD_CALL_PLATFORM_DAILY_MAX.` };

async function sendAlertEmail(subject: string, body: string): Promise<'sent' | 'failed' | 'skipped'> {
  const to = process.env.HOT_LEAD_CALL_ALERT_EMAIL?.trim();
  if (!to) return 'skipped';
  // Lazy: the call path must not load the email stack unless an alert is actually due.
  const { emailService } = await import('../emailService');
  const outcome = await emailService.sendEmail(to, subject, body, `<p>${emailService.escapeHtml(body)}</p>`);
  return outcome === 'failed' ? 'failed' : 'sent';
}

async function alertOnce(level: Level, used: number, cap: number, now: Date): Promise<void> {
  const date = utcDay(now);
  const key = platformNoticeKey(level, date);
  const token = `g${level}#${now.getTime()}`;
  const nowS = Math.floor(now.getTime() / 1000);
  const store = getLimitStore();
  if (!await store.claim(key, token, nowS + 2 * DAY_S, nowS)) return; // already alerted today
  console.error(`${platformMarker(level)} ${date} used=${used} cap=${cap}`);
  let outcome: 'sent' | 'failed' | 'skipped';
  try {
    const { subject, body } = copy(level, used, cap, date);
    outcome = await sendAlertEmail(subject, body);
  } catch (err) {
    console.warn(`[hotLeadCall] platform cap ${level}% alert email failed`, { error: errorName(err) });
    outcome = 'failed';
  }
  if (outcome !== 'failed') return;
  // Kept at both levels (as for the 100% org notice): releasing would make every counted lead above 80% redo the send and
  // re-log the ERROR marker, re-firing a paging alarm, during a provider outage. The ERROR line above is the alarm.
  console.warn(`[hotLeadCall] platform cap ${level}% alert email failed ${date}`);
}

/**
 * Fire-and-forget; the promise never rejects. `counted`: a lead was just counted and the day's count read `used` (undefined
 * when the read failed): 80% at ceil(0.8 * cap) (only when that is below the cap), 100% when the count reached the cap.
 * `refused`: the platform cap refused a lead, which is the 100% level.
 */
export function notifyPlatformCap(input: {
  cap: number; now?: Date; event: { kind: 'counted'; used: number | undefined } | { kind: 'refused' };
}): Promise<void> {
  const now = input.now ?? new Date();
  const { cap, event } = input;
  const run = async (): Promise<void> => {
    if (event.kind === 'refused') return alertOnce(100, cap, cap, now);
    if (event.used === undefined) return;
    // Both reached levels are processed: two concurrent leads can both read the cap, and the 80% alert must not be lost then.
    const threshold = eightyPercentOf(cap);
    if (threshold < cap && event.used >= threshold) await alertOnce(80, event.used, cap, now);
    if (event.used >= cap) await alertOnce(100, event.used, cap, now);
  };
  return run().catch(err => {
    console.warn('[hotLeadCall] platform cap alert failed', { error: errorName(err) });
  });
}
