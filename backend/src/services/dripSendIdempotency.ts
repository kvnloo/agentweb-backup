/**
 * ENG-2541 (slice of ENG-2167): pure drip-step send idempotency.
 *
 * - dripSendIdempotencyKey: deterministic, header-safe key per
 *   (org, sequence, enrollment, step[, attemptEpoch]). Stable across worker
 *   retries; a new enrollmentId (re-enrolment) yields a new key.
 * - decideDuplicateSend: given prior send records for a key, decide whether a
 *   send may proceed. No persistence, no network.
 */
import { createHash } from 'crypto';

export interface DripSendKeyInput {
  orgId: string;
  sequenceId: string;
  enrollmentId: string;
  stepIndex: number;
  attemptEpoch?: number;
}

const KEY_PREFIX = 'drip:v1:';

export function dripSendIdempotencyKey(input: DripSendKeyInput): string {
  const { orgId, sequenceId, enrollmentId, stepIndex, attemptEpoch } = input;
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    throw new Error(`invalid stepIndex: ${stepIndex}`);
  }
  if (attemptEpoch !== undefined && (!Number.isInteger(attemptEpoch) || attemptEpoch < 0)) {
    throw new Error(`invalid attemptEpoch: ${attemptEpoch}`);
  }
  // JSON array encoding keeps field boundaries unambiguous before hashing.
  const canonical = JSON.stringify([orgId, sequenceId, enrollmentId, stepIndex, attemptEpoch ?? null]);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${KEY_PREFIX}${digest}`;
}

export type PriorSendStatus = 'queued' | 'sent' | 'failed';

export interface PriorSend {
  key: string;
  status: PriorSendStatus;
  at: number | Date;
}

export interface DuplicateSendInput {
  key: string;
  priorSends: PriorSend[];
  now: number | Date;
  staleQueuedMs: number;
}

export type DuplicateSendDecision =
  | { send: true }
  | { send: false; reason: 'already_sent' | 'in_flight' };

const toMs = (t: number | Date): number => (t instanceof Date ? t.getTime() : t);

export function decideDuplicateSend(input: DuplicateSendInput): DuplicateSendDecision {
  const { key, priorSends, staleQueuedMs } = input;
  const now = toMs(input.now);
  const matching = priorSends.filter((p) => p.key === key);
  if (matching.some((p) => p.status === 'sent')) {
    return { send: false, reason: 'already_sent' };
  }
  const queued = matching.filter((p) => p.status === 'queued');
  // Fail closed: a non-finite timestamp or timing input would make every
  // freshness comparison false and silently authorize a duplicate send.
  if (
    queued.length > 0 &&
    (!Number.isFinite(now) ||
      !Number.isFinite(staleQueuedMs) ||
      queued.some((p) => !Number.isFinite(toMs(p.at))))
  ) {
    throw new Error('invalid duplicate-send timing');
  }
  const freshQueued = queued.some((p) => now - toMs(p.at) < staleQueuedMs);
  if (freshQueued) {
    return { send: false, reason: 'in_flight' };
  }
  return { send: true };
}
