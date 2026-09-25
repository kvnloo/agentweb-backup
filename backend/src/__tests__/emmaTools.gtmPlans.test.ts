/**
 * ENG-2103 F2 — proves emma/tools.ts's GTM plan tool execute() bodies call
 * emma/impl/gtmPlans.ts directly (not agentModeService.<method>) and forward
 * the result unchanged. Same pattern as emmaTools.books.test.ts.
 */

jest.mock('../emma/impl/gtmPlans', () => ({
  listGTMPlans: jest.fn(),
  readGTMPlan: jest.fn(),
  createGTMPlan: jest.fn(),
  updateGTMPlan: jest.fn(),
  addGTMPhase: jest.fn(),
  addGTMWorkItems: jest.fn(),
  updateGTMWorkItem: jest.fn(),
  updateGTMPhase: jest.fn(),
  deleteGTMItems: jest.fn(),
  getGTMCommonItems: jest.fn(),
  addGTMCommonItems: jest.fn(),
  sendGTMStatusReport: jest.fn(),
}));

// agentModeService.<gtmMethod> must NOT be called by these tools anymore —
// mock the whole module so a regression (a call site accidentally left pointed
// at the class) would throw instead of silently succeeding against the real
// service.
jest.mock('../services/agentModeService', () => ({
  agentModeService: new Proxy(
    {},
    {
      get(_target, prop) {
        return () => {
          throw new Error(`agentModeService.${String(prop)} should not be called by the GTM plans tool cluster after ENG-2103 F2`);
        };
      },
    }
  ),
}));

import { emmaToolRegistry } from '../emma/registry';
import * as gtmPlansImpl from '../emma/impl/gtmPlans';
import '../emma/tools';

const mockGtm = gtmPlansImpl as jest.Mocked<typeof gtmPlansImpl>;

describe('GTM plans tool cluster delegates to emma/impl/gtmPlans.ts (ENG-2103 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('list_gtm_plans forwards userId and returns the result unchanged', async () => {
    const expected = { success: true, plans: [], totalPlans: 0 };
    mockGtm.listGTMPlans.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('list_gtm_plans')!;
    const result = await tool.execute({}, { userId: 'u1' });

    expect(mockGtm.listGTMPlans).toHaveBeenCalledWith('u1');
    expect(result).toBe(expected);
  });

  it('read_gtm_plan forwards args and returns the result unchanged', async () => {
    const expected = { success: true, exists: true, plan: {} };
    mockGtm.readGTMPlan.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('read_gtm_plan')!;
    const result = await tool.execute({ plan_id: 'p1' }, { userId: 'u1' });

    expect(mockGtm.readGTMPlan).toHaveBeenCalledWith('p1', 'u1');
    expect(result).toBe(expected);
  });

  it('create_gtm_plan defaults description/phases and forwards session context', async () => {
    const expected = { success: true, plan: { planId: 'p1' } };
    mockGtm.createGTMPlan.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('create_gtm_plan')!;
    const result = await tool.execute({ title: 'Launch' }, { userId: 'u1', sessionId: 's1' });

    expect(mockGtm.createGTMPlan).toHaveBeenCalledWith('Launch', '', undefined, [], 'u1', 's1');
    expect(result).toBe(expected);
  });

  it('update_gtm_plan maps due_date to dueDate and forwards args', async () => {
    const expected = { success: true, plan: {} };
    mockGtm.updateGTMPlan.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('update_gtm_plan')!;
    const result = await tool.execute({ plan_id: 'p1', title: 'New', due_date: '2026-01-01' }, { userId: 'u1' });

    expect(mockGtm.updateGTMPlan).toHaveBeenCalledWith('p1', {
      title: 'New', description: undefined, dri: undefined, dueDate: '2026-01-01',
    }, 'u1');
    expect(result).toBe(expected);
  });

  it('add_gtm_phase maps work_items/due_date and forwards args', async () => {
    const expected = { success: true, phaseId: 'ph1' };
    mockGtm.addGTMPhase.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('add_gtm_phase')!;
    const result = await tool.execute({ plan_id: 'p1', title: 'Phase 1', work_items: [{ title: 'Item' }] }, { userId: 'u1' });

    expect(mockGtm.addGTMPhase).toHaveBeenCalledWith('p1', {
      title: 'Phase 1', description: undefined, dri: undefined, dueDate: undefined, workItems: [{ title: 'Item' }],
    }, 'u1');
    expect(result).toBe(expected);
  });

  it('add_gtm_work_items forwards args and returns the result unchanged', async () => {
    const expected = { success: true, addedItems: [] };
    mockGtm.addGTMWorkItems.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('add_gtm_work_items')!;
    const result = await tool.execute({ plan_id: 'p1', phase_id: 'ph1', work_items: [{ title: 'x' }] }, { userId: 'u1' });

    expect(mockGtm.addGTMWorkItems).toHaveBeenCalledWith('p1', 'ph1', [{ title: 'x' }], 'u1');
    expect(result).toBe(expected);
  });

  it('update_gtm_work_item maps both updates and notifications objects', async () => {
    const expected = { success: true, plan: {} };
    mockGtm.updateGTMWorkItem.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('update_gtm_work_item')!;
    const result = await tool.execute({
      plan_id: 'p1', phase_id: 'ph1', work_item_id: 'wi1',
      status: 'completed', notify_user: true, notification_message: 'done',
    }, { userId: 'u1' });

    expect(mockGtm.updateGTMWorkItem).toHaveBeenCalledWith('p1', 'ph1', 'wi1', {
      status: 'completed', notes: undefined, dri: undefined, title: undefined, description: undefined, dueDate: undefined,
    }, {
      notifyUser: true, notifyItemPoc: undefined, notifyPhasePoc: undefined, notifyPlanPoc: undefined, message: 'done',
    }, 'u1');
    expect(result).toBe(expected);
  });

  it('update_gtm_phase forwards args and returns the result unchanged', async () => {
    const expected = { success: true, plan: {} };
    mockGtm.updateGTMPhase.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('update_gtm_phase')!;
    const result = await tool.execute({ plan_id: 'p1', phase_id: 'ph1', title: 'New Phase' }, { userId: 'u1' });

    expect(mockGtm.updateGTMPhase).toHaveBeenCalledWith('p1', 'ph1', {
      title: 'New Phase', description: undefined, dri: undefined, dueDate: undefined,
    }, 'u1');
    expect(result).toBe(expected);
  });

  it('delete_gtm_items forwards args and returns the result unchanged', async () => {
    const expected = { success: true };
    mockGtm.deleteGTMItems.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('delete_gtm_items')!;
    const result = await tool.execute({ plan_id: 'p1', phase_id: 'ph1' }, { userId: 'u1' });

    expect(mockGtm.deleteGTMItems).toHaveBeenCalledWith('p1', 'ph1', undefined, 'u1');
    expect(result).toBe(expected);
  });

  it('get_gtm_common_items takes no args and returns the result unchanged', async () => {
    const expected = { success: true, categories: [] };
    mockGtm.getGTMCommonItems.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('get_gtm_common_items')!;
    const result = await tool.execute({}, { userId: 'u1' });

    expect(mockGtm.getGTMCommonItems).toHaveBeenCalledWith();
    expect(result).toBe(expected);
  });

  it('add_gtm_common_items forwards args and returns the result unchanged', async () => {
    const expected = { success: true, plan: {} };
    mockGtm.addGTMCommonItems.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('add_gtm_common_items')!;
    const result = await tool.execute({ plan_id: 'p1', items: [{ title: 'x' }], target_phase_id: 'ph1' }, { userId: 'u1' });

    expect(mockGtm.addGTMCommonItems).toHaveBeenCalledWith('p1', [{ title: 'x' }], 'ph1', undefined, 'u1');
    expect(result).toBe(expected);
  });

  it('send_gtm_status_report maps the notifications object and forwards args', async () => {
    const expected = { success: true };
    mockGtm.sendGTMStatusReport.mockResolvedValue(expected);

    const tool = emmaToolRegistry.getTool('send_gtm_status_report')!;
    const result = await tool.execute({ plan_id: 'p1', notify_plan_poc: true }, { userId: 'u1' });

    expect(mockGtm.sendGTMStatusReport).toHaveBeenCalledWith('p1', undefined, {
      notifyUser: undefined, notifyPlanPoc: true, notifyPhasePoc: undefined, notifyPhasePocs: undefined, message: undefined,
    }, 'u1');
    expect(result).toBe(expected);
  });
});
