// ENG-1880 Piece 3: the private, autonomous "Meta_Ads_Perf_Report" variant. Its step
// content is adapted from a proven internal validation plan — these tests pin the
// contract (visibility/access shape, the exact function calls each step requires, the
// title-based idempotency this script relies on since createWorkPlan mints a fresh
// planId every call) so a future edit can't silently make this reachable by customers
// or drop a step's required tool call.

jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    getAllWorkPlans: jest.fn(),
    createWorkPlan: jest.fn(),
  },
}));

import { workPlanService } from '../services/workPlanService';
import {
  AUTONOMOUS_REPORT_WORKPLAN_TITLE,
  AUTONOMOUS_REPORT_WORKPLAN_STEPS,
  buildAutonomousReportWorkPlan,
} from '../scripts/seed-eng1880-autonomous-report-workplan';

describe('work plan shape', () => {
  const plan = buildAutonomousReportWorkPlan();

  it('is private and hidden from agent mode — Phase A, not yet customer-reachable', () => {
    expect(plan.visibility).toBe('private');
    expect(plan.showInAgentMode).toBe(false);
    expect(plan.isBuiltIn).toBe(false);
  });

  // Round-2 review finding: every other visibility:'private' plan pairs it with a real
  // ownerId (userWorkPlanRoutes.ts's create route always sets both together). Without
  // one, orgShareService.canEditItem's ownership check is unconditionally false for
  // every caller, permanently blocking the plan from the standard user-facing edit route.
  it('has a real ownerId — required for the plan to ever be editable via the standard route', () => {
    expect(plan.ownerId).toBeTruthy();
    expect(typeof plan.ownerId).toBe('string');
  });

  it('accepts an explicit ownerId override instead of always using the default', () => {
    const overridden = buildAutonomousReportWorkPlan('some-other-admin-user-id');
    expect(overridden.ownerId).toBe('some-other-admin-user-id');
  });

  it('has exactly 3 steps with no structural inputRequest, matching the proven validation-plan shape', () => {
    expect(plan.steps).toHaveLength(3);
    plan.steps.forEach((step) => {
      expect((step as any).inputRequest).toBeUndefined();
    });
  });

  it('each step declares the exact required function calls the design specifies', () => {
    expect(plan.steps[0].requiredFunctionCalls).toEqual(['list_meta_ads_campaigns', 'get_meta_ads_metrics']);
    expect(plan.steps[1].requiredFunctionCalls).toEqual([
      'list_html_templates', 'perform_data_analysis', 'monitor_lead_volume',
    ]);
    expect(plan.steps[2].requiredFunctionCalls).toEqual(['create_html_from_template']);
  });

  it('step 2 tells the model to reuse step 1\'s existing CSV links, not construct new ones', () => {
    // The validation plan's own step 2 wording left this ambiguous, and both prior
    // live runs silently self-healed into the freeform create_html_file fallback
    // instead of using the template because of exactly this ambiguity.
    const step2 = AUTONOMOUS_REPORT_WORKPLAN_STEPS[1].description;
    expect(step2).toContain('already included in step 1');
    expect(step2).toContain('do not construct new CSVs via save_file');
  });

  it('step 2 tells the model to skip a missing breakdown rather than invent data for it', () => {
    const step2 = AUTONOMOUS_REPORT_WORKPLAN_STEPS[1].description;
    expect(step2).toContain('skip any breakdown whose CSV was not produced');
  });

  it('step 3 tells the model to omit a missing analysis section rather than fabricate or placeholder it', () => {
    const step3 = AUTONOMOUS_REPORT_WORKPLAN_STEPS[2].description as string;
    expect(step3).toContain('omit that section');
    expect(step3).toContain('rather than leaving a placeholder or fabricating figures');
  });

  it('step 3 carries no "INTERNAL VALIDATION" framing — this is the real customer-facing variant', () => {
    AUTONOMOUS_REPORT_WORKPLAN_STEPS.forEach((step) => {
      expect((step.description as string).toUpperCase()).not.toContain('INTERNAL VALIDATION');
    });
    expect(buildAutonomousReportWorkPlan().description.toUpperCase()).not.toContain('INTERNAL VALIDATION');
  });

  it('finds the template by the exact literal name list_html_templates would return', () => {
    expect(AUTONOMOUS_REPORT_WORKPLAN_STEPS[1].description).toContain('multi_campaign_performance_report');
  });

  it('preserves the proven autonomous-selection and false-positive-exclusion logic from the validation plan verbatim', () => {
    const step1 = AUTONOMOUS_REPORT_WORKPLAN_STEPS[0].description;
    expect(step1).toContain('EVERY campaign that has nonzero spend');
    expect(step1).toContain('OUTCOME_ENGAGEMENT or LINK_CLICKS');
    expect(step1).toContain('do not ask the user to pick one');
  });

  it('preserves the proven lead-count-from-CRM logic, never asking the user', () => {
    const step2 = AUTONOMOUS_REPORT_WORKPLAN_STEPS[1].description;
    expect(step2).toContain('do NOT ask the user how many leads converted');
  });
});

describe('seed idempotency', () => {
  const mockService = workPlanService as jest.Mocked<typeof workPlanService>;
  const runSeed = async () => {
    const mod = await import('../scripts/seed-eng1880-autonomous-report-workplan');
    return (mod as any).main();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('creates exactly one plan on a clean table', async () => {
    mockService.getAllWorkPlans.mockResolvedValue([]);
    mockService.createWorkPlan.mockResolvedValue({
      ...buildAutonomousReportWorkPlan(),
      planId: 'new-plan-id',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    } as any);

    await runSeed();

    expect(mockService.createWorkPlan).toHaveBeenCalledTimes(1);
    expect(mockService.createWorkPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        title: AUTONOMOUS_REPORT_WORKPLAN_TITLE,
        visibility: 'private',
        showInAgentMode: false,
      })
    );
  });

  it('a plan with the same title already existing skips creation and returns it, not a duplicate', async () => {
    const existing = {
      ...buildAutonomousReportWorkPlan(),
      planId: 'existing-plan-id',
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z',
    } as any;
    mockService.getAllWorkPlans.mockResolvedValue([existing]);

    const result = await runSeed();

    expect(mockService.createWorkPlan).not.toHaveBeenCalled();
    expect(result.planId).toBe('existing-plan-id');
  });

  it('a plan with a DIFFERENT title present does not block creation of this one', async () => {
    mockService.getAllWorkPlans.mockResolvedValue([
      { ...buildAutonomousReportWorkPlan(), title: 'Some Other Plan', planId: 'other-id' } as any,
    ]);
    mockService.createWorkPlan.mockResolvedValue({
      ...buildAutonomousReportWorkPlan(),
      planId: 'new-plan-id',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    } as any);

    await runSeed();

    expect(mockService.createWorkPlan).toHaveBeenCalledTimes(1);
  });

  it('running it twice leaves exactly one plan (second call finds the first and skips)', async () => {
    const created = {
      ...buildAutonomousReportWorkPlan(),
      planId: 'new-plan-id',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    } as any;
    mockService.getAllWorkPlans
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([created]);
    mockService.createWorkPlan.mockResolvedValue(created);

    await runSeed();
    await runSeed();

    expect(mockService.createWorkPlan).toHaveBeenCalledTimes(1);
  });

  it('a real database error is not swallowed', async () => {
    mockService.getAllWorkPlans.mockResolvedValue([]);
    mockService.createWorkPlan.mockRejectedValue(new Error('dynamo down'));
    await expect(runSeed()).rejects.toThrow('dynamo down');
  });
});
