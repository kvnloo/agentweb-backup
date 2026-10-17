import { isSuspectedMachineEngagement } from '../machineEngagement';

describe('isSuspectedMachineEngagement (ENG-2524)', () => {
  it('flags a 0.8s click', () => {
    expect(isSuspectedMachineEngagement('email.clicked', 800)).toBe(true);
  });

  it('flags a sub-2s open', () => {
    expect(isSuspectedMachineEngagement('email.opened', 1_500)).toBe(true);
  });

  it('does not flag an 18.7s click', () => {
    expect(isSuspectedMachineEngagement('email.clicked', 18_700)).toBe(false);
  });

  it('never flags a reply exit, however fast', () => {
    expect(isSuspectedMachineEngagement('email.received', 100)).toBe(false);
  });

  it('does not flag when the gap is unknown or negative', () => {
    expect(isSuspectedMachineEngagement('email.clicked', null)).toBe(false);
    expect(isSuspectedMachineEngagement('email.clicked', -500)).toBe(false);
  });
});
