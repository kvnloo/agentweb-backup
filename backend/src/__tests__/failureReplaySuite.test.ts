import {
  evaluateReplayCase,
  runFailureReplaySuite,
  type FailureReplayCase,
} from '../loops/eval/failureReplaySuite';

const eng286Case: FailureReplayCase<{ ceiling?: number }, { targetSpend: { cpcBidCeilingMicros?: string }; updateMask: string[] }> = {
  id: 'eng-286-target-spend-parent-mask',
  incident: 'ENG-286',
  input: {},
  assert: (output) =>
    output.targetSpend.cpcBidCeilingMicros === '0' &&
    output.updateMask.includes('target_spend.cpc_bid_ceiling_micros') &&
    !output.updateMask.includes('target_spend'),
  failure: 'TARGET_SPEND without a ceiling must use the uncapped leaf field mask',
};

const preFixContract = () => ({ targetSpend: {}, updateMask: ['target_spend'] });
const currentContract = ({ ceiling }: { ceiling?: number }) => ({
  targetSpend: { cpcBidCeilingMicros: String(ceiling ?? 0) },
  updateMask: ['target_spend.cpc_bid_ceiling_micros'],
});

describe('failure replay suite', () => {
  it('reproduces the historical ENG-286 failure against the pre-fix contract', async () => {
    await expect(evaluateReplayCase(eng286Case, preFixContract)).resolves.toMatchObject({
      passed: false,
      caseId: eng286Case.id,
      incident: 'ENG-286',
    });
  });

  it('passes the historical replay against the current contract', async () => {
    await expect(evaluateReplayCase(eng286Case, currentContract)).resolves.toMatchObject({
      passed: true,
      caseId: eng286Case.id,
    });
  });

  it('files one deduped finding for a broken contract through the intake seam', async () => {
    const fileIssue = jest.fn().mockResolvedValue({
      pageId: 'ENG-240',
      url: 'https://linear/ENG-240',
      deduped: true,
      tracker: 'Linear',
    });

    const result = await runFailureReplaySuite({
      cases: [eng286Case, eng286Case],
      contract: preFixContract,
      fileIssue,
      now: () => new Date('2026-09-17T12:00:00.000Z'),
    });

    expect(fileIssue).toHaveBeenCalledTimes(1);
    expect(fileIssue).toHaveBeenCalledWith(expect.objectContaining({
      source: 'failure-replay-suite scheduled runner',
      notionContext: expect.objectContaining({
        'Alert Class': 'failure-replay:eng-286-target-spend-parent-mask',
        'Replay Case ID': 'eng-286-target-spend-parent-mask',
      }),
    }));
    expect(result).toMatchObject({ checked: 1, failed: 1, filed: 1, deduped: 1 });
  });

  it('makes no intake call when every replay passes', async () => {
    const fileIssue = jest.fn();
    const result = await runFailureReplaySuite({
      cases: [eng286Case],
      contract: currentContract,
      fileIssue,
    });

    expect(fileIssue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, failed: 0, filed: 0, deduped: 0 });
  });
});
