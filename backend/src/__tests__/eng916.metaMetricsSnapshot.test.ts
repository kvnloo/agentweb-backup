import { snapshotMetaMetricsForDate, runMetaMetricsSnapshot } from '../cron/metaMetricsSnapshotCron';
import { userDb, crmDb } from '../services/db';
import { adsMetricsDb } from '../services/adsMetricsDb';
import { getMetaAccountCredentials } from '../services/metaAccountCredentials';

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn(),
    getAllUsers: jest.fn(),
  },
  crmDb: {
    getLeadListsByUserId: jest.fn(),
    getLeadsByListId: jest.fn(),
  },
}));

jest.mock('../services/adsMetricsDb', () => ({
  ...jest.requireActual('../services/adsMetricsDb'),
  adsMetricsDb: { putSnapshot: jest.fn() },
}));

/**
 * Passed explicitly wherever snapshotMetaMetricsForDate is called directly, so these tests exercise
 * the insights path only. Without it the function resolves account context itself, adding a Graph
 * call and making every fetch-count assertion here about two different things at once.
 */
const TEST_CONTEXT = { currency: 'USD', reportingTimezone: 'America/Los_Angeles' };

/** Every date now writes campaign rows PLUS one account_day row, so counts must be type-aware. */
const writtenRows = () => mockAdsDb.putSnapshot.mock.calls.map((c: any) => c[0]);
const campaignRows = () => writtenRows().filter((r: any) => r.rowType === 'campaign');
const accountDayRows = () => writtenRows().filter((r: any) => r.rowType === 'account_day');

jest.mock('../services/metaAccountCredentials', () => ({
  getMetaAccountCredentials: jest.fn(),
  // Real implementation, not a jest.fn() — enumerateDistinctMetaAdAccounts uses this to
  // dedupe accounts, and its actual stripping behavior (not just "some function exists")
  // is what the multi-account tests below depend on.
  cleanAccountId: (id: string) => (id || '').replace('act_', ''),
}));

const mockUserDb = userDb as jest.Mocked<typeof userDb>;
const mockCrmDb = crmDb as jest.Mocked<typeof crmDb>;
const mockAdsDb = adsMetricsDb as jest.Mocked<typeof adsMetricsDb>;
const mockGetCreds = getMetaAccountCredentials as jest.Mock;

const TEST_USER_ID_MATCHING_CRON = 'a3917669-1c7d-45ed-8ef9-f454de109b6f';
const TEST_DATE = '2026-08-09';

/**
 * Serves BOTH Graph calls a run makes: the account-context read (currency + timezone_name) and the
 * insights read (data). The context call is first and now fails closed without a currency, so a
 * fixture that only carried `data` would abort every run before a single date was attempted — which
 * is correct behaviour, and exactly what the dedicated no-currency test asserts with its own mock.
 */
function makeCampaignInsightsResponse(rows: Array<Record<string, any>>) {
  return { data: rows, currency: 'USD', timezone_name: 'America/Los_Angeles' };
}

function makeLead(campaign: string | undefined, createdAt: string) {
  return {
    leadId: `lead_${createdAt}`,
    listId: 'list_test',
    createdAt,
    firstTouch: campaign ? { utm: { campaign } } : undefined,
  };
}

/**
 * ENG-1601: the OTHER shape production actually delivers — the campaign id sits in the
 * free-form `customFields` bag and there is no `firstTouch` at all. 13 of 36 tagged
 * inbound leads looked like this, and the join dropped every one of them.
 */
function makeCustomFieldsLead(campaign: string | undefined, createdAt: string) {
  return {
    leadId: `cf_lead_${createdAt}`,
    listId: 'list_test',
    createdAt,
    // no firstTouch, deliberately
    customFields: campaign ? { utm_campaign: campaign } : { role: 'CTO' },
  };
}

describe('ENG-916 snapshotMetaMetricsForDate (shared per-day logic)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = jest.fn();

    mockUserDb.getUserById.mockResolvedValue({
      userId: TEST_USER_ID_MATCHING_CRON,
      connected_accounts: [{ platform: 'meta', config: { account_type: 'ad_account', access_token: 'tok' } }],
    } as any);

    mockGetCreds.mockResolvedValue({
      accountId: '1000000000000001',
      accessToken: 'tok',
      accountName: 'Test Account',
    });

    mockCrmDb.getLeadListsByUserId.mockResolvedValue([
      { listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON },
    ] as any);

    mockAdsDb.putSnapshot.mockResolvedValue(undefined as any);
  });

  it('joins a lead to its campaign by exact campaignId string equality', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '10.50', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10.5', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeLead('100000000000000001', `${TEST_DATE}T10:00:00.000Z`)],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(mockAdsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        campaignId: '100000000000000001',
        date: TEST_DATE,
        leadCount: 1,
        rowType: 'campaign',
      })
    );
    // unattributedLeadCount deliberately does NOT appear on campaign rows any more — it lives on
    // the single account_day row so it cannot be summed across campaigns.
    expect(campaignRows()[0].unattributedLeadCount).toBeUndefined();
  });

  it('falls back to campaign NAME when the lead was tagged with {{campaign.name}}', async () => {
    // Measured reality: Phoenix's 46 ACTIVE ads all carry {{campaign.name}}, so an id-only join
    // misses 100% of the portfolio's biggest spender. campaign_name already comes back in the same
    // insights response, so matching it costs nothing.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing Automation', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON }] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        makeLead('Leasing Automation', `${TEST_DATE}T10:00:00.000Z`),      // exact name
        makeLead('Leasing+Automation', `${TEST_DATE}T11:00:00.000Z`),      // plus-encoded
        makeLead('Leasing%20Automation', `${TEST_DATE}T12:00:00.000Z`),    // percent-encoded
        makeLead('100000000000000001', `${TEST_DATE}T13:00:00.000Z`),      // id still wins
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(result.leadCount).toBe(4);
    expect(result.unattributedLeadCount).toBe(0);
    // All four land on the campaign ID, never on the name — the row key stays the id.
    expect(campaignRows()[0].leadCount).toBe(4);
    expect(campaignRows()[0].campaignId).toBe('100000000000000001');
  });

  it('refuses to guess when two campaigns share a name, counting those leads unattributed', async () => {
    // Meta permits duplicate campaign names. Attributing to either would invent a fact, so the
    // ambiguous name is dropped from the map and the lead stays visibly uncounted.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '111', campaign_name: 'Duplicate Name', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
        { campaign_id: '222', campaign_name: 'Duplicate Name', spend: '2', impressions: '20', clicks: '2', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON }] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeLead('Duplicate Name', `${TEST_DATE}T10:00:00.000Z`)],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(result.unattributedLeadCount).toBe(1);
    expect(result.leadCount).toBe(0);
    for (const r of campaignRows()) expect(r.leadCount).toBe(0);
  });

  it('refuses a lead whose OTHER spelling collides with a different campaign', async () => {
    // `A+B` and `A B` are the same string once `+` is decoded, so a lead tagged `A+B` could have
    // come from either campaign. Matching the raw spelling first would attribute it to one of them.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '111', campaign_name: 'Spring+Sale', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
        { campaign_id: '222', campaign_name: 'Spring Sale', spend: '2', impressions: '20', clicks: '2', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON }] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        makeLead('Spring+Sale', `${TEST_DATE}T10:00:00.000Z`),
        makeLead('Spring Sale', `${TEST_DATE}T11:00:00.000Z`),
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    // Neither spelling can be resolved to one campaign, so neither lead is attributed.
    expect(result.unattributedLeadCount).toBe(2);
    expect(result.leadCount).toBe(0);
    for (const r of campaignRows()) expect(r.leadCount).toBe(0);
  });

  it('counts leads with no matching campaignId as unattributed instead of dropping them', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '10.50', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10.5', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        makeLead('100000000000000001', `${TEST_DATE}T10:00:00.000Z`),
        makeLead('some-other-campaign-name', `${TEST_DATE}T11:00:00.000Z`),
        makeLead(undefined, `${TEST_DATE}T12:00:00.000Z`),
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    // Unattributed leads aren't tied to any specific campaign, so they don't get
    // stamped onto a per-campaign row (that would misattribute them) — the campaign's
    // own row only reflects its own matched leads.
    expect(mockAdsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '100000000000000001', leadCount: 1 })
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

    await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    // A campaign ID never seen anywhere in this codebase's prior research must still
    // get a row written — proves discovery is dynamic, not a hardcoded list.
    expect(mockAdsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '999999999999999' })
    );
  });

  it('overwrites the same campaignId+date row on re-run rather than accumulating duplicates', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '10', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10', frequency: '1.2' },
      ]),
    });
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);

    await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);
    await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(campaignRows()).toHaveLength(2);
    const firstCallArg = campaignRows()[0];
    const secondCallArg = campaignRows()[1];
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

    await expect(snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT)).rejects.toThrow();
    expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
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
          paging: { next: 'https://graph.facebook.com/v25.0/act_1000000000000001/insights?after=CURSOR1' },
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

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(mockAdsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 'campaign_page1' })
    );
    expect(mockAdsDb.putSnapshot).toHaveBeenCalledWith(
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
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '10', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId
      .mockResolvedValueOnce({
        // Page 1 (leadId order): an older-dated lead sorts ahead of the target-date lead.
        items: [makeLead('100000000000000001', '2026-08-01T09:00:00.000Z')],
        lastEvaluatedKey: { listId: 'list_test', leadId: 'cursor1' },
        hasMore: true,
      } as any)
      .mockResolvedValueOnce({
        // Page 2: the target-date lead, reachable only if pagination continues.
        items: [makeLead('100000000000000001', `${TEST_DATE}T10:00:00.000Z`)],
        lastEvaluatedKey: null,
        hasMore: false,
      } as any);

    await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledTimes(2);
    expect(mockAdsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '100000000000000001', leadCount: 1 })
    );
  });

  // Greptile P1 #3: unattributed counts are not persisted — the account-wide
  // unattributedLeadCount is computed correctly and returned from the function, but every
  // persisted row hardcodes 0, so the real value never survives past the cron's own log line.
  it('persists the real account-wide unattributedLeadCount onto snapshot rows instead of hardcoding zero', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '10', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10', frequency: '1.2' },
      ]),
    });

    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        makeLead('100000000000000001', `${TEST_DATE}T10:00:00.000Z`),
        makeLead('some-other-campaign', `${TEST_DATE}T11:00:00.000Z`),
        makeLead(undefined, `${TEST_DATE}T12:00:00.000Z`),
      ],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(result.unattributedLeadCount).toBe(2);

    // It lands on the ONE account_day row, not on every campaign row. Stamping it per campaign is
    // what made summing N rows report N x the real figure.
    expect(accountDayRows()).toHaveLength(1);
    expect(accountDayRows()[0]).toEqual(
      expect.objectContaining({ rowType: 'account_day', unattributedLeadCount: 2, campaignId: null })
    );
    // 1 matched + 2 unmatched = 3 leads that day. Attributed stays derivable as total - unattributed.
    expect(accountDayRows()[0].totalLeadCount).toBe(3);
    for (const r of campaignRows()) {
      expect(r.unattributedLeadCount).toBeUndefined();
    }
  });

  it('writes an account_day row even when Meta reports NO campaign activity', async () => {
    // Greptile P1: the campaign loop was the only write, so a date with no campaign activity
    // produced no row at all and a gap was indistinguishable from "the cron never ran".
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([]),
    });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON }] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeLead(undefined, `${TEST_DATE}T10:00:00.000Z`)],
      lastEvaluatedKey: null,
      hasMore: false,
    } as any);

    await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(campaignRows()).toHaveLength(0);
    expect(accountDayRows()).toHaveLength(1);
    // A row saying zero is a measurement; no row is an absence. That is the whole distinction.
    expect(accountDayRows()[0].campaignsReported).toBe(0);
    expect(accountDayRows()[0].unattributedLeadCount).toBe(1);
    // totalLeadCount is the day's TOTAL, not the matched subset — a lead that matched no reported
    // campaign still happened, and a row claiming 0 leads beside 1 unattributed lead is incoherent.
    expect(accountDayRows()[0].totalLeadCount).toBe(1);
  });

  it('records currency and reporting timezone on every row rather than leaving them inferable', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON }] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);

    await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    // Currency varies BETWEEN accounts of the same user (mvarma holds Meta accounts in INR and
    // USD), and a mis-stated currency is an ~80x silent error. Timezone is recorded because the
    // same `date` string covers different 24h windows on different platforms.
    for (const r of writtenRows()) {
      expect(r.currency).toBe('USD');
      expect(r.reportingTimezone).toBe('America/Los_Angeles');
      expect(r.platform).toBe('meta');
      expect(r.parentAccountId).toBeNull();
    }
    expect(campaignRows()[0].platformMetrics).toEqual({ ctr: 1, cpm: 1, frequency: 1 });
  });
});

describe('ENG-916/ENG-1552 runMetaMetricsSnapshot (account-scoped, 28-day settling window, per-account + per-day failure isolation)', () => {
  const cronModule = jest.requireActual('../cron/metaMetricsSnapshotCron');

  /** A single user with a single connected Meta account — the degenerate, pre-widening case. */
  function makeSingleAccountUser(overrides: Partial<{ userId: string; accountId: string; createdAt: string }> = {}) {
    const userId = overrides.userId ?? TEST_USER_ID_MATCHING_CRON;
    const accountId = overrides.accountId ?? '1000000000000001';
    return {
      userId,
      connected_accounts: [
        {
          platform: 'meta',
          account_id: accountId,
          created_at: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
          config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: accountId },
        },
      ],
    };
  }

  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = jest.fn();
    mockUserDb.getAllUsers.mockResolvedValue([makeSingleAccountUser()] as any);
    mockGetCreds.mockResolvedValue({ accountId: '1000000000000001', accessToken: 'tok', accountName: 'Test Account' });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON }] as any);
    mockCrmDb.getLeadsByListId.mockResolvedValue({ items: [], lastEvaluatedKey: null, hasMore: false } as any);
    mockAdsDb.putSnapshot.mockResolvedValue(undefined as any);
  });

  // The 28 below is PINNED ON PURPOSE rather than imported from the module. Asserting against
  // the constant itself would pass for any value, which is exactly how this drifted to 3 in the
  // first place — the number is sized against Meta's documented 28-day insights-mutability window,
  // so changing it must be a deliberate edit here too.
  it('processes 28 distinct dates (today-1 through today-28), not just yesterday', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });

    await runMetaMetricsSnapshot();

    const datesWritten = mockAdsDb.putSnapshot.mock.calls.map((c: any) => c[0].date);
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
          { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
        ]),
      };
    });

    await runMetaMetricsSnapshot();

    // 27 of the 28 days should still have succeeded and written a campaign row.
    expect(campaignRows()).toHaveLength(27);
    // The failure must be visible, not swallowed silently.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('refuses to store spend when Meta reports no currency, instead of writing an unusable row', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // Account-context call answers without a currency.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'act_1000000000000001', timezone_name: 'America/Los_Angeles' }),
    });

    await runMetaMetricsSnapshot();

    // A spend figure whose unit is unknown is uninterpretable, and writing it beside
    // dataQuality: 'exact' asserts a confidence we do not have. Nothing is stored.
    expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('resolves Meta credentials ONCE per account, not once per day', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });

    await runMetaMetricsSnapshot();

    // getMetaAccountCredentials can refresh and PERSIST the Meta token inline, so resolving it
    // per day meant 28 reads (and 28 chances to write) against a live managed client's record
    // every run. One resolution per account is reused for every day in that account's settling
    // window. (No more getUserById call here at all — enumerateDistinctMetaAdAccounts already
    // carries the full user record from getAllUsers.)
    expect(mockGetCreds).toHaveBeenCalledTimes(1);
    expect(mockUserDb.getUserById).not.toHaveBeenCalled();
    // ...while every day in the window still got written.
    const datesWritten = mockAdsDb.putSnapshot.mock.calls.map((c: any) => c[0].date);
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

    // If credentials are dead no day can succeed for this (only) account, so the run must fail
    // fast with one clear line rather than repeating the identical error once per day.
    expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('walks the CRM lead lists ONCE per account for the whole window, not once per day', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });

    await runMetaMetricsSnapshot();

    // getLeadsForListOnDate cannot early-stop (AW-Leads orders by leadId, not createdAt), so it
    // scans every page of every list. Calling it per day meant 28 identical full walks per run.
    // One walk now serves the whole settling window per account, bucketed by date.
    expect(mockCrmDb.getLeadListsByUserId).toHaveBeenCalledTimes(1);
    expect(mockCrmDb.getLeadsByListId).toHaveBeenCalledTimes(1);
    // ...and every day in the window still got written.
    expect(new Set(mockAdsDb.putSnapshot.mock.calls.map((c: any) => c[0].date)).size).toBe(28);
  });

  it('bounds every Graph read with an abort signal', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
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

  // ── ENG-1552 widening: multi-account behavior ──────────────────────────────────────────
  describe('multi-account enumeration (ENG-1552 widening)', () => {
    it('snapshots every distinct account, resolving credentials independently for each', async () => {
      mockUserDb.getAllUsers.mockResolvedValue([
        makeSingleAccountUser({ userId: 'user-a', accountId: '111111111111' }),
        makeSingleAccountUser({ userId: 'user-b', accountId: '222222222222' }),
      ] as any);
      mockGetCreds.mockImplementation(async (_user: any, _userId: any, accountId: any) => ({
        accountId,
        accessToken: `tok-${accountId}`,
        accountName: 'Test',
      }));
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => makeCampaignInsightsResponse([
          { campaign_id: 'camp1', campaign_name: 'C1', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
        ]),
      });

      await runMetaMetricsSnapshot();

      expect(mockGetCreds).toHaveBeenCalledTimes(2);
      expect(mockGetCreds).toHaveBeenCalledWith(expect.anything(), 'user-a', '111111111111');
      expect(mockGetCreds).toHaveBeenCalledWith(expect.anything(), 'user-b', '222222222222');
      const accountsWritten = new Set(writtenRows().map((r: any) => r.accountId));
      expect(accountsWritten).toEqual(new Set(['111111111111', '222222222222']));
    });

    it('one account failing entirely does not stop the other accounts from being snapshotted', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockUserDb.getAllUsers.mockResolvedValue([
        makeSingleAccountUser({ userId: 'user-a', accountId: '111111111111' }),
        makeSingleAccountUser({ userId: 'user-b', accountId: '222222222222' }),
      ] as any);
      mockGetCreds.mockImplementation(async (_user: any, _userId: any, accountId: any) => {
        if (accountId === '111111111111') throw new Error('token expired');
        return { accountId, accessToken: `tok-${accountId}`, accountName: 'Test' };
      });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => makeCampaignInsightsResponse([
          { campaign_id: 'camp1', campaign_name: 'C1', spend: '1', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
        ]),
      });

      await runMetaMetricsSnapshot();

      const accountsWritten = new Set(writtenRows().map((r: any) => r.accountId));
      expect(accountsWritten).toEqual(new Set(['222222222222']));
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('dedupes a shared account reachable from multiple users, picking the EARLIEST-connected user as canonical', async () => {
      mockUserDb.getAllUsers.mockResolvedValue([
        makeSingleAccountUser({ userId: 'later-user', accountId: 'shared-acct', createdAt: '2026-06-01T00:00:00.000Z' }),
        makeSingleAccountUser({ userId: 'earlier-user', accountId: 'shared-acct', createdAt: '2026-01-01T00:00:00.000Z' }),
      ] as any);
      mockGetCreds.mockResolvedValue({ accountId: 'shared-acct', accessToken: 'tok', accountName: 'Test' });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => makeCampaignInsightsResponse([]),
      });

      await runMetaMetricsSnapshot();

      // Exactly one credential resolution for the shared account — deduped, not double-snapshotted.
      expect(mockGetCreds).toHaveBeenCalledTimes(1);
      expect(mockGetCreds).toHaveBeenCalledWith(expect.anything(), 'earlier-user', 'shared-acct');
      expect(mockGetCreds).not.toHaveBeenCalledWith(expect.anything(), 'later-user', expect.anything());
    });

    // Review finding: the tie-break's own edge cases (an exact tie, and every candidate
    // missing created_at) were correct by hand-trace but had no direct test — closing that
    // gap here rather than leaving the correctness unverified.
    // ENG-1907: a sandbox account carries a simulated Meta connection. Even if the user
    // listing ever handed one to this cron, it must not resolve its credentials or
    // write snapshot rows for it — that is how simulation noise would reach AW-AdsMetricsSnapshots.
    it('never enumerates a sandbox (eval_) principal\'s Meta account', async () => {
      mockUserDb.getAllUsers.mockResolvedValue([
        makeSingleAccountUser({ userId: 'user-a', accountId: '111111111111' }),
        makeSingleAccountUser({ userId: 'eval_2a2a2a2a-0000-4000-8000-000000000000', accountId: '999999999999' }),
      ] as any);
      mockGetCreds.mockImplementation(async (_user: any, _userId: any, accountId: any) => ({
        accountId,
        accessToken: `tok-${accountId}`,
        accountName: 'Test',
      }));
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => makeCampaignInsightsResponse([]),
      });

      await runMetaMetricsSnapshot();

      expect(mockGetCreds).toHaveBeenCalledTimes(1);
      expect(mockGetCreds).toHaveBeenCalledWith(expect.anything(), 'user-a', '111111111111');
      expect(mockGetCreds).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^eval_/), expect.anything());
      expect(new Set(writtenRows().map((r: any) => r.accountId))).toEqual(new Set(['111111111111']));
    });

    it('an exact created_at tie still resolves to exactly one canonical user, without crashing', async () => {
      mockUserDb.getAllUsers.mockResolvedValue([
        makeSingleAccountUser({ userId: 'user-x', accountId: 'tied-acct', createdAt: '2026-01-01T00:00:00.000Z' }),
        makeSingleAccountUser({ userId: 'user-y', accountId: 'tied-acct', createdAt: '2026-01-01T00:00:00.000Z' }),
      ] as any);
      mockGetCreds.mockResolvedValue({ accountId: 'tied-acct', accessToken: 'tok', accountName: 'Test' });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => makeCampaignInsightsResponse([]),
      });

      await runMetaMetricsSnapshot();

      // Exactly one resolution — a tie must still dedupe to a single canonical user, not
      // snapshot the account twice or throw.
      expect(mockGetCreds).toHaveBeenCalledTimes(1);
      const [, resolvedUserId] = mockGetCreds.mock.calls[0];
      expect(['user-x', 'user-y']).toContain(resolvedUserId);
    });

    it('every candidate missing created_at still resolves to exactly one canonical user', async () => {
      mockUserDb.getAllUsers.mockResolvedValue([
        makeSingleAccountUser({ userId: 'user-a', accountId: 'undated-acct', createdAt: '' }),
        makeSingleAccountUser({ userId: 'user-b', accountId: 'undated-acct', createdAt: '' }),
      ] as any);
      mockGetCreds.mockResolvedValue({ accountId: 'undated-acct', accessToken: 'tok', accountName: 'Test' });
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => makeCampaignInsightsResponse([]),
      });

      await runMetaMetricsSnapshot();

      // Missing created_at must not crash the Date.parse/Infinity comparison, and must
      // still dedupe to exactly one resolution rather than skipping the account entirely
      // or double-snapshotting it.
      expect(mockGetCreds).toHaveBeenCalledTimes(1);
      const [, resolvedUserId] = mockGetCreds.mock.calls[0];
      expect(['user-a', 'user-b']).toContain(resolvedUserId);
    });

    it('excludes an account id in EXCLUDED_META_ACCOUNT_IDS entirely — no credential resolution, no rows', async () => {
      mockUserDb.getAllUsers.mockResolvedValue([
        makeSingleAccountUser({ userId: 'every-io-user', accountId: '1358071355944019' }),
      ] as any);

      await runMetaMetricsSnapshot();

      expect(mockGetCreds).not.toHaveBeenCalled();
      expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
    });

    it('an empty account list (no users with a Meta ad account) completes cleanly with zero writes', async () => {
      mockUserDb.getAllUsers.mockResolvedValue([] as any);

      await runMetaMetricsSnapshot();

      expect(mockGetCreds).not.toHaveBeenCalled();
      expect(mockAdsDb.putSnapshot).not.toHaveBeenCalled();
    });
  });
});

describe('ENG-1601 leads whose campaign id lives only in customFields', () => {
  // These tests call snapshotMetaMetricsForDate directly with resolvedCredentials undefined,
  // exercising its standalone fallback (resolves its own user + credentials via getUserById),
  // not the account-enumerated path runMetaMetricsSnapshot now uses — so this block needs its
  // own explicit mock setup rather than depending on state left behind by a sibling describe.
  beforeEach(() => {
    jest.resetAllMocks();
    global.fetch = jest.fn();
    mockUserDb.getUserById.mockResolvedValue({
      userId: TEST_USER_ID_MATCHING_CRON,
      connected_accounts: [{ platform: 'meta', config: { account_type: 'ad_account', access_token: 'tok' } }],
    } as any);
    mockGetCreds.mockResolvedValue({ accountId: '1000000000000001', accessToken: 'tok', accountName: 'Test Account' });
    mockCrmDb.getLeadListsByUserId.mockResolvedValue([{ listId: 'list_test', userId: TEST_USER_ID_MATCHING_CRON }] as any);
    mockAdsDb.putSnapshot.mockResolvedValue(undefined as any);
  });

  const INSIGHTS = () => ({
    ok: true,
    json: async () => makeCampaignInsightsResponse([
      { campaign_id: '100000000000000001', campaign_name: 'Leasing', spend: '10.50', impressions: '1000', clicks: '20', ctr: '2.0', cpm: '10.5', frequency: '1.2' },
    ]),
  });

  it('attributes a lead whose campaign id is ONLY in customFields', async () => {
    // This is the production shape that was silently dropped: no firstTouch at all, a valid
    // campaign id in the free-form bag. 13 of 36 tagged inbound leads on one production account looked like this.
    (global.fetch as jest.Mock).mockResolvedValue(INSIGHTS());
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeCustomFieldsLead('100000000000000001', `${TEST_DATE}T10:00:00.000Z`)],
      lastEvaluatedKey: null, hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);

    expect(result.leadCount).toBe(1);
    expect(result.unattributedLeadCount).toBe(0);
    expect(mockAdsDb.putSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: '100000000000000001', leadCount: 1 })
    );
  });

  it('counts BOTH shapes together — this is the +57% the fix recovers', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(INSIGHTS());
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [
        makeLead('100000000000000001', `${TEST_DATE}T10:00:00.000Z`),             // structured
        makeCustomFieldsLead('100000000000000001', `${TEST_DATE}T11:00:00.000Z`), // bag only
      ],
      lastEvaluatedKey: null, hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);
    expect(result.leadCount).toBe(2);
    expect(result.unattributedLeadCount).toBe(0);
  });

  it('lets a structured firstTouch WIN over customFields — promotion only gap-fills', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(INSIGHTS());
    const conflicted: any = makeLead('100000000000000001', `${TEST_DATE}T10:00:00.000Z`);
    conflicted.customFields = { utm_campaign: 'some-other-campaign' };
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [conflicted], lastEvaluatedKey: null, hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);
    expect(result.leadCount).toBe(1); // matched on the structured value, not the bag
  });

  it('still counts a lead with neither shape as unattributed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(INSIGHTS());
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeCustomFieldsLead(undefined, `${TEST_DATE}T10:00:00.000Z`)],
      lastEvaluatedKey: null, hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);
    expect(result.leadCount).toBe(0);
    expect(result.unattributedLeadCount).toBe(1);
  });

  it('does NOT attribute a promoted tag whose campaign was not reported that day', async () => {
    /*
     * The staleness bound, pinned. A `utm_campaign` sitting in customFields could be old — the
     * bag carries no timestamp (none of the 13 real leads had a `landing_ts`), so the value
     * itself cannot be dated. What bounds it is the join's existing same-day constraint:
     * `knownCampaignIds` holds only the campaigns Meta REPORTED for this date, so a tag naming
     * a campaign that was not running cannot match.
     *
     * That constraint applies identically to a structured firstTouch, so promotion does not
     * widen the staleness exposure — it applies the same bound to more leads. This test exists
     * so that stays true.
     */
    (global.fetch as jest.Mock).mockResolvedValue(INSIGHTS());
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeCustomFieldsLead('999999999999999', `${TEST_DATE}T10:00:00.000Z`)], // never reported
      lastEvaluatedKey: null, hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);
    expect(result.leadCount).toBe(0);
    expect(result.unattributedLeadCount).toBe(1);
  });

  it('does NOT let the free-form bag defeat the ambiguity guard', async () => {
    // Two campaigns sharing a name: a promoted value that resolves to both must stay
    // unattributed, exactly as a structured one would. Promotion must not widen what counts.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => makeCampaignInsightsResponse([
        { campaign_id: '111', campaign_name: 'Spring Sale', spend: '5', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
        { campaign_id: '222', campaign_name: 'Spring Sale', spend: '5', impressions: '10', clicks: '1', ctr: '1', cpm: '1', frequency: '1' },
      ]),
    });
    mockCrmDb.getLeadsByListId.mockResolvedValue({
      items: [makeCustomFieldsLead('Spring Sale', `${TEST_DATE}T10:00:00.000Z`)],
      lastEvaluatedKey: null, hasMore: false,
    } as any);

    const result = await snapshotMetaMetricsForDate(TEST_USER_ID_MATCHING_CRON, TEST_DATE, undefined, undefined, TEST_CONTEXT);
    expect(result.leadCount).toBe(0);
    expect(result.unattributedLeadCount).toBe(1);
  });
});
