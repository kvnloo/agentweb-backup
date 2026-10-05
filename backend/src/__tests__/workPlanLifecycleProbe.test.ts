/** ENG-2060 — fail-closed verifier lifecycle probe (MOCKABLE). */
import { runWorkPlanLifecycleProbe, DEFAULT_FIXTURE, ProbeRefusal } from '../verification/workPlanLifecycleProbe';

const wrap = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
const VERIFIER = 'verifier-user';
const fixturePlan = { id: 'fx-1', title: DEFAULT_FIXTURE.planTitle, userId: VERIFIER };
const awaiting = {
  userId: VERIFIER,
  pendingWorkPlanInput: { requestId: 'req-1', status: 'awaiting', fields: [{ id: 'verifier_token' }] },
};

function fakeTools(overrides: Partial<Record<string, any[]>> = {}) {
  const queues: Record<string, any[]> = {
    list_predefined_work_plans: [[{ id: 'cust-1', title: 'Customer plan', userId: 'cust' }, fixturePlan]],
    emma_get_session: [{ userId: VERIFIER }, { userId: VERIFIER }, awaiting, { userId: VERIFIER, pendingWorkPlanInput: { requestId: 'req-1', status: 'answered' } }],
    emma_launch_work_plan: [{ success: true }],
    emma_answer_work_plan_input: [{ success: true }],
    ...overrides,
  };
  const calls: Array<[string, any]> = [];
  const callTool = jest.fn(async (name: string, args: any) => {
    calls.push([name, args]);
    const q = queues[name];
    if (!q || q.length === 0) throw new Error(`unexpected call ${name}`);
    return wrap(q.shift());
  });
  return { callTool, calls };
}

const base = { sessionId: 's-1', verifierUserId: VERIFIER, sleep: async () => {}, pollIntervalMs: 0 };

describe('ENG-2060 work-plan lifecycle probe', () => {
  it('drives list -> launch -> poll -> answer -> readback on the fixture only', async () => {
    const { callTool, calls } = fakeTools();
    const ev = await runWorkPlanLifecycleProbe(callTool, base);
    expect(ev).toMatchObject({ ok: true, planId: 'fx-1', requestId: 'req-1', polls: 2 });
    expect(ev.steps.map((s) => s.step)).toEqual(['list', 'launch', 'poll_input', 'answer', 'readback']);
    expect(calls).toContainEqual(['emma_launch_work_plan', { session_id: 's-1', plan_id: 'fx-1' }]);
    expect(calls).toContainEqual(['emma_answer_work_plan_input', {
      session_id: 's-1', request_id: 'req-1', values: DEFAULT_FIXTURE.answers,
    }]);
  });

  it('never launches when the fixture is absent', async () => {
    const { callTool, calls } = fakeTools({ list_predefined_work_plans: [[{ id: 'cust-1', title: 'Customer plan' }]] });
    const ev = await runWorkPlanLifecycleProbe(callTool, base);
    expect(ev).toMatchObject({ ok: false, failedStep: 'list' });
    expect(calls.map((c) => c[0])).not.toContain('emma_launch_work_plan');
  });

  it('refuses a fixture-titled plan owned by another account', async () => {
    const { callTool, calls } = fakeTools({ list_predefined_work_plans: [[{ ...fixturePlan, userId: 'cust' }]] });
    const ev = await runWorkPlanLifecycleProbe(callTool, base);
    expect(ev.failedStep).toBe('list');
    expect(calls.map((c) => c[0])).not.toContain('emma_launch_work_plan');
  });

  it('refuses to mutate a session not owned by the verifier', async () => {
    const { callTool, calls } = fakeTools({ emma_get_session: [{ userId: 'customer' }] });
    const ev = await runWorkPlanLifecycleProbe(callTool, base);
    expect(ev.failedStep).toBe('launch');
    expect(calls.map((c) => c[0])).not.toContain('emma_launch_work_plan');
  });

  it('bounds polling and never answers when input never arrives', async () => {
    const idle = { userId: VERIFIER };
    const { callTool, calls } = fakeTools({ emma_get_session: [idle, idle, idle, idle] });
    const ev = await runWorkPlanLifecycleProbe(callTool, { ...base, maxPolls: 3 });
    expect(ev).toMatchObject({ ok: false, failedStep: 'poll_input', polls: 3 });
    expect(calls.map((c) => c[0])).not.toContain('emma_answer_work_plan_input');
  });

  it('does not answer a request whose fields differ from the fixture contract', async () => {
    const odd = { userId: VERIFIER, pendingWorkPlanInput: { requestId: 'r', status: 'awaiting', fields: [{ id: 'budget' }] } };
    const { callTool, calls } = fakeTools({ emma_get_session: [{ userId: VERIFIER }, odd] });
    const ev = await runWorkPlanLifecycleProbe(callTool, base);
    expect(ev.failedStep).toBe('poll_input');
    expect(calls.map((c) => c[0])).not.toContain('emma_answer_work_plan_input');
  });

  it('fails readback when the request is still awaiting', async () => {
    const { callTool } = fakeTools({ emma_get_session: [{ userId: VERIFIER }, awaiting, awaiting] });
    const ev = await runWorkPlanLifecycleProbe(callTool, base);
    expect(ev.failedStep).toBe('readback');
  });

  it('rejects a non-fixture title before any call', async () => {
    const { callTool } = fakeTools();
    await expect(runWorkPlanLifecycleProbe(callTool, { ...base, fixture: { planTitle: 'Customer plan', answers: {} } }))
      .rejects.toBeInstanceOf(ProbeRefusal);
    expect(callTool).not.toHaveBeenCalled();
  });
});
