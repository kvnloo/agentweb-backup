/**
 * ENG-2371 (ENG-1240 slice B): automatic in-session continuation of a media batch.
 *
 * Drives the slice-A state machine (utils/mediaBatchStateMachine) behind an injected
 * store so a per-turn deadline leaves unfinished units queued for an automatic resume
 * instead of a customer-visible "reply continue". The store here is in-memory only;
 * durable persistence is slice C (no new table/schema in this slice).
 */
import {
  MediaBatch,
  UnitResult,
  createBatch,
  isTerminal,
  markRunning,
  nextRunnable,
  submitUnitResult,
} from '../../utils/mediaBatchStateMachine';

export interface StoredBatch {
  sessionId: string;
  batch: MediaBatch;
  /** True once the single completion notice for this batch has been emitted. */
  completionNotified: boolean;
}

export interface MediaBatchStore {
  get(batchId: string): Promise<StoredBatch | undefined>;
  put(record: StoredBatch): Promise<void>;
}

export class InMemoryMediaBatchStore implements MediaBatchStore {
  private readonly records = new Map<string, StoredBatch>();
  async get(batchId: string): Promise<StoredBatch | undefined> {
    const r = this.records.get(batchId);
    return r ? structuredClone(r) : undefined;
  }
  async put(record: StoredBatch): Promise<void> {
    this.records.set(record.batch.batchId, structuredClone(record));
  }
}

export type MediaBatchLogEvent =
  | {
      event: 'media_batch_unit';
      batchId: string;
      sessionId: string;
      unitIndex: number;
      durationMs: number;
      attempt: number;
      retryCount: number;
      outcome: 'succeeded' | 'failed_retryable' | 'failed_terminal';
    }
  | {
      event: 'media_batch_complete';
      batchId: string;
      sessionId: string;
      succeeded: number;
      failed: number;
      total: number;
    }
  | { event: 'media_batch_deadline'; batchId: string; sessionId: string; remaining: number };

export interface RunDeps {
  store: MediaBatchStore;
  generate: (input: Record<string, unknown>, unitKey: string) => Promise<UnitResult>;
  /** Attaches a finished asset to the ORIGINAL session. */
  attachAsset: (sessionId: string, assetId: string, unitIndex: number) => Promise<void>;
  /** Called exactly once per batch, when it reaches a terminal state. */
  notifyComplete: (sessionId: string, batch: MediaBatch) => Promise<void>;
  /** Schedules the next automatic continuation (replaces the "reply continue" ask). */
  scheduleContinuation: (batchId: string) => void;
  now: () => number;
  log: (e: MediaBatchLogEvent) => void;
}

export async function startMediaBatch(
  store: MediaBatchStore,
  sessionId: string,
  batchId: string,
  inputs: Record<string, unknown>[],
): Promise<void> {
  if (await store.get(batchId)) return; // idempotent start
  await store.put({ sessionId, batch: createBatch(batchId, inputs), completionNotified: false });
}

/**
 * Runs runnable units until the batch is terminal or `deadlineAt` passes. On deadline,
 * schedules an automatic continuation; never asks the customer to reply.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** Serializes runs per batchId within this process so two continuations never lease the same unit. */
export function runMediaBatch(
  batchId: string,
  deadlineAt: number,
  deps: RunDeps,
): Promise<'complete' | 'continuing' | 'missing'> {
  const prev = inFlight.get(batchId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => runMediaBatchUnlocked(batchId, deadlineAt, deps));
  const tail = run.catch(() => undefined);
  inFlight.set(batchId, tail);
  void tail.then(() => {
    if (inFlight.get(batchId) === tail) inFlight.delete(batchId);
  });
  return run;
}

async function runMediaBatchUnlocked(
  batchId: string,
  deadlineAt: number,
  deps: RunDeps,
): Promise<'complete' | 'continuing' | 'missing'> {
  const record = await deps.store.get(batchId);
  if (!record) return 'missing';
  let { batch } = record;
  const { sessionId } = record;

  while (!isTerminal(batch, deps.now())) {
    const runnable = nextRunnable(batch, deps.now());
    if (runnable.length === 0 || deps.now() >= deadlineAt) {
      const remaining = batch.units.filter((u) => u.state !== 'succeeded' && u.state !== 'failed_terminal' && u.state !== 'cancelled').length;
      deps.log({ event: 'media_batch_deadline', batchId, sessionId, remaining });
      await deps.store.put({ ...record, batch });
      deps.scheduleContinuation(batchId);
      return 'continuing';
    }
    const unit = runnable[0];
    const started = deps.now();
    batch = markRunning(batch, unit.index, started);
    await deps.store.put({ ...record, batch }); // lease persisted before the provider call
    let result: UnitResult;
    try {
      result = await deps.generate(unit.input, unit.key);
    } catch (err) {
      // A rejected provider call must not strand the lease: record a retryable failure.
      result = { ok: false, retryable: true, reason: err instanceof Error ? err.message : String(err) };
    }
    const applied = submitUnitResult(batch, unit.key, deps.now(), result);
    batch = applied.batch;
    const after = batch.units[unit.index];
    // Persist the generation result before attaching so an attach failure never re-generates.
    await deps.store.put({ ...record, batch });
    if (applied.applied && after.state === 'succeeded' && after.assetId) {
      await deps.attachAsset(sessionId, after.assetId, unit.index);
    }
    deps.log({
      event: 'media_batch_unit',
      batchId,
      sessionId,
      unitIndex: unit.index,
      durationMs: deps.now() - started,
      attempt: after.attempts,
      retryCount: Math.max(0, after.attempts - 1),
      outcome: after.state as 'succeeded' | 'failed_retryable' | 'failed_terminal',
    });
  }

  const latest = (await deps.store.get(batchId)) ?? { ...record, batch };
  if (!latest.completionNotified) {
    const succeeded = batch.units.filter((u) => u.state === 'succeeded').length;
    deps.log({
      event: 'media_batch_complete',
      batchId,
      sessionId,
      succeeded,
      failed: batch.units.length - succeeded,
      total: batch.units.length,
    });
    // Notify first; only record delivery after it succeeds so a failed notice is retried.
    await deps.notifyComplete(sessionId, batch);
    await deps.store.put({ sessionId, batch, completionNotified: true });
  }
  return 'complete';
}
