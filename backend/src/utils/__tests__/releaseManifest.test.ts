import { buildReleaseManifest, extractIssueIds } from '../releaseManifest';

const pr = (number: number, title: string, mergeCommitSha: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  mergeCommitSha,
  url: `https://github.com/AgentWebPro/agentweb/pull/${number}`,
  ...extra,
});

describe('extractIssueIds (ENG-131)', () => {
  it('finds ENG ids in title then body, upper-cased and de-duplicated in order', () => {
    expect(extractIssueIds('feat: x (eng-15)', 'Closes ENG-15 and relates to ENG-7')).toEqual(['ENG-15', 'ENG-7']);
  });

  it('ignores lookalikes that are part of a larger token', () => {
    expect(extractIssueIds('bump XENG-12, ENG-12a and chore_ENG-13_fix', 'branch swarm/eng-40-x')).toEqual(['ENG-40']);
  });
});

describe('buildReleaseManifest (ENG-131)', () => {
  const base = { deployRunId: 'run-1', fromSha: 'aaa', toSha: 'bbb' };

  it('maps each merged PR in the deploy range to its ENG issue with a stable idempotency key', () => {
    const m = buildReleaseManifest({ ...base, mergedPrs: [pr(1, 'feat: docs (ENG-15)', 's1'), pr(2, 'fix: y (ENG-20)', 's2')] });
    expect(m.deployRunId).toBe('run-1');
    expect(m.entries).toEqual([
      { issueId: 'ENG-15', prNumbers: [1], mergeCommitShas: ['s1'], prUrls: [pr(1, '', '').url], idempotencyKey: 'run-1:ENG-15' },
      { issueId: 'ENG-20', prNumbers: [2], mergeCommitShas: ['s2'], prUrls: [pr(2, '', '').url], idempotencyKey: 'run-1:ENG-20' },
    ]);
    expect(m.unlinkedPrs).toEqual([]);
  });

  it('collapses several PRs for one issue into a single entry (one doc per feature per deploy)', () => {
    const m = buildReleaseManifest({ ...base, mergedPrs: [pr(3, 'slice 1 (ENG-15)', 's3'), pr(4, 'slice 2 (ENG-15)', 's4')] });
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]).toMatchObject({ issueId: 'ENG-15', prNumbers: [3, 4], mergeCommitShas: ['s3', 's4'] });
  });

  it('reports PRs with no ENG reference instead of dropping them silently', () => {
    const m = buildReleaseManifest({ ...base, mergedPrs: [pr(5, 'ci: bump actions', 's5')] });
    expect(m.entries).toEqual([]);
    expect(m.unlinkedPrs).toEqual([5]);
  });

  it('ignores PRs whose merge commit is outside the deployed range', () => {
    const m = buildReleaseManifest({ ...base, rangeShas: ['s6'], mergedPrs: [pr(6, 'a (ENG-1)', 's6'), pr(7, 'b (ENG-2)', 'zzz')] });
    expect(m.entries.map((e) => e.issueId)).toEqual(['ENG-1']);
  });

  it('is deterministic regardless of input PR order', () => {
    const prs = [pr(9, 'b (ENG-9)', 's9'), pr(8, 'a (ENG-8)', 's8'), pr(10, 'c (ENG-8)', 's10')];
    expect(buildReleaseManifest({ ...base, mergedPrs: prs })).toEqual(buildReleaseManifest({ ...base, mergedPrs: [...prs].reverse() }));
  });

  it('requires a deploy run id, since that is the idempotency anchor', () => {
    expect(() => buildReleaseManifest({ ...base, deployRunId: '', mergedPrs: [] })).toThrow(/deployRunId/);
  });
});
