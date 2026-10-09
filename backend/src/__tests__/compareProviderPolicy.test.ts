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
  it('exact string true => deny', async () => {
    const { policy } = make(async () => ({ settingValue: 'true' }));
    expect(await policy.getPolicy()).toEqual({ data_collection: 'deny' });
  });
  it.each([' True ', 'TRUE', 'True', 'true ', ' true', true])('only the exact string "true" turns it on: %j => off', async (v) => {
    const { policy } = make(async () => ({ settingValue: v }));
    expect(await policy.getPolicy()).toBeNull();
  });
  it('4 concurrent cold calls share ONE in-flight settings read', async () => {
    let release!: (v: { settingValue: string }) => void;
    const { policy, getSetting } = make(() => new Promise((resolve) => { release = resolve as any; }));
    const calls = [policy.getPolicy(), policy.getPolicy(), policy.getPolicy(), policy.getPolicy()];
    release({ settingValue: 'true' });
    const out = await Promise.all(calls);
    expect(getSetting).toHaveBeenCalledTimes(1);
    expect(out).toEqual(Array(4).fill({ data_collection: 'deny' }));
  });
  it('concurrent calls during a failing refresh share one read and all get the last-known value', async () => {
    let reject!: (e: Error) => void;
    const { policy, getSetting } = make(() => new Promise((_r, rej) => { reject = rej; }));
    const calls = [policy.getPolicy(), policy.getPolicy(), policy.getPolicy()];
    reject(new Error('down'));
    expect(await Promise.all(calls)).toEqual([null, null, null]);
    expect(getSetting).toHaveBeenCalledTimes(1);
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

describe('isProviderPolicyUnavailableError (conservative)', () => {
  const nf = (message: string, status = 404) => Object.assign(new Error(message), { status });
  const generic = nf('404 No endpoints found matching your data policy');
  const on = DENY_DATA_COLLECTION_POLICY;
  it('policy on + generic no-endpoints 404 + known model => true', () => {
    expect(isProviderPolicyUnavailableError(generic, on, true)).toBe(true);
    expect(isProviderPolicyUnavailableError(nf('No endpoints available'), on, true)).toBe(true);
  });
  it('policy off => false (unchanged behaviour)', () => {
    expect(isProviderPolicyUnavailableError(generic, null, true)).toBe(false);
  });
  it('MISLABEL 1: require_parameters 404 stays upstream (not a privacy problem)', () => {
    expect(isProviderPolicyUnavailableError(nf('404 No endpoints found that can handle the requested parameters'), on, true)).toBe(false);
    expect(isProviderPolicyUnavailableError(nf('No endpoints found that support the parameters: tools'), on, true)).toBe(false);
  });
  it('MISLABEL 2: unknown/retired model 404 stays upstream', () => {
    expect(isProviderPolicyUnavailableError(nf('No endpoints found for foo/bar-9.'), on, true)).toBe(false);
  });
  it('model id not known to the registry => false', () => {
    expect(isProviderPolicyUnavailableError(generic, on, false)).toBe(false);
  });
  it('wrapped originalMessage with parameters text is also excluded', () => {
    const wrapped = Object.assign(new Error('LLM call failed'), { originalMessage: 'No endpoints found that can handle the requested parameters' });
    expect(isProviderPolicyUnavailableError(wrapped, on, true)).toBe(false);
  });
  it('policy on + unrelated errors => false', () => {
    expect(isProviderPolicyUnavailableError(new Error('socket hang up'), on, true)).toBe(false);
    expect(isProviderPolicyUnavailableError(nf('Not Found'), on, true)).toBe(false);
  });
  it('code constant', () => {
    expect(COMPARE_PROVIDER_POLICY_UNAVAILABLE_CODE).toBe('provider_policy_unavailable');
  });
});
