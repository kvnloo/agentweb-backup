/**
 * In-memory progress tracker for bulk email actions (find / validate / lookup).
 *
 * Backed by a process-local Map. Frontend polls
 *   GET /api/crm/lists/:listId/email-jobs/:jobId
 * to surface live progress and final counts.
 *
 * Persistence: NONE. If the backend restarts mid-job, the polling endpoint
 * returns 404 and the frontend falls back to an "unknown" state. The work
 * itself is also lost; users re-trigger. This is acceptable for v1 — bulk
 * jobs are short (seconds-to-minutes) and the tracker only exists to make
 * the UX visible.
 */

export type EmailJobKind = 'find' | 'validate' | 'lookup';
export type EmailJobStatus = 'running' | 'completed' | 'error';

export interface EmailJobState {
  jobId: string;
  kind: EmailJobKind;
  listId: string;
  userId: string;
  total: number;
  processed: number;
  /** For find/lookup: emails actually populated. For validate: deliverable count. */
  found: number;
  /** For find: leads where every tier missed. For validate: undeliverable.
   *  For lookup: leads where the API returned no profile. */
  notFound: number;
  /** Per-tier breakdown for find jobs (which tier resolved which lead).
   *  For validate/lookup: empty. */
  tierBreakdown?: Record<string, number>;
  errors: number;
  startedAt: string;
  completedAt?: string;
  status: EmailJobStatus;
  /** Free-text describing the failure when status === 'error'. */
  errorMessage?: string;
}

const TTL_MS = 30 * 60_000;          // keep completed jobs visible for 30 min
const STUCK_RUNNING_TTL_MS = 2 * 60 * 60_000;   // S7: drop running jobs older than 2h — caller crashed before completeJob
const _jobs = new Map<string, EmailJobState>();

function gc() {
  const now = Date.now();
  for (const [id, j] of _jobs.entries()) {
    if (j.status !== 'running' && j.completedAt) {
      if (now - new Date(j.completedAt).getTime() > TTL_MS) _jobs.delete(id);
    } else if (j.status === 'running') {
      // Stuck running — caller crashed/forgot to call completeJob. Don't keep
      // these around forever; otherwise getJob() shows stale "in progress" UI.
      if (now - new Date(j.startedAt).getTime() > STUCK_RUNNING_TTL_MS) _jobs.delete(id);
    }
  }
}

function newJobId(kind: EmailJobKind): string {
  return `${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function startEmailJob(args: {
  kind: EmailJobKind;
  listId: string;
  userId: string;
  total: number;
}): EmailJobState {
  gc();
  const job: EmailJobState = {
    jobId: newJobId(args.kind),
    kind: args.kind,
    listId: args.listId,
    userId: args.userId,
    total: args.total,
    processed: 0,
    found: 0,
    notFound: 0,
    tierBreakdown: {},
    errors: 0,
    startedAt: new Date().toISOString(),
    status: 'running',
  };
  _jobs.set(job.jobId, job);
  return job;
}

export function recordResult(jobId: string, args: {
  found: boolean;
  tier?: number;
  error?: boolean;
}): void {
  const j = _jobs.get(jobId);
  if (!j) return;
  j.processed++;
  if (args.error) j.errors++;
  else if (args.found) {
    j.found++;
    if (args.tier && j.tierBreakdown) {
      const k = `tier${args.tier}`;
      j.tierBreakdown[k] = (j.tierBreakdown[k] ?? 0) + 1;
    }
  } else {
    j.notFound++;
  }
}

export function completeJob(jobId: string, errorMessage?: string): void {
  const j = _jobs.get(jobId);
  if (!j) return;
  j.completedAt = new Date().toISOString();
  j.status = errorMessage ? 'error' : 'completed';
  if (errorMessage) j.errorMessage = errorMessage;
}

export function getJob(jobId: string): EmailJobState | null {
  // Run gc on every read so an idle backend (no new startEmailJob calls)
  // still expires completed and stuck-running jobs eventually.
  gc();
  return _jobs.get(jobId) ?? null;
}

/** Test-only: wipe all jobs. */
export function __resetJobsForTesting(): void {
  _jobs.clear();
}
