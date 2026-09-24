jest.mock('../services/leadNotificationLookup', () => ({ notificationLookup: { pages: jest.fn(), campaigns: jest.fn() } }));
import { notificationLookup } from '../services/leadNotificationLookup';
import { attributionValues, normalizeLandingUrl, resolveNotificationNames, slackAttributionUrl } from '../services/leadNotificationAttribution';
const mock = (fn: unknown) => fn as jest.Mock;
const date = '2026-09-23T12:00:00Z';
const account = { platform: 'meta', account_id: 'act_123', config: { account_type: 'ad_account', access_token: 'test-token' } };
const originalFetch = global.fetch;
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ id: '456', account_id: '123', name: 'Demo video',
    campaign: { id: '789', name: 'Tenant launch' }, adset: { id: '234', name: 'Property managers' } }) });
  mock(notificationLookup.campaigns).mockResolvedValue({ rows: [], truncated: false });
  mock(notificationLookup.pages).mockResolvedValue([]);
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
    mock(notificationLookup.campaigns).mockResolvedValue(raw);
    expect((await resolveNotificationNames('owner', new Map([['utmcampaign', '789']]), date)).campaign).toBe('789');
  });
it.each([null, {}, [null, {}, { userId: 'other', name: 'Private', deployedUrl: 'https://example.com/' }]])(
  'rejects malformed or cross-owner landing page records %j', async raw => {
    mock(notificationLookup.pages).mockResolvedValue(raw);
    expect((await resolveNotificationNames('owner', new Map([['landingurl', 'https://example.com/']]), date)).landingName).toBe('');
  });
it('does not guess a campaign name shared by separate accounts', async () => {
  mock(notificationLookup.campaigns).mockResolvedValue({ truncated: false, rows: ['a', 'b'].map(id => ({
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
    mock(notificationLookup.campaigns).mockReturnValue(new Promise(() => {}));
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

it.each([
  null, 'bad', {}, { id: 'page', userId: 'other', name: 'Private' },
  { id: 'other', userId: 'owner', name: 'Wrong' },
  { id: 'page', userId: 'owner', name: 'Archived', archived: true },
  { id: 'page', userId: 'owner', name: { bad: true } },
])('validates direct lookup identity, owner, archive status and fields: %j', async page => {
  mock(notificationLookup.pages).mockResolvedValue([page]);
  const result = await resolveNotificationNames('owner', new Map([['landingpageid', 'page']]), date);
  expect(result.landingName).toBe('');
  expect(notificationLookup.pages).toHaveBeenCalledWith('owner', 'page', expect.any(AbortSignal));
});
it('accepts the landingPage and pageUrl aliases as full landing URLs', async () => {
  for (const key of ['landingpage', 'pageurl']) {
    expect(await resolveNotificationNames('owner', new Map([[key, 'https://example.com/path?utm_source=qa']]), date))
      .toMatchObject({ landingUrl: 'https://example.com/path?utm_source=qa' });
  }
});
it('resolves a direct page and normalizes its stored URL', async () => {
  mock(notificationLookup.pages).mockResolvedValue([{ id: 'page', userId: 'owner', name: 'Demo', deployedUrl: 'https://EXAMPLE.com/demo' }]);
  expect(await resolveNotificationNames('owner', new Map([['landingpageid', 'page']]), date))
    .toMatchObject({ landingName: 'Demo', landingUrl: 'https://example.com/demo' });
});
it('does not guess between ambiguous URL matches', async () => {
  mock(notificationLookup.pages).mockResolvedValue(['a', 'b'].map(id => ({ id, userId: 'owner', name: id, deployedUrl: 'https://example.com/' })));
  expect((await resolveNotificationNames('owner', new Map([['landingurl', 'https://example.com/']]), date)).landingName).toBe('');
});
it('aborts all storage signals after two seconds without starting later provider work', async () => {
  jest.useFakeTimers();
  try {
    mock(notificationLookup.pages).mockReturnValue(new Promise(() => {}));
    mock(notificationLookup.campaigns).mockReturnValue(new Promise(() => {}));
    const work = resolveNotificationNames('owner', new Map([['landingpageid', 'page'], ['utmcampaign', 'raw'], ['adid', '456']]), date, [account]);
    const pageSignal = mock(notificationLookup.pages).mock.calls[0][2];
    const campaignSignal = mock(notificationLookup.campaigns).mock.calls[0][3];
    expect(pageSignal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await work).toMatchObject({ campaign: 'raw', ad: '456' });
    expect(pageSignal.aborted).toBe(true);
    expect(campaignSignal.aborted).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  } finally { jest.useRealTimers(); }
});
it('redacts encoded, mixed-case and repeated private keys while retaining safe attribution', () => {
  const url = slackAttributionUrl('https://example.com/path?%65mail=hidden&EMAIL=hidden2&accessToken=hidden3&session_id=hidden4&utm_campaign=launch&fbclid=click#hidden');
  expect(url).not.toContain('hidden');
  expect(url).toContain('utm_campaign=launch&amp;fbclid=click');
});
it.each(['javascript:alert(1)', 'https://user:pass@example.com/', '/relative', 'https://example.com/' + 'x'.repeat(3000)])('omits unsafe or oversized URL paths: %s', value => {
  expect(slackAttributionUrl(value)).toBe('');
});
it('keeps complete query pairs and escape entities when a large value precedes attribution', () => {
  const rendered = slackAttributionUrl('https://example.com/path?huge=' + 'x'.repeat(3000) + '&utm_source=google&gclid=click');
  expect(rendered).toBe('https://example.com/path?utm_source=google&amp;gclid=click');
});
