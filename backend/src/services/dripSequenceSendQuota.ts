/**
 * ENG-2533 (ENG-2167 slice): pure per-sender daily send-quota + warmup throttle.
 *
 * Decides whether a due drip email step may send now. Pure and deterministic:
 * time is injected, no persistence, no Resend calls. Not yet wired into
 * dripSequenceWorker (follow-up).
 */

export interface SendQuotaInput {
  /** Sends already made by this sender in the current UTC day. */
  sentToday: number;
  /** Configured hard daily cap for the sender. */
  dailyCap: number;
  /** Days since the sender (domain/key) started sending; 0 = first day. */
  senderAgeDays: number;
  /** Current time (injected). */
  now: Date;
  /** Optional override of the warmup ramp. */
  ramp?: WarmupRamp;
}

export type SendQuotaReason = 'ok' | 'daily_cap' | 'warmup_cap' | 'invalid_config';

export interface SendQuotaDecision {
  allow: boolean;
  reason: SendQuotaReason;
  effectiveCap?: number;
  retryAt?: Date;
}

/** Ramp steps: from `fromDay` (inclusive) onward the sender may send up to `cap`/day. */
export type WarmupRamp = ReadonlyArray<{ fromDay: number; cap: number }>;

/**
 * Default warmup ramp (conservative new-domain schedule):
 * day 0-2: 20/day, 3-6: 50, 7-13: 100, 14-20: 250, 21-27: 500, 28+: unlimited (configured cap).
 */
export const DEFAULT_WARMUP_RAMP: WarmupRamp = [
  { fromDay: 0, cap: 20 },
  { fromDay: 3, cap: 50 },
  { fromDay: 7, cap: 100 },
  { fromDay: 14, cap: 250 },
  { fromDay: 21, cap: 500 },
  { fromDay: 28, cap: Number.POSITIVE_INFINITY },
];

const isNonNegInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0;

export function rampCap(senderAgeDays: number, ramp: WarmupRamp = DEFAULT_WARMUP_RAMP): number {
  let cap = 0;
  for (const step of ramp) {
    if (senderAgeDays >= step.fromDay) cap = step.cap;
  }
  return cap;
}

export function nextUtcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function validRamp(ramp: WarmupRamp): boolean {
  if (!Array.isArray(ramp) || ramp.length === 0) return false;
  for (let i = 0; i < ramp.length; i++) {
    const s = ramp[i];
    if (s === null || typeof s !== 'object') return false;
    if (i === 0 && s.fromDay !== 0) return false;
    if (!isNonNegInt(s.fromDay) || !(s.cap === Number.POSITIVE_INFINITY || isNonNegInt(s.cap))) return false;
    if (i > 0 && s.fromDay <= ramp[i - 1].fromDay) return false;
  }
  return true;
}

export function decideDripSend(input: SendQuotaInput | null | undefined): SendQuotaDecision {
  if (!input) return { allow: false, reason: 'invalid_config' };
  const { sentToday, dailyCap, senderAgeDays, now } = input;
  const ramp = input.ramp ?? DEFAULT_WARMUP_RAMP;
  if (
    !isNonNegInt(sentToday) ||
    !isNonNegInt(dailyCap) ||
    dailyCap === 0 ||
    !isNonNegInt(senderAgeDays) ||
    !(now instanceof Date) ||
    Number.isNaN(now.getTime()) ||
    !validRamp(ramp)
  ) {
    return { allow: false, reason: 'invalid_config' };
  }

  const warm = rampCap(senderAgeDays, ramp);
  const effectiveCap = Math.min(dailyCap, warm);
  if (sentToday < effectiveCap) return { allow: true, reason: 'ok', effectiveCap };

  const retryAt = nextUtcDayStart(now);
  const reason: SendQuotaReason = warm < dailyCap ? 'warmup_cap' : 'daily_cap';
  return { allow: false, reason, effectiveCap, retryAt };
}
