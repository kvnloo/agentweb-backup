/**
 * Hot-lead call due-retries cron (ENG-2783): every five minutes, places the one retry of a lead who pressed 2 ("not
 * available now") once it is due. Armed by `startHotLeadCallRetryCron` (called from server.ts) unless HOT_LEAD_CALL_RETRY is
 * off; does nothing while the global kill switch is off. Overlapping runs, repeats and several instances are harmless: the
 * retry is claimed with a conditional write (see hotLeadCallService.processHotLeadCallRetry). A run that is still going when
 * the next tick fires is not doubled.
 */
import { runHotLeadCallRetrySweep, type RetrySweepSummary } from '../services/voice/hotLeadCallRetrySweep';
import { retrySweepEnabled } from '../services/voice/hotLeadCallRetry';

const TAG = '[hotLeadCall]';
export const HOT_LEAD_CALL_RETRY_INTERVAL_MS = 5 * 60 * 1000;
/** One extra run this long after arming, so a fresh deploy does not leave a due retry waiting a whole interval. */
export const HOT_LEAD_CALL_RETRY_BOOT_DELAY_MS = 30 * 1000;
/** A run in which nothing happened is logged at most this often. */
const IDLE_LOG_EVERY_MS = 60 * 60 * 1000;

let running = false;
let idleLoggedAt = 0;

/** Test-only: forget the overlap guard and the idle-log clock. */
export function resetHotLeadCallRetryCronForTests(): void {
  running = false;
  idleLoggedAt = 0;
}

const busy = (s: RetrySweepSummary): boolean => s.found > 0 || s.attempted > 0 || s.expired > 0 || s.skippedLists > 0 || s.failed > 0;

export async function runHotLeadCallRetryCron(): Promise<RetrySweepSummary | null> {
  if (running) return null;
  running = true;
  try {
    const s = await runHotLeadCallRetrySweep();
    const now = Date.now();
    if (s.enabled && s.killSwitchOn && (busy(s) || now - idleLoggedAt >= IDLE_LOG_EVERY_MS)) {
      if (!busy(s)) idleLoggedAt = now;
      console.info(
        `${TAG} retry sweep orgs=${s.orgs} lists=${s.lists} skippedLists=${s.skippedLists} leadsRead=${s.leadsRead} truncated=${s.truncated} found=${s.found} ` +
        `notDue=${s.notDue} rescheduled=${s.rescheduled} attempted=${s.attempted} refused=${s.refused} expired=${s.expired} lost=${s.lost} failed=${s.failed}`,
      );
    }
    return s;
  } finally {
    running = false;
  }
}

/**
 * Arms the every-5-minutes interval (plus one run 30 seconds after arming); returns the timer, or null (nothing armed) when HOT_LEAD_CALL_RETRY is off. `enabled` is
 * the host's own gate (server.ts passes isCronEnabled), `track` its job registry wrapper.
 */
export function startHotLeadCallRetryCron(host: {
  enabled: () => boolean;
  track: (name: string, run: Promise<unknown>) => Promise<unknown>;
}): NodeJS.Timeout | null {
  if (!retrySweepEnabled()) {
    console.log('[hotLeadCallRetryCron] Disabled: HOT_LEAD_CALL_RETRY is off');
    return null;
  }
  const tick = (): void => {
    if (!host.enabled()) return;
    host.track('hotLeadCallRetryCron', runHotLeadCallRetryCron()).catch((e) => console.error('[hotLeadCallRetryCron] Error:', e));
  };
  setTimeout(tick, HOT_LEAD_CALL_RETRY_BOOT_DELAY_MS).unref();
  const timer = setInterval(tick, HOT_LEAD_CALL_RETRY_INTERVAL_MS);
  console.log('[hotLeadCallRetryCron] Initialized — every 5 minutes, first run in 30 seconds');
  return timer;
}
