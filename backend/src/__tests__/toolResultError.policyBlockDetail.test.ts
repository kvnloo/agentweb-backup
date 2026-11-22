import { toolResultError, ToolResultPolicyBlockedError } from '../utils/toolResultError';

/**
 * ENG-3148: set_work_plan_status's gates return a generic `message` plus a
 * `formattedContent` naming the missing calls per step. The model-visible error
 * must carry that detail, or the model retries blind until the step budget ends.
 */
describe('toolResultError — policy-block detail (ENG-3148)', () => {
  it('includes formattedContent naming the missing function calls', () => {
    const err = toolResultError({
      success: false,
      blocked: true,
      reason: 'workplan_missing_function_calls',
      message: 'Cannot mark steps as completed. Required function calls have not been made yet.',
      formattedContent:
        '❌ Cannot complete these steps yet:\nStep 2 "Perform data analysis on metrics": missing required function calls: get_ads_thresholds',
    });
    expect(err).toBeInstanceOf(ToolResultPolicyBlockedError);
    expect(err!.message).toContain('Required function calls have not been made yet');
    expect(err!.message).toContain('missing required function calls: get_ads_thresholds');
    expect((err as ToolResultPolicyBlockedError).reason).toBe('workplan_missing_function_calls');
  });

  it('keeps the bare message when no formattedContent is present', () => {
    const err = toolResultError({
      success: false,
      blocked: true,
      reason: 'workplan_out_of_order',
      message: 'Cannot mark steps as completed. Earlier steps in the plan are not done yet.',
    });
    expect(err!.message).toBe('Cannot mark steps as completed. Earlier steps in the plan are not done yet.');
  });

  it('does not touch non-blocked failures', () => {
    const err = toolResultError({ success: false, message: 'boom', formattedContent: 'extra' });
    expect(err).not.toBeInstanceOf(ToolResultPolicyBlockedError);
    expect(err!.message).toBe('boom');
  });
});
