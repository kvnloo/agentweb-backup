/**
 * ENG-926 §F — fetching a run of daily rows for one ad account.
 *
 * The dead-token case is the reason this layer has its own status rather than returning an
 * empty array. A token that has expired produces no rows, and no rows looks exactly like
 * "this account is idle" — so a monitor that swallowed the error would report a healthy
 * silence for an account it can no longer see at all. That is the same failure the card
 * was written about, rebuilt inside the thing meant to prevent it.
 *
 * This is not hypothetical: `act_1916400978974090` on the production account carried a
 * dead token when this was written (verified 2026-08-15, `code: 190`,
 * `error_subcode: 460`, "the session has been invalidated because the user changed their
 * password"). The error body asserted below is that real response, copied verbatim.
 */

import { fetchDailyAdAccountActivity } from '../services/metaTrackingMonitor';

const okResponse = (rows: any[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: rows }),
});

const errorResponse = (error: any, status = 400) => ({
  ok: false,
  status,
  json: async () => ({ error }),
});

/** The exact Graph error returned by a Meta account whose token has been invalidated. */
const DEAD_TOKEN_ERROR = {
  message:
    'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.',
  type: 'OAuthException',
  code: 190,
  error_subcode: 460,
};

describe('fetchDailyAdAccountActivity', () => {
  it('turns raw insight rows into classified days', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse([
        {
          date_start: '2026-06-08',
          spend: '199.96',
          actions: [
            { action_type: 'lead', value: '17' },
            { action_type: 'offsite_conversion.fb_pixel_lead', value: '17' },
            { action_type: 'link_click', value: '152' },
          ],
        },
      ]),
    );

    const result = await fetchDailyAdAccountActivity('123', 'tok', 7, { fetchImpl } as any);

    expect(result.status).toBe('ok');
    expect(result.days).toEqual([
      { date: '2026-06-08', spend: 199.96, conversions: 17, unrecognized: [] },
    ]);
  });

  it('requests daily granularity and the actions field — without both, AC4 is impossible', async () => {
    // `getInsights` in metaService requests neither, which is why businessFunnelService's
    // lead count is structurally always zero. Pinning it here so the same omission cannot
    // silently happen again.
    const fetchImpl = jest.fn().mockResolvedValue(okResponse([]));
    await fetchDailyAdAccountActivity('123', 'tok', 7, { fetchImpl } as any);

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('time_increment=1');
    expect(url).toContain('actions');
    expect(url).toContain('act_123');
  });

  it('never puts the access token in a logged URL string', async () => {
    // The URL ends up in error logs on failure. A token in a log is a credential leak.
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(DEAD_TOKEN_ERROR));
    const result = await fetchDailyAdAccountActivity('123', 'super-secret-token', 7, {
      fetchImpl,
    } as any);
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('reports a dead token as its own status, never as an empty result', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(errorResponse(DEAD_TOKEN_ERROR));
    const result = await fetchDailyAdAccountActivity('123', 'tok', 7, { fetchImpl } as any);

    expect(result.status).toBe('token_error');
    expect(result.days).toEqual([]);
    expect(result.error).toContain('session has been invalidated');
  });

  it('treats any OAuthException as a token problem, not just subcode 460', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      errorResponse({ message: 'Session has expired', type: 'OAuthException', code: 190 }),
    );
    expect((await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any)).status).toBe(
      'token_error',
    );
  });

  it('separates a transient Graph failure from a dead token', async () => {
    // One is a configuration fact needing a human; the other resolves itself. Reporting a
    // rate limit as a dead token would send someone to re-authorise for no reason.
    const fetchImpl = jest.fn().mockResolvedValue(
      errorResponse({ message: 'User request limit reached', type: 'OAuthException', code: 17 }, 500),
    );
    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.status).toBe('fetch_error');
  });

  it('survives a thrown network error rather than aborting the sweep', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.status).toBe('fetch_error');
    expect(result.days).toEqual([]);
  });

  it('returns ok with no days for an account that has never spent', async () => {
    // Both of the development account's ad accounts return exactly this, at every window
    // including `date_preset=maximum`. It is not an error and must not read as one.
    const fetchImpl = jest.fn().mockResolvedValue(okResponse([]));
    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.status).toBe('ok');
    expect(result.days).toEqual([]);
  });

  it('tolerates a row with no actions array at all', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(okResponse([{ date_start: '2026-06-01', spend: '10.00' }]));
    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.days[0]).toEqual({
      date: '2026-06-01',
      spend: 10,
      conversions: 0,
      unrecognized: [],
    });
  });
});

describe('fetchDailyAdAccountActivity — objective filtering (2026-08-16)', () => {
  const campaignRow = (date: string, objective: string, spend: number, leads = 0) => ({
    date_start: date,
    objective,
    spend: String(spend),
    ...(leads ? { actions: [{ action_type: 'lead', value: String(leads) }] } : {}),
  });

  it('queries at CAMPAIGN level and asks for the objective', async () => {
    // Objective is not available at account level, and without it the check cannot tell
    // spend that was trying to convert from spend that never was.
    const fetchImpl = jest.fn().mockResolvedValue(okResponse([]));
    await fetchDailyAdAccountActivity('123', 'tok', 7, { fetchImpl } as any);

    const url = fetchImpl.mock.calls[0][0] as string;
    expect(url).toContain('level=campaign');
    expect(url).toContain('objective');
  });

  it('excludes engagement spend from the day totals — the Every.io case', async () => {
    // Five boosted posts, $597, no destination URL. Zero conversions is correct, not a
    // blackout. Counting that spend made this account alert for days.
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse([
        campaignRow('2026-08-14', 'OUTCOME_ENGAGEMENT', 139.89),
        campaignRow('2026-08-14', 'OUTCOME_ENGAGEMENT', 128.24),
      ]),
    );

    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);

    expect(result.days).toHaveLength(1);
    expect(result.days[0].spend).toBe(0);
    expect(result.excludedObjectives).toEqual(['OUTCOME_ENGAGEMENT']);
  });

  it('keeps conversion-optimised spend — the AgentWeb case', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse([campaignRow('2026-08-14', 'OUTCOME_LEADS', 175.57)]),
    );
    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.days[0].spend).toBeCloseTo(175.57, 2);
  });

  it('sums only the conversion campaigns when a day mixes both', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse([
        campaignRow('2026-08-14', 'OUTCOME_LEADS', 100, 3),
        campaignRow('2026-08-14', 'OUTCOME_ENGAGEMENT', 500),
      ]),
    );

    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);

    expect(result.days[0].spend).toBe(100);
    expect(result.days[0].conversions).toBe(3);
  });

  it('ignores conversions reported by a non-conversion campaign', async () => {
    // Counting them would let engagement spend mask a real blackout on the same account.
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse([
        campaignRow('2026-08-14', 'OUTCOME_LEADS', 100),
        campaignRow('2026-08-14', 'OUTCOME_ENGAGEMENT', 500, 9),
      ]),
    );

    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);

    expect(result.days[0].spend).toBe(100);
    expect(result.days[0].conversions).toBe(0);
  });

  it('keeps an UNKNOWN objective in scope, so a new Meta objective cannot mute a blackout', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      okResponse([campaignRow('2026-08-14', 'OUTCOME_INVENTED_2027', 50)]),
    );
    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.days[0].spend).toBe(50);
    expect(result.unknownObjectives).toEqual(['OUTCOME_INVENTED_2027']);
  });
});

describe('fetchDailyAdAccountActivity — pagination', () => {
  const page = (rows: any[], next?: string) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: rows, ...(next ? { paging: { next } } : {}) }),
  });
  const row = (date: string, objective: string, spend: number, leads = 0) => ({
    date_start: date, objective, spend: String(spend),
    ...(leads ? { actions: [{ action_type: 'lead', value: String(leads) }] } : {}),
  });

  it('follows paging.next — campaign level crosses page boundaries that account level did not', async () => {
    // Switching from level=account (7 rows for a week) to level=campaign multiplies rows by
    // the campaign count, so a real account spills past Meta's page size. Reading only the
    // first page silently drops spend AND conversions, producing a wrong verdict either
    // way. Greptile P1 on #2420.
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(page([row('2026-08-14', 'OUTCOME_LEADS', 100, 2)], 'https://next-page'))
      .mockResolvedValueOnce(page([row('2026-08-14', 'OUTCOME_LEADS', 50, 3)]));

    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.days).toHaveLength(1);
    expect(result.days[0].spend).toBe(150);
    expect(result.days[0].conversions).toBe(5);
  });

  it('merges days that arrive split across pages', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(page([row('2026-08-13', 'OUTCOME_LEADS', 10)], 'https://n'))
      .mockResolvedValueOnce(page([row('2026-08-14', 'OUTCOME_LEADS', 20)]));

    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.days.map((d: any) => d.date)).toEqual(['2026-08-13', '2026-08-14']);
  });

  it('carries excluded objectives across pages', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(page([row('2026-08-14', 'OUTCOME_ENGAGEMENT', 10)], 'https://n'))
      .mockResolvedValueOnce(page([row('2026-08-14', 'LINK_CLICKS', 20)]));

    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(result.excludedObjectives!.sort()).toEqual(['LINK_CLICKS', 'OUTCOME_ENGAGEMENT']);
  });

  it('stops at a page bound rather than following a pathological loop', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(page([row('2026-08-14', 'OUTCOME_LEADS', 1)], 'https://forever'));
    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(25);
    expect(result.status).toBe('ok');
  });

  it('a failure on a LATER page discards the whole read rather than reporting a partial one', async () => {
    // A partial window looks exactly like reduced spend, which is a wrong verdict rather
    // than a missing one. Same discipline as the coverage walk.
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(page([row('2026-08-14', 'OUTCOME_LEADS', 100, 5)], 'https://n'))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: { message: 'boom', code: 1 } }) });

    const result = await fetchDailyAdAccountActivity('1', 't', 7, { fetchImpl } as any);

    expect(result.status).toBe('fetch_error');
    expect(result.days).toEqual([]);
  });
});
