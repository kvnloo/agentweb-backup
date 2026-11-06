/**
 * Hot-lead call due-retries cron (ENG-2783): every five minutes, places the one retry of a lead who pressed 2 ("not
 * available now") once it is due. Armed in server.ts unless HOT_LEAD_CALL_RETRY is off; does nothing while the global
 * kill switch is off. Overlapping runs, repeats and several instances are harmless: the retry is claimed with a conditional
 * write (see hotLeadCallService.processHotLeadCallRetry). A run that is still going when the next tick fires is not doubled.
 */
import { runHotLeadCallRetrySweep, type RetrySweepSummary } from '../services/voice/hotLeadCallRetrySweep';

const TAG = '[hotLeadCall]';
export const HOT_LEAD_CALL_RETRY_INTERVAL_MS = 5 * 60 * 1000;

let running = false;

export async function runHotLeadCallRetryCron(): Promise<RetrySweepSummary | null> {
  if (running) return null;
  running = true;
  try {
    const s = await runHotLeadCallRetrySweep();
    if (s.enabled && s.killSwitchOn) {
      console.info(
        `${TAG} retry sweep orgs=${s.orgs} lists=${s.lists} leadsRead=${s.leadsRead} truncated=${s.truncated} found=${s.found} notDue=${s.notDue} ` +
        `attempted=${s.attempted} refused=${s.refused} expired=${s.expired} lost=${s.lost} failed=${s.failed}`,
      );
    }
    return s;
  } finally {
    running = false;
  }
}
