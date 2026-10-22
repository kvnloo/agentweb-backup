import {
  decideSequenceHealth,
  DEFAULT_SEQUENCE_HEALTH_THRESHOLDS,
} from '../dripSequenceHealth';

describe('decideSequenceHealth (ENG-2542)', () => {
  it('uses 5% bounce / 0.3% complaint / 50 sample defaults', () => {
    expect(DEFAULT_SEQUENCE_HEALTH_THRESHOLDS).toEqual({
      maxBounceRate: 0.05,
      maxComplaintRate: 0.003,
      minSample: 50,
    });
  });

  it('continues with null rates when nothing has been sent', () => {
    expect(decideSequenceHealth({ sent: 0, bounced: 0, complained: 0 })).toEqual({
      action: 'continue',
      bounceRate: null,
      complaintRate: null,
    });
  });

  it('does not pause below the minimum sample even at high rates', () => {
    const d = decideSequenceHealth({ sent: 3, bounced: 1, complained: 1 });
    expect(d.action).toBe('continue');
    expect(d.bounceRate).toBeCloseTo(1 / 3);
  });

  it('continues when rates are at (not above) thresholds', () => {
    const d = decideSequenceHealth({ sent: 1000, bounced: 50, complained: 3 });
    expect(d).toEqual({ action: 'continue', bounceRate: 0.05, complaintRate: 0.003 });
  });

  it('pauses on bounce rate alone', () => {
    expect(decideSequenceHealth({ sent: 100, bounced: 6, complained: 0 })).toEqual({
      action: 'pause',
      reasons: ['bounce_rate'],
      bounceRate: 0.06,
      complaintRate: 0,
    });
  });

  it('pauses on complaint rate alone', () => {
    const d = decideSequenceHealth({ sent: 1000, bounced: 0, complained: 4 });
    expect(d).toEqual({ action: 'pause', reasons: ['complaint_rate'], bounceRate: 0, complaintRate: 0.004 });
  });

  it('reports both reasons when both breach', () => {
    const d = decideSequenceHealth({ sent: 100, bounced: 10, complained: 1 });
    expect(d.action).toBe('pause');
    if (d.action === 'pause') expect(d.reasons).toEqual(['bounce_rate', 'complaint_rate']);
  });

  it('honours threshold overrides', () => {
    expect(
      decideSequenceHealth({ sent: 10, bounced: 1, complained: 0 }, { minSample: 10, maxBounceRate: 0.05 }).action,
    ).toBe('pause');
    expect(
      decideSequenceHealth({ sent: 100, bounced: 6, complained: 0 }, { maxBounceRate: 0.1 }).action,
    ).toBe('continue');
  });

  it.each([
    [{ sent: -1, bounced: 0, complained: 0 }],
    [{ sent: NaN, bounced: 0, complained: 0 }],
    [{ sent: Infinity, bounced: 0, complained: 0 }],
    [{ sent: 1.5, bounced: 0, complained: 0 }],
    [{ sent: 10, bounced: 11, complained: 0 }],
    [{ sent: 10, bounced: 0, complained: 11 }],
    [{ sent: 10, bounced: -1, complained: 0 }],
  ])('throws on invalid counts %j', (counts) => {
    expect(() => decideSequenceHealth(counts)).toThrow(RangeError);
  });

  it('throws on invalid thresholds', () => {
    const c = { sent: 100, bounced: 0, complained: 0 };
    expect(() => decideSequenceHealth(c, { maxBounceRate: 2 })).toThrow(RangeError);
    expect(() => decideSequenceHealth(c, { maxComplaintRate: -0.1 })).toThrow(RangeError);
    expect(() => decideSequenceHealth(c, { minSample: -5 })).toThrow(RangeError);
  });
});
