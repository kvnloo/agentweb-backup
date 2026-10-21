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
  rateCardVersionFor,
  isValidOverrideRate,
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
    expect(getAllocatedRateWithVersion('v0', 'landing_page_generation')?.version).toBe(VENDOR_RATE_CARD_VERSION);
  });
});

describe('parseVendorRateOverrides (fail safe)', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['null', null],
    ['string', '0.5'],
    ['above the cap', 10.01],
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

  it('does not echo stored text from an unparseable item', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    parseVendorRateOverrides('{"a":1,"b":SECRETSNIPPET}');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('SECRETSNIP');
  });

  it('warns without echoing values', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    parseVendorRateOverrides(stored({ twilio: { voice_minute_outbound: -7.77 } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('7.77');
  });

  it('keeps the audit fields when the last override has been removed', () => {
    const state = parseVendorRateOverrides(stored({}));
    expect(state).toEqual({ overrides: {}, updatedAt: T, updatedBy: 'admin-1' });
    expect(rateCardVersionFor(state)).toBe(VENDOR_RATE_CARD_VERSION);
  });
});

describe('version stamping and snapshot consistency', () => {
  it('is the plain version with no override and suffixed with updatedAt with one', () => {
    expect(getAllocatedRateWithVersion('twilio', 'voice_minute_outbound')?.version).toBe(VENDOR_RATE_CARD_VERSION);
    setVendorRateOverridesForTests({ twilio: { voice_minute_outbound: 0.02 } }, T);
    expect(getAllocatedRateWithVersion('twilio', 'voice_minute_outbound')?.version).toBe(`${VENDOR_RATE_CARD_VERSION}+ovr:${T}`);
  });

  it('an empty overrides object is not an active override', () => {
    setVendorRateOverridesForTests({});
    expect(getAllocatedRateWithVersion('twilio', 'voice_minute_outbound')?.version).toBe(VENDOR_RATE_CARD_VERSION);
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

  it('a boot-time refresh loads the override before the first lookup, with no further read', async () => {
    // server.ts awaits this before listen (verified by reading); this pins what that await buys.
    mockGetSetting.mockResolvedValue({ settingValue: stored({ twilio: { voice_minute_outbound: 0.02 } }) });
    await refreshVendorRateOverrides();
    expect(getAllocatedRate('twilio', 'voice_minute_outbound')).toBe(0.02);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
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

describe('6-decimal rule (a rate must never book as $0)', () => {
  it.each([0.000001, 0.014, 1.15, 10, 0.0125, 0.123456])('accepts %s', (v) => {
    expect(isValidOverrideRate(v)).toBe(true);
  });

  it.each([0.0000001, 1e-7, 5e-324, 0.0140004, 10.000001, 14, 0, -0.000001, NaN, Infinity, 10.01])(
    'rejects %s',
    (v) => {
      expect(isValidOverrideRate(v)).toBe(false);
    },
  );

  it('the load path drops a stored sub-micro rate', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseVendorRateOverrides(stored({ twilio: { voice_minute_outbound: 1e-7 } })).overrides).toEqual({});
  });
});

describe('cold start', () => {
  const realEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    setVendorRateOverridesForTests(null);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env.NODE_ENV = realEnv;
    jest.useRealTimers();
  });

  it('retries a failed first read after 5s, not a full TTL, and logs the failure once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetSetting.mockRejectedValue(new Error('down'));
    await refreshVendorRateOverrides();
    mockGetSetting.mockClear();

    jest.advanceTimersByTime(4_000);
    getAllocatedRate('twilio', 'voice_minute_outbound');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetSetting).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1_500);
    getAllocatedRate('twilio', 'voice_minute_outbound');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetSetting).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('could not read'))).toHaveLength(1);
  });

  it('after one good read a failed refresh waits the full TTL again', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await refreshVendorRateOverrides();
    jest.advanceTimersByTime(61_000);
    mockGetSetting.mockRejectedValue(new Error('down'));
    await refreshVendorRateOverrides();
    mockGetSetting.mockClear();
    jest.advanceTimersByTime(6_000);
    getAllocatedRate('twilio', 'voice_minute_outbound');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetSetting).not.toHaveBeenCalled();
  });

  it('a non-editable vendor never triggers a settings read', async () => {
    mockGetSetting.mockResolvedValue(null);
    getAllocatedRate('v0', 'landing_page_generation');
    getAllocatedRate('apollo', 'email_reveal');
    await jest.advanceTimersByTimeAsync(0);
    expect(mockGetSetting).not.toHaveBeenCalled();
  });
});
