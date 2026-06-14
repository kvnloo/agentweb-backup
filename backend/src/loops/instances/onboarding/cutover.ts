/**
 * Onboarding loop cutover policy (Phase 2, PR 1).
 *
 * Background: the framework V2 onboarding loop (the analyst-policy REVAMP) has
 * shipped and run ALONGSIDE the legacy threshold heartbeat in gated parallel
 * (both behind their own env flags). Running both daily double-fires: two
 * Slack DMs and double Bedrock spend.
 *
 * This module is the single source of truth for "which onboarding loop is the
 * live one." It flips the default so V2 is the live path and the legacy
 * heartbeat is OFF by default — without deleting any legacy code yet (deletion
 * is PR 2, pure subtraction on a green characterization test).
 *
 * Invariant: at most ONE of {legacy, V2} is ever live. The legacy path is
 * opt-in (it only runs when ONBOARDING_LOOP_ENABLED=true) and, when opted in,
 * it WINS — V2 yields so the two never both fire. This keeps the cutover
 * trivially revertible: set ONBOARDING_LOOP_ENABLED=true to fall back to the
 * old heartbeat, or ONBOARDING_LOOP_V2=false to silence both.
 *
 * Env contract:
 *   - default (nothing set)          → 'v2'    (the new live path)
 *   - ONBOARDING_LOOP_ENABLED=true   → 'legacy' (explicit fallback; V2 yields)
 *   - ONBOARDING_LOOP_V2=false       → V2 off; 'legacy' if legacy opted in, else 'off'
 */

export type OnboardingLoopMode = 'v2' | 'legacy' | 'off';

function isTrue(v: string | undefined): boolean {
  return v === 'true';
}

/** True when the legacy heartbeat cron is the live onboarding loop. Opt-in. */
export function isOnboardingLegacyLive(): boolean {
  return isTrue(process.env.ONBOARDING_LOOP_ENABLED);
}

/**
 * True when the framework V2 instance is the live onboarding loop. Live by
 * default, but yields to the legacy path when legacy is explicitly enabled
 * (so the two never double-fire), and can be explicitly disabled for rollback.
 */
export function isOnboardingV2Live(): boolean {
  if (isOnboardingLegacyLive()) return false; // legacy opted in → V2 yields
  return process.env.ONBOARDING_LOOP_V2 !== 'false'; // default on; explicit opt-out
}

/** Single resolved mode string — handy for a boot-time log line + tests. */
export function resolveOnboardingLoopMode(): OnboardingLoopMode {
  if (isOnboardingLegacyLive()) return 'legacy';
  if (isOnboardingV2Live()) return 'v2';
  return 'off';
}
