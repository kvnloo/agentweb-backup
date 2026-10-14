/**
 * ENG-2378: createSessionWithPlan (public / portal plan launch) with per-step models.
 * Every step's model is validated up front (422 + stepCount, nothing created) and copied canonically to the
 * session's plan; the switch off = not copied, not validated.
 */
import { Request, Response } from 'express';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { workPlanService } from '../services/workPlanService';
import { agentModeService } from '../services/agentModeService';
import { getUserFromToken } from '../middleware/auth';
import { userDb } from '../services/db';

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {
    createChatSession: jest.fn(),
    updateSessionWorkPlan: jest.fn(),
    updateSessionInteractiveShareMetadata: jest.fn(),
    updateSessionWorkPlanInputRequest: jest.fn().mockResolvedValue(undefined),
    updateSessionLlmModel: jest.fn(),
    getChatSession: jest.fn(),
    addMessageToSession: jest.fn().mockResolvedValue({}),
    addAssociatedSkills: jest.fn().mockResolvedValue(undefined),
    deleteSession: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../services/workPlanService', () => ({
  workPlanService: { getWorkPlansByVisibility: jest.fn(), getWorkPlansByOwner: jest.fn(), getWorkPlansByOrg: jest.fn() },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    getSupportedModels: jest.fn(),
    getDefaultModel: jest.fn(),
    resolveGenerationModel: jest.fn(),
    isModelSelectableBy: jest.fn(),
    getModelDisplayName: jest.fn(),
  },
  normalizeWorkPlanTitleForMatch: jest.requireActual('../services/agentModeService').normalizeWorkPlanTitleForMatch,
}));
jest.mock('../middleware/auth', () => ({ getUserFromToken: jest.fn(), authenticateToken: jest.fn((_q, _r, next) => next()) }));
jest.mock('../utils/agentModeAlerts', () => ({ sendAgentModeOncallAlert: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/generateMarketingResponseWorkerService', () => ({
  generateMarketingResponseWorkerService: {
    restartWorker: jest.fn(), runInWorker: jest.fn(), cancelSession: jest.fn(),
    ensureWorkerReady: jest.fn(), isWorkerHealthy: jest.fn().mockResolvedValue(true),
  },
}));
let mockSwitch = true;
let mockSwitchReads = 0;
let mockUnknown = false;
jest.mock('../services/agentMode/workPlanStepModelsInstance', () => ({
  workPlanStepModels: {
    isEnabled: jest.fn(async () => { mockSwitchReads += 1; return mockSwitch; }),
    shouldHonor: jest.fn(async () => { mockSwitchReads += 1; return mockSwitch || mockUnknown; }),
  },
}));

const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
const wps = workPlanService as jest.Mocked<typeof workPlanService>;
const svc = agentModeService as jest.Mocked<typeof agentModeService>;
const mockGetUserFromToken = getUserFromToken as jest.MockedFunction<typeof getUserFromToken>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const S = (n: number, model?: any) => ({ stepCount: n, title: `Step ${n}`, ...(model !== undefined && { model }) });
const session = { sessionId: 'sess-1', userId: 'u-1', title: 't', messages: [], createdAt: 'x', updatedAt: 'x', portalType: 'agent' as const, pageIdentifier: 'plan-Onboarding' };
const publish = (steps: any[], extra: any = {}) => {
  const plans = [{ planId: 'plan-1', title: 'Onboarding', steps, visibility: 'system' as const, isBuiltIn: true, createdAt: 'x', updatedAt: 'x', ...extra }];
  wps.getWorkPlansByVisibility.mockImplementation((v: string) => Promise.resolve(v === 'system' ? (plans as any) : []));
};
const res = () => { const r: any = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r as Response; };
const req = () => ({ params: { planTitle: 'Onboarding' }, headers: { 'content-type': 'application/json' }, body: {} } as unknown as Request);
const REG = new Set(['gpt-5-chat', 'gemini-3-pro-preview', 'admin-only-model', 'internal-judge']);

beforeEach(() => {
  jest.clearAllMocks();
  mockSwitch = true;
  mockUnknown = false;
  mockSwitchReads = 0;
  process.env.CUSTOMER_FRONTEND_URL = 'http://localhost:5174';
  wps.getWorkPlansByOwner.mockResolvedValue([]);
  wps.getWorkPlansByOrg.mockResolvedValue([]);
  mockUserDb.getUserById.mockResolvedValue({ userId: 'u-1', isAdmin: false } as any);
  mockGetUserFromToken.mockResolvedValue({ user: { userId: 'u-1', email: 'a@b.c' } } as any);
  svc.getSupportedModels.mockResolvedValue(['gpt-5-chat', 'gemini-3-pro-preview']);
  svc.getDefaultModel.mockResolvedValue('gpt-5-chat');
  (svc.resolveGenerationModel as jest.Mock).mockImplementation((m: string) => {
    const n = m === 'legacy-alias' ? 'gemini-3-pro-preview' : m;
    return REG.has(n) ? { model: n, fellBack: false, requestedModel: m } : { model: 'gpt-5-chat', fellBack: true, requestedModel: m };
  });
  (svc.isModelSelectableBy as jest.Mock).mockImplementation((m: string, admin: boolean) => (m === 'internal-judge' ? false : m === 'admin-only-model' ? admin : true));
  db.createChatSession.mockResolvedValue(session as any);
  db.updateSessionLlmModel.mockResolvedValue(session as any);
  db.updateSessionWorkPlan.mockResolvedValue(session as any);
});

const expectNothingCreated = () => {
  expect(db.createChatSession).not.toHaveBeenCalled();
  expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
  expect(db.addAssociatedSkills).not.toHaveBeenCalled();
  expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
  expect(db.updateSessionInteractiveShareMetadata).not.toHaveBeenCalled();
};

describe('createSessionWithPlan with per-step models', () => {
  it('ON: validates every step, copies canonical models onto the session plan, leaves model-less steps alone', async () => {
    publish([S(1, 'legacy-alias'), S(2), S(3, ' gpt-5-chat ')]);
    const r = res();
    await agentModeController.createSessionWithPlan(req(), r);
    expect(r.status).not.toHaveBeenCalledWith(422);
    const steps = db.updateSessionWorkPlan.mock.calls[0][1].steps as any[];
    expect(steps.map((s) => s.model)).toEqual(['gemini-3-pro-preview', undefined, 'gpt-5-chat']);
    expect('model' in steps[1]).toBe(false);
    // the session starts on the account default (no plan pin); the engine applies step 1's model at the first turn
    expect(db.updateSessionLlmModel).toHaveBeenCalledWith('sess-1', 'gpt-5-chat');
  });

  it.each([
    ['retired', 'retired-9', 'not_served'],
    ['internalOnly', 'internal-judge', 'not_selectable'],
    ['adminOnly for a non-admin launcher', 'admin-only-model', 'not_selectable'],
    ['non-string', ['gpt-5-chat'], 'not_served'],
  ])('ON: a %s model on a LATER step is a 422 naming that step and creates nothing', async (_l, model, reason) => {
    publish([S(1, 'gpt-5-chat'), S(2), S(3, model)]);
    const r = res();
    await agentModeController.createSessionWithPlan(req(), r);
    expect(r.status).toHaveBeenCalledWith(422);
    expect((r.json as jest.Mock).mock.calls[0][0]).toMatchObject({ code: 'model_unavailable', reason, stepCount: 3 });
    expect(String((r.json as jest.Mock).mock.calls[0][0].error)).toContain('nothing was sent to a different model');
    expectNothingCreated();
  });

  it('ON: an adminOnly step model launches for an admin', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: 'u-1', isAdmin: true } as any);
    publish([S(1, 'admin-only-model')]);
    const r = res();
    await agentModeController.createSessionWithPlan(req(), r);
    expect(r.status).not.toHaveBeenCalledWith(422);
    expect((db.updateSessionWorkPlan.mock.calls[0][1].steps as any[])[0].model).toBe('admin-only-model');
  });

  it('ON: the plan pin is still resolved and still wins at launch; a bad pin is refused with no stepCount', async () => {
    publish([S(1, 'gemini-3-pro-preview')], { defaultModel: 'gpt-5-chat' });
    await agentModeController.createSessionWithPlan(req(), res());
    expect(db.updateSessionLlmModel).toHaveBeenCalledWith('sess-1', 'gpt-5-chat');
    jest.clearAllMocks();
    publish([S(1, 'gemini-3-pro-preview')], { defaultModel: 'retired-9' });
    const r = res();
    await agentModeController.createSessionWithPlan(req(), r);
    expect(r.status).toHaveBeenCalledWith(422);
    expect((r.json as jest.Mock).mock.calls[0][0].stepCount).toBeUndefined();
  });

  it('ON, anonymous visitor: the refusal names no model, reason or step', async () => {
    mockGetUserFromToken.mockResolvedValue({ user: null });
    publish([S(1, 'retired-9')]);
    const r = res();
    await agentModeController.createSessionWithPlan(req(), r);
    expect(r.status).toHaveBeenCalledWith(422);
    expect((r.json as jest.Mock).mock.calls[0][0]).toEqual({
      error: "This work plan can't start right now because its model is unavailable.",
      code: 'model_unavailable',
    });
    expectNothingCreated();
  });

  it('OFF: not validated (a retired step model does not block) and NOT copied to the session plan', async () => {
    mockSwitch = false;
    publish([S(1, 'retired-9'), S(2, 'gpt-5-chat')]);
    const r = res();
    await agentModeController.createSessionWithPlan(req(), r);
    expect(r.status).not.toHaveBeenCalledWith(422);
    expect((db.updateSessionWorkPlan.mock.calls[0][1].steps as any[]).every((s) => !('model' in s))).toBe(true);
  });

  it('a plan with no step models never reads the switch and launches exactly as before', async () => {
    publish([S(1), S(2)]);
    await agentModeController.createSessionWithPlan(req(), res());
    expect(mockSwitchReads).toBe(0);
    expect((db.updateSessionWorkPlan.mock.calls[0][1].steps as any[]).every((s) => !('model' in s))).toBe(true);
  });

  it('records launchModel (and planDefaultModel when the plan pins one) for the model-less steps to fall back to', async () => {
    publish([S(1, 'gemini-3-pro-preview'), S(2)], { defaultModel: 'gpt-5-chat' });
    await agentModeController.createSessionWithPlan(req(), res());
    expect(db.updateSessionWorkPlan.mock.calls[0][1]).toMatchObject({ planDefaultModel: 'gpt-5-chat', launchModel: 'gpt-5-chat' });
    jest.clearAllMocks();
    publish([S(1, 'gemini-3-pro-preview'), S(2)]);
    await agentModeController.createSessionWithPlan(req(), res());
    const wp = db.updateSessionWorkPlan.mock.calls[0][1] as any;
    expect(wp.launchModel).toBe('gpt-5-chat'); // the account default the session starts on
    expect('planDefaultModel' in wp).toBe(false);
  });

  it('a plan without step models records neither', async () => {
    publish([S(1), S(2)], { defaultModel: 'gpt-5-chat' });
    await agentModeController.createSessionWithPlan(req(), res());
    const wp = db.updateSessionWorkPlan.mock.calls[0][1] as any;
    expect('launchModel' in wp).toBe(false);
  });

  it('switch state UNKNOWN still validates and copies step models', async () => {
    mockSwitch = false;
    mockUnknown = true;
    publish([S(1, 'retired-9')]);
    const r = res();
    await agentModeController.createSessionWithPlan(req(), r);
    expect(r.status).toHaveBeenCalledWith(422);
  });

  describe('the response never leaks step models or bookkeeping to an anonymous visitor (round 2)', () => {
    const body = (r: Response) => (r.json as jest.Mock).mock.calls[0][0];
    it('anonymous: no step model, launchModel, planDefaultModel or engineModel in the returned workPlan; the stored session plan keeps them', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      publish([S(1, 'gpt-5-chat'), S(2)], { defaultModel: 'gpt-5-chat' });
      const r = res();
      await agentModeController.createSessionWithPlan(req(), r);
      const wp = body(r).workPlan;
      expect(JSON.stringify(wp)).not.toMatch(/gpt-5-chat|launchModel|planDefaultModel|engineModel|"model"/);
      expect(wp.steps).toHaveLength(2);
      expect(wp.steps[0]).toMatchObject({ stepCount: 1, title: 'Step 1' });
      // the persisted session plan is untouched (the engine needs it)
      expect((db.updateSessionWorkPlan.mock.calls[0][1].steps as any[])[0].model).toBe('gpt-5-chat');
    });
    it('D6: the plan persisted on the session is not mutated by the response redaction', async () => {
      mockGetUserFromToken.mockResolvedValue({ user: null });
      publish([S(1, 'gpt-5-chat'), S(2)], { defaultModel: 'gpt-5-chat' });
      let snapshot = '';
      db.updateSessionWorkPlan.mockImplementation(async (_id: string, wp: any) => { snapshot = JSON.stringify(wp); return session as any; });
      await agentModeController.createSessionWithPlan(req(), res());
      const persisted = db.updateSessionWorkPlan.mock.calls[0][1];
      expect(JSON.stringify(persisted)).toBe(snapshot);
      expect(snapshot).toMatch(/launchModel/);
      expect((persisted.steps as any[])[0].model).toBe('gpt-5-chat');
    });
    it('authenticated owner: keeps step models but never the internal bookkeeping fields', async () => {
      publish([S(1, 'gpt-5-chat'), S(2)], { defaultModel: 'gpt-5-chat' });
      const r = res();
      await agentModeController.createSessionWithPlan(req(), r);
      const wp = body(r).workPlan;
      expect(wp.steps[0].model).toBe('gpt-5-chat');
      expect(JSON.stringify(wp)).not.toMatch(/launchModel|planDefaultModel|engineModel/);
    });
  });
});


