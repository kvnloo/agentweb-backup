/**
 * ENG-2378 review fixes: a stored step model is NEVER dropped by a write.
 *
 * With the switch off (or its state unknown after a settings-read failure) a submitted step `model` is ignored, but
 * the STORED model of the matching existing step is carried over, so an ordinary save / merge cannot erase it.
 * Also: modify_work_plan binds a model to its step (title), not to the stepCount slot; save_work_plan carries it;
 * /public/plans never exposes step models.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() }, orgDb: { getOrgById: jest.fn() } }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined) }));
const mockStore = new Map<string, any>();
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    createWorkPlan: jest.fn(async (p: any) => { const saved = { ...p, planId: 'new-plan', createdAt: 'c', updatedAt: 'u' }; mockStore.set('new-plan', saved); return saved; }),
    getWorkPlan: jest.fn(async (id: string) => mockStore.get(id) ?? null),
    updateWorkPlan: jest.fn(async (p: any) => { mockStore.set(p.planId, p); return 'rev'; }),
    getPublicPlansForAgentMode: jest.fn(),
    getWorkPlansByVisibility: jest.fn(),
    getWorkPlansByOwner: jest.fn(),
  },
}));
jest.mock('../services/workPlanThumbnailService', () => ({ workPlanThumbnailService: { generateAIThumbnail: jest.fn(() => Promise.resolve()) } }));
let mockState: 'on' | 'off' | 'unknown' = 'off';
jest.mock('../services/agentMode/workPlanStepModelsInstance', () => ({
  workPlanStepModels: {
    isEnabled: jest.fn(async () => mockState === 'on'),
    getState: jest.fn(async () => mockState),
    shouldHonor: jest.fn(async () => mockState !== 'off'),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'user-1', isAdmin: true }; next(); },
  isAdmin: (_req: any, _res: any, next: any) => next(),
  getUserFromToken: jest.fn().mockResolvedValue({ user: null }),
}));
jest.mock('../services/orgAuthz', () => ({ can: jest.fn(() => true), canEditItem: jest.fn(() => true) }));
const REG = new Set(['gpt-5-chat', 'claude-sonnet-x']);
const registry = {
  resolveGenerationModel: (m: string) => (REG.has(m) ? { model: m, fellBack: false, requestedModel: m } : { model: 'gpt-5-chat', fellBack: true, requestedModel: m }),
  isModelSelectableBy: () => true,
  getModelDisplayName: () => undefined,
};
jest.mock('../services/agentModeService', () => ({
  get agentModeService() { return registry; },
  normalizeWorkPlanTitleForMatch: (t: string) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
}));
const mockChatbot = { getChatSession: jest.fn(), updateSessionWorkPlan: jest.fn() };
jest.mock('../services/chatbotService', () => ({ chatbotDb: mockChatbot }));

import { userDb } from '../services/db';
import adminWorkPlanRoutes from '../routes/adminWorkPlanRoutes';
import userWorkPlanRoutes from '../routes/userWorkPlanRoutes';
import { authenticateToken, isAdmin } from '../middleware/auth';
import { carryStoredStepModels } from '../services/agentMode/workPlanStepModels';
import { modifyWorkPlan } from '../emma/impl/workPlans';
import { agentModeController } from '../controllers/agentModeController';
import { workPlanService } from '../services/workPlanService';

const wps = workPlanService as jest.Mocked<typeof workPlanService>;

describe('carryStoredStepModels', () => {
  const stored = [
    { stepCount: 1, title: 'Alpha', model: 'gpt-5-chat' },
    { stepCount: 2, title: 'Beta', model: 'claude-sonnet-x' },
    { stepCount: 3, title: 'Gamma' },
  ];
  it('matches by title first (reorder keeps each model with its step)', () => {
    const out = carryStoredStepModels([{ stepCount: 1, title: 'Beta' }, { stepCount: 2, title: 'Alpha' }], stored);
    expect(out.map((s: any) => s.model)).toEqual(['claude-sonnet-x', 'gpt-5-chat']);
  });
  it('a step renamed in place (same count, nothing else moved, same content) keeps its model', () => {
    const st = [{ stepCount: 1, title: 'Alpha', description: 'a', model: 'gpt-5-chat' }, { stepCount: 2, title: 'Beta', description: 'b', model: 'claude-sonnet-x' }, { stepCount: 3, title: 'Gamma', description: 'c' }];
    const out = carryStoredStepModels([{ stepCount: 1, title: 'Alpha', description: 'a' }, { stepCount: 2, title: 'Beta renamed', description: 'b' }, { stepCount: 3, title: 'Gamma', description: 'c' }], st);
    expect(out.map((s: any) => s.model)).toEqual(['gpt-5-chat', 'claude-sonnet-x', undefined]);
  });
  it('does not hand a model to a different step that merely took over the number', () => {
    // Alpha moved to slot 2 and Beta was deleted: a brand-new step at slot 1 must NOT inherit Alpha's model
    const out = carryStoredStepModels([{ stepCount: 1, title: 'Brand new' }, { stepCount: 2, title: 'Alpha' }], stored);
    expect(out.map((s: any) => s.model)).toEqual([undefined, 'gpt-5-chat']);
  });
  it('never overrides a model the step already carries, and leaves model-less stored steps alone', () => {
    const out = carryStoredStepModels([{ stepCount: 1, title: 'Alpha', model: 'claude-sonnet-x' }, { stepCount: 3, title: 'Gamma' }], stored);
    expect(out.map((s: any) => s.model)).toEqual(['claude-sonnet-x', undefined]);
  });
});

describe('carryStoredStepModels: duplicates, deletes and renames never bind the wrong model (round 2)', () => {
  const m = (steps: any[]) => steps.map((s) => s.model);
  it('N1: duplicated titles keep their own models (matched by slot when the title is ambiguous)', () => {
    const stored = [{ stepCount: 1, title: 'Review', model: 'm1' }, { stepCount: 2, title: 'Review', model: 'm2' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Review' }, { stepCount: 2, title: 'Review' }], stored))).toEqual(['m1', 'm2']);
  });
  it('N1: a duplicated title at a DIFFERENT slot does not guess (first hit must not win)', () => {
    const stored = [{ stepCount: 1, title: 'Review', model: 'm1' }, { stepCount: 2, title: 'Review', model: 'm2' }];
    const stored2 = [{ stepCount: 1, title: 'Review', description: 'old', model: 'm1' }, { stepCount: 2, title: 'Review', model: 'm2' }];
    // slot 1 was replaced by a different step (different content): it must not inherit m1; slot 2 keeps m2
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Intro', description: 'new' }, { stepCount: 2, title: 'Review' }], stored2))).toEqual([undefined, 'm2']);
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Intro' }, { stepCount: 2, title: 'Other' }, { stepCount: 3, title: 'Review' }], stored))).toEqual([undefined, undefined, undefined]);
  });
  it('N1: two incoming steps with one title cannot both inherit the single stored model', () => {
    const stored = [{ stepCount: 1, title: 'Review', model: 'm1' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Review' }, { stepCount: 2, title: 'Review' }], stored))).toEqual(['m1', undefined]);
  });
  it('N2: delete + rename drops the model instead of binding another step\'s', () => {
    const stored = [{ stepCount: 1, title: 'Draft', model: 'm1' }, { stepCount: 2, title: 'Review', model: 'm2' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Review v2' }], stored))).toEqual([undefined]);
  });
  it('N2: a same-count replacement with different content is not a rename', () => {
    const stored = [{ stepCount: 1, title: 'Draft', description: 'write it', model: 'm1' }, { stepCount: 2, title: 'Ship' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Plan the launch', description: 'plan it' }, { stepCount: 2, title: 'Ship' }], stored))).toEqual([undefined, undefined]);
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Draft v2', description: 'write it' }, { stepCount: 2, title: 'Ship' }], stored))).toEqual(['m1', undefined]);
  });
  it('N2: two renames at once (ambiguous) drop; a lone in-place rename with the same count keeps', () => {
    const stored = [{ stepCount: 1, title: 'Draft', model: 'm1' }, { stepCount: 2, title: 'Review', model: 'm2' }, { stepCount: 3, title: 'Ship' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Draft 2' }, { stepCount: 2, title: 'Review 2' }, { stepCount: 3, title: 'Ship' }], stored))).toEqual([undefined, undefined, undefined]);
    const withContent = [{ stepCount: 1, title: 'Draft', description: 'd', model: 'm1' }, { stepCount: 2, title: 'Review', description: 'r', model: 'm2' }, { stepCount: 3, title: 'Ship', description: 's' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'Draft', description: 'd' }, { stepCount: 2, title: 'Review renamed', description: 'r' }, { stepCount: 3, title: 'Ship', description: 's' }], withContent))).toEqual(['m1', 'm2', undefined]);
  });
  it('N2: with a different count a rename is never bound by position (insert / delete around it)', () => {
    const stored = [{ stepCount: 1, title: 'Draft', model: 'm1' }, { stepCount: 2, title: 'Review', model: 'm2' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'New first' }, { stepCount: 2, title: 'Draft' }, { stepCount: 3, title: 'Review renamed' }], stored))).toEqual([undefined, 'm1', undefined]);
  });
  it('reorder and insert still follow the title', () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'mA' }, { stepCount: 2, title: 'B', model: 'mB' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'B' }, { stepCount: 2, title: 'Inserted' }, { stepCount: 3, title: 'A' }], stored))).toEqual(['mB', undefined, 'mA']);
  });
  it('a stored step is consumed at most once (no reuse by a later incoming step)', () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'mA' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'A' }, { stepCount: 1, title: 'A' }], stored))).toEqual(['mA', undefined]);
  });
});

describe('carryStoredStepModels: shifted duplicates and empty steps (round 3)', () => {
  const m = (steps: any[]) => steps.map((s) => s.model);
  const rev = (d: string, extra: any = {}) => ({ title: 'Review', description: d, ...extra });
  const stored = [{ stepCount: 1, ...rev('d1'), model: 'm1' }, { stepCount: 2, ...rev('d2'), model: 'm2' }];
  it('F1: deleting the first of two duplicates never hands its model to the survivor', () => {
    expect(m(carryStoredStepModels([{ stepCount: 1, ...rev('d2') }], stored))).toEqual([undefined]);
  });
  it('F1: swapped duplicates do not swap (or keep) their models', () => {
    expect(m(carryStoredStepModels([{ stepCount: 1, ...rev('d2') }, { stepCount: 2, ...rev('d1') }], stored))).toEqual([undefined, undefined]);
  });
  it('F1: a NEW duplicate inserted first gets nothing and the shifted ones are not guessed', () => {
    expect(m(carryStoredStepModels([{ stepCount: 1, ...rev('d3') }, { stepCount: 2, ...rev('d1') }, { stepCount: 3, ...rev('d2') }], stored))).toEqual([undefined, undefined, undefined]);
  });
  it('F1: duplicates in the same place with the same content keep their own models; identical twins match by number', () => {
    expect(m(carryStoredStepModels([{ stepCount: 1, ...rev('d1') }, { stepCount: 2, ...rev('d2') }], stored))).toEqual(['m1', 'm2']);
    const twins = [{ stepCount: 1, ...rev('x'), model: 'm1' }, { stepCount: 2, ...rev('x'), model: 'm2' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, ...rev('x') }, { stepCount: 2, ...rev('x') }], twins))).toEqual(['m1', 'm2']);
  });
  it('LOW: a new step with no content at a deleted step\'s number does not inherit its model', () => {
    const st = [{ stepCount: 1, title: 'A', model: 'm1' }, { stepCount: 2, title: 'B', model: 'm2' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'A' }, { stepCount: 2, title: 'C' }], st))).toEqual(['m1', undefined]);
  });
  it('A1: a stored title that is unique still does not match when the INCOMING list repeats it (stored [X,R] incoming [R,R])', () => {
    const st = [{ stepCount: 1, title: 'X', description: 'x' }, { stepCount: 2, ...rev('r'), model: 'm' }];
    expect(m(carryStoredStepModels([{ stepCount: 1, ...rev('r') }, { stepCount: 2, ...rev('r') }], st))).toEqual([undefined, 'm']);
  });
  it('A4: a rename never binds across different step numbers', () => {
    const st = [{ stepCount: 1, title: 'A', description: 'd', model: 'm1' }, { stepCount: 2, title: 'B', description: 'e', model: 'm2' }];
    // B moved up, and the step that replaced A (same text) sits at number 2: not a rename in place
    expect(m(carryStoredStepModels([{ stepCount: 1, title: 'B', description: 'e' }, { stepCount: 2, title: 'C', description: 'd' }], st))).toEqual(['m2', undefined]);
  });
});

describe.each([
  ['admin', '/api/admin/work-plans'],
  ['user', '/api/user-work-plans'],
])('%s routes never erase a stored step model', (_who, base) => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/work-plans', authenticateToken, isAdmin, adminWorkPlanRoutes);
  app.use('/api/user-work-plans', authenticateToken, userWorkPlanRoutes);
  const full = (withModel: boolean) => [
    { stepCount: 1, title: 'One', description: 'd1', ...(withModel && { model: 'gpt-5-chat' }) },
    { stepCount: 2, title: 'Two', description: 'd2', ...(withModel && { model: 'claude-sonnet-x' }) },
  ];
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
    mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: full(true) });
    (userDb.getUserById as jest.Mock).mockResolvedValue({ userId: 'user-1', isAdmin: false });
  });

  it.each(['off', 'unknown'] as const)('switch %s: a full-step payload WITH models keeps the stored models (submitted values ignored)', async (state) => {
    mockState = state;
    const swapped = full(true).map((s) => ({ ...s, model: 'something-else' }));
    const res = await request(app).put(`${base}/p1`).send({ title: 'Edited', steps: swapped });
    expect(res.status).toBe(200);
    expect(mockStore.get('p1').steps.map((s: any) => s.model)).toEqual(['gpt-5-chat', 'claude-sonnet-x']);
  });

  it.each(['off', 'unknown'] as const)('switch %s: a payload LACKING model (portal / MCP round trip) keeps the stored models', async (state) => {
    mockState = state;
    const res = await request(app).put(`${base}/p1`).send({ title: 'Edited', steps: full(false) });
    expect(res.status).toBe(200);
    expect(mockStore.get('p1').steps.map((s: any) => s.model)).toEqual(['gpt-5-chat', 'claude-sonnet-x']);
  });

  it.each(['off', 'unknown'] as const)('N1 switch %s: duplicate titles keep their own stored models on a full-step payload lacking model', async (state) => {
    mockState = state;
    mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: [
      { stepCount: 1, title: 'Review', description: 'a', model: 'gpt-5-chat' }, { stepCount: 2, title: 'Review', description: 'b', model: 'claude-sonnet-x' }] });
    const res = await request(app).put(`${base}/p1`).send({ steps: [{ stepCount: 1, title: 'Review', description: 'a' }, { stepCount: 2, title: 'Review', description: 'b' }] });
    expect(res.status).toBe(200);
    expect(mockStore.get('p1').steps.map((s: any) => s.model)).toEqual(['gpt-5-chat', 'claude-sonnet-x']);
  });

  it('switch off: a reorder carries each model with its step (title match)', async () => {
    mockState = 'off';
    const res = await request(app).put(`${base}/p1`).send({ steps: [{ stepCount: 1, title: 'Two', description: 'd2' }, { stepCount: 2, title: 'One', description: 'd1' }] });
    expect(res.status).toBe(200);
    expect(mockStore.get('p1').steps.map((s: any) => s.model)).toEqual(['claude-sonnet-x', 'gpt-5-chat']);
  });

  it('switch ON: a payload lacking model on the USER route still keeps the stored model (admin replace is refused by the content guard instead)', async () => {
    mockState = 'on';
    const res = await request(app).put(`${base}/p1`).send({ steps: full(false) });
    if (base.includes('user')) {
      expect(res.status).toBe(200);
      expect(mockStore.get('p1').steps.map((s: any) => s.model)).toEqual(['gpt-5-chat', 'claude-sonnet-x']);
    } else {
      expect(res.status).toBe(400);
    }
  });

  it('switch ON: an explicit blank model still clears it (user route)', async () => {
    mockState = 'on';
    if (!base.includes('user')) return;
    const res = await request(app).put(`${base}/p1`).send({ steps: [{ stepCount: 1, title: 'One', description: 'd1', model: '' }, { stepCount: 2, title: 'Two', description: 'd2', model: 'claude-sonnet-x' }] });
    expect(res.status).toBe(200);
    expect(mockStore.get('p1').steps.map((s: any) => s.model)).toEqual([undefined, 'claude-sonnet-x']);
  });
});

describe('admin MCP merge/replace with the switch off', () => {
  it('admin merge with the switch off keeps the stored model', async () => {
    mockState = 'off';
    const app = express();
    app.use(express.json());
    app.use('/api/admin/work-plans', authenticateToken, isAdmin, adminWorkPlanRoutes);
    mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'system', steps: [{ stepCount: 1, title: 'One', model: 'gpt-5-chat' }] });
    const res = await request(app).put('/api/admin/work-plans/p1').send({ steps_mode: 'merge', steps: [{ stepCount: 1, description: 'x' }] });
    expect(res.status).toBe(200);
    expect(mockStore.get('p1').steps[0].model).toBe('gpt-5-chat');
  });
});

describe('modify_work_plan binds a model to its step, not to the stepCount slot', () => {
  const callLLM = jest.fn(async () => ({ content: 'NO' })) as any;
  const plan = () => ({
    title: 'Plan', createdAt: 'x', updatedAt: 'x',
    steps: [
      { stepCount: 1, title: 'Intro', status: 'pending' },
      { stepCount: 2, title: 'Cheap work', status: 'pending', model: 'claude-sonnet-x' },
      { stepCount: 3, title: 'Deep reasoning', status: 'pending', model: 'gpt-5-chat' },
    ],
  });
  const run = async (steps: any[], remove: number[] = []) => {
    mockChatbot.getChatSession.mockResolvedValue({ sessionId: 's', userId: 'u', messages: [], calledFunctions: {}, workPlan: plan() });
    mockChatbot.updateSessionWorkPlan.mockResolvedValue({});
    const r = await modifyWorkPlan(steps, remove, 's', undefined, false, callLLM);
    expect(r.success).toBe(true);
    return (mockChatbot.updateSessionWorkPlan.mock.calls[0][1].steps as any[]).map((s) => `${s.title}:${s.model ?? '-'}`);
  };
  beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'log').mockImplementation(() => {}); });

  it('insert at 2: the pushed-down steps keep their own models, the new step gets none', async () => {
    const out = await run([
      { stepCount: 2, title: 'Inserted' },
      { stepCount: 3, title: 'Cheap work' },
      { stepCount: 4, title: 'Deep reasoning' },
    ]);
    expect(out).toEqual(['Intro:-', 'Inserted:-', 'Cheap work:claude-sonnet-x', 'Deep reasoning:gpt-5-chat']);
  });
  it('reorder: models travel with the titles', async () => {
    const out = await run([{ stepCount: 2, title: 'Deep reasoning' }, { stepCount: 3, title: 'Cheap work' }]);
    expect(out).toEqual(['Intro:-', 'Deep reasoning:gpt-5-chat', 'Cheap work:claude-sonnet-x']);
  });
  it('delete: remaining steps keep their models', async () => {
    const out = await run([{ stepCount: 2, title: 'Deep reasoning' }], [3]);
    expect(out).toEqual(['Intro:-', 'Deep reasoning:gpt-5-chat']);
  });
  it('an edit that leaves the title alone keeps the model', async () => {
    const out = await run([{ stepCount: 2, title: 'Cheap work', description: 'more detail' }]);
    expect(out).toEqual(['Intro:-', 'Cheap work:claude-sonnet-x', 'Deep reasoning:gpt-5-chat']);
  });
});

describe('save_work_plan carries the session step model', () => {
  it.each([['on', true], ['unknown', true], ['off', false]] as const)('switch %s => model carried: %s', async (state, carried) => {
    mockState = state;
    mockChatbot.getChatSession.mockResolvedValue({ workPlan: { steps: [{ stepCount: 1, title: 'A', model: 'gpt-5-chat' }, { stepCount: 2, title: 'B' }] } });
    await import('../emma/tools');
    const { emmaToolRegistry } = await import('../emma/registry');
    await emmaToolRegistry.execute('save_work_plan', { title: 'T', steps: [{ stepCount: 1, title: 'A' }, { stepCount: 2, title: 'B' }] }, { userId: 'u', sessionId: 's' } as any);
    const saved = (wps.createWorkPlan as jest.Mock).mock.calls.pop()![0].steps;
    expect(saved.map((s: any) => s.model)).toEqual(carried ? ['gpt-5-chat', undefined] : [undefined, undefined]);
  });
});

describe('/public/plans never exposes step models', () => {
  const res = () => { const r: any = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; };
  it('getAllPredefinedWorkPlans strips model from every step but keeps the rest', async () => {
    (wps.getPublicPlansForAgentMode as jest.Mock).mockResolvedValue([
      { planId: 'p', title: 'P', showInAgentMode: true, visibility: 'system', steps: [{ stepCount: 1, title: 'A', description: 'd', model: 'gpt-5-chat' }], createdAt: 'x', updatedAt: 'x' },
    ]);
    (wps.getWorkPlansByOwner as jest.Mock).mockResolvedValue([]);
    const r = res();
    await agentModeController.getAllPredefinedWorkPlans({} as any, r);
    const body = r.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('gpt-5-chat');
    expect(body[0].steps[0]).toMatchObject({ stepCount: 1, title: 'A', description: 'd' });
  });
  it('getPredefinedWorkPlan strips it too', async () => {
    const plan = { planId: 'p', title: 'Onboarding', showInAgentMode: true, visibility: 'system', steps: [{ stepCount: 1, title: 'A', model: 'gpt-5-chat' }], createdAt: 'x', updatedAt: 'x' };
    (wps.getWorkPlansByVisibility as jest.Mock).mockImplementation(async (v: string) => (v === 'system' ? [plan] : []));
    const r = res();
    await agentModeController.getPredefinedWorkPlan({ params: { planTitle: 'Onboarding' } } as any, r);
    expect(JSON.stringify(r.json.mock.calls[0][0])).not.toContain('gpt-5-chat');
  });
});
