/**
 * ENG-55: Compare asks OpenRouter for providers that do not collect/train on data
 * (`provider.data_collection: 'deny'`), behind AW-Settings `model_compare_deny_data_collection`.
 */
import {
  applyProviderPolicy,
  COMPARE_DENY_DATA_COLLECTION_SETTING,
  COMPARE_PROVIDER_POLICY_UNAVAILABLE_CODE,
  createCompareProviderPolicy,
  DENY_DATA_COLLECTION_POLICY,
  isProviderPolicyUnavailableError,
} from '../services/agentMode/compareProviderPolicy';
import { OPENROUTER_PROVIDER_PREFERENCES } from '../services/agentMode/openRouterRequestParams';

function make(setting: () => Promise<{ settingValue?: unknown } | null>) {
  let t = 1_000_000;
  const getSetting = jest.fn(setting);
  const log = jest.fn();
  const policy = createCompareProviderPolicy({ getSetting, now: () => t, log });
  return { policy, getSetting, log, advance: (ms: number) => { t += ms; } };
}

describe('applyProviderPolicy', () => {
  const base = { ...OPENROUTER_PROVIDER_PREFERENCES, require_parameters: true };
  it('no policy => the exact same provider object content', () => {
    expect(applyProviderPolicy(base, null)).toEqual({
      order: ['amazon-bedrock', 'azure', 'google-vertex', 'anthropic', 'openai'],
      allow_fallbacks: true,
      require_parameters: true,
    });
    expect(applyProviderPolicy(base, undefined)).toEqual(base);
  });
  it('deny => merges data_collection without dropping order/allow_fallbacks/ignore', () => {
    expect(applyProviderPolicy({ ...base, ignore: ['Google'] }, DENY_DATA_COLLECTION_POLICY)).toEqual({
      ...base,
      ignore: ['Google'],
      data_collection: 'deny',
    });
  });
  it('does not mutate its input', () => {
    const input = { ...base };
    applyProviderPolicy(input, DENY_DATA_COLLECTION_POLICY);
    expect(input).not.toHaveProperty('data_collection');
  });
});

describe('createCompareProviderPolicy', () => {
  it('reads the documented setting name', async () => {
    const { policy, getSetting } = make(async () => ({ settingValue: 'true' }));
    await policy.getPolicy();
    expect(getSetting).toHaveBeenCalledWith('model_compare_deny_data_collection');
    expect(COMPARE_DENY_DATA_COLLECTION_SETTING).toBe('model_compare_deny_data_collection');
  });
  it.each([null, { settingValue: 'false' }, { settingValue: '' }, { settingValue: 'yes' }, { settingValue: undefined }, { settingValue: '1' }])(
    'absent/other value %j => off', async (row) => {
      const { policy } = make(async () => row as any);
      expect(await policy.getPolicy()).toBeNull();
    });
  it('exact string true (trim, case-insensitive) => deny', async () => {
    const { policy } = make(async () => ({ settingValue: ' True ' }));
    expect(await policy.getPolicy()).toEqual({ data_collection: 'deny' });
  });
  it('caches for ~60s then refreshes', async () => {
    let v = 'true';
    const { policy, getSetting, advance } = make(async () => ({ settingValue: v }));
    expect(await policy.getPolicy()).not.toBeNull();
    v = 'false';
    advance(59_000);
    expect(await policy.getPolicy()).not.toBeNull();
    expect(getSetting).toHaveBeenCalledTimes(1);
    advance(2_000);
    expect(await policy.getPolicy()).toBeNull();
    expect(getSetting).toHaveBeenCalledTimes(2);
  });
  it('read error after a success keeps the last-known value (on)', async () => {
    let fail = false;
    const { policy, advance, log } = make(async () => { if (fail) throw new Error('boom'); return { settingValue: 'true' }; });
    expect(await policy.getPolicy()).not.toBeNull();
    fail = true;
    advance(61_000);
    expect(await policy.getPolicy()).toEqual({ data_collection: 'deny' });
    expect(log).toHaveBeenCalled();
  });
  it('read error after a success keeps the last-known value (off)', async () => {
    let fail = false;
    const { policy, advance } = make(async () => { if (fail) throw new Error('boom'); return { settingValue: 'false' }; });
    expect(await policy.getPolicy()).toBeNull();
    fail = true;
    advance(61_000);
    expect(await policy.getPolicy()).toBeNull();
  });
  it('cold start with a read error => off (today\'s behaviour), never throws', async () => {
    const { policy } = make(async () => { throw new Error('down'); });
    await expect(policy.getPolicy()).resolves.toBeNull();
  });
  it('a failure is not cached as success: retried soon, then picks up the value', async () => {
    let fail = true;
    const { policy, advance } = make(async () => { if (fail) throw new Error('down'); return { settingValue: 'true' }; });
    expect(await policy.getPolicy()).toBeNull();
    fail = false;
    advance(6_000);
    expect(await policy.getPolicy()).not.toBeNull();
  });
});

describe('isProviderPolicyUnavailableError', () => {
  const noEndpoints = Object.assign(new Error('404 No endpoints found matching your data policy'), { status: 404 });
  it('policy on + no-endpoints 404 => true', () => {
    expect(isProviderPolicyUnavailableError(noEndpoints, DENY_DATA_COLLECTION_POLICY)).toBe(true);
  });
  it('policy off => false (unchanged behaviour)', () => {
    expect(isProviderPolicyUnavailableError(noEndpoints, null)).toBe(false);
  });
  it('policy on + unrelated errors => false', () => {
    expect(isProviderPolicyUnavailableError(new Error('socket hang up'), DENY_DATA_COLLECTION_POLICY)).toBe(false);
    expect(isProviderPolicyUnavailableError(Object.assign(new Error('Not Found'), { status: 404 }), DENY_DATA_COLLECTION_POLICY)).toBe(false);
  });
  it('code constant', () => {
    expect(COMPARE_PROVIDER_POLICY_UNAVAILABLE_CODE).toBe('provider_policy_unavailable');
  });
});
