import { runInsights, createInsightsReport, getInsightsReportStatus, getInsightsReportRows, parseInsightsParams, __resetInsightsReportsForTests } from '../../services/sandbox/insightsEngine';
import { computeShiftDays } from '../../services/sandbox/dateShift';
import { EMPTY_OVERLAY } from '../../services/sandbox/types';
import { buildFixtureDataset, fixtureTotal, fixtureActionTotal, FIXTURE_IDS, FIXTURE_ACCOUNT_ID, AGE_GENDER_BUCKETS } from './fixtures/fixtureDataset';

/**
 * ENG-1908 AC 2: insights payloads must match what the product parses from a real account —
 * string metrics, actions[] with the lead-family aliases, date_start/date_stop, names — and
 * totals must reconcile to the dataset.
 */
const dataset = buildFixtureDataset();
const now = new Date('2026-09-13T15:00:00Z');
const shift = computeShiftDays(dataset.meta.frozenWindow.until, now); // 135 → window is 2026-08-22..2026-09-12
const cents = (n: number) => (n / 100).toFixed(2);
const base = { node: { kind: 'account' as const, id: FIXTURE_ACCOUNT_ID }, breakdowns: [] as string[], actionBreakdowns: [] as string[], filtering: [] as any[] };
const params = (o: Record<string, unknown>) => ({ ...base, ...o }) as any;

beforeEach(() => __resetInsightsReportsForTests());

describe('insights engine — sync', () => {
  it('account-level totals over the whole (shifted) window reconcile to the dataset and are strings', () => {
    const res = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'account', fields: ['account_id', 'account_name', 'impressions', 'clicks', 'spend', 'reach', 'ctr', 'cpc', 'cpm', 'frequency', 'actions', 'cost_per_action_type', 'inline_link_clicks'],
      timeRange: { since: '2026-08-22', until: '2026-09-12' } }), shift, now);
    expect(res.paging).toEqual({ cursors: { before: 'MAAZDZD', after: 'MjQZD' } });
    expect(res.data).toHaveLength(1);
    const row = res.data[0] as any;
    const impressions = fixtureTotal(dataset, 'impressions'), clicks = fixtureTotal(dataset, 'clicks'), spend = fixtureTotal(dataset, 'spend');
    expect(row).toMatchObject({ account_id: FIXTURE_ACCOUNT_ID, account_name: 'AgentWeb Sandbox', date_start: '2026-08-22', date_stop: '2026-09-12',
      impressions: String(impressions), clicks: String(clicks), spend: cents(spend), inline_link_clicks: String(fixtureTotal(dataset, 'inline_link_clicks')) });
    expect(Number(row.reach)).toBeGreaterThan(0);
    expect(Number(row.reach)).toBeLessThan(fixtureTotal(dataset, 'reach'));
    expect(row.ctr).toBe((clicks / impressions * 100).toFixed(6));
    expect(row.cpc).toBe((spend / 100 / clicks).toFixed(6));
    expect(row.cpm).toBe((spend / 100 / impressions * 1000).toFixed(6));
    expect(row.frequency).toBe((impressions / Number(row.reach)).toFixed(6));
    const leads = fixtureActionTotal(dataset, 'lead');
    expect(row.actions).toEqual(expect.arrayContaining([
      { action_type: 'lead', value: String(leads) }, { action_type: 'offsite_conversion.fb_pixel_lead', value: String(leads) },
      { action_type: 'link_click', value: String(fixtureActionTotal(dataset, 'link_click')) },
    ]));
    expect(row.cost_per_action_type).toEqual(expect.arrayContaining([{ action_type: 'lead', value: (spend / 100 / leads).toFixed(6) }]));
    expect(Object.values(row).every(v => typeof v === 'string' || Array.isArray(v))).toBe(true);
  });

  it('campaign level yields one row per campaign with names, omits all-zero entities, and honours the last_7d preset', () => {
    const res = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id', 'campaign_name', 'spend', 'impressions', 'objective'], datePreset: 'last_7d' }), shift, now);
    // last_7d = 2026-09-06..2026-09-12 → frozen 2026-04-24..2026-04-30: the TRAFFIC campaign was paused on day 10 (2026-04-19), so only two campaigns have rows.
    expect(res.data.map((r: any) => r.campaign_id).sort()).toEqual([FIXTURE_IDS.campaigns[0], FIXTURE_IDS.campaigns[1]].sort());
    const first = res.data.find((r: any) => r.campaign_id === FIXTURE_IDS.campaigns[0]) as any;
    expect(first).toMatchObject({ campaign_name: 'Founder Demos — Lead Gen', objective: 'OUTCOME_LEADS', date_start: '2026-09-06', date_stop: '2026-09-12' });
    const adIds = dataset.ads.filter(a => a.campaign_id === FIXTURE_IDS.campaigns[0]).map(a => a.id);
    const rows = dataset.insightsDaily.filter(r => adIds.includes(r.ad_id) && r.date >= '2026-04-24' && r.date <= '2026-04-30');
    expect(first.spend).toBe(cents(rows.reduce((n, r) => n + r.spend, 0)));
    expect(first.impressions).toBe(String(rows.reduce((n, r) => n + r.impressions, 0)));
  });

  it('time_increment=1 returns one shifted row per day per entity, sorted by date then id', () => {
    const res = runInsights(dataset, EMPTY_OVERLAY, params({ node: { kind: 'ad', id: FIXTURE_IDS.ads[0] }, level: 'ad', fields: ['ad_id', 'spend'], timeRange: { since: '2026-09-10', until: '2026-09-12' }, timeIncrement: 1 }), shift, now);
    expect(res.data.map((r: any) => [r.date_start, r.date_stop])).toEqual([['2026-09-10', '2026-09-10'], ['2026-09-11', '2026-09-11'], ['2026-09-12', '2026-09-12']]);
    expect((res.data[0] as any).ad_id).toBe(FIXTURE_IDS.ads[0]);
  });

  it('filtering: campaign.id IN scopes rows; campaign.name CONTAIN is case-insensitive; NOT_IN excludes', () => {
    const inRes = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id'], filtering: [{ field: 'campaign.id', operator: 'IN', value: [FIXTURE_IDS.campaigns[1]] }], datePreset: 'maximum' }), shift, now);
    expect(inRes.data.map((r: any) => r.campaign_id)).toEqual([FIXTURE_IDS.campaigns[1]]);
    const containRes = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id'], filtering: [{ field: 'campaign.name', operator: 'CONTAIN', value: 'blog' }], datePreset: 'maximum' }), shift, now);
    expect(containRes.data.map((r: any) => r.campaign_id)).toEqual([FIXTURE_IDS.campaigns[2]]);
    const notIn = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id'], filtering: [{ field: 'campaign.id', operator: 'NOT_IN', value: [FIXTURE_IDS.campaigns[0], FIXTURE_IDS.campaigns[1]] }], datePreset: 'maximum' }), shift, now);
    expect(notIn.data.map((r: any) => r.campaign_id)).toEqual([FIXTURE_IDS.campaigns[2]]);
  });

  it('breakdowns come from the dataset breakdown rows, carry campaign_id, and sum back to the level total', () => {
    const total = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id', 'impressions', 'spend'], datePreset: 'maximum', filtering: [{ field: 'campaign.id', operator: 'IN', value: [FIXTURE_IDS.campaigns[0]] }] }), shift, now).data[0] as any;
    const res = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id', 'impressions', 'spend'], breakdowns: ['age', 'gender'], datePreset: 'maximum', filtering: [{ field: 'campaign.id', operator: 'IN', value: [FIXTURE_IDS.campaigns[0]] }] }), shift, now);
    expect(res.data).toHaveLength(AGE_GENDER_BUCKETS.length);
    expect(res.data.every((r: any) => r.campaign_id === FIXTURE_IDS.campaigns[0] && typeof r.age === 'string' && typeof r.gender === 'string')).toBe(true);
    expect(res.data.reduce((n: number, r: any) => n + Number(r.impressions), 0)).toBe(Number(total.impressions));
    expect(res.data.reduce((n: number, r: any) => n + Math.round(Number(r.spend) * 100), 0)).toBe(Math.round(Number(total.spend) * 100));
    // A dimension without dataset rows is allocated deterministically and still sums to the total.
    const device = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id', 'impressions'], breakdowns: ['impression_device'], datePreset: 'maximum', filtering: [{ field: 'campaign.id', operator: 'IN', value: [FIXTURE_IDS.campaigns[0]] }] }), shift, now);
    expect(device.data.length).toBeGreaterThan(1);
    expect(device.data.reduce((n: number, r: any) => n + Number(r.impressions), 0)).toBe(Number(total.impressions));
  });

  it('rejects a breakdowns list whose cartesian product would exceed the bucket cap (CodeRabbit, ENG-1908)', () => {
    // breakdowns is a plain caller-controlled list with no dedup — repeating one dimension
    // many times drives the same unbounded multiplication a listing of many distinct
    // dimensions would (age has 6 buckets; 6^5 = 7776 > the cap), and this synchronous
    // aggregation runs inside the request handler on a shared process, so it must reject
    // before doing that work rather than after building millions of rows.
    expect(() => runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id', 'impressions'], breakdowns: ['age', 'age', 'age', 'age', 'age'], datePreset: 'maximum' }), shift, now))
      .toThrow(expect.objectContaining({ graphError: expect.objectContaining({ code: 100 }) }));
    // A legitimate two-dimension request (already covered above) is nowhere near the cap and still works.
    expect(() => runInsights(dataset, EMPTY_OVERLAY, params({ level: 'campaign', fields: ['campaign_id', 'impressions'], breakdowns: ['age', 'gender'], datePreset: 'maximum' }), shift, now)).not.toThrow();
  });

  it('emits only requested fields (unknown ones are dropped, like the product-only aliases leads/cost_per_lead), never a window with no rows, and honours limit', () => {
    const res = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'ad', fields: ['ad_id', 'spend', 'not_a_real_field', 'leads', 'cost_per_lead'], datePreset: 'maximum', limit: 2 }), shift, now);
    expect(res.data).toHaveLength(2);
    expect(Object.keys(res.data[0]).sort()).toEqual(['ad_id', 'date_start', 'date_stop', 'spend']);
    expect(res.paging.cursors.after).not.toBe('MjQZD'); // more rows exist beyond the page
    const empty = runInsights(dataset, EMPTY_OVERLAY, params({ level: 'ad', fields: ['spend'], timeRange: { since: '2026-01-01', until: '2026-01-31' } }), shift, now);
    expect(empty.data).toEqual([]);
  });

  it('an overlay object created by the candidate has no delivery and therefore no rows', () => {
    const overlay = { ...EMPTY_OVERLAY, campaigns: { '120210000000009999': { ...dataset.campaigns[0], id: '120210000000009999', name: 'Candidate campaign' } } };
    const res = runInsights(dataset, overlay, params({ level: 'campaign', fields: ['campaign_id'], datePreset: 'maximum' }), shift, now);
    expect(res.data.some((r: any) => r.campaign_id === '120210000000009999')).toBe(false);
  });

  it("accepts real Meta's single-quoted time_range shape, exactly as routes/meta.ts and agentModeService.ts build it for a real account (ENG-1912 production proof)", () => {
    const parsed = parseInsightsParams(
      { time_range: "{'since':'2026-08-01','until':'2026-08-31'}", fields: 'spend' },
      { kind: 'account', id: FIXTURE_ACCOUNT_ID },
    );
    expect(parsed.timeRange).toEqual({ since: '2026-08-01', until: '2026-08-31' });
  });

  it('still rejects genuinely malformed time_range, not just any single-quoted string', () => {
    expect(() => parseInsightsParams(
      { time_range: "{'since':'not-a-date','until':'2026-08-31'}", fields: 'spend' },
      { kind: 'account', id: FIXTURE_ACCOUNT_ID },
    )).toThrow(/time_range/);
  });
});

describe('insights engine — async report flow', () => {
  it('creates a report whose status is immediately complete and whose rows equal the sync result', () => {
    const p = params({ level: 'campaign', fields: ['campaign_id', 'spend', 'actions'], datePreset: 'last_30d' });
    const sync = runInsights(dataset, EMPTY_OVERLAY, p, shift, now);
    const { report_run_id } = createInsightsReport(dataset, EMPTY_OVERLAY, p, shift, now);
    expect(report_run_id).toMatch(/^\d{15,20}$/);
    expect(getInsightsReportStatus(report_run_id, now)).toMatchObject({ id: report_run_id, account_id: FIXTURE_ACCOUNT_ID, async_status: 'Job Completed', async_percent_completion: 100, is_running: false, date_start: '2026-08-14', date_stop: '2026-09-12' });
    expect(getInsightsReportRows(report_run_id, now)).toEqual(sync);
  });
  it('expires after ten minutes and answers unknown ids with a Graph code 100 error', () => {
    const { report_run_id } = createInsightsReport(dataset, EMPTY_OVERLAY, params({ level: 'account', fields: ['spend'], datePreset: 'last_7d' }), shift, now);
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    expect(() => getInsightsReportStatus(report_run_id, later)).toThrow(expect.objectContaining({ graphError: expect.objectContaining({ code: 100 }) }));
    expect(() => getInsightsReportRows('1', now)).toThrow(expect.objectContaining({ graphError: expect.objectContaining({ code: 100 }) }));
  });
  it('paginates report rows with offset cursors and a next link when asked', () => {
    const { report_run_id } = createInsightsReport(dataset, EMPTY_OVERLAY, params({ level: 'ad', fields: ['ad_id', 'spend'], datePreset: 'maximum' }), shift, now);
    const first = getInsightsReportRows(report_run_id, now, { limit: 4, nextUrl: (after) => `https://graph.facebook.com/v25.0/${report_run_id}/insights?limit=4&after=${after}` });
    expect(first.data).toHaveLength(4);
    expect(first.paging.next).toContain('after=');
    const second = getInsightsReportRows(report_run_id, now, { limit: 4, after: first.paging.cursors.after });
    expect(second.data).toHaveLength(2);
    expect(second.paging.next).toBeUndefined();
    expect([...first.data, ...second.data].map((r: any) => r.ad_id)).toEqual(FIXTURE_IDS.ads);
  });
});

it('ENG-2025 repeated exposure is deduplicated across days, not summed as new people', () => {
  const d = buildFixtureDataset();
  const row = d.insightsDaily[0];
  d.insightsDaily = Array.from({ length: 14 }, (_, i) => ({ ...row, date: `2026-04-${String(10 + i).padStart(2, '0')}`, impressions: 100, reach: 80 }));
  const read = (since: string) => runInsights(d, EMPTY_OVERLAY, params({ fields: ['reach', 'frequency', 'impressions'], timeRange: { since, until: '2026-04-23' } }), 0, now).data[0] as any;
  const seven = read('2026-04-17'), fourteen = read('2026-04-10');
  expect(Number(fourteen.reach)).toBeGreaterThan(Number(seven.reach));
  expect(Number(fourteen.reach)).toBeLessThan(1120);
  expect(Number(fourteen.frequency)).toBeGreaterThan(Number(seven.frequency));
  expect(Number(fourteen.frequency)).toBeCloseTo(1400 / Number(fourteen.reach), 5);
});

it('modeled reach reconciles across breakdowns and does not change when a dimension is filtered', () => {
  const fields = ['impressions', 'reach', 'frequency'];
  const total = runInsights(dataset, EMPTY_OVERLAY, params({ fields, datePreset: 'maximum' }), shift, now).data[0] as any;
  const split = runInsights(dataset, EMPTY_OVERLAY, params({ fields, breakdowns: ['age', 'gender'], datePreset: 'maximum' }), shift, now).data as any[];
  expect(split.reduce((n, r) => n + Number(r.reach), 0)).toBe(Number(total.reach));
  const female = runInsights(dataset, EMPTY_OVERLAY, params({ fields, breakdowns: ['age', 'gender'], datePreset: 'maximum', filtering: [{ field: 'gender', operator: 'EQUAL', value: 'female' }] }), shift, now).data;
  expect(female).toEqual(split.filter(r => r.gender === 'female'));
});
