/**
 * ENG-110: cross-instance "a run is live on this session" guard for interactive POST /generate.
 *
 * WHY: the per-session generation lock, its owner map and GET /generating are process memory. Deploys are
 * Immutable (two instances overlap) and the old one drains for up to DRAIN_CEILING_MS, so during an overlap the
 * OLD instance can still be running a chat while the NEW one reports nothing: after a reload the portal offers
 * "Resend" and a click starts a SECOND generation (duplicate user message, two replies, double cost).
 *
 * WHAT: an owner-approved ADDITIVE optional attribute on the existing AW-ChatSessions item,
 *   activeRun: { runId, instanceId, startedAt, heartbeatAt }   (all strings / epoch-ms numbers)
 * No GSI, no backfill, no new table. Rollback = switch the setting off; a leftover attribute only goes stale
 * (it is ignored once heartbeatAt is older than ACTIVE_RUN_STALE_AFTER_MS) and is harmless.
 *
 * SWITCH: AW-Settings `session_active_run_guard_enabled`, exactly the string 'true' enables (no trim, no case
 * folding). Absent / anything else / a cold-start read failure => OFF, i.e. today's behaviour with zero writes.
 * A successful read is cached ~60s; a failed refresh keeps the last-known value (same pattern as
 * compareProviderPolicy.ts). It is deliberately NOT an env var.
 *
 * The claim is ONE conditional UpdateItem (the write is the check, no extra read). A lost condition => busy.
 * ANY other error (throttle, network, a mocked/absent client) FAILS OPEN: the run proceeds without the guard.
 * Writes here never touch updatedAt / adminListPartition, which would reorder session lists.
 *
 * Pure apart from the injected dependencies, so it is unit-testable with a fake DynamoDB.
 */
export const SESSION_ACTIVE_RUN_GUARD_SETTING = 'session_active_run_guard_enabled';

/** How often a live run refreshes `activeRun.heartbeatAt`. */
export const ACTIVE_RUN_HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * A heartbeat older than this no longer counts as a live run (3 missed beats). Instance clock skew in one
 * deployment is far below this, so plain epoch-ms comparison across instances is safe.
 */
export const ACTIVE_RUN_STALE_AFTER_MS = 3 * ACTIVE_RUN_HEARTBEAT_INTERVAL_MS;

const SETTING_CACHE_TTL_MS = 60_000;
/**
 * Upper bound on one switch read. /generate awaits it (at most once per cache window), so a hung AW-Settings read must
 * never stall the core path: on timeout we behave like any failed refresh (keep the last-known value, off if none).
 */
export const SETTING_READ_TIMEOUT_MS = 2_000;
/** After a failed refresh, retry sooner than a full window but not on every request. */
const SETTING_ERROR_RETRY_MS = 5_000;
const CONDITION_FAILED = 'ConditionalCheckFailedException';

export interface ActiveRun {
  runId: string;
  instanceId: string;
  startedAt: number;
  heartbeatAt: number;
}

/** True when `run` is a well-formed activeRun whose last heartbeat is within the staleness window. */
export function isActiveRunFresh(run: unknown, now: number): boolean {
  const beat = (run as Partial<ActiveRun> | null | undefined)?.heartbeatAt;
  return typeof beat === 'number' && Number.isFinite(beat) && beat >= now - ACTIVE_RUN_STALE_AFTER_MS;
}

/**
 * Hide `activeRun` from every serializer by construction: a non-enumerable own property is skipped by object
 * spread, Object.keys and JSON.stringify, yet stays readable as `item.activeRun` for in-process code (the
 * generating checks). Applied at the ChatbotDB read layer. No `activeRun` present => the item is untouched.
 */
export function concealActiveRun<T>(item: T): T {
  if (item && typeof item === 'object' && Object.prototype.propertyIsEnumerable.call(item, 'activeRun')) {
    Object.defineProperty(item, 'activeRun', {
      value: (item as { activeRun?: unknown }).activeRun,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  return item;
}

/** Carry a concealed activeRun from `from` onto a freshly spread copy `to` (spread drops non-enumerable keys). */
export function carryConcealedActiveRun<T extends object>(from: { activeRun?: unknown }, to: T): T {
  return from.activeRun === undefined ? to : concealActiveRun(Object.assign(to, { activeRun: from.activeRun }));
}

/** Copy of `value` without `activeRun` (a session, or `{ sessions: [...] }`). Never exposes runId/instanceId. */
export function omitActiveRun<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const strip = (s: any) => {
    if (!s || typeof s !== 'object' || !('activeRun' in s)) return s;
    const { activeRun: _a, ...rest } = s;
    return rest;
  };
  const v: any = value;
  if (Array.isArray(v.sessions)) return { ...strip(v), sessions: v.sessions.map(strip) } as T;
  return strip(v) as T;
}

export interface ActiveRunGuardDeps {
  getSetting(name: string): Promise<{ settingValue?: unknown } | null>;
  /** DocumentClient.update(params).promise() (resolved lazily so a missing client is a fail-open error). */
  update(params: Record<string, unknown>): Promise<unknown>;
  tableName(): string;
  now(): number;
  log(message: string, fields?: Record<string, unknown>): void;
  /** Per-process random id (not a hostname). */
  instanceId: string;
  newRunId(): string;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
}

export type ActiveRunClaim =
  /** Switch off, or the claim could not be made (fail-open): proceed without the guard. */
  | { status: 'skipped' }
  /** Another instance holds a fresh claim: reject with 409 SESSION_BUSY. */
  | { status: 'busy' }
  /** Claimed. `release()` MUST be called in the run's `finally`: it stops the timer synchronously. */
  | { status: 'claimed'; runId: string; release(): Promise<void> };

const errorClass = (error: unknown): string => (error as Error)?.name ?? 'Error';
const isConditionFailed = (error: unknown): boolean =>
  (error as any)?.code === CONDITION_FAILED || (error as any)?.name === CONDITION_FAILED;

export function createSessionActiveRunGuard(deps: ActiveRunGuardDeps) {
  const startTimer = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = deps.clearInterval ?? ((h) => clearInterval(h));

  let known = false; // last successfully read value; cold start => off
  let validUntil = 0;
  let inFlight: Promise<void> | null = null; // one refresh at a time

  async function refresh(now: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('settings read timed out')), SETTING_READ_TIMEOUT_MS);
        (timer as { unref?: () => void })?.unref?.();
      });
      const row = await Promise.race([deps.getSetting(SESSION_ACTIVE_RUN_GUARD_SETTING), timeout]);
      known = row?.settingValue === 'true';
      validUntil = now + SETTING_CACHE_TTL_MS;
    } catch (error) {
      deps.log('ActiveRunGuard: failed to read switch; keeping last-known value (off if none)', {
        errorClass: errorClass(error),
        known,
      });
      validUntil = now + SETTING_ERROR_RETRY_MS;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Never throws. */
  async function isEnabled(): Promise<boolean> {
    const now = deps.now();
    if (now >= validUntil) {
      inFlight ??= refresh(now).finally(() => { inFlight = null; });
      await inFlight;
    }
    return known;
  }

  /**
   * Is a run live on ANOTHER instance? This instance's own runs are answered by the in-memory lock, which is
   * authoritative and also covers the instant after a run ends but before its attribute is cleared.
   * Switch off => false without looking at the attribute. Never throws.
   */
  async function hasLiveRunElsewhere(run: unknown): Promise<boolean> {
    if (!run || typeof run !== 'object' || !isActiveRunFresh(run, deps.now())) return false;
    if ((run as Partial<ActiveRun>).instanceId === deps.instanceId) return false;
    return isEnabled();
  }

  async function claim(sessionId: string): Promise<ActiveRunClaim> {
    let runId: string;
    try {
      if (!(await isEnabled())) return { status: 'skipped' };
      runId = deps.newRunId();
      const now = deps.now();
      const run: ActiveRun = { runId, instanceId: deps.instanceId, startedAt: now, heartbeatAt: now };
      await deps.update({
        TableName: deps.tableName(),
        Key: { sessionId },
        UpdateExpression: 'SET activeRun = :r',
        // The write IS the check. Claimable when: no claim yet, the claim's heartbeat is stale, it is this run
        // already, or it was made by THIS instance (its in-memory lock, which we just won, proves that earlier
        // run ended here: e.g. Stop then an immediate resend before the old run's clear landed).
        ConditionExpression:
          'attribute_exists(sessionId) AND (attribute_not_exists(activeRun) OR activeRun.heartbeatAt < :staleBefore'
          + ' OR activeRun.runId = :me OR activeRun.instanceId = :instanceId)',
        ExpressionAttributeValues: {
          ':r': run,
          ':staleBefore': now - ACTIVE_RUN_STALE_AFTER_MS,
          ':me': runId,
          ':instanceId': deps.instanceId,
        },
      });
    } catch (error) {
      if (isConditionFailed(error)) return { status: 'busy' };
      deps.log('ActiveRunGuard: claim failed; proceeding without the guard (fail-open)', {
        sessionId,
        errorClass: errorClass(error),
      });
      return { status: 'skipped' };
    }

    let released = false;
    let beating = false;
    const beat = async (): Promise<void> => {
      if (released || beating) return;
      beating = true;
      try {
        await deps.update({
          TableName: deps.tableName(),
          Key: { sessionId },
          UpdateExpression: 'SET activeRun.heartbeatAt = :now',
          ConditionExpression: 'activeRun.runId = :me',
          ExpressionAttributeValues: { ':now': deps.now(), ':me': runId },
        });
      } catch (error) {
        // A lost or failed beat never stops the run; at worst another instance may claim after the window.
        deps.log('ActiveRunGuard: heartbeat failed (run continues)', {
          sessionId,
          errorClass: errorClass(error),
          lostClaim: isConditionFailed(error),
        });
      } finally {
        beating = false;
      }
    };
    const timer = startTimer(() => { void beat(); }, ACTIVE_RUN_HEARTBEAT_INTERVAL_MS);
    (timer as { unref?: () => void })?.unref?.(); // never keep the process alive

    return {
      status: 'claimed',
      runId,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        stopTimer(timer); // synchronous: the timer cannot outlive the run on any exit path
        try {
          await deps.update({
            TableName: deps.tableName(),
            Key: { sessionId },
            UpdateExpression: 'REMOVE activeRun',
            // Never clear a newer run's claim (ours went stale and another instance took over).
            ConditionExpression: 'activeRun.runId = :me',
            ExpressionAttributeValues: { ':me': runId },
          });
        } catch (error) {
          if (!isConditionFailed(error)) {
            deps.log('ActiveRunGuard: clear failed (leftover goes stale harmlessly)', {
              sessionId,
              errorClass: errorClass(error),
            });
          }
        }
      },
    };
  }

  return { isEnabled, hasLiveRunElsewhere, claim, instanceId: deps.instanceId };
}

export type SessionActiveRunGuard = ReturnType<typeof createSessionActiveRunGuard>;
