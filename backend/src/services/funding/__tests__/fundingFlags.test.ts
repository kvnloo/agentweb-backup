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

  describe('a failed read keeps the last good flags (ENG-2108)', () => {
    afterEach(() => jest.useRealTimers());

    it('does not flip BYOK off for a customer already on their own key when a refresh read fails', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockedGetSetting.mockResolvedValueOnce({ settingValue: JSON.stringify(VALID_FLAGS) });
      expect((await getFundingFlags()).byok.enabled).toBe(true);

      jest.advanceTimersByTime(61_000);
      mockedGetSetting.mockRejectedValueOnce(new Error('dynamo blip'));
      expect((await getFundingFlags()).byok).toEqual({ enabled: true, allowUserIds: ['user-1'] });
      spy.mockRestore();
    });

    it('does the same when the stored value is malformed', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockedGetSetting.mockResolvedValueOnce({ settingValue: JSON.stringify(VALID_FLAGS) });
      await getFundingFlags();
      jest.advanceTimersByTime(61_000);
      mockedGetSetting.mockResolvedValueOnce({ settingValue: '{ nope' });
      expect((await getFundingFlags()).byok.enabled).toBe(true);
      spy.mockRestore();
    });

    it('retries soon after a failed read, not after a full cache window, and recovers', async () => {
      jest.useFakeTimers();
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockedGetSetting.mockResolvedValueOnce({ settingValue: JSON.stringify(VALID_FLAGS) });
      await getFundingFlags();
      jest.advanceTimersByTime(61_000);
      mockedGetSetting.mockRejectedValueOnce(new Error('blip'));
      await getFundingFlags();
      expect(mockedGetSetting).toHaveBeenCalledTimes(2);
      await getFundingFlags(); // within the retry delay: no new read
      expect(mockedGetSetting).toHaveBeenCalledTimes(2);

      jest.advanceTimersByTime(5_001);
      mockedGetSetting.mockResolvedValueOnce({ settingValue: JSON.stringify({ ...VALID_FLAGS, byok: { enabled: false, allowUserIds: [] } }) });
      expect((await getFundingFlags()).byok.enabled).toBe(false);
      expect(mockedGetSetting).toHaveBeenCalledTimes(3);
      spy.mockRestore();
    });

    it('still turns BYOK off when the row was deliberately changed or deleted (only FAILED reads keep the old value)', async () => {
      jest.useFakeTimers();
      mockedGetSetting.mockResolvedValueOnce({ settingValue: JSON.stringify(VALID_FLAGS) });
      await getFundingFlags();
      jest.advanceTimersByTime(61_000);
      mockedGetSetting.mockResolvedValueOnce(null);
      expect((await getFundingFlags()).byok.enabled).toBe(false);
    });

    it('a process that has never read the flags falls back to all-off on a failed read', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockedGetSetting.mockRejectedValueOnce(new Error('blip'));
      expect((await getFundingFlags()).byok.enabled).toBe(false);
      spy.mockRestore();
    });
  });
});
