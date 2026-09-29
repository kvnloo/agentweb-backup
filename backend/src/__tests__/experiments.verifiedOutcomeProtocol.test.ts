import { advanceOutcome, canClaimSuccess } from '../experiments/verifiedOutcomeProtocol';

describe('A9 verified outcome protocol', () => {
  it('does not call a committed action successful before verification', () => {
    const committed = advanceOutcome({ operationId: '1', state: 'prepared' }, 'committed');
    expect(canClaimSuccess(committed)).toBe(false);
  });

  it('requires verification evidence', () => {
    const committed = { operationId: '1', state: 'committed' } as const;
    expect(canClaimSuccess(advanceOutcome(committed, 'verified'))).toBe(false);
    expect(canClaimSuccess(advanceOutcome(committed, 'verified', 'readback:123'))).toBe(true);
  });

  it('rejects impossible backwards transitions', () => {
    expect(() => advanceOutcome({ operationId: '1', state: 'verified', evidence: 'x' }, 'committed'))
      .toThrow(/invalid outcome transition/);
  });
});
