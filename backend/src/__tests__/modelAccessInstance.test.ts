/**
 * ENG-669 PR-A: the process-wide wiring (services/agentMode/modelAccessInstance.ts).
 *  - SYSTEM models (AgentWeb's choice, not the user's) are never refused: the configured default everywhere, the
 *    session kind's configured default, an admin-authored plan's pins. A user plan's pins are not system models.
 *  - an unreadable tier with nothing known allows the model and pages on-call exactly ONCE (deduped).
 *  - Compare D3: fewer than two runnable models => blocked with upgradeRequired.
 */
const settings: Record<string, string | undefined> = {};
jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn(async (name: string) => (settings[name] === undefined ? null : { settingName: name, settingValue: settings[name] })),
  },
}));
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn() } }));
jest.mock('../services/subscriptionService', () => ({
  getUserSubscriptionResolution: jest.fn(),
  readTierAllowedModels: jest.fn(),
}));
jest.mock('../services/workPlanService', () => ({ workPlanService: { getWorkPlan: jest.fn() } }));
jest.mock('../services/emailService', () => ({ emailService: { sendOncallAlert: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSessionRecord: jest.fn() } }));
jest.mock('../services/agentModeService', () => {
  const registry = new Set(['default-model', 'sched-model', 'report-model', 'report-gen-model', 'image-model', 'video-model', 'cs-model', 'plan-pin', 'step-pin', 'gpt-5.5', 'gemini-3.5-flash', 'live-1']);
  return {
    agentModeService: {
      getDefaultModel: jest.fn(async () => 'default-model'),
      getScheduledChatsDefaultModel: jest.fn(async () => 'sched-model'),
      getReportsModel: jest.fn(async () => 'report-model'),
      getReportGenerationDefaultModel: jest.fn(async () => 'report-gen-model'),
      getImageGenerationDefaultModel: jest.fn(async () => 'image-model'),
      getVideoGenerationDefaultModel: jest.fn(async () => 'video-model'),
      getCustomerSupportDefaultModel: jest.fn(async () => 'cs-model'),
      getSupportedModels: jest.fn(async () => ['default-model', 'gpt-5.5', 'gemini-3.5-flash', 'live-1']),
      isLiveModel: jest.fn((id: string) => id === 'live-1'),
      resolveGenerationModel: jest.fn((model: string) => (registry.has(model)
        ? { model, fellBack: false, requestedModel: model }
        : { model: 'default-model', fellBack: true, requestedModel: model })),
    },
  };
});

import { getTierCompareBlock, isSystemChosen, legacyPlanPinSource, modelAccess, storedBindingSource } from '../services/agentMode/modelAccessInstance';
import { userDb } from '../services/db';
import { readTierAllowedModels, getUserSubscriptionResolution } from '../services/subscriptionService';
import { workPlanService } from '../services/workPlanService';
import { emailService } from '../services/emailService';

const mockGetUser = userDb.getUserById as jest.Mock;
const mockResolution = getUserSubscriptionResolution as jest.Mock;
const mockTierConfig = readTierAllowedModels as jest.Mock;
const mockGetWorkPlan = workPlanService.getWorkPlan as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  modelAccess.reset();
  for (const key of Object.keys(settings)) delete settings[key];
  settings.model_tier_allowlist_enabled = 'true';
  mockGetUser.mockResolvedValue({ isAdmin: false });
  mockResolution.mockResolvedValue({ subscriptionType: 'Free', resolved: true });
  mockTierConfig.mockResolvedValue({ configured: true, allowedModels: ['agentweb-model'] });
});

/**
 * ENG-669: the ONE exemption (besides an admin owner): provenance recorded WITH the model when it was written says
 * AgentWeb chose it, or the model is the configured default for the session's kind. Nothing is inferred at check time
 * from a session's plan or template; the only template read is the one legacy rule for plans launched before the record.
 */
describe('isSystemChosen', () => {
  it('recorded provenance decides: system is exempt, user and unrecorded are not', async () => {
    expect(await isSystemChosen('gpt-5.5', 'system')).toBe(true);
    expect(await isSystemChosen('gpt-5.5', 'user')).toBe(false);
    expect(await isSystemChosen('gpt-5.5', undefined)).toBe(false);
  });

  it('the configured default is exempt everywhere, whatever the recorded source', async () => {
    expect(await isSystemChosen('default-model', 'user', null)).toBe(true);
    expect(await isSystemChosen('default-model', undefined, { sessionType: 'regular' })).toBe(true);
  });

  it.each([
    [{ sessionType: 'scheduled' }, 'sched-model'],
    [{ sessionType: 'report_generation' }, 'report-model'],
    [{ sessionType: 'report_generation' }, 'report-gen-model'],
    [{ sessionType: 'image-generation' }, 'image-model'],
    [{ sessionType: 'video-generation' }, 'video-model'],
    [{ sessionType: 'regular', portalType: 'emma-sidebar' }, 'cs-model'],
  ])('%p: its configured default %s is exempt there (AgentWeb\'s stamp, or a legacy one), and only there', async (session, model) => {
    expect(await isSystemChosen(model, 'system', session)).toBe(true);
    expect(await isSystemChosen(model, undefined, session)).toBe(true);
    expect(await isSystemChosen(model, undefined, { sessionType: 'regular', portalType: 'agent' })).toBe(false);
  });

  it.each([
    [{ sessionType: 'scheduled' }, 'sched-model'],
    [{ sessionType: 'report_generation' }, 'report-model'],
    [{ sessionType: 'report_generation' }, 'report-gen-model'],
    [{ sessionType: 'image-generation' }, 'image-model'],
    [{ sessionType: 'video-generation' }, 'video-model'],
    [{ sessionType: 'regular', portalType: 'emma-sidebar' }, 'cs-model'],
  ])('#3607 follow-up 1, %p: a USER\'s pick of its configured default %s is checked like any pick', async (session, model) => {
    expect(await isSystemChosen(model, 'user', session)).toBe(false);
  });

  it('the interactive configured default stays exempt for a user pick in every kind of session', async () => {
    for (const session of [{ sessionType: 'scheduled' }, { sessionType: 'image-generation' }, { sessionType: 'regular', portalType: 'emma-sidebar' }]) {
      expect(await isSystemChosen('default-model', 'user', session)).toBe(true);
    }
  });

  it("no check-time inference: a session's plan pins or template exempt nothing on their own", async () => {
    mockGetWorkPlan.mockResolvedValue({ visibility: 'system', isBuiltIn: true, defaultModel: 'plan-pin', steps: [{ model: 'step-pin' }] });
    const session = {
      llmModel: 'plan-pin', // a legacy stamp with no source and no decision (review F1: no longer exempt)
      workPlan: { templatePlanId: 'plan-1', planAuthor: 'system', steps: [{ model: 'step-pin' }] },
    };
    expect(await isSystemChosen('plan-pin', undefined, session)).toBe(false);
    expect(await isSystemChosen('step-pin', undefined, session)).toBe(false);
    expect(mockGetWorkPlan).not.toHaveBeenCalled();
  });
});

describe("storedBindingSource: the session's OWN stamp", () => {
  const canonical = (id: string) => (id === 'alias-5.5' ? 'gpt-5.5' : id);
  it('re-sending or re-selecting the stored model (any spelling) carries its recorded provenance; anything else is a user pick', async () => {
    const session = { llmModel: 'gpt-5.5', llmModelSource: 'system' as const };
    expect(await storedBindingSource(session, 'gpt-5.5', canonical)).toBe('system');
    expect(await storedBindingSource(session, 'alias-5.5', canonical)).toBe('system');
    expect(await storedBindingSource(session, 'gemini-3.5-flash', canonical)).toBe('user');
    expect(await storedBindingSource({ llmModel: 'gpt-5.5', llmModelSource: 'user' }, 'gpt-5.5', canonical)).toBe('user');
    expect(await storedBindingSource(null, 'gpt-5.5', canonical)).toBe('user');
  });
  it('legacy stamps (no source) follow the one session rule: a defaulted/corrected decision or a side channel is system', async () => {
    expect(await storedBindingSource({ llmModel: 'gpt-5.5', llmUsagePolicyDecision: { effectiveModel: 'gpt-5.5', modelSelection: 'corrected' } }, 'gpt-5.5', canonical)).toBe('system');
    expect(await storedBindingSource({ llmModel: 'gpt-5.5', slackThread: { channel: 'C' } }, 'gpt-5.5', canonical)).toBe('system');
    // Nothing says who chose it: none recorded (checked like a pick, except as the session kind's default).
    expect(await storedBindingSource({ llmModel: 'gpt-5.5' }, 'gpt-5.5', canonical)).toBeUndefined();
    expect(await storedBindingSource({ llmModel: 'gpt-5.5', llmUsagePolicyDecision: { effectiveModel: 'gpt-5.5', modelSelection: 'honored' } }, 'gpt-5.5', canonical))
      .toBeUndefined();
  });

  it('#3607 follow-up 1: the session kind\'s default STORED on the session stays AgentWeb\'s whatever its record; a new pick of it does not', async () => {
    const legacy = { sessionType: 'scheduled', llmModel: 'sched-model' };
    const check = async (session: any, model: string) => isSystemChosen(model, await storedBindingSource(session, model, (id) => id), session);
    expect(await check(legacy, 'sched-model')).toBe(true);
    expect(await check({ ...legacy, llmModelSource: 'system' }, 'sched-model')).toBe(true);
    // Recorded 'user': since 2026-10-19 the portal's per-turn echo of a legacy stamp records exactly this, so the
    // record cannot tell AgentWeb's stamp from a pick; the stored kind default keeps running.
    expect(await check({ ...legacy, llmModelSource: 'user' }, 'sched-model')).toBe(true);
    // The picker PATCH to the kind's default from another model: a new pick.
    expect(await check({ sessionType: 'scheduled', llmModel: 'gpt-5.5', llmModelSource: 'system' }, 'sched-model')).toBe(false);
  });

  it("legacy plan session: the engine's unsourced stamp of the plan's OWN pin follows the plan-pin legacy rule; another model does not", async () => {
    mockGetWorkPlan.mockResolvedValue({ visibility: 'system', isBuiltIn: true });
    const honored = { effectiveModel: 'step-pin', modelSelection: 'honored' as const };
    const legacy = { llmModel: 'step-pin', llmUsagePolicyDecision: honored, workPlan: { templatePlanId: 't1', planDefaultModel: 'plan-pin', steps: [{ model: 'step-pin' }] } };
    expect(await storedBindingSource(legacy, 'step-pin', canonical)).toBe('system');
    expect(await storedBindingSource({ ...legacy, llmModel: 'plan-pin', llmUsagePolicyDecision: undefined }, 'plan-pin', canonical)).toBe('system');
    expect(await storedBindingSource({ ...legacy, llmModel: 'gpt-5.5', llmUsagePolicyDecision: undefined }, 'gpt-5.5', canonical)).toBeUndefined();
    // A recorded source, or a plan launched after the record existed, is never re-inferred.
    expect(await storedBindingSource({ ...legacy, llmModelSource: 'user' }, 'step-pin', canonical)).toBe('user');
    expect(await storedBindingSource({ ...legacy, workPlan: { ...legacy.workPlan, planAuthor: 'system' } }, 'step-pin', canonical)).toBeUndefined();
    mockGetWorkPlan.mockResolvedValue({ visibility: 'private', isBuiltIn: false });
    expect(await storedBindingSource(legacy, 'step-pin', canonical)).toBe('user');
  });
});

describe('legacyPlanPinSource: the one legacy rule for plan pins', () => {
  it('a still-admin-authored template makes the plan\'s own pins system; a user template or a deleted one does not', async () => {
    mockGetWorkPlan.mockResolvedValue({ visibility: 'system', isBuiltIn: true });
    expect(await legacyPlanPinSource({ templatePlanId: 'plan-1' })).toBe('system');
    mockGetWorkPlan.mockResolvedValue({ visibility: 'private', isBuiltIn: false });
    expect(await legacyPlanPinSource({ templatePlanId: 'plan-1' })).toBe('user');
    mockGetWorkPlan.mockResolvedValue(null);
    expect(await legacyPlanPinSource({ templatePlanId: 'plan-gone' })).toBe('user');
    expect(await legacyPlanPinSource({})).toBe('user');
  });
  it('an unreadable template never blocks (system, logged)', async () => {
    mockGetWorkPlan.mockRejectedValue(new Error('ddb down'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await legacyPlanPinSource({ templatePlanId: 'plan-1' })).toBe('system');
    consoleError.mockRestore();
  });
});

describe('unreadable tier through the real alert sink', () => {
  it('allows, and pages on-call ONCE for any number of affected owners within the window', async () => {
    mockResolution.mockResolvedValue({ subscriptionType: 'Free', resolved: false });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (const ownerUserId of ['u-1', 'u-2', 'u-3']) {
      await expect(modelAccess.assertModelAllowed({ ownerUserId, requestedModel: 'gpt-5.5', canonicalModel: 'gpt-5.5' })).resolves.toBeUndefined();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(emailService.sendOncallAlert).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe('getTierCompareBlock (D3)', () => {
  beforeEach(() => {
    settings.subscription_types = JSON.stringify([
      { name: 'Free', allowedModels: ['agentweb-model'] },
      { name: 'Pro', allowedModels: ['gpt-5.5', 'gemini-3.5-flash'] },
      { name: 'Max' },
    ]);
  });

  it('blocks a plan that runs fewer than two models (only the default runs), naming the upgrade tiers', async () => {
    expect(await getTierCompareBlock('u-free')).toEqual({ tier: 'Free', upgradeRequired: ['Pro', 'Max'] });
  });

  it('the default counts: one allowed model + the default = two, not blocked', async () => {
    mockTierConfig.mockResolvedValue({ configured: true, allowedModels: ['gpt-5.5'] });
    expect(await getTierCompareBlock('u-free')).toBeNull();
  });

  it('a live-voice model does not count as comparable', async () => {
    mockTierConfig.mockResolvedValue({ configured: true, allowedModels: ['live-1'] });
    expect(await getTierCompareBlock('u-free')).not.toBeNull();
  });

  it('never blocks with the switch off, for an admin owner, or on a wildcard tier', async () => {
    settings.model_tier_allowlist_enabled = 'false';
    expect(await getTierCompareBlock('u-free')).toBeNull();

    modelAccess.reset();
    settings.model_tier_allowlist_enabled = 'true';
    mockGetUser.mockResolvedValue({ isAdmin: true });
    expect(await getTierCompareBlock('u-admin')).toBeNull();

    modelAccess.reset();
    mockGetUser.mockResolvedValue({ isAdmin: false });
    mockTierConfig.mockResolvedValue({ configured: true });
    expect(await getTierCompareBlock('u-max')).toBeNull();
  });
});
