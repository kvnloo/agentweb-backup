/**
 * ENG-2781 seat option (a), decided 2026-11-25 (CEO per Harsha's defaults). Dark until
 * ZOMA_DATABRICKS_LAUNCH_ENABLED=true, which is flipped only after Databricks allowlists the
 * Marketplace workspace.
 *
 * While the flag is on:
 *  - Open tester window: until ZOMA_OPEN_TESTER_UNTIL (default 2026-12-03T00:00 PT), every new
 *    Zoma signup is admitted without taking one of the capped seats, and is not billed
 *    (the publish paywall is skipped). "Free" means no billing, not just no waitlist.
 *  - After the window, Zoma authorizations from a Databricks-origin OAuth client still never
 *    count against the seat cap. They are read-only, so they never reach the paywall anyway.
 */
export const DEFAULT_ZOMA_OPEN_TESTER_UNTIL = '2026-12-03T08:00:00Z';

export const zomaDatabricksLaunchEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.ZOMA_DATABRICKS_LAUNCH_ENABLED === 'true';

/** Fails closed: an unparseable end date means the window is not open. */
export function zomaOpenTesterWindowActive(now: number = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (!zomaDatabricksLaunchEnabled(env)) return false;
  const raw = env.ZOMA_OPEN_TESTER_UNTIL || DEFAULT_ZOMA_OPEN_TESTER_UNTIL;
  // An explicit offset is required: a date-only or local value would close the window hours off.
  if (!/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return false;
  const until = Date.parse(raw);
  return Number.isFinite(until) && now < until;
}
