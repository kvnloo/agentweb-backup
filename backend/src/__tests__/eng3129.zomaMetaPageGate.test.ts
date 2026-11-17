/**
 * ENG-3129 — Zoma refuses Meta ad / creative CREATE when the connection has no usable Facebook
 * Page (stored probe `has_meta_pages: false`), WITHOUT calling Meta. The refusal carries the
 * canonical getMetaAdsNoPagesMessage, a one-click reconnect link, and the Business Settings
 * step (grant this Facebook user Advertiser access on Page X, then reconnect and select it).
 * Reads stay ungated, and explainMetaError maps Page-permission errors to the same message.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: {} }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: {} }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: { readToolkitMetaActivityLog: jest.fn().mockResolvedValue({ data: [] }) } }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});

import { executeMetaToolkitWrite, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { executeMetaToolkitCreative, type MetaToolkitCreativeDeps } from '../mcp/metaToolkitCreatives';
import { explainMetaError, META_ERROR_EXPLANATIONS } from '../mcp/metaToolkitDiagnostics';
import { META_BUSINESS_PAGES_SETTINGS_URL } from '../mcp/metaPageAccessRefusal';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { handleMetaToolkitCall } from '../mcp/metaToolkitGateway';
import { agentModeService } from '../services/agentModeService';
import { buildMetaAdsWrongPageMessage, META_ADS_NO_PAGES_MESSAGE } from '../utils/metaAdsScope';

const ACCOUNT = '111';
const LINK = 'https://www.facebook.com/v25.0/dialog/oauth?client_id=1&auth_type=rerequest&state=s';

const account = (pages: Record<string, unknown> = { has_meta_pages: false }) => ({
  platform: 'meta',
  account_id: `act_${ACCOUNT}`,
  config: { account_type: 'ad_account', access_token: 'tok', ad_account_id: ACCOUNT, granted_scopes: ['ads_read', 'ads_management'], ...pages },
});

function writeDeps(pages?: Record<string, unknown>, over: Partial<MetaToolkitWriteDeps> = {}) {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([account(pages)]),
    previewMoney: jest.fn(async (_u: string, _a: string, params: any) => ({ params, currency: 'USD', confirmation: '' })),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, c?: string, as?: string, ad?: string, params?: any) => ({
      success: true,
      awaitingUserConfirmation: true,
      summary: `${action} ${entity}`,
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, campaign_id: c, ad_set_id: as, ad_id: ad, params },
    })),
    dispatch: jest.fn(),
    readBack: jest.fn().mockResolvedValue({ id: '5', status: 'PAUSED', name: 'old' }),
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
    conversionLookup: jest.fn(),
    connectLink: jest.fn().mockResolvedValue(LINK),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => 1_800_000_000_000,
    consumedTokens: new Map(),
    ...over,
  } as MetaToolkitWriteDeps & Record<string, jest.Mock>;
}

function creativeDeps(pages?: Record<string, unknown>, over: Partial<MetaToolkitCreativeDeps> = {}) {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([account(pages)]),
    bucket: () => 'agentweb-user-files',
    presignPut: jest.fn(),
    presignGet: jest.fn(),
    headObject: jest.fn(),
    resolveHost: jest.fn().mockResolvedValue(['104.18.1.1']),
    probeUrl: jest.fn(async (url: string) => ({ finalUrl: url, status: 200, contentType: 'image/png', contentLength: 5_000 })),
    uploadImage: jest.fn().mockResolvedValue({ success: true, image_hash: 'hash' }),
    uploadVideo: jest.fn(),
    videoStatus: jest.fn(),
    previewCreative: jest.fn(),
    dispatch: jest.fn(),
    readCreative: jest.fn(),
    connectLink: jest.fn().mockResolvedValue(LINK),
    sleep: jest.fn().mockResolvedValue(undefined),
    now: () => 1_700_000_000_000,
    videoWaitMs: 90_000,
    ...over,
  } as MetaToolkitCreativeDeps & Record<string, jest.Mock>;
}

const adCreate = { entity_type: 'AD', action: 'CREATE', account_id: ACCOUNT, ad_set_id: '22', params: { name: 'Ad', creative_id: '33' } };
const creativeCreate = (params: any = {}) => ({
  entity_type: 'AD_CREATIVE', action: 'CREATE', account_id: ACCOUNT,
  params: { name: 'UGC', page_id: '4242', image_hash: 'h', link_url: 'https://shop.example.com', call_to_action_type: 'SHOP_NOW', ...params },
});

async function refusalOf(p: Promise<unknown>): Promise<string> {
  const error = await p.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(MetaToolkitRefusal);
  return (error as Error).message;
}

function expectNoMetaCall(d: Record<string, any>) {
  for (const k of ['preview', 'previewMoney', 'dispatch', 'readBack', 'assertCreativeOwned', 'conversionLookup', 'previewCreative', 'readCreative', 'uploadImage', 'uploadVideo', 'videoStatus']) {
    if (d[k]) expect(d[k]).not.toHaveBeenCalled();
  }
}

describe('ENG-3129 Page gate on Zoma Meta creates', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AD CREATE on a no-Page account is refused before any Meta call, with message, link and Business Settings step', async () => {
    const d = writeDeps();
    const message = await refusalOf(executeMetaToolkitWrite('u1', adCreate, d));
    expectNoMetaCall(d);
    expect(message).toContain(META_ADS_NO_PAGES_MESSAGE);
    expect(message).toContain(LINK);
    expect(message).toContain(META_BUSINESS_PAGES_SETTINGS_URL);
    expect(message).toMatch(/grant this Facebook user "Create ads" \(Advertiser\) access/);
    expect(message).toMatch(/select the Facebook Page you advertise from on the Pages step/);
    expect(d.connectLink).toHaveBeenCalledWith('u1');
  });

  it('a confirm=true replay is refused the same way (no token path reaches Meta)', async () => {
    const d = writeDeps();
    await refusalOf(executeMetaToolkitWrite('u1', { ...adCreate, confirm: true, preview_token: 'v1.9999999999999.x' }, d));
    expectNoMetaCall(d);
  });

  it('a repeat confirm of a CREATE that already succeeded returns the recorded outcome, not a Page refusal', async () => {
    const token = 'v1.recorded.x';
    const recorded = { status: 'EXECUTED', success: true, id: '777' };
    const d = writeDeps(undefined, { tokenOutcomes: new Map([[token, { exp: 1_900_000_000_000, outcome: recorded }]]) });
    const result = await executeMetaToolkitWrite('u1', { ...adCreate, confirm: true, preview_token: token }, d);
    expect(result).toMatchObject({ ...recorded, replayed: true });
    expectNoMetaCall(d);
  });

  it('names Page X when the account\'s existing ads run under a specific Page', async () => {
    const d = writeDeps({ has_meta_pages: false, existing_ads_page_id: '9001' });
    const message = await refusalOf(executeMetaToolkitWrite('u1', { ...adCreate, entity_type: 'CAMPAIGN', params: { name: 'C', objective: 'OUTCOME_LEADS' } }, d));
    expectNoMetaCall(d);
    expect(message).toContain(buildMetaAdsWrongPageMessage('9001'));
    expect(message).toContain('access on Facebook Page 9001');
    expect(message).toContain('select Facebook Page 9001 on the Pages step');
  });

  it('a link that cannot be minted still refuses, pointing at zoma_status for the link', async () => {
    const d = writeDeps(undefined, { connectLink: jest.fn().mockRejectedValue(new Error('secrets down')) });
    const message = await refusalOf(executeMetaToolkitWrite('u1', adCreate, d));
    expectNoMetaCall(d);
    expect(message).toContain('run zoma_status for a one-click reconnect link');
  });

  it('AD_CREATIVE CREATE and BULK_CREATE are refused before any Meta call, naming the requested page_id', async () => {
    const d = creativeDeps();
    const message = await refusalOf(executeMetaToolkitCreative('u1', creativeCreate(), d));
    expect(message).toContain(META_ADS_NO_PAGES_MESSAGE);
    expect(message).toContain(LINK);
    expect(message).toContain('"Create ads" (Advertiser) access on Facebook Page 4242');
    await refusalOf(executeMetaToolkitCreative('u1', { ...creativeCreate(), action: 'BULK_CREATE', params: { page_id: '4242', items: [{ image_hash: 'h' }] } }, d));
    expectNoMetaCall(d);
  });

  it('never-probed (unknown) and granted Page access are not gated', async () => {
    for (const pages of [{}, { has_meta_pages: true }]) {
      const d = writeDeps(pages);
      const result: any = await executeMetaToolkitWrite('u1', adCreate, d);
      expect(result.status).toBe('PREVIEW');
      expect(d.preview).toHaveBeenCalledTimes(1);
      expect(d.connectLink).not.toHaveBeenCalled();
    }
  });

  it('non-create writes and asset uploads on a no-Page account are not gated by this check', async () => {
    const d = writeDeps();
    const result: any = await executeMetaToolkitWrite('u1', { entity_type: 'AD', action: 'UPDATE', account_id: ACCOUNT, ad_id: '5', params: { name: 'new' } }, d);
    expect(result.status).toBe('PREVIEW');
    const c = creativeDeps();
    const upload: any = await executeMetaToolkitCreative('u1', { entity_type: 'AD_CREATIVE', action: 'UPLOAD_IMAGE', account_id: ACCOUNT, params: { image_url: 'https://cdn.example.com/a.png' } }, c);
    expect(upload).toMatchObject({ success: true, image_hash: 'hash' });
    expect(c.connectLink).not.toHaveBeenCalled();
  });

  it('reads on a no-Page account stay ungated', async () => {
    const d: any = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', scopes: ['tools:read'] }),
      listAccounts: jest.fn().mockResolvedValue([account()]),
      now: () => 0,
      rateLimiter: { check: () => ({ allowed: true }) },
      recordUsage: jest.fn(),
    };
    await handleMetaToolkitCall({ authorization: 'Bearer aw_fixture', toolName: 'ads_account_get_activity_logs' }, d);
    expect(agentModeService.readToolkitMetaActivityLog).toHaveBeenCalledWith('u1', { account_id: ACCOUNT });
  });
});

describe('ENG-3129 explainMetaError maps Page-permission errors', () => {
  it('a code-200 Page refusal returns the Page message and fix, not the generic code-200 hint', () => {
    const r: any = explainMetaError({ code: '200', message: '(#200) Requires pages_manage_ads permission to manage the object' });
    expect(r).toMatchObject({ code: '200', known: true, page_access: 'missing', meaning: META_ADS_NO_PAGES_MESSAGE });
    expect(r.action).not.toBe(META_ERROR_EXPLANATIONS['200'].action);
    expect(r.action).toContain(META_BUSINESS_PAGES_SETTINGS_URL);
    expect(r.action).toContain('Advertiser');
  });

  it('code 283 (Page extended permission) maps without a message; code 10 maps when Meta names the Page', () => {
    expect(explainMetaError({ code: '283' })).toMatchObject({ page_access: 'missing', meaning: META_ADS_NO_PAGES_MESSAGE });
    expect(explainMetaError({ code: '10', message: 'Param page_id must be a Page you have permission to advertise from' })).toMatchObject({ page_access: 'missing' });
  });

  it('a code-200 refusal that is not about a Page keeps the generic hint', () => {
    expect(explainMetaError({ code: '200' })).toEqual({ code: '200', known: true, ...META_ERROR_EXPLANATIONS['200'] });
    expect(explainMetaError({ code: '200', message: 'Ad account owner has NOT granted ads_management permission' })).not.toHaveProperty('page_access');
  });

  it('rejects a non-string message', () => {
    expect(() => explainMetaError({ code: '200', message: 5 })).toThrow(MetaToolkitRefusal);
  });
});
