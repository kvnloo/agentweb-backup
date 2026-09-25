jest.mock('../../settingsService', () => ({
  settingsService: { getSetting: jest.fn() },
}));

import { settingsService } from '../../settingsService';
import { getFundingFlags, __resetFundingFlagsCacheForTests } from '../fundingFlags';

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
});
