/**
 * ENG-926 §F — send-side CAPI identity-key coverage, queryable and trending.
 *
 * These tests pin the decisions that make the number trustworthy, not just the arithmetic.
 * Each one exists because getting it wrong produces a plausible number that is wrong:
 *
 *  - `null` vs `0` coverage, because 0% is an alarm and "nothing sent yet" is not
 *  - a pixel we could not READ is reported, never folded into a zero
 *  - an absent counter attribute reads as 0, so a new identity key needs no migration
 *  - the recorder can never turn a successful CAPI send into a failure
 */

import {
  CAPI_IDENTITY_KEYS,
  buildCoverageSortKey,
  parseCoverageSortKey,
  utcDateKey,
  aggregateCoverageRows,
  recordCapiKeySend,
  isEmptyEventStats,
  type CapiKeyCoverageRow,
} from '../services/metaCapiKeyCoverage';

/** 2026-08-19T10:00:00Z */
const NOW = Date.parse('2026-08-19T10:00:00.000Z');
const day = (n: number) => 86_400_000 * n;

function row(over: Partial<CapiKeyCoverageRow> = {}): CapiKeyCoverageRow {
  return {
    pixelId: '1430870751246428',
    date: '2026-08-19',
    eventName: 'Lead',
    sends: 10,
    em: 10,
    fbc: 6,
    ...over,
  } as CapiKeyCoverageRow;
}

describe('sort key', () => {
  it('round-trips date and event name', () => {
    const sk = buildCoverageSortKey('2026-08-19', 'Lead');
    expect(sk).toBe('2026-08-19#Lead');
    expect(parseCoverageSortKey(sk)).toEqual({ date: '2026-08-19', eventName: 'Lead' });
  });

  it('keeps a `#` inside an event name intact', () => {
    // Meta event names are customer-defined for custom conversions. Splitting on the LAST
    // separator instead of the first would corrupt any name containing one.
    const sk = buildCoverageSortKey('2026-08-19', 'Hubspot Form Completed #1');
    expect(parseCoverageSortKey(sk)).toEqual({
      date: '2026-08-19',
      eventName: 'Hubspot Form Completed #1',
    });
  });

  it('sorts lexically in chronological order, which is what makes a Query range work', () => {
    const keys = [
      buildCoverageSortKey('2026-08-09', 'Lead'),
      buildCoverageSortKey('2026-08-19', 'Lead'),
      buildCoverageSortKey('2026-08-02', 'Lead'),
    ];
    expect([...keys].sort()).toEqual([
      '2026-08-02#Lead',
      '2026-08-09#Lead',
      '2026-08-19#Lead',
    ]);
  });
});

describe('utcDateKey', () => {
  it('buckets in UTC, not local time', () => {
    // Our own clock, unlike Meta's /stats buckets which are stamped in the ad account's
    // timezone. Stating it in UTC is what keeps a day boundary meaningful across readers.
    expect(utcDateKey(Date.parse('2026-08-19T23:59:59.999Z'))).toBe('2026-08-19');
    expect(utcDateKey(Date.parse('2026-08-20T00:00:00.000Z'))).toBe('2026-08-20');
  });
});

describe('aggregateCoverageRows', () => {
  it('reports coverage as a ratio of sends carrying each key', () => {
    const out = aggregateCoverageRows([row({ sends: 10, em: 10, fbc: 6 })], 30, NOW);
    expect(out.totals.sends).toBe(10);
    expect(out.totals.coverage.em).toBe(1);
    expect(out.totals.coverage.fbc).toBe(0.6);
  });

  it('reports coverage as null — never 0 — when nothing was sent', () => {
    // 0% reads as "every send is missing this key", which is an alarm. "No sends yet" is
    // not, and the two must not render identically on a dashboard someone glances at.
    const out = aggregateCoverageRows([], 30, NOW);
    expect(out.totals.sends).toBe(0);
    for (const key of CAPI_IDENTITY_KEYS) {
      expect(out.totals.coverage[key]).toBeNull();
    }
  });

  it('treats an ABSENT counter attribute as 0, so a new identity key needs no migration', () => {
    // `external_id` and the geo fields are known gaps today. When they ship, historical rows
    // will not carry them, and 0 is the correct answer for a key we were not sending.
    const out = aggregateCoverageRows([row({ sends: 4, em: 4 })], 30, NOW);
    expect(out.totals.keys.fbp).toBe(0);
    expect(out.totals.coverage.fbp).toBe(0);
  });

  it('returns the daily series OLDEST-FIRST so a trend reads left to right', () => {
    // Same contract metaAttributionCoverage exposes; consumers depend on the ordering.
    const out = aggregateCoverageRows(
      [
        row({ date: '2026-08-19', sends: 1 }),
        row({ date: '2026-08-17', sends: 1 }),
        row({ date: '2026-08-18', sends: 1 }),
      ],
      30,
      NOW,
    );
    expect(out.daily.map((d) => d.date)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
  });

  it('sums rows that share a day across different event names', () => {
    const out = aggregateCoverageRows(
      [
        row({ date: '2026-08-19', eventName: 'Lead', sends: 3, em: 3, fbc: 3 }),
        row({ date: '2026-08-19', eventName: 'Schedule', sends: 1, em: 1, fbc: 0 }),
      ],
      30,
      NOW,
    );
    expect(out.daily).toHaveLength(1);
    expect(out.daily[0].sends).toBe(4);
    expect(out.daily[0].keys.fbc).toBe(3);
    expect(out.daily[0].coverage.fbc).toBe(0.75);
  });

  it('breaks down by event name, because one bad event type is invisible in the total', () => {
    const out = aggregateCoverageRows(
      [
        row({ eventName: 'Lead', sends: 9, em: 9, fbc: 9 }),
        row({ eventName: 'Schedule', sends: 1, em: 1, fbc: 0 }),
      ],
      30,
      NOW,
    );
    // Totals look healthy at 90%; the Schedule breakdown is where the problem shows.
    expect(out.totals.coverage.fbc).toBe(0.9);
    const schedule = out.byEvent.find((e) => e.eventName === 'Schedule');
    expect(schedule?.coverage.fbc).toBe(0);
  });

  it('excludes rows older than the window', () => {
    const out = aggregateCoverageRows(
      [
        row({ date: utcDateKey(NOW), sends: 1 }),
        row({ date: utcDateKey(NOW - day(40)), sends: 99 }),
      ],
      30,
      NOW,
    );
    expect(out.totals.sends).toBe(1);
  });

  it('never lets a key counter exceed the send count it is a ratio of', () => {
    // A corrupted or double-counted row would otherwise report >100% coverage, which reads
    // as nonsense rather than as the data problem it is.
    const out = aggregateCoverageRows([row({ sends: 2, em: 5 })], 30, NOW);
    expect(out.totals.coverage.em).toBeLessThanOrEqual(1);
  });
});

describe('recordCapiKeySend', () => {
  it('increments the send count and exactly the keys that went on the wire', async () => {
    const calls: any[] = [];
    await recordCapiKeySend(
      { pixelId: 'px1', eventName: 'Lead', keys: ['em', 'fbc'], nowMs: NOW },
      { addCounters: async (a) => { calls.push(a); } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      pixelId: 'px1',
      sortKey: '2026-08-19#Lead',
      increments: { sends: 1, em: 1, fbc: 1 },
    });
    // Keys that were NOT sent must not appear at all — writing a 0 would be indistinguishable
    // from a send that carried the key with an empty value.
    expect(Object.keys(calls[0].increments)).toEqual(['sends', 'em', 'fbc']);
  });

  it('ignores a key that is not a known CAPI identity field', async () => {
    const calls: any[] = [];
    await recordCapiKeySend(
      { pixelId: 'px1', eventName: 'Lead', keys: ['em', 'not_a_real_key'], nowMs: NOW },
      { addCounters: async (a) => { calls.push(a); } },
    );
    expect(Object.keys(calls[0].increments)).toEqual(['sends', 'em']);
  });

  it('still records the send when NO identity keys were present', async () => {
    // A send with no identity is the most important one to count: it is the denominator
    // that makes every coverage ratio fall.
    const calls: any[] = [];
    await recordCapiKeySend(
      { pixelId: 'px1', eventName: 'Lead', keys: [], nowMs: NOW },
      { addCounters: async (a) => { calls.push(a); } },
    );
    expect(calls[0].increments).toEqual({ sends: 1 });
  });

  it('NEVER throws when the store is unavailable — a metrics failure must not fail a send', async () => {
    // This is the load-bearing one. recordCapiKeySend is called immediately after Meta has
    // ACCEPTED a conversion; throwing here would turn a successful, already-delivered
    // conversion into a reported failure and, on the relay path, a retry.
    await expect(
      recordCapiKeySend(
        { pixelId: 'px1', eventName: 'Lead', keys: ['em'], nowMs: NOW },
        { addCounters: async () => { throw new Error('ResourceNotFoundException'); } },
      ),
    ).resolves.toBeUndefined();
  });

  it('defaults a missing event name to Lead rather than writing an empty bucket', async () => {
    const calls: any[] = [];
    await recordCapiKeySend(
      { pixelId: 'px1', eventName: undefined, keys: ['em'], nowMs: NOW },
      { addCounters: async (a) => { calls.push(a); } },
    );
    expect(calls[0].sortKey).toBe('2026-08-19#Lead');
  });
});

describe('isEmptyEventStats', () => {
  // Meta's `event_stats` field is what the shipped `DATASET GET_MATCH_QUALITY` tool returns,
  // and on live busy pixels it comes back EMPTY — probed on two pixels, two tokens, two
  // Business Managers. The tool has therefore been answering "{}" to every customer who asked
  // Emma for match quality. Detecting that reliably is what lets us answer with something real
  // instead, so each shape Meta has actually been observed returning is pinned here.

  it('treats the STRING "{}" as empty — Meta returns it as a string, not an object', () => {
    expect(isEmptyEventStats('{}')).toBe(true);
    expect(isEmptyEventStats('  {}  ')).toBe(true);
  });

  it('treats an empty object as empty', () => {
    expect(isEmptyEventStats({})).toBe(true);
  });

  it('treats an empty array as empty', () => {
    expect(isEmptyEventStats([])).toBe(true);
  });

  it('treats absent values as empty', () => {
    expect(isEmptyEventStats(undefined)).toBe(true);
    expect(isEmptyEventStats(null)).toBe(true);
    expect(isEmptyEventStats('')).toBe(true);
  });

  it('treats REAL stats as non-empty, so a working pixel is never overridden', () => {
    // The whole point of keeping the Meta call: if Meta ever starts serving this, we surface
    // the real number rather than our substitute.
    expect(isEmptyEventStats({ Lead: { match_quality: 7.2 } })).toBe(false);
    expect(isEmptyEventStats('{"Lead":{"match_quality":7.2}}')).toBe(false);
    expect(isEmptyEventStats([{ event: 'Lead' }])).toBe(false);
  });

  it('treats an unparseable string as NON-empty rather than guessing', () => {
    // Failing closed here would silently replace a response we simply could not read with our
    // own numbers, presenting a parse failure as a measurement.
    expect(isEmptyEventStats('not json')).toBe(false);
  });
});
