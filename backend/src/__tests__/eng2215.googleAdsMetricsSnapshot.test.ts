import {
  snapshotGoogleAdsMetricsForDate,
  enumerateDistinctGoogleAdsAccounts,
  runGoogleAdsMetricsSnapshot,
  fetchGoogleAdsAccountContext,
  isGoogleAdsMetricsSnapshotEnabled,
  GOOGLE_ADS_METRICS_SNAPSHOT_ENV,
} from '../cron/googleAdsMetricsSnapshotCron';
import { userDb } from '../services/db';
import { adsMetricsDb, buildEntityKey, ACCOUNT_DAY_SENTINEL } from '../services/adsMetricsDb';
import { googleAdsService } from '../services/googleAdsService';

jest.mock('../services/db', () => ({
  userDb: {
    getAllUsers: jest.fn(),
  },
}));

jest.mock('../services/adsMetricsDb', () => ({
  ...jest.requireActual('../services/adsMetricsDb'),
  adsMetricsDb: { putSnapshot: jest.fn() },
}));

jest.mock('../services/googleAdsService', () => ({
  googleAdsService: {
    search: jest.fn(),
    getAccountCredentials: jest.fn(),
  },
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockAdsDb = adsMetricsDb as jest.Mocked<typeof adsMetricsDb>;
const mockSearch = googleAdsService.search as jest.Mock;
const mockGetCreds = googleAdsService.getAccountCredentials as jest.Mock;

/** Whatever shape adsMetricsDb.putSnapshot actually accepts — reused instead of `any` so the
 * assertions below are checked against the real AdsMetricsSnapshotRow shape. */
type WrittenRow = Parameters<typeof mockAdsDb.putSnapshot>[0];
const writtenRows = (): WrittenRow[] => mockAdsDb.putSnapshot.mock.calls.map((call) => call[0]);
const campaignRows = (): WrittenRow[] => writtenRows().filter((r) => r.rowType === 'campaign');
const accountDayRows = (): WrittenRow[] => writtenRows().filter((r) => r.rowType === 'account_day');

/** `userDb.getAllUsers()`'s real return type is a large, mostly-irrelevant-here User shape; this
 * mocks only the fields enumerateDistinctGoogleAdsAccounts actually reads, funnelled through
 * `unknown` at exactly one point rather than sprinkling `any` through every test. */
type UsersList = Awaited<ReturnType<typeof userDb.getAllUsers>>;
interface TestConnectedAccount {
  platform: string;
  account_id: string;
  config: Record<string, unknown>;
  created_at?: string;
}
interface TestUser {
  userId: string;
  connected_accounts?: TestConnectedAccount[];
}
function mockUsers(users: readonly TestUser[]): void {
  mockUserDb.getAllUsers.mockResolvedValue(users as unknown as UsersList);
}

const TEST_DATE = '2026-08-09';
const TEST_CONTEXT = { currency: 'USD', reportingTimezone: 'America/Los_Angeles' };
const TEST_CREDENTIALS = { customerId: '2883029950', accessToken: 'tok', loginCustomerId: '2883029950' };

/** A `campaign` resource row shaped exactly as googleAdsService.search returns it — camelCase
 * keys, money/int64 fields as numeric strings (Google's REST JSON encoding). */
function campaignRow(overrides: Partial<{
  id: string; name: string; impressions: string; clicks: string; costMicros: string;
  conversions: string; ctr: string; averageCpc: string;
}> = {}) {
  return {
    campaign: { id: overrides.id ?? '111', name: overrides.name ?? 'Campaign A' },
    metrics: {
      impressions: overrides.impressions ?? '1000',
      clicks: overrides.clicks ?? '20',
      costMicros: overrides.costMicros ?? '10500000', // $10.50
      conversions: overrides.conversions ?? '2',
      ctr: overrides.ctr ?? '0.02',
      averageCpc: overrides.averageCpc ?? '525000', // $0.525/click, in micros
    },
  };
}

/** googleAdsService.search's own completeness out-param shape. */
type Completeness = { truncated?: boolean };

describe('ENG-2215 snapshotGoogleAdsMetricsForDate (Google Ads metrics snapshot)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAdsDb.putSnapshot.mockResolvedValue(undefined);
  });

  it('converts cost_micros AND average_cpc from micros to currency (both are money fields, only one has "_micros" in its name)', async () => {
    mockSearch.mockResolvedValue([campaignRow({ costMicros: '10500000', averageCpc: '525000' })]);

    await snapshotGoogleAdsMetricsForDate('user-1', TEST_DATE, TEST_CREDENTIALS, TEST_CONTEXT);

    const row = campaignRows()[0];
    expect(row.spend).toBeCloseTo(10.5, 6);
    expect(row.platformMetrics.averageCpc).toBeCloseTo(0.525, 6);
    // Never stored raw — this is the exact footgun the ENG-2215 brief calls out.
    expect(row.spend).not.toBe(10500000);
    expect(row.platformMetrics.averageCpc).not.toBe(525000);
  });

  it('writes rows with platform "google_ads" and the platform#accountId#campaignId entity key shape', async () => {
    mockSearch.mockResolvedValue([campaignRow({ id: '999888777' })]);

    await snapshotGoogleAdsMetricsForDate('user-1', TEST_DATE, TEST_CREDENTIALS, TEST_CONTEXT);

    const row = campaignRows()[0];
    expect(row.platform).toBe('google_ads');
    expect(row.entityKey).toBe(buildEntityKey('google_ads', TEST_CREDENTIALS.customerId, '999888777'));
    expect(row.campaignId).toBe('999888777');
    expect(row.accountId).toBe(TEST_CREDENTIALS.customerId);
  });

  it('carries ctr and conversions through unconverted (not money fields)', async () => {
    mockSearch.mockResolvedValue([campaignRow({ ctr: '0.045', conversions: '3.5' })]);

    await snapshotGoogleAdsMetricsForDate('user-1', TEST_DATE, TEST_CREDENTIALS, TEST_CONTEXT);

    const row = campaignRows()[0];
    expect(row.platformMetrics.ctr).toBeCloseTo(0.045);
    expect(row.platformMetrics.conversions).toBeCloseTo(3.5);
  });

  it('writes ALL rows googleAdsService.search returns, not just the first page — multi-row response', async () => {
    mockSearch.mockResolvedValue([
      campaignRow({ id: '1' }),
      campaignRow({ id: '2' }),
      campaignRow({ id: '3' }),
    ]);

    const result = await snapshotGoogleAdsMetricsForDate('user-1', TEST_DATE, TEST_CREDENTIALS, TEST_CONTEXT);

    expect(result.rowsWritten).toBe(3);
    expect(campaignRows()).toHaveLength(3);
    expect(campaignRows().map((r) => r.campaignId).sort()).toEqual(['1', '2', '3']);
  });

  it('refuses to write a day when googleAdsService.search reports its page cap truncated the read', async () => {
    mockSearch.mockImplementation(
      (_c: string, _a: string, _q: string, _l?: string, completeness?: Completeness) => {
        if (completeness) completeness.truncated = true;
        return Promise.resolve([campaignRow()]);
      }
    );

    await expect(
      snapshotGoogleAdsMetricsForDate('user-1', TEST_DATE, TEST_CREDENTIALS, TEST_CONTEXT)
    ).rejects.toThrow(/truncated/i);

    // Not a partial write — nothing for this day at all, including no account_day row.
    expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
  });

  it('always writes the account_day row, including when zero campaigns reported activity', async () => {
    mockSearch.mockResolvedValue([]);

    const result = await snapshotGoogleAdsMetricsForDate('user-1', TEST_DATE, TEST_CREDENTIALS, TEST_CONTEXT);

    expect(result.rowsWritten).toBe(0);
    expect(campaignRows()).toHaveLength(0);
    expect(accountDayRows()).toHaveLength(1);
    const dayRow = accountDayRows()[0];
    expect(dayRow.campaignsReported).toBe(0);
    expect(dayRow.entityKey).toBe(buildEntityKey('google_ads', TEST_CREDENTIALS.customerId, ACCOUNT_DAY_SENTINEL));
    // No CRM/lead attribution fields — out of scope for this cron.
    expect(dayRow.totalLeadCount).toBeUndefined();
    expect(dayRow.unattributedLeadCount).toBeUndefined();
  });

  it('sets parentAccountId to the manager id only when the leaf is reached through one', async () => {
    mockSearch.mockResolvedValue([campaignRow()]);

    await snapshotGoogleAdsMetricsForDate(
      'user-1', TEST_DATE,
      { customerId: '2883029950', accessToken: 'tok', loginCustomerId: '2737828986' },
      TEST_CONTEXT
    );
    expect(campaignRows()[0].parentAccountId).toBe('2737828986');

    mockAdsDb.putSnapshot.mockClear();
    mockSearch.mockResolvedValue([campaignRow()]);
    await snapshotGoogleAdsMetricsForDate(
      'user-1', TEST_DATE,
      { customerId: '2883029950', accessToken: 'tok', loginCustomerId: '2883029950' },
      TEST_CONTEXT
    );
    expect(campaignRows()[0].parentAccountId).toBeNull();
  });

  it('dryRun runs the same read/conversion path but calls adsMetricsDb.putSnapshot zero times', async () => {
    mockSearch.mockResolvedValue([campaignRow(), campaignRow({ id: '2' })]);

    const result = await snapshotGoogleAdsMetricsForDate(
      'user-1', TEST_DATE, TEST_CREDENTIALS, TEST_CONTEXT, 'daily', /* dryRun */ true
    );

    expect(result.rowsWritten).toBe(2);
    expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
  });
});

describe('ENG-2215 fetchGoogleAdsAccountContext', () => {
  beforeEach(() => jest.resetAllMocks());

  it('reads currency and timezone live from the customer resource', async () => {
    mockSearch.mockResolvedValue([{ customer: { currencyCode: 'INR', timeZone: 'Asia/Kolkata' } }]);
    const ctx = await fetchGoogleAdsAccountContext('123', 'tok', '123');
    expect(ctx).toEqual({ currency: 'INR', reportingTimezone: 'Asia/Kolkata' });
  });

  it('fails closed when Google returns no currency, rather than defaulting silently', async () => {
    mockSearch.mockResolvedValue([{ customer: { currencyCode: '', timeZone: 'Asia/Kolkata' } }]);
    await expect(fetchGoogleAdsAccountContext('123', 'tok', '123')).rejects.toThrow(/no currency/i);
  });
});

describe('ENG-2215 enumerateDistinctGoogleAdsAccounts', () => {
  beforeEach(() => jest.resetAllMocks());

  it('only picks google_ads accounts, ignoring other platforms on the same user', async () => {
    mockUsers([
      {
        userId: 'u1',
        connected_accounts: [
          { platform: 'meta', account_id: 'meta-1', config: {} },
          { platform: 'google_ads', account_id: '2883029950', config: { customer_id: '2883029950' }, created_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ]);

    const accounts = await enumerateDistinctGoogleAdsAccounts();
    expect(accounts).toEqual([{ customerId: '2883029950', canonicalUserId: 'u1' }]);
  });

  it('dedupes a shared account across users, picking the EARLIEST created_at as canonical', async () => {
    mockUsers([
      {
        userId: 'later-user',
        connected_accounts: [
          { platform: 'google_ads', account_id: '2883029950', config: { customer_id: '2883029950' }, created_at: '2026-05-01T00:00:00.000Z' },
        ],
      },
      {
        userId: 'earlier-user',
        connected_accounts: [
          { platform: 'google_ads', account_id: '2883029950', config: { customer_id: '2883029950' }, created_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ]);

    const accounts = await enumerateDistinctGoogleAdsAccounts();
    expect(accounts).toEqual([{ customerId: '2883029950', canonicalUserId: 'earlier-user' }]);
  });

  it('returns nothing when a user has no google_ads connected accounts', async () => {
    mockUsers([
      { userId: 'u1', connected_accounts: [] },
      { userId: 'u2' },
    ]);
    expect(await enumerateDistinctGoogleAdsAccounts()).toEqual([]);
  });
});

describe('ENG-2215 runGoogleAdsMetricsSnapshot — flag gating', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockAdsDb.putSnapshot.mockResolvedValue(undefined);
  });

  it('isGoogleAdsMetricsSnapshotEnabled is false unless the env var is exactly "true"', () => {
    expect(isGoogleAdsMetricsSnapshotEnabled({})).toBe(false);
    expect(isGoogleAdsMetricsSnapshotEnabled({ [GOOGLE_ADS_METRICS_SNAPSHOT_ENV]: 'True' })).toBe(false);
    expect(isGoogleAdsMetricsSnapshotEnabled({ [GOOGLE_ADS_METRICS_SNAPSHOT_ENV]: '1' })).toBe(false);
    expect(isGoogleAdsMetricsSnapshotEnabled({ [GOOGLE_ADS_METRICS_SNAPSHOT_ENV]: 'true' })).toBe(true);
  });

  it('is a complete no-op when disabled and not a dry run: never enumerates accounts, never calls the Google Ads API, never writes', async () => {
    const result = await runGoogleAdsMetricsSnapshot({ enabled: false, dryRun: false });

    expect(result).toEqual({ status: 'refused', reason: 'flag_off' });
    expect(mockUserDb.getAllUsers).not.toHaveBeenCalled();
    expect(mockGetCreds).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
  });

  it('a dry run proceeds even with the flag off, but still never writes', async () => {
    mockUsers([
      {
        userId: 'u1',
        connected_accounts: [
          { platform: 'google_ads', account_id: '2883029950', config: { customer_id: '2883029950' }, created_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ]);
    mockGetCreds.mockResolvedValue({ accessToken: 'tok', customerId: '2883029950', currency: 'USD', loginCustomerId: '2883029950' });
    mockSearch.mockImplementation((_c: string, _a: string, query: string) => {
      if (query.includes('FROM customer')) return Promise.resolve([{ customer: { currencyCode: 'USD', timeZone: 'UTC' } }]);
      return Promise.resolve([campaignRow()]);
    });

    const result = await runGoogleAdsMetricsSnapshot({ enabled: false, dryRun: true });

    expect(result.status).toBe('ran');
    if (result.status === 'ran') {
      expect(result.accountsAttempted).toBe(1);
      expect(result.rowsWritten).toBeGreaterThan(0);
    }
    expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
  });

  it('when enabled, enumerates accounts, resolves credentials per account, and writes rows', async () => {
    mockUsers([
      {
        userId: 'u1',
        connected_accounts: [
          { platform: 'google_ads', account_id: '2883029950', config: { customer_id: '2883029950' }, created_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ]);
    mockGetCreds.mockResolvedValue({ accessToken: 'tok', customerId: '2883029950', currency: 'USD', loginCustomerId: '2883029950' });
    mockSearch.mockImplementation((_c: string, _a: string, query: string) => {
      if (query.includes('FROM customer')) return Promise.resolve([{ customer: { currencyCode: 'USD', timeZone: 'UTC' } }]);
      return Promise.resolve([campaignRow()]);
    });

    const result = await runGoogleAdsMetricsSnapshot({ enabled: true, dryRun: false });

    expect(result.status).toBe('ran');
    expect(mockGetCreds).toHaveBeenCalledWith('u1', '2883029950');
    expect(mockAdsDb.putSnapshot).toHaveBeenCalled();
    expect(campaignRows().every((r) => r.platform === 'google_ads')).toBe(true);
  }, 20000);

  it('one account failing to resolve credentials does not stop other accounts', async () => {
    mockUsers([
      {
        userId: 'bad-user',
        connected_accounts: [
          { platform: 'google_ads', account_id: 'bad-account', config: { customer_id: 'bad-account' }, created_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
      {
        userId: 'good-user',
        connected_accounts: [
          { platform: 'google_ads', account_id: 'good-account', config: { customer_id: 'good-account' }, created_at: '2026-01-01T00:00:00.000Z' },
        ],
      },
    ]);
    mockGetCreds.mockImplementation((_userId: string, customerId: string) => {
      if (customerId === 'bad-account') return Promise.reject(new Error('no token'));
      return Promise.resolve({ accessToken: 'tok', customerId: 'good-account', currency: 'USD', loginCustomerId: 'good-account' });
    });
    mockSearch.mockImplementation((_c: string, _a: string, query: string) => {
      if (query.includes('FROM customer')) return Promise.resolve([{ customer: { currencyCode: 'USD', timeZone: 'UTC' } }]);
      return Promise.resolve([campaignRow()]);
    });

    const result = await runGoogleAdsMetricsSnapshot({ enabled: true, dryRun: false });

    expect(result.status).toBe('ran');
    if (result.status === 'ran') expect(result.accountsAttempted).toBe(2);
    // Only the good account's rows were written.
    expect(campaignRows().every((r) => r.accountId === 'good-account')).toBe(true);
    expect(campaignRows().length).toBeGreaterThan(0);
  }, 20000);
});
