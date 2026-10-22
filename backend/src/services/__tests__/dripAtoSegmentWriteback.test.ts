import { buildAtoSegmentWriteback, DripAtoSegmentConfig } from '../dripAtoSegmentWriteback';

const config: DripAtoSegmentConfig = {
  inSequenceTag: 'cfg-in-seq',
  newsletterTag: 'cfg-newsletter',
  repliedTag: 'cfg-replied',
  bookedTag: 'cfg-booked',
  suppressionTag: 'cfg-suppressed',
};

const run = (outcome: string, currentTags: string[]) =>
  buildAtoSegmentWriteback({ leadId: 'L1', currentTags, outcome, config });

describe('buildAtoSegmentWriteback (ENG-2546)', () => {
  it('no_response adds newsletter and removes in-sequence', () => {
    expect(run('no_response', ['cfg-in-seq', 'other'])).toEqual({
      leadId: 'L1', add: ['cfg-newsletter'], remove: ['cfg-in-seq'],
    });
  });

  it.each([
    ['replied', 'cfg-replied'],
    ['booked', 'cfg-booked'],
  ])('%s adds engaged tag, removes in-sequence, never newsletter', (outcome, tag) => {
    const r = run(outcome, ['cfg-in-seq']);
    expect(r.add).toEqual([tag]);
    expect(r.remove).toEqual(['cfg-in-seq']);
    expect(r.add).not.toContain('cfg-newsletter');
  });

  it.each(['unsubscribed', 'bounced'])(
    '%s removes in-sequence + newsletter and adds suppression',
    (outcome) => {
      const r = run(outcome, ['cfg-in-seq', 'cfg-newsletter']);
      expect(r.add).toEqual(['cfg-suppressed']);
      expect(r.remove.sort()).toEqual(['cfg-in-seq', 'cfg-newsletter']);
      expect(r.add).not.toContain('cfg-newsletter');
    },
  );

  it('returns only real diffs (does not remove absent tags)', () => {
    expect(run('bounced', [])).toEqual({ leadId: 'L1', add: ['cfg-suppressed'], remove: [] });
  });

  it.each(['no_response', 'replied', 'booked', 'unsubscribed', 'bounced'])(
    '%s is idempotent: re-applying yields an empty diff',
    (outcome) => {
      const start = ['cfg-in-seq', 'cfg-newsletter', 'x'];
      const first = run(outcome, start);
      const after = start.filter((t) => !first.remove.includes(t)).concat(first.add);
      expect(run(outcome, after)).toEqual({ leadId: 'L1', add: [], remove: [] });
    },
  );

  it('uses config tag names only', () => {
    const r = buildAtoSegmentWriteback({
      leadId: 'L2',
      currentTags: ['A'],
      outcome: 'no_response',
      config: { ...config, inSequenceTag: 'A', newsletterTag: 'B' },
    });
    expect(r).toEqual({ leadId: 'L2', add: ['B'], remove: ['A'] });
  });

  it('unknown outcome returns empty diff with a reason', () => {
    expect(run('mystery', ['cfg-in-seq'])).toEqual({
      leadId: 'L1', add: [], remove: [], reason: 'unknown_outcome:mystery',
    });
  });
});
