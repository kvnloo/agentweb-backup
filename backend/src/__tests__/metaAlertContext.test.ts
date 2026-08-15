/**
 * ENG-926 §F follow-up — what a tracking alert should actually say.
 *
 * The first real alert this system filed said: "Meta ad account 1358071355944019 spent with
 * zero attributed conversions." True, actionable in principle, and it took roughly ten API
 * calls to answer the questions it immediately raises — WHO is that, WHY is nothing
 * attributed, and WHAT should someone look at first. Every one of those answers was
 * available at the moment the alert fired.
 *
 * The rule this module follows: include what is EXPENSIVE for a reader to derive, and omit
 * what is cheap. Customer identity requires scanning users to map an ad-account id;
 * click-ID coverage requires walking every lead; Meta's match keys require knowing that
 * `/stats?aggregation=match_keys` exists at all. Those go in. Code pointers, the ENG-926
 * card text and Meta's documentation stay out — anyone reading the alert has those already.
 *
 * The hard constraint: enrichment is BEST EFFORT and must never prevent an alert. A
 * failure to look up the extra context is not a reason to stay silent about an account
 * burning money — the whole point of this system is that silence is the enemy.
 */

import {
  buildAlertContext,
  metaDeepLinks,
  ENRICHMENT_TIMEOUT_MS,
  MAX_PIXELS_DIAGNOSED,
} from '../services/metaAlertContext';

const owner = {
  userId: 'u-every',
  email: 'lyndi@every.io',
  company: 'Every.io',
  website: 'https://every.io',
};

const days = [
  { date: '2026-08-12', spend: 85.99, conversions: 0, unrecognized: [] },
  { date: '2026-08-13', spend: 120.71, conversions: 0, unrecognized: [] },
  { date: '2026-08-14', spend: 95.12, conversions: 0, unrecognized: [] },
];

const deps = (over: any = {}) => ({
  getCoverage: jest.fn().mockResolvedValue({
    totals: { leads: 8612, withClickId: 0, coverage: 0, undated: 0 },
    lists: [],
    daily: [],
    unreadableLists: [],
    windowDays: 30,
  }),
  getPixels: jest.fn().mockResolvedValue([
    { id: '1311221084072225', name: 'Every.io meta pixel', last_fired_time: '2026-08-14T19:59:40-0400' },
    { id: '1354983662931659', name: "Every.io's Pixel" },
  ]),
  getMatchKeys: jest.fn().mockResolvedValue({ Lead: { fr_cookie: 6, c_user_cookie: 6 } }),
  ...over,
});

describe('buildAlertContext — who is this', () => {
  it('names the customer, not just the ad account id', async () => {
    // Mapping an ad-account id to a customer means scanning AW-Users. Whoever opens the
    // ticket should not have to.
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(ctx['Owner Email']).toBe('lyndi@every.io');
    expect(ctx['Customer']).toBe('Every.io');
  });

  it('includes the customer domain when there is one', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(ctx['Customer Site']).toContain('every.io');
  });

  it('omits identity fields it does not have rather than printing undefined', async () => {
    const ctx = await buildAlertContext({ userId: 'u1' }, 'acct1', days, deps() as any);
    expect(ctx).not.toHaveProperty('Customer');
    expect(ctx).not.toHaveProperty('Customer Site');
    expect(JSON.stringify(ctx)).not.toContain('undefined');
  });
});

describe('buildAlertContext — why is nothing attributed', () => {
  it('carries click-ID coverage, the single most diagnostic number', async () => {
    // "0 of 8612" IS the diagnosis for a blackout: with no click id on the lead there is
    // nothing for Meta to attribute a conversion to.
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(String(ctx['Lead Click-ID Coverage'])).toContain('0 of 8612');
  });

  it('flags zero coverage explicitly rather than leaving a reader to spot the 0%', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(String(ctx['Lead Click-ID Coverage'])).toMatch(/no lead carries a click id/i);
  });

  it('reports the identity signals Meta actually received', async () => {
    // match_keys is how you tell "Meta got nothing to match on" from "Meta matched fine but
    // the ads are simply not converting" — two problems with opposite fixes.
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(String(ctx['Meta Match Keys'])).toContain('fr_cookie');
  });

  it('says so plainly when the pixel received no customer identity at all', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    // fr_cookie/c_user_cookie are Meta's OWN browser cookies, not identity we supplied.
    expect(String(ctx['Meta Match Keys'])).toMatch(/no identity we supplied/i);
  });

  it('does not raise that flag when we DID supply identity', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getMatchKeys: jest.fn().mockResolvedValue({ Purchase: { email: 4, fn: 4, fbc: 2 } }),
    } as any);
    expect(String(ctx['Meta Match Keys'])).not.toMatch(/no identity we supplied/i);
  });
});

describe('buildAlertContext — what to look at first', () => {
  it('lists the pixels on the account and which have never fired', async () => {
    // Two pixels where one has never fired is a live hypothesis for a total attribution
    // failure — the ads may be configured against the silent one.
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(String(ctx['Pixels On Account'])).toContain('1311221084072225');
    expect(String(ctx['Pixels On Account'])).toMatch(/never fired/i);
  });

  it('includes the per-day spend that triggered the alert', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(String(ctx['Spend By Day'])).toContain('2026-08-13');
    expect(String(ctx['Spend By Day'])).toContain('120.71');
  });

  it('includes deep links into Meta rather than an id to paste', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, deps() as any);
    expect(String(ctx['Meta Ads Manager'])).toContain('acct1');
    expect(String(ctx['Meta Events Manager'])).toContain('1311221084072225');
  });
});

describe('buildAlertContext — enrichment must never suppress the alert', () => {
  it('still returns context when coverage lookup throws', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getCoverage: jest.fn().mockRejectedValue(new Error('dynamo down')),
    } as any);
    expect(ctx['Owner Email']).toBe('lyndi@every.io');
    expect(ctx).not.toHaveProperty('Lead Click-ID Coverage');
  });

  it('still returns context when every enrichment throws', async () => {
    // The degraded alert is exactly today's alert. Losing the extras is acceptable;
    // losing the alert is not.
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      getCoverage: jest.fn().mockRejectedValue(new Error('x')),
      getPixels: jest.fn().mockRejectedValue(new Error('y')),
      getMatchKeys: jest.fn().mockRejectedValue(new Error('z')),
    } as any);
    expect(ctx['Ad Account']).toBe('acct1');
    expect(Object.keys(ctx).length).toBeGreaterThan(0);
  });

  it('never lets an access token reach the ticket', async () => {
    const ctx = await buildAlertContext(
      { ...owner, connected_accounts: [{ config: { access_token: 'super-secret-token' } }] },
      'acct1',
      days,
      deps() as any,
    );
    expect(JSON.stringify(ctx)).not.toContain('super-secret-token');
  });
});

describe('metaDeepLinks', () => {
  it('builds an ads manager link for the account', () => {
    expect(metaDeepLinks.adsManager('123')).toContain('123');
  });

  it('builds an events manager link for the pixel', () => {
    expect(metaDeepLinks.eventsManager('456')).toContain('456');
  });
});

describe('buildAlertContext — a hang must not stall the sweep', () => {
  // The try/catch guards against ERRORS. A Graph call that never settles is worse: it
  // freezes the sequential sweep, so every later account and every later user goes
  // unchecked while one hung request waits forever. fetch has no default timeout.
  const hang = () => new Promise(() => {});

  it('gives up on a lookup that never settles and still returns context', async () => {
    jest.useFakeTimers();
    const promise = buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getCoverage: jest.fn(hang),
    } as any);
    await jest.advanceTimersByTimeAsync(ENRICHMENT_TIMEOUT_MS + 100);
    const ctx = await promise;
    jest.useRealTimers();

    expect(ctx['Ad Account']).toBe('acct1');
    expect(ctx).not.toHaveProperty('Lead Click-ID Coverage');
  });

  it('still returns when EVERY lookup hangs', async () => {
    jest.useFakeTimers();
    const promise = buildAlertContext(owner, 'acct1', days, {
      getCoverage: jest.fn(hang),
      getPixels: jest.fn(hang),
      getMatchKeys: jest.fn(hang),
    } as any);
    await jest.advanceTimersByTimeAsync(ENRICHMENT_TIMEOUT_MS * 3 + 100);
    const ctx = await promise;
    jest.useRealTimers();

    expect(ctx['Owner Email']).toBe('lyndi@every.io');
    expect(ctx['Spend By Day']).toContain('2026-08-13');
  });
});

describe('buildAlertContext — pixel diagnostics must not misroute', () => {
  it('reports match keys for EVERY pixel that has fired, naming each', async () => {
    // Picking "the first pixel with a last_fired_time" attaches match keys and an Events
    // Manager link from a pixel that may have nothing to do with the ads — a confidently
    // wrong diagnosis is worse than none. Diagnose them all and label them.
    const getMatchKeys = jest.fn(async (pixelId: string) =>
      pixelId === 'px-old' ? { Lead: { fr_cookie: 2 } } : { Lead: { email: 9 } },
    );
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPixels: jest.fn().mockResolvedValue([
        { id: 'px-old', name: 'Old site pixel', last_fired_time: '2026-01-01T00:00:00-0400' },
        { id: 'px-live', name: 'Campaign pixel', last_fired_time: '2026-08-14T19:59:40-0400' },
      ]),
      getMatchKeys,
    } as any);

    expect(getMatchKeys).toHaveBeenCalledTimes(2);
    expect(String(ctx['Meta Match Keys'])).toContain('px-old');
    expect(String(ctx['Meta Match Keys'])).toContain('px-live');
  });

  it('does not claim "no identity supplied" when ANY fired pixel received identity', async () => {
    // The old single-pixel pick could land on a dead pixel and declare a diagnosis that
    // the live pixel contradicts.
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPixels: jest.fn().mockResolvedValue([
        { id: 'px-old', name: 'Old', last_fired_time: '2026-01-01T00:00:00-0400' },
        { id: 'px-live', name: 'Live', last_fired_time: '2026-08-14T19:59:40-0400' },
      ]),
      getMatchKeys: jest.fn(async (id: string) =>
        id === 'px-old' ? { Lead: { fr_cookie: 2 } } : { Lead: { email: 9 } },
      ),
    } as any);

    expect(String(ctx['Meta Match Keys'])).not.toMatch(/no identity we supplied/i);
  });

  it('skips pixels that have never fired — they have nothing to report', async () => {
    const getMatchKeys = jest.fn().mockResolvedValue({ Lead: { email: 1 } });
    await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPixels: jest.fn().mockResolvedValue([
        { id: 'px-live', last_fired_time: '2026-08-14T19:59:40-0400' },
        { id: 'px-dead' },
      ]),
      getMatchKeys,
    } as any);

    expect(getMatchKeys).toHaveBeenCalledTimes(1);
    expect(getMatchKeys).toHaveBeenCalledWith('px-live');
  });

  it('caps how many pixels it will diagnose', async () => {
    const many = Array.from({ length: MAX_PIXELS_DIAGNOSED + 4 }, (_, i) => ({
      id: `px${i}`,
      last_fired_time: '2026-08-14T19:59:40-0400',
    }));
    const getMatchKeys = jest.fn().mockResolvedValue({ Lead: { email: 1 } });
    await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPixels: jest.fn().mockResolvedValue(many),
      getMatchKeys,
    } as any);

    expect(getMatchKeys).toHaveBeenCalledTimes(MAX_PIXELS_DIAGNOSED);
  });

  it('links Events Manager for the most recently fired pixel', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPixels: jest.fn().mockResolvedValue([
        { id: 'px-old', last_fired_time: '2026-01-01T00:00:00-0400' },
        { id: 'px-live', last_fired_time: '2026-08-14T19:59:40-0400' },
      ]),
    } as any);
    expect(String(ctx['Meta Events Manager'])).toContain('px-live');
  });

  it('keeps the MOST RECENT pixels when capping, and links the newest of all', async () => {
    // Capping before sorting could discard the newest pixel and then link Events Manager
    // at a survivor — wrong dataset, on exactly the messy accounts where it matters.
    const pixels = [
      { id: 'px-oldest', last_fired_time: '2026-01-01T00:00:00-0400' },
      { id: 'px-old', last_fired_time: '2026-02-01T00:00:00-0400' },
      { id: 'px-older', last_fired_time: '2026-03-01T00:00:00-0400' },
      { id: 'px-newest', last_fired_time: '2026-08-14T19:59:40-0400' },
    ];
    const getMatchKeys = jest.fn().mockResolvedValue({ Lead: { email: 1 } });
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPixels: jest.fn().mockResolvedValue(pixels),
      getMatchKeys,
    } as any);

    expect(String(ctx['Meta Events Manager'])).toContain('px-newest');
    const diagnosed = getMatchKeys.mock.calls.map((c) => c[0]);
    expect(diagnosed).toContain('px-newest');
    expect(diagnosed).not.toContain('px-oldest');
    expect(diagnosed).toHaveLength(MAX_PIXELS_DIAGNOSED);
  });
});

describe('buildAlertContext — the configured pixel wins over recency', () => {
  // last_fired_time IGNORES CAPI (§10, ENG-941). A pixel taking only server-side
  // conversions can look stale or unfired while being the one the ads attribute through.
  const capiPixel = { id: 'px-capi', name: 'Attribution pixel' };
  const browserPixel = { id: 'px-browser', name: 'Old site pixel', last_fired_time: '2026-08-14T19:59:40-0400' };

  it('diagnoses the configured pixel even when Meta reports it as never fired', async () => {
    const getMatchKeys = jest.fn().mockResolvedValue({ Lead: { email: 5 } });
    await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPreferredPixelId: jest.fn().mockResolvedValue('px-capi'),
      getPixels: jest.fn().mockResolvedValue([browserPixel, capiPixel]),
      getMatchKeys,
    } as any);

    expect(getMatchKeys.mock.calls.map((c) => c[0])).toContain('px-capi');
  });

  it('links Events Manager at the configured pixel, not the most recently fired one', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPreferredPixelId: jest.fn().mockResolvedValue('px-capi'),
      getPixels: jest.fn().mockResolvedValue([browserPixel, capiPixel]),
    } as any);

    expect(String(ctx['Meta Events Manager'])).toContain('px-capi');
  });

  it('labels which pixel is the configured one', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPreferredPixelId: jest.fn().mockResolvedValue('px-capi'),
      getPixels: jest.fn().mockResolvedValue([browserPixel, capiPixel]),
      getMatchKeys: jest.fn().mockResolvedValue({ Lead: { email: 5 } }),
    } as any);

    expect(String(ctx['Meta Match Keys'])).toMatch(/px-capi.*configured attribution pixel/s);
  });

  it('never drops the configured pixel to the cap', async () => {
    const many = Array.from({ length: MAX_PIXELS_DIAGNOSED + 3 }, (_, i) => ({
      id: `px${i}`,
      last_fired_time: `2026-08-1${i}T00:00:00-0400`,
    }));
    const getMatchKeys = jest.fn().mockResolvedValue({ Lead: { email: 1 } });
    await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPreferredPixelId: jest.fn().mockResolvedValue('px-capi'),
      getPixels: jest.fn().mockResolvedValue([...many, capiPixel]),
      getMatchKeys,
    } as any);

    const diagnosed = getMatchKeys.mock.calls.map((c) => c[0]);
    expect(diagnosed).toContain('px-capi');
    expect(diagnosed).toHaveLength(MAX_PIXELS_DIAGNOSED);
  });

  it('falls back to recency when no configured pixel can be resolved', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPreferredPixelId: jest.fn().mockResolvedValue(undefined),
      getPixels: jest.fn().mockResolvedValue([
        { id: 'px-old', last_fired_time: '2026-01-01T00:00:00-0400' },
        { id: 'px-new', last_fired_time: '2026-08-14T19:59:40-0400' },
      ]),
    } as any);

    expect(String(ctx['Meta Events Manager'])).toContain('px-new');
  });

  it('still works when the resolver itself fails', async () => {
    const ctx = await buildAlertContext(owner, 'acct1', days, {
      ...deps(),
      getPreferredPixelId: jest.fn().mockRejectedValue(new Error('graph down')),
    } as any);

    expect(ctx['Ad Account']).toBe('acct1');
    expect(ctx['Meta Events Manager']).toBeDefined();
  });
});
