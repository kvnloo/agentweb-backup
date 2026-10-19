/**
 * ENG-2271 runtime overrides on the vendor rate card: precedence, fail-safe fallback, the TTL
 * refresh path and rate/version snapshot consistency.
 */
const mockGetSetting = jest.fn();
jest.mock('../services/settingsService', () => ({
  settingsService: { getSetting: (...a: unknown[]) => mockGetSetting(...a) },
}));

import {
  VENDOR_RATE_CARD_VERSION,
  applyVendorRateOverridesLocally,
  getAllocatedRate,
  getAllocatedRateWithVersion,
  getRateCardVersion,
  parseVendorRateOverrides,
  refreshVendorRateOverrides,
  setVendorRateOverridesForTests,
} from '../utils/vendorRateCard';

const T = '2026-11-01T00:00:00.000Z';
const stored = (overrides: unknown, updatedAt: unknown = T) =>
  JSON.stringify({ overrides, updatedAt, updatedBy: 'admin-1' });

afterEach(() => {
  setVendorRateOverridesForTests(null);
  jest.restoreAllMocks();
  mockGetSetting.mockReset();
});

describe('precedence', () => {
  it('returns the override for an editable provider and the card default otherwise', () => {
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } });
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.02);
    expect(getAllocatedRate('twilio', 'number_monthly_rent')).toBe(1.15);
    expect(getAllocatedRate('you.com', 'query')).toBe(0.0125);
  });

  it('never prices an unknown key, even if an override names it', () => {
    setVendorRateOverridesForTests({ twilio: { made_up: 5 } } as never);
    expect(getAllocatedRate('twilio', 'made_up')).toBeNull();
  });

  it('ignores overrides for a provider outside the editable allowlist', () => {
    setVendorRateOverridesForTests({ v0: { landing_page_generation: 0.01 } } as never);
    expect(getAllocatedRate('v0', 'landing_page_generation')).toBe(2.0);
    expect(getRateCardVersion()).toBe(VENDOR_RATE_CARD_VERSION);
  });
});

describe('parseVendorRateOverrides (fail safe)', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN-as-null', null],
    ['string', '0.5'],
    ['above the cap', 1000.01],
    ['Infinity-as-null', null],
  ])('drops a %s rate but keeps valid siblings', (_n, bad) => {
    const state = parseVendorRateOverrides(
      stored({ twilio: { voice_minute_outbound: bad, number_monthly_rent: 2 } }),
    );
    expect(state.overrides).toEqual({ twilio: { number_monthly_rent: 2 } });
  });

  it.each([
    ['bad JSON', '{nope'],
    ['an array', '[]'],
    ['no updatedAt', JSON.stringify({ overrides: { twilio: { voice_minute_outbound: 1 } } })],
    ['unparseable updatedAt', stored({ twilio: { voice_minute_outbound: 1 } }, 'yesterday')],
    ['overrides not an object', stored('x')],
  ])('yields no overrides for %s and does not throw', (_n, raw) => {
    expect(parseVendorRateOverrides(raw).overrides).toEqual({});
  });

  it('warns without echoing values', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    parseVendorRateOverrides(stored({ twilio: { voice_minute_outbound: -7.77 } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('7.77');
  });

  it('lookup falls back to the card when the injected state is garbage', () => {
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0 } } as never);
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.014);
  });
});

describe('version stamping and snapshot consistency', () => {
  it('is the plain version with no override and suffixed with updatedAt with one', () => {
    expect(getRateCardVersion()).toBe(VENDOR_RATE_CARD_VERSION);
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, T);
    expect(getRateCardVersion()).toBe(`${VENDOR_RATE_CARD_VERSION}+ovr:${T}`);
  });

  it('an empty overrides object is not an active override', () => {
    setVendorRateOverridesForTests({});
    expect(getRateCardVersion()).toBe(VENDOR_RATE_CARD_VERSION);
  });

  it('returns rate and version from one lookup, so a later change cannot split them', () => {
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, T);
    const priced = getAllocatedRateWithVersion('twilio', 'voice_minute_outbound')!;
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.03 } }, '2026-11-02T00:00:00.000Z');
    expect(priced).toEqual({ rate: 0.02, version: `${VENDOR_RATE_CARD_VERSION}+ovr:${T}` });
  });

  it('keeps the plain version on keys the override does not touch', () => {
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, T);
    expect(getAllocatedRateWithVersion('twilio', 'number_monthly_rent'))
      .toEqual({ rate: 1.15, version: VENDOR_RATE_CARD_VERSION });
  });
});

describe('refresh from AW-Settings (outside NODE_ENV=test)', () => {
  const realEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    setVendorRateOverridesForTests(null);
  });
  afterEach(() => {
    process.env.NODE_ENV = realEnv;
    jest.useRealTimers();
  });

  it('serves the card synchronously, refreshes in the background and applies the stored override', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: stored({ twilio: { voice_minute_outbound: 0.02 } }) });
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.014); // stale read never blocks
    await jest.advanceTimersByTimeAsync(0); // only the lookup's own background refresh runs
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.02);
  });

  it('does not re-read inside the 60s TTL and re-reads after it', async () => {
    mockGetSetting.mockResolvedValue({ settingValue: stored({ twilio: { voice_minute_outbound: 0.02 } }) });
    getAllocatedRate('twilio', 'voice_minute_outbound');
    await jest.advanceTimersByTimeAsync(0);
    mockGetSetting.mockClear();

    jest.advanceTimersByTime(59_000);
    getAllocatedRate('twilio', 'voice_minute_outbound');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetSetting).not.toHaveBeenCalled();

    jest.advanceTimersByTime(2_000);
    getAllocatedRate('twilio', 'voice_minute_outbound');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    mockGetSetting.mockResolvedValue(null);
    getAllocatedRate('twilio', 'voice_minute_outbound');
    getAllocatedRate('twilio', 'number_monthly_rent');
    await refreshVendorRateOverrides();
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good overrides when a refresh errors, and does not throw', async () => {
    mockGetSetting.mockResolvedValueOnce({ settingValue: stored({ twilio: { voice_minute_outbound: 0.02 } }) });
    await refreshVendorRateOverrides();
    jest.advanceTimersByTime(61_000);
    mockGetSetting.mockRejectedValueOnce(new Error('dynamo down'));
    expect(() => getAllocatedRate('twilio', 'voice_minute_outbound')).not.toThrow();
    await refreshVendorRateOverrides();
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.02);
  });

  it('gives up on a stalled read and keeps pricing from the card', async () => {
    mockGetSetting.mockReturnValue(new Promise(() => undefined));
    const done = refreshVendorRateOverrides();
    await jest.advanceTimersByTimeAsync(2_000);
    await done;
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.014);
  });

  it('drops overrides when the stored row is removed or corrupt', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetSetting.mockResolvedValueOnce({ settingValue: stored({ twilio: { voice_minute_outbound: 0.02 } }) });
    await refreshVendorRateOverrides();
    mockGetSetting.mockResolvedValueOnce({ settingValue: '{garbage' });
    await refreshVendorRateOverrides();
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.014);
  });

  it('a local apply (admin PUT) is not clobbered by an older in-flight read', async () => {
    let release!: (v: unknown) => void;
    mockGetSetting.mockReturnValue(new Promise((r) => { release = r; }));
    const slow = refreshVendorRateOverrides();
    applyVendorRateOverridesLocally(
      parseVendorRateOverrides(stored({ twilio: { voice_minute_outbound: 0.05 } })),
    );
    release(null); // the stale read says "no overrides"
    await slow;
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.05);
  });
});
