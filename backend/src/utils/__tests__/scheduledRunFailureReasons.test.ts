import { describeScheduledRunFailureReasons } from '../scheduledRunFailureReasons';

describe('describeScheduledRunFailureReasons (ENG-1735)', () => {
  const base = { success: false, content: 'Draft staged.', functionCallMisses: [], keywordMisses: [], workPlanCompleted: true, attempts: 3 };

  it('never returns an empty reason list for a failure with no misses', () => {
    const reasons = describeScheduledRunFailureReasons(base);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/3 attempt\(s\)/);
  });

  it('names deferredUnresolved as the concrete failing check', () => {
    expect(describeScheduledRunFailureReasons({ ...base, success: true, deferredUnresolved: true })).toEqual([
      expect.stringMatching(/deferred to an absent human/),
    ]);
  });

  it('names an incomplete work plan without blaming empty tool-call-only output', () => {
    const reasons = describeScheduledRunFailureReasons({ ...base, content: '  ', workPlanCompleted: false });
    expect(reasons).toEqual([expect.stringMatching(/work plan not completed/)]);
  });

  it('names empty output only when nothing more specific explains the failure', () => {
    expect(describeScheduledRunFailureReasons({ ...base, content: '' })).toEqual([
      expect.stringMatching(/empty final response/),
    ]);
  });

  it('names press-budget and linkedIn markers', () => {
    const reasons = describeScheduledRunFailureReasons(
      { ...base, publishHeldForApproval: true, sendPressExhausted: true },
      { linkedInInviteSendRequirementMissed: true },
    );
    expect(reasons.join('|')).toMatch(/publish press/);
    expect(reasons.join('|')).toMatch(/send press/);
    expect(reasons.join('|')).toMatch(/LinkedIn/);
  });

  it('adds no generic reason when misses already explain the failure', () => {
    expect(describeScheduledRunFailureReasons({ ...base, functionCallMisses: ['google_ads_manage'] })).toEqual([]);
  });
});
