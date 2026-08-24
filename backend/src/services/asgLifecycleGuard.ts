/**
 * ENG-764 / ENG-657: stop an Elastic Beanstalk deploy from killing an in-flight
 * scheduled run.
 *
 * Prod-verified failure (session d7e4863c, 2026-07-29): an immutable deploy added
 * the new instance at 10:17:06 and REMOVED the old one at 10:22:06 — 3m19s later.
 * A scheduled Lead Auto-Enrichment run had started on that old instance at 10:17:03
 * and needed ~5.4 min. It was killed mid-flight, and the ENG-324 reconciler had to
 * requeue it ~20 minutes later.
 *
 * The app already drains for DRAIN_CEILING_MS (10 min) on SIGTERM, and the ALB
 * DeregistrationDelay is 600s — but NEITHER makes the Auto Scaling group wait. The
 * ASG terminates the instance on its own schedule, so the drain never gets its
 * window. The missing piece is an ASG *termination lifecycle hook*: it parks the
 * instance in `Terminating:Wait` until something says CONTINUE.
 *
 * This module is the "something":
 *   1. Poll IMDS for `autoscaling/target-lifecycle-state`. It flips to `Terminated`
 *      as soon as the ASG decides this instance is going away — BEFORE any SIGTERM.
 *   2. On that signal, run the normal graceful drain (in-flight runs finish).
 *   3. Call CompleteLifecycleAction(CONTINUE) so the instance terminates immediately
 *      once drained, rather than sitting out the hook's full heartbeat timeout.
 *
 * DEPLOYMENT: the backend deploy script idempotently ensures the hook before each EB
 * update. The application's AWS identity has the narrow CompleteLifecycleAction,
 * RecordLifecycleActionHeartbeat, and DescribeAutoScalingInstances grants needed to
 * answer it. A 900-second heartbeat with DefaultResult=CONTINUE remains the fallback.
 *
 * Fail-safe by construction — every failure mode degrades to today's behavior or
 * better, never worse:
 *   - Not in an ASG / IMDS disabled (local dev, ECS, the test box): the metadata
 *     path 404s, the guard disables itself permanently and never fires.
 *   - CompleteLifecycleAction denied or erroring: the hook still expires on its own
 *     HeartbeatTimeout with DefaultResult=CONTINUE, so an instance is never stranded.
 *   - The hook itself missing: `Terminated` is still reported for any termination, so
 *     the drain simply starts earlier than it otherwise would.
 *
 * Deliberately conservative: it acts only on an exact `Terminated` match, and only
 * after two consecutive confirming reads, because a false positive would drain a
 * healthy single-instance production environment.
 */

import AWS from 'aws-sdk';

/**
 * Fixed hook name, mirrored in .ebextensions/07-termination-lifecycle.config.
 * Pinning it here means the instance never needs autoscaling:DescribeLifecycleHooks
 * just to answer the hook it is already parked on.
 */
export const TERMINATION_LIFECYCLE_HOOK_NAME = 'agentweb-drain-before-terminate';

const IMDS_BASE = 'http://169.254.169.254';
const IMDS_TOKEN_TTL_SECONDS = 300;
const IMDS_TIMEOUT_MS = 2000;

/** How often to ask IMDS whether this instance is being taken away. */
export const LIFECYCLE_POLL_INTERVAL_MS = 5000;

/**
 * Consecutive `Terminated` reads required before draining. IMDS is authoritative,
 * so this is pure belt-and-braces against a transient/garbled read taking down a
 * healthy instance — two polls costs 5 extra seconds against a 10-minute drain.
 */
export const CONFIRMING_READS_REQUIRED = 2;

/**
 * AWS may expose `Terminating` through IMDS just before its lifecycle action becomes
 * queryable by CompleteLifecycleAction. Retry only that exact propagation race for
 * at most 14 seconds; every other error still takes the normal fail-safe path.
 */
export const COMPLETION_MAX_ATTEMPTS = 15;
export const COMPLETION_RETRY_DELAY_MS = 1000;

export interface AsgLifecycleGuardDeps {
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to setInterval. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Resolves the ASG name for an instance and completes its lifecycle action. */
  completeAction?: (instanceId: string) => Promise<void>;
  /** Injected in tests; defaults to a one-shot timer. */
  sleepImpl?: (delayMs: number) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface AsgLifecycleGuardHandle {
  stop: () => void;
}

async function imdsRequest(
  fetchImpl: typeof fetch,
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMDS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${IMDS_BASE}${path}`, { ...init, signal: controller.signal });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch an IMDSv2 session token. Returns null when IMDS is unreachable/disabled. */
async function fetchImdsToken(fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const res = await imdsRequest(fetchImpl, '/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': String(IMDS_TOKEN_TTL_SECONDS) },
    });
    return res.ok && res.body.trim() ? res.body.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Read this instance's ASG target lifecycle state.
 *
 * Returns the state string, or null when the instance is not part of an ASG — the
 * metadata category 404s in that case (empirically confirmed on a standalone EC2
 * box), which is the signal to disable the guard rather than to retry forever.
 */
export async function readTargetLifecycleState(
  fetchImpl: typeof fetch = fetch
): Promise<{ state: string | null; unavailable: boolean }> {
  const token = await fetchImdsToken(fetchImpl);
  if (!token) return { state: null, unavailable: true };
  try {
    const res = await imdsRequest(fetchImpl, '/latest/meta-data/autoscaling/target-lifecycle-state', {
      headers: { 'X-aws-ec2-metadata-token': token },
    });
    if (res.status === 404) return { state: null, unavailable: true };
    if (!res.ok) return { state: null, unavailable: false };
    return { state: res.body.trim(), unavailable: false };
  } catch {
    // A transient IMDS blip is NOT a reason to disable the guard permanently.
    return { state: null, unavailable: false };
  }
}

/** Read this instance's id from IMDS. */
export async function readInstanceId(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const token = await fetchImdsToken(fetchImpl);
  if (!token) return null;
  try {
    const res = await imdsRequest(fetchImpl, '/latest/meta-data/instance-id', {
      headers: { 'X-aws-ec2-metadata-token': token },
    });
    return res.ok && res.body.trim() ? res.body.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Tell the ASG this instance has drained and may now be terminated.
 *
 * Best-effort by design: if this throws (missing IAM grant, API error), the hook
 * still expires on its own HeartbeatTimeout with DefaultResult=CONTINUE. The cost
 * of failure is a slower termination, never a stuck instance.
 */
export async function completeTerminationLifecycleAction(instanceId: string): Promise<void> {
  const autoscaling = new AWS.AutoScaling({ region: process.env.AWS_REGION || 'us-west-2' });
  const described = await autoscaling
    .describeAutoScalingInstances({ InstanceIds: [instanceId] })
    .promise();
  const asgName = described.AutoScalingInstances?.[0]?.AutoScalingGroupName;
  if (!asgName) {
    throw new Error(`instance ${instanceId} is not in an Auto Scaling group`);
  }
  await autoscaling
    .completeLifecycleAction({
      AutoScalingGroupName: asgName,
      LifecycleHookName: TERMINATION_LIFECYCLE_HOOK_NAME,
      InstanceId: instanceId,
      LifecycleActionResult: 'CONTINUE',
    })
    .promise();
}

function isLifecycleActionPropagationRace(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const awsError = error as { code?: unknown; name?: unknown; message?: unknown };
  const isValidationError =
    awsError.code === 'ValidationError' || awsError.name === 'ValidationError';
  return (
    isValidationError &&
    typeof awsError.message === 'string' &&
    awsError.message.includes('No active Lifecycle Action found')
  );
}

/**
 * Start watching for an ASG-initiated termination of THIS instance.
 *
 * `onTerminating` is invoked at most once and is expected to perform the graceful
 * drain. Once it resolves, the lifecycle action is completed so the ASG can proceed
 * immediately instead of waiting out the hook.
 */
export function startAsgTerminationGuard(
  onTerminating: () => Promise<void>,
  deps: AsgLifecycleGuardDeps = {}
): AsgLifecycleGuardHandle {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const setIntervalFn = deps.setIntervalImpl ?? setInterval;
  const clearIntervalFn = deps.clearIntervalImpl ?? clearInterval;
  const completeAction = deps.completeAction ?? completeTerminationLifecycleAction;
  const sleepImpl =
    deps.sleepImpl ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const log = deps.logger ?? console;

  let confirmingReads = 0;
  let fired = false;
  let stopped = false;

  const timer = setIntervalFn(async () => {
    if (stopped || fired) return;
    let reading: { state: string | null; unavailable: boolean };
    try {
      reading = await readTargetLifecycleState(fetchImpl);
    } catch {
      return; // never let a poll error escape into an unhandled rejection
    }

    if (reading.unavailable) {
      // Not in an ASG (or IMDS is off) — this guard can never apply here.
      stop();
      log.log('[asgLifecycleGuard] not an ASG instance — termination guard disabled');
      return;
    }

    if (reading.state !== 'Terminated') {
      confirmingReads = 0;
      return;
    }

    confirmingReads += 1;
    if (confirmingReads < CONFIRMING_READS_REQUIRED) return;

    fired = true;
    stop();
    log.warn(
      '[asgLifecycleGuard] ASG is terminating this instance — draining in-flight work before releasing it'
    );

    try {
      await onTerminating();
    } catch (drainError) {
      log.error('[asgLifecycleGuard] drain failed; releasing the instance anyway:', drainError);
    }

    try {
      const instanceId = await readInstanceId(fetchImpl);
      if (!instanceId) throw new Error('could not read instance-id from IMDS');
      for (let attempt = 1; attempt <= COMPLETION_MAX_ATTEMPTS; attempt += 1) {
        try {
          await completeAction(instanceId);
          break;
        } catch (completeError) {
          if (
            !isLifecycleActionPropagationRace(completeError) ||
            attempt === COMPLETION_MAX_ATTEMPTS
          ) {
            throw completeError;
          }
          log.warn(
            `[asgLifecycleGuard] lifecycle action is not active yet (attempt ${attempt}/${COMPLETION_MAX_ATTEMPTS}); retrying in ${COMPLETION_RETRY_DELAY_MS}ms`
          );
          await sleepImpl(COMPLETION_RETRY_DELAY_MS);
        }
      }
      log.log('[asgLifecycleGuard] drained — lifecycle action completed, instance may terminate');
    } catch (completeError) {
      // The hook's HeartbeatTimeout + DefaultResult=CONTINUE covers us here.
      log.error(
        '[asgLifecycleGuard] could not complete the lifecycle action; the hook will time out and continue on its own:',
        completeError
      );
    }
  }, LIFECYCLE_POLL_INTERVAL_MS);

  // Never hold the event loop open just to poll.
  if (typeof (timer as any)?.unref === 'function') (timer as any).unref();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(timer as any);
  }

  return { stop };
}
