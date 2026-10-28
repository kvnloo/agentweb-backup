/**
 * ENG-110: per-user soft cap on concurrently generating INTERACTIVE chats.
 *
 * Scope: only human-initiated turns by the session owner (/generate and
 * /verified-generate). Scheduled runs, auto-continuations, Slack, email and
 * approval-inbox paths never call this module, so they can neither consume a
 * user's slots nor be blocked by the cap.
 *
 * State is in-memory and per backend instance. It resets on restart, and during
 * an Immutable deploy two instances briefly coexist, so a user can momentarily
 * hold up to `limit` slots on each. That is accepted: it is a soft cap meant to
 * stop runaway tab-spamming, not a billing control, and the overlap is bounded
 * by the deploy window.
 *
 * Limit: AW-Settings `max_concurrent_generations_per_user` (cached ~60s, last
 * known value used if a refresh fails). Absent/invalid => 3. 0 => unlimited.
 *
 * ENG-2648: a turn that continues a paused conversation (an approval-deck answer
 * or cancel, a work-plan details answer) may exceed `limit` — refusing it after
 * its pending state was consumed would lose the outcome — but never the hard
 * ceiling `limit * PAUSED_TURN_CEILING_MULTIPLIER`. The caller takes that slot
 * BEFORE consuming the pending state, so a refusal at the ceiling loses nothing.
 */
import { settingsService } from '../settingsService';

export const MAX_CONCURRENT_GENERATIONS_SETTING = 'max_concurrent_generations_per_user';
export const DEFAULT_MAX_CONCURRENT_GENERATIONS_PER_USER = 3;
export const PAUSED_TURN_CEILING_MULTIPLIER = 2;
const CACHE_TTL_MS = 60_000;

let cachedLimit: number | null = null; // last known good (or default-from-absent) value
let cachedAt = 0;

function parseLimit(raw: unknown): number {
  const str = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (/^\d{1,6}$/.test(str)) return Number(str);
  return DEFAULT_MAX_CONCURRENT_GENERATIONS_PER_USER;
}

/** Never throws. */
export async function getMaxConcurrentGenerationsPerUser(): Promise<number> {
  const now = Date.now();
  if (cachedLimit !== null && now - cachedAt < CACHE_TTL_MS) return cachedLimit;
  try {
    const setting = await settingsService.getSetting(MAX_CONCURRENT_GENERATIONS_SETTING);
    cachedLimit = setting ? parseLimit(setting.settingValue) : DEFAULT_MAX_CONCURRENT_GENERATIONS_PER_USER;
    cachedAt = now;
  } catch (error) {
    console.error(`[concurrentGenerationCap] failed to read ${MAX_CONCURRENT_GENERATIONS_SETTING}; using last-known/default:`, error);
    if (cachedLimit === null) cachedLimit = DEFAULT_MAX_CONCURRENT_GENERATIONS_PER_USER;
    cachedAt = now; // back off: do not hammer a failing table on every request
  }
  return cachedLimit;
}

// userId -> sessionId -> holder count. Distinct sessions are what is capped.
const active = new Map<string, Map<string, number>>();

export type SlotResult =
  | { ok: true; release: () => void }
  | { ok: false; limit: number; current: number };

/**
 * On `ok`, the caller MUST call `release()` in a `finally` (release is idempotent).
 * A rejected result holds nothing. The check-and-add is synchronous (after the
 * limit read), so it is race-free.
 *
 * A normal turn is taken AFTER the session generation claim succeeded and is
 * refused at `limit`. A `continuesPausedTurn` slot is taken BEFORE the paused
 * state is consumed (see /generate) and is refused only at the hard ceiling
 * `limit * PAUSED_TURN_CEILING_MULTIPLIER`; the refusal body reports that ceiling.
 */
export async function acquireInteractiveGenerationSlot(
  userId: string,
  sessionId: string,
  options?: { continuesPausedTurn?: boolean },
): Promise<SlotResult> {
  const limit = await getMaxConcurrentGenerationsPerUser();
  let sessions = active.get(userId);
  if (limit > 0) {
    const max = options?.continuesPausedTurn ? limit * PAUSED_TURN_CEILING_MULTIPLIER : limit;
    const others = sessions ? sessions.size - (sessions.has(sessionId) ? 1 : 0) : 0;
    if (others >= max) return { ok: false, limit: max, current: others };
  }
  if (!sessions) {
    sessions = new Map();
    active.set(userId, sessions);
  }
  sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      const held = active.get(userId);
      if (!held) return;
      const n = (held.get(sessionId) ?? 0) - 1;
      if (n > 0) held.set(sessionId, n);
      else held.delete(sessionId);
      if (held.size === 0) active.delete(userId);
    },
  };
}

/**
 * ENG-110: ids of the CALLER's sessions that currently hold an interactive generation slot on this instance.
 * Reads only `active.get(userId)`: other users' entries are never iterated or returned. A slot is added on claim
 * and removed by release() in the handler's `finally`, so this cannot leak past a run (success, throw, timeout).
 * During an Immutable deploy overlap another instance's runs are invisible (accepted).
 */
export function getGeneratingSessionIdsForUser(userId: string): string[] {
  const sessions = active.get(userId);
  return sessions ? [...sessions.keys()] : [];
}

export function buildTooManyRunsBody(current: number, limit: number) {
  return {
    error: 'Too many concurrent runs',
    code: 'TOO_MANY_CONCURRENT_RUNS' as const,
    message: `You have ${current} chats generating at once. Wait for one to finish, then try again.`,
    limit,
  };
}

/** Thrown by runVerifiedChat so the verified-generate handler can answer 429. */
export class TooManyConcurrentRunsError extends Error {
  code = 'TOO_MANY_CONCURRENT_RUNS';
  constructor(public readonly current: number, public readonly limit: number) {
    super(`User has ${current} concurrent generations (limit ${limit}).`);
    this.name = 'TooManyConcurrentRunsError';
  }
}

export function isTooManyConcurrentRunsError(error: unknown): error is TooManyConcurrentRunsError {
  return error instanceof TooManyConcurrentRunsError
    || (typeof error === 'object' && error !== null && (error as any).code === 'TOO_MANY_CONCURRENT_RUNS');
}

export function __resetConcurrentGenerationCapForTests(): void {
  active.clear();
  cachedLimit = null;
  cachedAt = 0;
}

export function __activeGenerationCountForTests(userId: string): number {
  return active.get(userId)?.size ?? 0;
}
