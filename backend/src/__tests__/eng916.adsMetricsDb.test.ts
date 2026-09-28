/**
 * ENG-916 — read path for the shared ads metrics store.
 *
 * The store is shared across Meta, Google Ads and LinkedIn Ads, so two properties matter beyond
 * "does the query work": rows of different types and different accounts must never bleed into each
 * other, and a short read must never masquerade as a complete one. Every consumer reads a date
 * series to compute a trend, so a missing tail surfaces as a decline that never happened.
 */

const mockQuery = jest.fn();
const mockPut = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({ put: mockPut, query: mockQuery })),
  },
}));

import {
  adsMetricsDb,
  buildAdEntityKey,
  buildEntityKey,
  ACCOUNT_DAY_SENTINEL,
  AdsMetricsSnapshotRow,
} from '../services/adsMetricsDb';

const HAVEN_USER = 'a3917669-1c7d-45ed-8ef9-f454de109b6f';

const row = (
  over: Partial<AdsMetricsSnapshotRow> & { date: string }
): AdsMetricsSnapshotRow => ({
  entityKey: buildEntityKey('meta', '1842363582956923', 'c1'),
  rowType: 'campaign',
  platform: 'meta',
  accountId: '1842363582956923',
  parentAccountId: null,
  userId: HAVEN_USER,
  currency: 'USD',
  reportingTimezone: 'America/Los_Angeles',
  dataQuality: 'exact',
  campaignId: 'c1',
  campaignName: 'Leasing',
  spend: 1,
  impressions: 10,
  clicks: 1,
  platformMetrics: { ctr: 1, cpm: 1, frequency: 1 },
  snapshotSource: 'daily',
  capturedAt: '2026-08-25T09:00:00.000Z',
  ...over,
});

function queuePages(pages: Array<{ Items: any[]; LastEvaluatedKey?: any }>) {
  mockQuery.mockReset();
  for (const page of pages) {
    mockQuery.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page) });
  }
}

describe('ENG-916 adsMetricsDb read path', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns a campaign series oldest-first and reports it complete', async () => {
    queuePages([{ Items: [row({ date: '2026-08-01' }), row({ date: '2026-08-02' })] }]);

    const result = await adsMetricsDb.getSnapshotsByCampaign('meta', '1842363582956923', 'c1');

    expect(result.rows.map((r: AdsMetricsSnapshotRow) => r.date)).toEqual(['2026-08-01', '2026-08-02']);
    expect(result.truncated).toBe(false);
    // Oldest-first is a contract — consumers read these left to right.
    expect(mockQuery.mock.calls[0][0].ScanIndexForward).toBe(true);
  });

  it('scopes a campaign query by platform AND account, so identical campaign ids cannot collide', async () => {
    queuePages([{ Items: [] }]);
    await adsMetricsDb.getSnapshotsByCampaign('google_ads', '2883029950', 'c1');

    // A single user holds several accounts on the same platform (mvarma has two Meta ad accounts),
    // and campaign ids are only unique within an account — so the key must carry both.
    expect(mockQuery.mock.calls[0][0].ExpressionAttributeValues[':entityKey'])
      .toBe('google_ads#2883029950#c1');
  });

  it('follows LastEvaluatedKey across pages and resumes from the prior cursor', async () => {
    queuePages([
      { Items: [row({ date: '2026-08-01' })], LastEvaluatedKey: { entityKey: 'k', date: '2026-08-01' } },
      { Items: [row({ date: '2026-08-02' })] },
    ]);

    const result = await adsMetricsDb.getSnapshotsByCampaign('meta', '1842363582956923', 'c1');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(result.rows.map((r: AdsMetricsSnapshotRow) => r.date)).toEqual(['2026-08-01', '2026-08-02']);
    expect(mockQuery.mock.calls[1][0].ExclusiveStartKey).toEqual({ entityKey: 'k', date: '2026-08-01' });
    expect(result.truncated).toBe(false);
  });

  it('reports truncated: true instead of silently returning a short read', async () => {
    mockQuery.mockReset();
    mockQuery.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [row({ date: '2026-08-01' })],
        LastEvaluatedKey: { entityKey: 'k', date: '2026-08-01' },
      }),
    });

    const result = await adsMetricsDb.getSnapshotsByCampaign('meta', '1842363582956923', 'c1');

    expect(result.truncated).toBe(true);
  });

  it('never puts the reserved word `date` bare in a key condition', async () => {
    queuePages([{ Items: [] }]);
    await adsMetricsDb.getSnapshotsByCampaign('meta', '1842363582956923', 'c1', {
      since: '2026-08-01',
      until: '2026-08-28',
    });

    const params = mockQuery.mock.calls[0][0];
    // `date` is reserved in DynamoDB — a bare reference is a runtime ValidationException that a
    // mocked-SDK unit test cannot otherwise catch.
    expect(params.ExpressionAttributeNames).toEqual({ '#date': 'date' });
    expect(params.KeyConditionExpression).toContain('#date BETWEEN');
  });

  it('excludes account_day rows from the campaign series', async () => {
    queuePages([
      {
        Items: [
          row({ date: '2026-08-01' }),
          row({
            date: '2026-08-01',
            rowType: 'account_day',
            campaignId: null,
            entityKey: buildEntityKey('meta', '1842363582956923', ACCOUNT_DAY_SENTINEL),
            unattributedLeadCount: 4,
            campaignsReported: 1,
          }),
        ],
      },
    ]);

    const result = await adsMetricsDb.getSnapshotsByUserDateRange(HAVEN_USER, '2026-08-01', '2026-08-28');

    // A caller asking for campaign metrics must never silently receive a different row type mixed
    // in — the two carry different fields and mean different things.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rowType).toBe('campaign');
    expect(mockQuery.mock.calls[0][0].IndexName).toBe('userId-date-index');
  });

  it('returns only account_day rows from getAccountDaySnapshots', async () => {
    queuePages([
      {
        Items: [
          row({ date: '2026-08-01' }),
          row({
            date: '2026-08-01',
            rowType: 'account_day',
            campaignId: null,
            unattributedLeadCount: 4,
            campaignsReported: 0,
          }),
        ],
      },
    ]);

    const result = await adsMetricsDb.getAccountDaySnapshots(HAVEN_USER, '2026-08-01', '2026-08-28');

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].unattributedLeadCount).toBe(4);
    // campaignsReported: 0 is a measurement, not an absence — that distinction is the point.
    expect(result.rows[0].campaignsReported).toBe(0);
  });

  it('narrows by platform when asked, so one channel cannot pollute another series', async () => {
    queuePages([
      { Items: [row({ date: '2026-08-01' }), row({ date: '2026-08-01', platform: 'google_ads' })] },
    ]);

    const result = await adsMetricsDb.getSnapshotsByUserDateRange(
      HAVEN_USER, '2026-08-01', '2026-08-28', { platform: 'google_ads' }
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].platform).toBe('google_ads');
  });
});

describe('ENG-2141 ad rows', () => {
  beforeEach(() => mockQuery.mockReset());

  it('reads one ad\'s rows by its own entityKey, with an inclusive date range, oldest-first', async () => {
    queuePages([{ Items: [{ rowType: 'ad', date: '2026-08-01' }, { rowType: 'ad', date: '2026-08-02' }] }]);

    const result = await adsMetricsDb.getAdSnapshots('meta', '1842363582956923', 'ad9', { since: '2026-08-01', until: '2026-08-31' });

    const q = mockQuery.mock.calls[0][0];
    expect(q.IndexName).toBeUndefined();
    expect(q.KeyConditionExpression).toBe('entityKey = :entityKey AND #date BETWEEN :since AND :until');
    expect(q.ExpressionAttributeValues).toEqual({ ':entityKey': 'meta#1842363582956923#ad#ad9', ':since': '2026-08-01', ':until': '2026-08-31' });
    expect(q.ExpressionAttributeNames).toEqual({ '#date': 'date' });
    expect(q.ScanIndexForward).toBe(true);
    expect(result).toEqual({ rows: [{ rowType: 'ad', date: '2026-08-01' }, { rowType: 'ad', date: '2026-08-02' }], truncated: false });
  });

  it('keeps an ad key distinct from a campaign key with the same numeric id', () => {
    expect(buildAdEntityKey('meta', '1842363582956923', '123')).not.toBe(buildEntityKey('meta', '1842363582956923', '123'));
  });
});
