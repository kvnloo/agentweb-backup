/**
 * Compare models add-on entitlement (ENG-55 follow-up).
 *
 * Switch OFF/absent => nobody is gated (deploy changes nothing). Switch ON => admin or a
 * tier whose effective subscription includes `model_compare`; unreadable tier fails closed.
 */
import {
  createModelCompareEntitlement,
  MODEL_COMPARE_FEATURE_ID,
  MODEL_COMPARE_REQUIRES_ENTITLEMENT_SETTING,
} from '../services/agentMode/modelCompareEntitlement';
import { SUBSCRIPTION_FEATURES, getAllAvailableSubscriptionFeatures } from '../services/subscriptionService';

function make(over: { setting?: () => Promise<{ settingValue?: unknown } | null>; feature?: (u: string) => Promise<boolean | null> } = {}) {
  let t = 1_000_000;
  const getSetting = jest.fn(over.setting ?? (async () => ({ settingValue: 'true' })));
  const isFeatureEnabledForUser = jest.fn(over.feature ?? (async () => true));
  const ent = createModelCompareEntitlement({ getSetting, isFeatureEnabledForUser, now: () => t, log: () => undefined });
  return { ent, getSetting, isFeatureEnabledForUser, advance: (ms: number) => { t += ms; } };
}

describe('feature registration', () => {
  it('registers model_compare with a label and description in the admin checklist', () => {
    expect(MODEL_COMPARE_FEATURE_ID).toBe('model_compare');
    expect(SUBSCRIPTION_FEATURES.MODEL_COMPARE).toBe('model_compare');
    const f = getAllAvailableSubscriptionFeatures().find((x) => x.id === 'model_compare');
    expect(f).toEqual(expect.objectContaining({ label: 'Compare models' }));
    expect(f!.description.length).toBeGreaterThan(10);
  });
});

describe('switch off / absent / other', () => {
  it.each([null, { settingValue: 'false' }, { settingValue: '' }, { settingValue: 'yes' }, { settingValue: undefined }])(
    'is not required for %j and never consults the tier', async (row) => {
      const { ent, isFeatureEnabledForUser } = make({ setting: async () => row as any });
      expect(await ent.isRequired()).toBe(false);
      expect(await ent.isEntitled({ userId: 'u', isAdmin: false })).toBe(true);
      expect(isFeatureEnabledForUser).not.toHaveBeenCalled();
    });

  it('reads the documented setting name', async () => {
    const { ent, getSetting } = make();
    await ent.isRequired();
    expect(getSetting).toHaveBeenCalledWith(MODEL_COMPARE_REQUIRES_ENTITLEMENT_SETTING);
    expect(MODEL_COMPARE_REQUIRES_ENTITLEMENT_SETTING).toBe('model_compare_requires_entitlement');
  });
});

describe('switch on', () => {
  it("accepts 'true' case-insensitively with whitespace", async () => {
    const { ent } = make({ setting: async () => ({ settingValue: ' True ' }) });
    expect(await ent.isRequired()).toBe(true);
  });
  it('tier with the id => entitled; checks the user id and feature id', async () => {
    const { ent, isFeatureEnabledForUser } = make({ feature: async () => true });
    expect(await ent.isEntitled({ userId: 'u1', isAdmin: false })).toBe(true);
    expect(isFeatureEnabledForUser).toHaveBeenCalledWith('u1', 'model_compare');
  });
  it('tier without the id => denied', async () => {
    const { ent } = make({ feature: async () => false });
    expect(await ent.isEntitled({ userId: 'u1', isAdmin: false })).toBe(false);
  });
  it('unreadable tier (null) => denied (fail closed)', async () => {
    const { ent } = make({ feature: async () => null });
    expect(await ent.isEntitled({ userId: 'u1', isAdmin: false })).toBe(false);
  });
  it('tier lookup throwing => denied (fail closed)', async () => {
    const { ent } = make({ feature: async () => { throw new Error('ddb down'); } });
    expect(await ent.isEntitled({ userId: 'u1', isAdmin: false })).toBe(false);
  });
  it('admin => entitled without a tier lookup', async () => {
    const { ent, isFeatureEnabledForUser } = make({ feature: async () => false });
    expect(await ent.isEntitled({ userId: 'a', isAdmin: true })).toBe(true);
    expect(isFeatureEnabledForUser).not.toHaveBeenCalled();
  });
});

describe('settings cache', () => {
  it('caches for ~60s then re-reads', async () => {
    const { ent, getSetting, advance } = make();
    await ent.isRequired(); await ent.isRequired();
    expect(getSetting).toHaveBeenCalledTimes(1);
    advance(61_000);
    await ent.isRequired();
    expect(getSetting).toHaveBeenCalledTimes(2);
  });
  it('a read error after a known value keeps the last-known value (does not flip)', async () => {
    let fail = false;
    const { ent, advance } = make({ setting: async () => { if (fail) throw new Error('boom'); return { settingValue: 'true' }; } });
    expect(await ent.isRequired()).toBe(true);
    fail = true; advance(61_000);
    expect(await ent.isRequired()).toBe(true);
  });
  it('a read error on cold start => required (fail closed), never cached as success', async () => {
    const { ent, getSetting } = make({ setting: async () => { throw new Error('boom'); } });
    expect(await ent.isRequired()).toBe(true);
    expect(await ent.isRequired()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(1); // within the short retry window
  });
  it('cold-start read error: non-admin without tier access denied, admin allowed', async () => {
    const { ent, isFeatureEnabledForUser } = make({ setting: async () => { throw new Error('boom'); }, feature: async () => false });
    expect(await ent.isEntitled({ userId: 'u', isAdmin: false })).toBe(false);
    expect(await ent.isEntitled({ userId: 'a', isAdmin: true })).toBe(true);
    expect(isFeatureEnabledForUser).toHaveBeenCalledTimes(1);
  });
  it('cold-start read error: a tier with the feature is still entitled', async () => {
    const { ent } = make({ setting: async () => { throw new Error('boom'); }, feature: async () => true });
    expect(await ent.isEntitled({ userId: 'u', isAdmin: false })).toBe(true);
  });
  it('recovers on a later successful read (absent row => not required)', async () => {
    let fail = true;
    const { ent, advance } = make({ setting: async () => { if (fail) throw new Error('x'); return null; } });
    expect(await ent.isRequired()).toBe(true);
    fail = false; advance(6_000);
    expect(await ent.isRequired()).toBe(false);
  });
  it('a successful absent row is not required and is cached as a success', async () => {
    const { ent, getSetting } = make({ setting: async () => null });
    expect(await ent.isRequired()).toBe(false);
    expect(await ent.isRequired()).toBe(false);
    expect(getSetting).toHaveBeenCalledTimes(1);
  });
  it('a failed refresh is retried soon, not cached for a full window', async () => {
    let fail = true;
    const { ent, getSetting, advance } = make({ setting: async () => { if (fail) throw new Error('x'); return { settingValue: 'true' }; } });
    expect(await ent.isRequired()).toBe(true);
    fail = false; advance(6_000);
    expect(await ent.isRequired()).toBe(true);
    expect(getSetting).toHaveBeenCalledTimes(2);
  });
});
