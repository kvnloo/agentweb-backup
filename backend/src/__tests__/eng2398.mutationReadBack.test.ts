/**
 * ENG-2398 (ENG-592 slice 1b): every Google Ads mutation either proves itself by read-back
 * or is on an explicit, reasoned exemption list. Zero live network: credentials, mutate and
 * search are stubbed fixtures. Pattern: docs/ad-api-read-back-pattern.md.
 */
import { GoogleAdsService, GoogleAdsReadBackError } from '../services/googleAdsService';

const MUTATION_PREFIX = /^(create|update|remove|add|set|attach|upload|retag|pause|resume)/;

/** Methods that verify by read-back (search after mutate) and throw GoogleAdsReadBackError. */
const VERIFIED = new Set([
  'updateBudget', 'removeBudget',
  'updateCampaign', 'pauseCampaign', 'resumeCampaign', 'removeCampaign', 'retagAdUtm',
  'removeCampaignCriterion',
  'updateAdGroup', 'removeAdGroup',
  'updateKeyword', 'removeKeyword',
  'updateAd', 'removeAd',
  'removeConversionAction',
  'updateAssetGroup', // ENG-2928: status read back via verifyFieldsReadBack
  'setDeviceBidAdjustments', 'retagAssetGroupUtm', // ENG-2398 residual
  'updateResponsiveSearchAdContent', // ENG-2979: RSA fields read back, throws GoogleAdsReadBackError
]);

/** Explicit exemptions, each with the reason it is not a silent-success risk. */
const EXEMPT: Record<string, string> = {
  createBudget: 'create: Google returns the new resourceName; a create that did not land fails the mutate',
  createCampaign: 'create: returned resourceName is evidence; status staged PAUSED',
  createAdGroup: 'create: returned resourceName is evidence',
  createAd: 'create: returned resourceName is evidence; policy review is a separate signal',
  createAssetGroup: 'create: batchMutate is atomic, returned resourceNames are evidence',
  createConversionAction: 'create: reads back and returns field-level drift to the tool (driftWarning)',
  updateConversionAction: 'reads back and returns field-level drift to the tool (driftWarning); Google normalizes some fields, so drift is surfaced not thrown',
  addKeywords: 'create: per-criterion resourceNames returned; partial failure surfaces as mutate error',
  addNegativeKeywords: 'create: returned resourceNames are evidence',
  addNegativeCampaignCriteria: 'create: validated by NegativeCampaignCriteriaValidationError before mutate',
  addProximityCriterion: 'create: returned resourceName is evidence',
  updateConversionGoalBiddable: 'ENG-2979-era: reads back and returns drift to the tool (same contract as updateConversionAction)',
  uploadAsset: 'create: returned asset resourceName is evidence',
  attachCampaignAssets: 'create: returned campaign_asset resourceNames are evidence',
  uploadClickConversions: 'not a config mutation; partialFailureError is returned to the caller',
  createTextAsset: 'private helper for createAssetGroup; returned resourceName is evidence',
};

describe('ENG-2398 mutation surface coverage', () => {
  it('every public mutation method is verified or explicitly exempt', () => {
    const methods = Object.getOwnPropertyNames(GoogleAdsService.prototype)
      .filter((m) => m !== 'constructor' && MUTATION_PREFIX.test(m));
    const uncovered = methods.filter((m) => !VERIFIED.has(m) && !(m in EXEMPT));
    expect(uncovered).toEqual([]);
    for (const m of [...VERIFIED, ...Object.keys(EXEMPT)]) {
      expect(methods).toContain(m);
    }
  });
});

const AG = 'customers/123/adGroups/7';
const KW = 'customers/123/adGroupCriteria/7~55';
const AD = 'customers/123/adGroupAds/7~88';
const BUDGET = 'customers/123/campaignBudgets/3';

function setup(row: Record<string, unknown> | null, rowKey: string) {
  const svc = new GoogleAdsService();
  jest.spyOn(svc, 'getAccountCredentials').mockResolvedValue({ accessToken: 't', loginCustomerId: undefined } as any);
  const mutate = jest.spyOn(svc, 'mutate').mockResolvedValue({ results: [{}] });
  const search = jest.spyOn(svc, 'search').mockResolvedValue(row ? [{ [rowKey]: row }] : []);
  return { svc, mutate, search };
}

beforeAll(() => jest.spyOn(console, 'error').mockImplementation(() => {}));

describe('update read-back', () => {
  it('updateBudget: amount unchanged throws unsupported_field', async () => {
    const { svc } = setup({ amountMicros: '1000000' }, 'campaignBudget');
    await expect(svc.updateBudget('u', '123', BUDGET, 5_000_000))
      .rejects.toMatchObject({ code: 'unsupported_field', fields: ['amount_micros'] });
  });

  it('updateBudget: int64 string read-back matches numeric request', async () => {
    const { svc } = setup({ amountMicros: '5000000' }, 'campaignBudget');
    await expect(svc.updateBudget('u', '123', BUDGET, 5_000_000)).resolves.toBeUndefined();
  });

  it('updateAdGroup: cpc bid unchanged throws; matching fields resolve true', async () => {
    const bad = setup({ status: 'PAUSED', cpcBidMicros: '100' }, 'adGroup');
    await expect(bad.svc.updateAdGroup('u', '123', AG, { status: 'PAUSED', cpcBidMicros: 200 }))
      .rejects.toMatchObject({ code: 'unsupported_field', fields: ['cpc_bid_micros'] });
    const ok = setup({ status: 'PAUSED', cpcBidMicros: '200' }, 'adGroup');
    await expect(ok.svc.updateAdGroup('u', '123', AG, { status: 'PAUSED', cpcBidMicros: 200 })).resolves.toBe(true);
  });

  it('updateKeyword: status unchanged throws', async () => {
    const { svc } = setup({ status: 'ENABLED' }, 'adGroupCriterion');
    await expect(svc.updateKeyword('u', '123', KW, { status: 'PAUSED' }))
      .rejects.toBeInstanceOf(GoogleAdsReadBackError);
  });

  it('updateAd: missing resource on read-back is loud', async () => {
    const { svc } = setup(null, 'adGroupAd');
    await expect(svc.updateAd('u', '123', AD, { status: 'PAUSED' })).rejects.toBeInstanceOf(GoogleAdsReadBackError);
  });

  it('no-op update sends nothing and reads nothing', async () => {
    const { svc, mutate, search } = setup({}, 'adGroup');
    await expect(svc.updateAdGroup('u', '123', AG, {})).resolves.toBe(false);
    expect(mutate).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });
});

describe('read-back resource-name guard', () => {
  it('a quoted resource name never reaches GAQL and cannot pass a remove as "gone"', async () => {
    const { svc, search } = setup(null, 'adGroup');
    await expect(svc.removeAdGroup('u', '123', "customers/123/adGroups/7' OR ''='"))
      .rejects.toBeInstanceOf(GoogleAdsReadBackError);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('remove read-back (AC3)', () => {
  it.each([
    ['removeAdGroup', AG, 'adGroup'],
    ['removeKeyword', KW, 'adGroupCriterion'],
    ['removeAd', AD, 'adGroupAd'],
    ['removeBudget', BUDGET, 'campaignBudget'],
  ] as const)('%s: still ENABLED after remove throws', async (method, rn, key) => {
    const { svc } = setup({ status: 'ENABLED' }, key);
    await expect((svc as any)[method]('u', '123', rn)).rejects.toMatchObject({ code: 'unsupported_field', fields: ['status'] });
  });

  it.each([
    ['REMOVED', { status: 'REMOVED' }],
    ['not found', null],
  ])('removeAd resolves when resource reads back %s', async (_label, row) => {
    const { svc } = setup(row as any, 'adGroupAd');
    await expect(svc.removeAd('u', '123', AD)).resolves.toBeUndefined();
  });
});

describe('ENG-2398 residual: device bid modifiers + asset-group retag read-back', () => {
  const ASG = 'customers/123/assetGroups/9';
  function svcWith(searchImpl: (q: string) => any[], mutateResult: any = { results: [{}] }) {
    const svc = new GoogleAdsService();
    jest.spyOn(svc, 'getAccountCredentials').mockResolvedValue({ accessToken: 't', loginCustomerId: undefined } as any);
    const mutate = jest.spyOn(svc, 'mutate').mockResolvedValue(mutateResult);
    const search = jest.spyOn(svc, 'search').mockImplementation(async (_c: string, _t: string, q: string) => searchImpl(q));
    return { svc, mutate, search };
  }
  const campaignParams = { scope: 'CAMPAIGN', customerId: '123', campaignId: '5', adjustments: [{ device: 'MOBILE', bidModifier: 1.2 }] } as any;

  it('campaign device modifier matching read-back resolves', async () => {
    const { svc } = svcWith(() => [{ campaignCriterion: { bidModifier: 1.2 } }]);
    await expect(svc.setDeviceBidAdjustments('u', campaignParams)).resolves.toBeUndefined();
  });

  it('campaign device modifier unchanged throws unsupported_field', async () => {
    const { svc } = svcWith(() => [{ campaignCriterion: { bidModifier: 1 } }]);
    await expect(svc.setDeviceBidAdjustments('u', campaignParams))
      .rejects.toMatchObject({ code: 'unsupported_field', fields: ['bid_modifier'] });
  });

  it('-100% exclusion: omitted proto3 zero reads back as 0 and passes', async () => {
    const p = { ...campaignParams, adjustments: [{ device: 'TABLET', bidModifier: 0 }] };
    const { svc } = svcWith(() => [{ campaignCriterion: {} }]);
    await expect(svc.setDeviceBidAdjustments('u', p)).resolves.toBeUndefined();
  });

  it('ad-group create reads back the returned resourceName; missing row is loud', async () => {
    const p = { scope: 'AD_GROUP', customerId: '123', adGroupResourceName: AG, adjustments: [{ device: 'DESKTOP', bidModifier: 0.8 }] } as any;
    const created = 'customers/123/adGroupBidModifiers/7~30000';
    const ok = svcWith((q) => (q.includes(created) ? [{ adGroupBidModifier: { bidModifier: 0.8 } }] : []), { results: [{ resourceName: created }] });
    await expect(ok.svc.setDeviceBidAdjustments('u', p)).resolves.toBeUndefined();
    const gone = svcWith(() => [], { results: [{ resourceName: created }] });
    await expect(gone.svc.setDeviceBidAdjustments('u', p)).rejects.toBeInstanceOf(GoogleAdsReadBackError);
  });

  it('retagAssetGroupUtm: final_urls not written throws; written resolves success', async () => {
    const before = [{ assetGroup: { finalUrls: ['https://a.com/x'] }, campaign: {} }];
    let calls = 0;
    const bad = svcWith(() => (calls++ === 0 ? before : [{ assetGroup: { finalUrls: ['https://a.com/x'] } }]));
    await expect(bad.svc.retagAssetGroupUtm('u', '123', ASG)).rejects.toMatchObject({ code: 'unsupported_field', fields: ['final_urls'] });
    let n = 0; let written: string[] = [];
    const ok = svcWith(() => (n++ === 0 ? before : [{ assetGroup: { finalUrls: written } }]));
    ok.mutate.mockImplementation(async (_c: any, _t: any, _r: any, ops: any[]) => { written = ops[0].update.finalUrls; return { results: [{}] }; });
    await expect(ok.svc.retagAssetGroupUtm('u', '123', ASG)).resolves.toEqual({ success: true });
    expect(written[0]).toContain('utm_');
  });
});
