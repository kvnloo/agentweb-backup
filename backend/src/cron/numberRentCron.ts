/**
 * Hot-lead call number rent (ENG-2614): daily sweep that meters the current month's rent of every org's
 * caller number. Registered in server.ts anchored to a fixed UTC hour via `utils/dailySchedule.ts` (a plain
 * 24h interval never fires with redeploys every 1-2 hours). The month-scoped idempotency key makes every
 * extra run in the same month, and every parallel instance, a safe no-op.
 */
import { runNumberRentSweep, type NumberRentSweepSummary } from '../services/voice/numberRent';

const TAG = '[hotLeadCall]';

export async function runNumberRentCron(): Promise<NumberRentSweepSummary> {
  const summary = await runNumberRentSweep();
  if (!summary.enabled) {
    console.info(`${TAG} number rent sweep skipped: HOT_LEAD_CALL_RENT_METERING is off`);
  } else if (summary.failed + summary.skippedNoOwner + summary.skippedInvalidSid + summary.skippedNoRateUnit > 0) {
    console.error(`${TAG} number rent sweep completed with skipped or failed orgs`, summary);
  } else {
    console.info(`${TAG} number rent sweep completed`, summary);
  }
  return summary;
}
