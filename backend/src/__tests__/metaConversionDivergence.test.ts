/**
 * ENG-926 §F — "daily job comparing CRM conversions against Meta-attributed conversions;
 * alert on divergence."
 *
 * The card notes this "becomes straightforward once the relay in C exists, because we
 * finally have two independent counts to compare. Today we have one number and no way to
 * know whether it is real." That is exactly the shape here: what §C recorded itself as
 * having sent, against what Meta's pixel says it received.
 *
 * ─── Two decisions that look like details and are not ───────────────────────────────
 *
 * TOTALS over a window, never per-day buckets. Meta's `/stats` returns hourly buckets
 * stamped in the AD ACCOUNT's timezone — a live probe came back `+0530` — while our own
 * timestamps are UTC. Bucketing per day across that offset would report a divergence
 * every single day from nothing but arithmetic. Totals sidestep the offset entirely and
 * still answer the question that matters: did what we sent arrive.
 *
 * ONE rule, not a tuned ratio: we sent a meaningful number and Meta received NONE of them.
 * §C's post-mortem is explicit that tuning a threshold was the wrong move three times
 * running and stating the invariant was right. Zero-arrival cannot be produced by
 * reporting lag, timezone slop, or sampling — it means the events are not landing.
 */

import {
  evaluateDivergence,
  DIVERGENCE_MIN_SAMPLE,
  countPixelRelayEvents,
  countLoggedRelaysInWindow,
} from '../services/metaConversionDivergence';

describe('evaluateDivergence', () => {
  it('reports a blackout when we sent conversions and Meta received none', () => {
    const verdict = evaluateDivergence(DIVERGENCE_MIN_SAMPLE, 0);
    expect(verdict.status).toBe('not-arriving');
    expect(verdict.crmSent).toBe(DIVERGENCE_MIN_SAMPLE);
    expect(verdict.metaSeen).toBe(0);
  });

  it('says nothing when the counts agree', () => {
    expect(evaluateDivergence(10, 10).status).toBe('ok');
  });

  it('says nothing when Meta received MORE than we sent', () => {
    // Meta counts browser events on the same pixel that we never relayed, so its number
    // being larger is normal and is not evidence of anything.
    expect(evaluateDivergence(5, 40).status).toBe('ok');
  });

  it('says nothing about a partial shortfall', () => {
    // A partial gap is exactly what reporting lag, a timezone offset and Meta's own
    // sampling all produce. Alerting on it would be alerting on arithmetic, and §C's
    // post-mortem records that tuning this kind of threshold was wrong three times over.
    expect(evaluateDivergence(100, 40).status).toBe('ok');
  });

  it('withholds judgement below the minimum sample', () => {
    // One conversion that has not shown up yet is not a signal; it is a coin flip.
    const verdict = evaluateDivergence(DIVERGENCE_MIN_SAMPLE - 1, 0);
    expect(verdict.status).toBe('insufficient-data');
  });

  it('withholds judgement when nothing was sent at all', () => {
    // The relay is off for every customer today, so this is the case that must stay
    // silent rather than reporting a healthy comparison that never happened.
    expect(evaluateDivergence(0, 0).status).toBe('insufficient-data');
  });
});

describe('countPixelRelayEvents', () => {
  /** The window both sides of the comparison must share. */
  const WINDOW = { sinceMs: Date.parse('2026-08-08T12:00:00Z'), untilMs: Date.parse('2026-08-14T12:00:00Z') };

  const statsResponse = (buckets: any[], next?: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: buckets, ...(next ? { paging: { next } } : {}) }),
  });

  /** Shape copied from a real probe of pixel 1012387921717047 (2026-08-15). */
  const bucket = (startTime: string, events: Array<[string, number]>) => ({
    start_time: startTime,
    aggregation: 'event',
    data: events.map(([value, count]) => ({ value, count })),
  });

  it('counts only the events the relay emits, ignoring browser traffic on the same pixel', async () => {
    // The same pixel carries PageView and browser Lead events. Counting those would mask a
    // total failure of the relay behind unrelated traffic.
    const fetchImpl = jest.fn().mockResolvedValue(
      statsResponse([
        bucket('2026-08-15T02:30:00+0530', [
          ['Purchase', 1],
          ['QualifiedLead', 1],
          ['PageView', 200],
          ['Lead', 17],
        ]),
      ]),
    );

    const total = await countPixelRelayEvents('px1', 'tok', ['Purchase', 'QualifiedLead'], WINDOW, {
      fetchImpl,
    } as any);

    expect(total).toBe(2);
  });

  it('sums across hourly buckets', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      statsResponse([
        bucket('2026-08-15T02:30:00+0530', [['Purchase', 1]]),
        bucket('2026-08-15T15:30:00+0530', [['Purchase', 4], ['CRMWonDeal', 2]]),
      ]),
    );

    const total = await countPixelRelayEvents('px1', 'tok', ['Purchase', 'CRMWonDeal'], WINDOW, {
      fetchImpl,
    } as any);

    expect(total).toBe(7);
  });

  it('counts a renamed event when that is what the account emits', async () => {
    // The per-account override means the name is not fixed; comparing against a hardcoded
    // 'Purchase' would report a total blackout for any account that renamed it.
    const fetchImpl = jest.fn().mockResolvedValue(
      statsResponse([bucket('2026-08-15T02:30:00+0530', [['CRMPurchase', 3]])]),
    );

    expect(await countPixelRelayEvents('px1', 'tok', ['CRMPurchase'], WINDOW, { fetchImpl } as any)).toBe(3);
  });

  it('follows pagination', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(statsResponse([bucket('t1', [['Purchase', 2]])], 'https://next'))
      .mockResolvedValueOnce(statsResponse([bucket('t2', [['Purchase', 3]])]));

    expect(await countPixelRelayEvents('px1', 'tok', ['Purchase'], WINDOW, { fetchImpl } as any)).toBe(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null rather than 0 when the pixel cannot be read', async () => {
    // 0 means "Meta received nothing", which is an alert. "We could not ask" is not, and
    // collapsing the two would fire a blackout alert every time a token expires.
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad token', code: 190 } }),
    });

    expect(await countPixelRelayEvents('px1', 'tok', ['Purchase'], WINDOW, { fetchImpl } as any)).toBeNull();
  });

  it('returns null on a thrown network error', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    expect(await countPixelRelayEvents('px1', 'tok', ['Purchase'], WINDOW, { fetchImpl } as any)).toBeNull();
  });

  it('treats an empty stats response as zero received, which IS a signal', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(statsResponse([]));
    expect(await countPixelRelayEvents('px1', 'tok', ['Purchase'], WINDOW, { fetchImpl } as any)).toBe(0);
  });

  it('never puts the access token in a value it returns', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(statsResponse([]));
    await countPixelRelayEvents('px1', 'super-secret', ['Purchase'], WINDOW, { fetchImpl } as any);
    expect(fetchImpl.mock.calls[0][0]).toContain('px1');
  });

  it('bounds the request to the SAME window the CRM side counts', async () => {
    // Without this the two counts cover different periods: the CRM side is bounded to
    // seven days ending at the lag boundary while /stats, given no bounds, returns its own
    // default range. Comparing them is meaningless in both directions — it can hide a real
    // blackout behind older traffic, or invent one. Greptile caught this on #2413.
    const fetchImpl = jest.fn().mockResolvedValue(statsResponse([]));

    await countPixelRelayEvents('px1', 'tok', ['Purchase'], WINDOW, { fetchImpl } as any);

    const url = fetchImpl.mock.calls[0][0] as string;
    // Seconds, not milliseconds — Meta's stats endpoint takes unix seconds.
    expect(url).toContain(`start_time=${Math.floor(WINDOW.sinceMs / 1000)}`);
    expect(url).toContain(`end_time=${Math.floor(WINDOW.untilMs / 1000)}`);
  });

  it('uses start_time/end_time, never since/until', async () => {
    // Probed live against pixel 1012387921717047 (2026-08-15): `start_time`/`end_time`
    // returned 17 hourly buckets across the requested seven days, while `since`/`until`
    // returned the same 7 buckets as passing no bounds at all — silently ignored, exactly
    // like a bogus parameter name. Guessing here would have failed without an error.
    const fetchImpl = jest.fn().mockResolvedValue(statsResponse([]));

    await countPixelRelayEvents('px1', 'tok', ['Purchase'], WINDOW, { fetchImpl } as any);

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).not.toContain('since=');
    expect(url).not.toContain('until=');
  });
});

describe('countLoggedRelaysInWindow — destination scoping', () => {
  const W = { since: Date.parse('2026-08-08T00:00:00Z'), until: Date.parse('2026-08-14T00:00:00Z') };
  const entry = (at: string, pixel?: string) => ({ kind: 'won', at, ...(pixel ? { pixel } : {}) });
  const count = (log: any[], pixel: string) =>
    countLoggedRelaysInWindow({ metaConversionsSentLog: log }, W.since, W.until, pixel);

  it('counts sends that went to the pixel being compared', () => {
    expect(count([entry('2026-08-10T00:00:00Z', 'px1'), entry('2026-08-11T00:00:00Z', 'px1')], 'px1')).toBe(2);
  });

  it('EXCLUDES sends that went to a different pixel', () => {
    // A customer who connects a second ad account, or changes which is default, would
    // otherwise have history compared against a pixel it never reached — reported as a
    // blackout on a perfectly healthy relay (Greptile on #2413).
    expect(count([entry('2026-08-10T00:00:00Z', 'px-other')], 'px1')).toBe(0);
  });

  it('counts an entry with no recorded pixel', () => {
    // Rows written before the destination was recorded. None exist in production — the
    // relay is enabled for nobody — but dropping them would silently undercount rather
    // than fail loudly, and undercounting is what produces a false blackout.
    expect(count([entry('2026-08-10T00:00:00Z')], 'px1')).toBe(1);
  });

  it('still excludes entries outside the window regardless of pixel', () => {
    expect(count([entry('2026-01-01T00:00:00Z', 'px1')], 'px1')).toBe(0);
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────────────

import {
  checkUserConversionDivergence,
  __resetDivergenceAlertStateForTests,
} from '../services/metaConversionDivergence';

const relayUser = (enabled: boolean, eventNames?: any) => ({
  userId: 'u1',
  email: 'owner@example.com',
  connected_accounts: [
    {
      platform: 'meta',
      account_id: 'acct1',
      config: {
        account_type: 'ad_account',
        access_token: 'tok',
        crmConversionRelayEnabled: enabled,
        ...(eventNames ? { crmConversionEventNames: eventNames } : {}),
      },
    },
  ],
});

const NOW = Date.parse('2026-08-15T12:00:00Z');
/** Inside the window: older than the 24h lag boundary, newer than 7 days before it. */
const IN_WINDOW = '2026-08-11T12:00:00Z';
/** Too recent — Meta has not necessarily reported it yet. */
const TOO_RECENT = '2026-08-15T06:00:00Z';

const leadWithRelays = (timestamps: string[]) => ({
  leadId: 'lead-1',
  metaConversionsSentLog: timestamps.map((at) => ({ kind: 'won', at })),
});

let alerts: any[];
let divDeps: any;

beforeEach(() => {
  __resetDivergenceAlertStateForTests();
  alerts = [];
  divDeps = {
    getLeadLists: jest.fn().mockResolvedValue([{ listId: 'L1' }]),
    getLeads: jest.fn().mockResolvedValue({ items: [], lastEvaluatedKey: null }),
    resolvePixel: jest.fn().mockResolvedValue({ pixelId: 'px1', accountId: 'acct1' }),
    getCredentials: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
    countPixelEvents: jest.fn().mockResolvedValue(0),
    alertTransport: async (subject: string, message: string, context: any) => {
      alerts.push({ subject, message, context });
    },
    now: NOW,
  };
});

describe('checkUserConversionDivergence — scope', () => {
  it('does nothing at all for a customer who has not enabled the relay', async () => {
    // Silent by construction rather than by accident. This is every customer today, and a
    // comparison against events we never sent would be noise on every single run.
    const result = await checkUserConversionDivergence(relayUser(false), divDeps);

    expect(result.status).toBe('skipped');
    expect(divDeps.getLeadLists).not.toHaveBeenCalled();
    expect(divDeps.countPixelEvents).not.toHaveBeenCalled();
    expect(alerts).toHaveLength(0);
  });

  it('does nothing when the pixel cannot be resolved', async () => {
    divDeps.resolvePixel.mockResolvedValue({ unresolved: true, reason: 'no pixel' });
    const result = await checkUserConversionDivergence(relayUser(true), divDeps);
    expect(result.status).toBe('skipped');
    expect(alerts).toHaveLength(0);
  });
});

describe('checkUserConversionDivergence — the comparison', () => {
  it('alerts when relayed conversions are not reaching Meta', async () => {
    divDeps.getLeads.mockResolvedValue({
      items: [leadWithRelays([IN_WINDOW, IN_WINDOW, IN_WINDOW])],
      lastEvaluatedKey: null,
    });
    divDeps.countPixelEvents.mockResolvedValue(0);

    const result = await checkUserConversionDivergence(relayUser(true), divDeps);

    expect(result.status).toBe('not-arriving');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].context['Alert Class']).toBe('meta-conversion-divergence');
  });

  it('stays silent when Meta received them', async () => {
    divDeps.getLeads.mockResolvedValue({
      items: [leadWithRelays([IN_WINDOW, IN_WINDOW, IN_WINDOW])],
      lastEvaluatedKey: null,
    });
    divDeps.countPixelEvents.mockResolvedValue(3);

    const result = await checkUserConversionDivergence(relayUser(true), divDeps);

    expect(result.status).toBe('ok');
    expect(alerts).toHaveLength(0);
  });

  it('ignores conversions too recent for Meta to have reported', async () => {
    divDeps.getLeads.mockResolvedValue({
      items: [leadWithRelays([TOO_RECENT, TOO_RECENT, TOO_RECENT])],
      lastEvaluatedKey: null,
    });

    const result = await checkUserConversionDivergence(relayUser(true), divDeps);

    // Counted as nothing sent, so no conclusion — rather than three sent and none seen,
    // which would alert on reporting lag every single day.
    expect(result.status).toBe('insufficient-data');
    expect(alerts).toHaveLength(0);
  });

  it('asks Meta for the account\'s OWN event names, not the defaults', async () => {
    divDeps.getLeads.mockResolvedValue({
      items: [leadWithRelays([IN_WINDOW, IN_WINDOW, IN_WINDOW])],
      lastEvaluatedKey: null,
    });

    await checkUserConversionDivergence(relayUser(true, { won: 'CRMPurchase' }), divDeps);

    const names = divDeps.countPixelEvents.mock.calls[0][2];
    expect(names).toContain('CRMPurchase');
    expect(names).not.toContain('Purchase');
  });

  it('never alerts when the pixel could not be read', async () => {
    // null is "we could not ask", not "Meta received nothing". Treating them alike would
    // fire a blackout alert every time a token expired.
    divDeps.getLeads.mockResolvedValue({
      items: [leadWithRelays([IN_WINDOW, IN_WINDOW, IN_WINDOW])],
      lastEvaluatedKey: null,
    });
    divDeps.countPixelEvents.mockResolvedValue(null);

    const result = await checkUserConversionDivergence(relayUser(true), divDeps);

    expect(result.status).toBe('unknown');
    expect(alerts).toHaveLength(0);
  });

  it('does not re-alert inside the dedupe window', async () => {
    divDeps.getLeads.mockResolvedValue({
      items: [leadWithRelays([IN_WINDOW, IN_WINDOW, IN_WINDOW])],
      lastEvaluatedKey: null,
    });

    await checkUserConversionDivergence(relayUser(true), divDeps);
    await checkUserConversionDivergence(relayUser(true), { ...divDeps, now: NOW + 60 * 60 * 1000 });

    expect(alerts).toHaveLength(1);
  });

  it('survives an unreadable lead list without alerting on a partial count', async () => {
    // A half-read CRM produces an undercount, and an undercount compared against Meta is
    // a manufactured divergence.
    divDeps.getLeads.mockRejectedValue(new Error('dynamo down'));

    const result = await checkUserConversionDivergence(relayUser(true), divDeps);

    expect(result.status).toBe('unknown');
    expect(alerts).toHaveLength(0);
  });
});
