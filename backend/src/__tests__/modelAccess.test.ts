/**
 * ENG-669 PR-A: the tier model allowlist (services/agentMode/modelAccess.ts).
 *
 * Contract: switch `model_tier_allowlist_enabled` exact 'true' = on, anything else / cold-start failure = off
 * (nothing read). `allowedModels` absent = every model; '*' = every model; ids are matched CANONICALLY (legacy
 * aliases resolved); 'agentweb-model' is reserved and matches nothing runnable. Admin owners bypass, `anon_` owners
 * get the Free tier. A disallowed model throws ModelUnavailableError('not_in_plan') with the plan details, unless it
 * is a system model. An unreadable tier never blocks: last-known access, else allow + one deduped on-call alert.
 */
import {
  AGENTWEB_MODEL_ID,
  ALL_MODELS,
  MODEL_TIER_ALLOWLIST_SETTING,
  TIER_UNREADABLE_ALERT_DEDUPE_KEY,
  countAllowedRunnable,
  createModelAccess,
  isModelAllowed,
  isSystemAuthoredPlan,
  modelSourceAfter,
  normalizeAllowedModels,
  storedModelSource,
  type ModelAccessDeps,
  type TierModelsConfig,
} from '../services/agentMode/modelAccess';
import { ModelUnavailableError, buildModelUnavailableBody } from '../services/agentMode/modelUnavailable';

const ALIASES: Record<string, string> = {
  'legacy-sonnet': 'anthropic.claude-sonnet-4-6',
  'openrouter/old/glm': 'openrouter/z-ai/glm-5.3',
};
const normalize = (id: string) => ALIASES[id] ?? id;

const TIERS: TierModelsConfig[] = [
  { name: 'Free', allowedModels: ['gemini-3.5-flash', AGENTWEB_MODEL_ID] },
  { name: 'Pro', allowedModels: ['gemini-3.5-flash', 'gpt-5.5', 'legacy-sonnet', 'openrouter/z-ai/glm-5.3'] },
  { name: 'Max', allowedModels: ['*'] },
  { name: 'Legacy' }, // field absent = every model
];

function makeDeps(overrides: Partial<ModelAccessDeps> & { switchValue?: unknown; users?: Record<string, { isAdmin?: boolean; tier: string }> } = {}) {
  let now = 1_000_000;
  const users = overrides.users ?? {
    'u-free': { tier: 'Free' },
    'u-pro': { tier: 'Pro' },
    'u-max': { tier: 'Max' },
    'u-legacy': { tier: 'Legacy' },
    'u-admin': { tier: 'Free', isAdmin: true },
  };
  const deps = {
    getSetting: jest.fn(async (name: string) => (name === MODEL_TIER_ALLOWLIST_SETTING
      ? { settingValue: 'switchValue' in overrides ? overrides.switchValue : 'true' }
      : null)),
    getUser: jest.fn(async (userId: string) => (users[userId] ? { isAdmin: users[userId].isAdmin === true } : undefined)),
    resolveTier: jest.fn(async (userId: string) => (users[userId]
      ? { subscriptionType: users[userId].tier, resolved: true }
      : { subscriptionType: 'Free', resolved: false })),
    readTierModels: jest.fn(async (tierName: string) => {
      const tier = TIERS.find((t) => t.name === tierName);
      return tier ? { configured: true, allowedModels: tier.allowedModels } : { configured: false };
    }),
    listTiers: jest.fn(async () => TIERS),
    normalizeModelId: normalize,
    alertTierUnreadable: jest.fn(async () => true),
    now: () => now,
    log: jest.fn(),
    ...overrides,
  } as unknown as ModelAccessDeps & Record<string, jest.Mock>;
  return { deps, advance: (ms: number) => { now += ms; } };
}

describe('normalizeAllowedModels', () => {
  it('absent / not a list = every model', () => {
    expect(normalizeAllowedModels(undefined, normalize)).toBe(ALL_MODELS);
    expect(normalizeAllowedModels('gpt-5.5', normalize)).toBe(ALL_MODELS);
  });

  it("'*' anywhere = every model", () => {
    expect(normalizeAllowedModels(['gpt-5.5', '*'], normalize)).toBe(ALL_MODELS);
  });

  it('resolves legacy aliases (incl. openrouter/ ids), trims, de-duplicates and keeps the reserved id', () => {
    expect(normalizeAllowedModels([' legacy-sonnet ', 'anthropic.claude-sonnet-4-6', 'openrouter/old/glm', AGENTWEB_MODEL_ID, '', 7], normalize))
      .toEqual(['anthropic.claude-sonnet-4-6', 'openrouter/z-ai/glm-5.3', AGENTWEB_MODEL_ID]);
  });

  it('an empty list allows nothing beyond system models', () => {
    expect(normalizeAllowedModels([], normalize)).toEqual([]);
  });
});

describe('isModelAllowed / countAllowedRunnable', () => {
  const access = (allowedModels: string[] | '*', isAdmin = false) => ({ tier: 'T', allowedModels, isAdmin, source: 'tier' as const });

  it('matches canonical ids; admin and wildcard bypass', () => {
    expect(isModelAllowed(access(['gpt-5.5']), 'gpt-5.5')).toBe(true);
    expect(isModelAllowed(access(['gpt-5.5']), 'gemini-3.5-flash')).toBe(false);
    expect(isModelAllowed(access([], true), 'gemini-3.5-flash')).toBe(true);
    expect(isModelAllowed(access('*'), 'anything')).toBe(true);
  });

  it("'agentweb-model' matches nothing runnable until the router exists (PR-C)", () => {
    const catalog = ['gpt-5.5', 'gemini-3.5-flash'];
    expect(countAllowedRunnable(access([AGENTWEB_MODEL_ID]), catalog)).toBe(0);
    expect(countAllowedRunnable(access([AGENTWEB_MODEL_ID]), catalog, ['gemini-3.5-flash'])).toBe(1);
    expect(countAllowedRunnable(access(['gpt-5.5']), catalog, ['gemini-3.5-flash'])).toBe(2);
    expect(countAllowedRunnable(access('*'), catalog)).toBe(2);
  });
});

describe('isSystemAuthoredPlan', () => {
  it('built-in (admin route) or system visibility; a user plan stays user-authored when public', () => {
    expect(isSystemAuthoredPlan({ visibility: 'system', isBuiltIn: false })).toBe(true);
    expect(isSystemAuthoredPlan({ visibility: 'public', isBuiltIn: true })).toBe(true);
    expect(isSystemAuthoredPlan({ visibility: 'public', isBuiltIn: false })).toBe(false);
    expect(isSystemAuthoredPlan({ visibility: 'private', isBuiltIn: false })).toBe(false);
    expect(isSystemAuthoredPlan(null)).toBe(false);
  });
});

describe('the switch', () => {
  it.each([undefined, 'TRUE', ' true', 'false', '1', true])('%p is off: assertModelAllowed reads nothing else', async (value) => {
    const { deps } = makeDeps({ switchValue: value });
    const access = createModelAccess(deps);
    await expect(access.assertModelAllowed({ ownerUserId: 'u-free', requestedModel: 'gpt-5.5', canonicalModel: 'gpt-5.5' })).resolves.toBeUndefined();
    expect(await access.filterAllowedModels('u-free', ['gpt-5.5'])).toEqual(['gpt-5.5']);
    expect(deps.getUser).not.toHaveBeenCalled();
    expect(deps.resolveTier).not.toHaveBeenCalled();
    expect(deps.readTierModels).not.toHaveBeenCalled();
  });

  it('a cold-start read failure is off; a later failure keeps the last-known value; reads are cached ~60s', async () => {
    const getSetting = jest.fn().mockRejectedValueOnce(new Error('ddb down'));
    const { deps, advance } = makeDeps({ getSetting });
    const access = createModelAccess(deps);
    expect(await access.isEnabled()).toBe(false);

    getSetting.mockResolvedValue({ settingValue: 'true' });
    advance(5_000);
    expect(await access.isEnabled()).toBe(true);
    advance(30_000);
    expect(await access.isEnabled()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(2);

    getSetting.mockRejectedValue(new Error('ddb down again'));
    advance(61_000);
    expect(await access.isEnabled()).toBe(true);
  });
});

describe('getModelAccess', () => {
  it('absent field = every model; wildcard = every model; a list is canonicalised', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    expect(await access.getModelAccess('u-legacy')).toMatchObject({ tier: 'Legacy', allowedModels: '*', isAdmin: false, source: 'tier' });
    expect(await access.getModelAccess('u-max')).toMatchObject({ tier: 'Max', allowedModels: '*' });
    expect((await access.getModelAccess('u-pro')).allowedModels)
      .toEqual(['gemini-3.5-flash', 'gpt-5.5', 'anthropic.claude-sonnet-4-6', 'openrouter/z-ai/glm-5.3']);
  });

  it('an admin owner bypasses without any tier read', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    expect(await access.getModelAccess('u-admin')).toMatchObject({ isAdmin: true, allowedModels: '*', source: 'admin' });
    expect(deps.resolveTier).not.toHaveBeenCalled();
    expect(deps.readTierModels).not.toHaveBeenCalled();
  });

  it("an anon_ owner gets the Free tier's list without a user read", async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    expect(await access.getModelAccess('anon_123')).toMatchObject({ tier: 'Free', allowedModels: ['gemini-3.5-flash', AGENTWEB_MODEL_ID] });
    expect(deps.getUser).not.toHaveBeenCalled();
    expect(deps.resolveTier).not.toHaveBeenCalled();
  });

  it('the tier is resolved for the OWNER id given (org-aware resolution lives in resolveTier)', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    await access.getModelAccess('u-pro');
    expect(deps.resolveTier).toHaveBeenCalledWith('u-pro');
  });

  it('a fresh answer is reused for ~10s (one tier read per turn), then re-read', async () => {
    const { deps, advance } = makeDeps();
    const access = createModelAccess(deps);
    await access.getModelAccess('u-pro');
    await access.getModelAccess('u-pro');
    expect(deps.resolveTier).toHaveBeenCalledTimes(1);
    advance(11_000);
    await access.getModelAccess('u-pro');
    expect(deps.resolveTier).toHaveBeenCalledTimes(2);
  });
});

describe('unreadable tier: never blocks', () => {
  it('serves the last-known access for that owner after a failed read', async () => {
    const { deps, advance } = makeDeps();
    const access = createModelAccess(deps);
    const first = await access.getModelAccess('u-pro');
    advance(11_000);
    (deps.readTierModels as jest.Mock).mockRejectedValueOnce(new Error('settings read failed'));
    expect(await access.getModelAccess('u-pro')).toEqual({ ...first, source: 'last_known' });
    advance(11_000);
    (deps.resolveTier as jest.Mock).mockRejectedValueOnce(new Error('ddb down'));
    expect(await access.getModelAccess('u-pro')).toEqual({ ...first, source: 'last_known' });
    expect(deps.alertTierUnreadable).not.toHaveBeenCalled();
  });

  it('with nothing known: allows every model and fires the deduped on-call alert (constant key)', async () => {
    const { deps } = makeDeps();
    (deps.resolveTier as jest.Mock).mockResolvedValue({ subscriptionType: 'Free', resolved: false });
    const access = createModelAccess(deps);
    await expect(access.assertModelAllowed({ ownerUserId: 'u-free', requestedModel: 'gpt-5.5', canonicalModel: 'gpt-5.5' })).resolves.toBeUndefined();
    await expect(access.assertModelAllowed({ ownerUserId: 'u-pro', requestedModel: 'gpt-5.5', canonicalModel: 'gpt-5.5' })).resolves.toBeUndefined();
    expect(deps.alertTierUnreadable).toHaveBeenCalledTimes(2);
    for (const [call] of (deps.alertTierUnreadable as jest.Mock).mock.calls) {
      expect(call).toMatchObject({ dedupeKey: TIER_UNREADABLE_ALERT_DEDUPE_KEY, dedupeWindowMs: 60 * 60 * 1000 });
    }
  });

  it('a failing alert sink never fails the turn', async () => {
    const { deps } = makeDeps({ alertTierUnreadable: jest.fn().mockRejectedValue(new Error('smtp down')) });
    (deps.readTierModels as jest.Mock).mockRejectedValue(new Error('ddb down'));
    const access = createModelAccess(deps);
    await expect(access.getModelAccess('u-free')).resolves.toMatchObject({ allowedModels: '*', source: 'unavailable' });
  });
});

describe('unconfigured tier and read storms (review R4)', () => {
  it('a tier with no row is every model, cached like any answer, logged once, and NEVER alerts', async () => {
    const { deps } = makeDeps({ users: { 'u-ghost': { tier: 'Enterprise-Legacy' }, 'u-ghost-2': { tier: 'Enterprise-Legacy' } } });
    const access = createModelAccess(deps);
    for (let i = 0; i < 5; i++) {
      expect(await access.getModelAccess('u-ghost')).toMatchObject({ tier: 'Enterprise-Legacy', allowedModels: '*', source: 'tier' });
    }
    await access.getModelAccess('u-ghost-2');
    expect(deps.getUser).toHaveBeenCalledTimes(2);
    expect(deps.resolveTier).toHaveBeenCalledTimes(2);
    expect(deps.readTierModels).toHaveBeenCalledTimes(2);
    expect(deps.alertTierUnreadable).not.toHaveBeenCalled();
    expect((deps.log as jest.Mock).mock.calls.filter(([m]) => /no subscription_types row/.test(m))).toHaveLength(1);
  });

  it('anon_ with no Free row is every model, without an alert', async () => {
    const { deps } = makeDeps();
    (deps.readTierModels as jest.Mock).mockResolvedValue({ configured: false });
    const access = createModelAccess(deps);
    expect(await access.getModelAccess('anon_1')).toMatchObject({ tier: 'Free', allowedModels: '*', source: 'tier' });
    expect(deps.alertTierUnreadable).not.toHaveBeenCalled();
  });

  it('a FAILING read is answered from a short cache too: N turns => bounded reads, not N of each', async () => {
    const { deps, advance } = makeDeps();
    (deps.readTierModels as jest.Mock).mockRejectedValue(new Error('ddb down'));
    const access = createModelAccess(deps);
    for (let i = 0; i < 5; i++) {
      expect(await access.getModelAccess('u-free')).toMatchObject({ allowedModels: '*', source: 'unavailable' });
    }
    expect(deps.getUser).toHaveBeenCalledTimes(1);
    expect(deps.resolveTier).toHaveBeenCalledTimes(1);
    expect(deps.readTierModels).toHaveBeenCalledTimes(1);
    advance(11_000);
    await access.getModelAccess('u-free');
    expect(deps.readTierModels).toHaveBeenCalledTimes(2);
    // ...and a recovered read replaces the degraded answer at once.
    (deps.readTierModels as jest.Mock).mockImplementation(async () => ({ configured: true, allowedModels: ['gemini-3.5-flash'] }));
    advance(11_000);
    expect(await access.getModelAccess('u-free')).toMatchObject({ allowedModels: ['gemini-3.5-flash'], source: 'tier' });
  });
});

describe('assertModelAllowed', () => {
  it('refuses a disallowed canonical id with not_in_plan and the plan details', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    const err = await access.assertModelAllowed({ ownerUserId: 'u-free', requestedModel: 'legacy-sonnet', canonicalModel: 'anthropic.claude-sonnet-4-6' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ModelUnavailableError);
    expect(err).toMatchObject({
      reason: 'not_in_plan',
      requestedModel: 'legacy-sonnet',
      plan: {
        model: 'anthropic.claude-sonnet-4-6',
        tier: 'Free',
        allowedModels: ['gemini-3.5-flash', AGENTWEB_MODEL_ID],
        upgradeRequired: ['Pro', 'Max', 'Legacy'],
      },
    });
  });

  it('allows a listed id, an aliased listed id (matched canonically) and an openrouter/ id', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    for (const canonicalModel of ['gpt-5.5', 'anthropic.claude-sonnet-4-6', 'openrouter/z-ai/glm-5.3']) {
      await expect(access.assertModelAllowed({ ownerUserId: 'u-pro', requestedModel: canonicalModel, canonicalModel })).resolves.toBeUndefined();
    }
  });

  it('admin owner, wildcard and absent field never refuse', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    for (const ownerUserId of ['u-admin', 'u-max', 'u-legacy']) {
      await expect(access.assertModelAllowed({ ownerUserId, requestedModel: 'gpt-5.5', canonicalModel: 'gpt-5.5' })).resolves.toBeUndefined();
    }
  });

  it('a system model passes; the system check runs ONLY when the allowlist would refuse', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    const isSystemModel = jest.fn(async (id: string) => id === 'gpt-5.5');
    await access.assertModelAllowed({ ownerUserId: 'u-free', requestedModel: 'gemini-3.5-flash', canonicalModel: 'gemini-3.5-flash', isSystemModel });
    expect(isSystemModel).not.toHaveBeenCalled();
    await expect(access.assertModelAllowed({ ownerUserId: 'u-free', requestedModel: 'gpt-5.5', canonicalModel: 'gpt-5.5', isSystemModel }))
      .resolves.toBeUndefined();
    await expect(access.assertModelAllowed({ ownerUserId: 'u-free', requestedModel: 'o3', canonicalModel: 'o3', isSystemModel }))
      .rejects.toMatchObject({ reason: 'not_in_plan' });
  });

  it("'agentweb-model' on a tier allows no runnable model (until PR-C)", async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    expect(await access.filterAllowedModels('u-free', ['gpt-5.5', 'gemini-3.5-flash', 'o3'])).toEqual(['gemini-3.5-flash']);
    expect(await access.filterAllowedModels('u-free', ['gpt-5.5', 'o3'], async (id) => id === 'o3')).toEqual(['o3']);
  });
});

describe('tiersRunningAtLeast (Compare D3 upgradeRequired)', () => {
  it('names the tiers that run at least N catalog models', async () => {
    const { deps } = makeDeps();
    const access = createModelAccess(deps);
    expect(await access.tiersRunningAtLeast(2, ['gpt-5.5', 'gemini-3.5-flash'])).toEqual(['Pro', 'Max', 'Legacy']);
    expect(await access.tiersRunningAtLeast(2, ['gpt-5.5', 'gemini-3.5-flash'], ['gpt-5.5'])).toEqual(['Free', 'Pro', 'Max', 'Legacy']);
  });
});

describe('the 422 body', () => {
  const err = new ModelUnavailableError('legacy-sonnet', 'not_in_plan', {
    model: 'anthropic.claude-sonnet-4-6', tier: 'Free', allowedModels: ['gemini-3.5-flash'], upgradeRequired: ['Pro'],
  });

  it('carries model, tier, allowedModels and upgradeRequired for the owner', () => {
    expect(buildModelUnavailableBody(err, 'Claude Sonnet 4.6')).toEqual({
      error: "The model you selected (Claude Sonnet 4.6) isn't included in your plan, so nothing was sent to a different model. Choose another model, or upgrade your plan to use this one.",
      code: 'model_unavailable',
      requestedModel: 'legacy-sonnet',
      reason: 'not_in_plan',
      model: 'anthropic.claude-sonnet-4-6',
      tier: 'Free',
      allowedModels: ['gemini-3.5-flash'],
      upgradeRequired: ['Pro'],
    });
  });

  it('omits every plan field (and the plan wording) for a share viewer', () => {
    const body = buildModelUnavailableBody(err, 'Claude Sonnet 4.6', 'selection', 'share_viewer');
    expect(body).toEqual({
      error: "The model selected for this chat (Claude Sonnet 4.6) isn't available on this account, so nothing was sent to a different model. Choose another model and try again.",
      code: 'model_unavailable',
      requestedModel: 'legacy-sonnet',
      reason: 'not_in_plan',
    });
  });

  it('existing reasons keep their exact wording and shape', () => {
    expect(buildModelUnavailableBody(new ModelUnavailableError('x', 'not_served'))).toEqual({
      error: "The model you selected (x) isn't available right now, so nothing was sent to a different model. Choose another model and try again.",
      code: 'model_unavailable',
      requestedModel: 'x',
      reason: 'not_served',
    });
  });
});

describe('who chose a stored model (review round 3)', () => {
  // 'gpt-5-chat-2' is a real legacy alias of 'gpt-5.5' in the registry's alias table.
  it('modelSourceAfter compares through the registry alias table BY DEFAULT (every caller, by construction)', () => {
    expect(modelSourceAfter({ llmModel: 'gpt-5.5', llmModelSource: 'system' }, 'gpt-5.5', 'gpt-5-chat-2')).toBe('system');
    expect(modelSourceAfter({ llmModel: 'gpt-5-chat-2' }, 'gpt-5.5', null)).toBe('user');
    expect(modelSourceAfter({ llmModel: 'gpt-5.5', llmModelSource: 'system' }, 'gemini-3.5-flash', 'gemini-3.5-flash')).toBe('user');
    expect(modelSourceAfter({ llmModel: 'gpt-5.5', llmModelSource: 'user' }, 'gemini-3.5-flash', null)).toBe('system');
  });

  it('legacy rule: no source and no decision is AgentWeb\'s only on a side-channel session', () => {
    expect(storedModelSource({ llmModel: 'm' })).toBe('user');
    expect(storedModelSource({ llmModel: 'm', slackThread: { channel: 'C', threadTs: '1' } })).toBe('system');
    expect(storedModelSource({ llmModel: 'm', gtmWorkItem: { planId: 'p' } })).toBe('system');
    expect(storedModelSource({ llmModel: 'm', sessionType: 'emma-email' })).toBe('system');
    expect(storedModelSource({ llmModel: 'm', sessionType: 'result-endpoint' })).toBe('system');
    // A recorded source or a decision always wins over the marker.
    expect(storedModelSource({ llmModel: 'm', slackThread: { channel: 'C' }, llmModelSource: 'user' })).toBe('user');
    expect(storedModelSource({
      llmModel: 'm', slackThread: { channel: 'C' }, llmUsagePolicyDecision: { effectiveModel: 'm', modelSelection: 'honored' },
    })).toBe('user');
  });
});
