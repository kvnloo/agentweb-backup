/**
 * Hot-lead call stuck-record sweep (ENG-2271): daily, settles records that stayed live longer than a call can
 * last. Registered in server.ts anchored to a fixed UTC hour via `utils/dailySchedule.ts`. Report-only unless
 * HOT_LEAD_CALL_STUCK_SWEEP=close; overlapping runs and repeats are harmless (conditional writes, exactly-once metering).
 */
import { runStuckCallSweep, type StuckSweepSummary } from '../services/voice/stuckCallSweep';

const TAG = '[hotLeadCall]';

export async function runStuckCallSweepCron(): Promise<StuckSweepSummary> {
  const summary = await runStuckCallSweep();
  if (summary.mode === 'off') {
    console.info(`${TAG} stuck call sweep skipped: HOT_LEAD_CALL_STUCK_SWEEP is off`);
  } else if (summary.failed > 0) {
    console.error(`${TAG} stuck call sweep completed with failures`, summary);
  } else {
    console.info(`${TAG} stuck call sweep completed`, summary);
  }
  return summary;
}
