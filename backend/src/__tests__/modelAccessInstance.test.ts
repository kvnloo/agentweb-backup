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
  getSubscriptionTypeConfig: jest.fn(),
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

import { getTierCompareBlock, isSystemModelFor, modelAccess } from '../services/agentMode/modelAccessInstance';
import { userDb } from '../services/db';
import { getSubscriptionTypeConfig, getUserSubscriptionResolution } from '../services/subscriptionService';
import { workPlanService } from '../services/workPlanService';
import { emailService } from '../services/emailService';

const mockGetUser = userDb.getUserById as jest.Mock;
const mockResolution = getUserSubscriptionResolution as jest.Mock;
const mockTierConfig = getSubscriptionTypeConfig as jest.Mock;
const mockGetWorkPlan = workPlanService.getWorkPlan as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  modelAccess.reset();
  for (const key of Object.keys(settings)) delete settings[key];
  settings.model_tier_allowlist_enabled = 'true';
  mockGetUser.mockResolvedValue({ isAdmin: false });
  mockResolution.mockResolvedValue({ subscriptionType: 'Free', resolved: true });
  mockTierConfig.mockResolvedValue({ name: 'Free', allowedModels: ['agentweb-model'] });
});

describe('isSystemModelFor', () => {
  it('the configured default is a system model everywhere', async () => {
    expect(await isSystemModelFor(null, 'default-model')).toBe(true);
    expect(await isSystemModelFor({ sessionType: 'regular' }, 'default-model')).toBe(true);
    expect(await isSystemModelFor(null, 'gpt-5.5')).toBe(false);
  });

  it.each([
    [{ sessionType: 'scheduled' }, 'sched-model'],
    [{ sessionType: 'report_generation' }, 'report-model'],
    [{ sessionType: 'report_generation' }, 'report-gen-model'],
    [{ sessionType: 'image-generation' }, 'image-model'],
    [{ sessionType: 'video-generation' }, 'video-model'],
    [{ sessionType: 'regular', portalType: 'emma-sidebar' }, 'cs-model'],
  ])('%p: its configured default %s is a system model there, and only there', async (session, model) => {
    expect(await isSystemModelFor(session, model)).toBe(true);
    expect(await isSystemModelFor({ sessionType: 'regular', portalType: 'agent' }, model)).toBe(false);
  });

  it("an admin-authored plan's pins are system models in a session launched from it; a user plan's are not", async () => {
    const session = { sessionType: 'predefined-work-plan', workPlan: { templatePlanId: 'plan-1' } };
    mockGetWorkPlan.mockResolvedValue({ visibility: 'system', isBuiltIn: true, defaultModel: 'plan-pin', steps: [{ model: 'step-pin' }, {}] });
    expect(await isSystemModelFor(session, 'plan-pin')).toBe(true);
    expect(await isSystemModelFor(session, 'step-pin')).toBe(true);
    expect(await isSystemModelFor(session, 'gpt-5.5')).toBe(false);

    mockGetWorkPlan.mockResolvedValue({ visibility: 'private', isBuiltIn: false, defaultModel: 'plan-pin', steps: [{ model: 'step-pin' }] });
    expect(await isSystemModelFor(session, 'plan-pin')).toBe(false);
    expect(await isSystemModelFor(session, 'step-pin')).toBe(false);
  });

  it('an unreadable template never blocks (treated as admin-authored)', async () => {
    mockGetWorkPlan.mockRejectedValue(new Error('ddb down'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await isSystemModelFor({ workPlan: { templatePlanId: 'plan-1' } }, 'gpt-5.5')).toBe(true);
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
    mockTierConfig.mockResolvedValue({ name: 'Free', allowedModels: ['gpt-5.5'] });
    expect(await getTierCompareBlock('u-free')).toBeNull();
  });

  it('a live-voice model does not count as comparable', async () => {
    mockTierConfig.mockResolvedValue({ name: 'Free', allowedModels: ['live-1'] });
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
    mockTierConfig.mockResolvedValue({ name: 'Max' });
    expect(await getTierCompareBlock('u-max')).toBeNull();
  });
});
