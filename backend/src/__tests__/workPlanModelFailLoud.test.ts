/**
 * ENG-903: Work Plan `defaultModel` is an explicit pin. It must (a) be refused at WRITE time
 * when unservable, and (b) fail the LAUNCH loudly (shared model_unavailable body / Emma tool
 * message) before any session mutation, never silently launching on the account default.
 */
import request from 'supertest';
import express from 'express';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    getChatSession: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
    updateSessionWorkPlanInputRequest: jest.fn(),
    updateCalledFunctions: jest.fn(),
    addAssociatedSkills: jest.fn(),
    updateSessionLlmModel: jest.fn(),
  },
}));
jest.mock('../services/predefinedWorkPlanResolver', () => ({
  getAccessiblePredefinedWorkPlanCandidates: jest.fn(),
}));
jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() },
  orgDb: { getOrgById: jest.fn() },
}));
const mockAlert = jest.fn().mockResolvedValue(undefined);
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: (...a: any[]) => mockAlert(...a) }));
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    createWorkPlan: jest.fn(),
    getWorkPlan: jest.fn(),
    updateWorkPlan: jest.fn(),
  },
}));
jest.mock('../services/workPlanThumbnailService', () => ({
  workPlanThumbnailService: { generateAIThumbnail: jest.fn(() => Promise.resolve()) },
}));
let mockIsAdminCaller = false;
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'user-1', isAdmin: mockIsAdminCaller }; next(); },
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../services/orgAuthz', () => ({ can: jest.fn(() => true), canEditItem: jest.fn(() => true) }));

// Registry double: same shape as AgentModeService's resolveGenerationModel / isModelSelectableBy.
const REG = new Set(['gpt-5-chat', 'claude-sonnet-x', 'admin-only-model', 'internal-judge', 'live-voice']);
const registry = {
  resolveGenerationModel: (m: string) => {
    const n = m === 'legacy-alias' ? 'claude-sonnet-x' : m;
    return REG.has(n) ? { model: n, fellBack: false, requestedModel: m } : { model: 'gpt-5-chat', fellBack: true, requestedModel: m };
  },
  isModelSelectableBy: (m: string, admin: boolean) => {
    if (m === 'internal-judge' || m === 'live-voice') return false;
    if (m === 'admin-only-model') return admin;
    return true;
  },
  getModelDisplayName: (m: string) => (m === 'claude-sonnet-x' ? 'Claude Sonnet X' : undefined),
  getSupportedModels: async () => ['gpt-5-chat', 'claude-sonnet-x'],
};
jest.mock('../services/agentModeService', () => ({
  get agentModeService() { return registry; },
}));

import * as workPlansImpl from '../emma/impl/workPlans';
import { chatbotDb } from '../services/chatbotService';
import { getAccessiblePredefinedWorkPlanCandidates } from '../services/predefinedWorkPlanResolver';
import { userDb } from '../services/db';
import { resolvePlanLaunchModel, validatePlanDefaultModelWrite } from '../services/agentMode/modelPin';
import { workPlanService } from '../services/workPlanService';
import adminWorkPlanRoutes from '../routes/adminWorkPlanRoutes';
import userWorkPlanRoutes from '../routes/userWorkPlanRoutes';
import { authenticateToken, isAdmin } from '../middleware/auth';

const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
const candidates = getAccessiblePredefinedWorkPlanCandidates as jest.Mock;
const getUser = (userDb as any).getUserById as jest.Mock;
const wps = workPlanService as jest.Mocked<typeof workPlanService>;

const plan = (defaultModel: any) => ({
  planId: 'plan-1', title: 'Client Onboarding', visibility: 'system', defaultModel,
  steps: [{ stepCount: 1, title: 'S1', skillIds: ['skill-a'] }],
});
const SENTENCE = "isn't available right now, so nothing was sent to a different model. Choose another model and try again.";

describe('resolvePlanLaunchModel (launch-time rules shared with schedule pins)', () => {
  const notAdmin = async () => false;
  const admin = async () => true;
  it.each([
    ['retired id', 'retired-9', 'not_served'],
    ['non-string', 42, 'not_served'],
    ['internalOnly', 'internal-judge', 'not_selectable'],
    ['live-voice', 'live-voice', 'not_selectable'],
    ['adminOnly for non-admin', 'admin-only-model', 'not_selectable'],
  ])('refuses %s', async (_l, model, reason) => {
    await expect(resolvePlanLaunchModel(registry, notAdmin, model)).rejects.toMatchObject({ code: 'model_unavailable', reason });
  });
  it('accepts adminOnly for an admin, canonicalises an alias, treats empty as no pin', async () => {
    await expect(resolvePlanLaunchModel(registry, admin, 'admin-only-model')).resolves.toBe('admin-only-model');
    await expect(resolvePlanLaunchModel(registry, notAdmin, 'legacy-alias')).resolves.toBe('claude-sonnet-x');
    await expect(resolvePlanLaunchModel(registry, notAdmin, 'gpt-5-chat')).resolves.toBe('gpt-5-chat');
    await expect(resolvePlanLaunchModel(registry, notAdmin, '')).resolves.toBeUndefined();
    await expect(resolvePlanLaunchModel(registry, notAdmin, '  ')).resolves.toBeUndefined();
    await expect(resolvePlanLaunchModel(registry, notAdmin, undefined)).resolves.toBeUndefined();
  });
});

describe('validatePlanDefaultModelWrite', () => {
  const notAdmin = async () => false;
  it('untouched for undefined/null; clears with blank; trims; tolerates an unchanged stale stored value', async () => {
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, undefined)).toEqual({ touched: false });
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, null)).toEqual({ touched: false });
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, '  ')).toEqual({ touched: true, value: '' });
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, '  gpt-5-chat ')).toEqual({ touched: true, value: 'gpt-5-chat' });
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, 'retired-9', 'retired-9')).toEqual({ touched: true, value: 'retired-9' });
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, ' retired-9 ', 'retired-9')).toEqual({ touched: true, value: 'retired-9' });
  });
  it('refuses a CHANGED unservable value and a non-string', async () => {
    await expect(validatePlanDefaultModelWrite(registry, notAdmin, 'retired-9', 'gpt-5-chat')).rejects.toMatchObject({ reason: 'not_served' });
    await expect(validatePlanDefaultModelWrite(registry, notAdmin, { a: 1 })).rejects.toMatchObject({ reason: 'not_served' });
    await expect(validatePlanDefaultModelWrite(registry, notAdmin, 'internal-judge')).rejects.toMatchObject({ reason: 'not_selectable' });
  });
});

describe('applyPredefinedWorkPlan (Emma tool / launch / accept core)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: false });
    db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [] } as any);
  });
  const launch = (model: any, opts: any = {}) => {
    candidates.mockResolvedValue([plan(model)]);
    return workPlansImpl.applyPredefinedWorkPlan('Client Onboarding', 's1', 'user-1', opts, registry as any);
  };
  const expectNoSideEffects = () => {
    expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
    expect(db.addAssociatedSkills).not.toHaveBeenCalled();
    expect(db.updateCalledFunctions).not.toHaveBeenCalled();
    expect(db.updateSessionWorkPlanInputRequest).not.toHaveBeenCalled();
    expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
  };

  it.each([
    ['retired', 'retired-9', 'not_served'],
    ['internalOnly', 'internal-judge', 'not_selectable'],
    ['live-voice', 'live-voice', 'not_selectable'],
    ['adminOnly (non-admin owner)', 'admin-only-model', 'not_selectable'],
    ['non-string', { x: 1 }, 'not_served'],
  ])('%s plan model: refuses with the shared sentence and no session mutation', async (_l, model, reason) => {
    const r: any = await launch(model);
    expect(r.success).toBe(false);
    expect(r.errorType).toBe('model_unavailable');
    expect(r.modelUnavailable).toMatchObject({ code: 'model_unavailable', reason });
    expect(r.message).toContain(SENTENCE);
    expect(r.message).toBe(r.modelUnavailable.error);
    expectNoSideEffects();
  });

  it('uses the registry display name in the sentence', async () => {
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: false });
    const r: any = await launch('internal-judge');
    expect(r.message).toContain('(internal-judge)');
  });

  it('refuses BEFORE the active-plan confirmation gate would be reached for a model-broken plan', async () => {
    const r: any = await launch('retired-9', { force: true });
    expect(r.errorType).toBe('model_unavailable');
    expectNoSideEffects();
  });

  it('adminOnly plan model launches for an admin owner', async () => {
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    const r: any = await launch('admin-only-model');
    expect(r.success).toBe(true);
    expect(db.updateSessionLlmModel).toHaveBeenCalledWith('s1', 'admin-only-model');
  });

  it('valid, alias and live-served ids launch and store the canonical id; empty leaves the model untouched', async () => {
    expect(((await launch('gpt-5-chat')) as any).success).toBe(true);
    expect(db.updateSessionLlmModel).toHaveBeenLastCalledWith('s1', 'gpt-5-chat');
    expect(((await launch('legacy-alias')) as any).success).toBe(true);
    expect(db.updateSessionLlmModel).toHaveBeenLastCalledWith('s1', 'claude-sonnet-x');
    db.updateSessionLlmModel.mockClear();
    expect(((await launch('')) as any).success).toBe(true);
    expect(((await launch(undefined)) as any).success).toBe(true);
    expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('unattended (scheduled) launch: refused, no side effects, oncall alert sent', async () => {
    const r: any = await launch('retired-9', { isUnattendedRun: true });
    expect(r.errorType).toBe('model_unavailable');
    expectNoSideEffects();
    await new Promise((res) => setImmediate(res));
    expect(mockAlert).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'workplan_model_invalid:plan-1:retired-9' }));
  });

  it('interactive launch does not page oncall', async () => {
    await launch('retired-9');
    await new Promise((res) => setImmediate(res));
    expect(mockAlert).not.toHaveBeenCalled();
  });
});

describe('plan write routes (create/update)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/work-plans', authenticateToken, isAdmin, adminWorkPlanRoutes);
  app.use('/api/user-work-plans', authenticateToken, userWorkPlanRoutes);
  const step = { stepCount: 1, title: 'S', description: 'd' };
  const stored = (defaultModel?: string) => ({
    planId: 'p1', title: 'T', steps: [step], visibility: 'private', ownerId: 'user-1', defaultModel,
    createdAt: 'x', updatedAt: 'x',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdminCaller = false;
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: false });
    wps.createWorkPlan.mockImplementation(async (p: any) => ({ ...p, planId: 'new' }));
    wps.updateWorkPlan.mockResolvedValue('rev');
  });

  it.each(['/api/user-work-plans', '/api/admin/work-plans'])('POST %s: 422 for retired / internal / non-string, nothing written', async (base) => {
    for (const defaultModel of ['retired-9', 'internal-judge', ['gpt-5-chat']]) {
      const res = await request(app).post(base).send({ title: 'T', steps: [step], defaultModel });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('model_unavailable');
    }
    expect(wps.createWorkPlan).not.toHaveBeenCalled();
  });

  it('POST user: adminOnly is 422 for a member, accepted for an admin; trims; blank stores nothing', async () => {
    const denied = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: [step], defaultModel: 'admin-only-model' });
    expect(denied.status).toBe(422);
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    const ok = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: [step], defaultModel: ' admin-only-model ' });
    expect(ok.status).toBe(201);
    expect(wps.createWorkPlan.mock.calls[0][0].defaultModel).toBe('admin-only-model');
    const blank = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: [step], defaultModel: '  ' });
    expect(blank.status).toBe(201);
    expect(wps.createWorkPlan.mock.calls[1][0].defaultModel).toBeUndefined();
  });

  it('POST admin: adminOnly accepted (writer is an admin)', async () => {
    const res = await request(app).post('/api/admin/work-plans').send({ title: 'T', steps: [step], defaultModel: 'admin-only-model', visibility: 'system' });
    expect(res.status).toBe(201);
  });

  it.each([['/api/user-work-plans', 'private'], ['/api/admin/work-plans', 'private']])('PUT %s: tolerates an UNCHANGED stale stored model, refuses a changed bad one, clears with blank', async (base) => {
    wps.getWorkPlan.mockResolvedValue(stored('retired-9') as any);
    const unchanged = await request(app).put(`${base}/p1`).send({ title: 'Renamed', defaultModel: 'retired-9' });
    expect(unchanged.status).toBe(200);
    expect(wps.updateWorkPlan.mock.calls[0][0].defaultModel).toBe('retired-9');

    const omitted = await request(app).put(`${base}/p1`).send({ title: 'Renamed again' });
    expect(omitted.status).toBe(200);
    expect(wps.updateWorkPlan.mock.calls[1][0].defaultModel).toBe('retired-9');

    wps.updateWorkPlan.mockClear();
    const changedBad = await request(app).put(`${base}/p1`).send({ defaultModel: 'other-retired' });
    expect(changedBad.status).toBe(422);
    expect(changedBad.body).toMatchObject({ code: 'model_unavailable', reason: 'not_served', requestedModel: 'other-retired' });
    const nonString = await request(app).put(`${base}/p1`).send({ defaultModel: 7 });
    expect(nonString.status).toBe(422);
    expect(wps.updateWorkPlan).not.toHaveBeenCalled();

    const cleared = await request(app).put(`${base}/p1`).send({ defaultModel: '   ' });
    expect(cleared.status).toBe(200);
    expect(wps.updateWorkPlan.mock.calls[0][0].defaultModel).toBeUndefined();

    const changedGood = await request(app).put(`${base}/p1`).send({ defaultModel: ' gpt-5-chat ' });
    expect(changedGood.status).toBe(200);
    expect(wps.updateWorkPlan.mock.calls[1][0].defaultModel).toBe('gpt-5-chat');
  });
});
