/**
 * ENG-3032 acceptance (ENG-2915 slice 2): read-only ads_get_ad_images / ads_get_ad_videos.
 *  1. Both are advertised, tools:read only.
 *  2. limit / after are allow-listed and bounded; anything else is refused before a Graph read.
 *  3. Success with paging, empty library, Graph error, foreign-account 403.
 *  4. No existing Zoma operation lists either library, so both are new tools (see PR).
 *  5. Both matrix rows leave `gap`.
 * Mocked Graph only: no live Meta call.
 */
jest.mock('../services/agentApiKeyService', () => ({ agentApiKeyService: { validateKey: jest.fn() } }));
jest.mock('../mcp/oauth/oauthService', () => ({ mcpOAuthService: { validateAccessToken: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({ getAccountsByUserIdIncludingOrgShared: jest.fn() }));
jest.mock('../services/mcpUsageEventsService', () => ({ recordMcpToolUse: jest.fn(), recordMcpWriteExecuted: jest.fn() }));
jest.mock('../services/agentModeService', () => ({
  agentModeService: {
    listMetaAdsCampaignsNew: jest.fn(),
    getMetaAdsMetrics: jest.fn(),
    callMetaAdsInsightsApiWrapper: jest.fn(),
    callMetaMarketingApi: jest.fn(),
    launchTargetedAudienceCampaign: jest.fn(),
    launchRetargetingCampaign: jest.fn(),
  },
}));
jest.mock('../utils/scheduledPublishConsentGuard', () => ({
  refuseUnauthorizedScheduledPublish: jest.fn().mockResolvedValue(null),
  attachPublishRevalidation: (_: unknown, context: unknown) => context,
}));
jest.mock('../services/evaluationPolicy', () => ({ enforceEvaluationTool: jest.fn().mockResolvedValue(undefined) }));

import {
  runMetaAssetLibraryTool,
  parseAssetLibraryArgs,
  META_ASSET_LIBRARY_TOOL_NAMES,
  AD_IMAGE_FIELDS,
  AD_VIDEO_FIELDS,
} from '../mcp/metaToolkitAssetLibrary';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { getMetaToolkitManifest, assertMetaToolkitV1Call } from '../mcp/metaToolkitManifest';
import { getToolkitToolAnnotations } from '../mcp/toolkitToolAnnotations';
import { handleMetaToolkitCall, MetaToolkitGatewayDeps } from '../mcp/metaToolkitGateway';
import { ZOMA_META_PARITY_MATRIX } from '../mcp/zomaMetaParityMatrix';
import { sendMetaToolkitError } from '../routes/metaToolkit';

const NEXT = 'https://graph.facebook.com/v25.0/act_9/adimages?access_token=SECRET&after=QVFI';

describe('ENG-3032 ads_get_ad_images', () => {
  it('returns one page with the documented fields and an opaque cursor, never the paging URL', async () => {
    const readAccountGraph = jest.fn().mockResolvedValue({
      data: [
        { hash: 'abc123', name: 'hero.png', url: 'https://scontent.example/hero.png', width: 1080, height: 1080, status: 'ACTIVE', id: '9:abc123' },
        { hash: 'def456', name: 'old.png', url: 'https://scontent.example/old.png', width: '600', height: '314', status: 'DELETED' },
      ],
      paging: { cursors: { before: 'QVFH', after: 'QVFI' }, next: NEXT },
    });
    const r: any = await runMetaAssetLibraryTool('ads_get_ad_images', 'u', '9', { account_id: '9', limit: 2 }, { readAccountGraph });
    expect(readAccountGraph).toHaveBeenCalledWith('u', '9', 'adimages', { fields: AD_IMAGE_FIELDS, limit: '2' });
    expect(r).toEqual({
      account_id: '9',
      images: [
        { image_hash: 'abc123', name: 'hero.png', url: 'https://scontent.example/hero.png', width: 1080, height: 1080, status: 'ACTIVE' },
        { image_hash: 'def456', name: 'old.png', url: 'https://scontent.example/old.png', width: 600, height: 314, status: 'DELETED' },
      ],
      count: 2,
      next_cursor: 'QVFI',
    });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|access_token/);
  });

  it('sends the cursor for the next page and reports the last page without one', async () => {
    const readAccountGraph = jest.fn().mockResolvedValue({ data: [{ hash: 'h' }], paging: { cursors: { after: 'QVFJ' } } });
    const r: any = await runMetaAssetLibraryTool('ads_get_ad_images', 'u', '9', { after: 'QVFI' }, { readAccountGraph });
    expect(readAccountGraph).toHaveBeenCalledWith('u', '9', 'adimages', { fields: AD_IMAGE_FIELDS, limit: '25', after: 'QVFI' });
    expect(r.next_cursor).toBeUndefined();
    expect(r.images[0]).toEqual({ image_hash: 'h', name: null, url: null, width: null, height: null, status: null });
  });

  it('an empty library is an empty list, not an error', async () => {
    const readAccountGraph = jest.fn().mockResolvedValue({ data: [] });
    expect(await runMetaAssetLibraryTool('ads_get_ad_images', 'u', '9', {}, { readAccountGraph })).toEqual({ account_id: '9', images: [], count: 0 });
  });
});

describe('ENG-3032 ads_get_ad_videos', () => {
  it('returns id, title, status, length and thumbnail with paging', async () => {
    const readAccountGraph = jest.fn().mockResolvedValue({
      data: [
        { id: '111', title: 'UGC cut 1', status: { video_status: 'ready', processing_progress: 100 }, length: 14.5, picture: 'https://scontent.example/t1.jpg' },
        { id: 222, status: { video_status: 'processing' } },
      ],
      paging: { cursors: { after: 'MTAx' }, next: NEXT },
    });
    const r: any = await runMetaAssetLibraryTool('ads_get_ad_videos', 'u', '9', {}, { readAccountGraph });
    expect(readAccountGraph).toHaveBeenCalledWith('u', '9', 'advideos', { fields: AD_VIDEO_FIELDS, limit: '25' });
    expect(r).toEqual({
      account_id: '9',
      videos: [
        { video_id: '111', title: 'UGC cut 1', status: 'ready', length_seconds: 14.5, thumbnail_url: 'https://scontent.example/t1.jpg' },
        { video_id: '222', title: null, status: 'processing', length_seconds: null, thumbnail_url: null },
      ],
      count: 2,
      next_cursor: 'MTAx',
    });
  });

  it('an empty library and malformed rows do not throw', async () => {
    const readAccountGraph = jest.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ data: [null, 'x', []] });
    expect(await runMetaAssetLibraryTool('ads_get_ad_videos', 'u', '9', {}, { readAccountGraph })).toEqual({ account_id: '9', videos: [], count: 0 });
    expect(await runMetaAssetLibraryTool('ads_get_ad_videos', 'u', '9', {}, { readAccountGraph })).toEqual({ account_id: '9', videos: [], count: 0 });
  });
});

describe('ENG-3032 arguments and errors', () => {
  it.each([
    ['unknown argument', { fields: 'access_token' }, /Unknown argument\(s\): fields/],
    ['limit 0', { limit: 0 }, /limit must be an integer/],
    ['limit above the bound', { limit: 101 }, /limit must be an integer/],
    ['string limit', { limit: '10' }, /limit must be an integer/],
    ['cursor carrying a second parameter', { after: 'QVFI&access_token=x' }, /after must be the next_cursor/],
    ['non-string cursor', { after: 5 }, /after must be the next_cursor/],
    ['empty cursor', { after: '' }, /after must be the next_cursor/],
    ['array arguments', [1], /must be an object/],
  ])('refuses %s before any Graph read', async (_l, args, message) => {
    for (const name of META_ASSET_LIBRARY_TOOL_NAMES) {
      const readAccountGraph = jest.fn();
      const failure = await runMetaAssetLibraryTool(name, 'u', '9', args, { readAccountGraph }).catch((e) => e);
      expect(failure).toBeInstanceOf(MetaToolkitRefusal);
      expect(failure.message).toMatch(message);
      expect(readAccountGraph).not.toHaveBeenCalled();
    }
  });

  it('accepts the bounds', () => {
    expect(parseAssetLibraryArgs({ limit: 1 })).toEqual({ limit: 1 });
    expect(parseAssetLibraryArgs({ limit: 100, after: 'QVFI_-=' })).toEqual({ limit: 100, after: 'QVFI_-=' });
    expect(parseAssetLibraryArgs(undefined)).toEqual({ limit: 25 });
  });

  it("a Graph error is the toolkit's structured 400 with Meta's message only, never the token", async () => {
    const err: any = Object.assign(new Error('Request failed with status code 400'), {
      config: { params: { access_token: 'SECRET' } }, metaError: { code: 200, message: '(#200) Permissions error' },
    });
    for (const name of META_ASSET_LIBRARY_TOOL_NAMES) {
      const failure = await runMetaAssetLibraryTool(name, 'u', '9', {}, { readAccountGraph: jest.fn().mockRejectedValue(err) }).catch((e) => e);
      expect(failure).toBeInstanceOf(MetaToolkitRefusal);
      const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
      sendMetaToolkitError(res, failure);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json.mock.calls[0][0].error).toMatch(/Permissions error/);
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(/SECRET/);
    }
  });
});

describe('ENG-3032 manifest, scope and metering', () => {
  const NOW = Date.parse('2026-11-15T00:00:00Z');
  const acct = (id: string) => ({ platform: 'meta', account_id: id, config: { account_type: 'ad_account', ad_account_id: id, access_token: 'tok', token_expires_at: NOW + 86_400_000 } });
  function makeDeps(scopes: string[]) {
    const raw = {
      validateApiKey: jest.fn().mockResolvedValue({ userId: 'user-1', keyId: 'k', scopes }),
      validateOAuthToken: jest.fn().mockResolvedValue(null),
      listAccounts: jest.fn().mockResolvedValue([acct('111')]),
      execute: jest.fn(),
      recordUsage: jest.fn().mockResolvedValue(true),
      recordWrite: jest.fn().mockResolvedValue(undefined),
      now: () => NOW,
      rateLimiter: { check: () => ({ allowed: true, remaining: 1, resetInMs: 0 }) },
      runAssetLibraryTool: jest.fn().mockResolvedValue({ images: [], count: 0, access_token: 'leak' }),
    };
    return { raw, deps: raw as unknown as MetaToolkitGatewayDeps };
  }

  it.each(META_ASSET_LIBRARY_TOOL_NAMES)('%s is advertised with a closed schema and annotated read-only', (name) => {
    const def: any = getMetaToolkitManifest().find((d: any) => d.name === name);
    expect(def).toBeDefined();
    expect(def.inputSchema.additionalProperties).toBe(false);
    expect(Object.keys(def.inputSchema.properties).sort()).toEqual(['account_id', 'after', 'limit']);
    expect(() => assertMetaToolkitV1Call(name, {})).not.toThrow();
    expect(getToolkitToolAnnotations(name)).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it.each(META_ASSET_LIBRARY_TOOL_NAMES)('%s: a tools:read key runs it on the resolved account, metered once as a read', async (name) => {
    const { raw, deps } = makeDeps(['tools:read']);
    const res = await handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: name, args: {} }, deps);
    expect(res).toEqual({ images: [], count: 0 });
    expect(raw.runAssetLibraryTool).toHaveBeenCalledWith(name, 'user-1', '111', expect.any(Object));
    expect(raw.recordUsage).toHaveBeenCalledTimes(1);
    expect(raw.recordWrite).not.toHaveBeenCalled();
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it.each(META_ASSET_LIBRARY_TOOL_NAMES)('%s: a foreign ad account is 403 before any Graph read and is not metered', async (name) => {
    const { raw, deps } = makeDeps(['tools:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: name, args: { account_id: '999' } }, deps))
      .rejects.toMatchObject({ status: 403 });
    expect(raw.runAssetLibraryTool).not.toHaveBeenCalled();
    expect(raw.recordUsage).not.toHaveBeenCalled();
  });

  it('a key with neither tools scope is 403', async () => {
    const { raw, deps } = makeDeps(['email:read']);
    await expect(handleMetaToolkitCall({ authorization: 'Bearer aw_x', toolName: 'ads_get_ad_images', args: {} }, deps))
      .rejects.toMatchObject({ status: 403, message: expect.stringContaining('tools:read') });
    expect(raw.runAssetLibraryTool).not.toHaveBeenCalled();
  });
});

describe('ENG-3032 parity rows', () => {
  it.each(META_ASSET_LIBRARY_TOOL_NAMES)('%s leaves gap', (name) => {
    expect(ZOMA_META_PARITY_MATRIX.find((r) => r.metaTool === name)).toMatchObject({ status: 'covered', zoma: { tool: name } });
  });
});
