process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * ENG-2928 — Zoma Google Ads: keywords, negatives, responsive search ads, PMax assets and
 * asset groups, PMax brand on CAMPAIGN CREATE.
 *  - Every guarded write: PREVIEW + token, nothing sent until confirm; creates are PAUSED;
 *    read-back decides CONFIRMED / MISMATCH / UNCONFIRMED.
 *  - ASSET UPLOAD cannot spend: no preview token, but the write gate, URL rule and read-back
 *    still apply, and it is metered as a write.
 *  - Enabling a keyword / ad / asset group is ceiling-checked at its campaign's budget.
 *  - aw_ key scopes: a read-only key cannot reach any of these writes.
 */
jest.mock('../services/agentModeService', () => ({ agentModeService: {} }));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../emma/impl/adsCrmApis', () => ({
  handleCallGoogleAdsApi: jest.fn().mockResolvedValue({ success: true }),
  handleCallGoogleAdsReportingApi: jest.fn().mockResolvedValue({ success: true, results: [] }),
}));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));

import {
  assertGoogleToolkitCall, getGoogleToolkitManifest, isGoogleGuardedWrite, isGoogleToolkitWrite,
} from '../mcp/googleToolkitManifest';
import { executeGoogleToolkitWrite, mapGoogleReadRows, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
import { handleMetaToolkitCall, type MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';

const NOW = Date.parse('2026-11-10T00:00:00Z');
const CID = '1234567890';
const BUDGET = `customers/${CID}/campaignBudgets/55`;
const CAMPAIGN = `customers/${CID}/campaigns/77`;
const PMAX = `customers/${CID}/campaigns/88`;
const AD_GROUP = `customers/${CID}/adGroups/66`;
const KEYWORD = `customers/${CID}/adGroupCriteria/66~501`;
const NEG_KEYWORD = `customers/${CID}/adGroupCriteria/66~502`;
const AD = `customers/${CID}/adGroupAds/66~701`;
const ASSET_GROUP = `customers/${CID}/assetGroups/301`;
const LOGO = `customers/${CID}/assets/9001`;
const SQUARE = `customers/${CID}/assets/9002`;
const LANDSCAPE = `customers/${CID}/assets/9003`;

type Kw = { resourceName: string; text: string; matchType: string; status?: string; negative: boolean; adGroup?: string };

function writeDeps(over: Partial<GoogleToolkitWriteDeps> = {}) {
  const state: Record<string, any> = {
    [BUDGET]: { resourceName: BUDGET, name: 'Daily', amountMicros: 20_000_000, explicitlyShared: false, referenceCount: 0 },
    [CAMPAIGN]: { resourceName: CAMPAIGN, name: 'Search', status: 'ENABLED', budget: BUDGET, channelType: 'SEARCH' },
    [PMAX]: { resourceName: PMAX, name: 'PMax', status: 'PAUSED', budget: BUDGET, channelType: 'PERFORMANCE_MAX' },
    [AD_GROUP]: { resourceName: AD_GROUP, name: 'Shoes', status: 'ENABLED', campaign: CAMPAIGN },
    [KEYWORD]: { resourceName: KEYWORD, text: 'red shoes', matchType: 'EXACT', status: 'PAUSED', negative: false, adGroup: AD_GROUP },
    [NEG_KEYWORD]: { resourceName: NEG_KEYWORD, text: 'free', matchType: 'BROAD', status: 'ENABLED', negative: true, adGroup: AD_GROUP },
    [AD]: { resourceName: AD, status: 'PAUSED', type: 'RESPONSIVE_SEARCH_AD', adGroup: AD_GROUP },
    [ASSET_GROUP]: { resourceName: ASSET_GROUP, name: 'AG', status: 'PAUSED', campaign: PMAX },
    [LOGO]: { resourceName: LOGO, type: 'IMAGE', name: 'logo' },
  };
  const adGroupKeywords: Kw[] = [state[KEYWORD], state[NEG_KEYWORD]];
  const campaignNegatives: Kw[] = [];
  const brands: Record<string, { businessName?: string; logoAssets: string[] }> = { [PMAX]: { businessName: 'Acme', logoAssets: [LOGO] } };
  let seq = 1000;
  const deps: GoogleToolkitWriteDeps & { state: Record<string, any>; adGroupKeywords: Kw[]; campaignNegatives: Kw[]; brands: typeof brands } = {
    state, adGroupKeywords, campaignNegatives, brands,
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u: string, _c: string, kind: string, rn: string) => {
      if (kind === 'ad_group_keywords') return rn === AD_GROUP ? adGroupKeywords.map((k) => ({ ...k })) : [];
      if (kind === 'campaign_negative_keywords') return campaignNegatives.map((k) => ({ ...k }));
      if (kind === 'campaign_brand') return brands[rn] ? { ...brands[rn], logoAssets: [...brands[rn].logoAssets] } : { logoAssets: [] };
      return state[rn] ? { ...state[rn] } : null;
    }),
    dispatch: jest.fn(async (_u: string, args: any) => {
      // Simulates Google applying the change.
      const id = seq++;
      if (args.entity_type === 'KEYWORD' && args.action === 'ADD') {
        for (const k of args.keywords) adGroupKeywords.push({ resourceName: `customers/${CID}/adGroupCriteria/66~${id}`, text: k.text, matchType: k.matchType, status: args.status, negative: false, adGroup: AD_GROUP });
        return { success: true, message: 'Added' };
      }
      if (args.entity_type === 'KEYWORD' && args.action === 'ADD_NEGATIVE') {
        const list = args.campaign_resource_name ? campaignNegatives : adGroupKeywords;
        for (const k of args.keywords) list.push({ resourceName: `customers/${CID}/x/${id}`, text: k.text, matchType: k.matchType, negative: true });
        return { success: true, message: 'Added' };
      }
      if (args.entity_type === 'KEYWORD' && args.action === 'UPDATE') state[args.criterion_resource_name].status = args.status;
      if (args.entity_type === 'KEYWORD' && args.action === 'REMOVE') delete state[args.criterion_resource_name];
      if (args.entity_type === 'AD' && args.action === 'UPDATE') state[args.ad_resource_name].status = args.status;
      if (args.entity_type === 'ASSET_GROUP' && args.action === 'UPDATE') state[args.asset_group_resource_name].status = args.status;
      if (args.entity_type === 'AD' && args.action === 'CREATE') {
        const rn = `customers/${CID}/adGroupAds/66~${id}`;
        state[rn] = { resourceName: rn, status: args.status, type: args.type, adGroup: args.ad_group_resource_name };
        return { success: true, adResourceName: rn };
      }
      if (args.entity_type === 'ASSET_GROUP' && args.action === 'CREATE') {
        const rn = `customers/${CID}/assetGroups/${id}`;
        state[rn] = { resourceName: rn, name: args.name, status: 'PAUSED', campaign: args.campaign_resource_name };
        return { success: true, assetGroupResourceName: rn };
      }
      if (args.entity_type === 'CAMPAIGN' && args.action === 'CREATE') {
        const rn = `customers/${CID}/campaigns/${id}`;
        state[rn] = { resourceName: rn, name: args.name, status: args.status, budget: args.budget_resource_name, channelType: args.type };
        if (args.brand_business_name) brands[rn] = { businessName: args.brand_business_name, logoAssets: [args.brand_logo_asset_resource_name] };
        return { success: true, campaignResourceName: rn };
      }
      if (args.entity_type === 'ASSET' && args.action === 'UPLOAD') {
        const rn = `customers/${CID}/assets/${id}`;
        state[rn] = { resourceName: rn, name: args.name, type: args.asset_type === 'TEXT' ? 'TEXT' : args.asset_type === 'VIDEO' ? 'YOUTUBE_VIDEO' : 'IMAGE', ...(args.asset_type === 'TEXT' ? { text: args.data } : {}) };
        return { success: true, assetResourceName: rn };
      }
      return { success: true, message: 'ok' };
    }),
    resolveImageUrl: jest.fn(async (_u: string, raw: unknown) => `${String(raw)}?signed=1`),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
    ...over,
  };
  return deps;
}

/** Preview, then confirm with that preview's token. */
async function approve(d: GoogleToolkitWriteDeps, args: any) {
  const preview: any = await executeGoogleToolkitWrite('u1', args, 'USD', d);
  expect(preview.status).toBe('PREVIEW');
  expect(d.dispatch).not.toHaveBeenCalled();
  const result: any = await executeGoogleToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, 'USD', d);
  return { preview, result };
}

const base = { customer_id: CID };
const headlines = (n: number, len = 20) => Array.from({ length: n }, (_, i) => `H${i}`.padEnd(len, 'x'));
const descriptions = (n: number, len = 50) => Array.from({ length: n }, (_, i) => `D${i}`.padEnd(len, 'y'));

describe('ENG-2928 keywords', () => {
  const add = { ...base, entity_type: 'KEYWORD', action: 'ADD', ad_group_resource_name: AD_GROUP, keywords: [{ text: 'blue shoes', matchType: 'PHRASE' }, { text: 'Running Shoes', matchType: 'EXACT' }] };

  it('ADD: preview sends nothing, confirm dispatches once PAUSED, read-back CONFIRMED with the new ids', async () => {
    const d = writeDeps();
    const { preview, result } = await approve(d, add);
    expect(preview.preview).toContain('Add 2 keyword(s) to ad group "Shoes" (ad group is ENABLED): PHRASE "blue shoes", EXACT "Running Shoes".');
    expect(preview.preview).toContain('always created paused');
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledWith('u1', { ...add, status: 'PAUSED' });
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: AD_GROUP });
    expect(result.ids).toHaveLength(2);
  });

  it('ADD: ENABLED on create, bad match types, oversize text and duplicates are refused before readiness', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...add, status: 'ENABLED' }, 'USD', d)).rejects.toThrow(/always created PAUSED/);
    await expect(executeGoogleToolkitWrite('u1', { ...add, keywords: [{ text: 'x', matchType: 'BROAD_MATCH' }] }, 'USD', d)).rejects.toThrow(/matchType must be/);
    await expect(executeGoogleToolkitWrite('u1', { ...add, keywords: [{ text: 'a'.repeat(81), matchType: 'EXACT' }] }, 'USD', d)).rejects.toThrow(/at most 80 characters/);
    await expect(executeGoogleToolkitWrite('u1', { ...add, keywords: [{ text: 'a b c d e f g h i j k', matchType: 'EXACT' }] }, 'USD', d)).rejects.toThrow(/10 words/);
    await expect(executeGoogleToolkitWrite('u1', { ...add, keywords: [{ text: 'Shoe', matchType: 'EXACT' }, { text: ' shoe ', matchType: 'EXACT' }] }, 'USD', d)).rejects.toThrow(/Duplicate keyword/);
    await expect(executeGoogleToolkitWrite('u1', { ...add, keywords: [] }, 'USD', d)).rejects.toThrow(/1-100/);
    await expect(executeGoogleToolkitWrite('u1', { ...add, keywords: [{ text: 'x', matchType: 'EXACT', cpc_bid_micros: 1 }] }, 'USD', d)).rejects.toThrow(/\{text, matchType\} only/);
    await expect(executeGoogleToolkitWrite('u1', { ...add, ad_group_resource_name: 'customers/999/adGroups/1' }, 'USD', d)).rejects.toThrow(MetaToolkitRefusal);
    expect(d.assertReady).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('ADD: a keyword already in the ad group is refused at preview (Google would reject the batch)', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...add, keywords: [{ text: 'Red  Shoes', matchType: 'EXACT' }] }, 'USD', d))
      .rejects.toThrow(/Already present: EXACT "Red {2}Shoes"/);
  });

  it('ADD: Google accepted but a keyword is missing on read-back → MISMATCH; read-back failure → UNCONFIRMED', async () => {
    const d = writeDeps({ dispatch: jest.fn().mockResolvedValue({ success: true }) });
    const { result } = await approve(d, add);
    expect(result).toMatchObject({ success: false, verification: 'MISMATCH' });
    // The read fails only after Google applied it (confirm re-reads the preview state first).
    let applied = false;
    const d2 = writeDeps({ dispatch: jest.fn(async () => { applied = true; return { success: true }; }) });
    const realRead = d2.read;
    d2.read = jest.fn(async (u: string, c: string, kind: any, rn: string) => {
      if (applied && kind === 'ad_group_keywords') throw new Error('network');
      return realRead(u, c, kind, rn);
    });
    const r = (await approve(d2, add)).result;
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('UPDATE status=ENABLED names the budget it spends at, and the spend ceiling applies via ad group → campaign', async () => {
    const update = { ...base, entity_type: 'KEYWORD', action: 'UPDATE', criterion_resource_name: KEYWORD, status: 'ENABLED' };
    const d = writeDeps();
    const { preview, result } = await approve(d, update);
    expect(preview.preview).toContain('Keyword EXACT "red shoes": PAUSED → ENABLED.');
    expect(preview.preview).toContain('Budget "Daily": 20.00 USD/day');
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ENABLED', id: KEYWORD });

    const capped = writeDeps({ spendCeilingPolicy: () => ({ maxDailyBudget: 10_000_000 }) });
    await expect(executeGoogleToolkitWrite('u1', update, 'USD', capped)).rejects.toThrow(/Enabling this keyword would start spend at its budget/);
    expect(capped.dispatch).not.toHaveBeenCalled();
  });

  it('UPDATE on a negative keyword is refused (negatives have no status)', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'KEYWORD', action: 'UPDATE', criterion_resource_name: NEG_KEYWORD, status: 'PAUSED' }, 'USD', d))
      .rejects.toThrow(/Use KEYWORD REMOVE/);
  });

  it('REMOVE: CONFIRMED when the criterion is gone; MISMATCH when it still reads ENABLED; UNCONFIRMED when the read fails', async () => {
    const remove = { ...base, entity_type: 'KEYWORD', action: 'REMOVE', criterion_resource_name: KEYWORD };
    const d = writeDeps();
    const { preview, result } = await approve(d, remove);
    expect(preview.preview).toContain('Remove keyword EXACT "red shoes" (currently PAUSED) from ad group');
    expect(preview.preview).toContain('permanent');
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: KEYWORD });

    const stuck = writeDeps({ dispatch: jest.fn().mockResolvedValue({ success: true }) });
    stuck.state[KEYWORD].status = 'ENABLED';
    expect((await approve(stuck, remove)).result).toMatchObject({ success: false, verification: 'MISMATCH' });

    let removed = false;
    const blind = writeDeps({ dispatch: jest.fn(async () => { removed = true; return { success: true }; }) });
    const realRead = blind.read;
    blind.read = jest.fn(async (u: string, c: string, kind: any, rn: string) => {
      if (removed) throw new Error('timeout');
      return realRead(u, c, kind, rn);
    });
    expect((await approve(blind, remove)).result).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
  });

  it('REMOVE of a negative keyword warns that it can increase spend (and does not say "Status: unchanged")', async () => {
    const d = writeDeps();
    const { preview } = await approve(d, { ...base, entity_type: 'KEYWORD', action: 'REMOVE', criterion_resource_name: NEG_KEYWORD });
    expect(preview.preview).toContain('Remove negative keyword');
    expect(preview.preview).toMatch(/can increase spend/);
    expect(preview.preview).not.toContain('Status: unchanged');
  });

  it('REMOVE of a keyword that does not exist is refused, nothing sent', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, entity_type: 'KEYWORD', action: 'REMOVE', criterion_resource_name: `customers/${CID}/adGroupCriteria/66~999` }, 'USD', d))
      .rejects.toThrow(/was not found/);
  });
});

describe('ENG-2928 negative keywords', () => {
  const negatives = [{ text: 'cheap', matchType: 'BROAD' }];

  it('campaign level: preview says it cannot increase spend; read-back finds it in the campaign negatives', async () => {
    const args = { ...base, entity_type: 'KEYWORD', action: 'ADD_NEGATIVE', campaign_resource_name: CAMPAIGN, keywords: negatives };
    const d = writeDeps();
    const { preview, result } = await approve(d, args);
    expect(preview.preview).toContain('Exclude 1 negative keyword(s) at campaign level on "Search": BROAD "cheap".');
    expect(preview.preview).toContain('cannot start or increase spend');
    expect(d.dispatch).toHaveBeenCalledWith('u1', args);
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: CAMPAIGN });
  });

  it('ad group level: a positive keyword with the same text is not a duplicate; an existing negative is', async () => {
    const args = { ...base, entity_type: 'KEYWORD', action: 'ADD_NEGATIVE', ad_group_resource_name: AD_GROUP, keywords: [{ text: 'red shoes', matchType: 'EXACT' }] };
    const d = writeDeps();
    expect((await approve(d, args)).result).toMatchObject({ success: true, verification: 'CONFIRMED', id: AD_GROUP });
    await expect(executeGoogleToolkitWrite('u1', { ...args, keywords: [{ text: 'free', matchType: 'BROAD' }] }, 'USD', writeDeps()))
      .rejects.toThrow(/Already present/);
  });

  it('exactly one level: both or neither is refused before readiness', async () => {
    const d = writeDeps();
    const args = { ...base, entity_type: 'KEYWORD', action: 'ADD_NEGATIVE', keywords: negatives };
    await expect(executeGoogleToolkitWrite('u1', args, 'USD', d)).rejects.toThrow(/exactly one of/);
    await expect(executeGoogleToolkitWrite('u1', { ...args, campaign_resource_name: CAMPAIGN, ad_group_resource_name: AD_GROUP }, 'USD', d)).rejects.toThrow(/exactly one of/);
    expect(d.assertReady).not.toHaveBeenCalled();
  });
});

describe('ENG-2928 responsive search ads', () => {
  const rsa = { ...base, entity_type: 'AD', action: 'CREATE', ad_group_resource_name: AD_GROUP, headlines: headlines(3), descriptions: descriptions(2), final_url: 'https://acme.example/shoes' };

  it('CREATE: preview lists the copy; dispatched once as a PAUSED RESPONSIVE_SEARCH_AD; read-back CONFIRMED', async () => {
    const d = writeDeps();
    const { preview, result } = await approve(d, rsa);
    expect(preview.preview).toContain('Create a responsive search ad in ad group "Shoes" (ad group is ENABLED) → https://acme.example/shoes');
    expect(preview.preview).toContain('Headlines (3):');
    expect(preview.preview).toContain('Descriptions (2):');
    expect(d.dispatch).toHaveBeenCalledWith('u1', { ...rsa, type: 'RESPONSIVE_SEARCH_AD', status: 'PAUSED' });
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
    expect(result.id).toMatch(new RegExp(`^customers/${CID}/adGroupAds/66~\\d+$`));
  });

  it.each([
    ['2 headlines', { headlines: headlines(2) }, /headlines must be 3-15/],
    ['16 headlines', { headlines: headlines(16) }, /headlines must be 3-15/],
    ['a 31-char headline', { headlines: [...headlines(2), 'x'.repeat(31)] }, /at most 30 characters each/],
    ['1 description', { descriptions: descriptions(1) }, /descriptions must be 2-4/],
    ['5 descriptions', { descriptions: descriptions(5) }, /descriptions must be 2-4/],
    ['a 91-char description', { descriptions: [descriptions(1)[0], 'y'.repeat(91)] }, /at most 90 characters each/],
    ['duplicate headlines', { headlines: ['Same', 'same', 'Other'] }, /duplicate/],
    ['an http final_url', { final_url: 'http://acme.example' }, /final_url must be an https URL/],
    ['a display ad', { type: 'RESPONSIVE_DISPLAY_AD' }, /RESPONSIVE_SEARCH_AD ads only/],
    ['status ENABLED', { status: 'ENABLED' }, /always created PAUSED/],
  ])('CREATE refuses %s before readiness or Google', async (_l, over, msg) => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...rsa, ...over }, 'USD', d)).rejects.toThrow(msg);
    expect(d.assertReady).not.toHaveBeenCalled();
    expect(d.read).not.toHaveBeenCalled();
  });

  it('CREATE limits are characters, not bytes: a 30-character non-ASCII headline is accepted', async () => {
    const d = writeDeps();
    const r: any = await executeGoogleToolkitWrite('u1', { ...rsa, headlines: ['é'.repeat(30), 'b', 'c'] }, 'USD', d);
    expect(r.status).toBe('PREVIEW');
  });

  it('CREATE: Google says created but the ad reads back ENABLED → MISMATCH (never success)', async () => {
    const d = writeDeps();
    (d.dispatch as jest.Mock).mockImplementationOnce(async () => {
      const rn = `customers/${CID}/adGroupAds/66~42`;
      d.state[rn] = { resourceName: rn, status: 'ENABLED', type: 'RESPONSIVE_SEARCH_AD' };
      return { success: true, adResourceName: rn };
    });
    expect((await approve(d, rsa)).result).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('a creative-gate block from the Emma handler is FAILED, not a verdict (nothing created, not metered)', async () => {
    const d = writeDeps({ dispatch: jest.fn().mockResolvedValue({ success: false, blocked: true, reason: 'tracking_preflight_unresolved', error: 'blocked' }) });
    const { result } = await approve(d, rsa);
    expect(result).toMatchObject({ status: 'FAILED', blocked: true });
    expect(result.verification).toBeUndefined();
  });

  it('UPDATE status=ENABLED is ceiling-checked at the campaign budget', async () => {
    const enable = { ...base, entity_type: 'AD', action: 'UPDATE', ad_resource_name: AD, status: 'ENABLED' };
    const d = writeDeps();
    expect((await approve(d, enable)).result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ENABLED' });
    const capped = writeDeps({ spendCeilingPolicy: () => ({ maxDailyBudget: 1_000_000 }) });
    await expect(executeGoogleToolkitWrite('u1', enable, 'USD', capped)).rejects.toThrow(/Enabling this ad would start spend/);
  });
});

describe('ENG-2928 assets (non-spending: no preview token)', () => {
  it('IMAGE from a URL: resolved through the staged/public URL rule, dispatched once, read back CONFIRMED', async () => {
    const d = writeDeps();
    const args = { ...base, entity_type: 'ASSET', action: 'UPLOAD', asset_type: 'IMAGE', name: 'Hero', data: 'https://cdn.example/hero.png' };
    const r: any = await executeGoogleToolkitWrite('u1', args, 'USD', d);
    expect(d.resolveImageUrl).toHaveBeenCalledWith('u1', 'https://cdn.example/hero.png', 'data');
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.dispatch).toHaveBeenCalledWith('u1', { ...args, data: 'https://cdn.example/hero.png?signed=1' });
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', asset_type: 'IMAGE' });
    expect(r.preview_token).toBeUndefined();
  });

  it('TEXT: the read-back text must match; a different text is MISMATCH', async () => {
    const d = writeDeps();
    const args = { ...base, entity_type: 'ASSET', action: 'UPLOAD', asset_type: 'TEXT', data: 'Acme Shoes' };
    const ok: any = await executeGoogleToolkitWrite('u1', args, 'USD', d);
    expect(ok).toMatchObject({ success: true, verification: 'CONFIRMED', asset_type: 'TEXT' });
    expect(d.resolveImageUrl).not.toHaveBeenCalled();
    expect(d.dispatch).toHaveBeenCalledWith('u1', { ...args, name: 'Acme Shoes' });

    const wrong = writeDeps({
      dispatch: jest.fn(async () => {
        wrong.state[`customers/${CID}/assets/5`] = { resourceName: `customers/${CID}/assets/5`, type: 'TEXT', text: 'Other' };
        return { success: true, assetResourceName: `customers/${CID}/assets/5` };
      }),
    });
    expect(await executeGoogleToolkitWrite('u1', args, 'USD', wrong)).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('a timeout is UNCONFIRMED (it may exist); a refused URL sends nothing; the write gate still applies', async () => {
    const args = { ...base, entity_type: 'ASSET', action: 'UPLOAD', asset_type: 'LOGO', name: 'Logo', data: 'https://cdn.example/logo.png' };
    const slow = writeDeps({ dispatch: jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded')) });
    expect(await executeGoogleToolkitWrite('u1', args, 'USD', slow)).toMatchObject({ success: false, verification: 'UNCONFIRMED' });

    const privateUrl = writeDeps({ resolveImageUrl: jest.fn().mockRejectedValue(new MetaToolkitRefusal('That URL does not point to a public address.')) });
    await expect(executeGoogleToolkitWrite('u1', args, 'USD', privateUrl)).rejects.toThrow(/public address/);
    expect(privateUrl.dispatch).not.toHaveBeenCalled();

    const { ZomaNotReadyError } = jest.requireActual('../mcp/zomaOnboarding');
    const notReady = writeDeps({ assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('No payment method on file')) });
    await expect(executeGoogleToolkitWrite('u1', args, 'USD', notReady)).rejects.toThrow(/No payment method/);
    expect(notReady.dispatch).not.toHaveBeenCalled();
  });

  it('shape: unknown asset types, oversize text and non-YouTube video ids are refused', async () => {
    const d = writeDeps();
    const up = { ...base, entity_type: 'ASSET', action: 'UPLOAD' };
    await expect(executeGoogleToolkitWrite('u1', { ...up, asset_type: 'HTML5', name: 'x', data: 'x' }, 'USD', d)).rejects.toThrow(/asset_type must be/);
    await expect(executeGoogleToolkitWrite('u1', { ...up, asset_type: 'TEXT', data: 'x'.repeat(91) }, 'USD', d)).rejects.toThrow(/at most 90/);
    await expect(executeGoogleToolkitWrite('u1', { ...up, asset_type: 'VIDEO', name: 'v', data: 'https://youtu.be/x' }, 'USD', d)).rejects.toThrow(/YouTube video id/);
    await expect(executeGoogleToolkitWrite('u1', { ...up, asset_type: 'IMAGE', data: 'https://cdn.example/a.png' }, 'USD', d)).rejects.toThrow(/requires name/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});

describe('ENG-2928 Performance Max end to end', () => {
  const pmaxCreate = {
    ...base, entity_type: 'CAMPAIGN', action: 'CREATE', name: 'PMax launch', type: 'PERFORMANCE_MAX', budget_resource_name: BUDGET,
    bidding_strategy: 'MAXIMIZE_CONVERSIONS', brand_business_name: 'Acme', brand_logo_asset_resource_name: LOGO,
  };

  it('CAMPAIGN CREATE PERFORMANCE_MAX carries the brand to the Emma handler and verifies it on read-back', async () => {
    const d = writeDeps();
    const { preview, result } = await approve(d, pmaxCreate);
    expect(preview.preview).toContain(`Brand: business name "Acme", logo ${LOGO}`);
    expect(d.dispatch).toHaveBeenCalledWith('u1', expect.objectContaining({ brand_business_name: 'Acme', brand_logo_asset_resource_name: LOGO, status: 'PAUSED' }));
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED', brand: { business_name: 'Acme', logo_assets: [LOGO] } });
  });

  it('CAMPAIGN CREATE PERFORMANCE_MAX without its brand on read-back is MISMATCH', async () => {
    const d = writeDeps();
    (d.dispatch as jest.Mock).mockImplementationOnce(async (_u: string, args: any) => {
      const rn = `customers/${CID}/campaigns/4242`;
      d.state[rn] = { resourceName: rn, status: 'PAUSED', budget: args.budget_resource_name };
      return { success: true, campaignResourceName: rn };
    });
    expect((await approve(d, pmaxCreate)).result).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('brand fields: required for PMax, refused for other types, logo must be an image asset', async () => {
    const d = writeDeps();
    const { brand_business_name: _n, ...noName } = pmaxCreate;
    await expect(executeGoogleToolkitWrite('u1', noName, 'USD', d)).rejects.toThrow(/requires brand_business_name/);
    await expect(executeGoogleToolkitWrite('u1', { ...pmaxCreate, brand_business_name: 'x'.repeat(26) }, 'USD', d)).rejects.toThrow(/at most 25/);
    await expect(executeGoogleToolkitWrite('u1', { ...pmaxCreate, brand_logo_asset_resource_name: 'https://x/logo.png' }, 'USD', d)).rejects.toThrow(/brand_logo_asset_resource_name/);
    await expect(executeGoogleToolkitWrite('u1', { ...pmaxCreate, type: 'SEARCH' }, 'USD', d)).rejects.toThrow(/PERFORMANCE_MAX campaigns only/);
    d.state[LOGO] = { resourceName: LOGO, type: 'TEXT' };
    await expect(executeGoogleToolkitWrite('u1', pmaxCreate, 'USD', d)).rejects.toThrow(/not an image/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  const assetGroup = {
    ...base, entity_type: 'ASSET_GROUP', action: 'CREATE', name: 'Spring', campaign_resource_name: PMAX, final_url: 'https://acme.example',
    headlines: headlines(3), long_headlines: ['A long headline about shoes'], descriptions: [...descriptions(1, 40), ...descriptions(1, 80)],
    square_image_assets: [SQUARE], landscape_image_assets: [LANDSCAPE],
  };

  it('ASSET_GROUP CREATE: links the assets, created PAUSED, read back in the right campaign', async () => {
    const d = writeDeps();
    const { preview, result } = await approve(d, assetGroup);
    expect(preview.preview).toContain('Create asset group "Spring" in Performance Max campaign "PMax" (campaign is PAUSED) → https://acme.example');
    expect(preview.preview).toContain('Brand (campaign level): business name "Acme", 1 logo(s).');
    expect(preview.preview).toContain('Images: 1 square, 1 landscape.');
    expect(d.dispatch).toHaveBeenCalledWith('u1', { ...assetGroup, logo_assets: [] });
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'PAUSED' });
  });

  it('ASSET_GROUP CREATE refuses a non-PMax campaign and a campaign with no brand, nothing sent', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...assetGroup, campaign_resource_name: CAMPAIGN }, 'USD', d)).rejects.toThrow(/is SEARCH PERFORMANCE_MAX|asset groups belong to Performance Max/);
    d.brands[PMAX] = { logoAssets: [LOGO] };
    await expect(executeGoogleToolkitWrite('u1', assetGroup, 'USD', d)).rejects.toThrow(/has no business name linked/);
    d.brands[PMAX] = { businessName: 'Acme', logoAssets: [] };
    await expect(executeGoogleToolkitWrite('u1', assetGroup, 'USD', d)).rejects.toThrow(/has no logo linked/);
    // An asset-group logo satisfies the logo requirement.
    expect((await executeGoogleToolkitWrite('u1', { ...assetGroup, logo_assets: [LOGO] }, 'USD', d) as any).status).toBe('PREVIEW');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['no long headline', { long_headlines: [] }, /long_headlines must be 1-5/],
    ['a 91-char long headline', { long_headlines: ['z'.repeat(91)] }, /at most 90/],
    ['no description of 60 chars or fewer', { descriptions: descriptions(2, 70) }, /60 characters or fewer/],
    ['no square image', { square_image_assets: [] }, /square_image_assets must be 1-20/],
    ['an image that is not an asset in this customer', { landscape_image_assets: ['customers/1/assets/2'] }, /landscape_image_assets must be/],
    ['status ENABLED', { status: 'ENABLED' }, /always created PAUSED/],
  ])('ASSET_GROUP CREATE refuses %s before readiness', async (_l, over, msg) => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...assetGroup, ...over }, 'USD', d)).rejects.toThrow(msg);
    expect(d.assertReady).not.toHaveBeenCalled();
  });

  it('ASSET_GROUP UPDATE status=ENABLED: CONFIRMED by read-back; ceiling-checked at the PMax budget', async () => {
    const enable = { ...base, entity_type: 'ASSET_GROUP', action: 'UPDATE', asset_group_resource_name: ASSET_GROUP, status: 'ENABLED' };
    const d = writeDeps();
    const { preview, result } = await approve(d, enable);
    expect(preview.preview).toContain('Asset group "AG": PAUSED → ENABLED.');
    expect(preview.preview).toContain('Its campaign "PMax" is PAUSED, so this alone does not start delivery.');
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', status: 'ENABLED' });
    const capped = writeDeps({ spendCeilingPolicy: () => ({ maxDailyBudget: 1_000_000 }) });
    await expect(executeGoogleToolkitWrite('u1', enable, 'USD', capped)).rejects.toThrow(/Enabling this asset group would start spend/);
  });
});

describe('ENG-2928 read mapping', () => {
  it('campaign brand aggregates BUSINESS_NAME text and LOGO assets', () => {
    expect(mapGoogleReadRows('campaign_brand', [
      { campaignAsset: { fieldType: 'BUSINESS_NAME', asset: 'customers/1/assets/1' }, asset: { textAsset: { text: 'Acme' } } },
      { campaignAsset: { fieldType: 'LOGO', asset: 'customers/1/assets/2' }, asset: {} },
    ])).toEqual({ businessName: 'Acme', logoAssets: ['customers/1/assets/2'] });
  });

  it('keyword lists map ad group and campaign criteria', () => {
    expect(mapGoogleReadRows('ad_group_keywords', [{ adGroupCriterion: { resourceName: 'r', keyword: { text: 't', matchType: 'EXACT' }, status: 'PAUSED', negative: false } }]))
      .toEqual([expect.objectContaining({ resourceName: 'r', text: 't', matchType: 'EXACT', status: 'PAUSED', negative: false })]);
    expect(mapGoogleReadRows('campaign_negative_keywords', [{ campaignCriterion: { resourceName: 'c', keyword: { text: 'n', matchType: 'BROAD' }, negative: true } }]))
      .toEqual([expect.objectContaining({ resourceName: 'c', negative: true })]);
  });
});

describe('ENG-2928 surface, scopes and metering', () => {
  it('the new writes are in the surface; other writes stay refused', () => {
    for (const [entity, action] of [['KEYWORD', 'ADD'], ['KEYWORD', 'UPDATE'], ['KEYWORD', 'REMOVE'], ['KEYWORD', 'ADD_NEGATIVE'], ['AD', 'CREATE'], ['AD', 'UPDATE'], ['ASSET_GROUP', 'CREATE'], ['ASSET_GROUP', 'UPDATE']]) {
      expect(isGoogleGuardedWrite('call_google_ads_api', { entity_type: entity, action })).toBe(true);
    }
    expect(isGoogleGuardedWrite('call_google_ads_api', { entity_type: 'ASSET', action: 'UPLOAD' })).toBe(false);
    expect(isGoogleToolkitWrite('call_google_ads_api', { entity_type: 'ASSET', action: 'UPLOAD' })).toBe(true);
    for (const [entity, action] of [['AD', 'REMOVE'], ['CAMPAIGN_ASSET', 'ATTACH'], ['ASSET_GROUP', 'RETAG_UTM'], ['AD', 'RETAG_UTM'], ['CAMPAIGN', 'REMOVE']]) {
      expect(() => assertGoogleToolkitCall('call_google_ads_api', { entity_type: entity, action })).toThrow(MetaToolkitRefusal);
    }
  });

  it('the advertised schema lists the new entities, actions and inputs (still no micros or override inputs)', () => {
    const api = getGoogleToolkitManifest()[0];
    const props = api.inputSchema.properties;
    expect(props.entity_type.enum).toEqual(expect.arrayContaining(['KEYWORD', 'AD', 'ASSET', 'ASSET_GROUP']));
    expect(props.action.enum).toEqual(expect.arrayContaining(['ADD', 'ADD_NEGATIVE', 'REMOVE', 'UPLOAD']));
    for (const k of ['keywords', 'criterion_resource_name', 'headlines', 'descriptions', 'final_url', 'long_headlines', 'square_image_assets', 'landscape_image_assets', 'asset_type', 'data', 'brand_business_name', 'brand_logo_asset_resource_name', 'asset_group_resource_name']) {
      expect(props[k]).toBeDefined();
    }
    for (const gone of ['client_id', 'override_tracking_check', 'tracking_override_token', 'amount_micros', 'cpc_bid_micros']) expect(props[gone]).toBeUndefined();
    expect(api.description).toContain('Performance Max end to end');
  });

  function gatewayDeps(scopes: string[] | undefined) {
    return {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'u1', keyId: 'k1', ...(scopes ? { scopes } : {}) }),
      validateOAuthToken: jest.fn().mockResolvedValue(null),
      listAccounts: jest.fn().mockResolvedValue([{
        platform: 'google_ads', account_id: CID, account_name: 'Acme',
        config: { account_type: 'google_ads', customer_id: CID, login_customer_id: '999', currency: 'USD', access_token: 't', refresh_token: 'r' },
      }]),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(true),
      recordWrite: jest.fn().mockResolvedValue(true),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
    } as unknown as MetaToolkitGatewayDeps & Record<string, jest.Mock>;
  }

  const prev = process.env.ZOMA_GOOGLE_ENABLED;
  beforeEach(() => { process.env.ZOMA_GOOGLE_ENABLED = 'true'; });
  afterAll(() => {
    if (prev === undefined) delete process.env.ZOMA_GOOGLE_ENABLED;
    else process.env.ZOMA_GOOGLE_ENABLED = prev;
  });

  it.each([
    ['ASSET UPLOAD', { entity_type: 'ASSET', action: 'UPLOAD', asset_type: 'TEXT', data: 'Acme' }],
    ['KEYWORD ADD', { entity_type: 'KEYWORD', action: 'ADD', ad_group_resource_name: AD_GROUP, keywords: [{ text: 'a', matchType: 'EXACT' }] }],
    ['ASSET_GROUP UPDATE', { entity_type: 'ASSET_GROUP', action: 'UPDATE', asset_group_resource_name: ASSET_GROUP, status: 'ENABLED' }],
  ])('a read-only aw_ key cannot run %s (403 before accounts, Google or metering)', async (_l, args) => {
    const deps = gatewayDeps(['tools:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: 'call_google_ads_api', args: { customer_id: CID, ...args } }, deps))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('tools:execute') });
    expect(deps.listAccounts).not.toHaveBeenCalled();
    expect(deps.recordWrite).not.toHaveBeenCalled();
    expect(deps.recordUsage).not.toHaveBeenCalled();
  });
});

describe('ENG-2928 double-width text weighting', () => {
  it('counts CJK characters as two toward the 30-char headline limit', () => {
    const { validateGoogleWriteShape } = require('../mcp/googleToolkitWrites');
    const args = {
      customer_id: '1234567890', entity_type: 'AD', action: 'CREATE',
      ad_group_resource_name: 'customers/1234567890/adGroups/1', type: 'RESPONSIVE_SEARCH_AD',
      headlines: ['中'.repeat(16), 'Two', 'Three'], descriptions: ['Desc one here', 'Desc two here'],
      final_url: 'https://example.com', status: 'PAUSED',
    };
    expect(() => validateGoogleWriteShape(args, 'USD')).toThrow();
    expect(() => validateGoogleWriteShape({ ...args, headlines: ['中'.repeat(15), 'Two', 'Three'] }, 'USD')).not.toThrow();
  });
});
