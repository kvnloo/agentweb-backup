/**
 * ENG-2194 (ENG-2128): the ad-level snapshot gains 3-second video plays and a CRM lead join by
 * utm_content, and the creative-vs-performance report gains CVR, hook rate and CRM CPL. Meta
 * responses come from the recorded-shape fixture; leads are synthetic.
 */
import {
  AD_LEVEL_SNAPSHOTS_ENV,
  countCrmLeadsByAd,
  runMetaMetricsSnapshot,
  snapshotMetaAdMetricsForDate,
} from '../cron/metaMetricsSnapshotCron';
import { adsMetricsDb, type AdsMetricsAdRow } from '../services/adsMetricsDb';
import { userDb, crmDb } from '../services/db';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';
import { aggregateCreative, creativePerformanceReport, type AdDayMetrics, type CreativeObservation } from '../loops/eval/creativePerformance';
import { formatReport, parseArgs } from '../scripts/creativePerformanceCorrelation';
import fixture from './fixtures/metaInsightsLevelAd.json';

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn(), getAllUsers: jest.fn() },
  crmDb: { getLeadListsByUserId: jest.fn(), getLeadsByListId: jest.fn() },
}));
jest.mock('../services/adsMetricsDb', () => ({
  ...jest.requireActual('../services/adsMetricsDb'),
  adsMetricsDb: { putSnapshot: jest.fn(), putAdSnapshot: jest.fn() },
}));
jest.mock('../services/metaAccountCredentials', () => ({
  getMetaAccountCredentials: jest.fn(),
  cleanAccountId: (id: string) => (id || '').replace('act_', ''),
}));

const ACCOUNT = '1000000000000001';
const USER = 'user-ad-rows';
const DATE = '2026-08-01';
const CREDS = { accountId: ACCOUNT, accessToken: 'tok' };
const CONTEXT = { currency: fixture.accountContext.currency, reportingTimezone: fixture.accountContext.timezone_name };
const IMAGE_AD = '120200000000000011';
const VIDEO_AD = '120200000000000012';
const STOCK_AD = '120200000000000013';

type FetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };
const fetchMock = jest.fn<Promise<FetchResponse>, [string]>();
const ok = (body: unknown): FetchResponse => ({ ok: true, json: async () => body });
const adRows = (): AdsMetricsAdRow[] => jest.mocked(adsMetricsDb.putAdSnapshot).mock.calls.map((c) => c[0]);
const byAd = (adId: string): AdsMetricsAdRow => adRows().find((r) => r.adId === adId)!;

/** Leads the way both write paths store them: a structured firstTouch, or only the customFields bag. */
const leads = [
  { firstTouch: { timestamp: `${DATE}T10:00:00.000Z`, utm: { source: 'meta', campaign: '120200000000000031', content: IMAGE_AD } } },
  { customFields: { utm_source: 'meta', utm_content: IMAGE_AD } },
  { customFields: { utm_content: ` ${VIDEO_AD} ` } },
  // A campaign id or a macro that never resolved is not an ad Meta reported: never counted.
  { customFields: { utm_content: '120200000000000031' } },
  { customFields: { utm_content: '{{ad.id}}' } },
  { firstTouch: { timestamp: `${DATE}T10:00:00.000Z`, utm: { source: 'google' } } },
  {},
];

beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.mocked(adsMetricsDb.putAdSnapshot).mockResolvedValue(undefined);
  jest.mocked(adsMetricsDb.putSnapshot).mockResolvedValue(undefined);
});

describe('countCrmLeadsByAd', () => {
  it('counts leads by utm_content from firstTouch or customFields, only for reported ads', () => {
    const counts = countCrmLeadsByAd(leads, new Set([IMAGE_AD, VIDEO_AD, STOCK_AD]));
    expect(Object.fromEntries(counts)).toEqual({ [IMAGE_AD]: 2, [VIDEO_AD]: 1 });
  });
});

describe('snapshotMetaAdMetricsForDate (ENG-2194 fields)', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValueOnce(ok(fixture.pages[0])).mockResolvedValueOnce(ok(fixture.pages[1]));
  });

  it('records 3-second plays (actions.video_view) on video ads only', async () => {
    await snapshotMetaAdMetricsForDate(USER, DATE, CREDS, CONTEXT);
    expect(byAd(VIDEO_AD).platformMetrics).toMatchObject({ videoPlays3s: 911, videoP25Watched: 640, videoThruplayWatched: 212 });
    expect(byAd(IMAGE_AD).platformMetrics).not.toHaveProperty('videoPlays3s');
    expect(byAd(STOCK_AD).platformMetrics).not.toHaveProperty('videoPlays3s');
  });

  it('writes crmLeadCount per ad when the day\'s CRM leads are passed, zero included', async () => {
    await snapshotMetaAdMetricsForDate(USER, DATE, CREDS, CONTEXT, 'daily', leads);
    expect(adRows().map((r) => [r.adId, r.crmLeadCount])).toEqual([[IMAGE_AD, 2], [VIDEO_AD, 1], [STOCK_AD, 0]]);
    // Meta-reported leads stay separate from the CRM join.
    expect(byAd(IMAGE_AD).platformLeadCount).toBe(3);
  });

  it('omits crmLeadCount when no leads were passed, so "not joined" never reads as zero', async () => {
    await snapshotMetaAdMetricsForDate(USER, DATE, CREDS, CONTEXT);
    for (const row of adRows()) expect(row).not.toHaveProperty('crmLeadCount');
  });
});

describe('runMetaMetricsSnapshot passes each date\'s CRM leads to the ad rows', () => {
  const env = process.env[AD_LEVEL_SNAPSHOTS_ENV];

  afterEach(() => {
    if (env === undefined) delete process.env[AD_LEVEL_SNAPSHOTS_ENV];
    else process.env[AD_LEVEL_SNAPSHOTS_ENV] = env;
    jest.restoreAllMocks();
  });

  it('joins a lead to the ad row of the date it was created, and writes zero on the other dates', async () => {
    process.env[AD_LEVEL_SNAPSHOTS_ENV] = 'true';
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const leadDate = yesterday.toISOString().slice(0, 10);
    jest.mocked(userDb.getAllUsers).mockResolvedValue([
      {
        userId: USER,
        connected_accounts: [{ platform: 'meta', account_id: ACCOUNT, created_at: '2026-01-01T00:00:00.000Z', config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: ACCOUNT } }],
      },
    ] as never);
    jest.mocked(getMetaAccountCredentials).mockResolvedValue({ ...CREDS, accountName: 'Test' } as never);
    jest.mocked(crmDb.getLeadListsByUserId).mockResolvedValue([{ listId: 'list-1' }] as never);
    jest.mocked(crmDb.getLeadsByListId).mockResolvedValue({
      items: [{ createdAt: `${leadDate}T12:00:00.000Z`, customFields: { utm_content: STOCK_AD } }],
      lastEvaluatedKey: undefined,
    } as never);
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('/insights')) return ok(fixture.accountContext);
      return ok(url.includes('level=ad') ? { data: fixture.pages[1].data } : { data: [] });
    });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await runMetaMetricsSnapshot();

    const rows = adRows();
    expect(rows).toHaveLength(30);
    expect(rows.find((r) => r.date === leadDate)?.crmLeadCount).toBe(1);
    expect(rows.filter((r) => r.date !== leadDate).every((r) => r.crmLeadCount === 0)).toBe(true);
  });
});

/** Settled: captured 40 days after the reporting date. */
function settledRow(date: string, over: Partial<AdDayMetrics> = {}): AdDayMetrics {
  const captured = new Date(`${date}T09:00:00.000Z`);
  captured.setUTCDate(captured.getUTCDate() + 40);
  return { date, capturedAt: captured.toISOString(), currency: 'USD', spend: 10, impressions: 1000, clicks: 200, platformLeadCount: 1, ...over };
}

function creative(id: string, rubricScore: number | null, rows: AdDayMetrics[]): CreativeObservation {
  return { creativeId: id, rubricScore, ads: [{ adId: `ad-${id}`, via: 'create_ad', linkedAt: '2026-07-01T10:00:00.000Z', rows }] };
}

describe('aggregateCreative (ENG-2194 fields)', () => {
  it('sums 3-second plays over the impressions that reported them, and CRM leads over joined spend only', () => {
    const agg = aggregateCreative(creative('c', 5, [
      settledRow('2026-07-01', { platformMetrics: { videoPlays3s: 300 }, crmLeadCount: 2 }),
      // Written before the join existed: its spend must not dilute CPL.
      settledRow('2026-07-02', { spend: 90, impressions: 5000 }),
      settledRow('2026-07-03', { platformMetrics: { videoPlays3s: 100 }, crmLeadCount: 0 }),
    ]));
    expect(agg).toMatchObject({ videoPlays3s: 400, videoImpressions: 2000, crmLeads: 2, crmJoinedSpend: 20, spend: 110, impressions: 7000 });
  });

  it('reports the CRM-joined currency separately from the all-rows currency (CodeRabbit #3122)', () => {
    // An older, unjoined EUR row alongside settled, CRM-joined USD rows: `currency` (all settled
    // rows) is mixed, but the CRM join itself never left USD, so `crmCurrency` must stay single.
    const agg = aggregateCreative(creative('c', 5, [
      settledRow('2026-07-01', { crmLeadCount: 1, spend: 8 }),
      settledRow('2026-07-02', { currency: 'EUR' }),
    ]));
    expect(agg.currency).toBeNull();
    expect(agg.crmCurrency).toBe('USD');
  });
});

describe('creativePerformanceReport (ENG-2194 metrics)', () => {
  // Score rises with CVR and hook rate, and CRM CPL falls as it rises.
  const data = [
    creative('c1', 1, [settledRow('2026-07-01', { platformLeadCount: 2, crmLeadCount: 1, platformMetrics: { videoPlays3s: 100 } })]),
    creative('c2', 3, [settledRow('2026-07-01', { platformLeadCount: 4, crmLeadCount: 2, platformMetrics: { videoPlays3s: 200 } })]),
    creative('c3', 4, [settledRow('2026-07-01', { platformLeadCount: 6, crmLeadCount: 4, platformMetrics: { videoPlays3s: 250 } })]),
    creative('c4', 6, [settledRow('2026-07-01', { platformLeadCount: 9, crmLeadCount: 5, platformMetrics: { videoPlays3s: 400 } })]),
  ];

  it('correlates the score with CVR, hook rate and CRM CPL', () => {
    const report = creativePerformanceReport(data, { iterations: 200, seed: 3 });
    expect(report.cvr.n).toBe(4);
    expect(report.cvr.result!.rho).toBeCloseTo(1, 12);
    expect(report.hookRate.n).toBe(4);
    expect(report.hookRate.result!.rho).toBeCloseTo(1, 12);
    expect(report.cplByCurrency.USD.n).toBe(4);
    expect(report.cplByCurrency.USD.result!.rho).toBeCloseTo(-1, 12);
  });

  it('counts the creatives each new metric leaves out', () => {
    const report = creativePerformanceReport([
      ...data,
      // Image ad: no 3-second plays. Few clicks: no CVR. Rows never joined to the CRM: no CPL.
      creative('image', 5, [settledRow('2026-07-01', { clicks: 20 })]),
      creative('mixed', 5, [
        settledRow('2026-07-01', { crmLeadCount: 1, platformMetrics: { videoPlays3s: 10 } }),
        settledRow('2026-07-02', { currency: 'INR', crmLeadCount: 1, platformMetrics: { videoPlays3s: 10 } }),
      ]),
    ], { minImpressions: 100 });
    expect(report.excluded).toMatchObject({ belowMinClicks: 1, noVideoPlays: 1, noCrmLeads: 1, crmMixedCurrency: 1 });
    expect(report.cvr.n).toBe(5);
    expect(report.hookRate.n).toBe(5);
    expect(report.cplByCurrency.USD.n).toBe(4);
  });

  it('keeps a valid USD CPL pair when the only other currency never joined the CRM (CodeRabbit #3122)', () => {
    const report = creativePerformanceReport([
      ...data,
      creative('crmJoinedOnly', 5, [
        // CRM-joined USD row: this is the CPL pair the creative should contribute.
        settledRow('2026-07-01', { crmLeadCount: 1, spend: 8 }),
        // Settled EUR row that was never joined to the CRM (no crmLeadCount at all). Determining
        // CPL eligibility from the all-rows currency would see USD+EUR and wrongly call this
        // "mixed currency", dropping a perfectly single-currency CRM pairing.
        settledRow('2026-07-02', { currency: 'EUR' }),
      ]),
    ], { iterations: 200, seed: 3 });
    expect(report.excluded.crmMixedCurrency).toBe(0);
    expect(report.cplByCurrency.USD.n).toBe(5);
  });
});

describe('creativePerformanceCorrelation CLI (ENG-2194)', () => {
  it('takes --min-clicks and prints CVR, hook rate and CRM CPL', () => {
    const opts = parseArgs(['--min-clicks', '50']);
    expect(opts.minClicks).toBe(50);
    const lines = formatReport(creativePerformanceReport([
      creative('a', 1, [settledRow('2026-07-01', { platformLeadCount: 1, crmLeadCount: 1, platformMetrics: { videoPlays3s: 100 } })]),
      creative('b', 2, [settledRow('2026-07-01', { platformLeadCount: 2, crmLeadCount: 1, spend: 5, platformMetrics: { videoPlays3s: 200 } })]),
      creative('c', 3, [settledRow('2026-07-01', { platformLeadCount: 3, crmLeadCount: 1, spend: 2, platformMetrics: { videoPlays3s: 300 } })]),
    ], { iterations: 50, minClicks: 50 }), 0, opts);
    expect(lines.find((l) => l.startsWith('Rubric score vs CVR'))).toMatch(/rho=1\.000 {2}n=3/);
    expect(lines.find((l) => l.startsWith('Rubric score vs hook rate'))).toMatch(/rho=1\.000 {2}n=3/);
    expect(lines.find((l) => l.startsWith('Rubric score vs CRM CPL (USD)'))).toMatch(/rho=-1\.000 {2}n=3/);
    expect(lines.find((l) => l.startsWith('Excluded:'))).toContain('< 50 clicks (CVR) 0');
  });
});
