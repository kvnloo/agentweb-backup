/**
 * ENG-2110 (B3): once a day, mark Claude logins past their fixed 30-day refresh lifetime as
 * expired, and log how many are within 7 and 2 days of it (no notification channel yet).
 * Always scheduled, but does nothing unless the `claudeSubscription` funding flag is on:
 * prod EB cannot take a new environment variable (ENG-2071).
 */
import { getFundingFlags } from "../services/funding/fundingFlags";
import { getClaudeSubscriptionService } from "../services/funding/claudeSubscriptionService";

export const CLAUDE_SUBSCRIPTION_EXPIRY_JOB_NAME = "ClaudeSubscriptionExpiry";
export const CLAUDE_SUBSCRIPTION_EXPIRY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

export interface ExpiryScheduleDeps {
  isCronEnabled: () => boolean;
  track: <T>(jobName: string, promise: Promise<T>) => Promise<T>;
  run?: () => Promise<unknown>;
  flagEnabled?: () => Promise<boolean>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

export function scheduleClaudeSubscriptionExpiry(deps: ExpiryScheduleDeps): { scheduled: boolean } {
  const schedule = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const repeat = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const flagEnabled = deps.flagEnabled ?? (async () => {
    const flags = await getFundingFlags();
    return !flags.killSwitch && flags.claudeSubscription.enabled;
  });
  const run =
    deps.run ??
    (async () => {
      const result = await getClaudeSubscriptionService().expiryPass();
      console.log(
        `[${CLAUDE_SUBSCRIPTION_EXPIRY_JOB_NAME}] expired=${result.expired} within7Days=${result.within7Days} within2Days=${result.within2Days}` +
          (result.soon.length ? ` soon=${result.soon.map((s) => `${s.connectionId}:${s.daysLeft}d`).join(",")}` : ""),
      );
      return result;
    });
  const tick = () => {
    if (!deps.isCronEnabled()) return;
    deps
      .track(CLAUDE_SUBSCRIPTION_EXPIRY_JOB_NAME, (async () => ((await flagEnabled()) ? run() : undefined))())
      .catch((error: unknown) => console.error(`[${CLAUDE_SUBSCRIPTION_EXPIRY_JOB_NAME}] Error:`, (error as { code?: string })?.code || "error"));
  };
  schedule(() => {
    tick();
    repeat(tick, CLAUDE_SUBSCRIPTION_EXPIRY_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  return { scheduled: true };
}
