/**
 * ENG-2915 — Zoma external MCP creatives: multi-variant (asset_feed_spec), carousel /
 * placement without a top-level image, video ingest from a public URL, and BULK_CREATE.
 */
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../mcp/zomaOnboarding', () => {
  class ZomaNotReadyError extends Error {}
  return {
    ZomaNotReadyError,
    assertZomaWriteReady: jest.fn(),
    adsManagementScopeState: (a: any) => a?.config?.scope ?? 'missing',
    metaConnectionIsUsable: () => true,
    runZomaTool: jest.fn(),
  };
});
jest.mock('../mcp/zomaDeviceFlow', () => ({ ZOMA_TOKEN_PREFIX: 'zoma_', validateZomaToken: jest.fn() }));

import { executeMetaToolkitCreative, isCreativeAssetRequest, MAX_BULK_CREATIVES, type MetaToolkitCreativeDeps } from '../mcp/metaToolkitCreatives';
import { handleMetaToolkitCall } from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { SsrfBlockedError } from '../utils/ssrfGuard';

const USER = 'user-1';
const ACCOUNT = '123456';

function deps(over: Partial<MetaToolkitCreativeDeps> = {}): MetaToolkitCreativeDeps {
  let nextId = 700;
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([
      { platform: 'meta', account_id: ACCOUNT, config: { account_type: 'ad_account', access_token: 't', ad_account_id: ACCOUNT, scope: 'granted' } },
    ]),
    bucket: () => 'agentweb-user-files',
    presignPut: jest.fn(),
    presignGet: jest.fn(),
    headObject: jest.fn(),
    resolveHost: jest.fn().mockResolvedValue(['104.18.1.1']),
    probeUrl: jest.fn(async (url: string) => ({ finalUrl: url, status: 200, contentType: 'video/mp4', contentLength: 5_000_000 })),
    uploadImage: jest.fn().mockResolvedValue({ success: true, image_hash: 'hash' }),
    uploadVideo: jest.fn().mockResolvedValue({ success: true, video: { id: '998877' } }),
    videoStatus: jest.fn().mockResolvedValue({ status: 'ready', thumbnail_url: 'https://scontent/thumb.jpg' }),
    previewCreative: jest.fn(async (_u: string, _a: string, params: any) => ({ awaitingUserConfirmation: true, metaWriteDispatch: { params } })),
    dispatch: jest.fn(async () => {
      const id = String(nextId++);
      return { result: { success: true }, createdId: id };
    }),
    readCreative: jest.fn(async (_u: string, _a: string, id: string) => ({ success: true, creative: { id, name: 'n' } })),
    sleep: jest.fn().mockResolvedValue(undefined),
    now: () => 1_700_000_000_000,
    videoWaitMs: 90_000,
    ...over,
  };
}

const call = (action: string, params: any) => ({ entity_type: 'AD_CREATIVE', action, account_id: ACCOUNT, params });
const base = { name: 'UGC', page_id: '42', link_url: 'https://shop.example.com', call_to_action_type: 'SHOP_NOW' };
const afsReadBack = (counts: { titles: number; bodies: number; descriptions?: number; images?: number; videos?: number }) => {
  const arr = (n = 0) => Array.from({ length: n }, () => ({}));
  return jest.fn(async (_u: string, _a: string, id: string) => ({
    success: true,
    creative: {
      id,
      name: 'UGC',
      asset_feed_spec: { titles: arr(counts.titles), bodies: arr(counts.bodies), descriptions: arr(counts.descriptions), images: arr(counts.images), videos: arr(counts.videos) },
    },
  }));
};

describe('multi-variant CREATE (asset_feed_spec)', () => {
  const multi = { ...base, headlines: ['H1', 'H2', 'H3'], bodies: ['B1', 'B2'], descriptions: ['D1'], image_hashes: ['ih1', 'ih2'], video_ids: ['111', '222'] };

  it('builds one creative from the lists, filling video thumbnails from Meta, verified CONFIRMED by read-back', async () => {
    const d = deps({ readCreative: afsReadBack({ titles: 3, bodies: 2, descriptions: 1, images: 2, videos: 2 }) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', multi), d);
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', creative_id: '700' });
    const sent = (d.previewCreative as jest.Mock).mock.calls[0][2];
    expect(sent).toMatchObject({
      headlines: ['H1', 'H2', 'H3'], bodies: ['B1', 'B2'], descriptions: ['D1'], image_hashes: ['ih1', 'ih2'], video_ids: ['111', '222'],
      video_thumbnails: { '111': 'https://scontent/thumb.jpg', '222': 'https://scontent/thumb.jpg' },
      call_to_action_type: 'SHOP_NOW', link_url: 'https://shop.example.com',
    });
    expect(d.dispatch).toHaveBeenCalledTimes(1);
  });

  it('is MISMATCH when Meta stored fewer variants than were sent', async () => {
    const d = deps({ readCreative: afsReadBack({ titles: 1, bodies: 2, descriptions: 1, images: 2, videos: 2 }) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', multi), d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH', creative_id: '700' });
    expect(r.message).toMatch(/titles: sent 3, Meta has 1/);
  });

  it.each([
    ['six headlines', { headlines: ['1', '2', '3', '4', '5', '6'] }, /headlines" has 6 entries; the maximum is 5/],
    ['six bodies', { bodies: ['1', '2', '3', '4', '5', '6'] }, /bodies" has 6 entries; the maximum is 5/],
    ['six descriptions', { descriptions: ['1', '2', '3', '4', '5', '6'] }, /descriptions" has 6 entries/],
    ['a 256-char headline', { headlines: ['x'.repeat(256)] }, /headlines\[0\] is 256 characters; the maximum is 255/],
    ['eleven images', { image_hashes: Array.from({ length: 11 }, (_, i) => `h${i}`), video_ids: undefined }, /image_hashes" has 11 entries; the maximum is 10/],
    ['an empty headline', { headlines: ['ok', ' '] }, /headlines\[1\] must be a non-empty string/],
    ['title and headlines together', { title: 'T' }, /either "headlines" or "title"/],
    ['an image_url', { image_url: 'https://cdn.x/a.png' }, /cannot use "image_url"/],
    ['carousel mixed in', { carousel_cards: [{}, {}] }, /cannot use "carousel_cards"/],
    ['a bad CTA', { call_to_action_type: 'buy now' }, /call_to_action_type/],
    ['no link', { link_url: undefined }, /requires "link_url"/],
    ['no media', { image_hashes: undefined, video_ids: undefined }, /needs media/],
  ])('refuses %s with a clear error, sending nothing to Meta', async (_label, over, pattern) => {
    const d = deps();
    await expect(executeMetaToolkitCreative(USER, call('CREATE', { ...multi, ...over }), d)).rejects.toThrow(pattern);
    expect(d.previewCreative).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('folds a single body/image into the lists (headlines + one image)', async () => {
    const d = deps({ readCreative: afsReadBack({ titles: 2, bodies: 1, images: 1 }) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', { ...base, headlines: ['A', 'B'], body: 'one', image_hash: 'ih' }), d);
    expect(r.verification).toBe('CONFIRMED');
    const sent = (d.previewCreative as jest.Mock).mock.calls[0][2];
    expect(sent).toMatchObject({ bodies: ['one'], image_hashes: ['ih'] });
    expect(sent.body).toBeUndefined();
    expect(sent.image_hash).toBeUndefined();
  });

  it('does not build when a variant video is still processing', async () => {
    const d = deps({ videoStatus: jest.fn().mockResolvedValue({ status: 'processing' }) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', multi), d);
    expect(r).toMatchObject({ success: false, status: 'VIDEO_NOT_READY' });
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});

describe('carousel_cards and placement_assets need no top-level media', () => {
  it('creates a carousel from per-card media only, resolving card image URLs through the SSRF guard', async () => {
    const d = deps({
      probeUrl: jest.fn(async (url: string) => ({ finalUrl: `${url}?final`, status: 200, contentType: 'image/png' })),
      readCreative: jest.fn(async (_u: string, _a: string, id: string) => ({
        success: true, creative: { id, object_story_spec: { link_data: { child_attachments: [{}, {}] } } },
      })),
    });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', {
      name: 'C', page_id: '42', body: 'b',
      carousel_cards: [
        { image_hash: 'h1', title: 'One', link_url: 'https://x.com/1' },
        { image_url: 'https://cdn.x/2.png', title: 'Two', link_url: 'https://x.com/2' },
      ],
    }), d);
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED' });
    const sent = (d.previewCreative as jest.Mock).mock.calls[0][2];
    expect(sent.image_hash).toBeUndefined();
    expect(sent.carousel_cards[1].image_url).toBe('https://cdn.x/2.png?final');
  });

  it('refuses a carousel card with no link, and a private card image URL', async () => {
    await expect(executeMetaToolkitCreative(USER, call('CREATE', {
      name: 'C', page_id: '42', body: 'b', carousel_cards: [{ image_hash: 'h1' }, { image_hash: 'h2' }],
    }), deps())).rejects.toThrow(/carousel_cards\[0\] needs a link_url/);
    await expect(executeMetaToolkitCreative(USER, call('CREATE', {
      name: 'C', page_id: '42', body: 'b', link_url: 'https://x.com',
      carousel_cards: [{ image_hash: 'h1' }, { image_url: 'https://internal.example/a.png' }],
    }), deps({ resolveHost: jest.fn().mockResolvedValue(['10.0.0.5']) }))).rejects.toThrow(/public address/);
  });

  it('is MISMATCH when Meta stored fewer carousel cards', async () => {
    const d = deps({ readCreative: jest.fn(async (_u: string, _a: string, id: string) => ({ success: true, creative: { id, object_story_spec: { link_data: { child_attachments: [{}] } } } })) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', {
      name: 'C', page_id: '42', body: 'b', link_url: 'https://x.com', carousel_cards: [{ image_hash: 'h1' }, { image_hash: 'h2' }],
    }), d);
    expect(r).toMatchObject({ success: false, verification: 'MISMATCH' });
  });

  it('creates a placement creative from placement_assets alone', async () => {
    const d = deps({ readCreative: jest.fn(async (_u: string, _a: string, id: string) => ({ success: true, creative: { id, asset_feed_spec: { images: [{}, {}] } } })) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', {
      name: 'P', page_id: '42', body: 'b', title: 't', link_url: 'https://x.com',
      placement_assets: [{ image_hash: 'sq', is_default: true }, { image_hash: 'tall', placements: ['story', 'reels'] }],
    }), d);
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect((d.previewCreative as jest.Mock).mock.calls[0][2].image_hash).toBeUndefined();
  });
});

describe('video ingest from a public URL', () => {
  it('uploads the post-redirect URL the probe validated', async () => {
    const d = deps({ probeUrl: jest.fn(async () => ({ finalUrl: 'https://cdn.ugc.example/final.mp4', status: 200, contentType: 'video/mp4' })) });
    const r = await executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_url: 'https://ugc.example/v/abc' }), d);
    expect(r).toMatchObject({ verification: 'CONFIRMED', video_id: '998877' });
    expect(d.uploadVideo).toHaveBeenCalledWith(USER, 'https://cdn.ugc.example/final.mp4', ACCOUNT);
  });

  it.each([
    ['a redirect into a private network', jest.fn().mockRejectedValue(new SsrfBlockedError()), /does not point to a public https address/],
    ['a post page instead of a file', jest.fn().mockResolvedValue({ finalUrl: 'u', status: 200, contentType: 'text/html' }), /web page, not a video file/],
    ['a non-video type', jest.fn().mockResolvedValue({ finalUrl: 'u', status: 200, contentType: 'application/json' }), /serves application\/json, not a video/],
    ['a file over 1 GB', jest.fn().mockResolvedValue({ finalUrl: 'u', status: 200, contentType: 'video/mp4', contentLength: 1024 * 1024 * 1024 + 1 }), /limit is 1024 MB/],
    ['a login wall', jest.fn().mockResolvedValue({ finalUrl: 'u', status: 403, contentType: 'text/html' }), /answered HTTP 403/],
  ])('refuses %s before Meta is asked to fetch it', async (_l, probeUrl, pattern) => {
    const d = deps({ probeUrl });
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_url: 'https://ugc.example/v/abc' }), d)).rejects.toThrow(pattern);
    expect(d.uploadVideo).not.toHaveBeenCalled();
  });

  it('still refuses http and private hosts without probing', async () => {
    const d = deps();
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_url: 'http://ugc.example/v.mp4' }), d)).rejects.toThrow(/Only https/);
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_url: 'https://127.0.0.1/v.mp4' }), d)).rejects.toThrow(/public address/);
    expect(d.probeUrl).not.toHaveBeenCalled();
  });

  it('uses Meta\'s processed thumbnail for a single-video creative with none supplied', async () => {
    const d = deps();
    const r = await executeMetaToolkitCreative(USER, call('CREATE', { ...base, body: 'b', title: 't', video_id: '111' }), d);
    expect(r.verification).toBe('CONFIRMED');
    expect((d.previewCreative as jest.Mock).mock.calls[0][2].image_url).toBe('https://scontent/thumb.jpg');
  });
});

describe('BULK_CREATE', () => {
  const shared = { ...base, body: 'Shared body', title: 'Shared headline' };

  it('creates up to 10 creatives, each reported individually, with partial success reported', async () => {
    const previewCreative = jest.fn(async (_u: string, _a: string, params: any) =>
      params.image_hash === 'bad'
        ? { success: false, error: 'META_PAGE_ACCESS_MISSING: nope' }
        : { awaitingUserConfirmation: true, metaWriteDispatch: { params } });
    const d = deps({ previewCreative });
    const r = await executeMetaToolkitCreative(USER, call('BULK_CREATE', {
      ...shared,
      items: [
        { image_hash: 'h1' },
        { image_hash: 'bad' },
        { video_url: 'https://ugc.example/v.mp4', name: 'Custom' },
        { image_url: 'https://127.0.0.1/a.png' },
      ],
    }), deps({ ...d, previewCreative, resolveHost: jest.fn(async (host: string) => (host === '127.0.0.1' ? ['127.0.0.1'] : ['104.18.1.1'])) }));
    expect(r).toMatchObject({ success: true, status: 'PARTIAL', requested: 4, created: 2, confirmed: 2, failed: 2 });
    expect(r.results[0]).toMatchObject({ index: 0, name: 'UGC 1', success: true, verification: 'CONFIRMED' });
    expect(r.results[1]).toMatchObject({ index: 1, success: false, status: 'FAILED' });
    expect(r.results[1].message).toContain('META_PAGE_ACCESS_MISSING');
    expect(r.results[2]).toMatchObject({ index: 2, name: 'Custom', success: true, verification: 'CONFIRMED' });
    expect(r.results[3]).toMatchObject({ index: 3, success: false, status: 'REFUSED' });
    expect(r.results[3].message).toMatch(/public address/);
  });

  it('applies shared fields and per-item overrides (including multi-variant items)', async () => {
    const d = deps({ readCreative: jest.fn(async (_u: string, _a: string, id: string) => ({ success: true, creative: { id, asset_feed_spec: { titles: [{}, {}], bodies: [{}], images: [{}] } } })) });
    const r = await executeMetaToolkitCreative(USER, call('BULK_CREATE', {
      ...base, bodies: ['Shared body'], items: [{ image_hashes: ['h1'], headlines: ['A', 'B'] }],
    }), d);
    expect(r.status).toBe('ALL_CONFIRMED');
    expect((d.previewCreative as jest.Mock).mock.calls[0][2]).toMatchObject({ name: 'UGC 1', page_id: '42', bodies: ['Shared body'], headlines: ['A', 'B'], image_hashes: ['h1'] });
  });

  it('waits for all uploaded videos against ONE shared deadline and reports the unfinished ones', async () => {
    let t = 0;
    const videoStatus = jest.fn(async (_u: string, _a: string, id: string) => (id === '1' ? { status: 'ready', thumbnail_url: 'https://scontent/1.jpg' } : { status: 'processing' }));
    let n = 0;
    const d = deps({
      uploadVideo: jest.fn(async () => ({ success: true, video: { id: String(++n) } })),
      videoStatus,
      now: () => t,
      sleep: jest.fn(async (ms: number) => { t += ms; }),
      videoWaitMs: 20_000,
    });
    const r = await executeMetaToolkitCreative(USER, call('BULK_CREATE', { ...shared, items: [{ video_url: 'https://ugc.example/1.mp4' }, { video_url: 'https://ugc.example/2.mp4' }] }), d);
    expect(t).toBeLessThanOrEqual(25_000);
    expect(r.results[0]).toMatchObject({ success: true, verification: 'CONFIRMED' });
    expect(r.results[1]).toMatchObject({ success: false, status: 'VIDEO_NOT_READY', video_id: '2' });
    expect(r.status).toBe('PARTIAL');
  });

  it(`refuses more than ${MAX_BULK_CREATIVES} items, no items, and gate-only params on an item`, async () => {
    const d = deps();
    const items = Array.from({ length: MAX_BULK_CREATIVES + 1 }, (_, i) => ({ image_hash: `h${i}` }));
    await expect(executeMetaToolkitCreative(USER, call('BULK_CREATE', { ...shared, items }), d)).rejects.toThrow(/at most 10 items/);
    await expect(executeMetaToolkitCreative(USER, call('BULK_CREATE', { ...shared }), d)).rejects.toThrow(/needs params.items/);
    expect(d.dispatch).not.toHaveBeenCalled();
    const r = await executeMetaToolkitCreative(USER, call('BULK_CREATE', { ...shared, items: [{ image_hash: 'h', override_tracking_check: true }] }), d);
    expect(r).toMatchObject({ status: 'NONE_CREATED', success: false });
    expect(r.results[0].message).toMatch(/override_tracking_check/);
  });

  it('checks readiness and ads_management once, before anything is uploaded', async () => {
    const d = deps({ listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: ACCOUNT, config: { account_type: 'ad_account', access_token: 't', ad_account_id: ACCOUNT, scope: 'missing' } }]) });
    await expect(executeMetaToolkitCreative(USER, call('BULK_CREATE', { ...shared, items: [{ video_url: 'https://ugc.example/1.mp4' }] }), d)).rejects.toThrow();
    expect(d.uploadVideo).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});

describe('gateway: surface, scopes, metering', () => {
  const gatewayDeps = (executeCreative: any, recordWrite: any, scopes?: string[]) => ({
    validateApiKey: jest.fn().mockResolvedValue({ userId: USER, keyId: 'k1', ...(scopes ? { scopes } : {}) }),
    validateOAuthToken: jest.fn(),
    listAccounts: jest.fn().mockResolvedValue([
      { platform: 'meta', account_id: ACCOUNT, status: 'active', config: { account_type: 'ad_account', access_token: 't', ad_account_id: ACCOUNT, scope: 'granted' } },
    ]),
    execute: jest.fn(),
    recordUsage: jest.fn().mockResolvedValue(true),
    now: () => 0,
    rateLimiter: { check: () => ({ allowed: true, resetInMs: 0 }) },
    executeCreative,
    recordWrite,
  });
  const bulk = { entity_type: 'AD_CREATIVE', action: 'BULK_CREATE', params: { items: [{ image_hash: 'h' }] } };

  it('routes BULK_CREATE as a creative write and advertises it', () => {
    expect(isCreativeAssetRequest('call_meta_marketing_api', bulk)).toBe(true);
    const manifest = getMetaToolkitManifest({
      getTool: (name: string) => ({ definition: { name, description: 'x', inputSchema: { type: 'object', properties: { action: { enum: ['LIST'] } } } } }),
    } as any);
    const tool = manifest.find((t: any) => t.name === 'call_meta_marketing_api');
    expect(tool.inputSchema.properties.action.enum).toContain('BULK_CREATE');
    expect(tool.description).toMatch(/headlines\[\]/);
    expect(tool.description).toMatch(/BULK_CREATE/);
  });

  it('meters one write per bulk item that reached Meta, none for refused items', async () => {
    const executeCreative = jest.fn().mockResolvedValue({
      success: true, status: 'PARTIAL',
      results: [
        { index: 0, success: true, verification: 'CONFIRMED', id: '1', creative_id: '1' },
        { index: 1, success: false, status: 'REFUSED', message: 'x' },
        { index: 2, success: false, verification: 'UNCONFIRMED', id: '3', creative_id: '3' },
      ],
    });
    const recordWrite = jest.fn().mockResolvedValue(true);
    const d: any = gatewayDeps(executeCreative, recordWrite);
    await handleMetaToolkitCall({ authorization: 'Bearer aw_test', toolName: 'call_meta_marketing_api', args: bulk }, d);
    expect(recordWrite).toHaveBeenCalledTimes(2);
    expect(recordWrite).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: 'BULK_CREATE', verification: 'CONFIRMED', objectId: '1' }));
    expect(recordWrite).toHaveBeenNthCalledWith(2, expect.objectContaining({ verification: 'UNCONFIRMED', objectId: '3' }));
    expect(d.recordUsage).toHaveBeenCalledTimes(1);
  });

  it('a read-only aw_ key cannot BULK_CREATE (ENG-2865)', async () => {
    const executeCreative = jest.fn();
    const d: any = gatewayDeps(executeCreative, jest.fn(), ['tools:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_test', toolName: 'call_meta_marketing_api', args: bulk }, d)).rejects.toMatchObject({ status: 403 });
    expect(executeCreative).not.toHaveBeenCalled();
    expect(d.recordUsage).not.toHaveBeenCalled();
  });
});
