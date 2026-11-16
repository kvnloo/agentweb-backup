/**
 * ENG-2520 (slice of ENG-2501): store-agnostic dispatcher for due scheduled posts.
 * Storage and publishing are injected ports; no real implementation exists yet
 * (the storage decision on ENG-2501 is still open).
 */
import { ScheduledPostRecord, selectDuePosts, transition } from './scheduledPostLifecycle';

export interface ScheduledPostRepository {
  listPending(now: Date): Promise<ScheduledPostRecord[]>;
  /** Fresh read used to re-check status immediately before publishing. */
  get(id: string): Promise<ScheduledPostRecord | undefined>;
  save(record: ScheduledPostRecord): Promise<void>;
}

export type PublishResult = { ok: true } | { ok: false; error: string; retryable: boolean };

/**
 * Publication contract: implementations MUST be idempotent on `idempotencyKey`
 * (a repeat call with the same key must not publish a second time). The
 * dispatcher's fresh read narrows but cannot close the window between publish
 * and save (concurrent dispatchers, or save failing after a successful publish),
 * so duplicate-safety is owned by the publisher, keyed by post ID.
 */
export interface ScheduledPostPublisher {
  publish(record: ScheduledPostRecord, opts: { idempotencyKey: string }): Promise<PublishResult>;
}

export function scheduledPostIdempotencyKey(postId: string): string {
  return `scheduled-post:${postId}`;
}

export interface DispatchSummary {
  fired: string[];
  failed: string[];
  retried: string[];
  skipped: string[];
  errors: { id: string; error: string }[];
}

export async function dispatchDuePosts(deps: {
  repo: ScheduledPostRepository;
  publisher: ScheduledPostPublisher;
  now: Date;
}): Promise<DispatchSummary> {
  const { repo, publisher, now } = deps;
  const summary: DispatchSummary = { fired: [], failed: [], retried: [], skipped: [], errors: [] };
  const due = selectDuePosts(await repo.listPending(now), now);

  for (const candidate of due) {
    try {
      const current = await repo.get(candidate.id);
      if (!current || current.status !== 'pending' || current.publishAt.getTime() > now.getTime()) {
        summary.skipped.push(candidate.id);
        continue;
      }
      let result: PublishResult;
      try {
        result = await publisher.publish(current, { idempotencyKey: scheduledPostIdempotencyKey(current.id) });
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
      }
      if (result.ok) {
        const t = transition(current, { type: 'markFired', now });
        if (t.ok && t.changed) await repo.save(t.record);
        summary.fired.push(current.id);
      } else {
        const t = transition(current, { type: 'markAttemptFailed', now, error: result.error, retryable: result.retryable });
        if (!t.ok) throw new Error(t.message);
        if (t.changed) await repo.save(t.record);
        if (t.record.status === 'pending') summary.retried.push(current.id);
        else summary.failed.push(current.id);
        summary.errors.push({ id: current.id, error: result.error });
      }
    } catch (err) {
      summary.failed.push(candidate.id);
      summary.errors.push({ id: candidate.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}
