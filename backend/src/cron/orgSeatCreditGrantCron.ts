/**
 * Seat-based billing (ENG-2247) — daily sweep that grants each org's monthly
 * LLM usage credit for its purchased extra seats.
 *
 * See `services/orgSeatCreditGrantService.ts` for why this is a sibling sweep
 * rather than an extension of the existing (lazy, per-user, non-scheduled)
 * usage-counter reset. Registered in server.ts anchored to a fixed UTC hour
 * via `utils/dailySchedule.ts` so it survives the frequent redeploys in this
 * environment and still fires once a day; grantId idempotency in
 * `grantMonthlyLlmUsageCredit` makes any extra fire in the same usage month a
 * safe no-op.
 */
import { grantMonthlySeatCreditsForAllOrgs, type OrgSeatCreditGrantSummary } from '../services/orgSeatCreditGrantService';

const TAG = '[OrgSeatCreditGrantCron]';

export async function runOrgSeatCreditGrant(): Promise<OrgSeatCreditGrantSummary> {
  const summary = await grantMonthlySeatCreditsForAllOrgs();
  if (summary.failed > 0) {
    console.error(`${TAG} completed with failures`, summary);
  } else {
    console.info(`${TAG} completed`, summary);
  }
  return summary;
}
