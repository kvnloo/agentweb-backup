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

  // ENG-2662: "Harsha Daily X Post (Autonomous)" called twitter_outreach, then never
  // called post_on_connected_account across all 3 presses. The alert must say the
  // model withheld the named publish tool, not just that a budget ran out.
  it('names the withheld publish tool and that the model held it, not a budget bug', () => {
    const reasons = describeScheduledRunFailureReasons({
      ...base,
      publishHeldForApproval: true,
      functionCallMisses: ['post_on_connected_account'],
      attempts: 3,
    });
    const joined = reasons.join('|');
    expect(joined).toMatch(/publish press budget exhausted with the publish tool uncalled/);
    expect(joined).toMatch(/post_on_connected_account/);
    expect(joined).toMatch(/withheld/);
    expect(joined).toMatch(/after 3 attempt/);
  });

  it('adds no generic reason when misses already explain the failure', () => {
    expect(describeScheduledRunFailureReasons({ ...base, functionCallMisses: ['google_ads_manage'] })).toEqual([]);
  });
});
