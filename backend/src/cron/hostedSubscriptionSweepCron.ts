/**
 * ENG-2110 (1d): every few minutes, finish disconnects the login host has not yet confirmed (`revoking`) and make hosted
 * records follow what the host says. Deliberately NOT gated by the funding flag: a customer who disconnected must have their
 * login wiped even if the feature is switched off afterwards. It does nothing (and calls nothing) when there are no hosted rows.
 * Safe on several instances at once: every write is conditional and the host's revoke is idempotent.
 */
import { getHostedSubscriptionService } from "../services/funding/hostedSubscriptionService";

export const HOSTED_SUBSCRIPTION_SWEEP_JOB_NAME = "HostedSubscriptionSweep";
export const HOSTED_SUBSCRIPTION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const FIRST_RUN_DELAY_MS = 60 * 1000;

export interface SweepScheduleDeps {
  isCronEnabled: () => boolean;
  track: <T>(jobName: string, promise: Promise<T>) => Promise<T>;
  run?: () => Promise<unknown>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

export function scheduleHostedSubscriptionSweep(deps: SweepScheduleDeps): { scheduled: boolean } {
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => (setTimeout(fn, ms) as NodeJS.Timeout).unref?.());
  const repeat = deps.setInterval ?? ((fn: () => void, ms: number) => (setInterval(fn, ms) as NodeJS.Timeout).unref?.());
  const run =
    deps.run ??
    (async () => {
      const r = await getHostedSubscriptionService().sweepOnce();
      if (r.revoking || r.markedNeedsReconnect || r.stuck || r.hostUnavailable) {
        console.log(`[${HOSTED_SUBSCRIPTION_SWEEP_JOB_NAME}] revoking=${r.revoking} revoked=${r.revoked} stuck=${r.stuck} reconciled=${r.reconciled} needsReconnect=${r.markedNeedsReconnect} hostUnavailable=${r.hostUnavailable}`);
      }
      return r;
    });
  const tick = () => {
    if (!deps.isCronEnabled()) return;
    deps.track(HOSTED_SUBSCRIPTION_SWEEP_JOB_NAME, run()).catch((error: unknown) => console.error(`[${HOSTED_SUBSCRIPTION_SWEEP_JOB_NAME}] Error:`, (error as { code?: string })?.code || "error"));
  };
  schedule(() => {
    tick();
    repeat(tick, HOSTED_SUBSCRIPTION_SWEEP_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  return { scheduled: true };
}
