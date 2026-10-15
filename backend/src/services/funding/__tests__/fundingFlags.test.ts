jest.mock('../../settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

import { settingsService } from '../../settingsService';
import { getFundingFlags, isClaudeSubscriptionEnabledFor, __resetFundingFlagsCacheForTests } from '../fundingFlags';

const mockedGetSetting = settingsService.getSetting as jest.Mock;

const VALID_FLAGS = {
  byok: { enabled: true, allowUserIds: ['user-1'] },
  claudeSubscription: { enabled: false, allowUserIds: [] },
  killSwitch: false,
};

describe('getFundingFlags (ENG-1816 F1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetFundingFlagsCacheForTests();
  });

  it('resolves all-off when the settings row does not exist', async () => {
    mockedGetSetting.mockResolvedValue(null);
    const flags = await getFundingFlags();
    expect(flags.byok.enabled).toBe(false);
    expect(flags.claudeSubscription.enabled).toBe(false);
    expect(flags.killSwitch).toBe(false);
  });

  it('resolves all-off, not a throw, when the row is malformed JSON', async () => {
    mockedGetSetting.mockResolvedValue({ settingValue: 'not json {' });
    const flags = await getFundingFlags();
    expect(flags.byok.enabled).toBe(false);
  });

  it('resolves all-off when the parsed JSON is missing required fields', async () => {
    mockedGetSetting.mockResolvedValue({ settingValue: JSON.stringify({ byok: { enabled: true } }) });
    const flags = await getFundingFlags();
    expect(flags.byok.enabled).toBe(false);
  });

  it('resolves all-off when the DynamoDB read itself throws', async () => {
    mockedGetSetting.mockRejectedValue(new Error('table not found'));
    const flags = await getFundingFlags();
    expect(flags.byok.enabled).toBe(false);
    expect(flags.claudeSubscription.enabled).toBe(false);
  });

  it('parses a well-formed row correctly', async () => {
    mockedGetSetting.mockResolvedValue({ settingValue: JSON.stringify(VALID_FLAGS) });
    const flags = await getFundingFlags();
    expect(flags).toEqual(VALID_FLAGS);
  });

  it('caches the result — a second call within the TTL does not re-read the setting', async () => {
    mockedGetSetting.mockResolvedValue({ settingValue: JSON.stringify(VALID_FLAGS) });
    await getFundingFlags();
    await getFundingFlags();
    expect(mockedGetSetting).toHaveBeenCalledTimes(1);
  });

  describe('isClaudeSubscriptionEnabledFor (ENG-2110)', () => {
    const row = (sub: unknown, killSwitch = false) => ({ settingValue: JSON.stringify({ ...VALID_FLAGS, claudeSubscription: sub, killSwitch }) });

    it('is true only for a user named one by one while the feature is on', async () => {
      mockedGetSetting.mockResolvedValue(row({ enabled: true, allowUserIds: ['user-1'] }));
      expect(await isClaudeSubscriptionEnabledFor('user-1')).toBe(true);
      expect(await isClaudeSubscriptionEnabledFor('user-2')).toBe(false);
    });

    it('does NOT honour the * wildcard (logins are handled on the main backend until the worker exists)', async () => {
      mockedGetSetting.mockResolvedValue(row({ enabled: true, allowUserIds: ['*'] }));
      expect(await isClaudeSubscriptionEnabledFor('user-1')).toBe(false);
      expect(await isClaudeSubscriptionEnabledFor('*')).toBe(false);
    });

    it('is false when the feature is off, when the kill switch is on, and when the row is missing', async () => {
      mockedGetSetting.mockResolvedValue(row({ enabled: false, allowUserIds: ['user-1'] }));
      expect(await isClaudeSubscriptionEnabledFor('user-1')).toBe(false);
      __resetFundingFlagsCacheForTests();
      mockedGetSetting.mockResolvedValue(row({ enabled: true, allowUserIds: ['user-1'] }, true));
      expect(await isClaudeSubscriptionEnabledFor('user-1')).toBe(false);
      __resetFundingFlagsCacheForTests();
      mockedGetSetting.mockResolvedValue(null);
      expect(await isClaudeSubscriptionEnabledFor('user-1')).toBe(false);
    });

    it('is independent of the BYOK switch', async () => {
      mockedGetSetting.mockResolvedValue({ settingValue: JSON.stringify({ ...VALID_FLAGS, byok: { enabled: true, allowUserIds: ['*'] }, claudeSubscription: { enabled: false, allowUserIds: [] } }) });
      expect(await isClaudeSubscriptionEnabledFor('user-1')).toBe(false);
    });
  });
});
