/**
 * ENG-3064 (ENG-592 slice 2): every LinkedIn Ads update either proves itself by reading the
 * resource back or is on an explicit, reasoned exemption list. Stubbed HTTP only: axios is a
 * jest mock, no live LinkedIn call. Pattern: docs/ad-api-read-back-pattern.md.
 */
const mockAxiosFn = jest.fn();

jest.mock('axios', () => {
  const fn = (...args: any[]) => mockAxiosFn(...args);
  (fn as any).post = jest.fn();
  (fn as any).get = jest.fn();
  (fn as any).put = jest.fn().mockResolvedValue({ data: {} });
  (fn as any).create = jest.fn().mockReturnValue(fn);
  return { __esModule: true, default: fn };
});

jest.mock('../config/integrations', () => ({
  INTEGRATION_CONFIG: {
    linkedinAds: { apiVersion: '202603', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken' },
  },
}));

import * as svc from '../services/linkedInAdsService';

const TOKEN = 't';
const ACCT = '123';
const CAMPAIGN = '555';

const MUTATION_PREFIX = /^(create|update|remove|delete|add|set|attach|upload|retag|pause|resume|archive|initialize|finalize|send)/;

/** Update paths that read the resource back and return errorType 'unsupported_field'. */
const VERIFIED = new Set([
  'updateCampaignGroup',
  'updateCampaign',
  'updateCreativeStatus',
  'retagCreativeUtm',
  'retagPostUtm',
]);

/** Explicit exemptions, each with the reason it is not verified by read-back. */
const EXEMPT: Record<string, string> = {
  createCampaignGroup: 'create: LinkedIn returns the new id in x-restli-id; a create that did not land fails the request',
  createCampaign: 'create: returned id is the evidence',
  createPost: 'create: returned post URN is the evidence',
  createCreative: 'create: returned creative id is the evidence',
  createCreativeInline: 'create: returned creative id is the evidence',
  createDynamicCreative: 'create: returned creative id is the evidence',
  createInMailContent: 'create: returned content URN is the evidence',
  createConversationAd: 'create: returned conversation URN is the evidence',
  createConversationAdContent: 'create: returned message-content URN is the evidence',
  setConversationAdFirstContent: 'no usable read: LinkedIn documents the first-message field as update-only and its GET example does not return it',
  initializeImageUpload: 'upload step: returns the upload URL and image URN used by the next step',
  uploadImageBinary: 'upload step: throws on a non-2xx PUT',
  initializeVideoUpload: 'upload step: returns upload instructions and video URN used by the next step',
  uploadVideoPart: 'upload step: throws on a non-2xx PUT; returns the part ETag',
  finalizeVideoUpload: 'upload step: a failed finalize fails the request',
  initializeDocumentUpload: 'upload step: returns the upload URL and document URN used by the next step',
  uploadDocumentBinary: 'upload step: throws on a non-2xx PUT',
  sendTestInMail: 'not a config mutation: sends one test message, nothing to read back',
};

const ok = (data: any = {}) => ({ data, headers: {}, status: 200 });
const fail = (status: number, message: string) => ({ response: { status, data: { message } } });
const calls = () => mockAxiosFn.mock.calls.map((c) => c[0]);

beforeEach(() => {
  mockAxiosFn.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ENG-3064 LinkedIn Ads mutation surface coverage', () => {
  it('every exported mutation-shaped function is verified or explicitly exempt', () => {
    const fns = Object.keys(svc).filter((k) => typeof (svc as any)[k] === 'function' && MUTATION_PREFIX.test(k));
    expect(fns.filter((f) => !VERIFIED.has(f) && !(f in EXEMPT))).toEqual([]);
    for (const name of [...VERIFIED, ...Object.keys(EXEMPT)]) expect(fns).toContain(name);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
    expect([...VERIFIED].filter((f) => f in EXEMPT)).toEqual([]);
  });
});

describe('updateCampaignGroup read-back', () => {
  const params = { status: 'PAUSED', name: 'Q4', total_budget_amount: 1500, run_schedule_end: 1800000000000 };

  it('every field landed: success, read from the single-group endpoint', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({
      status: 'PAUSED', name: 'Q4', totalBudget: { amount: '1500.00', currencyCode: 'USD' }, runSchedule: { start: 1, end: 1800000000000 },
    }));
    const result = await svc.updateCampaignGroup(TOKEN, ACCT, '77', params);
    expect(result.success).toBe(true);
    expect(calls()[1]).toMatchObject({ method: 'GET', url: `https://api.linkedin.com/rest/adAccounts/${ACCT}/adCampaignGroups/77` });
  });

  it('fields unchanged on read-back: unsupported_field with exactly those fields', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({
      status: 'ACTIVE', name: 'Q4', totalBudget: { amount: '900', currencyCode: 'USD' }, runSchedule: { start: 1, end: 1800000000000 },
    }));
    const result = await svc.updateCampaignGroup(TOKEN, ACCT, '77', params);
    expect(result).toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status', 'totalBudget.amount'] });
    expect(result.error).toContain('status, totalBudget.amount');
    // Only the fields that did not land are called unapplied; name and schedule did land here.
    expect(result.error).toContain('Those field(s) were NOT applied');
    expect(result.error).not.toContain('The change was NOT applied');
  });

  it('read-back request fails: not reported as success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockRejectedValueOnce(fail(500, 'boom'));
    const result = await svc.updateCampaignGroup(TOKEN, ACCT, '77', params);
    expect(result).toMatchObject({ success: false, errorType: 'read_back_failed' });
  });

  it('resource missing on read-back (404, or 200 with no body) is a failure', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockRejectedValueOnce(fail(404, 'not found'));
    expect((await svc.updateCampaignGroup(TOKEN, ACCT, '77', { status: 'PAUSED' })).success).toBe(false);
    mockAxiosFn.mockReset();
    mockAxiosFn.mockResolvedValueOnce(ok()).mockResolvedValueOnce({ data: undefined, headers: {}, status: 200 });
    expect(await svc.updateCampaignGroup(TOKEN, ACCT, '77', { status: 'PAUSED' }))
      .toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['status'] });
  });

  it('update request itself failed: no read-back request is made', async () => {
    mockAxiosFn.mockRejectedValueOnce(fail(400, 'bad'));
    const result = await svc.updateCampaignGroup(TOKEN, ACCT, '77', params);
    expect(result.success).toBe(false);
    expect(result.errorType).toBeUndefined();
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
  });
});

describe('updateCampaign read-back', () => {
  const params = {
    status: 'ACTIVE', name: 'Brand', daily_budget_amount: 50, total_budget_amount: 2000, unit_cost_amount: 7.5,
    run_schedule_start: 1790000000000, run_schedule_end: 1800000000000,
  };
  const landed = {
    status: 'ACTIVE', name: 'Brand',
    dailyBudget: { amount: '50', currencyCode: 'USD' }, totalBudget: { amount: '2000.0', currencyCode: 'USD' },
    unitCost: { amount: '7.50', currencyCode: 'USD' }, runSchedule: { start: 1790000000000, end: 1800000000000 },
  };

  it('every field landed: success, read from the single-campaign endpoint', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(landed));
    expect((await svc.updateCampaign(TOKEN, ACCT, '9', params)).success).toBe(true);
    expect(calls()[1]).toMatchObject({ method: 'GET', url: `https://api.linkedin.com/rest/adAccounts/${ACCT}/adCampaigns/9` });
  });

  it('budget and schedule unchanged on read-back: unsupported_field', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({
      ...landed, dailyBudget: { amount: '20', currencyCode: 'USD' }, runSchedule: { start: 1790000000000, end: 1 },
    }));
    expect(await svc.updateCampaign(TOKEN, ACCT, '9', params))
      .toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['dailyBudget.amount', 'runSchedule.end'] });
  });

  it('read-back request fails: not reported as success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockRejectedValueOnce(fail(429, 'slow down'));
    expect(await svc.updateCampaign(TOKEN, ACCT, '9', params)).toMatchObject({ success: false, errorType: 'read_back_failed' });
  });

  it('update request itself failed: no read-back request is made', async () => {
    mockAxiosFn.mockRejectedValueOnce(fail(400, 'bad'));
    expect((await svc.updateCampaign(TOKEN, ACCT, '9', params)).success).toBe(false);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
  });

  it('a targeting-only update is sent but not compared (field-level exemption), so no read is made', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok());
    const result = await svc.updateCampaign(TOKEN, ACCT, '9', { targeting_criteria: { include: { and: [] } } });
    expect(result.success).toBe(true);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
  });
});

describe('updateCreativeStatus read-back', () => {
  it('status landed: success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({ intendedStatus: 'PAUSED' }));
    expect((await svc.updateCreativeStatus(TOKEN, ACCT, '42', 'PAUSED')).success).toBe(true);
    expect(calls()[1].method).toBe('GET');
    expect(calls()[1].url).toContain(`/creatives/${encodeURIComponent('urn:li:sponsoredCreative:42')}`);
  });

  it('status unchanged on read-back: unsupported_field', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok({ intendedStatus: 'ACTIVE' }));
    expect(await svc.updateCreativeStatus(TOKEN, ACCT, '42', 'PAUSED'))
      .toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['intendedStatus'] });
  });

  it('read-back request fails: not reported as success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok()).mockRejectedValueOnce(fail(503, 'down'));
    expect(await svc.updateCreativeStatus(TOKEN, ACCT, '42', 'PAUSED')).toMatchObject({ success: false, errorType: 'read_back_failed' });
  });

  it('update request itself failed: no read-back request is made', async () => {
    mockAxiosFn.mockRejectedValueOnce(fail(403, 'no'));
    expect((await svc.updateCreativeStatus(TOKEN, ACCT, '42', 'PAUSED')).success).toBe(false);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
  });
});

describe('retagCreativeUtm (text ad) read-back', () => {
  const before = { content: { textAd: { headline: 'H', description: 'D', landingPage: 'https://example.com/' } } };
  const written = () => calls()[1].data.patch.$set.content.textAd.landingPage as string;

  it('URL landed: success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok(before)).mockResolvedValueOnce(ok())
      .mockImplementationOnce(async () => ok({ content: { textAd: { ...before.content.textAd, landingPage: written() } } }));
    expect((await svc.retagCreativeUtm(TOKEN, ACCT, '42', CAMPAIGN)).success).toBe(true);
    expect(mockAxiosFn).toHaveBeenCalledTimes(3);
  });

  it('URL unchanged on read-back: unsupported_field', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok(before)).mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok(before));
    expect(await svc.retagCreativeUtm(TOKEN, ACCT, '42', CAMPAIGN))
      .toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['content.textAd.landingPage'] });
  });

  it('read-back request fails: not reported as success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok(before)).mockResolvedValueOnce(ok()).mockRejectedValueOnce(fail(500, 'boom'));
    expect(await svc.retagCreativeUtm(TOKEN, ACCT, '42', CAMPAIGN)).toMatchObject({ success: false, errorType: 'read_back_failed' });
  });

  it('update request itself failed: no read-back request is made', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok(before)).mockRejectedValueOnce(fail(400, 'bad'));
    expect((await svc.retagCreativeUtm(TOKEN, ACCT, '42', CAMPAIGN)).success).toBe(false);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
  });
});

describe('retagPostUtm read-back', () => {
  const POST = 'urn:li:share:999';
  const written = () => calls()[1].data.patch.$set.contentLandingPage as string;

  it('URL landed: success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok({ contentLandingPage: 'https://example.com/' })).mockResolvedValueOnce(ok())
      .mockImplementationOnce(async () => ok({ contentLandingPage: written() }));
    expect((await svc.retagPostUtm(TOKEN, POST, CAMPAIGN)).success).toBe(true);
    expect(calls()[2]).toMatchObject({ method: 'GET', url: `https://api.linkedin.com/rest/posts/${encodeURIComponent(POST)}` });
  });

  it('URL unchanged on read-back: unsupported_field', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok({ contentLandingPage: 'https://example.com/' })).mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok({ contentLandingPage: 'https://example.com/' }));
    expect(await svc.retagPostUtm(TOKEN, POST, CAMPAIGN))
      .toMatchObject({ success: false, errorType: 'unsupported_field', fields: ['contentLandingPage'] });
  });

  it('read-back request fails: not reported as success', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok({ contentLandingPage: 'https://example.com/' })).mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(fail(500, 'boom'));
    expect(await svc.retagPostUtm(TOKEN, POST, CAMPAIGN)).toMatchObject({ success: false, errorType: 'read_back_failed' });
  });

  it('update request itself failed: no read-back request is made', async () => {
    mockAxiosFn.mockResolvedValueOnce(ok({ contentLandingPage: 'https://example.com/' })).mockRejectedValueOnce(fail(400, 'bad'));
    expect((await svc.retagPostUtm(TOKEN, POST, CAMPAIGN)).success).toBe(false);
    expect(mockAxiosFn).toHaveBeenCalledTimes(2);
  });
});

describe('exempt path stays as it was', () => {
  it('setConversationAdFirstContent makes one request and no read', async () => {
    mockAxiosFn.mockResolvedValueOnce({ data: {}, headers: {}, status: 204 });
    expect((await svc.setConversationAdFirstContent(TOKEN, 'urn:li:sponsoredConversation:1', 'urn:li:sponsoredMessageContent:2')).success).toBe(true);
    expect(mockAxiosFn).toHaveBeenCalledTimes(1);
  });
});
