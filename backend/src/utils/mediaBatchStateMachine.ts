/**
 * ENG-2370 (ENG-1240 slice A): pure, I/O-free media-batch unit state machine.
 *
 * Models a media batch as N units so an interrupted batch (e.g. a turn deadline
 * after 3 of 4 images) can resume only the unfinished units, never re-run
 * succeeded ones, retry only retryable failures within a budget, and keep
 * provider failure distinct from cancellation. No persistence, no network.
 */
import { createHash } from 'crypto';

export type UnitState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'cancelled';

export interface BatchPolicy {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** A running unit whose lease has expired is treated as interrupted. */
  leaseMs: number;
}

export const DEFAULT_POLICY: BatchPolicy = {
  maxAttempts: 3,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  leaseMs: 5 * 60_000,
};

export interface MediaUnit {
  index: number;
  key: string;
  input: Record<string, unknown>;
  state: UnitState;
  attempts: number;
  startedAt?: number;
  /** Earliest time a failed_retryable unit may run again. */
  notBefore?: number;
  lastError?: string;
  assetId?: string;
}

export interface MediaBatch {
  batchId: string;
  policy: BatchPolicy;
  units: MediaUnit[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function unitIdempotencyKey(batchId: string, index: number, input: Record<string, unknown>): string {
  const inputHash = createHash('sha256').update(canonical(input)).digest('hex').slice(0, 16);
  return `${batchId}:${index}:${inputHash}`;
}

export function createBatch(
  batchId: string,
  inputs: Record<string, unknown>[],
  policy: BatchPolicy = DEFAULT_POLICY,
): MediaBatch {
  return {
    batchId,
    policy,
    units: inputs.map((input, index) => ({
      index,
      key: unitIdempotencyKey(batchId, index, input),
      input,
      state: 'queued',
      attempts: 0,
    })),
  };
}

export function backoffMs(attempt: number, policy: BatchPolicy): number {
  const exp = policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exp, policy.maxBackoffMs);
}

function leaseExpired(u: MediaUnit, policy: BatchPolicy, now: number): boolean {
  return u.state === 'running' && u.startedAt !== undefined && now - u.startedAt > policy.leaseMs;
}

function hasBudget(u: MediaUnit, policy: BatchPolicy): boolean {
  return u.attempts < policy.maxAttempts;
}

export function nextRunnable(batch: MediaBatch, now: number): MediaUnit[] {
  const { policy } = batch;
  return batch.units.filter((u) => {
    if (u.state === 'queued') return true;
    if (u.state === 'failed_retryable') return hasBudget(u, policy) && (u.notBefore ?? 0) <= now;
    if (leaseExpired(u, policy, now)) return hasBudget(u, policy);
    return false;
  });
}

/** Terminal when no unit can ever run again. `now` lets expired, budget-exhausted leases count. */
export function isTerminal(batch: MediaBatch, now?: number): boolean {
  return batch.units.every((u) => {
    if (u.state === 'succeeded' || u.state === 'failed_terminal' || u.state === 'cancelled') return true;
    if (u.state === 'running' && now !== undefined && leaseExpired(u, batch.policy, now)) {
      return !hasBudget(u, batch.policy);
    }
    return false;
  });
}

function update(batch: MediaBatch, index: number, fn: (u: MediaUnit) => MediaUnit): MediaBatch {
  const unit = batch.units[index];
  if (!unit) throw new Error(`unit ${index} not in batch ${batch.batchId}`);
  return { ...batch, units: batch.units.map((u) => (u.index === index ? fn(u) : u)) };
}

export function markRunning(batch: MediaBatch, index: number, now: number): MediaBatch {
  return update(batch, index, (u) => {
    const runnable = nextRunnable(batch, now).some((r) => r.index === index);
    if (!runnable) throw new Error(`unit ${index} is not runnable (state=${u.state})`);
    return { ...u, state: 'running', attempts: u.attempts + 1, startedAt: now, notBefore: undefined };
  });
}

export function markSucceeded(batch: MediaBatch, index: number, _now: number, result: { assetId: string }): MediaBatch {
  return update(batch, index, (u) => {
    if (u.state !== 'running') throw new Error(`unit ${index} not running (state=${u.state})`);
    return { ...u, state: 'succeeded', assetId: result.assetId, lastError: undefined };
  });
}

export function markFailed(
  batch: MediaBatch,
  index: number,
  now: number,
  failure: { retryable: boolean; reason: string },
): MediaBatch {
  const { policy } = batch;
  return update(batch, index, (u) => {
    if (u.state !== 'running') throw new Error(`unit ${index} not running (state=${u.state})`);
    const retry = failure.retryable && hasBudget(u, policy);
    return {
      ...u,
      state: retry ? 'failed_retryable' : 'failed_terminal',
      lastError: failure.reason,
      notBefore: retry ? now + backoffMs(u.attempts, policy) : undefined,
    };
  });
}

/** Cancels every non-finished unit; already-terminal outcomes are preserved. */
export function cancelBatch(batch: MediaBatch, _now: number): MediaBatch {
  return {
    ...batch,
    units: batch.units.map((u) =>
      u.state === 'succeeded' || u.state === 'failed_terminal' ? u : { ...u, state: 'cancelled' as const },
    ),
  };
}

export type UnitResult = { ok: true; assetId: string } | { ok: false; retryable: boolean; reason: string };

/** Idempotent result submission keyed by unit idempotency key. Completed/unknown keys are no-ops. */
export function submitUnitResult(
  batch: MediaBatch,
  key: string,
  now: number,
  result: UnitResult,
): { batch: MediaBatch; applied: boolean } {
  const unit = batch.units.find((u) => u.key === key);
  if (!unit || unit.state !== 'running') return { batch, applied: false };
  const next = result.ok
    ? markSucceeded(batch, unit.index, now, { assetId: result.assetId })
    : markFailed(batch, unit.index, now, { retryable: result.retryable, reason: result.reason });
  return { batch: next, applied: true };
}
