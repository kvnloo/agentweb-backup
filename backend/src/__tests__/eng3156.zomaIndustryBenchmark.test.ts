/**
 * ENG-3156 — zoma_industry_benchmark: customer CPA vs a sourced, versioned industry benchmark.
 *
 * Contract (ENG-3156):
 *   - KPI is purchase → lead → registration (zoma_ads_report's priority) or the caller's kpi.
 *   - Customer CPA = spend / conversions of that KPI for the range; zero conversions → no CPA.
 *   - No benchmark row for industry/platform/kpi → exactly "Industry benchmark: N/A", no estimate.
 *   - Every number carries its source (customer: Meta insights; benchmark: source + year + url).
 *   - Without an industry, it is classified from the ads' destination and the user can override.
 */
import {
  BENCHMARK_NA,
  classifyIndustryWithLlm,
  compareCpa,
  destinationsFromCreatives,
  parseZomaIndustryBenchmarkArgs,
  runZomaIndustryBenchmark,
  type ZomaIndustryBenchmarkDeps,
} from '../mcp/zomaIndustryBenchmark';
import {
  BENCHMARK_INDUSTRIES,
  getIndustryBenchmark,
  INDUSTRY_BENCHMARKS,
} from '../mcp/zomaIndustryBenchmarks';
import { chooseConversionEvent, kpiOfConversionEvent, runZomaAdsReport, type ZomaAdsReport } from '../mcp/zomaAdsReport';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

const account: any = { config: { access_token: 'tok' } };

function report(over: Partial<ZomaAdsReport> & { spend?: number; conversions?: number } = {}): ZomaAdsReport {
  const spend = over.spend ?? 500;
  const conversions = over.conversions ?? 10;
  return {
    account_id: '123',
    currency: over.currency === undefined ? 'USD' : over.currency,
    level: 'account',
    date_range: { preset: 'last_30d' },
    conversion_event: over.conversion_event === undefined ? 'lead' : over.conversion_event,
    rows: [],
    totals: { spend, impressions: 1000, clicks: 50, ctr: 5, cpc: 10, conversions, conversion_value: 0, roas: null },
    summary: '',
  };
}

function deps(r: ZomaAdsReport, classified: { industry: any; basis: string | null } = { industry: 'real_estate', basis: 'homes.example' }) {
  return {
    runReport: jest.fn(async () => r),
    classifyIndustry: jest.fn(async () => classified),
  } satisfies ZomaIndustryBenchmarkDeps;
}

describe('ENG-3156 benchmark table', () => {
  it('attributes every row: source name, year, https url, positive USD figure, known industry', () => {
    expect(INDUSTRY_BENCHMARKS.length).toBeGreaterThan(0);
    for (const row of INDUSTRY_BENCHMARKS) {
      expect(row.sourceName).toMatch(/\S/);
      expect(row.year).toBeGreaterThanOrEqual(2024);
      expect(row.url).toMatch(/^https:\/\//);
      expect(row.currency).toBe('USD');
      expect(row.cpa).toBeGreaterThan(0);
      expect(BENCHMARK_INDUSTRIES).toContain(row.industry);
    }
  });

  it('has at most one row per industry/platform/kpi', () => {
    const keys = INDUSTRY_BENCHMARKS.map((r) => `${r.industry}|${r.platform}|${r.kpi}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('returns null (never a substitute) when no source publishes the figure', () => {
    expect(getIndustryBenchmark('other', 'meta', 'lead')).toBeNull();
    // Published as lead CPL only: no purchase or registration figure is invented from it.
    expect(getIndustryBenchmark('real_estate', 'meta', 'purchase')).toBeNull();
    expect(getIndustryBenchmark('real_estate', 'google', 'registration')).toBeNull();
    // LocaliQ/WordStream Meta tables have no Travel row; Google's figure is not borrowed.
    expect(getIndustryBenchmark('travel', 'meta', 'lead')).toBeNull();
    expect(getIndustryBenchmark('travel', 'google', 'lead')?.cpa).toBe(73.7);
  });

  it('returns the published figure for a covered key', () => {
    expect(getIndustryBenchmark('real_estate', 'meta', 'lead')).toMatchObject({ cpa: 13.74, year: 2026, url: 'https://localiq.com/blog/facebook-advertising-benchmarks/' });
  });
});

describe('ENG-3156 KPI priority', () => {
  const rows = [{ actions: [{ action_type: 'lead', value: '4' }, { action_type: 'purchase', value: '2' }, { action_type: 'complete_registration', value: '9' }] }];

  it('maps Meta action types to the KPI they count toward', () => {
    expect(kpiOfConversionEvent('omni_purchase')).toBe('purchase');
    expect(kpiOfConversionEvent('offsite_conversion.fb_pixel_lead')).toBe('lead');
    expect(kpiOfConversionEvent('complete_registration')).toBe('registration');
    expect(kpiOfConversionEvent('link_click')).toBeNull();
    expect(kpiOfConversionEvent(null)).toBeNull();
  });

  it('picks purchase before lead before registration, or only the caller\'s KPI', () => {
    expect(chooseConversionEvent(rows, null)).toBe('purchase');
    expect(chooseConversionEvent([{ actions: [{ action_type: 'complete_registration', value: '1' }, { action_type: 'lead', value: '1' }] }], null)).toBe('lead');
    expect(chooseConversionEvent(rows, null, 'registration')).toBe('complete_registration');
    expect(chooseConversionEvent([{ actions: [{ action_type: 'purchase', value: '1' }] }], null, 'lead')).toBeNull();
  });

  it('counts only the caller KPI in the Meta report', async () => {
    const fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [{ spend: '100', impressions: '10', clicks: '1', ...rows[0] }] }) }));
    const r = await runZomaAdsReport(account, '123', { level: 'account' }, { fetch, graphBaseUrl: 'https://graph.test' }, { kpi: 'lead' });
    expect(r.conversion_event).toBe('lead');
    expect(r.totals.conversions).toBe(4);
  });

  it('uses the auto-chosen KPI, or passes the caller kpi through to the report', async () => {
    const auto = deps(report({ conversion_event: 'omni_purchase' }));
    const a = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate' }, auto);
    expect(a.kpi).toBe('purchase');
    expect(a.kpi_source).toBe('auto');
    expect(auto.runReport).toHaveBeenCalledWith(account, '123', { level: 'account', date_preset: 'last_30d' }, undefined);

    const chosen = deps(report());
    const c = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate', kpi: 'lead', since: '2026-10-01', until: '2026-10-31' }, chosen);
    expect(c.kpi).toBe('lead');
    expect(c.kpi_source).toBe('caller');
    expect(chosen.runReport).toHaveBeenCalledWith(account, '123', { level: 'account', since: '2026-10-01', until: '2026-10-31' }, 'lead');
  });
});

describe('ENG-3156 CPA math and comparison', () => {
  it('CPA = spend / conversions; % difference vs benchmark; lower is better', async () => {
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate' }, deps(report({ spend: 500, conversions: 10 })));
    expect(r.customer.cpa).toBe(50);
    expect(r.industry_benchmark).not.toBe(BENCHMARK_NA);
    expect((r.industry_benchmark as any).cpa).toBe(13.74);
    expect(r.comparison).toMatchObject({ difference_percent: 263.9, verdict: 'worse' });

    const cheap = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate' }, deps(report({ spend: 68.7, conversions: 10 })));
    expect(cheap.customer.cpa).toBe(6.87);
    expect(cheap.comparison).toMatchObject({ difference_percent: -50, verdict: 'better' });
  });

  it('compareCpa reports equality as same', () => {
    expect(compareCpa(20, 20)).toEqual({ difference_percent: 0, verdict: 'same' });
    expect(compareCpa(30, 20)).toEqual({ difference_percent: 50, verdict: 'worse' });
  });

  it('zero conversions: no CPA, no comparison, benchmark still attributed', async () => {
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate' }, deps(report({ spend: 200, conversions: 0 })));
    expect(r.customer.cpa).toBeNull();
    expect(r.comparison).toBeNull();
    expect(r.comparison_note).toMatch(/No lead conversions/);
    expect(r.summary).toMatch(/Your CPA: N\/A \(0 conversions, spend 200\.00 USD\)/);
    expect(Number.isFinite(r.customer.spend)).toBe(true);
  });

  it('does not compare across currencies', async () => {
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate' }, deps(report({ currency: 'EUR' })));
    expect(r.customer.cpa).toBe(50);
    expect(r.comparison).toBeNull();
    expect(r.comparison_note).toMatch(/EUR.*USD/);
  });
});

describe('ENG-3156 N/A path', () => {
  it.each([
    ['industry without any row', { industry: 'other' }, 'lead'],
    ['KPI without any row', { industry: 'real_estate' }, 'omni_purchase'],
  ])('%s → exactly "Industry benchmark: N/A"', async (_label, args, event) => {
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', args, deps(report({ conversion_event: event })));
    expect(r.industry_benchmark).toBe('N/A');
    expect(r.comparison).toBeNull();
    expect(r.summary.split('\n')).toContain('Industry benchmark: N/A');
    expect(r.summary).not.toMatch(/Industry benchmark: \d/);
  });

  it('no conversion action at all → no KPI → N/A', async () => {
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate' }, deps(report({ conversion_event: null, conversions: 0 })));
    expect(r.kpi).toBeNull();
    expect(r.industry_benchmark).toBe('N/A');
  });
});

describe('ENG-3156 attribution on every number', () => {
  it('customer CPA, benchmark and comparison each carry a source', async () => {
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'real_estate' }, deps(report()));
    expect(r.customer.source).toMatch(/Meta Ads Insights for act_123, last_30d, conversions = lead/);
    const b = r.industry_benchmark as Exclude<typeof r.industry_benchmark, 'N/A'>;
    expect(b).toMatchObject({ source_name: expect.stringMatching(/LocaliQ/), year: 2026, url: expect.stringMatching(/^https:\/\//), table_version: expect.any(String) });
    expect(r.comparison?.source).toMatch(/LocaliQ.*2026/);
    expect(r.summary).toContain(`source: ${b.source_name}, ${b.year}, ${b.url}`);
    expect(r.summary).toContain(`source: ${r.customer.source}`);
  });
});

describe('ENG-3156 industry classification', () => {
  it('uses the classified industry and says the user can override it', async () => {
    const d = deps(report(), { industry: 'real_estate', basis: 'homes.example' });
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', {}, d);
    expect(d.classifyIndustry).toHaveBeenCalledWith(account, '123', 'u1');
    expect(r.industry).toBe('real_estate');
    expect(r.industry_source).toBe('classified');
    expect(r.industry_note).toMatch(/homes\.example.*tell me your industry/i);
  });

  it('caller industry skips classification', async () => {
    const d = deps(report());
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', { industry: 'education' }, d);
    expect(d.classifyIndustry).not.toHaveBeenCalled();
    expect(r.industry_source).toBe('caller');
    expect(r.industry_note).toBeNull();
  });

  it('unclassifiable → N/A and asks for the industry', async () => {
    const r = await runZomaIndustryBenchmark(account, '123', 'u1', {}, deps(report(), { industry: null, basis: null }));
    expect(r.industry).toBeNull();
    expect(r.industry_benchmark).toBe('N/A');
    expect(r.industry_note).toMatch(/could not be determined/);
  });

  it('extracts the most common non-Meta destination host and ad copy', () => {
    const d = destinationsFromCreatives([
      { object_story_spec: { link_data: { link: 'https://www.homes.example/listings', name: 'Find your home' } } },
      { link_url: 'https://homes.example/a', body: 'Tour today' },
      { object_story_spec: { video_data: { call_to_action: { value: { link: 'https://facebook.com/page' } } } } },
      { link_url: 'https://other.example' },
    ]);
    expect(d.host).toBe('homes.example');
    expect(d.url).toBe('https://www.homes.example/listings');
    expect(d.copy).toEqual(['Find your home', 'Tour today']);
  });

  it('accepts only an enum industry from the LLM', async () => {
    const llm = (content: string) => jest.fn(async () => ({ choices: [{ message: { content } }] }));
    expect(await classifyIndustryWithLlm({ host: 'homes.example', url: null, copy: [] }, 'u1', llm(' Real_Estate.'))).toBe('real_estate');
    expect(await classifyIndustryWithLlm({ host: 'x.example', url: null, copy: [] }, 'u1', llm('saas'))).toBeNull();
    const failing = jest.fn(async () => { throw new Error('down'); });
    expect(await classifyIndustryWithLlm({ host: 'x.example', url: null, copy: [] }, 'u1', failing)).toBeNull();
  });
});

describe('ENG-3156 argument validation', () => {
  it('refuses unknown industry / kpi and bad dates before any read', () => {
    expect(() => parseZomaIndustryBenchmarkArgs({ industry: 'saas' })).toThrow(MetaToolkitRefusal);
    expect(() => parseZomaIndustryBenchmarkArgs({ kpi: 'click' })).toThrow(MetaToolkitRefusal);
    expect(() => parseZomaIndustryBenchmarkArgs({ since: '2026-11-10' })).toThrow(MetaToolkitRefusal);
  });
});
