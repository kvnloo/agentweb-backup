const mockGetSetting = jest.fn();
jest.mock('../../settingsService', () => ({ settingsService: { getSetting: (...a: unknown[]) => mockGetSetting(...a) } }));

import { isHotLeadCallEnabled, setHotLeadCallEnabledOverride } from '../hotLeadCallMode';

describe('isHotLeadCallEnabled', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  beforeEach(() => {
    mockGetSetting.mockReset();
    setHotLeadCallEnabledOverride(null);
    Object.assign(process.env, { NODE_ENV: 'production' }); // the module reads nothing under NODE_ENV=test
  });
  afterEach(() => {
    Object.assign(process.env, { NODE_ENV: ORIGINAL_ENV });
    setHotLeadCallEnabledOverride(null);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('reads the hot_lead_call_mode setting', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: 'on' });
    expect(await isHotLeadCallEnabled()).toBe(true);
    expect(mockGetSetting).toHaveBeenCalledWith('hot_lead_call_mode');
  });

  it('is case- and whitespace-insensitive', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: '  ON ' });
    expect(await isHotLeadCallEnabled()).toBe(true);
  });

  it.each([[{ settingValue: 'off' }], [null], [{ settingValue: '' }], [{ settingValue: 'yes' }], [{ settingValue: 'true' }], [{ settingValue: '1' }], [{}]])(
    'is off for %j',
    async (row) => {
      mockGetSetting.mockResolvedValue(row);
      expect(await isHotLeadCallEnabled()).toBe(false);
    },
  );

  it('is off when the read throws, and does not throw', async () => {
    mockGetSetting.mockRejectedValue(new Error('dynamo down'));
    await expect(isHotLeadCallEnabled()).resolves.toBe(false);
  });

  it('caches for 30s and then re-reads', async () => {
    let now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockGetSetting.mockResolvedValue({ settingValue: 'on' });
    await isHotLeadCallEnabled();
    now += 29_999;
    await isHotLeadCallEnabled();
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
    mockGetSetting.mockResolvedValue({ settingValue: 'off' });
    now += 2;
    expect(await isHotLeadCallEnabled()).toBe(false);
    expect(mockGetSetting).toHaveBeenCalledTimes(2);
  });

  it('concurrent callers share one read', async () => {
    let release: (v: unknown) => void = () => undefined;
    mockGetSetting.mockReturnValue(new Promise((r) => { release = r; }));
    const calls = [isHotLeadCallEnabled(), isHotLeadCallEnabled(), isHotLeadCallEnabled()];
    release({ settingValue: 'on' });
    expect(await Promise.all(calls)).toEqual([true, true, true]);
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it('a stalled read gives up after 1.5s and is off', async () => {
    jest.useFakeTimers();
    mockGetSetting.mockReturnValue(new Promise(() => undefined));
    const result = isHotLeadCallEnabled();
    await jest.advanceTimersByTimeAsync(1501);
    expect(await result).toBe(false);
  });

  it('reads nothing under NODE_ENV=test', async () => {
    Object.assign(process.env, { NODE_ENV: 'test' });
    expect(await isHotLeadCallEnabled()).toBe(false);
    expect(mockGetSetting).not.toHaveBeenCalled();
  });
});
