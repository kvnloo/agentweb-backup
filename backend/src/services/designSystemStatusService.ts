/**
 * Design-system build status — ENG-328 mandatory onboarding step.
 *
 * Pure state-transition logic for the async design-system scrape, mirroring
 * brandBuildStatusService.ts's shape exactly (idle|running|ready|failed,
 * started/completed/duration/error, a hard watchdog wall). The one structural
 * difference: brandBuildStatus lives as flat fields on User; designSystem is
 * a single nested object (`user.designSystem`) so it can be resolved
 * org-first via resolveOrgProfileField the same way brandGuidelines is (a
 * design system is an ORG/account-level artifact — one website per account —
 * not a per-user one).
 *
 * This service intentionally does NOT touch DynamoDB, so it's unit-testable
 * without mocking AWS. Callers pass the current persisted `designSystem`
 * object and receive a patch (`{ designSystem: {...} }`) to persist via
 * userDb.updateUser / orgDb.updateOrganization.
 */

export type DesignSystemStatus = "idle" | "running" | "ready" | "failed";
export type DesignSystemSource = "scrape" | "manual_fallback";

export interface DesignSystemFields {
  status: DesignSystemStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  source?: DesignSystemSource;
  kbTaskId?: string;
}

export interface DesignSystemPatch {
  designSystem: DesignSystemFields;
}

export interface DesignSystemSnapshot extends DesignSystemFields {
  inFlight: boolean;
  timedOut: boolean;
}

/**
 * UI/status budget — mirrors BRAND_BUILD_TIMEOUT_MS's role. The scrape here
 * is deterministic (cssExtractor, not an LLM chat turn), so its budget is
 * tighter than brand-build's 300s: a same-origin multi-page Puppeteer crawl
 * with per-page 30s navigation timeouts should land well under this even on
 * a slow site.
 */
export const DESIGN_SYSTEM_TIMEOUT_MS = 120_000;

/** Hard watchdog wall — set above the budget so persistFailure normally wins the race. */
export const DESIGN_SYSTEM_HARD_TIMEOUT_MS = 150_000;

export function buildStartPatch(now: Date = new Date()): DesignSystemPatch {
  return {
    designSystem: {
      status: "running",
      startedAt: now.toISOString(),
      completedAt: undefined,
      durationMs: undefined,
      error: undefined,
    },
  };
}

/**
 * Compute a patch marking the build successfully completed. Returns `null`
 * if the current state isn't `running` — completion events from non-running
 * states are ignored (prevents double-writes from noisy callers).
 */
export function buildReadyPatch(
  current: DesignSystemFields | undefined,
  source: DesignSystemSource,
  kbTaskId: string,
  now: Date = new Date()
): DesignSystemPatch | null {
  if (current?.status !== "running") return null;
  const startedAt = current.startedAt ? Date.parse(current.startedAt) : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  return {
    designSystem: {
      status: "ready",
      startedAt: current.startedAt,
      completedAt: now.toISOString(),
      durationMs: Math.max(0, duration),
      error: undefined,
      source,
      kbTaskId,
    },
  };
}

export function buildFailedPatch(
  current: DesignSystemFields | undefined,
  error: string,
  now: Date = new Date()
): DesignSystemPatch {
  const startedAt = current?.startedAt ? Date.parse(current.startedAt) : NaN;
  const completedAtMs = now.getTime();
  const duration = Number.isFinite(startedAt) ? completedAtMs - startedAt : 0;
  const safeError = (error || "design system scrape failed").slice(0, 512);
  return {
    designSystem: {
      status: "failed",
      startedAt: current?.startedAt,
      completedAt: now.toISOString(),
      durationMs: Math.max(0, duration),
      error: safeError,
      kbTaskId: current?.kbTaskId,
    },
  };
}

/**
 * Watchdog: a build stuck in `running` past the hard wall is treated as an
 * orphaned fire-and-forget job (lost to a deploy/crash/instance recycle) and
 * force-failed on the next status read. Returns `null` when not stuck.
 */
export function buildAutoFailPatchIfStuck(
  current: DesignSystemFields | undefined,
  now: Date = new Date()
): DesignSystemPatch | null {
  if (current?.status !== "running") return null;
  const startedAt = current.startedAt ? Date.parse(current.startedAt) : NaN;
  if (!Number.isFinite(startedAt)) return null;
  const age = now.getTime() - startedAt;
  if (age < DESIGN_SYSTEM_HARD_TIMEOUT_MS) return null;
  return buildFailedPatch(
    current,
    `Design-system scrape timed out after ${Math.round(age / 1000)}s — the background job did not complete. Please retry.`,
    now
  );
}

export function snapshot(
  current: DesignSystemFields | undefined,
  now: Date = new Date()
): DesignSystemSnapshot {
  const status = current?.status ?? "idle";
  const startedAt = current?.startedAt ? Date.parse(current.startedAt) : NaN;
  const age = Number.isFinite(startedAt) ? now.getTime() - startedAt : 0;
  return {
    status,
    startedAt: current?.startedAt,
    completedAt: current?.completedAt,
    durationMs: current?.durationMs,
    error: current?.error,
    source: current?.source,
    kbTaskId: current?.kbTaskId,
    inFlight: status === "running",
    timedOut: status === "running" && age >= DESIGN_SYSTEM_TIMEOUT_MS,
  };
}
