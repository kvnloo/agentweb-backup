/**
 * ENG-2953 (ENG-2812.3): SHADOW wiring of the ENG-2820 session turn/spend breaker.
 *
 * ON BY DEFAULT (log-only) since ENG-2812: prod's Elastic Beanstalk environment-variable block
 * is at CloudFormation's 4096-character cap, so a new env property cannot be added there. Set
 * SESSION_BREAKER_SHADOW=false (or 0 / off) to turn it off. Every agent-loop LLM turn is
 * counted against a process-local per-session accumulator and the pure evaluator is run.
 * A non-`continue` decision emits ONE structured `session_breaker_would_pause` log line per
 * cap multiple crossed. It never pauses, never alters the response, never writes to any
 * table, and never notifies anyone — it only produces evidence for picking per-tier caps.
 *
 * Accumulators are in-memory and per-instance (reset on restart); acceptable for shadow
 * evidence, and deliberately not persisted (persistence stays on ENG-2812, Requires: Me).
 */
import { evaluateSessionSpendBreaker, SessionSpendCaps } from './sessionSpendBreaker';

export interface SessionBreakerShadowConfig {
  caps: SessionSpendCaps;
}

type Env = Record<string, string | undefined>;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Returns null (no-op) only when SESSION_BREAKER_SHADOW is "false", "0" or "off"; on otherwise. */
export function readSessionBreakerShadowConfig(env: Env = process.env): SessionBreakerShadowConfig | null {
  const flag = (env.SESSION_BREAKER_SHADOW ?? '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return null;
  return {
    caps: {
      maxTurns: positiveNumber(env.SESSION_BREAKER_SHADOW_MAX_TURNS, 40),
      maxSpendUsd: positiveNumber(env.SESSION_BREAKER_SHADOW_MAX_SPEND_USD, 5),
    },
  };
}

interface SessionAccumulator {
  turns: number;
  spendUsd: number;
  lastLoggedMultiple: number;
  lastSeenMs: number;
}

const MAX_TRACKED_SESSIONS = 5000;
const accumulators = new Map<string, SessionAccumulator>();

export interface SessionBreakerShadowTurn {
  sessionId: string;
  userId?: string;
  billingUserId?: string;
  isScheduled: boolean;
  /** Lazily computed so the flag-off path does no work at all. */
  costUsd: () => number;
}

export interface SessionBreakerShadowDeps {
  env?: Env;
  log?: (line: string) => void;
  evaluate?: typeof evaluateSessionSpendBreaker;
  now?: () => number;
}

/**
 * Count one agent-loop turn for `turn.sessionId` and log a would-pause event when a new cap
 * multiple is crossed. Never throws; returns nothing the caller could act on.
 */
export function recordSessionBreakerShadowTurn(turn: SessionBreakerShadowTurn, deps: SessionBreakerShadowDeps = {}): void {
  try {
    const config = readSessionBreakerShadowConfig(deps.env ?? process.env);
    if (!config || !turn.sessionId) return;
    const evaluate = deps.evaluate ?? evaluateSessionSpendBreaker;
    const log = deps.log ?? ((line: string) => console.log(line));
    const now = (deps.now ?? Date.now)();

    let acc = accumulators.get(turn.sessionId);
    if (!acc) {
      if (accumulators.size >= MAX_TRACKED_SESSIONS) evictOldest();
      acc = { turns: 0, spendUsd: 0, lastLoggedMultiple: 0, lastSeenMs: now };
      accumulators.set(turn.sessionId, acc);
    }
    const cost = turn.costUsd();
    acc.turns += 1;
    if (Number.isFinite(cost) && cost > 0) acc.spendUsd += cost;
    acc.lastSeenMs = now;

    const decision = evaluate({ turns: acc.turns, spendUsd: acc.spendUsd, caps: config.caps, isScheduled: turn.isScheduled });
    if (decision.action === 'continue') return;

    const multiple = Math.max(
      Math.floor(acc.turns / config.caps.maxTurns),
      Math.floor(acc.spendUsd / config.caps.maxSpendUsd),
    );
    if (multiple <= acc.lastLoggedMultiple) return;
    acc.lastLoggedMultiple = multiple;

    log(JSON.stringify({
      event: 'session_breaker_would_pause',
      sessionId: turn.sessionId,
      userId: turn.userId,
      billingUserId: turn.billingUserId,
      turns: acc.turns,
      spendUsd: Number(acc.spendUsd.toFixed(4)),
      multiple,
      action: decision.action,
      reason: decision.reason,
      isScheduled: turn.isScheduled,
      maxTurns: config.caps.maxTurns,
      maxSpendUsd: config.caps.maxSpendUsd,
    }));
  } catch {
    // Shadow telemetry must never affect a live turn.
  }
}

function evictOldest(): void {
  let oldestKey: string | undefined;
  let oldest = Infinity;
  for (const [key, acc] of accumulators) {
    if (acc.lastSeenMs < oldest) {
      oldest = acc.lastSeenMs;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) accumulators.delete(oldestKey);
}

/** Test-only reset. */
export function __resetSessionBreakerShadowForTests(): void {
  accumulators.clear();
}
