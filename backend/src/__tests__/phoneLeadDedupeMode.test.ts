/**
 * ENG-2123: the rollout switch fails OFF. A missing row, an unknown value or a failed read must all
 * mean "behave as before", because this guards the public capture route.
 */
const mockGetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: (...a: any[]) => mockGetSetting(...a) } }));

import { getPhoneDedupeMode, setPhoneDedupeModeOverride, PHONE_DEDUPE_SETTING } from '../utils/phoneLeadDedupeMode';

describe('getPhoneDedupeMode', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  beforeEach(() => {
    jest.resetModules();
    mockGetSetting.mockReset();
    setPhoneDedupeModeOverride(null);
    (process.env as any).NODE_ENV = 'production'; // the module reads nothing under NODE_ENV=test
  });
  afterEach(() => { (process.env as any).NODE_ENV = ORIGINAL_ENV; setPhoneDedupeModeOverride(null); });

  const fresh = async () => {
    const m = await import('../utils/phoneLeadDedupeMode');
    m.setPhoneDedupeModeOverride(null); // also clears the module cache
    return m.getPhoneDedupeMode;
  };

  it.each(['off', 'create', 'shadow', 'on'])('reads %s from the setting', async (v) => {
    mockGetSetting.mockResolvedValue({ settingName: PHONE_DEDUPE_SETTING, settingValue: v });
    expect(await (await fresh())()).toBe(v);
    expect(mockGetSetting).toHaveBeenCalledWith(PHONE_DEDUPE_SETTING);
  });

  it('is case- and whitespace-insensitive', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: '  ON ' });
    expect(await (await fresh())()).toBe('on');
  });

  it.each([[null], [{ settingValue: '' }], [{ settingValue: 'yes' }], [{ settingValue: 'true' }], [{}]])('fails OFF for %j', async (row) => {
    mockGetSetting.mockResolvedValue(row);
    expect(await (await fresh())()).toBe('off');
  });

  it('fails OFF when the read throws, and does not throw', async () => {
    mockGetSetting.mockRejectedValue(new Error('dynamo down'));
    await expect((await fresh())()).resolves.toBe('off');
  });

  it('caches for the TTL, so the capture route does not read the table per request', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: 'on' });
    const get = await fresh();
    await get(); await get(); await get();
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers at cache expiry share ONE read', async () => {
    let release: (v: any) => void = () => undefined;
    mockGetSetting.mockReturnValue(new Promise((r) => { release = r; }));
    const get = await fresh();
    const calls = [get(), get(), get(), get()];
    release({ settingValue: 'shadow' });
    expect(await Promise.all(calls)).toEqual(['shadow', 'shadow', 'shadow', 'shadow']);
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it('a stalled read gives up after 1.5s and fails OFF instead of stalling the capture', async () => {
    jest.useFakeTimers();
    try {
      mockGetSetting.mockReturnValue(new Promise(() => undefined)); // never settles
      const get = await fresh();
      const result = get();
      await jest.advanceTimersByTimeAsync(1499);
      let settled = false;
      void result.then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      expect(await result).toBe('off');
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads nothing under NODE_ENV=test (existing capture-route tests must not reach DynamoDB)', async () => {
    (process.env as any).NODE_ENV = 'test';
    expect(await (await fresh())()).toBe('off');
    expect(mockGetSetting).not.toHaveBeenCalled();
  });
});
