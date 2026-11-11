process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2931 (child of ENG-2883 "failed launches never shown as successful"):
 * every Zoma external write path, for every failure mode, must come back non-success —
 * never success:true, never verification CONFIRMED, never a success-shaped message.
 * Creates must still land PAUSED.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../mcp/zomaOnboarding', () => {
  const actual = jest.requireActual('../mcp/zomaOnboarding');
  return { ...actual, assertZomaWriteReady: jest.fn() };
});

import { normalizeMetaMoney } from '../services/metaService';
import { executeMetaToolkitWrite, type MetaToolkitWriteDeps } from '../mcp/metaToolkitWrites';
import { executeMetaToolkitCreative, type MetaToolkitCreativeDeps } from '../mcp/metaToolkitCreatives';
import { executeGoogleToolkitWrite, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';

const NOW = 1_800_000_000_000;
const SUCCESS_SHAPED = /confirmed by read-back|created and read back|successfully|uploaded and processed/i;

function expectNotSuccess(r: any) {
  expect(r.success).not.toBe(true);
  expect(r.verification).not.toBe('CONFIRMED');
  expect(String(r.message ?? '')).not.toMatch(SUCCESS_SHAPED);
  if (r.verification === undefined) expect(['FAILED', 'NEEDS_NEW_PREVIEW']).toContain(r.status);
  else expect(['UNCONFIRMED', 'MISMATCH']).toContain(r.verification);
}

// ── Meta campaign / ad set / ad writes ───────────────────────────────────────

type Failure = 'lost_answer' | 'provider_error' | 'server_5xx' | 'timeout_throw' | 'missing_id' | 'readback_failure' | 'readback_mismatch';
const FAILURES: Failure[] = ['lost_answer', 'provider_error', 'server_5xx', 'timeout_throw', 'missing_id', 'readback_failure', 'readback_mismatch'];

const META_CASES = [
  { name: 'CAMPAIGN CREATE', args: { entity_type: 'CAMPAIGN', action: 'CREATE', account_id: '111', params: { name: 'C', objective: 'OUTCOME_LEADS', daily_budget: 50 } }, good: { status: 'PAUSED', daily_budget: '5000' }, bad: { status: 'ACTIVE', daily_budget: '5000' } },
  { name: 'AD_SET CREATE', args: { entity_type: 'AD_SET', action: 'CREATE', account_id: '111', campaign_id: '10', params: { name: 'S', daily_budget: 20 } }, good: { status: 'PAUSED', daily_budget: '2000' }, bad: { status: 'PAUSED', daily_budget: '9999' } },
  { name: 'AD CREATE', args: { entity_type: 'AD', action: 'CREATE', account_id: '111', ad_set_id: '20', params: { name: 'A', creative_id: '555' } }, good: { status: 'PAUSED' }, bad: { status: 'ACTIVE' } },
  { name: 'CAMPAIGN UPDATE budget', args: { entity_type: 'CAMPAIGN', action: 'UPDATE', account_id: '111', campaign_id: '999', params: { daily_budget: 60 } }, good: { status: 'PAUSED', daily_budget: '6000' }, bad: { status: 'PAUSED', daily_budget: '5000' } },
];

function metaDeps(failure: Failure | null, c: typeof META_CASES[number]) {
  let dispatched = false;
  const prior = { id: '999', status: 'PAUSED', effective_status: 'PAUSED', daily_budget: '5000' };
  const after = failure === 'readback_mismatch' ? c.bad : c.good;
  const deps: MetaToolkitWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: 'act_111', config: { account_type: 'ad_account', access_token: 't', ad_account_id: '111', granted_scopes: ['ads_management'] } }]),
    previewMoney: jest.fn(async (_u: string, _a: string, params: any) => {
      const out = { ...params };
      if (params.daily_budget !== undefined) out.daily_budget = normalizeMetaMoney(params.daily_budget, 'USD').minorUnits;
      return { params: out, currency: 'USD', confirmation: '' };
    }),
    preview: jest.fn(async (_u: string, entity: string, action: string, accountId: string, cid?: string, as?: string, ad?: string, params?: any) => ({
      success: true, awaitingUserConfirmation: true, summary: `${action} ${entity}`,
      metaWriteDispatch: { entity_type: entity, action, account_id: accountId, campaign_id: cid, ad_set_id: as, ad_id: ad, params },
    })),
    dispatch: jest.fn(async () => {
      dispatched = true;
      if (failure === 'provider_error') return { result: { success: false, error: '(#100) Invalid parameter' } };
      if (failure === 'server_5xx') return { result: { success: false, error: 'Meta returned 500', code: 500 } };
      if (failure === 'timeout_throw') throw new Error('ETIMEDOUT');
      // The agentModeService wrappers catch transport errors and return a plain failure (no code).
      if (failure === 'lost_answer') return { result: { success: false, message: 'Meta request failed', error: 'The request was made but no response was received' } };
      if (failure === 'missing_id') return { result: { success: true, message: 'created successfully' }, createdId: undefined };
      return { result: { success: true, message: 'created successfully' }, createdId: '999' };
    }) as any,
    readBack: jest.fn(async () => {
      if (!dispatched) return prior;
      if (failure === 'readback_failure') throw new Error('Meta read failed');
      return { id: '999', effective_status: after.status, ...after };
    }),
    assertCreativeOwned: jest.fn().mockResolvedValue(undefined),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
  };
  return deps;
}

async function metaConfirm(deps: MetaToolkitWriteDeps, args: any) {
  const p: any = await executeMetaToolkitWrite('u1', args, deps);
  expect(p.status).toBe('PREVIEW');
  return executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: p.preview_token }, deps);
}

describe('ENG-2931 Meta writes never report success on failed/unverified writes', () => {
  const rows = META_CASES.flatMap((c) => FAILURES
    .filter((f) => !(f === 'missing_id' && c.args.action === 'UPDATE')) // an UPDATE's id is its target, not provider output
    .map((f) => [c.name, f, c] as const));

  it.each(rows)('%s × %s', async (_n, failure, c) => {
    const r: any = await metaConfirm(metaDeps(failure, c), c.args);
    expectNotSuccess(r);
  });

  it.each(META_CASES.filter((c) => c.args.action === 'CREATE').map((c) => [c.name, c] as const))('%s still lands PAUSED and confirms on the happy path', async (_n, c) => {
    const deps = metaDeps(null, c);
    const r: any = await metaConfirm(deps, c.args);
    expect((deps.preview as jest.Mock).mock.calls[0][7].status).toBe('PAUSED');
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
  });

  it('a dispatch throw is UNCONFIRMED (may have applied), never "did not apply"', async () => {
    const r: any = await metaConfirm(metaDeps('timeout_throw', META_CASES[0]), META_CASES[0].args);
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(r.message).toMatch(/do not retry blindly/i);
  });

  it.each(META_CASES.map((c) => [c.name, c] as const))('%s: a wrapper-caught lost answer is UNCONFIRMED, not FAILED', async (_n, c) => {
    const r: any = await metaConfirm(metaDeps('lost_answer', c), c.args);
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(r.status).not.toBe('FAILED');
  });

  it('a definite Meta rejection stays FAILED', async () => {
    const r: any = await metaConfirm(metaDeps('provider_error', META_CASES[0]), META_CASES[0].args);
    expect(r).toMatchObject({ status: 'FAILED', success: false });
  });

  it('a repeat confirm with the same token replays the first outcome and sends nothing', async () => {
    const deps = metaDeps('lost_answer', META_CASES[0]);
    const args = META_CASES[0].args;
    const p: any = await executeMetaToolkitWrite('u1', args, deps);
    const first: any = await executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: p.preview_token }, deps);
    const again: any = await executeMetaToolkitWrite('u1', { ...args, confirm: true, preview_token: p.preview_token }, deps);
    expect(again).toMatchObject({ verification: first.verification, message: first.message, replayed: true });
    expect((deps.dispatch as jest.Mock).mock.calls).toHaveLength(1);
  });
});

// ── Meta creative assets ─────────────────────────────────────────────────────

function creativeDeps(over: Partial<MetaToolkitCreativeDeps> = {}): MetaToolkitCreativeDeps {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: '123', config: { account_type: 'ad_account', access_token: 't', ad_account_id: '123', granted_scopes: ['ads_management'] } }]),
    bucket: () => 'b',
    presignPut: jest.fn(() => 'https://b/put'),
    presignGet: jest.fn(() => 'https://b/get'),
    headObject: jest.fn().mockResolvedValue({ key: 'k', contentLength: 2048, contentType: 'image/png' }),
    resolveHost: jest.fn().mockResolvedValue(['104.18.1.1']),
    uploadImage: jest.fn().mockResolvedValue({ success: true, image_hash: 'h' }),
    uploadVideo: jest.fn().mockResolvedValue({ success: true, video: { id: '998877' } }),
    videoStatus: jest.fn().mockResolvedValue({ status: 'ready' }),
    previewCreative: jest.fn().mockResolvedValue({ awaitingUserConfirmation: true, metaWriteDispatch: { entity_type: 'AD_CREATIVE', action: 'CREATE' } }),
    dispatch: jest.fn().mockResolvedValue({ result: { success: true }, createdId: '555' }),
    readCreative: jest.fn().mockResolvedValue({ success: true, creative: { id: '555' } }),
    sleep: jest.fn().mockResolvedValue(undefined),
    now: () => NOW,
    videoWaitMs: 0,
    ...over,
  } as MetaToolkitCreativeDeps;
}
const creative = (action: string, params: any) => ({ entity_type: 'AD_CREATIVE', action, account_id: '123', params });
const CREATE = creative('CREATE', { image_hash: 'h', name: 'n', page_id: '42', body: 'b', title: 't', link_url: 'https://x.com' });

describe('ENG-2931 Meta creative writes never report success on failed/unverified writes', () => {
  const cases: Array<[string, any, Partial<MetaToolkitCreativeDeps>]> = [
    ['CREATE × wrapper-caught lost answer', CREATE, { dispatch: jest.fn().mockResolvedValue({ result: { success: false, error: 'The request was made but no response was received' } }) }],
    ['CREATE × provider error', CREATE, { dispatch: jest.fn().mockResolvedValue({ result: { success: false, error: '(#100) bad' } }) }],
    ['CREATE × 5xx', CREATE, { dispatch: jest.fn().mockResolvedValue({ result: { success: false, error: '500', code: 500 } }) }],
    ['CREATE × timeout throw', CREATE, { dispatch: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')) }],
    ['CREATE × missing id', CREATE, { dispatch: jest.fn().mockResolvedValue({ result: { success: true } }) }],
    ['CREATE × read-back failure', CREATE, { readCreative: jest.fn().mockRejectedValue(new Error('read failed')) }],
    ['CREATE × read-back mismatch', CREATE, { readCreative: jest.fn().mockResolvedValue({ success: true, creative: { id: '777' } }) }],
    ['UPLOAD_IMAGE × provider error', creative('UPLOAD_IMAGE', { image_url: 'https://cdn.x/a.png' }), { uploadImage: jest.fn().mockResolvedValue({ success: false, error: 'bad image' }) }],
    ['UPLOAD_IMAGE × missing hash', creative('UPLOAD_IMAGE', { image_url: 'https://cdn.x/a.png' }), { uploadImage: jest.fn().mockResolvedValue({ success: true }) }],
    ['UPLOAD_VIDEO × provider error', creative('UPLOAD_VIDEO', { video_url: 'https://cdn.x/v.mp4' }), { uploadVideo: jest.fn().mockResolvedValue({ success: false, error: '500' }) }],
    ['UPLOAD_VIDEO × missing id', creative('UPLOAD_VIDEO', { video_url: 'https://cdn.x/v.mp4' }), { uploadVideo: jest.fn().mockResolvedValue({ success: true, video: {} }) }],
    ['UPLOAD_VIDEO × still processing (unverified)', creative('UPLOAD_VIDEO', { video_url: 'https://cdn.x/v.mp4' }), { videoStatus: jest.fn().mockResolvedValue({ status: 'processing' }) }],
    ['UPLOAD_VIDEO × processing error', creative('UPLOAD_VIDEO', { video_url: 'https://cdn.x/v.mp4' }), { videoStatus: jest.fn().mockResolvedValue({ status: 'error', error: 'codec' }) }],
  ];

  it.each(cases)('%s', async (_n, args, over) => {
    const r: any = await executeMetaToolkitCreative('u1', args, creativeDeps(over));
    expectNotSuccess(r);
  });

  it('a wrapper-caught lost answer on CREATE is UNCONFIRMED with list-before-retry advice', async () => {
    const r: any = await executeMetaToolkitCreative('u1', CREATE, creativeDeps({ dispatch: jest.fn().mockResolvedValue({ result: { success: false, error: 'The request was made but no response was received' } }) }));
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(r.message).toMatch(/List the account's creatives/);
  });
});

// ── Google Ads writes ────────────────────────────────────────────────────────

const CID = '1234567890';
const BUDGET = `customers/${CID}/campaignBudgets/55`;
const CAMPAIGN = `customers/${CID}/campaigns/77`;

const GOOGLE_CASES = [
  { name: 'BUDGET UPDATE', args: { customer_id: CID, entity_type: 'BUDGET', action: 'UPDATE', budget_resource_name: BUDGET, amount: 50 } },
  { name: 'BUDGET CREATE', args: { customer_id: CID, entity_type: 'BUDGET', action: 'CREATE', name: 'New', amount: 25 } },
  { name: 'CAMPAIGN CREATE', args: { customer_id: CID, entity_type: 'CAMPAIGN', action: 'CREATE', name: 'New', type: 'SEARCH', budget_resource_name: BUDGET, bidding_strategy: 'TARGET_SPEND' } },
  { name: 'CAMPAIGN UPDATE status', args: { customer_id: CID, entity_type: 'CAMPAIGN', action: 'UPDATE', campaign_resource_name: CAMPAIGN, status: 'PAUSED' } },
];

function googleDeps(failure: Failure | null) {
  let dispatched = false;
  const state: Record<string, any> = {
    [BUDGET]: { resourceName: BUDGET, name: 'Daily', amountMicros: 20_000_000, explicitlyShared: true, referenceCount: 1 },
    [CAMPAIGN]: { resourceName: CAMPAIGN, name: 'Brand', status: 'ENABLED', budget: BUDGET },
    [`customers/${CID}/campaignBudgets/900`]: { resourceName: `customers/${CID}/campaignBudgets/900`, amountMicros: failure === 'readback_mismatch' ? 1 : 25_000_000, referenceCount: 0 },
    [`customers/${CID}/campaigns/901`]: { resourceName: `customers/${CID}/campaigns/901`, status: failure === 'readback_mismatch' ? 'ENABLED' : 'PAUSED', budget: BUDGET },
  };
  const deps: GoogleToolkitWriteDeps = {
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u: string, _c: string, _k: string, rn: string) => {
      if (dispatched && failure === 'readback_failure') throw new Error('GAQL failed');
      if (dispatched && failure === 'readback_mismatch' && rn === BUDGET) return { ...state[BUDGET], amountMicros: 1 };
      if (dispatched && failure === 'readback_mismatch' && rn === CAMPAIGN) return { ...state[CAMPAIGN], status: 'ENABLED' };
      if (dispatched && failure !== 'readback_mismatch' && rn === BUDGET) return { ...state[BUDGET], amountMicros: 50_000_000 };
      if (dispatched && failure !== 'readback_mismatch' && rn === CAMPAIGN) return { ...state[CAMPAIGN], status: 'PAUSED' };
      return state[rn] ? { ...state[rn] } : null;
    }),
    dispatch: jest.fn(async (_u: string, args: any) => {
      dispatched = true;
      if (failure === 'provider_error') return { success: false, error: 'INVALID_ARGUMENT', code: 400 };
      if (failure === 'server_5xx') return { success: false, error: 'INTERNAL', code: 500 };
      if (failure === 'timeout_throw') throw new Error('ETIMEDOUT');
      if (failure === 'missing_id') return { success: true };
      if (args.entity_type === 'BUDGET' && args.action === 'CREATE') return { success: true, budgetResourceName: `customers/${CID}/campaignBudgets/900` };
      if (args.entity_type === 'CAMPAIGN' && args.action === 'CREATE') return { success: true, campaignResourceName: `customers/${CID}/campaigns/901` };
      return { success: true };
    }),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
  };
  return deps;
}

async function googleConfirm(deps: GoogleToolkitWriteDeps, args: any) {
  const p: any = await executeGoogleToolkitWrite('u1', args, 'USD', deps);
  expect(p.status).toBe('PREVIEW');
  return executeGoogleToolkitWrite('u1', { ...args, confirm: true, preview_token: p.preview_token }, 'USD', deps);
}

describe('ENG-2931 Google writes never report success on failed/unverified writes', () => {
  const rows = GOOGLE_CASES.flatMap((c) => FAILURES
    .filter((f) => f !== 'lost_answer') // Meta-wrapper shape; Google's own outcomeUnknown path covers it
    .filter((f) => !(f === 'missing_id' && c.args.action === 'UPDATE'))
    .map((f) => [c.name, f, c] as const));

  it.each(rows)('%s × %s', async (_n, failure, c) => {
    const r: any = await googleConfirm(googleDeps(failure), c.args);
    expectNotSuccess(r);
  });

  it('CAMPAIGN CREATE still lands PAUSED and confirms on the happy path', async () => {
    const deps = googleDeps(null);
    const r: any = await googleConfirm(deps, GOOGLE_CASES[2].args);
    expect((deps.dispatch as jest.Mock).mock.calls[0][1]).toMatchObject({ status: 'PAUSED' });
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
  });
});
