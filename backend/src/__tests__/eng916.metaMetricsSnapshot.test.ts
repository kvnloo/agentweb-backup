import { snapshotMetaMetricsForDate, runMetaMetricsSnapshot } from '../cron/metaMetricsSnapshotCron';
import { userDb, crmDb } from '../services/db';
import { metaAdsMetricsDb } from '../services/metaAdsMetricsDb';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
  },
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
}));

jest.mock('../services/metaAdsMetricsDb', () => ({
  metaAdsMetricsDb: {
    putSnapshot: jest.fn(),
  },
}));

jest.mock('../services/metaAccountCredentials', () => ({
  getMetaAccountCredentials: jest.fn(),
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockMetricsDb = metaAdsMetricsDb as jest.Mocked<typeof metaAdsMetricsDb>;
const mockGetCreds = getMetaAccountCredentials as jest.Mock;

const HAVEN_USER_ID = 'a3917669-1c7d-45ed-8ef9-f454de109b6f';
const TEST_DATE = '2026-08-09';

function makeCampaignInsightsResponse(rows: Array<Record<string, any>>) {
  return { data: rows };
}

function makeLead(campaign: string | undefined, createdAt: string) {
  return {
    leadId: `lead_${createdAt}`,
    listId: 'list_test',
    createdAt,
    firstTouch: campaign ? { utm: { campaign } } : undefined,
  };
}

describe('ENG-916 snapshotMetaMetricsForDate (shared per-day logic)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = jest.fn();

    mockUserDb.getUserById.mockResolvedValue({
      userId: HAVEN_USER_ID,
      connected_accounts: [{ platform: 'meta', config: { account_type: 'ad_account', access_token: 'tok' } }],
    } as any);

    mockGetCreds.mockResolvedValue({
      accountId: '1842363582956923',
      accessToken: 'tok',
      accountName: 'Haven AI',
    });

    mockCrmDb.getLeadListsByUserId.mockResolvedValue([
      { listId: 'list_test', userId: HAVEN_USER_ID },
    ] as any);

    mockMetricsDb.putSnapshot.mockResolvedValue(undefined as any);
  });

  it('joins a lead to its campaign by exact campaignId string equality', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '10.50', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10.5', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeLead('120244135557390173', `${TEST_DATE}T10:00:00.000Z`)],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);

    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: '120244135557390173',
        date: TEST_DATE,
        leadCount: 1,
        unattributedLeadCount: 0,
      })
    );
  });

  it('counts leads with no matching campaignId as unattributed instead of dropping them', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '10.50', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10.5', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        makeLead('120244135557390173', `${TEST_DATE}T10:00:00.000Z`),
        makeLead('some-other-campaign-name', `${TEST_DATE}T11:00:00.000Z`),
        makeLead(undefined, `${TEST_DATE}T12:00:00.000Z`),
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);

    // Unattributed leads aren't tied to any specific campaign, so they don't get
    // stamped onto a per-campaign row (that would misattribute them) — the campaign's
    // own row only reflects its own matched leads.
    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '120244135557390173', leadCount: 1 })
    );
    // They must still be visible somewhere, though — at the day/account level via the
    // function's own return value (which the cron logs), not silently swallowed.
    expect(result.unattributedLeadCount).toBe(2);
    expect(result.leadCount).toBe(1);
  });

  it('does not hardcode any campaign ID — discovers whatever campaigns Meta reports that day', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '999999999999999', campaign_name: 'Brand New Campaign', spend: '5', impressions: '100', clicks: '2', ctr: '2.0', cpm: '50', frequency: '1.0' },
      ]),
    });

    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);

    await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);

    // A campaign ID never seen anywhere in this codebase's prior research must still
    // get a row written — proves discovery is dynamic, not a hardcoded list.
    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '999999999999999' })
    );
  });

  it('overwrites the same campaignId+date row on re-run rather than accumulating duplicates', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '10', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10', frequency: '1.2' },
      ]),
    });
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);

    await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);
    await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);

    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledTimes(2);
    const [firstCallArg] = mockMetricsDb.putSnapshot.mock.calls[0];
    const [secondCallArg] = mockMetricsDb.putSnapshot.mock.calls[1];
    // Same key both times — a DynamoDB put on an identical key is an overwrite, not a new row.
    expect(firstCallArg.campaignId).toBe(secondCallArg.campaignId);
    expect(firstCallArg.date).toBe(secondCallArg.date);
  });

  it('propagates a clear error when the Meta Insights API call fails, rather than writing partial/wrong data', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Meta API is down' } }),
    });

    await expect(snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE)).rejects.toThrow();
    expect(mockMetricsDb.putSnapshot).not.toHaveBeenCalled();
  });

  // Greptile P1 #1: pagination truncates campaign snapshots — the insights fetch only ever
  // read the first page of `body.data` and never followed `body.paging.next`, so a campaign
  // that only showed up on a later page silently got no snapshot row.
  it('follows paging.next to fetch every page of campaign insights, not just the first', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { campaign_id: 'campaign_page1', campaign_name: 'Page1 Campaign', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
          ],
          paging: { next: 'https://graph.facebook.com/v25.0/act_1842363582956923/insights?after=CURSOR1' },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { campaign_id: 'campaign_page2', campaign_name: 'Page2 Campaign', spend: '2', impressions: '20', clicks: '2', ctr: '2', cpm: '2', frequency: '2' },
          ],
          // No paging.next -- this is the last page.
        }),
      });

    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);

    const result = await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 'campaign_page1' })
    );
    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 'campaign_page2' })
    );
    expect(result.rowsWritten).toBe(2);
  });

  // Greptile P1 #2: early stop uses an unordered field — getLeadsForListOnDate breaks out of
  // pagination the moment it sees ANY lead whose createdAt sorts before the target date, but
  // the underlying DynamoDB query is ordered by leadId (ScanIndexForward: false), not by
  // createdAt. An older-createdAt lead can sort ahead of a target-date lead that lives on a
  // later page, and the old early-stop would never fetch that later page.
  it('does not stop paging just because an older-createdAt lead sorts ahead of a target-date lead on a later page', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '10', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId
      .mockResolvedValueOnce({
        // Page 1 (leadId order): an older-dated lead sorts ahead of the target-date lead.
        items: [makeLead('120244135557390173', '2026-08-01T09:00:00.000Z')],
        lastEvaluatedKey: { listId: 'list_test', leadId: 'cursor1' },
        hasMore: true,
      } as any)
      .mockResolvedValueOnce({
        // Page 2: the target-date lead, reachable only if pagination continues.
        items: [makeLead('120244135557390173', `${TEST_DATE}T10:00:00.000Z`)],
        lastEvaluatedKey: null,
        hasMore: false,
      } as any);

    await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);

    expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledTimes(2);
    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '120244135557390173', leadCount: 1 })
    );
  });

  // Greptile P1 #3: unattributed counts are not persisted — the account-wide
  // unattributedLeadCount is computed correctly and returned from the function, but every
  // persisted row hardcodes 0, so the real value never survives past the cron's own log line.
  it('persists the real account-wide unattributedLeadCount onto snapshot rows instead of hardcoding zero', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '10', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        makeLead('120244135557390173', `${TEST_DATE}T10:00:00.000Z`),
        makeLead('some-other-campaign', `${TEST_DATE}T11:00:00.000Z`),
        makeLead(undefined, `${TEST_DATE}T12:00:00.000Z`),
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(HAVEN_USER_ID, TEST_DATE);

    expect(result.unattributedLeadCount).toBe(2);
    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '120244135557390173', unattributedLeadCount: 2 })
    );
  });
});

describe('ENG-916 runMetaMetricsSnapshot (28-day settling window + per-day failure isolation)', () => {
  const cronModule = jest.requireActual('../cron/metaMetricsSnapshotCron');

  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = jest.fn();
    mockUserDb.getUserById.mockResolvedValue({
      userId: HAVEN_USER_ID,
      connected_accounts: [{ platform: 'meta', config: { account_type: 'ad_account', access_token: 'tok' } }],
    } as any);
    mockGetCreds.mockResolvedValue({ accountId: '1842363582956923', accessToken: 'tok', accountName: 'Haven AI' });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: HAVEN_USER_ID }] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);
    mockMetricsDb.putSnapshot.mockResolvedValue(undefined as any);
  });

  // The 28 below is PINNED ON PURPOSE rather than imported from the module. Asserting against
  // the constant itself would pass for any value, which is exactly how this drifted to 3 in the
  // first place — the number is sized against Meta's documented 28-day insights-mutability window,
  // so changing it must be a deliberate edit here too.
  it('processes 28 distinct dates (today-1 through today-28), not just yesterday', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });

    await runMetaMetricsSnapshot();

    const datesWritten = mockMetricsDb.putSnapshot.mock.calls.map((c: any) => c[0].date);
    expect(new Set(datesWritten).size).toBe(28);
  });

  it('logs and continues when one day in the window fails, instead of aborting the whole run', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let callCount = 0;
    (global.fetch as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        return { ok: false, status: 500, json: async () => ({ error: { message: 'transient failure' } }) };
      }
      return {
        ok: true,
        json: async () => makeCampaignInsightsResponse([
          { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
        ]),
      };
    });

    await runMetaMetricsSnapshot();

    // 27 of the 28 days should still have succeeded and written a row.
    expect(mockMetricsDb.putSnapshot).toHaveBeenCalledTimes(27);
    // The failure must be visible, not swallowed silently.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('resolves Meta credentials ONCE for the whole run, not once per day', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });

    await runMetaMetricsSnapshot();

    // getMetaAccountCredentials can refresh and PERSIST the Meta token inline, so resolving it
    // per day meant 28 reads (and 28 chances to write) against a live managed client's record
    // every run. One resolution is reused for every day in the settling window.
    expect(mockGetCreds).toHaveBeenCalledTimes(1);
    expect(mockUserDb.getUserById).toHaveBeenCalledTimes(1);
    // ...while every day in the window still got written.
    const datesWritten = mockMetricsDb.putSnapshot.mock.calls.map((c: any) => c[0].date);
    expect(new Set(datesWritten).size).toBe(28);
  });

  it('attempts NO days and logs once when credentials cannot be resolved', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetCreds.mockRejectedValue(new Error('Meta access token has expired'));
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([]),
    });

    await runMetaMetricsSnapshot();

    // If credentials are dead no day can succeed, so the run must fail fast with one clear line
    // rather than repeating the identical error once per day in the settling window.
    expect(mockMetricsDb.putSnapshot).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('bounds every Graph read with an abort signal', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '120244135557390173', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });

    await runMetaMetricsSnapshot();

    // Node's fetch has no default deadline and these reads are sequential across the window,
    // so one hung connection would stall every remaining day and read as "the cron did not run".
    expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    for (const call of (global.fetch as jest.Mock).mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
