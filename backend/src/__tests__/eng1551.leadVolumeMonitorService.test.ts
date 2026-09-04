import { monitorLeadVolume } from '../services/leadVolumeMonitorService';
import { userDb } from '../services/db';
import { getAccountsByUserId } from '../services/connectedAccountsDb';
import { adsMetricsDb } from '../services/adsMetricsDb';
import { MIN_HISTORY_DAYS, OBSERVATION_WINDOW_DAYS } from '../services/leadVolumeMonitor';
import type { AdsMetricsSnapshotRow } from '../services/adsMetricsDb';

jest.mock('../services/db');
jest.mock('../services/connectedAccountsDb');
jest.mock('../services/adsMetricsDb');

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockGetAccounts = getAccountsByUserId as jest.Mock;
const mockAdsMetricsDb = adsMetricsDb as jest.Mocked<typeof adsMetricsDb>;

const CLIENT = { userId: 'client-1', email: 'haven@example.com', displayName: 'Haven' };

function campaignRow(overrides: Partial<AdsMetricsSnapshotRow> = {}): AdsMetricsSnapshotRow {
  return {
    entityKey: 'meta#act123#camp1',
    date: '2026-08-01',
    rowType: 'campaign',
    platform: 'meta',
    accountId: 'act123',
    parentAccountId: null,
    userId: CLIENT.userId,
    currency: 'USD',
    reportingTimezone: null,
    dataQuality: 'exact',
    campaignId: 'camp1',
    campaignName: 'Test Campaign',
    spend: 10,
    impressions: 100,
    clicks: 5,
    leadCount: 1,
    platformMetrics: {},
    snapshotSource: 'daily',
    capturedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAdsMetricsDb.getSnapshotsByUserDateRange.mockResolvedValue({ rows: [], truncated: false });
  mockAdsMetricsDb.getAccountDaySnapshots.mockResolvedValue({ rows: [], truncated: false });
});

describe('monitorLeadVolume — authorization', () => {
  it('refuses a non-admin caller', async () => {
    const result = await monitorLeadVolume('caller-1', 'haven@example.com', false);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Admin access required/);
    expect(mockGetAccounts).not.toHaveBeenCalled();
  });

  it('falls back to a fresh admin lookup when callerIsAdmin is undefined', async () => {
    (mockUserDb.getUserById as jest.Mock).mockResolvedValue({ isAdmin: true });
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(CLIENT);
    mockGetAccounts.mockResolvedValue([]);
    const result = await monitorLeadVolume('caller-1', 'haven@example.com', undefined);
    expect(result.success).toBe(true);
    expect(mockUserDb.getUserById).toHaveBeenCalledWith('caller-1');
  });
});

describe('monitorLeadVolume — client resolution', () => {
  it('returns a not-found error for an unresolvable client', async () => {
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(null);
    (mockUserDb.getAllUsers as jest.Mock).mockResolvedValue([]);
    const result = await monitorLeadVolume('caller-1', 'nobody@example.com', true);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Client not found/);
  });

  it('falls back to display-name matching when email lookup misses', async () => {
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(null);
    (mockUserDb.getAllUsers as jest.Mock).mockResolvedValue([CLIENT]);
    mockGetAccounts.mockResolvedValue([]);
    const result = await monitorLeadVolume('caller-1', 'hav', true);
    expect(result.success).toBe(true);
    expect(result.client?.userId).toBe(CLIENT.userId);
  });
});

describe('monitorLeadVolume — ad account filtering', () => {
  beforeEach(() => {
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(CLIENT);
  });

  it('excludes a connected account with platform=meta but account_type != ad_account (e.g. Instagram Business)', async () => {
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'ig-123', config: { account_type: 'instagram_business' } },
    ]);
    const result = await monitorLeadVolume('caller-1', 'haven@example.com', true);
    expect(result.reports).toEqual([]);
  });

  it('includes only platform=meta, account_type=ad_account rows', async () => {
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'act123', config: { account_type: 'ad_account' } },
      { platform: 'meta', account_id: 'ig-123', config: { account_type: 'instagram_business' } },
      { platform: 'google_ads', account_id: 'g-123', config: { account_type: 'ad_account' } },
    ]);
    const result = await monitorLeadVolume('caller-1', 'haven@example.com', true);
    expect(result.reports).toHaveLength(1);
    expect(result.reports?.[0].accountId).toBe('act123');
  });

  it('returns an empty reports array with a message when the client has no Meta ad accounts', async () => {
    mockGetAccounts.mockResolvedValue([]);
    const result = await monitorLeadVolume('caller-1', 'haven@example.com', true);
    expect(result.success).toBe(true);
    expect(result.reports).toEqual([]);
    expect(result.message).toMatch(/No connected Meta ad accounts/);
  });
});

describe('monitorLeadVolume — multi-account isolation', () => {
  it('never leaks one ad account\'s rows into another account\'s report', async () => {
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(CLIENT);
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'act-A', config: { account_type: 'ad_account' } },
      { platform: 'meta', account_id: 'act-B', config: { account_type: 'ad_account' } },
    ]);
    mockAdsMetricsDb.getSnapshotsByUserDateRange.mockResolvedValue({
      rows: [
        campaignRow({ accountId: 'act-A', campaignId: 'campA', entityKey: 'meta#act-A#campA', leadCount: 5 }),
        campaignRow({ accountId: 'act-B', campaignId: 'campB', entityKey: 'meta#act-B#campB', leadCount: 0 }),
      ],
      truncated: false,
    });
    const result = await monitorLeadVolume('caller-1', 'haven@example.com', true);
    expect(result.reports).toHaveLength(2);
    const reportA = result.reports!.find(r => r.accountId === 'act-A')!;
    const reportB = result.reports!.find(r => r.accountId === 'act-B')!;
    expect(reportA.campaigns).toHaveLength(1);
    expect(reportA.campaigns[0].campaignId).toBe('campA');
    expect(reportB.campaigns).toHaveLength(1);
    expect(reportB.campaigns[0].campaignId).toBe('campB');
  });
});

describe('monitorLeadVolume — default window', () => {
  it('uses a 60-day default window ending at `now` when since/until are not supplied', async () => {
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(CLIENT);
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'act123', config: { account_type: 'ad_account' } },
    ]);
    const now = new Date('2026-09-04T00:00:00.000Z');
    await monitorLeadVolume('caller-1', 'haven@example.com', true, { now });
    expect(mockAdsMetricsDb.getSnapshotsByUserDateRange).toHaveBeenCalledWith(
      CLIENT.userId,
      '2026-07-06', // 60 days before 2026-09-04
      '2026-09-04',
      { platform: 'meta' },
    );
  });

  it('honors explicit since/until when supplied', async () => {
    (mockUserDb.getUserByEmail as jest.Mock).mockResolvedValue(CLIENT);
    mockGetAccounts.mockResolvedValue([
      { platform: 'meta', account_id: 'act123', config: { account_type: 'ad_account' } },
    ]);
    await monitorLeadVolume('caller-1', 'haven@example.com', true, { since: '2026-01-01', until: '2026-01-31' });
    expect(mockAdsMetricsDb.getSnapshotsByUserDateRange).toHaveBeenCalledWith(
      CLIENT.userId,
      '2026-01-01',
      '2026-01-31',
      { platform: 'meta' },
    );
  });
});
