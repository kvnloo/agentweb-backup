/**
 * ENG-2400 — modify_work_plan non-schema handler failure + work-plan
 * preservation invariant.
 *
 * Failure class reproduced: a modify that leaves a gap in stepCount numbering
 * (e.g. removeStepCounts:[2] on a 3-step plan without renumbering step 3)
 * reached chatbotDb.updateSessionWorkPlan, whose assertSequentialStepCounts
 * threw (before any write); the handler then returned the opaque "Failed to modify work plan".
 * The handler also mutated the steps array of the session object it had read
 * (shallow `{ ...session.workPlan }` copy), so a failed modify was not
 * side-effect free for the caller's in-memory plan.
 *
 * Invariants:
 *  - on any failure the store is not written and the read plan is unchanged;
 *  - a partial modify never drops steps or fields it did not name;
 *  - the gap failure returns an actionable message naming the bad numbering.
 */
jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
  },
}));

import { chatbotDb } from '../services/chatbotService';
import { modifyWorkPlan } from '../emma/impl/workPlans';
import { assertSequentialStepCounts } from '../services/workPlanSteps';

const getChatSession = chatbotDb.getChatSession as jest.Mock;
const updateSessionWorkPlan = chatbotDb.updateSessionWorkPlan as jest.Mock;
const callLLM = jest.fn(async () => ({ content: 'NO' })) as any;

function storedPlan() {
  return {
    title: 'Plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    steps: [
      { stepCount: 1, title: 'One', description: 'd1', status: 'completed', notes: 'n1' },
      { stepCount: 2, title: 'Two', description: 'd2', status: 'pending', userInstructions: 'u2' },
      { stepCount: 3, title: 'Three', description: 'd3', status: 'pending', skillIds: ['s3'] },
    ],
  };
}

function session(plan = storedPlan()) {
  return { sessionId: 's1', userId: 'u1', messages: [], calledFunctions: {}, workPlan: plan };
}

describe('modifyWorkPlan preservation (ENG-2400)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('a non-sequential result fails with an actionable message, without writing or mutating the read plan', async () => {
    const s = session();
    const snapshot = JSON.parse(JSON.stringify(s.workPlan));
    getChatSession.mockResolvedValue(s);
    // Real store behaviour: validate before any write.
    updateSessionWorkPlan.mockImplementation(async (_id: string, plan: any) => {
      assertSequentialStepCounts(plan.steps);
      return {};
    });

    const result = await modifyWorkPlan([], [2], 's1', undefined, false, callLLM);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/sequential/i);
    expect(result.message).toMatch(/renumber/);
    expect(s.workPlan).toEqual(snapshot);
  });

  it('a store write failure leaves the read plan unchanged', async () => {
    const s = session();
    const snapshot = JSON.parse(JSON.stringify(s.workPlan));
    getChatSession.mockResolvedValue(s);
    updateSessionWorkPlan.mockRejectedValue(new Error('ConditionalCheckFailed'));

    const result = await modifyWorkPlan(
      [{ stepCount: 2, title: 'Two edited' }, { stepCount: 4, title: 'Four' }],
      [],
      's1',
      undefined,
      false,
      callLLM,
    );

    expect(result.success).toBe(false);
    expect(s.workPlan).toEqual(snapshot);
  });

  it('a partial modify keeps unnamed steps and unnamed fields of the named step', async () => {
    getChatSession.mockResolvedValue(session());
    updateSessionWorkPlan.mockResolvedValue({});

    const result = await modifyWorkPlan([{ stepCount: 2, title: 'Two edited' }], [], 's1', undefined, false, callLLM);

    expect(result.success).toBe(true);
    const written = updateSessionWorkPlan.mock.calls[0][1];
    expect(written.steps).toHaveLength(3);
    expect(written.steps[0]).toMatchObject({ stepCount: 1, title: 'One', description: 'd1', status: 'completed', notes: 'n1' });
    expect(written.steps[1]).toMatchObject({ stepCount: 2, title: 'Two edited', description: 'd2', userInstructions: 'u2', status: 'pending' });
    expect(written.steps[2]).toMatchObject({ stepCount: 3, title: 'Three', description: 'd3', skillIds: ['s3'] });
    expect(written.title).toBe('Plan');
    expect(written.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
