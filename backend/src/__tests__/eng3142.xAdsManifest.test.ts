/**
 * ENG-3142 — X Ads toolkit manifest + reads: curated surface, honest annotations, and
 * synchronous stats split into <=7-day windows and merged. X is faked at the HTTP boundary.
 */
import {
  assertXAdsToolkitCall, chunkDateRange, executeXAdsRead, getXAdsToolkitManifest, mergeStatsWindows, X_ADS_TOOL_NAMES,
} from '../mcp/xAdsToolkitManifest';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { annotateToolkitTools, getToolkitToolAnnotations } from '../mcp/toolkitToolAnnotations';

const credentials = { consumerKey: 'ck', consumerSecret: 'cs', token: 't', tokenSecret: 'ts' };
const ok = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body) });

describe('ENG-3142 X Ads manifest', () => {
  it('advertises exactly x_ads_read and x_ads_write with closed schemas', () => {
    const tools = getXAdsToolkitManifest();
    expect(tools.map((t) => t.name)).toEqual([...X_ADS_TOOL_NAMES]);
    for (const t of tools) expect(t.inputSchema.additionalProperties).toBe(false);
    expect(tools[1].description).toMatch(/PAUSED/);
    expect(tools[1].description).toMatch(/preview_token/);
  });

  it('annotations: x_ads_read is read-only; x_ads_write is a destructive write', () => {
    expect(getToolkitToolAnnotations('x_ads_read')).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(getToolkitToolAnnotations('x_ads_write')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotateToolkitTools(getXAdsToolkitManifest()).every((t) => t.annotations)).toBe(true);
  });

  it('refuses anything outside the surface', () => {
    expect(() => assertXAdsToolkitCall('x_ads_delete', {})).toThrow(MetaToolkitRefusal);
    expect(() => assertXAdsToolkitCall('x_ads_read', { action: 'DELETE_CAMPAIGN' })).toThrow(MetaToolkitRefusal);
    expect(() => assertXAdsToolkitCall('x_ads_write', { entity_type: 'CAMPAIGN', action: 'DELETE' })).toThrow(MetaToolkitRefusal);
    expect(() => assertXAdsToolkitCall('x_ads_write', { entity_type: 'PROMOTED_TWEET', action: 'ACTIVATE' })).toThrow(MetaToolkitRefusal);
    expect(() => assertXAdsToolkitCall('x_ads_write', { entity_type: 'LINE_ITEM', action: 'ACTIVATE' })).not.toThrow();
  });
});

describe('ENG-3142 X Ads stats windows', () => {
  it('splits a range into <=7-day windows (end exclusive)', () => {
    expect(chunkDateRange('2026-11-01', '2026-11-08')).toEqual([{ start: '2026-11-01', end: '2026-11-08' }]);
    expect(chunkDateRange('2026-10-01', '2026-10-31')).toEqual([
      { start: '2026-10-01', end: '2026-10-08' },
      { start: '2026-10-08', end: '2026-10-15' },
      { start: '2026-10-15', end: '2026-10-22' },
      { start: '2026-10-22', end: '2026-10-29' },
      { start: '2026-10-29', end: '2026-10-31' },
    ]);
  });

  it('refuses bad, inverted or over-90-day ranges', () => {
    expect(() => chunkDateRange('2026/11/01', '2026-11-08')).toThrow(MetaToolkitRefusal);
    expect(() => chunkDateRange('2026-11-08', '2026-11-01')).toThrow(MetaToolkitRefusal);
    expect(() => chunkDateRange('2026-01-01', '2026-06-01')).toThrow(/90 days/);
  });

  it('merges DAY series in order and sums TOTAL; all-null stays null', () => {
    const w1 = { data: [{ id: 'c1', id_data: [{ metrics: { impressions: [10, 20], billed_charge_local_micro: [1000000, null], likes: null } }] }] };
    const w2 = { data: [{ id: 'c1', id_data: [{ metrics: { impressions: [5], billed_charge_local_micro: [500000], likes: null } }] }] };
    expect(mergeStatsWindows([w1, w2], 'DAY')).toEqual([{ id: 'c1', metrics: { impressions: [10, 20, 5], billed_charge_local_micro: [1000000, null, 500000], likes: [null, null] } }]);
    expect(mergeStatsWindows([w1, w2], 'TOTAL')).toEqual([{ id: 'c1', metrics: { impressions: 35, billed_charge_local_micro: 1500000, likes: null } }]);
  });
});

describe('ENG-3142 executeXAdsRead', () => {
  it('GET_STATS over 10 days makes two signed, sequential 7-day requests and merges them', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(ok({ data: [{ id: 'c1', id_data: [{ metrics: { impressions: Array(7).fill(1) } }] }] }))
      .mockResolvedValueOnce(ok({ data: [{ id: 'c1', id_data: [{ metrics: { impressions: [2, 2, 2] } }] }] }));
    const result = await executeXAdsRead(
      { action: 'GET_STATS', entity: 'CAMPAIGN', entity_ids: ['c1'], start_date: '2026-11-01', end_date: '2026-11-11', granularity: 'TOTAL' },
      { accountId: 'acc1', credentials, fetchImpl },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map(([u]) => new URL(u));
    expect(urls[0].pathname).toBe('/12/stats/accounts/acc1');
    expect(urls.map((u) => [u.searchParams.get('start_time'), u.searchParams.get('end_time')])).toEqual([['2026-11-01', '2026-11-08'], ['2026-11-08', '2026-11-11']]);
    expect(urls[0].searchParams.get('metric_groups')).toBe('ENGAGEMENT,BILLING');
    expect(urls[0].searchParams.get('placement')).toBe('ALL_ON_TWITTER');
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toMatch(/oauth_token="t"/);
    expect(result).toMatchObject({ success: true, windows: 2, data: [{ id: 'c1', metrics: { impressions: 13 } }] });
  });

  it('GET_STATS refuses more than 20 ids before calling X', async () => {
    const fetchImpl = jest.fn();
    await expect(executeXAdsRead(
      { action: 'GET_STATS', entity: 'CAMPAIGN', entity_ids: Array.from({ length: 21 }, (_, i) => `c${i}`), start_date: '2026-11-01', end_date: '2026-11-02' },
      { accountId: 'acc1', credentials, fetchImpl },
    )).rejects.toThrow(MetaToolkitRefusal);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('LIST_CAMPAIGNS follows next_cursor on the resolved account only', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(ok({ data: [{ id: 'c1' }], next_cursor: 'cur2' }))
      .mockResolvedValueOnce(ok({ data: [{ id: 'c2' }], next_cursor: null }));
    const result = await executeXAdsRead({ action: 'LIST_CAMPAIGNS' }, { accountId: 'acc1', credentials, fetchImpl });
    expect(result).toMatchObject({ count: 2, data: [{ id: 'c1' }, { id: 'c2' }] });
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get('cursor')).toBe('cur2');
    expect(fetchImpl.mock.calls.every(([u]) => u.startsWith('https://ads-api.x.com/12/accounts/acc1/campaigns'))).toBe(true);
  });
});
