/**
 * ENG-2141 (ENG-2128 T9): ad-level rows in AW-AdsMetricsSnapshots, from recorded-shape Meta
 * insights fixtures. No live calls: fetch and the store are mocked.
 */
import {
  AD_LEVEL_SNAPSHOTS_ENV,
  isAdLevelSnapshotEnabled,
  runMetaMetricsSnapshot,
  snapshotMetaAdMetricsForDate,
} from '../cron/metaMetricsSnapshotCron';
import { adsMetricsDb, buildAdEntityKey, isMetaRowSettled, type AdsMetricsAdRow } from '../services/adsMetricsDb';
import { userDb, crmDb } from '../services/db';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';
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

type FetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> };
const fetchMock = jest.fn<Promise<FetchResponse>, [string]>();
const ok = (body: unknown): FetchResponse => ({ ok: true, json: async () => body });

const adRows = (): AdsMetricsAdRow[] => jest.mocked(adsMetricsDb.putAdSnapshot).mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.mocked(adsMetricsDb.putAdSnapshot).mockResolvedValue(undefined);
  jest.mocked(adsMetricsDb.putSnapshot).mockResolvedValue(undefined);
});

describe('snapshotMetaAdMetricsForDate', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValueOnce(ok(fixture.pages[0])).mockResolvedValueOnce(ok(fixture.pages[1]));
  });

  it('writes one ad row per ad across every page, keyed by ad and date', async () => {
    const result = await snapshotMetaAdMetricsForDate(USER, DATE, CREDS, CONTEXT);

    expect(result).toEqual({ adRowsWritten: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = fetchMock.mock.calls[0][0];
    expect(firstUrl).toContain(`act_${ACCOUNT}/insights`);
    expect(firstUrl).toContain('&level=ad&');
    expect(firstUrl).toContain(`time_range={'since':'${DATE}','until':'${DATE}'}`);
    expect(firstUrl).toMatch(/fields=ad_id,ad_name,adset_id,campaign_id,spend,impressions,clicks,ctr,cpm,frequency,actions,video_p25_watched_actions,video_thruplay_watched_actions&/);
    expect(fetchMock.mock.calls[1][0]).toBe(fixture.pages[0].paging.next);

    expect(adRows().map((r) => r.entityKey)).toEqual([
      `meta#${ACCOUNT}#ad#120200000000000011`,
      `meta#${ACCOUNT}#ad#120200000000000012`,
      `meta#${ACCOUNT}#ad#120200000000000013`,
    ]);
    expect(adRows()[0]).toEqual({
      entityKey: buildAdEntityKey('meta', ACCOUNT, '120200000000000011'),
      date: DATE,
      rowType: 'ad',
      platform: 'meta',
      accountId: ACCOUNT,
      parentAccountId: null,
      ownerUserId: USER,
      currency: 'USD',
      reportingTimezone: 'America/Los_Angeles',
      dataQuality: 'exact',
      adId: '120200000000000011',
      adName: 'Generated 4:5 - spring offer',
      adsetId: '120200000000000021',
      campaignId: '120200000000000031',
      spend: 42.17,
      impressions: 3810,
      clicks: 61,
      // `lead`, `offsite_conversion.fb_pixel_lead` and `onsite_web_lead` are one conversion.
      platformLeadCount: 3,
      platformMetrics: { ctr: 1.60105, cpm: 11.068241, frequency: 1.214286 },
      snapshotSource: 'daily',
      capturedAt: expect.any(String),
    });
  });

  it('keeps ad rows out of the userId-date-index GSI (no userId attribute)', async () => {
    await snapshotMetaAdMetricsForDate(USER, DATE, CREDS, CONTEXT);
    for (const row of adRows()) expect(row).not.toHaveProperty('userId');
  });

  it('records video p25 / thruplay only when Meta returned them, and zero leads when no actions came back', async () => {
    await snapshotMetaAdMetricsForDate(USER, DATE, CREDS, CONTEXT);
    const [image, video, noActions] = adRows();
    expect(image.platformMetrics).not.toHaveProperty('videoP25Watched');
    expect(video.platformMetrics).toMatchObject({ videoP25Watched: 640, videoThruplayWatched: 212 });
    expect(video.platformLeadCount).toBe(0);
    expect(noActions).toMatchObject({ platformLeadCount: 0, clicks: 0, impressions: 97 });
  });
});

describe('snapshotMetaAdMetricsForDate failures', () => {
  it('throws on a Meta error so the cron logs the day instead of writing a partial set', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: { message: 'Invalid parameter' } }) });
    await expect(snapshotMetaAdMetricsForDate(USER, DATE, CREDS, CONTEXT)).rejects.toThrow(/Invalid parameter/);
    expect(adsMetricsDb.putAdSnapshot).not.toHaveBeenCalled();
  });
});

describe('runMetaMetricsSnapshot ad-level flag', () => {
  const campaignPage = {
    data: [{ campaign_id: '120200000000000031', campaign_name: 'Spring', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' }],
  };
  const env = process.env[AD_LEVEL_SNAPSHOTS_ENV];

  beforeEach(() => {
    jest.mocked(userDb.getAllUsers).mockResolvedValue([
      {
        userId: USER,
        connected_accounts: [{ platform: 'meta', account_id: ACCOUNT, created_at: '2026-01-01T00:00:00.000Z', config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: ACCOUNT } }],
      },
    ] as never);
    jest.mocked(getMetaAccountCredentials).mockResolvedValue({ ...CREDS, accountName: 'Test' } as never);
    jest.mocked(crmDb.getLeadListsByUserId).mockResolvedValue([] as never);
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('/insights')) return ok(fixture.accountContext);
      return ok(url.includes('level=ad') ? { data: fixture.pages[1].data } : campaignPage);
    });
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (env === undefined) delete process.env[AD_LEVEL_SNAPSHOTS_ENV];
    else process.env[AD_LEVEL_SNAPSHOTS_ENV] = env;
    jest.restoreAllMocks();
  });

  it('is off unless the variable is exactly "true"', () => {
    expect(isAdLevelSnapshotEnabled({})).toBe(false);
    expect(isAdLevelSnapshotEnabled({ [AD_LEVEL_SNAPSHOTS_ENV]: '1' })).toBe(false);
    expect(isAdLevelSnapshotEnabled({ [AD_LEVEL_SNAPSHOTS_ENV]: 'true' })).toBe(true);
  });

  it('writes no ad rows and makes no level=ad call while off', async () => {
    delete process.env[AD_LEVEL_SNAPSHOTS_ENV];
    await runMetaMetricsSnapshot();
    expect(adsMetricsDb.putAdSnapshot).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('level=ad'))).toBe(false);
    expect(adsMetricsDb.putSnapshot).toHaveBeenCalled();
  });

  it('writes ad rows for every date in the refresh window when on', async () => {
    process.env[AD_LEVEL_SNAPSHOTS_ENV] = 'true';
    await runMetaMetricsSnapshot();
    expect(new Set(adRows().map((r) => r.date)).size).toBe(30);
  });

  it('a failing ad read does not cost the day its campaign rows', async () => {
    process.env[AD_LEVEL_SNAPSHOTS_ENV] = 'true';
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('/insights')) return ok(fixture.accountContext);
      if (url.includes('level=ad')) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return ok(campaignPage);
    });

    await runMetaMetricsSnapshot();

    const campaignDates = jest.mocked(adsMetricsDb.putSnapshot).mock.calls.map((c) => c[0]).filter((r) => r.rowType === 'campaign');
    expect(campaignDates).toHaveLength(30);
    expect(adsMetricsDb.putAdSnapshot).not.toHaveBeenCalled();
    expect(errors.mock.calls.some((c) => String(c[0]).includes('(ad level)'))).toBe(true);
  });
});

describe('isMetaRowSettled (28-day settling window)', () => {
  // 2026-08-01 in UTC-12 ends at 2026-08-02T12:00Z; + 28 days = 2026-08-30T12:00Z.
  it('is unsettled until 28 days after the latest possible end of the reporting day', () => {
    expect(isMetaRowSettled({ date: DATE, capturedAt: '2026-08-30T11:59:59.999Z' })).toBe(false);
    expect(isMetaRowSettled({ date: DATE, capturedAt: '2026-08-30T12:00:00.000Z' })).toBe(true);
  });

  it('matches the cron: the 09:00 UTC run on day +30 captures a settled row, day +29 does not', () => {
    expect(isMetaRowSettled({ date: DATE, capturedAt: '2026-08-31T09:00:00.000Z' })).toBe(true);
    expect(isMetaRowSettled({ date: DATE, capturedAt: '2026-08-30T09:00:00.000Z' })).toBe(false);
  });

  it('judges by capture time, so a row last written inside the window stays unsettled', () => {
    expect(isMetaRowSettled({ date: DATE, capturedAt: '2026-08-05T09:00:00.000Z' })).toBe(false);
    expect(isMetaRowSettled({ date: 'not-a-date', capturedAt: '2026-12-01T00:00:00.000Z' })).toBe(false);
    expect(isMetaRowSettled({ date: DATE, capturedAt: '' })).toBe(false);
  });
});
