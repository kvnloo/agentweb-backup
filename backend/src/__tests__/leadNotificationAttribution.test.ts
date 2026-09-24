jest.mock('../services/adsMetricsDb', () => ({ adsMetricsDb: { getSnapshotsByUserDateRange: jest.fn() } }));
jest.mock('../services/v0Service', () => ({ getLandingPagesByOwner: jest.fn() }));
import { adsMetricsDb } from '../services/adsMetricsDb';
import { getLandingPagesByOwner } from '../services/v0Service';
import { attributionValues, normalizeLandingUrl, resolveNotificationNames } from '../services/leadNotificationAttribution';
const mock = (fn: unknown) => fn as jest.Mock;
const date = '2026-09-23T12:00:00Z';
const account = { platform: 'meta', account_id: 'act_123', config: { account_type: 'ad_account', access_token: 'test-token' } };
const originalFetch = global.fetch;
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: '456', account_id: '123', name: 'Demo video',
    campaign: { id: '789', name: 'Tenant launch' }, adset: { id: '234', name: 'Property managers' } }) });
  mock(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ rows: [], truncated: false });
  mock(getLandingPagesByOwner).mockResolvedValue([]);
});
afterEach(() => { global.fetch = originalFetch; });

it.each(['ad_id', 'utm_content', 'utm_term'])('resolves %s through a persisted org ad account and verifies account ownership', async key => {
  const values = attributionValues({ customFields: { [key]: '456' } }, false);
  const result = await resolveNotificationNames('owner', values, date, [account]);
  expect(result).toMatchObject({ ad: 'Demo video', campaign: 'Tenant launch', adSet: 'Property managers' });
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
it('never resolves opaque click identifiers as ads', async () => {
  const result = await resolveNotificationNames('owner', new Map([['fbclid', '456'], ['gclid', '789']]), date, [account]);
  expect(result.ad).toBe('fbclid=456; gclid=789');
  expect(global.fetch).not.toHaveBeenCalled();
});
it.each([null, [], 'wrong', { id: '456', account_id: 'other', name: 'Private ad' },
  { id: 'wrong', account_id: '123', name: 'Wrong ad' }, { id: '456', account_id: '123', name: {}, campaign: [], adset: 'bad' }])(
  'rejects malformed or cross-account ad results %j', async raw => {
    mock(global.fetch).mockResolvedValue({ ok: true, json: async () => raw });
    const result = await resolveNotificationNames('owner', new Map([['adid', '456']]), date, [account]);
    expect(result.ad).toBe('456');
    expect(result.campaign).toBe('');
  });
it.each([null, {}, [null, 'bad', { platform: 'meta', config: 'bad' }], [account, { ...account, account_id: 'act_999' }]])(
  'does not guess malformed or ambiguous account scope %j', async accounts => {
    await resolveNotificationNames('owner', new Map([['adid', '456']]), date, accounts);
    expect(global.fetch).not.toHaveBeenCalled();
  });
it('falls back on an ad lookup failure', async () => {
  mock(global.fetch).mockRejectedValue(new Error('timeout'));
  const result = await resolveNotificationNames('owner', new Map([['adid', '456']]), date, [account]);
  expect(result.ad).toBe('456');
});
it.each([null, [], { rows: 'bad' }, { rows: [null, {}, { userId: 'other', rowType: 'campaign', campaignId: '789', campaignName: 'Private', entityKey: 'meta#1#789' }], truncated: false },
  { rows: [{ userId: 'owner', rowType: 'campaign', campaignId: '789', campaignName: 'Partial', entityKey: 'meta#1#789' }], truncated: true }])(
  'retains raw campaign on malformed, cross-owner or incomplete snapshots %j', async raw => {
    mock(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue(raw);
    expect((await resolveNotificationNames('owner', new Map([['utmcampaign', '789']]), date)).campaign).toBe('789');
  });
it.each([null, {}, [null, {}, { userId: 'other', name: 'Private', deployedUrl: 'https://example.com/' }]])(
  'rejects malformed or cross-owner landing page records %j', async raw => {
    mock(getLandingPagesByOwner).mockResolvedValue(raw);
    expect((await resolveNotificationNames('owner', new Map([['landingurl', 'https://example.com/']]), date)).landingName).toBe('');
  });
it('does not guess a campaign name shared by separate accounts', async () => {
  mock(adsMetricsDb.getSnapshotsByUserDateRange).mockResolvedValue({ truncated: false, rows: ['a', 'b'].map(id => ({
    userId: 'owner', rowType: 'campaign', campaignId: id, campaignName: 'Launch', entityKey: `meta#${id}#${id}`,
  })) });
  expect((await resolveNotificationNames('owner', new Map([['utmcampaign', 'Launch']]), date)).campaign).toBe('Launch');
});
it.each(['javascript:alert(1)', 'https://user:password@example.com', '/relative/path'])('rejects unsafe/incomplete URL %s', value => {
  expect(normalizeLandingUrl(value)).toBe('');
});

it('delivers raw attribution within an overall deadline when storage never settles', async () => {
  jest.useFakeTimers();
  try {
    mock(adsMetricsDb.getSnapshotsByUserDateRange).mockReturnValue(new Promise(() => {}));
    const work = resolveNotificationNames('owner', new Map([['utmcampaign', 'raw'], ['adid', '456']]), date, [account]);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await work).toMatchObject({ campaign: 'raw', ad: '456' });
    expect(global.fetch).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});

it.each(['campaignid', 'utmcampaign'])('retains raw identifiers when an ad contradicts explicit %s', async key => {
  const result = await resolveNotificationNames('owner', new Map([[key, '999'], ['adid', '456']]), date, [account]);
  expect(result.ad).toBe('456');
  expect(result.campaign).toBe('999');
});
