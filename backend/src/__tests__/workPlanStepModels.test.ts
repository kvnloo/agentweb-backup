/**
 * ENG-2378: per-step model in Work Plans (write side + launch side).
 *
 * A step may carry an optional `model`. Behind the AW-Settings switch `work_plan_step_models_enabled` it is
 * validated like the plan's `defaultModel` at write time (422 model_unavailable + stepCount), round-trips through
 * every place that lists step fields, and is validated for ALL steps up front at launch (no state written when any
 * step's model cannot be served). Switch off = exactly today's behaviour: the field is dropped on write and not
 * copied at launch.
 *
 * The engine side (step.model beats the request's llmModel, mid-plan retirement pauses the plan) lives in
 * agentModeController.workPlanStepModel.test.ts.
 */
import fs from 'fs';
import path from 'path';
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

// In-memory plan store so create -> get -> update -> get is a real round trip through the route + service seam.
const mockStore = new Map<string, any>();
jest.mock('../services/workPlanService', () => ({
  workPlanService: {
    createWorkPlan: jest.fn(async (p: any) => { const saved = { ...p, planId: 'new-plan', createdAt: 'c', updatedAt: 'u' }; mockStore.set('new-plan', saved); return saved; }),
    getWorkPlan: jest.fn(async (id: string) => mockStore.get(id) ?? null),
    updateWorkPlan: jest.fn(async (p: any) => { mockStore.set(p.planId, p); return 'rev'; }),
  },
}));
jest.mock('../services/workPlanThumbnailService', () => ({
  workPlanThumbnailService: { generateAIThumbnail: jest.fn(() => Promise.resolve()) },
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
let mockIsAdminCaller = false;
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, _res: any, next: any) => { req.user = { userId: 'user-1', isAdmin: mockIsAdminCaller }; next(); },
  isAdmin: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../services/orgAuthz', () => ({ can: jest.fn(() => true), canEditItem: jest.fn(() => true) }));

const REG = new Set(['gpt-5-chat', 'claude-sonnet-x', 'admin-only-model', 'internal-judge']);
const registry = {
  resolveGenerationModel: (m: string) => {
    const n = m === 'legacy-alias' ? 'claude-sonnet-x' : m;
    return REG.has(n) ? { model: n, fellBack: false, requestedModel: m } : { model: 'gpt-5-chat', fellBack: true, requestedModel: m };
  },
  isModelSelectableBy: (m: string, admin: boolean) => {
    if (m === 'internal-judge') return false;
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
import { workPlanService } from '../services/workPlanService';
import adminWorkPlanRoutes from '../routes/adminWorkPlanRoutes';
import userWorkPlanRoutes from '../routes/userWorkPlanRoutes';
import { authenticateToken, isAdmin } from '../middleware/auth';
import { normalizeWorkPlanSteps, mergeWorkPlanSteps, WORK_PLAN_STEP_FIELDS } from '../services/workPlanSteps';
import {
  createWorkPlanStepModelsSwitch,
  WORK_PLAN_STEP_MODELS_SETTING,
  currentPendingStep,
  stepModelOf,
  anyStepCarriesModel,
  checkPlanStepModelsWrite,
  resolvePlanStepModelsForLaunch,
  isStepModelUnavailableError,
  buildStepModelPausedMessage,
} from '../services/agentMode/workPlanStepModels';

const db = chatbotDb as jest.Mocked<typeof chatbotDb>;
const candidates = getAccessiblePredefinedWorkPlanCandidates as jest.Mock;
const getUser = (userDb as any).getUserById as jest.Mock;
const wps = workPlanService as jest.Mocked<typeof workPlanService>;

describe('the switch (work_plan_step_models_enabled)', () => {
  const make = (rows: Array<{ settingValue?: unknown } | null | Error>) => {
    let now = 1_000_000;
    const getSetting = jest.fn(async () => {
      const next = rows.length > 1 ? rows.shift()! : rows[0];
      if (next instanceof Error) throw next;
      return next;
    });
    const log = jest.fn();
    const sw = createWorkPlanStepModelsSwitch({ getSetting, now: () => now, log });
    return { sw, getSetting, log, advance: (ms: number) => { now += ms; } };
  };

  it('reads the documented setting name', async () => {
    const { sw, getSetting } = make([{ settingValue: 'true' }]);
    await sw.isEnabled();
    expect(getSetting).toHaveBeenCalledWith(WORK_PLAN_STEP_MODELS_SETTING);
    expect(WORK_PLAN_STEP_MODELS_SETTING).toBe('work_plan_step_models_enabled');
  });

  it.each([['true', true], ['TRUE', false], [' true', false], ['true ', false], ['1', false], [true, false], ['false', false], ['', false], [undefined, false]])(
    'settingValue %j => enabled %s (exact string true only)', async (value, expected) => {
      const { sw } = make([{ settingValue: value }]);
      expect(await sw.isEnabled()).toBe(expected);
    });

  it('an absent row is off', async () => {
    const { sw } = make([null]);
    expect(await sw.isEnabled()).toBe(false);
  });

  it('cold-start read failure is off and logs; a later successful read turns it on', async () => {
    const { sw, log, advance } = make([new Error('ddb down'), { settingValue: 'true' }]);
    expect(await sw.isEnabled()).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    advance(5_001);
    expect(await sw.isEnabled()).toBe(true);
  });

  it('caches ~60s, then refreshes; a failed refresh keeps the last-known value', async () => {
    const { sw, getSetting, advance } = make([{ settingValue: 'true' }, new Error('blip'), { settingValue: 'false' }]);
    expect(await sw.isEnabled()).toBe(true);
    advance(59_000);
    expect(await sw.isEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(1);
    advance(2_000); // past 60s -> refresh fails -> last-known stays on
    expect(await sw.isEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(2);
    advance(1_000); // inside the 5s error-retry window: no extra read
    expect(await sw.isEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(2);
    advance(5_000); // retry succeeds with 'false'
    expect(await sw.isEnabled()).toBe(false);
  });

  it('getState: a cold-start outage is UNKNOWN (honoured), a definite false is OFF (ignored), true is ON', async () => {
    const outage = make([new Error('ddb down')]);
    expect(await outage.sw.getState()).toBe('unknown');
    expect(await outage.sw.shouldHonor()).toBe(true);
    expect(await outage.sw.isEnabled()).toBe(false);
    const off = make([{ settingValue: 'false' }]);
    expect(await off.sw.getState()).toBe('off');
    expect(await off.sw.shouldHonor()).toBe(false);
    const absent = make([null]);
    expect(await absent.sw.getState()).toBe('off');
    const on = make([{ settingValue: 'true' }]);
    expect(await on.sw.getState()).toBe('on');
    expect(await on.sw.shouldHonor()).toBe(true);
  });

  it('getState: once a read has succeeded, a later outage keeps that value (never falls back to unknown)', async () => {
    const { sw, advance } = make([{ settingValue: 'false' }, new Error('blip')]);
    expect(await sw.getState()).toBe('off');
    advance(61_000);
    expect(await sw.getState()).toBe('off');
  });

  it('parallel callers share one in-flight read', async () => {
    const { sw, getSetting } = make([{ settingValue: 'true' }]);
    await Promise.all([sw.isEnabled(), sw.isEnabled(), sw.isEnabled()]);
    expect(getSetting).toHaveBeenCalledTimes(1);
  });
});

describe('step helpers', () => {
  it('stepModelOf: trimmed non-blank string only', () => {
    expect(stepModelOf({ model: ' gpt-5-chat ' })).toBe('gpt-5-chat');
    for (const bad of [undefined, null, '', '  ', 7, ['x'], {}]) expect(stepModelOf({ model: bad as any })).toBeUndefined();
    expect(stepModelOf(undefined)).toBeUndefined();
  });

  it('currentPendingStep: first step that is neither completed nor skipped', () => {
    const wp = { steps: [{ stepCount: 1, status: 'completed' }, { stepCount: 2, status: 'skipped' }, { stepCount: 3, status: 'pending' }, { stepCount: 4, status: 'pending' }] };
    expect(currentPendingStep(wp)?.stepCount).toBe(3);
    expect(currentPendingStep({ steps: [{ status: 'completed' }] })).toBeUndefined();
    expect(currentPendingStep(undefined)).toBeUndefined();
    expect(currentPendingStep({ steps: 'nope' as any })).toBeUndefined();
  });

  it('anyStepCarriesModel: a model key (even blank) anywhere, never for non-arrays', () => {
    expect(anyStepCarriesModel([{ title: 'a' }, { title: 'b', model: 'x' }])).toBe(true);
    expect(anyStepCarriesModel([{ title: 'a', model: '' }])).toBe(true);
    expect(anyStepCarriesModel([{ title: 'a', model: null }])).toBe(false);
    expect(anyStepCarriesModel([{ title: 'a' }, null, 'x'])).toBe(false);
    expect(anyStepCarriesModel(undefined)).toBe(false);
  });
});

describe('every place that lists step fields knows `model`', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('WorkPlanStep interface fields are all in WORK_PLAN_STEP_FIELDS (a new field cannot be silently dropped again)', () => {
    const src = read('services/workPlanService.ts');
    const body = src.slice(src.indexOf('export interface WorkPlanStep {'), src.indexOf('export interface WorkPlan {'));
    const fields = Array.from(body.matchAll(/^ {2}(\w+)\??:/gm)).map((m) => m[1]);
    expect(fields).toContain('model');
    expect(fields.length).toBeGreaterThan(8);
    for (const f of fields) expect(WORK_PLAN_STEP_FIELDS.has(f)).toBe(true);
  });

  it('STEP_CONTENT_FIELDS (the destructive-replace guard) lists model', () => {
    const src = read('services/workPlanSteps.ts');
    const block = src.slice(src.indexOf('const STEP_CONTENT_FIELDS'), src.indexOf('] as const', src.indexOf('const STEP_CONTENT_FIELDS')));
    expect(block).toContain("'model'");
  });

  it('session work-plan step types (read + write side) declare model', () => {
    const src = read('services/chatbotService.ts');
    expect(src.match(/model\?: string;/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the MCP manage_predefined_work_plan step schema documents model', () => {
    expect(read('mcp/server/apiTools.ts')).toMatch(/model: \{ type: 'string', description: 'Optional model for THIS step/);
  });
});

describe('normalizeWorkPlanSteps', () => {
  it('switch ON: keeps a trimmed model; blank/null/absent store nothing; no warning for those', () => {
    const { steps, warnings } = normalizeWorkPlanSteps(
      [{ title: 'a', model: ' gpt-5-chat ' }, { title: 'b', model: '   ' }, { title: 'c', model: null }, { title: 'd' }],
      { stepModelsEnabled: true },
    );
    expect(steps.map((s) => s.model)).toEqual(['gpt-5-chat', undefined, undefined, undefined]);
    expect('model' in steps[1]).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('switch ON: a non-string model is reported and not stored', () => {
    const { steps, warnings } = normalizeWorkPlanSteps([{ title: 'a', model: 7 }, { title: 'b', model: ['x'] }], { stepModelsEnabled: true });
    expect(steps.every((s) => !('model' in s))).toBe(true);
    expect(warnings).toEqual(['step 1: ignored model — expected a string', 'step 2: ignored model — expected a string']);
  });

  it('switch OFF (default): the model is dropped with a warning, other fields untouched', () => {
    for (const options of [undefined, {}, { stepModelsEnabled: false }]) {
      const { steps, warnings } = normalizeWorkPlanSteps([{ title: 'a', model: 'gpt-5-chat', userInstructions: 'u' }], options);
      expect('model' in steps[0]).toBe(false);
      expect(steps[0].userInstructions).toBe('u');
      expect(warnings).toEqual(['step 1: ignored model — per-step models are not enabled']);
    }
  });
});

describe('mergeWorkPlanSteps with a step model', () => {
  const existing = [{ stepCount: 1, title: 'A', model: 'gpt-5-chat' }, { stepCount: 2, title: 'B' }];
  it('an amend that does not mention model keeps it', () => {
    expect(mergeWorkPlanSteps(existing, [{ stepCount: 1, title: 'A2' }])[0].model).toBe('gpt-5-chat');
  });
  it('sets and replaces a model', () => {
    const merged = mergeWorkPlanSteps(existing, [{ stepCount: 2, model: 'claude-sonnet-x' }, { stepCount: 1, model: 'claude-sonnet-x' }]);
    expect(merged.map((s) => s.model)).toEqual(['claude-sonnet-x', 'claude-sonnet-x']);
  });
  it("a blank model is the explicit clear: the key is removed, never stored as ''", () => {
    const merged = mergeWorkPlanSteps(existing, [{ stepCount: 1, model: '' }]);
    expect('model' in merged[0]).toBe(false);
  });
  it('null / undefined mean "not supplied" and keep the stored model', () => {
    expect(mergeWorkPlanSteps(existing, [{ stepCount: 1, model: null }])[0].model).toBe('gpt-5-chat');
    expect(mergeWorkPlanSteps(existing, [{ stepCount: 1, model: undefined }])[0].model).toBe('gpt-5-chat');
  });
});

describe('checkPlanStepModelsWrite (same semantics as the plan defaultModel)', () => {
  const notAdmin = async () => false;
  const admin = async () => true;

  it('steps without a model are fine and never touch the registry', async () => {
    await expect(checkPlanStepModelsWrite(notAdmin, [{ title: 'a' }, { title: 'b', model: '  ' }])).resolves.toEqual({ ok: true });
  });

  it('a served, selectable model passes', async () => {
    await expect(checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, model: 'gpt-5-chat' }, { stepCount: 2, model: 'legacy-alias' }])).resolves.toEqual({ ok: true });
  });

  it.each([
    ['retired', 'retired-9', 'not_served'],
    ['internalOnly', 'internal-judge', 'not_selectable'],
    ['adminOnly for a non-admin', 'admin-only-model', 'not_selectable'],
  ])('refuses %s with the shared body extended with stepCount (the offending step, not the first)', async (_l, model, reason) => {
    const r: any = await checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, model: 'gpt-5-chat' }, { stepCount: 2, model }]);
    expect(r.ok).toBe(false);
    expect(r.body).toMatchObject({ code: 'model_unavailable', reason, requestedModel: model, stepCount: 2 });
    expect(typeof r.body.error).toBe('string');
  });

  it('adminOnly passes when the launcher is an admin', async () => {
    await expect(checkPlanStepModelsWrite(admin, [{ stepCount: 1, model: 'admin-only-model' }])).resolves.toEqual({ ok: true });
  });

  it('an UNCHANGED stored model is tolerated even if it has since been retired (matched by stepCount)', async () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'retired-9' }];
    await expect(checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, title: 'A', model: 'retired-9' }], stored)).resolves.toEqual({ ok: true });
  });

  it('...and when the step was renumbered by a reorder, it is matched by title instead', async () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'retired-9' }, { stepCount: 2, title: 'B' }];
    const reordered = [{ stepCount: 1, title: 'B' }, { stepCount: 2, title: 'A', model: 'retired-9' }];
    await expect(checkPlanStepModelsWrite(notAdmin, reordered, stored)).resolves.toEqual({ ok: true });
  });

  it('a CHANGED model is validated, and a model newly added to a step that had none is validated', async () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'gpt-5-chat' }, { stepCount: 2, title: 'B' }];
    const changed: any = await checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, title: 'A', model: 'retired-9' }, { stepCount: 2, title: 'B' }], stored);
    expect(changed).toMatchObject({ ok: false, body: { stepCount: 1, reason: 'not_served' } });
    const added: any = await checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, title: 'A', model: 'gpt-5-chat' }, { stepCount: 2, title: 'B', model: 'retired-9' }], stored);
    expect(added).toMatchObject({ ok: false, body: { stepCount: 2 } });
  });

  it('without stored steps (create / widened scope) every model is validated as new', async () => {
    const r: any = await checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, model: 'retired-9' }]);
    expect(r.ok).toBe(false);
  });

  it('a step without a usable stepCount is reported by its array position', async () => {
    const r: any = await checkPlanStepModelsWrite(notAdmin, [{ title: 'a' }, { title: 'b', model: 'retired-9' }]);
    expect(r.body.stepCount).toBe(2);
  });
});

describe('checkPlanStepModelsWrite: each stored step is a counterpart at most once (CodeRabbit)', () => {
  const notAdmin = async () => false;
  it('a retired model copied onto a SECOND step with the same title is validated as new (only one step can be "unchanged")', async () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'retired-9' }];
    const r: any = await checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, title: 'A', model: 'retired-9' }, { stepCount: 2, title: 'A', model: 'retired-9' }], stored);
    expect(r).toMatchObject({ ok: false, body: { stepCount: 2, requestedModel: 'retired-9', reason: 'not_served' } });
  });
  it('the step that still carries the stored model claims it, whichever order they arrive in', async () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'retired-9' }];
    const r: any = await checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, title: 'A', model: 'other-retired' }, { stepCount: 2, title: 'A', model: 'retired-9' }], stored);
    expect(r).toMatchObject({ ok: false, body: { stepCount: 1, requestedModel: 'other-retired' } });
    const ok = await checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, title: 'A', model: 'gpt-5-chat' }, { stepCount: 2, title: 'A', model: 'retired-9' }], stored);
    expect(ok).toEqual({ ok: true });
  });
  it('a valid new model on the second duplicate passes while the first keeps its retired stored one', async () => {
    const stored = [{ stepCount: 1, title: 'A', model: 'retired-9' }];
    await expect(checkPlanStepModelsWrite(notAdmin, [{ stepCount: 1, title: 'A', model: 'retired-9' }, { stepCount: 2, title: 'A', model: 'gpt-5-chat' }], stored)).resolves.toEqual({ ok: true });
  });
});

describe('resolvePlanStepModelsForLaunch', () => {
  const notAdmin = async () => false;
  it('returns the canonical id per step index, skipping steps with no model', async () => {
    const map = await resolvePlanStepModelsForLaunch(registry, notAdmin, [{ stepCount: 1 }, { stepCount: 2, model: 'legacy-alias' }, { stepCount: 3, model: 'gpt-5-chat' }]);
    expect([...map.entries()]).toEqual([[1, 'claude-sonnet-x'], [2, 'gpt-5-chat']]);
  });
  it('throws a StepModelUnavailableError naming the FIRST bad step, with the shared cause', async () => {
    const err: any = await resolvePlanStepModelsForLaunch(registry, notAdmin, [{ stepCount: 1, model: 'gpt-5-chat' }, { stepCount: 2, model: 'retired-9' }, { stepCount: 3, model: 'internal-judge' }]).catch((e) => e);
    expect(isStepModelUnavailableError(err)).toBe(true);
    expect(err.stepCount).toBe(2);
    expect(err.cause).toMatchObject({ code: 'model_unavailable', reason: 'not_served', requestedModel: 'retired-9' });
  });
  it('an adminOnly step model launches for an admin launcher only', async () => {
    await expect(resolvePlanStepModelsForLaunch(registry, async () => true, [{ stepCount: 1, model: 'admin-only-model' }])).resolves.toBeInstanceOf(Map);
    await expect(resolvePlanStepModelsForLaunch(registry, notAdmin, [{ stepCount: 1, model: 'admin-only-model' }])).rejects.toMatchObject({ stepCount: 1 });
  });
});

describe('plan write routes: round trip of step.model', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/work-plans', authenticateToken, isAdmin, adminWorkPlanRoutes);
  app.use('/api/user-work-plans', authenticateToken, userWorkPlanRoutes);

  const steps = (m1?: string, m2?: string) => [
    { stepCount: 1, title: 'One', description: 'd1', ...(m1 !== undefined && { model: m1 }) },
    { stepCount: 2, title: 'Two', description: 'd2', ...(m2 !== undefined && { model: m2 }) },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
    mockSwitch = true;
    mockUnknown = false;
    mockSwitchReads = 0;
    mockIsAdminCaller = true;
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: false });
  });

  describe.each([
    ['admin', '/api/admin/work-plans'],
    ['user', '/api/user-work-plans'],
  ])('%s routes', (_who, base) => {
    it('switch ON: create stores the (trimmed, canonical-validated) model; GET/PUT keep it', async () => {
      const created = await request(app).post(base).send({ title: 'T', steps: steps(' gpt-5-chat ', undefined) });
      expect(created.status).toBe(201);
      expect(created.body.steps[0].model).toBe('gpt-5-chat');
      expect('model' in created.body.steps[1]).toBe(false);
      expect(mockStore.get('new-plan').steps[0].model).toBe('gpt-5-chat');

      // an unrelated edit that re-sends the steps unchanged keeps the model
      const put = await request(app).put(`${base}/new-plan`).send({ title: 'T2', steps: steps('gpt-5-chat') });
      expect(put.status).toBe(200);
      expect(mockStore.get('new-plan').steps[0].model).toBe('gpt-5-chat');

      // change it
      const changed = await request(app).put(`${base}/new-plan`).send({ steps: steps('claude-sonnet-x', 'gpt-5-chat') });
      expect(changed.status).toBe(200);
      expect(mockStore.get('new-plan').steps.map((s: any) => s.model)).toEqual(['claude-sonnet-x', 'gpt-5-chat']);

      // a PUT with no steps leaves them (and their models) alone
      await request(app).put(`${base}/new-plan`).send({ title: 'T3' });
      expect(mockStore.get('new-plan').steps.map((s: any) => s.model)).toEqual(['claude-sonnet-x', 'gpt-5-chat']);
    });

    it('switch ON: a model that is not served / not selectable is a 422 model_unavailable naming the step, nothing written', async () => {
      for (const [model, reason] of [['retired-9', 'not_served'], ['internal-judge', 'not_selectable'], ['admin-only-model', 'not_selectable']] as const) {
        const res = await request(app).post(base).send({ title: 'T', steps: steps('gpt-5-chat', model) });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: 'model_unavailable', reason, requestedModel: model, stepCount: 2 });
      }
      expect(wps.createWorkPlan).not.toHaveBeenCalled();

      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: steps('gpt-5-chat') });
      const put = await request(app).put(`${base}/p1`).send({ steps: steps('gpt-5-chat', 'retired-9') });
      expect(put.status).toBe(422);
      expect(put.body).toMatchObject({ code: 'model_unavailable', stepCount: 2 });
      expect(wps.updateWorkPlan).not.toHaveBeenCalled();
    });

    it('switch ON: an UNCHANGED stored (since retired) step model does not block an unrelated edit', async () => {
      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: steps('retired-9') });
      const res = await request(app).put(`${base}/p1`).send({ title: 'Renamed', steps: steps('retired-9') });
      expect(res.status).toBe(200);
      expect(mockStore.get('p1').steps[0].model).toBe('retired-9');
      // ...but moving the step to ANOTHER bad model is refused
      const bad = await request(app).put(`${base}/p1`).send({ steps: steps('other-retired') });
      expect(bad.status).toBe(422);
    });

    it('switch ON: a non-string model is reported in warnings and not stored', async () => {
      const res = await request(app).post(base).send({ title: 'T', steps: [{ title: 'a', model: { x: 1 } }] });
      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual(['step 1: ignored model — expected a string']);
      expect('model' in mockStore.get('new-plan').steps[0]).toBe(false);
    });

    it('switch OFF: create/update DROP the model (with a warning) and never validate it, even a retired one', async () => {
      mockSwitch = false;
      const created = await request(app).post(base).send({ title: 'T', steps: steps('retired-9', 'gpt-5-chat') });
      expect(created.status).toBe(201);
      expect(mockStore.get('new-plan').steps.every((s: any) => !('model' in s))).toBe(true);
      expect(created.body.warnings).toEqual([
        'step 1: ignored model — per-step models are not enabled',
        'step 2: ignored model — per-step models are not enabled',
      ]);
      const put = await request(app).put(`${base}/new-plan`).send({ steps: steps('retired-9') });
      expect(put.status).toBe(200);
      expect('model' in mockStore.get('new-plan').steps[0]).toBe(false);
    });

    it('switch OFF: a replace that no longer carries a model stored while the switch was ON is NOT refused as content loss', async () => {
      mockSwitch = false;
      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: steps('gpt-5-chat') });
      const res = await request(app).put(`${base}/p1`).send({ title: 'x', steps: steps() });
      expect(res.status).toBe(200);
    });

    it('steps without any model never read the switch (existing plans pay nothing)', async () => {
      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: steps() });
      await request(app).post(base).send({ title: 'T', steps: steps() });
      await request(app).put(`${base}/p1`).send({ steps: steps() });
      expect(mockSwitchReads).toBe(0);
    });
  });

  describe('admin-only behaviour', () => {
    it('switch ON: a replace that OMITS a stored step model is refused as content loss (a retired/blank edit cannot silently reset it)', async () => {
      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: steps('gpt-5-chat', 'claude-sonnet-x') });
      const res = await request(app).put('/api/admin/work-plans/p1').send({ steps: steps(undefined, 'claude-sonnet-x') });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('model');
      expect(wps.updateWorkPlan).not.toHaveBeenCalled();
    });

    it('merge mode: amending another field keeps the stored model; a model can be set and cleared (blank)', async () => {
      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'system', steps: steps('gpt-5-chat', undefined) });
      const amend = await request(app).put('/api/admin/work-plans/p1').send({ steps_mode: 'merge', steps: [{ stepCount: 1, description: 'new' }] });
      expect(amend.status).toBe(200);
      expect(mockStore.get('p1').steps[0]).toMatchObject({ description: 'new', model: 'gpt-5-chat' });

      const set = await request(app).put('/api/admin/work-plans/p1').send({ steps_mode: 'merge', steps: [{ stepCount: 2, model: 'claude-sonnet-x' }] });
      expect(set.status).toBe(200);
      expect(mockStore.get('p1').steps[1].model).toBe('claude-sonnet-x');

      const cleared = await request(app).put('/api/admin/work-plans/p1').send({ steps_mode: 'merge', steps: [{ stepCount: 1, model: '' }] });
      expect(cleared.status).toBe(200);
      expect('model' in mockStore.get('p1').steps[0]).toBe(false);
      expect(mockStore.get('p1').steps[1].model).toBe('claude-sonnet-x');

      const bad = await request(app).put('/api/admin/work-plans/p1').send({ steps_mode: 'merge', steps: [{ stepCount: 1, model: 'retired-9' }] });
      expect(bad.status).toBe(422);
      expect(bad.body.stepCount).toBe(1);
    });

    it('merge mode with the switch OFF: the stored model is preserved (nothing is "supplied") and a supplied one is ignored', async () => {
      mockSwitch = false;
      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'system', steps: steps('gpt-5-chat') });
      const res = await request(app).put('/api/admin/work-plans/p1').send({ steps_mode: 'merge', steps: [{ stepCount: 1, description: 'x', model: 'claude-sonnet-x' }] });
      expect(res.status).toBe(200);
      expect(mockStore.get('p1').steps[0]).toMatchObject({ description: 'x', model: 'gpt-5-chat' });
    });

    it('a system/public plan is launched by non-admins: an adminOnly step model is 422 (admin status does not apply)', async () => {
      const res = await request(app).post('/api/admin/work-plans').send({ title: 'T', visibility: 'system', steps: steps('admin-only-model') });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ reason: 'not_selectable', stepCount: 1 });
    });

    it('scope widening (private owned by an admin -> system) re-checks STORED step models as a non-admin launcher, even when steps are not sent', async () => {
      getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
      mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: steps('admin-only-model') });
      const res = await request(app).put('/api/admin/work-plans/p1').send({ visibility: 'system' });
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable', stepCount: 1 });
      expect(wps.updateWorkPlan).not.toHaveBeenCalled();
      // while it stays private + owned by that admin, the same stored model is fine
      const ok = await request(app).put('/api/admin/work-plans/p1').send({ title: 'x' });
      expect(ok.status).toBe(200);
    });
  });

  describe('user routes: adminOnly follows the plan OWNER', () => {
    it('a non-admin owner cannot pick an adminOnly step model; an admin owner (no org) can', async () => {
      const denied = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: steps('admin-only-model') });
      expect(denied.status).toBe(422);
      getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
      const ok = await request(app).post('/api/user-work-plans').send({ title: 'T', steps: steps('admin-only-model') });
      expect(ok.status).toBe(201);
      expect(mockStore.get('new-plan').steps[0].model).toBe('admin-only-model');
    });
  });
});

describe('applyPredefinedWorkPlan (launch / accept / scheduled launch core)', () => {
  const plan = (steps: any[], extra: any = {}) => ({ planId: 'plan-1', title: 'Client Onboarding', visibility: 'system', steps, ...extra });
  const S = (n: number, model?: any) => ({ stepCount: n, title: `S${n}`, skillIds: [], ...(model !== undefined && { model }) });

  beforeEach(() => {
    jest.clearAllMocks();
    mockSwitch = true;
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: false });
    db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [] } as any);
    db.updateSessionLlmModel.mockResolvedValue({} as any);
    db.updateSessionWorkPlan.mockResolvedValue({} as any);
  });
  const launch = (p: any, opts: any = {}, userId = 'user-1') => {
    candidates.mockResolvedValue([p]);
    return workPlansImpl.applyPredefinedWorkPlan('Client Onboarding', 's1', userId, opts, registry as any);
  };
  const expectNoState = () => {
    expect(db.updateSessionWorkPlan).not.toHaveBeenCalled();
    expect(db.addAssociatedSkills).not.toHaveBeenCalled();
    expect(db.updateCalledFunctions).not.toHaveBeenCalled();
    expect(db.updateSessionWorkPlanInputRequest).not.toHaveBeenCalled();
    expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
  };

  it('ON: every step model is validated, stored canonically on the session plan; steps without one are untouched', async () => {
    const r: any = await launch(plan([S(1, 'legacy-alias'), S(2), S(3, 'gpt-5-chat')]));
    expect(r.success).toBe(true);
    const stored = db.updateSessionWorkPlan.mock.calls[0][1].steps as any[];
    expect(stored.map((s) => s.model)).toEqual(['claude-sonnet-x', undefined, 'gpt-5-chat']);
    expect('model' in stored[1]).toBe(false);
    // no plan pin => the launch itself does not touch the session model (the engine sets it per step)
    expect(db.updateSessionLlmModel).not.toHaveBeenCalled();
  });

  it('ON: an unservable model on ANY step (here the last) refuses the whole launch with 422 data and writes NOTHING', async () => {
    const r: any = await launch(plan([S(1, 'gpt-5-chat'), S(2), S(3, 'retired-9')], { defaultModel: 'gpt-5-chat' }));
    expect(r.success).toBe(false);
    expect(r.errorType).toBe('model_unavailable');
    expect(r.modelUnavailable).toMatchObject({ code: 'model_unavailable', reason: 'not_served', requestedModel: 'retired-9', stepCount: 3 });
    expect(r.message).toContain('Do not retry');
    expectNoState();
  });

  it.each([
    ['internalOnly', 'internal-judge'],
    ['adminOnly (non-admin launcher)', 'admin-only-model'],
    ['non-string', { x: 1 }],
  ])('ON: %s step model refuses the launch', async (_l, model) => {
    const r: any = await launch(plan([S(1), S(2, model)]));
    expect(r.errorType).toBe('model_unavailable');
    expect(r.modelUnavailable.stepCount).toBe(2);
    expectNoState();
  });

  it('ON: adminOnly step model launches for an admin launcher', async () => {
    getUser.mockResolvedValue({ userId: 'user-1', isAdmin: true });
    const r: any = await launch(plan([S(1, 'admin-only-model')]));
    expect(r.success).toBe(true);
  });

  it('ON: a bad PLAN pin is still refused first (existing behaviour unchanged, no stepCount)', async () => {
    const r: any = await launch(plan([S(1, 'gpt-5-chat')], { defaultModel: 'retired-9' }));
    expect(r.errorType).toBe('model_unavailable');
    expect(r.modelUnavailable.stepCount).toBeUndefined();
    expectNoState();
  });

  it('ON, unattended (scheduled) launch: refused, nothing written, oncall alert names the step', async () => {
    const r: any = await launch(plan([S(1), S(2, 'retired-9')]), { isUnattendedRun: true });
    expect(r.errorType).toBe('model_unavailable');
    expectNoState();
    await new Promise((res) => setImmediate(res));
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][0]).toMatchObject({
      dedupeKey: 'workplan_model_invalid:plan-1:step2:retired-9',
      context: expect.objectContaining({ Step: '2' }),
    });
    expect(mockAlert.mock.calls[0][0].message).toContain('step 2 uses model "retired-9"');
  });

  it('ON, interactive launch does not page oncall', async () => {
    await launch(plan([S(1, 'retired-9')]));
    await new Promise((res) => setImmediate(res));
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('ON, anonymous visitor: the refusal names no model id, reason or step', async () => {
    const r: any = await launch(plan([S(1, 'retired-9')]), {}, 'anon_abc');
    expect(r.errorType).toBe('model_unavailable');
    expect(JSON.stringify(r)).not.toMatch(/retired-9|not_served|stepCount/);
    expectNoState();
  });

  it('OFF: the model is NOT copied to the session plan and is NOT validated (a retired one does not block the launch)', async () => {
    mockSwitch = false;
    const r: any = await launch(plan([S(1, 'retired-9'), S(2, 'gpt-5-chat')]));
    expect(r.success).toBe(true);
    const stored = db.updateSessionWorkPlan.mock.calls[0][1].steps as any[];
    expect(stored.every((s) => !('model' in s))).toBe(true);
  });

  it('plans with no step models behave exactly as before, on or off', async () => {
    for (const on of [true, false]) {
      mockSwitch = on;
      db.updateSessionWorkPlan.mockClear();
      const r: any = await launch(plan([S(1), S(2)]));
      expect(r.success).toBe(true);
      expect((db.updateSessionWorkPlan.mock.calls[0][1].steps as any[]).every((s) => !('model' in s))).toBe(true);
    }
  });

  it('records the plan default and the pre-plan session model so a model-less step has something to fall back to', async () => {
    db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [], llmModel: 'claude-sonnet-x' } as any);
    const r: any = await launch(plan([S(1, 'gpt-5-chat'), S(2)], { defaultModel: 'gpt-5-chat' }));
    expect(r.success).toBe(true);
    expect(db.updateSessionWorkPlan.mock.calls[0][1]).toMatchObject({ planDefaultModel: 'gpt-5-chat', launchModel: 'claude-sonnet-x' });
  });

  it("ENG-669: each pin is stamped at launch WITH its provenance (the plan's author): admin plan system, user plan user", async () => {
    db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [], llmModel: 'claude-sonnet-x' } as any);
    await launch(plan([S(1, 'gpt-5-chat'), S(2)], { defaultModel: 'gpt-5-chat' }));
    let wp = db.updateSessionWorkPlan.mock.calls[0][1] as any;
    expect(wp).toMatchObject({ planAuthor: 'system', planDefaultModel: 'gpt-5-chat', planDefaultModelSource: 'system' });
    expect(wp.steps.map((s: any) => `${s.model ?? '-'}:${s.modelSource ?? '-'}`)).toEqual(['gpt-5-chat:system', '-:-']);
    jest.clearAllMocks();
    db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [], llmModel: 'claude-sonnet-x' } as any);
    db.updateSessionWorkPlan.mockResolvedValue({} as any);
    await launch(plan([S(1, 'gpt-5-chat'), S(2)], { defaultModel: 'gpt-5-chat', visibility: 'private', ownerId: 'user-1' }));
    wp = db.updateSessionWorkPlan.mock.calls[0][1] as any;
    expect(wp).toMatchObject({ planAuthor: 'user', planDefaultModelSource: 'user' });
    expect(wp.steps[0]).toMatchObject({ model: 'gpt-5-chat', modelSource: 'user' });
  });

  it('a plan without step models records neither (unchanged session shape)', async () => {
    db.getChatSession.mockResolvedValue({ sessionId: 's1', messages: [], llmModel: 'claude-sonnet-x' } as any);
    await launch(plan([S(1), S(2)], { defaultModel: 'gpt-5-chat' }));
    const wp = db.updateSessionWorkPlan.mock.calls[0][1] as any;
    expect('launchModel' in wp).toBe(false);
    expect('planDefaultModel' in wp).toBe(false);
  });

  it('switch state UNKNOWN (settings outage): step models are still validated and copied; only a definite off ignores them', async () => {
    mockSwitch = false;
    mockUnknown = true;
    const bad: any = await launch(plan([S(1, 'retired-9')]));
    expect(bad.errorType).toBe('model_unavailable');
    const ok: any = await launch(plan([S(1, 'gpt-5-chat')]));
    expect(ok.success).toBe(true);
    expect((db.updateSessionWorkPlan.mock.calls[0][1].steps as any[])[0].model).toBe('gpt-5-chat');
  });
});

describe('private -> public transitions revalidate step models for NON-admin launchers (CodeRabbit)', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/work-plans', authenticateToken, isAdmin, adminWorkPlanRoutes);
  app.use('/api/user-work-plans', authenticateToken, userWorkPlanRoutes);
  const withModel = (visibility: string, model: string) => ({
    planId: 'p1', title: 'T', visibility, ownerId: 'user-1',
    steps: [{ stepCount: 1, title: 'One', description: 'd' }, { stepCount: 2, title: 'Two', description: 'd', model }],
  });
  const svc: any = workPlanService;
  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.clear();
    mockSwitch = true;
    mockUnknown = false;
    svc.submitForReview = jest.fn(async (id: string) => ({ ...mockStore.get(id), visibility: 'pending_review' }));
    svc.approveWorkPlan = jest.fn(async (id: string) => ({ ...mockStore.get(id), visibility: 'public' }));
  });

  it.each([
    ['submit', 'post', '/api/user-work-plans/p1/submit-for-review', 'private', () => svc.submitForReview],
    ['approve', 'post', '/api/admin/work-plans/p1/approve', 'pending_review', () => svc.approveWorkPlan],
  ] as const)('%s: an admin-only step model is refused with the shared 422 + stepCount and the plan state is unchanged', async (_n, _m, url, visibility, fn) => {
    mockIsAdminCaller = true;
    mockStore.set('p1', withModel(visibility, 'admin-only-model'));
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'model_unavailable', reason: 'not_selectable', requestedModel: 'admin-only-model', stepCount: 2 });
    expect(fn()).not.toHaveBeenCalled();
    expect(mockStore.get('p1').visibility).toBe(visibility);
  });

  it.each([
    ['submit', '/api/user-work-plans/p1/submit-for-review', 'private', () => svc.submitForReview],
    ['approve', '/api/admin/work-plans/p1/approve', 'pending_review', () => svc.approveWorkPlan],
  ] as const)('%s: a normal step model goes through', async (_n, url, visibility, fn) => {
    mockIsAdminCaller = true;
    mockStore.set('p1', withModel(visibility, 'gpt-5-chat'));
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(200);
    expect(fn()).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['submit', '/api/user-work-plans/p1/submit-for-review', 'private', () => svc.submitForReview],
    ['approve', '/api/admin/work-plans/p1/approve', 'pending_review', () => svc.approveWorkPlan],
  ] as const)('%s: switch OFF ignores stored step models (no refusal); UNKNOWN still validates them', async (_n, url, visibility, fn) => {
    mockIsAdminCaller = true;
    mockStore.set('p1', withModel(visibility, 'admin-only-model'));
    mockSwitch = false;
    expect((await request(app).post(url).send({})).status).toBe(200);
    fn().mockClear();
    mockUnknown = true;
    const res = await request(app).post(url).send({});
    expect(res.status).toBe(422);
    expect(fn()).not.toHaveBeenCalled();
  });

  it('a plan with no step models never reads the switch on these transitions', async () => {
    mockIsAdminCaller = true;
    mockStore.set('p1', { planId: 'p1', title: 'T', visibility: 'private', ownerId: 'user-1', steps: [{ stepCount: 1, title: 'One' }] });
    mockSwitchReads = 0;
    expect((await request(app).post('/api/user-work-plans/p1/submit-for-review').send({})).status).toBe(200);
    expect(mockSwitchReads).toBe(0);
  });

  it('submit by a non-owner still gets the service\'s own refusal (no early 422 leak of someone else\'s step models)', async () => {
    mockStore.set('p1', { ...withModel('private', 'admin-only-model'), ownerId: 'someone-else' });
    svc.submitForReview = jest.fn(async () => { throw new Error('Not authorized'); });
    const res = await request(app).post('/api/user-work-plans/p1/submit-for-review').send({});
    expect(res.status).toBe(403);
  });
});

describe('buildStepModelPausedMessage (ENG-669)', () => {
  it("a step model outside the plan is worded for whoever reads the chat (owner or share viewer): never 'your plan'", () => {
    const text = buildStepModelPausedMessage(2, 'GPT-5.5', 'not_in_plan');
    expect(text).toContain("Step 2 uses GPT-5.5, which isn't included in this account's plan.");
    expect(text).not.toContain('your plan');
  });
  it('an unavailable model keeps its wording', () => {
    expect(buildStepModelPausedMessage(1, 'X', 'not_served')).toContain('Step 1 uses X, which is no longer available.');
  });
});
