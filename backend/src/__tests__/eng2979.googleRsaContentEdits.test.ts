/**
 * ENG-2979 — Google toolkit responsive search ad content edits (headlines / descriptions /
 * final_url) through the guarded preview gateway, plus the GoogleAdsService AdService mutate.
 * All Google calls are mocked.
 */
import { executeGoogleToolkitWrite, mapGoogleReadRow, type GoogleToolkitWriteDeps } from '../mcp/googleToolkitWrites';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { GoogleAdsService, GoogleAdsReadBackError } from '../services/googleAdsService';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const CID = '1234567890';
const AD = `customers/${CID}/adGroupAds/66~901`;
const DISPLAY_AD = `customers/${CID}/adGroupAds/66~902`;
const FOREIGN_AD = 'customers/9999999999/adGroupAds/66~901';
const H = ['Fast Shoes', 'Free Returns', 'Shop Today'];
const D = ['Comfortable running shoes for every day.', 'Free shipping on all orders.'];

function writeDeps(apply: (args: any, state: Record<string, any>) => void = defaultApply) {
  const state: Record<string, any> = {
    [AD]: { resourceName: AD, status: 'ENABLED', type: 'RESPONSIVE_SEARCH_AD', adGroup: `customers/${CID}/adGroups/66`, finalUrls: ['https://old.example.com'], headlines: ['A', 'B', 'C'], descriptions: ['Old one.', 'Old two.'] },
    [DISPLAY_AD]: { resourceName: DISPLAY_AD, status: 'ENABLED', type: 'RESPONSIVE_DISPLAY_AD', finalUrls: ['https://old.example.com'] },
  };
  const deps: any = {
    state,
    assertReady: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(async (_u: string, _c: string, _k: string, rn: string) => (state[rn] ? JSON.parse(JSON.stringify(state[rn])) : null)),
    dispatch: jest.fn(async (_u: string, args: any) => { apply(args, state); return { success: true, message: 'ok' }; }),
    resolveImageUrl: jest.fn(),
    spendCeilingPolicy: () => null,
    secret: () => 'test-secret',
    now: () => NOW,
    consumedTokens: new Map(),
  };
  return deps as GoogleToolkitWriteDeps & { state: Record<string, any> };
}

function defaultApply(args: any, state: Record<string, any>) {
  const ad = state[args.ad_resource_name];
  if (args.headlines) ad.headlines = args.headlines;
  if (args.descriptions) ad.descriptions = args.descriptions;
  if (args.final_url) ad.finalUrls = [args.final_url];
  if (args.status) ad.status = args.status;
}

const base = { customer_id: CID, entity_type: 'AD', action: 'UPDATE' };

async function approve(d: GoogleToolkitWriteDeps, args: any) {
  const preview: any = await executeGoogleToolkitWrite('u1', args, 'USD', d);
  expect(preview.status).toBe('PREVIEW');
  expect(d.dispatch).not.toHaveBeenCalled();
  const result: any = await executeGoogleToolkitWrite('u1', { ...args, confirm: true, preview_token: preview.preview_token }, 'USD', d);
  return { preview, result };
}

describe('ENG-2979 AD UPDATE responsive search ad content', () => {
  it('AC1/AC4: preview shows current vs new and sends nothing; confirm dispatches only changed fields and read-back CONFIRMS', async () => {
    const d = writeDeps();
    const args = { ...base, ad_resource_name: AD, headlines: H, final_url: 'https://new.example.com/shoes' };
    const { preview, result } = await approve(d, args);
    expect(preview.preview).toContain('Headlines: "A" | "B" | "C" → "Fast Shoes" | "Free Returns" | "Shop Today".');
    expect(preview.preview).toContain('Final URL: https://old.example.com → https://new.example.com/shoes.');
    expect(preview.preview).not.toContain('Descriptions:');
    expect(preview.preview).toContain('Status: unchanged.');
    expect(preview.preview_token).toEqual(expect.any(String));
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect((d.dispatch as jest.Mock).mock.calls[0][1]).toEqual({ ...base, ad_resource_name: AD, headlines: H, final_url: 'https://new.example.com/shoes' });
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED', id: AD });
  });

  it('AC1: the preview token is single-use', async () => {
    const d = writeDeps();
    const args = { ...base, ad_resource_name: AD, descriptions: D };
    const preview: any = await executeGoogleToolkitWrite('u1', args, 'USD', d);
    const confirm = { ...args, confirm: true, preview_token: preview.preview_token };
    await executeGoogleToolkitWrite('u1', confirm, 'USD', d);
    // State changed, so a replay no longer matches the preview: nothing is sent again.
    const replay: any = await executeGoogleToolkitWrite('u1', confirm, 'USD', d).catch((e) => e);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(replay instanceof MetaToolkitRefusal || replay.status === 'PREVIEW_MISMATCH').toBe(true);
  });

  it('AC4: accepted but not read back as sent → MISMATCH; unreadable → UNCONFIRMED; never success', async () => {
    const mismatch = writeDeps(() => undefined);
    const r1 = (await approve(mismatch, { ...base, ad_resource_name: AD, headlines: H })).result;
    expect(r1).toMatchObject({ success: false, verification: 'MISMATCH' });

    const gone = writeDeps((_a, s) => { delete s[AD].headlines; });
    const r2 = (await approve(gone, { ...base, ad_resource_name: AD, headlines: H })).result;
    expect(r2).toMatchObject({ success: false, verification: 'UNCONFIRMED' });
    expect(r2.message).toMatch(/^UNCONFIRMED/);
  });

  it('AC2: status and content cannot be combined', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, ad_resource_name: AD, status: 'PAUSED', headlines: H }, 'USD', d))
      .rejects.toThrow(/status must be sent alone/);
    await expect(executeGoogleToolkitWrite('u1', { ...base, ad_resource_name: AD }, 'USD', d))
      .rejects.toThrow(/AD UPDATE requires status/);
    expect(d.read).not.toHaveBeenCalled();
  });

  it('AC3: RSA limits incl. double-width weighting; non-https final_url refused', async () => {
    const d = writeDeps();
    const call = (extra: any) => executeGoogleToolkitWrite('u1', { ...base, ad_resource_name: AD, ...extra }, 'USD', d);
    await expect(call({ headlines: ['One', 'Two'] })).rejects.toThrow(/headlines must be 3-15/);
    await expect(call({ headlines: ['One', 'Two', '靴'.repeat(16)] })).rejects.toThrow(/at most 30 characters/);
    await expect(call({ descriptions: ['x'.repeat(91), 'ok'] })).rejects.toThrow(/at most 90 characters/);
    await expect(call({ final_url: 'http://insecure.example.com' })).rejects.toThrow(/final_url must be an https URL/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('AC5: foreign ad resource and non-RSA ads are refused before any dispatch', async () => {
    const d = writeDeps();
    await expect(executeGoogleToolkitWrite('u1', { ...base, ad_resource_name: FOREIGN_AD, headlines: H }, 'USD', d))
      .rejects.toThrow(/ad_resource_name must be a adGroupAds resource name in customer 1234567890/);
    await expect(executeGoogleToolkitWrite('u1', { ...base, ad_resource_name: DISPLAY_AD, headlines: H }, 'USD', d))
      .rejects.toThrow(/RESPONSIVE_DISPLAY_AD ad. Only RESPONSIVE_SEARCH_AD/);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('status-only AD UPDATE is unchanged', async () => {
    const d = writeDeps();
    const { result } = await approve(d, { ...base, ad_resource_name: AD, status: 'PAUSED' });
    expect((d.dispatch as jest.Mock).mock.calls[0][1]).toEqual({ ...base, ad_resource_name: AD, status: 'PAUSED' });
    expect(result).toMatchObject({ success: true, verification: 'CONFIRMED' });
  });

  it('maps RSA headlines/descriptions from the read row', () => {
    const row = { adGroupAd: { resourceName: AD, status: 'PAUSED', adGroup: 'g', ad: { type: 'RESPONSIVE_SEARCH_AD', finalUrls: ['https://x'], responsiveSearchAd: { headlines: [{ text: 'a' }], descriptions: [{ text: 'b' }] } } } };
    expect(mapGoogleReadRow('ad', row)).toMatchObject({ headlines: ['a'], descriptions: ['b'], finalUrls: ['https://x'] });
  });
});

describe('ENG-2979 GoogleAdsService.updateAd content edit', () => {
  function service(readBack: any) {
    const svc = new GoogleAdsService() as any;
    svc.getAccountCredentials = jest.fn().mockResolvedValue({ accessToken: 't', loginCustomerId: undefined });
    svc.mutate = jest.fn().mockResolvedValue({});
    svc.search = jest.fn().mockResolvedValue(readBack ? [{ adGroupAd: { ad: readBack } }] : []);
    return svc;
  }

  it('mutates customers/{cid}/ads/{adId} via AdService with an update_mask of only the changed fields', async () => {
    const svc = service({ finalUrls: ['https://n.example.com'], responsiveSearchAd: { headlines: H.map((text) => ({ text })) } });
    await expect(svc.updateAd('u1', CID, AD, { headlines: H, finalUrl: 'https://n.example.com' })).resolves.toBe(true);
    expect(svc.mutate).toHaveBeenCalledTimes(1);
    expect(svc.mutate).toHaveBeenCalledWith(CID, 't', 'ads', [{
      update: { resourceName: `customers/${CID}/ads/901`, responsiveSearchAd: { headlines: H.map((text) => ({ text })) }, finalUrls: ['https://n.example.com'] },
      updateMask: 'responsive_search_ad.headlines,final_urls',
    }], undefined);
  });

  it('throws GoogleAdsReadBackError when a field does not read back', async () => {
    const svc = service({ finalUrls: ['https://old'], responsiveSearchAd: { descriptions: D.map((text) => ({ text })) } });
    await expect(svc.updateAd('u1', CID, AD, { descriptions: D, finalUrl: 'https://n.example.com' }))
      .rejects.toThrow(GoogleAdsReadBackError);
  });

  it('refuses an ad resource from another customer without mutating', async () => {
    const svc = service(null);
    await expect(svc.updateAd('u1', CID, FOREIGN_AD, { headlines: H })).rejects.toThrow(GoogleAdsReadBackError);
    expect(svc.mutate).not.toHaveBeenCalled();
  });
});
