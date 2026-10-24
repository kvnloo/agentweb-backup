import { createSubscriptionIsLive } from '../bridgeLiveness';
import { __resetFundingFlagsCacheForTests, FUNDING_FLAGS_SETTING_NAME } from '../fundingFlags';
import { settingsService } from '../../settingsService';

jest.mock('../../settingsService', () => ({ settingsService: { getSetting: jest.fn(), getSettingConsistent: jest.fn() } }));

const NOW = Date.parse('2026-10-24T12:00:00Z');
const RUN = { runId: 'r', userId: 'u1', sessionId: 's', connectionId: 'c1', epoch: 3 };
const record = (over: Record<string, unknown> = {}) =>
  ({ connectionId: 'c1', ownerUserId: 'u1', kind: 'claude_subscription', status: 'active', subHostEpoch: 3, subNeedsReconnect: false, subRefreshExpiresAtMs: NOW + 86_400_000, ...over }) as any;
const flags = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ byok: { enabled: false, allowUserIds: [] }, claudeSubscription: { enabled: true, allowUserIds: ['u1'] }, killSwitch: false, ...over });

const getSettingCached = settingsService.getSetting as jest.Mock; // reads (cached path)
const getSettingFresh = settingsService.getSettingConsistent as jest.Mock; // writes (fresh path)
const getSetting = { // both paths answer the same row unless a test splits them
  mockReset: () => { getSettingCached.mockReset(); getSettingFresh.mockReset(); },
  mockResolvedValue: (v: unknown) => { getSettingCached.mockResolvedValue(v); getSettingFresh.mockResolvedValue(v); },
};

function make(rec: any) {
  return createSubscriptionIsLive({ getConnection: jest.fn(async () => rec), now: () => NOW });
}

describe('subscription liveness check', () => {
  beforeEach(() => {
    __resetFundingFlagsCacheForTests();
    getSetting.mockReset();
    getSetting.mockResolvedValue({ settingName: FUNDING_FLAGS_SETTING_NAME, settingValue: flags() });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('is live for an active connection of the owner at the run\'s epoch with the feature on', async () => {
    expect(await make(record())(RUN, { write: true })).toBe(true);
    expect(await make(record())(RUN, { write: false })).toBe(true);
  });

  it('has nothing to check for a run that is not funded by a connection', async () => {
    expect(await make(null)({ runId: 'r', userId: 'u1', sessionId: 's' }, { write: true })).toBe(true);
  });

  it.each([
    ['a missing connection', null],
    ['another owner', record({ ownerUserId: 'u2' })],
    ['a revoked connection', record({ revokedAt: '2026-10-24T00:00:00Z' })],
    ['an invalid status', record({ status: 'invalid' })],
    ['a connection needing reconnect', record({ subNeedsReconnect: true })],
    ['a new host epoch', record({ subHostEpoch: 4 })],
    ['an expired login', record({ subRefreshExpiresAtMs: NOW - 1 })],
    ['another kind', record({ kind: 'byok' })],
  ])('is not live for %s', async (_label, rec) => {
    expect(await make(rec)(RUN, { write: true })).toBe(false);
  });

  it('is not live when the feature is off, the kill switch is on, or the user is not listed', async () => {
    for (const value of [flags({ claudeSubscription: { enabled: false, allowUserIds: ['u1'] } }), flags({ killSwitch: true }), flags({ claudeSubscription: { enabled: true, allowUserIds: ['*'] } })]) {
      getSetting.mockResolvedValue({ settingName: FUNDING_FLAGS_SETTING_NAME, settingValue: value });
      __resetFundingFlagsCacheForTests();
      expect(await make(record())(RUN, { write: true })).toBe(false);
    }
  });

  it('a write throws when the flags cannot be read fresh, even though a good value is cached', async () => {
    expect(await make(record())(RUN, { write: false })).toBe(true); // caches the good flags
    getSettingFresh.mockRejectedValue(new Error('dynamo down')); // the cached path is not even consulted for a write
    getSettingCached.mockRejectedValue(new Error('dynamo down'));
    await expect(make(record())(RUN, { write: true })).rejects.toThrow();
    expect(await make(record())(RUN, { write: false })).toBe(true); // reads may use the cache
  });

  it('a write throws on a malformed flags row instead of treating it as off or as the last good value', async () => {
    getSetting.mockResolvedValue({ settingName: FUNDING_FLAGS_SETTING_NAME, settingValue: '{"nope":true}' });
    await expect(make(record())(RUN, { write: true })).rejects.toThrow();
  });

  it('propagates a connection read failure so the bridge can refuse retryably', async () => {
    const isLive = createSubscriptionIsLive({ getConnection: jest.fn(async () => { throw new Error('x'); }), now: () => NOW });
    await expect(isLive(RUN, { write: true })).rejects.toThrow();
  });
});
