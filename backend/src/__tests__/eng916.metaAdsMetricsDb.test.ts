/**
 * ENG-916 — read path for the Meta ads metrics store.
 *
 * These exist because the store shipped write-only: the card asks for "90 days of history
 * queryable per campaign", and the 1% Ads-Manager reconciliation (the parent card's Phase 1
 * gate) is literally unrunnable without a way to read back what was stored.
 *
 * The pagination assertions are the load-bearing ones. Every consumer of this store reads a
 * date series to compute a trend, so a short read does not surface as an error — it surfaces
 * as a decline that never happened.
 */

const mockQuery = jest.fn();
const mockPut = jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });

jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: mockPut,
      query: mockQuery,
    })),
  },
}));

import { metaAdsMetricsDb } from '../services/metaAdsMetricsDb';

const row = (campaignId: string, date: string) => ({
  campaignId,
  date,
  accountId: '1842363582956923',
  userId: 'a3917669-1c7d-45ed-8ef9-f454de109b6f',
  campaignName: 'Leasing',
  spend: 1,
  impressions: 10,
  clicks: 1,
  ctr: 1,
  cpm: 1,
  frequency: 1,
  leadCount: 0,
  unattributedLeadCount: 0,
  snapshotSource: 'daily' as const,
  capturedAt: '2026-08-24T09:00:00.000Z',
});

/** Queue one query() resolution per page. */
function queuePages(pages: Array<{ Items: any[]; LastEvaluatedKey?: any }>) {
  mockQuery.mockReset();
  for (const page of pages) {
    mockQuery.mockReturnValueOnce({ promise: jest.fn().mockResolvedValue(page) });
  }
}

describe('ENG-916 metaAdsMetricsDb read path', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('returns a campaign series oldest-first and reports it complete', async () => {
    queuePages([{ Items: [row('c1', '2026-08-01'), row('c1', '2026-08-02')] }]);

    const result = await metaAdsMetricsDb.getSnapshotsByCampaign('c1');

    expect(result.rows.map(r => r.date)).toEqual(['2026-08-01', '2026-08-02']);
    expect(result.truncated).toBe(false);
    // Oldest-first is a contract, not an accident — consumers read these left to right.
    expect(mockQuery.mock.calls[0][0].ScanIndexForward).toBe(true);
  });

  it('follows LastEvaluatedKey across pages and concatenates every row', async () => {
    queuePages([
      { Items: [row('c1', '2026-08-01')], LastEvaluatedKey: { campaignId: 'c1', date: '2026-08-01' } },
      { Items: [row('c1', '2026-08-02')], LastEvaluatedKey: { campaignId: 'c1', date: '2026-08-02' } },
      { Items: [row('c1', '2026-08-03')] },
    ]);

    const result = await metaAdsMetricsDb.getSnapshotsByCampaign('c1');

    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(result.rows.map(r => r.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(result.truncated).toBe(false);
    // Page 2 must resume from page 1's cursor, or the walk silently restarts.
    expect(mockQuery.mock.calls[1][0].ExclusiveStartKey).toEqual({ campaignId: 'c1', date: '2026-08-01' });
  });

  it('reports truncated: true instead of silently returning a short read', async () => {
    // Every page hands back another cursor, so the cap is what stops the loop.
    mockQuery.mockReset();
    mockQuery.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Items: [row('c1', '2026-08-01')],
        LastEvaluatedKey: { campaignId: 'c1', date: '2026-08-01' },
      }),
    });

    const result = await metaAdsMetricsDb.getSnapshotsByCampaign('c1');

    expect(result.truncated).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('never puts the reserved word `date` bare in a key condition', async () => {
    queuePages([{ Items: [] }]);

    await metaAdsMetricsDb.getSnapshotsByCampaign('c1', { since: '2026-08-01', until: '2026-08-28' });

    const params = mockQuery.mock.calls[0][0];
    // `date` is reserved in DynamoDB — a bare reference is a ValidationException at runtime,
    // which unit tests against a mocked SDK cannot otherwise catch.
    expect(params.ExpressionAttributeNames).toEqual({ '#date': 'date' });
    expect(params.KeyConditionExpression).toContain('#date BETWEEN');
    expect(params.KeyConditionExpression).not.toMatch(/[^#]date\s+BETWEEN/);
  });

  it('reads the user/date range off the userId-date-index GSI', async () => {
    queuePages([{ Items: [row('c1', '2026-08-01')] }]);

    const result = await metaAdsMetricsDb.getSnapshotsByUserDateRange(
      'a3917669-1c7d-45ed-8ef9-f454de109b6f',
      '2026-08-01',
      '2026-08-28'
    );

    const params = mockQuery.mock.calls[0][0];
    expect(params.IndexName).toBe('userId-date-index');
    expect(params.KeyConditionExpression).toBe('userId = :userId AND #date BETWEEN :since AND :until');
    expect(params.ExpressionAttributeValues[':since']).toBe('2026-08-01');
    expect(result.truncated).toBe(false);
  });
});
