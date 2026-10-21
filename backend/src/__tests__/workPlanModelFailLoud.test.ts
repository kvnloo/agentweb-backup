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
    restoreSessionLlmModelIfUnchanged: jest.fn(),
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
// ENG-669: AW-Settings rows by name (tier-allowlist switch off unless a test sets it) and the owner's tier.
const mockSettings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (mockSettings[name] === undefined ? null : { settingName: name, settingValue: mockSettings[name] })),
  },
}));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionResolution: jest.fn(async () => ({ subscriptionType: 'Free', resolved: true })),
  readTierAllowedModels: jest.fn(async (tier: string) => (tier === 'Free' ? { configured: true, allowedModels: ['gpt-5-chat'] } : { configured: false })),
}));

// Registry double: same shape as AgentModeService's resolveGenerationModel / isModelSelectableBy.
const REG = new Set(['gpt-5-chat', 'claude-sonnet-x', 'admin-only-model', 'internal-judge', 'live-voice']);
const registry = {
  resolveGenerationModel: (m: string) => {
    const n = m === 'legacy-alias' ? 'claude-sonnet-x' : m === 'legacy-internal' ? 'internal-judge' : m;
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
import * as orgShareService from '../services/orgShareService';
import { authenticateToken, isAdmin } from '../middleware/auth';
import { modelAccess } from '../services/agentMode/modelAccessInstance';

const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
const candidates = getAccessiblePredefinedWorkPlanCandidates as jest.Mock;
const getUser = (userDb as any).getUserById as jest.Mock;
const wps = workPlanService as jest.Mocked<typeof workPlanService>;

const plan = (defaultModel: any) => ({
  planId: 'plan-1', title: 'Client Onboarding', visibility: 'system', defaultModel,
  steps: [{ stepCount: 1, title: 'S1', skillIds: ['skill-a'] }],
});
const SENTENCE = "isn't available right now, so the plan was not started and nothing was sent to a different model.";

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
    expect(r.message).toContain(r.modelUnavailable.error);
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
    expect(db.updateSessionLlmModel).toHaveBeenCalledWith('s1', 'admin-only-model', undefined, 'system');
  });

  it('valid, alias and live-served ids launch and store the canonical id; empty leaves the model untouched', async () => {
    expect(((await launch('gpt-5-chat')) as any).success).toBe(true);
    expect(db.updateSessionLlmModel).toHaveBeenLastCalledWith('s1', 'gpt-5-chat', undefined, 'system');
    expect(((await launch('legacy-alias')) as any).success).toBe(true);
    expect(db.updateSessionLlmModel).toHaveBeenLastCalledWith('s1', 'claude-sonnet-x', undefined, 'system');
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

  it('ENG-669 PR-C: an unattended launch pinned to an unavailable AgentWeb Model is refused without paging (the router alert covers it)', async () => {
    const { agentWebModelRouter } = await import('../services/agentMode/agentWebModelRouterInstance');
    for (const table of [undefined, '{not json']) {
      agentWebModelRouter.reset();
      mockAlert.mockClear();
      mockSettings.agentweb_model_router_enabled = table ? 'true' : undefined;
      mockSettings.agentweb_model_routing_table = table;
      const r: any = await launch('agentweb-model', { isUnattendedRun: true });
      expect(r.errorType).toBe('model_unavailable');
      expect(r.message).toContain('(AgentWeb Model)');
      expectNoSideEffects();
      await new Promise((res) => setImmediate(res));
      expect(mockAlert.mock.calls.map(([a]) => a.dedupeKey).filter((k) => String(k).startsWith('workplan_model_invalid'))).toEqual([]);
    }
    delete mockSettings.agentweb_model_router_enabled;
    delete mockSettings.agentweb_model_routing_table;
    agentWebModelRouter.reset();
  });

  it('a FAILED model write refuses the launch and writes nothing else (model is written first)', async () => {
    db.updateSessionLlmModel.mockRejectedValueOnce(new Error('ddb down'));
    const r: any = await launch('gpt-5-chat');
    expect(r.success).toBe(false);
    expect(r.errorType).toBe('model_save_failed');
    expect(r.code).toBe('model_save_failed');
    expect(r.message).toContain('Do not retry');
    expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
    expect(db.addAssociatedSkills).not.toHaveBeenCalled();
    expect(db.updateCalledFunctions).not.toHaveBeenCalled();
    expect(db.updateSessionWorkPlanInputRequest).not.toHaveBeenCalled();
  });

  it('the model write happens before the plan write on success', async () => {
    const r: any = await launch('gpt-5-chat');
    expect(r.success).toBe(true);
    expect(db.updateSessionLlmModel.mock.invocationCallOrder[0])
      .toBeLessThan(db.updateSessionWorkPlan.mock.invocationCallOrder[0]);
  });

  it('Emma tool message names no user selection, carries a no-retry hint, keeps code fields', async () => {
    const r: any = await launch('retired-9');
    expect(r.errorType).toBe('model_unavailable');
    expect(r.code).toBe('model_unavailable');
    expect(r.message).not.toContain('you selected');
    expect(r.message).toContain("work plan's pinned model");
    expect(r.message).toContain('Do not retry');
    expect(r.message).toContain('work plan settings');
    expect(r.modelUnavailable.error).not.toContain('you selected');
  });

  describe('compensation and pre-validation (model write is rolled back / never happens)', () => {
    const PRIOR_DECISION = { requestedModel: 'old-model', honored: true } as any;
    beforeEach(() => {
      db.getChatSession.mockResolvedValue({
        sessionId: 's1', messages: [], llmModel: 'old-model', llmUsagePolicyDecision: PRIOR_DECISION,
        workPlan: { title: 'Old', steps: [{ stepCount: 1, title: 'x', status: 'pending' }] },
      } as any);
    });

    it('plan write fails: previous model AND policy decision are restored conditionally on the model we wrote', async () => {
      db.restoreSessionLlmModelIfUnchanged.mockResolvedValue(true);
      db.updateSessionWorkPlan.mockRejectedValueOnce(new Error('ddb throttled'));
      const r: any = await launch('gpt-5-chat', { force: true });
      expect(r.success).toBe(false);
      expect(db.updateSessionLlmModel).toHaveBeenCalledTimes(1);
      expect(db.updateSessionLlmModel).toHaveBeenCalledWith('s1', 'gpt-5-chat', undefined, 'system');
      expect(db.restoreSessionLlmModelIfUnchanged).toHaveBeenCalledWith('s1', 'gpt-5-chat', { llmModel: 'old-model', llmUsagePolicyDecision: PRIOR_DECISION });
    });

    it('session had NO explicit model: restore asks for absence, never a stored default', async () => {
      db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [], workPlan: { title: 'Old', steps: [{ stepCount: 1, title: 'x', status: 'pending' }] } } as any);
      db.restoreSessionLlmModelIfUnchanged.mockResolvedValue(true);
      db.updateSessionWorkPlan.mockRejectedValueOnce(new Error('ddb throttled'));
      const r: any = await launch('gpt-5-chat', { force: true });
      expect(r.success).toBe(false);
      expect(db.restoreSessionLlmModelIfUnchanged).toHaveBeenCalledWith('s1', 'gpt-5-chat', { llmModel: undefined, llmUsagePolicyDecision: undefined });
      expect(db.updateSessionLlmModel).toHaveBeenCalledTimes(1);
    });

    it('a user model change in the window is preserved (condition fails -> info log, no CRITICAL, still a failure)', async () => {
      // In-memory session with the real conditional semantics.
      const row: any = { llmModel: 'old-model' };
      db.updateSessionLlmModel.mockImplementation(async (_id: string, m: string) => { row.llmModel = m; return {} as any; });
      db.restoreSessionLlmModelIfUnchanged.mockImplementation(async (_id: string, expected: string, prev: any) => {
        if (row.llmModel !== expected) return false;
        row.llmModel = prev.llmModel;
        return true;
      });
      db.updateSessionWorkPlan.mockImplementationOnce(async () => { row.llmModel = 'USER-PICK'; throw new Error('ddb throttled'); });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      const r: any = await launch('gpt-5-chat', { force: true });
      expect(r.success).toBe(false);
      expect(row.llmModel).toBe('USER-PICK');
      expect(errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).not.toMatch(/CRITICAL/);
      expect(infoSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('s1');
      errSpy.mockRestore(); infoSpy.mockRestore();
    });

    it('restore itself fails: CRITICAL log with the session id, caller still gets a failure, never success', async () => {
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      db.updateSessionWorkPlan.mockRejectedValueOnce(new Error('ddb throttled'));
      db.restoreSessionLlmModelIfUnchanged.mockRejectedValueOnce(new Error('restore down'));
      const r: any = await launch('gpt-5-chat', { force: true });
      expect(r.success).toBe(false);
      const logged = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      expect(logged).toMatch(/CRITICAL/);
      expect(logged).toContain('s1');
      errSpy.mockRestore();
    });

    it('non-sequential stepCount: no model write at all (nothing changes)', async () => {
      candidates.mockResolvedValue([{ ...plan('gpt-5-chat'), steps: [{ stepCount: 1, title: 'a' }, { stepCount: 3, title: 'b' }] }]);
      const r: any = await workPlansImpl.applyPredefinedWorkPlan('Client Onboarding', 's1', 'user-1', { force: true }, registry as any);
      expect(r.success).toBe(false);
      expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
      expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
    });
  });

  describe('anonymous (visitor) session via the Emma tool', () => {
    it('model_unavailable message and body name no model id, name or reason', async () => {
      candidates.mockResolvedValue([plan('admin-only-model')]);
      const r: any = await workPlansImpl.applyPredefinedWorkPlan('Client Onboarding', 's1', 'anon_abc', {}, registry as any);
      expect(r.errorType).toBe('model_unavailable');
      const text = JSON.stringify(r);
      expect(text).not.toContain('admin-only-model');
      expect(text).not.toMatch(/not_selectable|not_served/);
      expect(r.modelUnavailable).toEqual({ error: "This work plan can't start right now because its model is unavailable.", code: 'model_unavailable' });
      expect(r.message).toContain("can't start right now");
      expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
    });
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

  it.each(['system', 'public', undefined, 'shared'])('POST admin: adminOnly on a %s plan is 422 not_selectable (everyone launches it)', async (visibility) => {
    mockIsAdminCaller = true;
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    const res = await request(app).post('/api/admin/work-plans').send({ title: 'T', steps: [step], defaultModel: 'admin-only-model', visibility });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable' });
    expect(wps.createWorkPlan).not.toHaveBeenCalled();
  });

  it('POST admin: even a private plan has no owner here, so adminOnly is 422 (use the owner route for that)', async () => {
    mockIsAdminCaller = true;
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    const res = await request(app).post('/api/admin/work-plans').send({ title: 'T', steps: [step], defaultModel: 'admin-only-model', visibility: 'private' });
    expect(res.status).toBe(422);
  });

  it('PUT admin: adminOnly pin on a system plan or another owner\'s private plan is 422; on own private plan accepted', async () => {
    mockIsAdminCaller = true;
    getUser.mockImplementation(async (id: string) => ({ userId: id, isAdmin: id === 'user-1' }));
    for (const p of [
      { ...stored(), visibility: 'system', ownerId: undefined },
      { ...stored(), visibility: 'public' },
      { ...stored(), visibility: 'private', ownerId: 'someone-else' },
    ]) {
      wps.getWorkPlan.mockResolvedValue(p as any);
      const res = await request(app).put('/api/admin/work-plans/p1').send({ defaultModel: 'admin-only-model' });
      expect(res.status).toBe(422);
    }
    expect(wps.updateWorkPlan).not.toHaveBeenCalled();
    wps.getWorkPlan.mockResolvedValue(stored() as any);
    const ok = await request(app).put('/api/admin/work-plans/p1').send({ defaultModel: 'admin-only-model' });
    expect(ok.status).toBe(200);
  });

  it('PUT user: a NON-admin caller pinning an adminOnly model is 422', async () => {
    wps.getWorkPlan.mockResolvedValue(stored('gpt-5-chat') as any);
    const res = await request(app).put('/api/user-work-plans/p1').send({ defaultModel: 'admin-only-model' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable' });
    expect(wps.updateWorkPlan).not.toHaveBeenCalled();
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

describe('canonical id storage (alias in => canonical persisted)', () => {
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
    mockIsAdminCaller = true;
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    wps.createWorkPlan.mockImplementation(async (p: any) => ({ ...p, planId: 'new' }));
    wps.updateWorkPlan.mockResolvedValue('rev');
  });

  it.each(['/api/user-work-plans', '/api/admin/work-plans'])('POST %s stores the canonical id for an alias', async (base) => {
    const res = await request(app).post(base).send({ title: 'T', steps: [step], defaultModel: ' legacy-alias ' });
    expect(res.status).toBe(201);
    expect(wps.createWorkPlan.mock.calls[0][0].defaultModel).toBe('claude-sonnet-x');
  });

  it.each(['/api/user-work-plans', '/api/admin/work-plans'])('PUT %s stores the canonical id for an alias', async (base) => {
    wps.getWorkPlan.mockResolvedValue(stored('gpt-5-chat') as any);
    const res = await request(app).put(`${base}/p1`).send({ defaultModel: 'legacy-alias' });
    expect(res.status).toBe(200);
    expect(wps.updateWorkPlan.mock.calls[0][0].defaultModel).toBe('claude-sonnet-x');
  });

  it.each(['/api/user-work-plans', '/api/admin/work-plans'])('PUT %s: an alias that resolves to a non-selectable model is still 422', async (base) => {
    wps.getWorkPlan.mockResolvedValue(stored('gpt-5-chat') as any);
    const res = await request(app).put(`${base}/p1`).send({ defaultModel: 'legacy-internal' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable', requestedModel: 'legacy-internal' });
    expect(wps.updateWorkPlan).not.toHaveBeenCalled();
  });

  it.each(['/api/user-work-plans', '/api/admin/work-plans'])('PUT %s: an unchanged stored alias resent is tolerated and not rewritten', async (base) => {
    wps.getWorkPlan.mockResolvedValue(stored('legacy-alias') as any);
    const res = await request(app).put(`${base}/p1`).send({ title: 'R', defaultModel: ' legacy-alias ' });
    expect(res.status).toBe(200);
    expect(wps.updateWorkPlan.mock.calls[0][0].defaultModel).toBe('legacy-alias');
    // the canonical form of the stored alias is also "unchanged"
    const res2 = await request(app).put(`${base}/p1`).send({ defaultModel: 'claude-sonnet-x' });
    expect(res2.status).toBe(200);
    expect(wps.updateWorkPlan.mock.calls[1][0].defaultModel).toBe('claude-sonnet-x');
  });

  it('validatePlanDefaultModelWrite: canonical for alias; requested value for a registry without resolveGenerationModel', async () => {
    const notAdmin = async () => false;
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, 'legacy-alias')).toEqual({ touched: true, value: 'claude-sonnet-x' });
    expect(await validatePlanDefaultModelWrite({}, notAdmin, ' legacy-alias ')).toEqual({ touched: true, value: 'legacy-alias' });
  });
});

describe('admin status scope: private + owner-admin + NO org only', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/work-plans', authenticateToken, isAdmin, adminWorkPlanRoutes);
  app.use('/api/user-work-plans', authenticateToken, userWorkPlanRoutes);
  const step = { stepCount: 1, title: 'S', description: 'd' };
  const stored = (over: any = {}) => ({
    planId: 'p1', title: 'T', steps: [step], visibility: 'private', ownerId: 'user-1',
    createdAt: 'x', updatedAt: 'x', ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdminCaller = true;
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    wps.createWorkPlan.mockImplementation(async (p: any) => ({ ...p, planId: 'new' }));
    wps.updateWorkPlan.mockResolvedValue('rev');
  });

  it.each(['system', 'public'])('admin PUT visibility private->%s over a STORED adminOnly pin (model omitted): 422 not_selectable, nothing written', async (visibility) => {
    wps.getWorkPlan.mockResolvedValue(stored({ defaultModel: 'admin-only-model' }) as any);
    const res = await request(app).put('/api/admin/work-plans/p1').send({ visibility });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable' });
    expect(wps.updateWorkPlan).not.toHaveBeenCalled();
  });

  it('admin PUT visibility private->system with the SAME adminOnly model re-sent: still 422', async () => {
    wps.getWorkPlan.mockResolvedValue(stored({ defaultModel: 'admin-only-model' }) as any);
    const res = await request(app).put('/api/admin/work-plans/p1').send({ visibility: 'system', defaultModel: 'admin-only-model' });
    expect(res.status).toBe(422);
  });

  it('admin PUT visibility private->system is fine when the stored model is selectable by everyone, or when it also clears the pin', async () => {
    wps.getWorkPlan.mockResolvedValue(stored({ defaultModel: 'gpt-5-chat' }) as any);
    expect((await request(app).put('/api/admin/work-plans/p1').send({ visibility: 'system' })).status).toBe(200);
    wps.getWorkPlan.mockResolvedValue(stored({ defaultModel: 'admin-only-model' }) as any);
    expect((await request(app).put('/api/admin/work-plans/p1').send({ visibility: 'system', defaultModel: '' })).status).toBe(200);
  });

  it('admin PUT: an org-scoped private plan is shared, so adminOnly is 422 even for its admin owner', async () => {
    wps.getWorkPlan.mockResolvedValue(stored({ orgId: 'org-1', defaultModel: 'gpt-5-chat' }) as any);
    const res = await request(app).put('/api/admin/work-plans/p1').send({ defaultModel: 'admin-only-model' });
    expect(res.status).toBe(422);
  });

  it('user POST: admin-1 in an org -> plan gets orgId -> adminOnly pin is 422; admin-1 with no org -> 201', async () => {
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true, orgId: 'org-1' });
    const denied = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: [step], defaultModel: 'admin-only-model' });
    expect(denied.status).toBe(422);
    expect(wps.createWorkPlan).not.toHaveBeenCalled();
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    const ok = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: [step], defaultModel: 'admin-only-model' });
    expect(ok.status).toBe(201);
  });

  it('user PUT: the OWNER decides adminOnly, not the editor (admin editing a non-admin owner\'s private plan is 422; non-admin editing an admin owner\'s is 200)', async () => {
    // The editor is an org editor allowed to edit another member's plan (real rule lives in orgShareService).
    const editSpy = jest.spyOn(orgShareService, 'canEditItem').mockReturnValue(true);
    getUser.mockImplementation(async (id: string) => ({ userId: id, isAdmin: id === 'user-1' }));
    wps.getWorkPlan.mockResolvedValue(stored({ ownerId: 'owner-2' }) as any);
    const denied = await request(app).put('/api/user-work-plans/p1').send({ defaultModel: 'admin-only-model' });
    expect(denied.status).toBe(422);
    expect(denied.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable' });
    expect(wps.updateWorkPlan).not.toHaveBeenCalled();
    getUser.mockImplementation(async (id: string) => ({ userId: id, isAdmin: id === 'owner-2' }));
    const ok = await request(app).put('/api/user-work-plans/p1').send({ defaultModel: 'admin-only-model' });
    expect(ok.status).toBe(200);
    editSpy.mockRestore();
  });

  it('user PUT: admin owner of an org-scoped private plan cannot set an adminOnly pin; non-org can', async () => {
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    wps.getWorkPlan.mockResolvedValue(stored({ orgId: 'org-1' }) as any);
    const denied = await request(app).put('/api/user-work-plans/p1').send({ defaultModel: 'admin-only-model' });
    expect(denied.status).toBe(422);
    wps.getWorkPlan.mockResolvedValue(stored() as any);
    const ok = await request(app).put('/api/user-work-plans/p1').send({ defaultModel: 'admin-only-model' });
    expect(ok.status).toBe(200);
  });
});

/**
 * ENG-669 PR-A: a USER-authored plan pin must be in the owner's plan at write time and in the LAUNCHING user's plan
 * at launch (422 / tool refusal `not_in_plan`); an admin-authored (system) plan's pin is AgentWeb's choice and is
 * exempt. An unchanged stored pin stays editable. Switch off: unchanged.
 */
describe('ENG-669 tier model allowlist on plan pins', () => {
  const NOT_IN_PLAN = 'claude-sonnet-x';
  const notAdmin = async () => false;
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of Object.keys(mockSettings)) delete mockSettings[key];
    mockSettings.model_tier_allowlist_enabled = 'true';
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['gpt-5-chat'] }, { name: 'Pro' }]);
    modelAccess.reset();
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: false });
    db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [] } as any);
  });

  it('modelPin: checked only with a tier owner, on the canonical id', async () => {
    await expect(resolvePlanLaunchModel(registry, notAdmin, 'legacy-alias', 'user-1'))
      .rejects.toMatchObject({ reason: 'not_in_plan', plan: { model: NOT_IN_PLAN, tier: 'Free', upgradeRequired: ['Pro'] } });
    await expect(resolvePlanLaunchModel(registry, notAdmin, NOT_IN_PLAN)).resolves.toBe(NOT_IN_PLAN);
    await expect(resolvePlanLaunchModel(registry, notAdmin, 'gpt-5-chat', 'user-1')).resolves.toBe('gpt-5-chat');
  });

  it('modelPin: an UNCHANGED stored pin outside the plan stays editable; a changed one is refused', async () => {
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, NOT_IN_PLAN, NOT_IN_PLAN, 'user-1')).toEqual({ touched: true, value: NOT_IN_PLAN });
    // The stored alias resent as its canonical id is the same model: unchanged, stored canonically.
    expect(await validatePlanDefaultModelWrite(registry, notAdmin, NOT_IN_PLAN, 'legacy-alias', 'user-1')).toEqual({ touched: true, value: NOT_IN_PLAN });
    await expect(validatePlanDefaultModelWrite(registry, notAdmin, NOT_IN_PLAN, 'gpt-5-chat', 'user-1')).rejects.toMatchObject({ reason: 'not_in_plan' });
  });

  describe('launch (Emma tool / applyPredefinedWorkPlan)', () => {
    const launchPlan = (p: Record<string, unknown>) => {
      candidates.mockResolvedValue([p]);
      return workPlansImpl.applyPredefinedWorkPlan('Client Onboarding', 's1', 'user-1', {}, registry as any) as Promise<any>;
    };

    it("a user plan's pin outside the launcher's plan is refused with the plan details; nothing changes", async () => {
      const r = await launchPlan({ ...plan(NOT_IN_PLAN), visibility: 'private', isBuiltIn: false, ownerId: 'user-1' });
      expect(r).toMatchObject({ success: false, errorType: 'model_unavailable' });
      expect(r.modelUnavailable).toMatchObject({ reason: 'not_in_plan', model: NOT_IN_PLAN, tier: 'Free', upgradeRequired: ['Pro'] });
      expect(r.message).toContain("isn't included in your plan");
      expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
      expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
    });

    it("an admin-authored (system) plan's pin is exempt and launches on exactly that model", async () => {
      const r = await launchPlan({ ...plan(NOT_IN_PLAN), visibility: 'system', isBuiltIn: true });
      expect(r.success).toBe(true);
      expect(db.updateSessionLlmModel).toHaveBeenCalledWith('s1', NOT_IN_PLAN, undefined, 'system');
    });

    it('switch off: the user plan launches as before', async () => {
      delete mockSettings.model_tier_allowlist_enabled;
      modelAccess.reset();
      const r = await launchPlan({ ...plan(NOT_IN_PLAN), visibility: 'private', isBuiltIn: false, ownerId: 'user-1' });
      expect(r.success).toBe(true);
    });
  });

  describe('write routes', () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin/work-plans', authenticateToken, isAdmin, adminWorkPlanRoutes);
    app.use('/api/user-work-plans', authenticateToken, userWorkPlanRoutes);
    const step = { stepCount: 1, title: 'S', description: 'd' };
    const stored = (defaultModel?: string) => ({
      planId: 'p1', title: 'T', steps: [step], visibility: 'private', ownerId: 'user-1', defaultModel, createdAt: 'x', updatedAt: 'x',
    });
    beforeEach(() => {
      mockIsAdminCaller = false;
      wps.createWorkPlan.mockImplementation(async (p: any) => ({ ...p, planId: 'new' }));
      wps.updateWorkPlan.mockResolvedValue('rev');
    });

    it("user POST: a pin outside the owner's plan is a 422 not_in_plan; nothing written", async () => {
      const res = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: [step], defaultModel: NOT_IN_PLAN });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_in_plan', tier: 'Free' });
      expect(wps.createWorkPlan).not.toHaveBeenCalled();
    });

    it('user PUT: an unchanged stored pin outside the plan stays editable; changing to one is a 422', async () => {
      wps.getWorkPlan.mockResolvedValue(stored(NOT_IN_PLAN) as any);
      expect((await request(app).put('/api/user-work-plans/p1').send({ title: 'Renamed', defaultModel: NOT_IN_PLAN })).status).toBe(200);
      wps.getWorkPlan.mockResolvedValue(stored('gpt-5-chat') as any);
      const changed = await request(app).put('/api/user-work-plans/p1').send({ defaultModel: NOT_IN_PLAN });
      expect(changed.status).toBe(422);
      expect(changed.body).toMatchObject({ reason: 'not_in_plan' });
    });

    it('admin POST (admin-authored system plan): the same pin is accepted', async () => {
      mockIsAdminCaller = true;
      const res = await request(app).post('/api/admin/work-plans').send({ title: 'T', steps: [step], defaultModel: NOT_IN_PLAN });
      expect(res.status).toBe(201);
      expect(wps.createWorkPlan).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: NOT_IN_PLAN }));
    });
  });
});
