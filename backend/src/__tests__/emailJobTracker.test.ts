import {
  startEmailJob,
  recordResult,
  completeJob,
  getJob,
  __resetJobsForTesting,
} from '../services/emailJobTracker';

beforeEach(() => __resetJobsForTesting());

describe('emailJobTracker', () => {
  it('starts a job with running status and zero counters', () => {
    const j = startEmailJob({ kind: 'find', listId: 'L1', userId: 'u1', total: 10 });
    expect(j.status).toBe('running');
    expect(j.processed).toBe(0);
    expect(j.found).toBe(0);
    expect(j.notFound).toBe(0);
    expect(j.errors).toBe(0);
    expect(j.tierBreakdown).toEqual({});
    expect(j.jobId).toMatch(/^find_/);
  });

  it('recordResult updates counters and tier breakdown', () => {
    const j = startEmailJob({ kind: 'find', listId: 'L1', userId: 'u1', total: 5 });
    recordResult(j.jobId, { found: true, tier: 1 });
    recordResult(j.jobId, { found: true, tier: 2 });
    recordResult(j.jobId, { found: true, tier: 2 });
    recordResult(j.jobId, { found: false });
    recordResult(j.jobId, { found: false, error: true });
    const after = getJob(j.jobId)!;
    expect(after.processed).toBe(5);
    expect(after.found).toBe(3);
    expect(after.notFound).toBe(1);
    expect(after.errors).toBe(1);
    expect(after.tierBreakdown).toEqual({ tier1: 1, tier2: 2 });
  });

  it('completeJob flips status and stamps completedAt', () => {
    const j = startEmailJob({ kind: 'validate', listId: 'L1', userId: 'u1', total: 1 });
    completeJob(j.jobId);
    const after = getJob(j.jobId)!;
    expect(after.status).toBe('completed');
    expect(after.completedAt).toBeDefined();
  });

  it('completeJob with errorMessage produces error status', () => {
    const j = startEmailJob({ kind: 'lookup', listId: 'L1', userId: 'u1', total: 1 });
    completeJob(j.jobId, 'rate limit hit');
    const after = getJob(j.jobId)!;
    expect(after.status).toBe('error');
    expect(after.errorMessage).toBe('rate limit hit');
  });

  it('returns null for unknown jobId', () => {
    expect(getJob('does-not-exist')).toBeNull();
  });

  it('recordResult on unknown jobId is a silent no-op', () => {
    expect(() => recordResult('nope', { found: true })).not.toThrow();
  });
});
