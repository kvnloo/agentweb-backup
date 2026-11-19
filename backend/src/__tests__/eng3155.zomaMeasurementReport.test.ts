/**
 * ENG-3155 — proactive Zoma measurement reports.
 * Tool output (metrics, CRM leads, breakdowns, hosted HTML, industryBenchmark), the new-delivery caveat, the
 * engagement/link-clicks exclusion, auto-enrollment idempotency (in-memory store with the same conditional
 * semantics + the DynamoDB condition expressions), the exactly-once runner claim, and flag off = no-op.
 * Mock-only: no Meta, DynamoDB, S3 or mail.
 */
jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByIdConsistent: jest.fn(), updateUser: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn(async () => []), createAccount: jest.fn() }));
jest.mock('../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn(), getClient: jest.fn() } }));
jest.mock('../services/mcpUsageEventsService', () => ({
  recordMcpToolUse: jest.fn().mockResolvedValue(undefined),
  recordMcpWriteExecuted: jest.fn().mockResolvedValue(undefined),
  recordMcpToolFailed: jest.fn().mockResolvedValue(undefined),
  getMcpUserUsage: jest.fn(),
  getMcpUsageByUser: jest.fn(),
  hasZomaFunnelRow: jest.fn(),
  recordZomaBillingFunnel: jest.fn(),
  EMMA_MCP_LOOP_ID: 'emma-mcp',
  EVT_MCP_WRITE_EXECUTED: 'mcp_write_executed',
}));
jest.mock('../services/journeyMilestones', () => ({ noteProductUse: jest.fn(), noteSignup: jest.fn(), zomaMilestone: jest.fn() }));

import {
  buildZomaMeasurementReport,
  INDUSTRY_BENCHMARK_NA_LINE,
  measurementIndustryBenchmark,
  measurementFindings,
  NEW_DELIVERY_CAVEAT,
  renderMeasurementReportHtml,
  runZomaMeasurementReport,
  ZOMA_MEASUREMENT_REPORTS_FLAG,
  type MeasurementCampaign,
  type MeasurementReport,
  type MeasurementReportDeps,
} from '../mcp/zomaMeasurementReport';
import {
  DynamoZomaReportScheduleStore,
  enrollReportSchedule,
  firstReportAt,
  runZomaMeasurementReports,
  MEASUREMENT_UNSUBSCRIBE_CONTEXT,
  runZomaReportScheduleTool,
  scheduleNoticeText,
  stopAllReportSchedules,
  type MeasurementRunnerDeps,
  type ZomaReportSchedule,
  type ZomaReportScheduleStore,
} from '../mcp/zomaReportSchedule';
import { assertMetaToolkitV1Call, getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { zomaNextStep } from '../mcp/zomaNextStep';
import { signUnsubscribeToken, verifyUnsubscribeToken } from '../mcp/zomaWeeklyReport';
import { AUTONOMOUS_REPORT_WORKPLAN_STEPS } from '../scripts/seed-eng1880-autonomous-report-workplan';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-18T15:00:00Z');
const ON = { [ZOMA_MEASUREMENT_REPORTS_FLAG]: 'true' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

afterEach(() => {
  delete process.env[ZOMA_MEASUREMENT_REPORTS_FLAG];
});

// ---------------------------------------------------------------------------------------------
// In-memory store with the DynamoDB store's conditional semantics
// ---------------------------------------------------------------------------------------------

class MemoryStore implements ZomaReportScheduleStore {
  rows = new Map<string, ZomaReportSchedule>();
  private key = (u: string, a: string) => `${u}#${a}`;
  async get(u: string, a: string) { return this.rows.get(this.key(u, a)) ?? null; }
  async listForUser(u: string) { return [...this.rows.values()].filter((r) => r.userId === u); }
  async listDue(now: string) { return [...this.rows.values()].filter((r) => r.status === 'active' && r.nextReportAt <= now).map((r) => ({ ...r })); }
  async create(r: ZomaReportSchedule) {
    if (this.rows.has(this.key(r.userId, r.adAccountId))) return false;
    this.rows.set(this.key(r.userId, r.adAccountId), { ...r });
    return true;
  }
  async resumeDormant(u: string, a: string, l: string, n: string, now: string) {
    const r = this.rows.get(this.key(u, a));
    if (!r || r.status !== 'dormant') return false;
    Object.assign(r, { status: 'active', launchedAt: l, nextReportAt: n, updatedAt: now });
    return true;
  }
  async claimSlot(u: string, a: string, due: string, next: string, now: string) {
    const r = this.rows.get(this.key(u, a));
    if (!r || r.status !== 'active' || r.nextReportAt !== due) return false;
    Object.assign(r, { nextReportAt: next, lastClaimedSlot: due, updatedAt: now });
    return true;
  }
  async update(u: string, a: string, patch: Partial<ZomaReportSchedule>, now: string) {
    const r = this.rows.get(this.key(u, a));
    if (!r) return false;
    Object.assign(r, patch, { updatedAt: now });
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Report fixtures
// ---------------------------------------------------------------------------------------------

const account: any = { platform: 'meta', account_id: 'act_111', config: { account_type: 'ad_account', access_token: 'EAAG-secret', ad_account_id: '111' } };
const iso = (ms: number) => new Date(ms).toISOString();

function graph(handlers: Record<string, any>) {
  return jest.fn(async (url: string) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v\d+\.\d+\//, '');
    const key = path === 'act_111/insights' ? `insights:${u.searchParams.get('breakdowns') ?? u.searchParams.get('level')}` : path;
    const body = handlers[key];
    if (body === undefined) return { ok: false, status: 400, json: async () => ({ error: { message: `no fixture for ${key}` } }) };
    return { ok: true, status: 200, json: async () => body };
  });
}

const adsReport = {
  account_id: '111', currency: 'USD', level: 'campaign', date_range: { since: '2026-10-18', until: '2026-11-17' }, conversion_event: 'purchase',
  rows: [
    { campaign_id: '1', campaign_name: 'Prospecting', spend: 300, impressions: 30000, clicks: 600, ctr: 2, cpc: 0.5, conversions: 10, conversion_value: 900, roas: 3 },
    { campaign_id: '2', campaign_name: 'Retargeting', spend: 200, impressions: 10000, clicks: 300, ctr: 3, cpc: 0.67, conversions: 2, conversion_value: 300, roas: 1.5 },
    { campaign_id: '3', campaign_name: 'Brand video', spend: 50, impressions: 20000, clicks: 40, ctr: 0.2, cpc: 1.25, conversions: 0, conversion_value: 0, roas: null },
    { campaign_id: '4', campaign_name: 'Launch week', spend: 40, impressions: 4000, clicks: 50, ctr: 1.25, cpc: 0.8, conversions: 0, conversion_value: 0, roas: null },
    { campaign_id: '5', campaign_name: 'Old offer', spend: 80, impressions: 9000, clicks: 100, ctr: 1.11, cpc: 0.8, conversions: 0, conversion_value: 0, roas: null },
    { campaign_id: '6', campaign_name: 'Off', spend: 0, impressions: 0, clicks: 0, ctr: null, cpc: null, conversions: 0, conversion_value: 0, roas: null },
  ],
  totals: { spend: 670, impressions: 73000, clicks: 1090, ctr: 1.49, cpc: 0.61, conversions: 12, conversion_value: 1200, roas: 1.79 },
  summary: '',
} as any;

const graphFixtures = (accountCreated = '2024-01-01T00:00:00+0000') => ({
  act_111: { id: 'act_111', created_time: accountCreated },
  'act_111/campaigns': { data: [
    { id: '1', name: 'Prospecting', objective: 'OUTCOME_SALES', start_time: '2026-08-01T00:00:00+0000' },
    { id: '2', name: 'Retargeting', objective: 'OUTCOME_SALES', start_time: '2026-08-01T00:00:00+0000' },
    { id: '3', name: 'Brand video', objective: 'OUTCOME_ENGAGEMENT', start_time: '2026-08-01T00:00:00+0000' },
    { id: '4', name: 'Launch week', objective: 'OUTCOME_SALES', start_time: iso(NOW - 3 * DAY) },
    { id: '5', name: 'Old offer', objective: 'OUTCOME_SALES', start_time: '2026-06-01T00:00:00+0000' },
  ] },
  'act_111/ads': { data: [
    { campaign_id: '1', creative: { object_story_spec: { link_data: { link: 'https://shop.example.com/p' } } } },
    { campaign_id: '3', creative: { object_story_spec: { link_data: { link: 'https://www.facebook.com/somepage' } } } },
  ] },
  'insights:ad': { data: [
    { ad_id: 'a1', ad_name: 'Hero image', campaign_id: '1', spend: '200', impressions: '20000', clicks: '400', actions: [{ action_type: 'purchase', value: '7' }] },
    { ad_id: 'a2', ad_name: 'Carousel', campaign_id: '2', spend: '150', impressions: '8000', clicks: '200', actions: [] },
  ] },
  'insights:age,gender': { data: [{ age: '25-34', gender: 'female', spend: '300', impressions: '30000', clicks: '500' }] },
  // Placement returns nothing: the section must be omitted.
  'insights:publisher_platform,platform_position': { data: [] },
  // Device is missing on purpose (Graph error): the section must be omitted, the report still built.
});

function deps(over: Partial<MeasurementReportDeps> = {}, fixtures = graphFixtures()): MeasurementReportDeps & { fetch: jest.Mock } {
  return {
    fetch: graph(fixtures),
    graphBaseUrl: 'https://graph.example/v25.0',
    now: () => NOW,
    runAdsReport: jest.fn(async () => JSON.parse(JSON.stringify(adsReport))),
    getLeads: jest.fn(async () => ({ byCampaign: new Map([['1', 20], ['2', 0]]), unattributed: 3 })),
    uploadHtml: jest.fn(async () => 'https://agentweb-user-files.s3.amazonaws.com/users/u1/report.html'),
    ...over,
  } as any;
}

// ---------------------------------------------------------------------------------------------

describe('ENG-3155 zoma_measurement_report output', () => {
  it('covers every campaign with spend in the default last_30d window, with metrics, CRM leads, breakdowns and a hosted link', async () => {
    const d = deps();
    const r = await runZomaMeasurementReport('u1', account, '111', {}, d);

    expect(d.runAdsReport).toHaveBeenCalledWith(account, '111', { level: 'campaign', since: '2026-10-19', until: '2026-11-17' });
    expect(r.date_range).toEqual({ since: '2026-10-19', until: '2026-11-17' });
    expect(r.campaigns.map((c) => c.campaign_id)).toEqual(['1', '2', '3', '4', '5']); // zero-spend '6' is not in it
    const p = r.campaigns[0];
    expect(p).toMatchObject({ spend: 300, impressions: 30000, clicks: 600, ctr: 2, cpc: 0.5, conversions: 10, roas: 3, crm_leads: 20, cost_per_lead: 15 });
    expect(r.campaigns[1]).toMatchObject({ crm_leads: 0, cost_per_lead: null });
    expect(r.campaigns[2]).toMatchObject({ crm_leads: null, cost_per_lead: null });
    expect(r.totals).toMatchObject({ spend: 670, conversions: 12, roas: 1.79, crm_leads: 20, cost_per_lead: 33.5 });
    expect(r.unattributed_crm_leads).toBe(3);
    // No industry given: exactly N/A, and the user is asked for it.
    expect(r.industryBenchmark.line).toBe('Industry benchmark: N/A');
    expect(r.industryBenchmark.note).toMatch(/^Tell us your industry/);
    expect(r.report_url).toBe('https://agentweb-user-files.s3.amazonaws.com/users/u1/report.html');

    expect(r.breakdowns.top_ads?.[0]).toMatchObject({ ad_id: 'a1', label: 'Hero image', spend: 200, conversions: 7 });
    expect(r.breakdowns.demographics).toEqual([{ label: '25-34 · female', spend: 300, impressions: 30000, clicks: 500, ctr: 1.67 }]);
    // Empty placement and a failed device read are omitted, never filled in.
    expect(r.breakdowns.placements).toBeUndefined();
    expect(r.breakdowns.devices).toBeUndefined();

    const html: string = (d.uploadHtml as jest.Mock).mock.calls[0][0];
    expect(html).toContain('<th>Conversions</th>');
    expect(html).toContain('<th>ROAS</th>');
    expect(html).toContain('Top Ads by Spend');
    expect(html).toContain('Demographics');
    expect(html).not.toContain('<h2>Placement</h2>');
    expect(html).not.toContain('<h2>Device</h2>');
    expect(html).not.toMatch(/\{\{\w+\}\}/);
    expect(html).toContain('Industry benchmark: N/A');
    // The access token is never sent anywhere but Graph, and never lands in the report.
    expect(JSON.stringify(r)).not.toContain('EAAG-secret');
  });

  it('omits CRM columns when there is no CRM data, and escapes campaign names', async () => {
    const d = deps({ getLeads: jest.fn(async () => null) });
    (d.runAdsReport as jest.Mock).mockResolvedValueOnce({ ...adsReport, rows: [{ ...adsReport.rows[0], campaign_name: '<script>x</script>' }] });
    const r = await buildZomaMeasurementReport('u1', account, '111', { date_preset: 'last_7d' }, d);
    expect(r.totals.crm_leads).toBeNull();
    const html = renderMeasurementReportHtml(r);
    expect(html).not.toContain('CRM Leads');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('a window with no spend says so instead of inventing rows', async () => {
    const d = deps();
    (d.runAdsReport as jest.Mock).mockResolvedValueOnce({ ...adsReport, rows: [], totals: { ...adsReport.totals, spend: 0 } });
    const r = await buildZomaMeasurementReport('u1', account, '111', {}, d);
    expect(r.campaigns).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.breakdowns).toEqual({});
    expect(r.summary).toContain('No campaign spent in this window.');
  });
});

describe('ENG-3155 vs. industry line (ENG-3156 benchmark)', () => {
  const leadReport = (conversions: number) => ({ ...JSON.parse(JSON.stringify(adsReport)), conversion_event: 'lead', totals: { ...adsReport.totals, conversions } });

  it('compares the report\'s own CPA with the benchmark: % diff, worse, source + year + url, with no extra Graph read', async () => {
    const d = deps({ runAdsReport: jest.fn(async () => leadReport(12)) });
    const r = await runZomaMeasurementReport('u1', account, '111', { industry: 'education' }, d);
    const ib = r.industryBenchmark;
    expect(ib.customer_cpa).toBe(55.83); // 670 / 12, the report's totals
    expect(ib.benchmark).toMatchObject({ cpa: 26.31, currency: 'USD', year: 2026, url: 'https://localiq.com/blog/facebook-advertising-benchmarks/' });
    expect(ib.comparison).toEqual({ difference_percent: 112.2, verdict: 'worse' });
    expect(ib.line).toContain('your CPA 55.83 USD vs 26.31 USD benchmark');
    expect(ib.line).toContain('112.2% above the benchmark (worse');
    expect(ib.line).toContain('LocaliQ — Facebook Advertising Benchmarks for 2026, 2026, https://localiq.com/blog/facebook-advertising-benchmarks/');
    expect(r.summary).toContain(ib.line);
    const html: string = (d.uploadHtml as jest.Mock).mock.calls[0][0];
    expect(html).toContain('vs. Industry');
    expect(html).toContain('href="https://localiq.com/blog/facebook-advertising-benchmarks/"');
    // Reuses the report's spend/conversions: one ads report, no creatives read, no extra insights read.
    expect(d.runAdsReport).toHaveBeenCalledTimes(1);
    const paths = (d.fetch.mock.calls as any[]).map(([u]) => new URL(u).pathname);
    expect(paths.some((p) => p.includes('adcreatives'))).toBe(false);
    expect(paths.filter((p) => p.endsWith('/insights'))).toHaveLength(4);
  });

  it('says better when the CPA is below the benchmark', () => {
    const ib = measurementIndustryBenchmark({ industry: 'education', conversionEvent: 'lead', spend: 670, conversions: 50, currency: 'USD', newAccount: false });
    expect(ib.comparison).toEqual({ difference_percent: -49.1, verdict: 'better' });
    expect(ib.line).toContain('49.1% below the benchmark (better');
  });

  it('is exactly "Industry benchmark: N/A" when there is no row (purchase KPI, or industry "other")', () => {
    for (const input of [
      { industry: 'education' as const, conversionEvent: 'purchase' },
      { industry: 'other' as const, conversionEvent: 'lead' },
      { industry: 'education' as const, conversionEvent: null },
    ]) {
      const ib = measurementIndustryBenchmark({ ...input, spend: 670, conversions: 12, currency: 'USD', newAccount: false });
      expect(ib.line).toBe(INDUSTRY_BENCHMARK_NA_LINE);
      expect(ib.benchmark).toBe('N/A');
      expect(ib.comparison).toBeNull();
    }
  });

  it('does not compare without conversions or across currencies, but still cites the benchmark', () => {
    const none = measurementIndustryBenchmark({ industry: 'education', conversionEvent: 'lead', spend: 100, conversions: 0, currency: 'USD', newAccount: false });
    expect(none.comparison).toBeNull();
    expect(none.note).toMatch(/No lead conversions/);
    expect(none.line).toContain('https://localiq.com/blog/facebook-advertising-benchmarks/');
    const eur = measurementIndustryBenchmark({ industry: 'education', conversionEvent: 'lead', spend: 100, conversions: 5, currency: 'EUR', newAccount: false });
    expect(eur.comparison).toBeNull();
    expect(eur.note).toMatch(/EUR/);
  });

  it('skips the comparison for a new-delivery account and shows the caveat instead', async () => {
    const d = deps({ runAdsReport: jest.fn(async () => leadReport(12)) }, graphFixtures(iso(NOW - 2 * DAY)));
    const r = await runZomaMeasurementReport('u1', account, '111', { industry: 'education' }, d);
    expect(r.industryBenchmark.comparison).toBeNull();
    expect(r.industryBenchmark.benchmark).toBe('N/A');
    expect(r.industryBenchmark.line).toContain(NEW_DELIVERY_CAVEAT);
    const html: string = (d.uploadHtml as jest.Mock).mock.calls[0][0];
    expect(html).not.toContain('above the benchmark');
  });

  it('refuses an unknown industry before any Graph read', async () => {
    const d = deps();
    await expect(buildZomaMeasurementReport('u1', account, '111', { industry: 'crypto' }, d)).rejects.toThrow(/industry must be one of/);
    expect(d.runAdsReport).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe('ENG-3155 exclusion of engagement / link-click campaigns without a destination', () => {
  it('lists them with a reason and never reports them as conversion failures', async () => {
    const r = await buildZomaMeasurementReport('u1', account, '111', {}, deps());
    expect(r.excluded_from_conversion_findings).toEqual([
      expect.objectContaining({ campaign_id: '3', campaign_name: 'Brand video', reason: expect.stringContaining('no destination URL') }),
    ]);
    expect(r.findings.some((f) => f.campaign_id === '3')).toBe(false);
    // An established sales campaign with spend and no purchases IS flagged.
    expect(r.findings).toContainEqual(expect.objectContaining({ type: 'no_conversions', campaign_id: '5' }));
  });

  it('a LINK_CLICKS campaign that does send people to a site is judged normally', () => {
    const c = (id: string, objective: string, spend: number, conversions: number): MeasurementCampaign => ({
      campaign_id: id, campaign_name: id, objective, new_delivery: false, spend, impressions: 1, clicks: 1, ctr: null, cpc: null, conversions, roas: null, crm_leads: null, cost_per_lead: null,
    });
    const out = measurementFindings([c('L1', 'LINK_CLICKS', 50, 0), c('L2', 'LINK_CLICKS', 50, 0)], { conversionEvent: 'lead', newAccount: false, withDestination: new Set(['L1']) });
    expect(out.excluded.map((e) => e.campaign_id)).toEqual(['L2']);
    // L1 has a destination, so it is not excluded, but a click objective is still not called a conversion failure.
    expect(out.findings).toEqual([]);
  });

  it('when destinations cannot be read, engagement campaigns are excluded (no false failure)', () => {
    const c: MeasurementCampaign = { campaign_id: 'E', campaign_name: 'E', objective: 'OUTCOME_ENGAGEMENT', new_delivery: false, spend: 10, impressions: 1, clicks: 0, ctr: null, cpc: null, conversions: 0, roas: null, crm_leads: null, cost_per_lead: null };
    const out = measurementFindings([c], { conversionEvent: 'purchase', newAccount: false, withDestination: null });
    expect(out.excluded[0].reason).toContain('could not be checked');
    expect(out.findings).toEqual([]);
  });
});

describe('ENG-3155 new-delivery caveat', () => {
  it('a campaign that started in the last 7 days gets the exact note and no winner/loser or pause/scale call', async () => {
    const r = await buildZomaMeasurementReport('u1', account, '111', {}, deps());
    const launch = r.campaigns.find((c) => c.campaign_id === '4')!;
    expect(launch.new_delivery).toBe(true);
    expect(r.caveats).toEqual([{ scope: 'campaign', campaign_id: '4', campaign_name: 'Launch week', text: NEW_DELIVERY_CAVEAT }]);
    expect(NEW_DELIVERY_CAVEAT).toBe('New account/campaign: delivery metrics typically take up to one week to stabilize. Best practice is to treat these results as qualitative signals rather than definitive performance.');
    expect(r.findings.some((f) => f.campaign_id === '4')).toBe(false);
    // Established campaigns still get their comparison.
    expect(r.findings).toContainEqual(expect.objectContaining({ type: 'lowest_cost_per_conversion', campaign_id: '1', recommendation: 'scale' }));
    expect(r.findings).toContainEqual(expect.objectContaining({ type: 'highest_cost_per_conversion', campaign_id: '2', recommendation: 'review_or_pause' }));
    expect(renderMeasurementReportHtml({ ...r, report_url: undefined })).toContain(NEW_DELIVERY_CAVEAT);
  });

  it('a new ad account: the note covers the account and there are no findings or recommendations at all', async () => {
    const r = await buildZomaMeasurementReport('u1', account, '111', {}, deps({}, graphFixtures(iso(NOW - 2 * DAY))));
    expect(r.new_account).toBe(true);
    expect(r.caveats).toEqual([{ scope: 'account', text: NEW_DELIVERY_CAVEAT }]);
    expect(r.findings).toEqual([]);
    expect(r.campaigns.every((c) => c.new_delivery)).toBe(true);
    expect(r.summary).toContain(NEW_DELIVERY_CAVEAT);
  });

  it('the autonomous report work plan carries the same caveat in its report step', () => {
    const step3 = AUTONOMOUS_REPORT_WORKPLAN_STEPS[2].description as string;
    expect(step3).toContain('CAVEAT (always apply): new ad accounts and new campaigns normally take up to one week');
    expect(step3).toContain(NEW_DELIVERY_CAVEAT);
    expect(step3).toMatch(/winner\/loser calls or pause\/scale recommendations/);
  });
});

// ---------------------------------------------------------------------------------------------

describe('ENG-3155 auto-enrollment on ship', () => {
  const now = () => NOW;

  it('creates one schedule per user + ad account; first report ~7 days after launch; repeat ships change nothing', async () => {
    const store = new MemoryStore();
    const first = await enrollReportSchedule('u1', '111', { store, now, env: ON });
    expect(first).toMatchObject({ enrollment: 'created', status: 'active', cadence: 'weekly', next_report_at: iso(NOW + 7 * DAY) });
    const again = await enrollReportSchedule('u1', '111', { store, now: () => NOW + DAY, env: ON });
    expect(again).toMatchObject({ enrollment: 'already_active', next_report_at: iso(NOW + 7 * DAY) });
    expect(store.rows.size).toBe(1);
    await enrollReportSchedule('u1', '222', { store, now, env: ON });
    expect(store.rows.size).toBe(2);
    expect(scheduleNoticeText(first!)).toContain('zoma_report_schedule');
  });

  it('concurrent enrollments create exactly one row', async () => {
    const store = new MemoryStore();
    const results = await Promise.all([1, 2, 3, 4].map(() => enrollReportSchedule('u1', '111', { store, now, env: ON })));
    expect(results.filter((r) => r?.enrollment === 'created')).toHaveLength(1);
    expect(store.rows.size).toBe(1);
  });

  it('a dormant schedule (no spend 14+ days) resumes on the next ship; a user pause/stop is kept', async () => {
    const store = new MemoryStore();
    await enrollReportSchedule('u1', '111', { store, now, env: ON });
    await store.update('u1', '111', { status: 'dormant' }, iso(NOW));
    const later = NOW + 30 * DAY;
    const resumed = await enrollReportSchedule('u1', '111', { store, now: () => later, env: ON });
    expect(resumed).toMatchObject({ enrollment: 'resumed', status: 'active', next_report_at: firstReportAt(iso(later)) });
    await store.update('u1', '111', { status: 'stopped' }, iso(later));
    const kept = await enrollReportSchedule('u1', '111', { store, now: () => later + DAY, env: ON });
    expect(kept).toMatchObject({ enrollment: 'kept_user_choice', status: 'stopped' });
    expect((await store.get('u1', '111'))!.status).toBe('stopped');
  });

  it('the DynamoDB store writes with attribute_not_exists and reports a lost race as "exists"', async () => {
    const put = jest.fn()
      .mockReturnValueOnce({ promise: () => Promise.resolve({}) })
      .mockReturnValueOnce({ promise: () => Promise.reject(Object.assign(new Error('exists'), { code: 'ConditionalCheckFailedException' })) });
    const update = jest.fn(() => ({ promise: () => Promise.reject(Object.assign(new Error('nope'), { code: 'ConditionalCheckFailedException' })) }));
    const store = new DynamoZomaReportScheduleStore({ put, update } as any, 'T');
    const rec: ZomaReportSchedule = { userId: 'u1', adAccountId: '111', status: 'active', cadence: 'weekly', nextReportAt: 'x', launchedAt: 'x', createdAt: 'x', updatedAt: 'x' };
    expect(await store.create(rec)).toBe(true);
    expect(await store.create(rec)).toBe(false);
    expect(put.mock.calls[0][0]).toMatchObject({ TableName: 'T', ConditionExpression: 'attribute_not_exists(userId)' });
    expect(await store.claimSlot('u1', '111', 'due', 'next', 'now')).toBe(false);
    expect((update.mock.calls[0] as any)[0]).toMatchObject({ ConditionExpression: '#status = :active AND nextReportAt = :due', ExpressionAttributeValues: expect.objectContaining({ ':due': 'due' }) });
  });

  it('the gateway enrolls after a CONFIRMED activation and the next step tells the agent', async () => {
    process.env[ZOMA_MEASUREMENT_REPORTS_FLAG] = 'true';
    const enroll = jest.fn(async () => ({ status: 'active', cadence: 'weekly', next_report_at: iso(NOW + 7 * DAY), enrollment: 'created', how_to_change: 'x' }) as any);
    const result: any = await handleMetaToolkitCall(
      { authorization: 'Bearer oauth-good', toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action: 'UPDATE', id: '9', params: { status: 'ACTIVE' }, confirm: true, preview_token: 't' } },
      gatewayDeps({ enrollReportSchedule: enroll, executeWrite: async () => ({ verification: 'CONFIRMED', id: '9' }) }),
    );
    expect(enroll).toHaveBeenCalledWith('u1', '111');
    expect(result.report_schedule.enrollment).toBe('created');
    expect(zomaNextStep('call_meta_marketing_api', {}, result)).toContain('A measurement report schedule was set up');
  });

  it('the gateway does not enroll on a pause, or on an unconfirmed activation', async () => {
    process.env[ZOMA_MEASUREMENT_REPORTS_FLAG] = 'true';
    const enroll = jest.fn();
    await handleMetaToolkitCall(
      { authorization: 'Bearer oauth-good', toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action: 'UPDATE', id: '9', params: { status: 'PAUSED' }, confirm: true, preview_token: 't' } },
      gatewayDeps({ enrollReportSchedule: enroll, executeWrite: async () => ({ verification: 'CONFIRMED', id: '9' }) }),
    );
    await handleMetaToolkitCall(
      { authorization: 'Bearer oauth-good', toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action: 'UPDATE', id: '9', params: { status: 'ACTIVE' }, confirm: true, preview_token: 't' } },
      gatewayDeps({ enrollReportSchedule: enroll, executeWrite: async () => ({ verification: 'UNCONFIRMED', id: '9' }) }),
    );
    expect(enroll).not.toHaveBeenCalled();
  });
});

const metaAccount: any = {
  platform: 'meta',
  account_id: 'act_111',
  account_name: 'Phoenix Shop',
  config: { account_type: 'ad_account', access_token: 'EAAG-secret', ad_account_id: '111', currency: 'USD', granted_scopes: ['ads_management'] },
};

function gatewayDeps(over: Partial<MetaToolkitGatewayDeps> = {}): MetaToolkitGatewayDeps {
  return {
    validateApiKey: async () => null,
    validateOAuthToken: async () => ({ userId: 'u1', clientId: 'claude-code' }),
    getOAuthClientRedirectUris: async () => ['http://localhost:1/callback'],
    listAccounts: async () => [metaAccount],
    execute: jest.fn() as any,
    recordUsage: jest.fn().mockResolvedValue(undefined) as any,
    recordWrite: jest.fn().mockResolvedValue(undefined) as any,
    recordFailure: jest.fn().mockResolvedValue(undefined) as any,
    reportBillableCall: async () => undefined,
    assertPublishAllowed: async () => undefined,
    rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) } as any,
    now: () => NOW,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------

describe('ENG-3155 runner: exactly once per slot', () => {
  const report = { summary: 'Measurement report for act_111.', date_range: { since: '2026-10-19', until: '2026-11-17' }, report_url: 'https://r/x.html' } as unknown as MeasurementReport;

  function runnerDeps(store: MemoryStore, over: Partial<MeasurementRunnerDeps> = {}): MeasurementRunnerDeps & { sendEmail: jest.Mock } {
    return {
      enabled: () => true,
      maxPerPass: () => 100,
      store: () => store,
      getUser: async (userId: string) => ({ userId, email: 'owner@shop.com', isAdmin: false }),
      recentSpend: async () => 120,
      buildReport: jest.fn(async () => report),
      sendEmail: jest.fn(async () => 'sent' as const),
      backendUrl: () => 'https://api.example',
      secret: () => 'test-secret',
      now: () => NOW,
      ...over,
    } as any;
  }

  const seed = (store: MemoryStore, over: Partial<ZomaReportSchedule> = {}) =>
    store.create({ userId: 'u1', adAccountId: '111', status: 'active', cadence: 'weekly', nextReportAt: iso(NOW - DAY), launchedAt: iso(NOW - 8 * DAY), createdAt: iso(NOW - 8 * DAY), updatedAt: iso(NOW - 8 * DAY), ...over });

  it('sends the due report once with the hosted link and a signed opt-out, then advances to the next week', async () => {
    const store = new MemoryStore();
    await seed(store);
    const d = runnerDeps(store);
    const r1 = await runZomaMeasurementReports(d);
    expect(r1).toMatchObject({ due: 1, sent: 1 });
    const [to, subject, text, , headers] = d.sendEmail.mock.calls[0];
    expect(to).toBe('owner@shop.com');
    expect(subject).toContain('measurement report');
    expect(text).toContain('https://r/x.html');
    expect(text).toMatch(/\/api\/zoma\/measurement-report\/unsubscribe\?t=/);
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const row = (await store.get('u1', '111'))!;
    expect(row.lastClaimedSlot).toBe(iso(NOW - DAY));
    expect(row.nextReportAt).toBe(iso(NOW + 6 * DAY));
    // A repeated pass in the same hour sends nothing.
    expect(await runZomaMeasurementReports(d)).toMatchObject({ due: 0, sent: 0 });
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('two concurrent passes over the same due slot send exactly one email', async () => {
    const store = new MemoryStore();
    await seed(store);
    const d = runnerDeps(store);
    const [a, b] = await Promise.all([runZomaMeasurementReports(d), runZomaMeasurementReports(d)]);
    expect(a.sent + b.sent).toBe(1);
    expect(d.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a failed send is not retried for that slot; a build failure does not burn it', async () => {
    const store = new MemoryStore();
    await seed(store);
    const failing = runnerDeps(store, { sendEmail: jest.fn(async () => 'failed' as const) });
    expect(await runZomaMeasurementReports(failing)).toMatchObject({ failed: 1 });
    expect(await runZomaMeasurementReports(failing)).toMatchObject({ due: 0 });

    const store2 = new MemoryStore();
    await seed(store2);
    const broken = runnerDeps(store2, { buildReport: jest.fn(async () => { throw new Error('Meta down'); }) });
    expect(await runZomaMeasurementReports(broken)).toMatchObject({ sent: 0 });
    expect((await store2.get('u1', '111'))!.nextReportAt).toBe(iso(NOW - DAY)); // still due next tick
  });

  it('stops the pass after 3 failed sends in a row', async () => {
    const store = new MemoryStore();
    for (const a of ['1', '2', '3', '4']) await seed(store, { adAccountId: a });
    const d = runnerDeps(store, { sendEmail: jest.fn(async () => 'failed' as const) });
    expect(await runZomaMeasurementReports(d)).toMatchObject({ failed: 3 });
    expect(d.sendEmail).toHaveBeenCalledTimes(3);
  });

  it('no spend in the last 14 days: goes dormant without emailing; internal accounts are skipped', async () => {
    const store = new MemoryStore();
    await seed(store);
    const d = runnerDeps(store, { recentSpend: async () => 0 });
    expect(await runZomaMeasurementReports(d)).toMatchObject({ dormant: 1, sent: 0 });
    expect((await store.get('u1', '111'))!.status).toBe('dormant');
    expect(d.sendEmail).not.toHaveBeenCalled();

    const store2 = new MemoryStore();
    await seed(store2);
    const internal = runnerDeps(store2, { getUser: async (userId) => ({ userId, email: 'harsha@agentweb.pro', isAdmin: true }) });
    await runZomaMeasurementReports(internal);
    expect(internal.sendEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------

describe('ENG-3155 zoma_report_schedule', () => {
  it('GET / UPDATE cadence / PAUSE / RESUME / STOP', async () => {
    const store = new MemoryStore();
    await enrollReportSchedule('u1', '111', { store, now: () => NOW, env: ON });
    const opts = { store, now: () => NOW + DAY, env: ON };
    expect((await runZomaReportScheduleTool('u1', {}, opts)).schedules).toEqual([{ account_id: '111', status: 'active', cadence: 'weekly', next_report_at: iso(NOW + 7 * DAY) }]);
    await runZomaReportScheduleTool('u1', { action: 'UPDATE', cadence: 'monthly' }, opts);
    expect((await store.get('u1', '111'))!.cadence).toBe('monthly');
    await runZomaReportScheduleTool('u1', { action: 'PAUSE', account_id: 'act_111' }, opts);
    expect((await store.get('u1', '111'))!.status).toBe('paused');
    await runZomaReportScheduleTool('u1', { action: 'RESUME' }, opts);
    expect((await store.get('u1', '111'))!.status).toBe('active');
    await runZomaReportScheduleTool('u1', { action: 'STOP' }, opts);
    expect((await store.get('u1', '111'))!.status).toBe('stopped');
    await expect(runZomaReportScheduleTool('u1', { action: 'UPDATE', cadence: 'hourly' }, opts)).rejects.toThrow(/cadence must be one of/);
    await expect(runZomaReportScheduleTool('u1', { action: 'PAUSE', account_id: '999' }, opts)).rejects.toThrow(/No measurement report schedule exists/);
  });
});

describe('ENG-3155 signed opt-out', () => {
  it('stops every schedule of the user; its link is not interchangeable with the weekly email link', async () => {
    const store = new MemoryStore();
    await enrollReportSchedule('u1', '111', { store, now: () => NOW, env: ON });
    await enrollReportSchedule('u1', '222', { store, now: () => NOW, env: ON });
    expect(await stopAllReportSchedules('u1', store, () => NOW)).toBe(true);
    expect((await store.listForUser('u1')).map((s) => s.status)).toEqual(['stopped', 'stopped']);
    const token = signUnsubscribeToken('u1', 's', MEASUREMENT_UNSUBSCRIBE_CONTEXT);
    expect(verifyUnsubscribeToken(token, 's', MEASUREMENT_UNSUBSCRIBE_CONTEXT)).toBe('u1');
    expect(verifyUnsubscribeToken(token, 's')).toBeNull();
    expect(verifyUnsubscribeToken(signUnsubscribeToken('u1', 's'), 's', MEASUREMENT_UNSUBSCRIBE_CONTEXT)).toBeNull();
  });
});

describe('ENG-3155 flag off = no-op', () => {
  it('no tools in the manifest, no enrollment, no runner work, schedule tool refuses', async () => {
    const names = () => getMetaToolkitManifest().map((t: any) => t.name);
    expect(names()).not.toContain('zoma_measurement_report');
    expect(names()).not.toContain('zoma_report_schedule');

    const store = new MemoryStore();
    const spy = jest.spyOn(store, 'create');
    expect(await enrollReportSchedule('u1', '111', { store, env: OFF })).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    await store.create({ userId: 'u1', adAccountId: '111', status: 'active', cadence: 'weekly', nextReportAt: iso(NOW - DAY), launchedAt: 'x', createdAt: 'x', updatedAt: 'x' });
    const listDue = jest.spyOn(store, 'listDue');
    const sendEmail = jest.fn();
    expect(await runZomaMeasurementReports({ enabled: () => false, store: () => store, sendEmail } as any)).toEqual({ due: 0, sent: 0, failed: 0, dormant: 0 });
    expect(listDue).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();

    await expect(runZomaReportScheduleTool('u1', {}, { store, env: OFF })).rejects.toThrow(/not available/);

    // The gateway: an activation enrolls nothing (the default enroller returns null), the tools are not routed.
    const result: any = await handleMetaToolkitCall(
      { authorization: 'Bearer oauth-good', toolName: 'call_meta_marketing_api', args: { entity_type: 'CAMPAIGN', action: 'UPDATE', id: '9', params: { status: 'ACTIVE' }, confirm: true, preview_token: 't' } },
      gatewayDeps({ executeWrite: async () => ({ verification: 'CONFIRMED', id: '9' }) }),
    );
    expect(result.report_schedule).toBeUndefined();
    // Not routed: the call falls through to the v1 executor, which refuses a tool outside the surface.
    const runMeasurementReport = jest.fn();
    const execute = jest.fn(async (name: string, args: any) => assertMetaToolkitV1Call(name, args));
    await expect(handleMetaToolkitCall({ authorization: 'Bearer oauth-good', toolName: 'zoma_measurement_report', args: {} }, gatewayDeps({ runMeasurementReport, execute: execute as any }))).rejects.toThrow(/not part of the Meta Toolkit/);
    expect(runMeasurementReport).not.toHaveBeenCalled();
  });

  it('with the flag on, both tools are advertised', () => {
    process.env[ZOMA_MEASUREMENT_REPORTS_FLAG] = 'true';
    const names = getMetaToolkitManifest().map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(['zoma_measurement_report', 'zoma_report_schedule']));
  });
});
