/**
 * ENG-3133 — the two data readers the weekly email stands on, tested for real (the main suite mocks them):
 * the per-day Meta insights read (`runZomaAdsDaily`, real code against a fake Graph) and the all-users usage query
 * of the real event store (the real paging code against a fake DynamoDB client).
 */
const mockQuery = jest.fn();
jest.mock('aws-sdk', () => {
  const actual = jest.requireActual('aws-sdk');
  const DynamoDB = Object.assign(jest.fn(), actual.DynamoDB, {
    DocumentClient: jest.fn().mockImplementation(() => ({ query: (...a: any[]) => mockQuery(...a), put: jest.fn(), get: jest.fn() })),
  });
  return { ...actual, DynamoDB };
});

import { runZomaAdsDaily } from '../mcp/zomaAdsReport';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { getMcpUsageByUser } from '../services/mcpUsageEventsService';

const account: any = { config: { access_token: 'TOKEN', currency: 'EUR' } };
const RANGE = { since: '2026-11-09', until: '2026-11-22' };
const respond = (body: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const graph = (pages: any[]) => {
  const calls: string[] = [];
  let i = 0;
  const deps: any = { graphBaseUrl: 'https://graph.test/v1/', fetch: jest.fn(async (url: string) => { calls.push(url); return pages[i++] ?? respond({ data: [] }); }) };
  return { calls, deps };
};
const row = (date: string, spend: string, extra: Record<string, unknown> = {}) => ({ date_start: date, date_stop: date, spend, impressions: '1000', clicks: '20', account_currency: 'USD', ...extra });
const purchase = (n: string, value: string) => ({ actions: [{ action_type: 'purchase', value: n }], action_values: [{ action_type: 'purchase', value }] });

describe('runZomaAdsDaily', () => {
  it('asks Meta for one account-level row per day over exactly the requested window', async () => {
    const { calls, deps } = graph([respond({ data: [] })]);
    await runZomaAdsDaily(account, '123', RANGE, deps);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://graph.test/v1/act_123/insights');
    const q = url.searchParams;
    expect(q.get('level')).toBe('account');
    expect(q.get('time_increment')).toBe('1');
    expect(JSON.parse(q.get('time_range')!)).toEqual(RANGE);
    expect(q.get('limit')).toBe('100');
    expect(q.get('access_token')).toBe('TOKEN');
    for (const field of ['spend', 'impressions', 'clicks', 'actions', 'action_values', 'account_currency']) expect(q.get('fields')!.split(',')).toContain(field);
  });

  it('parses each day to numbers, oldest first, with the conversion count and value of the chosen event', async () => {
    const { deps } = graph([respond({ data: [
      row('2026-11-12', '20.456', purchase('3', '90.5')),
      row('2026-11-10', '10', { impressions: '500', clicks: '5' }),
    ] })]);
    const out = await runZomaAdsDaily(account, '123', RANGE, deps);
    expect(out).toMatchObject({ account_id: '123', currency: 'USD', conversion_event: 'purchase' });
    expect(out.rows).toEqual([
      { date: '2026-11-10', spend: 10, impressions: 500, clicks: 5, conversions: 0, conversion_value: 0 },
      { date: '2026-11-12', spend: 20.46, impressions: 1000, clicks: 20, conversions: 3, conversion_value: 90.5 },
    ]);
  });

  it('chooses ONE conversion event for the whole window, so the two weeks compare like with like', async () => {
    const { deps } = graph([respond({ data: [
      row('2026-11-10', '10', purchase('2', '40')),
      row('2026-11-18', '10', { actions: [{ action_type: 'lead', value: '9' }] }), // a different event on another day is not mixed in
    ] })]);
    const out = await runZomaAdsDaily(account, '123', RANGE, deps);
    expect(out.conversion_event).toBe('purchase');
    expect(out.rows.map((r) => r.conversions)).toEqual([2, 0]);
  });

  it('falls back to leads when there are no purchases, and has no event at all when nothing converted', async () => {
    const lead = graph([respond({ data: [row('2026-11-10', '10', { actions: [{ action_type: 'lead', value: '2' }] })] })]);
    expect(await runZomaAdsDaily(account, '123', RANGE, lead.deps)).toMatchObject({ conversion_event: 'lead', rows: [{ conversions: 2, conversion_value: 0 }] });
    const none = graph([respond({ data: [row('2026-11-10', '10')] })]);
    expect(await runZomaAdsDaily(account, '123', RANGE, none.deps)).toMatchObject({ conversion_event: null, rows: [{ conversions: 0 }] });
    const empty = graph([respond({ data: [] })]);
    expect(await runZomaAdsDaily(account, '123', RANGE, empty.deps)).toMatchObject({ conversion_event: null, rows: [] });
  });

  it('follows paging to the end, using the exact next link Meta returns', async () => {
    const { calls, deps } = graph([
      respond({ data: [row('2026-11-10', '1')], paging: { next: 'https://graph.test/v1/next-page?cursor=abc' } }),
      respond({ data: [row('2026-11-11', '2')] }),
    ]);
    const out = await runZomaAdsDaily(account, '123', RANGE, deps);
    expect(calls[1]).toBe('https://graph.test/v1/next-page?cursor=abc');
    expect(out.rows.map((r) => r.date)).toEqual(['2026-11-10', '2026-11-11']);
  });

  it('refuses an endless paging chain instead of looping', async () => {
    const pages = Array.from({ length: 20 }, () => respond({ data: [row('2026-11-10', '1')], paging: { next: 'https://graph.test/v1/more' } }));
    await expect(runZomaAdsDaily(account, '123', RANGE, graph(pages).deps)).rejects.toThrow(/more daily rows than expected/);
  });

  it('ignores a row with no usable date, and falls back to the account currency when Meta gives none', async () => {
    const { deps } = graph([respond({ data: [{ spend: '5', impressions: '1', clicks: '1' }, { date_start: 'garbage', spend: '5' }, { date_start: '2026-11-10', spend: '7', impressions: '1', clicks: '1' }] })]);
    const out = await runZomaAdsDaily(account, '123', RANGE, deps);
    expect(out.rows.map((r) => r.date)).toEqual(['2026-11-10']);
    expect(out.currency).toBe('EUR');
  });

  it('turns Meta failures into plain refusals that say nothing was changed', async () => {
    const expired = graph([respond({ error: { code: 190, message: 'Invalid OAuth access token' } }, 400)]);
    await expect(runZomaAdsDaily(account, '123', RANGE, expired.deps)).rejects.toThrow(/expired or was revoked/);
    const other = graph([respond({ error: { code: 4, message: 'Application request limit reached' } }, 400)]);
    await expect(runZomaAdsDaily(account, '123', RANGE, other.deps)).rejects.toThrow(/Application request limit reached, code 4.*Nothing was changed/);
    const down = graph([respond({}, 503)]);
    await expect(runZomaAdsDaily(account, '123', RANGE, down.deps)).rejects.toThrow(/HTTP 503/);
    const html = graph([{ ok: false, status: 502, json: async () => { throw new Error('not json'); } }]);
    await expect(runZomaAdsDaily(account, '123', RANGE, html.deps)).rejects.toThrow(/unreadable report \(HTTP 502\)/);
    const shape = graph([respond({ nope: true })]);
    await expect(runZomaAdsDaily(account, '123', RANGE, shape.deps)).rejects.toThrow(/without data rows/);
    await expect(runZomaAdsDaily(account, '123', RANGE, graph([respond({ error: { code: 190 } }, 400)]).deps)).rejects.toBeInstanceOf(MetaToolkitRefusal);
  });

  it('refuses bad windows and a missing token before any request', async () => {
    const { calls, deps } = graph([]);
    for (const bad of [{ since: '2026-11-22', until: '2026-11-09' }, { since: '11/09/2026', until: '2026-11-22' }, { since: '2026-11-09', until: 'x' }, { since: '2026-10-01', until: '2026-11-22' }]) {
      await expect(runZomaAdsDaily(account, '123', bad, deps)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    }
    await expect(runZomaAdsDaily({ config: {} } as any, '123', RANGE, deps)).rejects.toThrow(/no usable access token/);
    expect(calls).toHaveLength(0);
  });

  it('accepts a window of exactly 31 days', async () => {
    const { deps } = graph([respond({ data: [] })]);
    await expect(runZomaAdsDaily(account, '123', { since: '2026-10-23', until: '2026-11-22' }, deps)).resolves.toMatchObject({ rows: [] });
  });
});

describe('the real event store: one range query for every user', () => {
  const START = '2026-11-16T16:00:00.000Z';
  const END = '2026-11-23T16:00:00.000Z';
  const item = (subjectId: string, ts: string, product = 'zoma') => ({ loopId: 'emma-mcp', tsSession: `${ts}#${subjectId}`, eventType: 'mcp_tool_used', subjectId, ts, dimensions: { product } });
  beforeEach(() => mockQuery.mockReset());

  it('asks for the whole window of the one partition, follows LastEvaluatedKey to the end, and groups what comes back', async () => {
    const query = mockQuery;
    query.mockImplementation((params: any) => ({
      promise: async () => (params.ExclusiveStartKey
        ? { Items: [item('u2', '2026-11-19T10:00:00.000Z'), item('u1', '2026-11-20T10:00:00.000Z', 'emma_mcp')] }
        : { Items: [item('u1', '2026-11-18T10:00:00.000Z')], LastEvaluatedKey: { loopId: 'emma-mcp', tsSession: 'resume-here' } }),
    }));
    const byUser = await getMcpUsageByUser({ start: START, end: END }, { product: 'zoma' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toMatchObject({
      KeyConditionExpression: 'loopId = :loopId AND tsSession BETWEEN :start AND :end',
      ExpressionAttributeValues: { ':loopId': 'emma-mcp', ':start': START, ':end': END },
    });
    expect((query.mock.calls[0][0] as any).ExclusiveStartKey).toBeUndefined();
    expect((query.mock.calls[1][0] as any).ExclusiveStartKey).toEqual({ loopId: 'emma-mcp', tsSession: 'resume-here' });
    expect([...byUser.keys()].sort()).toEqual(['u1', 'u2']);
    expect(byUser.get('u1')!.toolCalls).toBe(1); // the emma_mcp row of u1 is not a Zoma call
    expect(byUser.get('u2')!.toolCalls).toBe(1);
  });

  it('an empty window is an empty map, and a failing query fails the pass (nobody is emailed on a guess)', async () => {
    mockQuery.mockImplementation(() => ({ promise: async () => ({ Items: [] }) }));
    expect((await getMcpUsageByUser({ start: START, end: END }, { product: 'zoma' })).size).toBe(0);
    mockQuery.mockImplementation(() => ({ promise: async () => { throw new Error('ProvisionedThroughputExceededException'); } }));
    await expect(getMcpUsageByUser({ start: START, end: END }, { product: 'zoma' })).rejects.toThrow('ProvisionedThroughputExceededException');
  });
});
