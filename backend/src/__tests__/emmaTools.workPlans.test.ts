/**
 * ENG-2103 F2 — proves emma/tools.ts's work-plan tool execute() bodies call
 * emma/impl/workPlans.ts directly (not agentModeService.<method>) and forward
 * the result unchanged. Same pattern as emmaTools.blog.test.ts/
 * emmaTools.knowledgeBase.test.ts/emmaTools.leads.test.ts.
 *
 * `launch_predefined_work_plan` is the one exception in this cluster: it
 * still passes the agentModeService singleton through as
 * applyPredefinedWorkPlan's 5th argument (the WorkPlanModelRegistry used to
 * validate a template's defaultModel — a real cross-dependency on class
 * instance state, not something this extraction could remove). The mocked
 * agentModeService below is a throwing Proxy specifically so that if any
 * OTHER method on it were ever called by this cluster's tools, the test
 * would fail loudly instead of silently succeeding against the real service
 * — merely being PASSED as a value (never invoked, since
 * workPlansImpl.applyPredefinedWorkPlan is itself mocked below) is fine.
 *
 * `modify_work_plan` (ENG-2103 F2 design-decision-list follow-up, Pattern A)
 * was added to this cluster in a later round than the other 5 — it forwards
 * `agentModeService.callLLM.bind(agentModeService)` as modifyWorkPlan's 6th
 * argument, the same "pass the real singleton's bound method, verify by
 * invoking the mocked/throwing reference" shape `launch_predefined_work_plan`
 * already established for its own 5th argument.
 */

jest.mock('../emma/impl/workPlans', () => ({
  createWorkPlan: jest.fn(),
  applyPredefinedWorkPlan: jest.fn(),
  recommendPredefinedWorkPlan: jest.fn(),
  setWorkPlanStatus: jest.fn(),
  sendForReview: jest.fn(),
  modifyWorkPlan: jest.fn(),
}));

// agentModeService.<workPlanMethod> must NOT be called by these tools anymore
// — mock the whole module so a regression (a call site accidentally left
// pointed at the class) would throw instead of silently succeeding against
// the real service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the work-plans tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as workPlansImpl from '../emma/impl/workPlans';
import '../emma/tools';

const mockWorkPlans = workPlansImpl as jest.Mocked<typeof workPlansImpl>;

describe('Work plans tool cluster delegates to emma/impl/workPlans.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('create_work_plan forwards title/steps/session/autocomplete/isUnattendedRun and returns the result unchanged', async () => {
    const expected = { success: true, workPlan: { title: 'T' } };
    mockWorkPlans.createWorkPlan.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_work_plan')!;
    const steps = [{ stepCount: 1, title: 'Step 1' }];
    const result = await tool.execute(
      { title: 'T', steps, autocomplete: true },
      { sessionId: 's1', isUnattendedRun: false }
    );

    expect(mockWorkPlans.createWorkPlan).toHaveBeenCalledWith('T', steps, 's1', true, false);
    expect(result).toBe(expected);
  });

  it('launch_predefined_work_plan forwards planTitle/session/user/force/confirmedDeclinedPlan and the model registry, and returns the result unchanged', async () => {
    const expected = { success: true, workPlan: { title: 'Onboarding' } };
    mockWorkPlans.applyPredefinedWorkPlan.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('launch_predefined_work_plan')!;
    const result = await tool.execute(
      { planTitle: 'Client Onboarding', force: true },
      { userId: 'u1', sessionId: 's1', isUnattendedRun: false }
    );

    // The 5th argument (the WorkPlanModelRegistry) is the mocked
    // agentModeService singleton — a throwing Proxy (see the module mock
    // above) whose `get` trap returns a fresh closure per property access.
    // That defeats jest's own equality/asymmetric-matcher machinery when the
    // object itself is nested inside a toHaveBeenCalledWith(...) comparison
    // (even expect.anything() misreports it there), so the first 4 positional
    // args are checked via toHaveBeenCalledWith and the 5th is checked
    // directly, by reference, against the real imported singleton.
    const { agentModeService } = require('../services/agentModeService');
    const callArgs = mockWorkPlans.applyPredefinedWorkPlan.mock.calls[0];
    expect(callArgs.slice(0, 4)).toEqual([
      'Client Onboarding', 's1', 'u1',
      { force: true, confirmedDeclinedPlan: false, isUnattendedRun: false },
    ]);
    expect(callArgs[4]).toBe(agentModeService);
    expect(result).toBe(expected);
  });

  it('recommend_predefined_work_plan forwards planId/reason/session/user and returns the result unchanged', async () => {
    const expected = { success: true, type: 'workplan_recommendation' };
    mockWorkPlans.recommendPredefinedWorkPlan.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('recommend_predefined_work_plan')!;
    const result = await tool.execute(
      { planId: 'plan-onboard', reason: 'because X' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockWorkPlans.recommendPredefinedWorkPlan).toHaveBeenCalledWith('plan-onboard', 'because X', 's1', 'u1');
    expect(result).toBe(expected);
  });

  it('set_work_plan_status forwards updates/session and returns the result unchanged', async () => {
    const expected = { success: true, updatedSteps: [] };
    mockWorkPlans.setWorkPlanStatus.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('set_work_plan_status')!;
    const updates = [{ stepCount: 1, status: 'completed' as const }];
    const result = await tool.execute({ updates }, { sessionId: 's1' });

    expect(mockWorkPlans.setWorkPlanStatus).toHaveBeenCalledWith(updates, 's1');
    expect(result).toBe(expected);
  });

  it('send_for_review forwards subject/session/user/content_url/content_html and returns the result unchanged', async () => {
    const expected = { success: true, message: 'Review email sent to reviewer@example.com', to: 'reviewer@example.com' };
    mockWorkPlans.sendForReview.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('send_for_review')!;
    const result = await tool.execute(
      { subject: 'Your report', content_url: 'https://s3/x.html', content_html: '<p>hi</p>' },
      { userId: 'u1', sessionId: 's1' }
    );

    expect(mockWorkPlans.sendForReview).toHaveBeenCalledWith('Your report', 's1', 'u1', 'https://s3/x.html', '<p>hi</p>');
    expect(result).toBe(expected);
  });

  it('send_for_review throws when userId or sessionId is missing from context', async () => {
    const tool = emmaToolRegistry.getTool('send_for_review')!;
    await expect(tool.execute({ subject: 'X' }, {})).rejects.toThrow('Missing user or session context');
    expect(mockWorkPlans.sendForReview).not.toHaveBeenCalled();
  });

  it('modify_work_plan forwards steps/removeStepCounts/session/autocomplete/isUnattendedRun plus a callLLM bound to the real agentModeService singleton, and returns the result unchanged', async () => {
    const expected = { success: true, workPlan: { title: 'T' } };
    mockWorkPlans.modifyWorkPlan.mockResolvedValue(expected as any);

    const tool = emmaToolRegistry.getTool('modify_work_plan')!;
    const steps = [{ stepCount: 1, title: 'Step 1' }];
    const result = await tool.execute(
      { steps, removeStepCounts: [2], autocomplete: true },
      { sessionId: 's1', isUnattendedRun: false }
    );

    const callArgs = mockWorkPlans.modifyWorkPlan.mock.calls[0];
    expect(callArgs.slice(0, 5)).toEqual([steps, [2], 's1', true, false]);
    // The 6th argument is `agentModeService.callLLM.bind(agentModeService)` —
    // the mocked agentModeService above is a throwing Proxy, so invoking the
    // bound function proves it is really wired to that singleton's callLLM,
    // the same "invoke the mock to prove the wiring" shape
    // launch_predefined_work_plan's toBe(agentModeService) check uses for its
    // own injected 5th argument (a bound function can't be compared by
    // reference the way a plain object can).
    expect(typeof callArgs[5]).toBe('function');
    expect(() => (callArgs[5] as any)()).toThrow('agentModeService.callLLM should not be called by the work-plans tool cluster after ENG-2103 F2');
    expect(result).toBe(expected);
  });

  // ENG-2399 (Opslane run 285 findings 1-2): pin the registered tool entry, not just the validator.
  it('modify_work_plan: a remove-only call reaches the handler and its result is returned', async () => {
    const expected = { success: true, message: 'Work plan modified successfully' };
    mockWorkPlans.modifyWorkPlan.mockReset();
    mockWorkPlans.modifyWorkPlan.mockResolvedValue(expected as any);
    const tool = emmaToolRegistry.getTool('modify_work_plan')!;
    const result = await tool.execute({ removeStepCounts: [3] }, { sessionId: 's1' });
    expect(mockWorkPlans.modifyWorkPlan.mock.calls[0].slice(0, 3)).toEqual([[], [3], 's1']);
    expect(result).toBe(expected);
  });

  it('modify_work_plan: a string stepCount returns structured invalid_args and never reaches the handler', async () => {
    mockWorkPlans.modifyWorkPlan.mockReset();
    const tool = emmaToolRegistry.getTool('modify_work_plan')!;
    const result: any = await tool.execute({ steps: [{ stepCount: '2', title: 'X' }] }, { sessionId: 's1' });
    expect(result).toMatchObject({ success: false, errorClass: 'invalid_args', field: 'steps[0].stepCount', expected: 'integer >= 1' });
    expect(result.message).toMatch(/^Invalid parameters for modify_work_plan/);
    expect(mockWorkPlans.modifyWorkPlan).not.toHaveBeenCalled();
  });
});
