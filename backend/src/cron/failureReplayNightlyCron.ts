/**
 * Nightly failure replay (ENG-591 AC2, via ENG-2145).
 *
 * Replays every registered case (loops/eval/failureReplayCatalog.ts) against the current code once
 * a night at 04:30 UTC. A case that regressed is filed through the ENG-240 intake seam
 * (fileAutoIssue) under the stable `failure-replay:<case-id>` alert class, so repeated nights
 * converge on one issue instead of one per run. The replay itself makes no network, AWS or LLM
 * call; only a failure reaches the intake.
 *
 * Off by default: scheduled only when FAILURE_REPLAY_NIGHTLY_ENABLED=true (enabling it in
 * production is an OPS step, like EVAL_V2_SAMPLER_ENABLED).
 */

import { runFailureReplaySuite, type FailureReplayRunResult } from '../loops/eval/failureReplaySuite';
import { FAILURE_REPLAY_CATALOG, runRegisteredCheck, toFailureReplayCases, type RegisteredReplayCase } from '../loops/eval/failureReplayCatalog';
import type { FileAutoIssueParams, FiledAutoResult } from '../services/intakeService';

export const FAILURE_REPLAY_NIGHTLY_FLAG = 'FAILURE_REPLAY_NIGHTLY_ENABLED';
export const FAILURE_REPLAY_JOB_NAME = 'FailureReplayNightly';
export const FAILURE_REPLAY_UTC_HOUR = 4;
export const FAILURE_REPLAY_UTC_MINUTE = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runFailureReplayNightly(deps: {
  catalog?: readonly RegisteredReplayCase[];
  fileIssue?: (params: FileAutoIssueParams) => Promise<FiledAutoResult>;
  now?: () => Date;
} = {}): Promise<FailureReplayRunResult> {
  const result = await runFailureReplaySuite({
    cases: toFailureReplayCases(deps.catalog ?? FAILURE_REPLAY_CATALOG),
    contract: runRegisteredCheck,
    // undefined falls back to the runner's defaults (fileAutoIssue, the wall clock).
    fileIssue: deps.fileIssue,
    now: deps.now,
  });
  console.log(`[${FAILURE_REPLAY_JOB_NAME}] checked ${result.checked}, failed ${result.failed}, filed ${result.filed} (deduped ${result.deduped})`);
  return result;
}

/** Milliseconds from `now` until the next 04:30 UTC. */
export function msUntilNextRun(now: Date): number {
  const next = new Date(now);
  next.setUTCHours(FAILURE_REPLAY_UTC_HOUR, FAILURE_REPLAY_UTC_MINUTE, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

export interface NightlyScheduleDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
  /** instanceState.isCronEnabled: false on a draining or non-leader instance. */
  isCronEnabled: () => boolean;
  /** cronJobRegistry.track, so shutdown waits for an in-flight run. */
  track: (jobName: string, promise: Promise<unknown>) => Promise<unknown>;
  run?: () => Promise<unknown>;
}

/** Schedules the nightly run when the flag is on. Returns whether it scheduled anything. */
export function scheduleFailureReplayNightly(deps: NightlyScheduleDeps): { scheduled: false } | { scheduled: true; firstRunInMs: number } {
  const env = deps.env ?? process.env;
  if (env[FAILURE_REPLAY_NIGHTLY_FLAG] !== 'true') return { scheduled: false };
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const repeat = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const run = deps.run ?? (() => runFailureReplayNightly());
  const tick = () => {
    if (!deps.isCronEnabled()) return;
    deps.track(FAILURE_REPLAY_JOB_NAME, run()).catch((error: unknown) => console.error(`[${FAILURE_REPLAY_JOB_NAME}] Error:`, error));
  };
  const firstRunInMs = msUntilNextRun((deps.now ?? (() => new Date()))());
  schedule(() => {
    tick();
    repeat(tick, DAY_MS);
  }, firstRunInMs);
  console.log(`[${FAILURE_REPLAY_JOB_NAME}] Initialized — first run at 04:30 UTC (in ${Math.round(firstRunInMs / 60000)} min)`);
  return { scheduled: true, firstRunInMs };
}
