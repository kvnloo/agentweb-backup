process.env.ZOMA_REQUIRE_PAYMENT_METHOD = 'true';
/**
 * Zoma creative upload (Matt's 2026-10-26 feedback): external creatives → Meta media
 * library → creative → paused ad, without Ads Manager.
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

import {
  executeMetaToolkitCreative,
  isCreativeAssetRequest,
  isPrivateAddress,
  prepareZomaUpload,
  type MetaToolkitCreativeDeps,
} from '../mcp/metaToolkitCreatives';
import { MetaToolkitRefusal } from '../mcp/metaToolkitErrors';
import { handleMetaToolkitCall, stripCredentials } from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest } from '../mcp/metaToolkitManifest';
import { ZomaNotReadyError } from '../mcp/zomaOnboarding';

const USER = 'user-1';
const ACCOUNT = '123456';
const BUCKET = 'agentweb-user-files';

function deps(over: Partial<MetaToolkitCreativeDeps> = {}): MetaToolkitCreativeDeps {
  return {
    assertReady: jest.fn().mockResolvedValue(undefined),
    listAccounts: jest.fn().mockResolvedValue([
      { platform: 'meta', account_id: ACCOUNT, config: { account_type: 'ad_account', access_token: 't', ad_account_id: ACCOUNT, scope: 'granted' } },
    ]),
    bucket: () => BUCKET,
    presignPut: jest.fn((key: string) => `https://${BUCKET}.s3.amazonaws.com/${key}?X-Amz-Signature=put`),
    presignGet: jest.fn((key: string) => `https://${BUCKET}.s3.amazonaws.com/${key}?X-Amz-Signature=get`),
    headObject: jest.fn().mockResolvedValue({ key: 'k', contentLength: 2048, contentType: 'image/png' }),
    resolveHost: jest.fn().mockResolvedValue(['104.18.1.1']),
    probeUrl: jest.fn(async (url: string) => ({ finalUrl: url, status: 200, contentType: '' })),
    uploadImage: jest.fn().mockResolvedValue({ success: true, image_hash: 'abc123hash', image_url: 'https://scontent/x.png' }),
    uploadVideo: jest.fn().mockResolvedValue({ success: true, video: { id: '998877' } }),
    videoStatus: jest.fn().mockResolvedValue({ status: 'ready', thumbnail_url: 'https://scontent/thumb.jpg' }),
    previewCreative: jest.fn().mockResolvedValue({ awaitingUserConfirmation: true, metaWriteDispatch: { entity_type: 'AD_CREATIVE', action: 'CREATE' } }),
    dispatch: jest.fn().mockResolvedValue({ result: { success: true, creative: { id: '555' } }, createdId: '555' }),
    readCreative: jest.fn().mockResolvedValue({ success: true, creative: { id: '555', name: 'Higgsfield 1' } }),
    sleep: jest.fn().mockResolvedValue(undefined),
    now: () => 1_700_000_000_000,
    videoWaitMs: 90_000,
    ...over,
  };
}

const call = (action: string, params: any) => ({ entity_type: 'AD_CREATIVE', action, account_id: ACCOUNT, params });

describe('surface', () => {
  it('routes AD_CREATIVE uploads + create, nothing else', () => {
    expect(isCreativeAssetRequest('call_meta_marketing_api', call('UPLOAD_IMAGE', {}))).toBe(true);
    expect(isCreativeAssetRequest('call_meta_marketing_api', call('UPLOAD_VIDEO', {}))).toBe(true);
    expect(isCreativeAssetRequest('call_meta_marketing_api', call('CREATE', {}))).toBe(true);
    expect(isCreativeAssetRequest('call_meta_marketing_api', call('UPDATE', {}))).toBe(false);
    expect(isCreativeAssetRequest('call_meta_marketing_api', { entity_type: 'CUSTOM_AUDIENCE', action: 'UPLOAD_USERS' })).toBe(false);
  });

  it('advertises zoma_prepare_upload and the upload actions', () => {
    const manifest = getMetaToolkitManifest({
      getTool: (name: string) => ({
        definition: {
          name,
          description: 'x',
          inputSchema: { type: 'object', properties: { action: { enum: ['LIST'] }, entity_type: { enum: [] }, account_id: {} } },
        },
      }),
    } as any);
    const marketing = manifest.find((d: any) => d.name === 'call_meta_marketing_api');
    expect(marketing.inputSchema.properties.action.enum).toEqual(expect.arrayContaining(['UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'CREATE']));
    expect(marketing.description).toContain('zoma_prepare_upload');
    expect(manifest.map((d: any) => d.name)).toContain('zoma_prepare_upload');
  });
});

describe('zoma_prepare_upload', () => {
  it('mints a PUT under the caller prefix with the validated content type', async () => {
    const d = deps();
    const r = await prepareZomaUpload(USER, { filename: 'Higgsfield Batch/01 hero.PNG' }, d);
    expect(r.kind).toBe('image');
    expect(r.headers['Content-Type']).toBe('image/png');
    expect(r.file_url).toMatch(new RegExp(`^https://${BUCKET}\\.s3\\.amazonaws\\.com/users/${USER}/zoma-uploads/.+/01_hero\\.PNG$`));
    expect(d.presignPut).toHaveBeenCalledWith(expect.stringMatching(`^users/${USER}/zoma-uploads/`), 'image/png', 900);
    expect(r.upload_command).toContain("-H 'Content-Type: image/png'");
  });

  it('refuses unknown types, oversize, and unready accounts', async () => {
    await expect(prepareZomaUpload(USER, { filename: 'x.exe' }, deps())).rejects.toBeInstanceOf(MetaToolkitRefusal);
    await expect(prepareZomaUpload(USER, { filename: 'x.png', size_bytes: 31 * 1024 * 1024 }, deps())).rejects.toThrow(/size_bytes/);
    const notReady = deps({ assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('No payment method on file')) });
    await expect(prepareZomaUpload(USER, { filename: 'x.mp4' }, notReady)).rejects.toThrow(/payment method/);
  });
});

describe('UPLOAD_IMAGE', () => {
  it('uploads a public URL and returns the hash', async () => {
    const d = deps();
    const r = await executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: 'https://cdn.higgsfield.ai/a.png' }), d);
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', image_hash: 'abc123hash' });
    expect(d.uploadImage).toHaveBeenCalledWith(USER, 'https://cdn.higgsfield.ai/a.png', ACCOUNT);
  });

  it('presigns the caller own staged file', async () => {
    const d = deps();
    const key = `users/${USER}/zoma-uploads/1-ab/a.png`;
    await executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: `https://${BUCKET}.s3.amazonaws.com/${key}` }), d);
    expect(d.headObject).toHaveBeenCalledWith(key);
    expect(d.uploadImage).toHaveBeenCalledWith(USER, expect.stringContaining('X-Amz-Signature=get'), ACCOUNT);
  });

  it("refuses someone else's staged file and non-zoma keys", async () => {
    for (const key of ['users/other/zoma-uploads/1/a.png', `users/${USER}/files/1/a.png`]) {
      await expect(
        executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: `https://${BUCKET}.s3.amazonaws.com/${key}` }), deps()),
      ).rejects.toThrow(/not uploaded by this account/);
    }
  });

  it('refuses http, private addresses, and missing staged objects', async () => {
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: 'http://x.com/a.png' }), deps())).rejects.toThrow(/https/);
    await expect(
      executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: 'https://169.254.169.254/latest' }), deps()),
    ).rejects.toThrow(/public address/);
    const internal = deps({ resolveHost: jest.fn().mockResolvedValue(['10.0.0.5']) });
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: 'https://internal.corp/a.png' }), internal)).rejects.toThrow(/public address/);
    const missing = deps({ headObject: jest.fn().mockResolvedValue(null) });
    await expect(
      executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: `https://${BUCKET}.s3.amazonaws.com/users/${USER}/zoma-uploads/1/a.png` }), missing),
    ).rejects.toThrow(/not found/);
  });

  it('requires ads_management and write readiness', async () => {
    const noScope = deps({ listAccounts: jest.fn().mockResolvedValue([{ platform: 'meta', account_id: ACCOUNT, config: { account_type: 'ad_account', access_token: 't', ad_account_id: ACCOUNT, scope: 'missing' } }]) });
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: 'https://cdn.x/a.png' }), noScope)).rejects.toThrow(/ads_management/);
    const d = deps({ assertReady: jest.fn().mockRejectedValue(new ZomaNotReadyError('No payment method')) });
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_IMAGE', { image_url: 'https://cdn.x/a.png' }), d)).rejects.toBeInstanceOf(MetaToolkitRefusal);
    expect(d.uploadImage).not.toHaveBeenCalled();
  });
});

describe('UPLOAD_VIDEO', () => {
  it('waits for processing and returns the thumbnail', async () => {
    const videoStatus = jest.fn()
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({ status: 'ready', thumbnail_url: 'https://scontent/t.jpg' });
    const d = deps({ videoStatus });
    const r = await executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_url: 'https://cdn.higgsfield.ai/v.mp4' }), d);
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', video_id: '998877', thumbnail_url: 'https://scontent/t.jpg' });
    expect(videoStatus).toHaveBeenCalledTimes(2);
  });

  it('reports still-processing as UNCONFIRMED and supports a re-check by video_id', async () => {
    let t = 0;
    const d = deps({ videoStatus: jest.fn().mockResolvedValue({ status: 'processing' }), now: () => (t += 50_000), videoWaitMs: 60_000 });
    const r = await executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_url: 'https://cdn.x/v.mp4' }), d);
    expect(r).toMatchObject({ verification: 'UNCONFIRMED', video_status: 'processing' });
    const again = await executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_id: '998877' }), deps());
    expect(again).toMatchObject({ verification: 'CONFIRMED', video_status: 'ready' });
  });
});

describe('AD_CREATIVE CREATE', () => {
  const base = { name: 'Higgsfield 1', page_id: '42', body: 'b', title: 't', link_url: 'https://x.com' };

  it('creates through the shared gate + dispatch, verified by read-back', async () => {
    const d = deps();
    const r = await executeMetaToolkitCreative(USER, call('CREATE', { ...base, image_hash: 'abc123hash' }), d);
    expect(r).toMatchObject({ success: true, verification: 'CONFIRMED', creative_id: '555' });
    expect(d.previewCreative).toHaveBeenCalledWith(USER, ACCOUNT, expect.objectContaining({ image_hash: 'abc123hash' }));
    expect(d.dispatch).toHaveBeenCalled();
  });

  it('does not dispatch when the shared gate refuses (e.g. Page access)', async () => {
    const d = deps({ previewCreative: jest.fn().mockResolvedValue({ success: false, error: 'META_PAGE_ACCESS_MISSING: no access' }) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', { ...base, image_hash: 'h' }), d);
    expect(r).toMatchObject({ success: false, status: 'FAILED' });
    expect(r.message).toContain('META_PAGE_ACCESS_MISSING');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('refuses a creative with no media and an unready video', async () => {
    await expect(executeMetaToolkitCreative(USER, call('CREATE', base), deps())).rejects.toThrow(/needs the media/);
    const d = deps({ videoStatus: jest.fn().mockResolvedValue({ status: 'processing' }) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', { ...base, video_id: '1', image_url: 'https://cdn.x/t.jpg' }), d);
    expect((r as any).status).toBe('VIDEO_NOT_READY');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('is UNCONFIRMED when the read-back fails', async () => {
    const d = deps({ readCreative: jest.fn().mockRejectedValue(new Error('boom')) });
    const r = await executeMetaToolkitCreative(USER, call('CREATE', { ...base, image_hash: 'h' }), d);
    expect(r).toMatchObject({ success: false, verification: 'UNCONFIRMED', creative_id: '555' });
  });

  it('refuses gate-only params', async () => {
    await expect(executeMetaToolkitCreative(USER, call('CREATE', { ...base, image_hash: 'h', override_tracking_check: true }), deps())).rejects.toThrow(/override_tracking_check/);
  });
});

describe('gateway routing + metering', () => {
  const gatewayDeps = (executeCreative: any, recordWrite: any, prepareUpload?: any) => ({
    validateApiKey: jest.fn().mockResolvedValue({ userId: USER, keyId: 'k1' }),
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
    prepareUpload,
  });

  it('routes AD_CREATIVE UPLOAD_IMAGE to the creative executor and meters it as a write', async () => {
    const executeCreative = jest.fn().mockResolvedValue({ success: true, verification: 'CONFIRMED', image_hash: 'h1' });
    const recordWrite = jest.fn().mockResolvedValue(true);
    const d: any = gatewayDeps(executeCreative, recordWrite);
    const r = await handleMetaToolkitCall(
      { authorization: 'Bearer aw_test', toolName: 'call_meta_marketing_api', args: { entity_type: 'AD_CREATIVE', action: 'UPLOAD_IMAGE', params: { image_url: 'https://cdn.x/a.png' } } },
      d,
    );
    expect(r.image_hash).toBe('h1');
    expect(executeCreative).toHaveBeenCalledWith(USER, expect.objectContaining({ account_id: ACCOUNT }));
    expect(d.execute).not.toHaveBeenCalled();
    expect(recordWrite).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'AD_CREATIVE', action: 'UPLOAD_IMAGE', objectId: 'h1', verification: 'CONFIRMED' }));
  });

  it('routes zoma_prepare_upload without Meta account resolution', async () => {
    const prepareUpload = jest.fn().mockResolvedValue({ upload_url: 'u', file_url: 'f' });
    const d: any = gatewayDeps(jest.fn(), jest.fn(), prepareUpload);
    d.listAccounts = jest.fn().mockResolvedValue([]);
    const r = await handleMetaToolkitCall({ authorization: 'Bearer aw_test', toolName: 'zoma_prepare_upload', args: { filename: 'a.png' } }, d);
    expect(r.file_url).toBe('f');
    expect(prepareUpload).toHaveBeenCalledWith(USER, { filename: 'a.png' });
    expect(d.recordUsage).toHaveBeenCalledTimes(1);
  });
});

describe('isPrivateAddress', () => {
  it.each([['127.0.0.1', true], ['10.1.2.3', true], ['172.20.0.1', true], ['192.168.1.1', true], ['169.254.169.254', true], ['::1', true], ['fd00::1', true], ['::ffff:10.0.0.1', true], ['8.8.8.8', false], ['2606:4700::1', false]])(
    '%s → %s',
    (ip, expected) => expect(isPrivateAddress(ip)).toBe(expected),
  );
});

describe('E2E regressions (2026-10-26 prod run)', () => {
  it('skips the lagging ownership edge for a video it just uploaded, but not for caller ids', async () => {
    const videoStatus = jest.fn().mockResolvedValue({ status: 'ready', thumbnail_url: 't' });
    await executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_url: 'https://cdn.x/v.mp4' }), deps({ videoStatus }));
    expect(videoStatus).toHaveBeenCalledWith(USER, ACCOUNT, '998877', { justUploaded: true });
    videoStatus.mockClear();
    await executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_id: '42' }), deps({ videoStatus }));
    expect(videoStatus).toHaveBeenCalledWith(USER, ACCOUNT, '42', { justUploaded: false });
  });

  it('surfaces a video-status failure as a readable refusal', async () => {
    const d = deps({ videoStatus: jest.fn().mockRejectedValue(new Error('That video is not in the selected ad account.')) });
    await expect(executeMetaToolkitCreative(USER, call('UPLOAD_VIDEO', { video_id: '42' }), d)).rejects.toThrow(/not in the selected ad account/);
  });

  it('never returns Page or user access tokens to external agents', () => {
    const out: any = stripCredentials({ pages: [{ id: '1', name: 'P', access_token: 'EAAsecret', nested: { refresh_token: 'r', ok: 1 } }], message: 'm' });
    expect(JSON.stringify(out)).not.toMatch(/EAAsecret|refresh_token|access_token/);
    expect(out.pages[0]).toMatchObject({ id: '1', name: 'P', nested: { ok: 1 } });
  });
});
