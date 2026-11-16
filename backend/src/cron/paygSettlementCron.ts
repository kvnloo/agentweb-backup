/**
 * ENG-668 PR-2 — daily month-end pay-as-you-go settlement sweep.
 *
 * See `services/paygSettlementService.ts`. Registered in server.ts anchored to a fixed UTC hour via
 * `utils/dailySchedule.ts` (a 24h setInterval never elapses in an environment that redeploys every
 * 1-2 hours), after the 10:00 UTC seat-credit sweep. It runs every day: off switch or day 1 of the
 * month => it does nothing; from day 2 it settles the previous month, and every later day of the month
 * only resumes what is still `pending` (each month's record makes a rerun a no-op).
 */
import { runPaygSettlement as settle, type PaygSettlementRunSummary } from '../services/paygSettlementService';

const TAG = '[PaygSettlementCron]';

export async function runPaygSettlement(): Promise<PaygSettlementRunSummary> {
  const summary = await settle();
  if (summary.failed > 0) {
    console.error(`${TAG} completed with failures`, summary);
  } else if (!summary.skipped) {
    console.info(`${TAG} completed`, summary);
  }
  return summary;
}
