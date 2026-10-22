/**
 * ENG-903: a schedule's model pin (llmModel / llmBackupModel) is validated at the WRITE
 * site with the picker/resolver rules, so a bad pin is a 422 `model_unavailable` at
 * create/update time instead of a failed run + oncall alert later.
 */
import { Request, Response } from 'express';

jest.mock('../services/subscriptionService', () => ({
  getAllowedFunctionCalls: jest.fn(async () => []),
  isSubscriptionFeatureEnabled: jest.fn(async () => true),
  // ENG-669: the owner's tier for the model allowlist.
  getUserSubscriptionResolution: jest.fn(async () => ({ subscriptionType: 'Free', resolved: true })),
  readTierAllowedModels: jest.fn(async (tier: string) => (tier === 'Free' ? { configured: true, allowedModels: ['gemini-3.5-flash'] } : { configured: false })),
}));
// ENG-669: AW-Settings rows by name; the tier-allowlist switch is off unless a test sets it.
const mockSettings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (mockSettings[name] === undefined ? null : { settingName: name, settingValue: mockSettings[name] })),
  },
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: { getChatSession: jest.fn() },
}));

type Cfg = { name: string; internalOnly?: boolean; adminOnly?: boolean; isLive?: boolean };
const REGISTRY: Record<string, Cfg> = {
  'gpt-5-chat-2': { name: 'GPT 5 Chat 2' },
  'anthropic.claude-sonnet-5': { name: 'Sonnet 5' },
  // ENG-669: the one model the test Free tier lists (not the default, so "allowed" is proven on its own).
  'gemini-3.5-flash': { name: 'Gemini 3.5 Flash' },
  'anthropic.claude-opus-4-8': { name: 'Opus 4.8', adminOnly: true },
  'internal-model': { name: 'Internal', internalOnly: true },
  'live-voice': { name: 'Live', isLive: true },
};
const ALIASES: Record<string, string> = { 'claude-sonnet-5': 'anthropic.claude-sonnet-5', 'legacy-internal': 'internal-model' };

jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    default_model: 'gpt-5-chat-2',
    getDefaultModel: jest.fn(async () => 'gpt-5-chat-2'),
    getScheduledChatsDefaultModel: jest.fn(async () => 'gpt-5-chat-2'),
    getSupportedModels: jest.fn(async (isAdmin: boolean) =>
      Object.keys(REGISTRY).filter((m) => !REGISTRY[m].internalOnly && (isAdmin || !REGISTRY[m].adminOnly))),
    getModelDisplayName: jest.fn((id: string) => REGISTRY[id]?.name),
    resolveGenerationModel: jest.fn((model: string) => {
      const n = ALIASES[model] ?? model;
      if (Object.prototype.hasOwnProperty.call(REGISTRY, n)) return { model: n, fellBack: false, requestedModel: model };
      return { model: 'gpt-5-chat-2', fellBack: true, requestedModel: model };
    }),
    isModelSelectableBy: jest.fn((id: string, isAdmin: boolean) => {
      const c = REGISTRY[id];
      if (!c || c.internalOnly || c.isLive) return false;
      return !(c.adminOnly && !isAdmin);
    }),
  },
}));

jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    createSchedule: jest.fn(),
    updateSchedule: jest.fn(),
  },
  userDb: { getUserById: jest.fn() },
  scheduleTemplateDb: { getTemplateById: jest.fn(), updateTemplate: jest.fn() },
}));

import { scheduleDb, userDb, scheduleTemplateDb } from '../services/db';
import { agentModeController } from '../controllers/agentModeController';
import { modelAccess } from '../services/agentMode/modelAccessInstance';

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;
const mockUserDb = userDb as jest.Mocked<typeof userDb>;

const USER = 'u1';
const makeRes = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis() }) as unknown as Response & { json: jest.Mock; status: jest.Mock };
const base = { scheduleName: 'S', startingMessage: 'Hi', scheduleFrequency: 'daily' };
const create = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await agentModeController.createScheduledChat({ user: { userId: USER }, body: { ...base, ...body } } as unknown as Request, res);
  return res;
};
const update = async (body: Record<string, unknown>) => {
  const res = makeRes();
  await agentModeController.updateScheduledChat(
    { user: { userId: USER }, params: { scheduleId: 's1' }, body } as unknown as Request, res);
  return res;
};
const stored = (extra: Record<string, unknown> = {}) => ({
  scheduleId: 's1', userId: USER, scheduleName: 'S', startingMessage: 'Hi', frequency: 'daily',
  nextRunTime: '2030-01-01T00:00:00.000Z', llmModel: '', ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockSettings)) delete mockSettings[key];
  modelAccess.reset();
  mockUserDb.getUserById.mockResolvedValue({ userId: USER, isAdmin: false } as any);
  mockScheduleDb.createSchedule.mockResolvedValue(undefined as any);
  mockScheduleDb.updateSchedule.mockResolvedValue(undefined as any);
});

const expect422 = (res: any, requested: string, reason: string) => {
  expect(res.status).toHaveBeenCalledWith(422);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_unavailable', requestedModel: requested, reason }));
};

describe('createScheduledChat model pin', () => {
  it.each([
    ['unserved', 'gpt-4-retired', 'not_served'],
    ['internalOnly', 'internal-model', 'not_selectable'],
    ['live-voice', 'live-voice', 'not_selectable'],
    ['adminOnly for a non-admin', 'anthropic.claude-opus-4-8', 'not_selectable'],
  ])('rejects %s llmModel with 422 and writes nothing', async (_n, model, reason) => {
    const res = await create({ llmModel: model });
    expect422(res, model, reason);
    expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
  });

  it('rejects a non-string llmModel', async () => {
    const res = await create({ llmModel: ['gpt-5-chat-2'] });
    expect(res.status).toHaveBeenCalledWith(422);
    expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
  });

  it('accepts adminOnly for an admin', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: USER, isAdmin: true } as any);
    await create({ llmModel: 'anthropic.claude-opus-4-8' });
    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'anthropic.claude-opus-4-8' }));
  });

  it('still rejects internalOnly for an admin', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: USER, isAdmin: true } as any);
    expect422(await create({ llmModel: 'internal-model' }), 'internal-model', 'not_selectable');
  });

  it('stores a trimmed valid id, the canonical id for an honoured alias, and no pin for empty/absent', async () => {
    await create({ llmModel: '  gpt-5-chat-2  ' });
    await create({ llmModel: 'claude-sonnet-5' });
    await create({ llmModel: '' });
    await create({});
    const models = mockScheduleDb.createSchedule.mock.calls.map((c) => (c[0] as any).llmModel);
    expect(models).toEqual(['gpt-5-chat-2', 'anthropic.claude-sonnet-5', '', '']);
  });

  it('validates llmBackupModel too (422, nothing written)', async () => {
    expect422(await create({ llmBackupModel: 'gpt-4-retired' }), 'gpt-4-retired', 'not_served');
    expect422(await create({ llmBackupModel: 'internal-model' }), 'internal-model', 'not_selectable');
    expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
  });

  it('accepts a valid backup model', async () => {
    await create({ llmBackupModel: 'anthropic.claude-sonnet-5' });
    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ llmBackupModel: 'anthropic.claude-sonnet-5' }));
  });
});

describe('updateScheduledChat model pin', () => {
  it('rejects setting a different unserved model', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-5-chat-2' }) as any);
    expect422(await update({ llmModel: 'gpt-4-retired' }), 'gpt-4-retired', 'not_served');
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('rejects setting adminOnly for a non-admin but allows it for an admin', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    expect422(await update({ llmModel: 'anthropic.claude-opus-4-8' }), 'anthropic.claude-opus-4-8', 'not_selectable');
    mockUserDb.getUserById.mockResolvedValue({ userId: USER, isAdmin: true } as any);
    const res = await update({ llmModel: 'anthropic.claude-opus-4-8' });
    expect(res.status).not.toHaveBeenCalledWith(422);
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith('s1', expect.objectContaining({ llmModel: 'anthropic.claude-opus-4-8' }), ...[] as any);
  });

  it('compat: absent or unchanged retired model does not block an unrelated edit', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-4-retired' }) as any);
    const absent = await update({ scheduleName: 'Renamed' });
    expect(absent.status).not.toHaveBeenCalledWith(422);
    const same = await update({ scheduleName: 'Renamed 2', llmModel: 'gpt-4-retired' });
    expect(same.status).not.toHaveBeenCalledWith(422);
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
  });

  it('changing away from a retired model to a valid one works; to a different bad one is rejected', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-4-retired' }) as any);
    expect422(await update({ llmModel: 'gpt-4-other' }), 'gpt-4-other', 'not_served');
    await update({ llmModel: 'gpt-5-chat-2' });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect((mockScheduleDb.updateSchedule.mock.calls[0][1] as any).llmModel).toBe('gpt-5-chat-2');
  });

  it("'' clears the pin without validation", async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-4-retired' }) as any);
    const res = await update({ llmModel: '' });
    expect(res.status).not.toHaveBeenCalledWith(422);
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-string llmModel', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored() as any);
    const res = await update({ llmModel: { id: 'x' } });
    expect(res.status).toHaveBeenCalledWith(422);
  });

  it('backup: set-to-bad rejected; unchanged retired backup allowed; clear allowed', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      stored({ llmBackupModel: 'gpt-4-retired', llmBackupSource: 'user', llmBackupNeedsConfirmation: false }) as any);
    expect422(await update({ llmBackupModel: 'internal-model' }), 'internal-model', 'not_selectable');
    expect(mockScheduleDb.updateSchedule).not.toHaveBeenCalled();
    const same = await update({ llmBackupModel: 'gpt-4-retired', scheduleName: 'R' });
    expect(same.status).not.toHaveBeenCalledWith(422);
    expect(same.status).not.toHaveBeenCalledWith(400);
    const cleared = await update({ llmBackupModel: '' });
    expect(cleared.status).not.toHaveBeenCalledWith(422);
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(2);
  });
});

describe('updateScheduledChat model pin normalisation (CodeRabbit)', () => {
  const written = () => mockScheduleDb.updateSchedule.mock.calls[0][1] as any;
  const removed = () => mockScheduleDb.updateSchedule.mock.calls[0][4] as any;

  it('writes the TRIMMED value when a padded copy of the stored model is re-sent', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-4-retired' }) as any);
    await update({ llmModel: ' gpt-4-retired ' });
    expect(written().llmModel).toBe('gpt-4-retired');
  });

  it('treats a whitespace-only llmModel as an explicit clear (same as empty)', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-5-chat-2' }) as any);
    await update({ llmModel: '   ' });
    expect(written().llmModel).toBeUndefined();
    expect(removed()).toEqual(expect.arrayContaining(['llmModel']));
  });

  it('treats explicit null llmModel as omitted: never writes null, never clears', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-5-chat-2' }) as any);
    const res = await update({ llmModel: null, scheduleName: 'R' });
    expect(res.status).not.toHaveBeenCalledWith(422);
    expect('llmModel' in written()).toBe(false);
    expect(removed() || []).not.toContain('llmModel');
  });

  it('backup: padded value is stored trimmed; whitespace-only clears', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(
      stored({ llmBackupModel: 'gpt-5-chat-2', llmBackupSource: 'user', llmBackupNeedsConfirmation: false }) as any);
    await update({ llmBackupModel: ' anthropic.claude-sonnet-5 ' });
    expect(written().llmBackupModel).toBe('anthropic.claude-sonnet-5');
    mockScheduleDb.updateSchedule.mockClear();
    await update({ llmBackupModel: '   ' });
    expect(written().llmBackupModel).toBe('');
  });
});

describe('canonical id storage for schedule pins', () => {
  it('create: alias resolving to a non-selectable model is still 422', async () => {
    expect422(await create({ llmModel: 'legacy-internal' }), 'legacy-internal', 'not_selectable');
    expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
  });
  it('update: alias in => canonical written', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-5-chat-2' }) as any);
    await update({ llmModel: 'claude-sonnet-5' });
    expect((mockScheduleDb.updateSchedule.mock.calls[0][1] as any).llmModel).toBe('anthropic.claude-sonnet-5');
  });
  it('update: unchanged stored alias resent is tolerated and not rewritten', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'claude-sonnet-5' }) as any);
    await update({ llmModel: ' claude-sonnet-5 ' });
    expect((mockScheduleDb.updateSchedule.mock.calls[0][1] as any).llmModel).toBe('claude-sonnet-5');
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
  });
  it('create: backup alias stored canonical', async () => {
    await create({ llmBackupModel: 'claude-sonnet-5' });
    const arg = mockScheduleDb.createSchedule.mock.calls[0]?.[0] as any;
    expect(arg?.llmBackupModel).toBe('anthropic.claude-sonnet-5');
  });
});

describe('createScheduleFromTemplate override semantics (CodeRabbit)', () => {
  const tpl = { templateId: 't1', visibility: 'system', name: 'T', startingMessage: 'Hi', suggestedFrequency: 'daily',
    llmModel: 'gpt-5-chat-2', variables: [] };
  const fromTemplate = async (body: Record<string, unknown>) => {
    const res = makeRes();
    await (agentModeController as any).createScheduleFromTemplate(
      { user: { userId: USER, email: 'a@b.c' }, params: { templateId: 't1' }, body: { scheduleName: 'S', ...body } } as unknown as Request, res);
    return res;
  };
  beforeEach(() => { (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(tpl); });
  const model = () => (mockScheduleDb.createSchedule.mock.calls[0][0] as any).llmModel;

  it('omitted override inherits the template pin', async () => {
    await fromTemplate({});
    expect(model()).toBe('gpt-5-chat-2');
  });
  it.each([[''], ['   ']])('explicit %j override produces an UNPINNED schedule', async (v) => {
    await fromTemplate({ llmModel: v });
    expect(model()).toBe('');
  });
  it('a valid override wins, trimmed', async () => {
    await fromTemplate({ llmModel: ' anthropic.claude-sonnet-5 ' });
    expect(model()).toBe('anthropic.claude-sonnet-5');
  });
  it('explicit empty backup override stays unpinned', async () => {
    await fromTemplate({ llmBackupModel: '' });
    expect((mockScheduleDb.createSchedule.mock.calls[0][0] as any).llmBackupModel).toBe('');
  });
});

/**
 * ENG-669 PR-A: a schedule pin (and backup) is the OWNER's selection, so with the tier allowlist on it must be in the
 * owner's plan: refused at write time (422 not_in_plan). An UNCHANGED stored pin stays editable (the run itself is
 * gated: runScheduledChat resolves the pin without a silent swap).
 */
describe('ENG-669 tier model allowlist on schedule pins', () => {
  const NOT_IN_PLAN = 'anthropic.claude-sonnet-5';
  beforeEach(() => {
    mockSettings.model_tier_allowlist_enabled = 'true';
    mockSettings.subscription_types = JSON.stringify([{ name: 'Free', allowedModels: ['gpt-5-chat-2'] }, { name: 'Pro', allowedModels: ['*'] }]);
  });

  it('create: a pin (or an alias of one) outside the plan is a 422 with the plan details; nothing written', async () => {
    for (const llmModel of [NOT_IN_PLAN, 'claude-sonnet-5']) {
      const res = await create({ llmModel });
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'model_unavailable', reason: 'not_in_plan', requestedModel: llmModel,
        model: NOT_IN_PLAN, tier: 'Free', allowedModels: ['gemini-3.5-flash'], upgradeRequired: ['Pro'],
      }));
    }
    expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
  });

  it('create: the backup is checked too; a pin the plan lists is stored', async () => {
    expect((await create({ llmBackupModel: NOT_IN_PLAN })).status).toHaveBeenCalledWith(422);
    expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    await create({ llmModel: 'gemini-3.5-flash' });
    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gemini-3.5-flash' }));
  });

  it('create: the configured default is not listed but is a system model, so it is stored too', async () => {
    await create({ llmModel: 'gpt-5-chat-2' });
    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ llmModel: 'gpt-5-chat-2' }));
  });

  it('an admin owner bypasses the allowlist', async () => {
    mockUserDb.getUserById.mockResolvedValue({ userId: USER, isAdmin: true } as any);
    await create({ llmModel: NOT_IN_PLAN });
    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ llmModel: NOT_IN_PLAN }));
  });

  it('update: an UNCHANGED stored pin outside the plan stays editable; changing TO one is a 422', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: NOT_IN_PLAN }) as any);
    expect((await update({ scheduleName: 'Renamed', llmModel: NOT_IN_PLAN })).status).not.toHaveBeenCalledWith(422);
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);

    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: 'gpt-5-chat-2' }) as any);
    const changed = await update({ llmModel: NOT_IN_PLAN });
    expect(changed.status).toHaveBeenCalledWith(422);
    expect(changed.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'not_in_plan' }));
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
  });

  describe('createScheduleFromTemplate (review MAJOR 2)', () => {
    const fromTemplate = async (tpl: Record<string, unknown>, body: Record<string, unknown> = {}) => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({
        templateId: 't1', name: 'T', startingMessage: 'Hi', suggestedFrequency: 'daily', variables: [], ...tpl,
      });
      const res = makeRes();
      await (agentModeController as any).createScheduleFromTemplate(
        { user: { userId: USER, email: 'a@b.c' }, params: { templateId: 't1' }, body: { scheduleName: 'S', ...body } } as unknown as Request, res);
      return res;
    };

    it("an admin-authored (system) template's pin is inherited as a SYSTEM model: stored with llmModelSource 'system'", async () => {
      const res = await fromTemplate({ visibility: 'system', llmModel: NOT_IN_PLAN });
      expect(res.status).not.toHaveBeenCalledWith(422);
      expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ llmModel: NOT_IN_PLAN, llmModelSource: 'system' }));
    });

    it("a user-authored template's pin outside the plan is a 422 at creation (not a failed run later); nothing written", async () => {
      for (const visibility of ['private', 'public']) {
        const res = await fromTemplate({ visibility, createdBy: USER, llmModel: NOT_IN_PLAN });
        expect(res.status).toHaveBeenCalledWith(422);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'model_unavailable', reason: 'not_in_plan' }));
      }
      expect(mockScheduleDb.createSchedule).not.toHaveBeenCalled();
    });

    it("a user-authored template's pin the plan lists is inherited as the owner's pin (no system origin)", async () => {
      await fromTemplate({ visibility: 'private', createdBy: USER, llmModel: 'gemini-3.5-flash' });
      const created = mockScheduleDb.createSchedule.mock.calls[0][0] as any;
      expect(created.llmModel).toBe('gemini-3.5-flash');
      expect(created).not.toHaveProperty('llmModelSource');
    });

    it('an explicit override is the owner\'s pin even on a system template', async () => {
      expect((await fromTemplate({ visibility: 'system', llmModel: 'gemini-3.5-flash' }, { llmModel: NOT_IN_PLAN })).status)
        .toHaveBeenCalledWith(422);
    });
  });

  describe('updateScheduleTemplate on a system template (review NIT 4)', () => {
    const systemTemplate = { templateId: 't1', createdBy: USER, visibility: 'system', name: 'T', startingMessage: 'Hi', llmModel: NOT_IN_PLAN };
    const updateTemplate = async (body: Record<string, unknown>, user: Record<string, unknown> = { userId: USER }) => {
      (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue(systemTemplate);
      const res = makeRes();
      await (agentModeController as any).updateScheduleTemplate(
        { user, params: { templateId: 't1' }, body } as unknown as Request, res);
      return res;
    };

    it("its non-admin creator cannot change the model: schedules from it inherit the pin as a system model (403)", async () => {
      const res = await updateTemplate({ llmModel: 'gemini-3.5-flash' });
      expect(res.status).toHaveBeenCalledWith(403);
      expect(scheduleTemplateDb.updateTemplate).not.toHaveBeenCalled();
    });

    it('re-sending the stored model (a full-object PUT) is not a change', async () => {
      const res = await updateTemplate({ name: 'Renamed', llmModel: ` ${NOT_IN_PLAN} ` });
      expect(res.status).not.toHaveBeenCalledWith(403);
    });

    it('not a change: an alias of the stored model, or any spelling of "no model" on a template without one', async () => {
      expect((await updateTemplate({ llmModel: 'claude-sonnet-5' })).status).not.toHaveBeenCalledWith(403); // alias of NOT_IN_PLAN
      for (const llmModel of [null, '', '   ']) {
        (scheduleTemplateDb.getTemplateById as jest.Mock).mockResolvedValue({ ...systemTemplate, llmModel: undefined });
        const res = makeRes();
        await (agentModeController as any).updateScheduleTemplate(
          { user: { userId: USER }, params: { templateId: 't1' }, body: { llmModel } } as unknown as Request, res);
        expect(res.status).not.toHaveBeenCalledWith(403);
      }
    });

    it('fail closed: clearing the stored model, or a non-string value, is a change (403)', async () => {
      expect((await updateTemplate({ llmModel: null })).status).toHaveBeenCalledWith(403);
      expect((await updateTemplate({ llmModel: 42 })).status).toHaveBeenCalledWith(403);
      expect(scheduleTemplateDb.updateTemplate).not.toHaveBeenCalled();
    });

    it('an administrator may change it', async () => {
      const res = await updateTemplate({ llmModel: 'gemini-3.5-flash' }, { userId: USER, isAdmin: true });
      expect(res.status).not.toHaveBeenCalledWith(403);
      expect(scheduleTemplateDb.updateTemplate).toHaveBeenCalled();
    });
  });

  it('update: changing the pin of a schedule inherited from a system template records it as the owner\'s', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(stored({ llmModel: NOT_IN_PLAN, llmModelSource: 'system' }) as any);
    await update({ llmModel: 'gemini-3.5-flash' });
    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledWith('s1', expect.objectContaining({ llmModel: 'gemini-3.5-flash', llmModelSource: 'user' }), ...[] as any);
  });

  it('switch off: the same pin is accepted exactly as before', async () => {
    delete mockSettings.model_tier_allowlist_enabled;
    modelAccess.reset();
    await create({ llmModel: NOT_IN_PLAN });
    expect(mockScheduleDb.createSchedule).toHaveBeenCalledWith(expect.objectContaining({ llmModel: NOT_IN_PLAN }));
  });
});
