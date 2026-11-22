import { completionRouting } from '../dripSequenceRouting';

const config = { noResponseSegment: 'newsletter-haven' };

describe('completionRouting (ENG-2504)', () => {
  it('AC1: no_response with a delivered step and a configured segment adds to that segment', () => {
    expect(completionRouting('no_response', true, config)).toEqual({
      action: 'add_to_segment',
      segment: 'newsletter-haven',
    });
  });

  it('AC2: nothing delivered never enrolls the lead', () => {
    expect(completionRouting('no_response', false, config)).toEqual({ action: 'none', reason: 'completed_no_sends' });
  });

  it.each(['unsubscribed', 'bounced'] as const)('AC3: compliance stop %s never adds to a segment', (reason) => {
    expect(completionRouting(reason, true, config)).toEqual({ action: 'none', reason });
    expect(completionRouting(reason, false, config)).toEqual({ action: 'none', reason });
  });

  it.each(['replied', 'booked'] as const)('AC3: %s is owned by sales, no segment add', (reason) => {
    expect(completionRouting(reason, true, config)).toEqual({ action: 'none', reason });
  });

  it.each([{}, { noResponseSegment: '' }, { noResponseSegment: '   ' }])(
    'AC4: no configured segment returns no_segment_configured (%p)',
    (cfg) => {
      expect(completionRouting('no_response', true, cfg)).toEqual({ action: 'none', reason: 'no_segment_configured' });
    },
  );

  it('compliance stops win even without a configured segment', () => {
    expect(completionRouting('unsubscribed', true, {})).toEqual({ action: 'none', reason: 'unsubscribed' });
  });

  it('unknown outcome fails closed', () => {
    expect(completionRouting('mystery' as any, true, config)).toEqual({ action: 'none', reason: 'unknown_outcome' });
  });
});
