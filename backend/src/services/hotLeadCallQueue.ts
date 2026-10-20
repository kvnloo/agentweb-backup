import { enqueueJob, markJobComplete, markJobFailed, startHeartbeat } from './asyncJobQueue';
import { errorText } from './hotLeadCallText';

/**
 * Queues a hot-lead-call job under its permanent key and runs it once in this process: claim on enqueue,
 * heartbeat while it works, then mark it complete or failed. A key that was queued before is `duplicate` and
 * nothing runs. `background` returns once the job is queued instead of when it has finished. Throws when the
 * queue itself is unavailable; a failing `process` is recorded on the queue row and never thrown.
 */
export async function runQueuedHotLeadJob<J>(opts: {
  source: string;
  key: string;
  job: J;
  process: (job: J) => Promise<void>;
  /** Names the job in the failure the queue row keeps. */
  label: string;
  background?: boolean;
}): Promise<'duplicate' | 'started'> {
  const { source, key, job } = opts;
  const queued = await enqueueJob(source, key, job, { claimImmediately: true });
  if (queued === 'duplicate') return 'duplicate';
  if (queued !== 'enqueued') throw new Error('Hot lead call queue unavailable');
  const run = async (): Promise<void> => {
    const stop = startHeartbeat(source, key);
    try {
      await opts.process(job);
      await markJobComplete(source, key);
    } catch (err) {
      await markJobFailed(source, key, new Error(`${opts.label} failed: ${errorText(err)}`)).catch(() => undefined);
    } finally { stop(); }
  };
  // A crash before a background run finishes is covered by the queue reclaiming the job.
  if (opts.background) void run();
  else await run();
  return 'started';
}
