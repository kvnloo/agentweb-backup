/**
 * Zoma creative upload for external MCP agents.
 *
 * Matt's feedback (2026-10-26): Zoma could build campaign shells, set budgets and read
 * performance, but creatives made outside AgentWeb (e.g. a Higgsfield batch) still had
 * to be uploaded in Ads Manager. This module closes that gap:
 *
 *   zoma_prepare_upload            → presigned S3 PUT for a LOCAL file (the agent curls it up)
 *   AD_CREATIVE UPLOAD_IMAGE       → image (public https URL or the staged file) → image_hash
 *   AD_CREATIVE UPLOAD_VIDEO       → video (public https URL or the staged file) → video_id,
 *                                    waits for Meta processing, returns a thumbnail_url;
 *                                    with params.video_id only, re-checks processing status
 *   AD_CREATIVE CREATE             → creative from image_hash / image_url / video_id, a
 *                                    carousel (carousel_cards), placement_assets, or (ENG-2915)
 *                                    a multi-variant asset_feed_spec: headlines[] / bodies[] /
 *                                    descriptions[] (≤5 each) + image_hashes[] / video_ids[]
 *   AD_CREATIVE BULK_CREATE        → (ENG-2915) up to 10 creatives in one call, each reported
 *                                    on its own (partial success is reported, never hidden)
 *
 * None of these can spend: an uploaded asset or a creative does nothing until an AD uses
 * it, and AD CREATE stays on the guarded preview → confirm path (always PAUSED; activation
 * is its own approval). So these run directly, without a preview token, but behind the
 * same write gate as every other external write: payment method + usable Meta connection
 * + a GRANTED ads_management scope.
 *
 * Creative CREATE still runs the shared gate (validateMetaActionParams, the ENG-2232 Page
 * access preflight) via the sessionless toolkit preview, and is then dispatched exactly
 * like an approved write (dispatchToolkitConfirmedMetaWrite). It is reported done only
 * after an ownership-scoped AD_CREATIVE GET read-back.
 *
 * URL safety: the server (images) or Meta (videos) fetches the URL, so external callers
 * may only pass https URLs that resolve to public addresses, or a staged file under their
 * OWN users/<userId>/zoma-uploads/ prefix. Nothing new is persisted beyond the S3 object.
 * ENG-2915: a public URL is also probed (headers only, every redirect hop re-resolved and
 * pinned via utils/ssrfGuard) so a redirect to a private address, a web page instead of a
 * media file (a TikTok/Instagram post page), or an over-limit file is refused before upload.
 */
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import { assertAdsManagementGranted, assertMetaPageAccessForCreate } from './metaToolkitWrites';
import { MetaService } from '../services/metaService';
import { probePublicMediaUrl, SsrfBlockedError } from '../utils/ssrfGuard';
import { googleToolkitEnabled } from './zomaToolDefinitions';
import { isOutcomeUnknownFailure } from './zomaWriteGuard';

export const CREATIVE_ASSET_ACTIONS = ['UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'CREATE', 'BULK_CREATE'] as const;
/** ENG-2915: most creatives one BULK_CREATE call may build. */
export const MAX_BULK_CREATIVES = 10;
export const ZOMA_UPLOAD_PREFIX = 'zoma-uploads';
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const VIDEO_TYPES: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm' };
const CREATIVE_TYPE_KEYS = ['image_hash', 'image_url', 'video_id', 'carousel_cards', 'placement_assets'];

export function isCreativeAssetRequest(toolName: string, args: any): boolean {
  return (
    toolName === 'call_meta_marketing_api' &&
    String(args?.entity_type) === 'AD_CREATIVE' &&
    (CREATIVE_ASSET_ACTIONS as readonly string[]).includes(String(args?.action))
  );
}

export interface StagedObject {
  key: string;
  contentLength?: number;
  contentType?: string;
}

export interface MetaToolkitCreativeDeps {
  assertReady: (userId: string) => Promise<void>;
  /** zoma_prepare_upload readiness; defaults to assertReady. ENG-2928: Meta OR Google Ads. */
  assertUploadReady?: (userId: string) => Promise<void>;
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  bucket: () => string;
  presignPut: (key: string, contentType: string, expiresIn: number) => string;
  presignGet: (key: string, expiresIn: number) => string;
  headObject: (key: string) => Promise<StagedObject | null>;
  resolveHost: (host: string) => Promise<string[]>;
  /** ENG-2915: SSRF-safe header probe (redirects re-validated per hop); returns the final URL. */
  probeUrl: (url: string) => Promise<{ finalUrl: string; status: number; contentType: string; contentLength?: number }>;
  uploadImage: (userId: string, url: string, accountId: string) => Promise<any>;
  uploadVideo: (userId: string, url: string, accountId: string) => Promise<any>;
  videoStatus: (userId: string, accountId: string, videoId: string, opts?: { justUploaded?: boolean }) => Promise<{ status: string; thumbnail_url?: string; error?: string }>;
  previewCreative: (userId: string, accountId: string, params: any) => Promise<any>;
  dispatch: (userId: string, dispatch: any) => Promise<{ result: any; createdId?: string }>;
  readCreative: (userId: string, accountId: string, creativeId: string) => Promise<any>;
  /** ENG-3129: one-click Meta reconnect link for the Page-access refusal. */
  connectLink?: (userId: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  videoWaitMs: number;
}

const ams = async () => (await import('../services/agentModeService')).agentModeService;
const s3 = async () => import('../utils/s3Utils');

const defaultDeps: MetaToolkitCreativeDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId),
  // ENG-2928: a staged file can also feed a Google Ads ASSET UPLOAD, so a Google-only user may stage.
  assertUploadReady: async (userId) => {
    try {
      await assertZomaWriteReady(userId);
    } catch (error) {
      if (!(error instanceof ZomaNotReadyError) || !googleToolkitEnabled()) throw error;
      await assertZomaWriteReady(userId, undefined, 'google_ads');
    }
  },
  listAccounts: getAccountsByUserIdIncludingOrgShared,
  bucket: () => process.env.AWS_S3_BUCKET || 'agentweb-user-files',
  presignPut: () => {
    throw new Error('presignPut is resolved lazily');
  },
  presignGet: () => {
    throw new Error('presignGet is resolved lazily');
  },
  headObject: async (key) => {
    try {
      const meta: any = await (await s3()).getS3ObjectMetadata(key);
      if (!meta) return null;
      return { key, contentLength: Number(meta.ContentLength ?? meta.contentLength ?? meta.size), contentType: meta.ContentType ?? meta.contentType };
    } catch {
      return null;
    }
  },
  resolveHost: async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address),
  probeUrl: (url) => probePublicMediaUrl(url),
  uploadImage: async (userId, url, accountId) => (await ams()).uploadMetaAdsImage(userId, url, accountId),
  uploadVideo: async (userId, url, accountId) => (await ams()).uploadMetaAdsVideo(userId, url, accountId),
  videoStatus: async (userId, accountId, videoId, opts) => (await ams()).readToolkitMetaVideoStatus(userId, accountId, videoId, opts),
  previewCreative: async (userId, accountId, params) =>
    (await ams()).previewToolkitMetaWrite(userId, 'AD_CREATIVE', 'CREATE', accountId, undefined, undefined, undefined, params),
  dispatch: async (userId, d) => (await ams()).dispatchToolkitConfirmedMetaWrite(userId, d),
  readCreative: async (userId, accountId, creativeId) =>
    (await ams()).manageMetaAdsAdCreatives(userId, 'GET', accountId, { creative_id: creativeId }),
  connectLink: async (userId) => (await import('../services/metaConnectUrl')).buildMetaConnectUrl(userId, 'marketing'),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  videoWaitMs: 90_000,
};

async function withS3Defaults(deps: MetaToolkitCreativeDeps): Promise<MetaToolkitCreativeDeps> {
  if (deps !== defaultDeps) return deps;
  const mod = await s3();
  return {
    ...deps,
    presignPut: (key, contentType, expiresIn) => mod.generatePresignedPutUrl(key, contentType, deps.bucket(), expiresIn),
    presignGet: (key, expiresIn) => mod.generatePresignedUrl(key, deps.bucket(), expiresIn),
  };
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() || 'file';
  const clean = base.normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return clean.slice(-120) || 'file';
}

function userPrefix(userId: string): string {
  return `users/${userId}/${ZOMA_UPLOAD_PREFIX}/`;
}

function canonicalS3Url(bucket: string, key: string): string {
  return `https://${bucket}.s3.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Key of a staged object in OUR bucket, or null when the URL is not one. */
function stagedKeyFromUrl(bucket: string, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const b = bucket.toLowerCase();
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (host === `${b}.s3.amazonaws.com` || new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.s3[.-][a-z0-9-]+\\.amazonaws\\.com$`).test(host)) {
    return path || null;
  }
  if ((host === 's3.amazonaws.com' || /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host)) && path.startsWith(`${bucket}/`)) {
    return path.slice(bucket.length + 1) || null;
  }
  return null;
}

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

/**
 * Turn a caller-supplied asset URL into one the server/Meta may fetch. Staged files must be
 * the caller's own; anything else must be public https.
 */
async function resolveAssetUrl(
  userId: string, raw: unknown, kind: 'image' | 'video', deps: MetaToolkitCreativeDeps,
  field = kind === 'image' ? 'params.image_url' : 'params.video_url',
): Promise<{ fetchUrl: string; source: 'staged' | 'url' }> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new MetaToolkitRefusal(`${field} is required: a public https URL, or the file_url returned by zoma_prepare_upload for a local file.`);
  const bucket = deps.bucket();
  const key = stagedKeyFromUrl(bucket, value);
  if (key) {
    if (!key.startsWith(userPrefix(userId)) || key.includes('..')) {
      throw new MetaToolkitRefusal('That file was not uploaded by this account. Use zoma_prepare_upload to upload your own file first.');
    }
    const head = await deps.headObject(key);
    if (!head) throw new MetaToolkitRefusal('The staged file was not found. Run the upload command from zoma_prepare_upload first (it must finish with HTTP 200), then retry.');
    const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (head.contentLength !== undefined && Number.isFinite(head.contentLength) && head.contentLength > max) {
      throw new MetaToolkitRefusal(`That ${kind} is ${(head.contentLength / 1048576).toFixed(1)} MB; the limit is ${max / 1048576} MB.`);
    }
    if (head.contentLength === 0) throw new MetaToolkitRefusal('The staged file is empty. Re-run the upload command.');
    return { fetchUrl: deps.presignGet(key, 60 * 60), source: 'staged' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MetaToolkitRefusal('That is not a valid URL. For a file on your computer, call zoma_prepare_upload first.');
  }
  if (url.protocol !== 'https:') throw new MetaToolkitRefusal('Only https URLs are accepted. For a file on your computer, call zoma_prepare_upload first.');
  if (url.username || url.password) throw new MetaToolkitRefusal('URLs with embedded credentials are not accepted.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : await deps.resolveHost(host);
  } catch {
    throw new MetaToolkitRefusal(`Could not resolve ${host}. Check the URL, or upload the file with zoma_prepare_upload.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new MetaToolkitRefusal('That URL does not point to a public address. Upload the file with zoma_prepare_upload instead.');
  }
  return { fetchUrl: await probeAssetUrl(url.toString(), host, kind, deps), source: 'url' };
}

const OCTET_TYPES = new Set(['application/octet-stream', 'binary/octet-stream', 'application/x-binary']);

/**
 * ENG-2915: check what a public URL actually serves before the server or Meta fetches it.
 * Returns the final (post-redirect) URL; every hop was re-resolved to a public https address.
 */
async function probeAssetUrl(url: string, host: string, kind: 'image' | 'video', deps: MetaToolkitCreativeDeps): Promise<string> {
  let probe: Awaited<ReturnType<MetaToolkitCreativeDeps['probeUrl']>>;
  try {
    probe = await deps.probeUrl(url);
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new MetaToolkitRefusal('That URL (or a redirect from it) does not point to a public https address. Upload the file with zoma_prepare_upload instead.');
    }
    throw new MetaToolkitRefusal(`Could not reach ${host}: ${error instanceof Error ? error.message : 'unknown error'}. Check the URL, or upload the file with zoma_prepare_upload.`);
  }
  if (probe.status < 200 || probe.status >= 300) {
    throw new MetaToolkitRefusal(`${host} answered HTTP ${probe.status} for that URL. The ${kind} must be downloadable without a login; otherwise download it and upload it with zoma_prepare_upload.`);
  }
  const type = probe.contentType;
  if (type === 'text/html' || type === 'application/xhtml+xml') {
    throw new MetaToolkitRefusal(
      `That URL is a web page, not a ${kind} file. For a TikTok, Instagram, YouTube or other post link, use the direct ${kind === 'video' ? '.mp4' : 'image'} download link, ` +
      'or download the file and upload it with zoma_prepare_upload.',
    );
  }
  if (type && !type.startsWith(`${kind}/`) && !OCTET_TYPES.has(type)) {
    throw new MetaToolkitRefusal(`That URL serves ${type}, not a ${kind}.`);
  }
  const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (probe.contentLength !== undefined && probe.contentLength > max) {
    throw new MetaToolkitRefusal(`That ${kind} is ${(probe.contentLength / 1048576).toFixed(1)} MB; the limit is ${max / 1048576} MB.`);
  }
  if (probe.contentLength === 0) throw new MetaToolkitRefusal(`That URL serves an empty file.`);
  return probe.finalUrl;
}

/**
 * ENG-2928: the same URL rule for a Google Ads image asset — the caller's own staged file
 * (re-signed for a short-lived fetch) or a public https URL. Returns the URL to fetch.
 */
export async function resolveZomaImageUrl(userId: string, raw: unknown, field: string, depsIn: MetaToolkitCreativeDeps = defaultDeps): Promise<string> {
  const deps = await withS3Defaults(depsIn);
  return (await resolveAssetUrl(userId, raw, 'image', deps, field)).fetchUrl;
}

/** zoma_prepare_upload: presigned PUT for a local file under the caller's own prefix. */
export async function prepareZomaUpload(userId: string, args: any, depsIn: MetaToolkitCreativeDeps = defaultDeps) {
  const deps = await withS3Defaults(depsIn);
  const filename = sanitizeFilename(String(args?.filename ?? ''));
  const ext = extOf(filename);
  const contentType = IMAGE_TYPES[ext] ?? VIDEO_TYPES[ext];
  if (!args?.filename || !contentType) {
    throw new MetaToolkitRefusal(
      `filename must end in one of: ${[...Object.keys(IMAGE_TYPES), ...Object.keys(VIDEO_TYPES)].map((e) => `.${e}`).join(', ')}.`,
    );
  }
  const kind = IMAGE_TYPES[ext] ? 'image' : 'video';
  const size = args?.size_bytes === undefined ? undefined : Number(args.size_bytes);
  const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (size !== undefined && (!Number.isFinite(size) || size <= 0 || size > max)) {
    throw new MetaToolkitRefusal(`size_bytes must be between 1 and ${max} for a ${kind}.`);
  }
  try {
    await (deps.assertUploadReady ?? deps.assertReady)(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }
  const key = `${userPrefix(userId)}${deps.now()}-${crypto.randomBytes(8).toString('hex')}/${filename}`;
  const uploadUrl = deps.presignPut(key, contentType, UPLOAD_URL_TTL_SECONDS);
  const fileUrl = canonicalS3Url(deps.bucket(), key);
  const action = kind === 'image' ? 'UPLOAD_IMAGE' : 'UPLOAD_VIDEO';
  const urlParam = kind === 'image' ? 'image_url' : 'video_url';
  return {
    kind,
    upload_url: uploadUrl,
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    file_url: fileUrl,
    expires_in: UPLOAD_URL_TTL_SECONDS,
    upload_command: `curl -sS --fail -X PUT -H 'Content-Type: ${contentType}' --upload-file '<path to ${filename}>' '${uploadUrl}'`,
    next_step:
      `Run upload_command with the real local path (it prints nothing on success). Then call call_meta_marketing_api with ` +
      `entity_type AD_CREATIVE, action ${action}, params.${urlParam} = file_url. The upload URL expires in 15 minutes and only accepts Content-Type ${contentType}.`,
  };
}

function refuseForbidden(params: any) {
  for (const key of ['confirm', 'override_tracking_check', 'tracking_override_token', 'budget_confirmation_token']) {
    if (params[key] !== undefined) throw new MetaToolkitRefusal(`params.${key} is not available to external Meta Toolkit callers.`);
  }
}

/** Video status as a refusal the agent can read, not an opaque 500. */
async function readVideoStatus(userId: string, accountId: string, videoId: string, deps: MetaToolkitCreativeDeps, justUploaded: boolean) {
  try {
    return await deps.videoStatus(userId, accountId, videoId, { justUploaded });
  } catch (error: any) {
    const meta = error?.response?.data?.error?.message;
    throw new MetaToolkitRefusal(`Could not read video ${videoId}: ${meta || (error instanceof Error ? error.message : 'unknown error')}`);
  }
}

async function waitForVideo(userId: string, accountId: string, videoId: string, deps: MetaToolkitCreativeDeps, justUploaded = false) {
  const deadline = deps.now() + deps.videoWaitMs;
  let last = await readVideoStatus(userId, accountId, videoId, deps, justUploaded);
  while (last.status === 'processing' && deps.now() < deadline) {
    await deps.sleep(5000);
    last = await readVideoStatus(userId, accountId, videoId, deps, justUploaded);
  }
  return last;
}

function videoResult(videoId: string, st: { status: string; thumbnail_url?: string; error?: string }) {
  if (st.status === 'ready') {
    return {
      success: true,
      verification: 'CONFIRMED',
      video_id: videoId,
      video_status: 'ready',
      thumbnail_url: st.thumbnail_url ?? null,
      message:
        `Video ${videoId} is uploaded and processed by Meta.` +
        (st.thumbnail_url
          ? ' Use video_id plus image_url = thumbnail_url (or your own thumbnail via UPLOAD_IMAGE) in AD_CREATIVE CREATE.'
          : ' Meta returned no thumbnail yet; upload a thumbnail with UPLOAD_IMAGE and pass its image_hash in AD_CREATIVE CREATE.'),
    };
  }
  if (st.status === 'processing') {
    // ENG-2931: still processing is not a confirmed upload outcome, so never success.
    return {
      success: false,
      verification: 'UNCONFIRMED',
      video_id: videoId,
      video_status: 'processing',
      message: `Video ${videoId} is uploaded but Meta is still processing it. Do not create the creative yet. Re-check with AD_CREATIVE UPLOAD_VIDEO and params.video_id = "${videoId}" (no video_url) in a minute.`,
    };
  }
  return {
    success: false,
    verification: 'MISMATCH',
    video_id: videoId,
    video_status: st.status,
    message: `Meta could not process video ${videoId}${st.error ? `: ${st.error}` : ''}. Check the file (MP4/MOV, H.264) and upload it again.`,
  };
}

/** Execute one creative-asset call. `args.account_id` is already the resolved, owned account. */
export async function executeMetaToolkitCreative(userId: string, rawArgs: any, depsIn: MetaToolkitCreativeDeps = defaultDeps) {
  const deps = await withS3Defaults(depsIn);
  const { confirm: _c, preview_token: _p, ...args } = rawArgs ?? {};
  const action = String(args.action);
  const accountId = String(args.account_id ?? '');
  if (args.client_id !== undefined) throw new MetaToolkitRefusal('client_id is not available to external Meta Toolkit callers.');
  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params) ? { ...args.params } : {};
  refuseForbidden(params);

  try {
    await deps.assertReady(userId);
  } catch (error) {
    if (error instanceof ZomaNotReadyError) throw new MetaToolkitRefusal(error.message);
    throw error;
  }
  const accounts = await deps.listAccounts(userId);
  assertAdsManagementGranted(accounts, accountId);
  // ENG-3129: a creative needs a Page; refuse before any upload/preview reaches Meta. Uploads stay ungated.
  if (action === 'CREATE' || action === 'BULK_CREATE') {
    await assertMetaPageAccessForCreate(accounts, accountId, {
      pageId: typeof params.page_id === 'string' ? params.page_id : undefined,
      connectLink: deps.connectLink && (() => deps.connectLink!(userId)),
    });
  }

  if (action === 'UPLOAD_IMAGE') {
    const { fetchUrl } = await resolveAssetUrl(userId, params.image_url, 'image', deps);
    const result = await deps.uploadImage(userId, fetchUrl, accountId);
    if (!result?.success || !result.image_hash) {
      return { success: false, status: 'FAILED', message: String(result?.message || result?.error || 'Meta did not accept the image.'), meta_error: result?.meta_error };
    }
    return {
      success: true,
      verification: 'CONFIRMED',
      image_hash: result.image_hash,
      meta_image_url: result.image_url ?? null,
      message: `Image uploaded to the ad account's media library. image_hash ${result.image_hash} — pass it as params.image_hash to AD_CREATIVE CREATE.`,
    };
  }

  if (action === 'UPLOAD_VIDEO') {
    if (params.video_id && !params.video_url) {
      const videoId = String(params.video_id);
      if (!/^\d+$/.test(videoId)) throw new MetaToolkitRefusal('params.video_id must be a Meta video id.');
      return videoResult(videoId, await waitForVideo(userId, accountId, videoId, deps));
    }
    const { fetchUrl } = await resolveAssetUrl(userId, params.video_url, 'video', deps);
    const result = await deps.uploadVideo(userId, fetchUrl, accountId);
    const videoId = result?.video?.id ? String(result.video.id) : '';
    if (!result?.success || !videoId) {
      return { success: false, status: 'FAILED', message: String(result?.message || result?.error || 'Meta did not accept the video.') };
    }
    return videoResult(videoId, await waitForVideo(userId, accountId, videoId, deps, true));
  }

  if (action === 'BULK_CREATE') return bulkCreateCreatives(userId, accountId, params, deps);
  return createCreative(userId, accountId, params, deps);
}

const refusal = (error: unknown) =>
  error instanceof MetaToolkitRefusal ? error : new MetaToolkitRefusal(error instanceof Error ? error.message : String(error));

/** A ready video, or the not-ready result to return instead. */
async function requireReadyVideo(userId: string, accountId: string, videoId: string, deps: MetaToolkitCreativeDeps, label = `Video ${videoId}`) {
  if (!/^\d+$/.test(videoId)) throw new MetaToolkitRefusal(`${label}: video_id must be a Meta video id.`);
  const st = await readVideoStatus(userId, accountId, videoId, deps, false);
  if (st.status !== 'ready') {
    return {
      notReady: {
        success: false,
        status: 'VIDEO_NOT_READY',
        video_id: videoId,
        video_status: st.status,
        message: `${label} is ${st.status} at Meta; the creative cannot be built until it is ready. Re-check with AD_CREATIVE UPLOAD_VIDEO params.video_id.`,
      },
    };
  }
  return { thumbnailUrl: st.thumbnail_url };
}

/** ENG-2915: what Meta must have stored for the creative to match what was sent. */
function shapeMismatches(sent: any, creative: any): string[] {
  const out: string[] = [];
  const afs = creative?.asset_feed_spec;
  const count = (v: any) => (Array.isArray(v) ? v.length : 0);
  if (MetaService.isMultiVariantCreative(sent)) {
    const expected: Array<[string, number]> = [
      ['titles', count(sent.headlines)], ['bodies', count(sent.bodies)], ['descriptions', count(sent.descriptions)],
      ['images', count(sent.image_hashes)], ['videos', count(sent.video_ids)],
    ];
    for (const [field, n] of expected) {
      if (count(afs?.[field]) !== n) out.push(`asset_feed_spec.${field}: sent ${n}, Meta has ${count(afs?.[field])}`);
    }
  } else if (Array.isArray(sent.carousel_cards)) {
    const n = count(creative?.object_story_spec?.link_data?.child_attachments);
    if (n !== sent.carousel_cards.length) out.push(`carousel cards: sent ${sent.carousel_cards.length}, Meta has ${n}`);
  } else if (Array.isArray(sent.placement_assets)) {
    if (count(afs?.images) !== sent.placement_assets.length) out.push(`placement images: sent ${sent.placement_assets.length}, Meta has ${count(afs?.images)}`);
  }
  return out;
}

/** One AD_CREATIVE CREATE. Throws MetaToolkitRefusal for caller errors; returns a verdict otherwise. */
async function createCreative(userId: string, accountId: string, input: any, deps: MetaToolkitCreativeDeps): Promise<any> {
  let params = { ...input };
  if (params.video_url !== undefined) {
    throw new MetaToolkitRefusal('AD_CREATIVE CREATE takes params.video_id. Upload the video first with UPLOAD_VIDEO (params.video_url), or use BULK_CREATE, whose items accept video_url.');
  }
  if (MetaService.isMultiVariantCreative(params)) {
    let variants;
    try {
      variants = MetaService.normalizeMultiVariantCreative(params, { requireThumbnails: false });
    } catch (error) {
      throw refusal(error);
    }
    const supplied = params.video_thumbnails && typeof params.video_thumbnails === 'object' ? params.video_thumbnails : {};
    const thumbnails: Record<string, string> = {};
    for (const videoId of variants.video_ids) {
      const ready = await requireReadyVideo(userId, accountId, videoId, deps);
      if (ready.notReady) return ready.notReady;
      if (typeof supplied[videoId] === 'string' && supplied[videoId]) {
        thumbnails[videoId] = (await resolveAssetUrl(userId, supplied[videoId], 'image', deps)).fetchUrl;
      } else if (ready.thumbnailUrl) {
        thumbnails[videoId] = ready.thumbnailUrl;
      } else {
        throw new MetaToolkitRefusal(`Meta has no thumbnail for video ${videoId} yet. Upload one with UPLOAD_IMAGE and pass its URL as params.video_thumbnails["${videoId}"].`);
      }
    }
    const { title: _t, body: _b, description: _d, image_hash: _ih, video_id: _v, ...rest } = params;
    params = { ...rest, ...variants, video_thumbnails: thumbnails };
    try {
      MetaService.validateCreativeParams('CREATE', params);
    } catch (error) {
      throw refusal(error);
    }
  } else {
    const types = CREATIVE_TYPE_KEYS.filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '');
    if (types.length === 0) {
      throw new MetaToolkitRefusal(
        'AD_CREATIVE CREATE needs the media: params.image_hash (from UPLOAD_IMAGE), params.image_url, params.video_id (from UPLOAD_VIDEO), ' +
        'params.carousel_cards, params.placement_assets, or the multi-variant lists (image_hashes / video_ids with headlines / bodies).',
      );
    }
    if (typeof params.image_url === 'string' && params.image_url) {
      params.image_url = (await resolveAssetUrl(userId, params.image_url, 'image', deps)).fetchUrl;
    }
    // Carousel cards and placement assets carry their own media; no top-level image is needed.
    if (params.carousel_cards !== undefined) {
      if (!Array.isArray(params.carousel_cards)) throw new MetaToolkitRefusal('params.carousel_cards must be an array of 2–10 cards.');
      const cards = [];
      for (let i = 0; i < params.carousel_cards.length; i++) {
        const card = params.carousel_cards[i];
        if (!card || typeof card !== 'object' || Array.isArray(card)) throw new MetaToolkitRefusal(`carousel_cards[${i}] must be an object.`);
        const next = { ...card };
        if (!next.link_url && !params.link_url) {
          throw new MetaToolkitRefusal(`carousel_cards[${i}] needs a link_url (or set params.link_url for every card).`);
        }
        if (typeof next.image_url === 'string' && next.image_url) {
          next.image_url = (await resolveAssetUrl(userId, next.image_url, 'image', deps)).fetchUrl;
        }
        if (next.video_id) {
          const ready = await requireReadyVideo(userId, accountId, String(next.video_id), deps, `carousel_cards[${i}] video ${next.video_id}`);
          if (ready.notReady) return ready.notReady;
          if (!next.image_hash && !next.image_url && ready.thumbnailUrl) next.image_url = ready.thumbnailUrl;
        }
        cards.push(next);
      }
      params.carousel_cards = cards;
    }
    if (params.placement_assets !== undefined) {
      if (!Array.isArray(params.placement_assets)) throw new MetaToolkitRefusal('params.placement_assets must be an array.');
      const assets = [];
      for (let i = 0; i < params.placement_assets.length; i++) {
        const asset = params.placement_assets[i];
        if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new MetaToolkitRefusal(`placement_assets[${i}] must be an object.`);
        const next = { ...asset };
        if (typeof next.image_url === 'string' && next.image_url) {
          next.image_url = (await resolveAssetUrl(userId, next.image_url, 'image', deps)).fetchUrl;
        }
        assets.push(next);
      }
      params.placement_assets = assets;
    }
    if (params.video_id) {
      const ready = await requireReadyVideo(userId, accountId, String(params.video_id), deps);
      if (ready.notReady) return ready.notReady;
      // Meta's own processed thumbnail is a valid video thumbnail when the caller supplied none.
      if (!params.image_hash && !params.image_url && ready.thumbnailUrl) params.image_url = ready.thumbnailUrl;
    }
  }

  const preview = await deps.previewCreative(userId, accountId, params);
  if (!preview?.awaitingUserConfirmation || !preview.metaWriteDispatch) {
    return { success: false, status: 'FAILED', message: `Not created, nothing was sent to Meta: ${String(preview?.error || preview?.message || 'the creative could not be prepared.')}` };
  }
  // ENG-2931: a transport throw, or an accepted request with no id, may still have created the
  // creative at Meta: UNCONFIRMED (check before retrying), never success and never "not created".
  let dispatched: { result: any; createdId?: string | null };
  try {
    dispatched = await deps.dispatch(userId, preview.metaWriteDispatch);
  } catch (error: unknown) {
    return {
      success: false,
      verification: 'UNCONFIRMED',
      id: null,
      message: `UNCONFIRMED: the creative request failed without a definite answer from Meta (${error instanceof Error ? error.message : String(error)}), so it may or may not have been created. List the account's creatives before retrying.`,
    };
  }
  const { result, createdId } = dispatched;
  if (isOutcomeUnknownFailure(result)) {
    // ENG-2931: the wrapper caught a transport failure; the creative may exist at Meta.
    return {
      success: false,
      verification: 'UNCONFIRMED',
      id: null,
      message: `UNCONFIRMED: the creative request failed without a definite answer from Meta (${String(result?.error || result?.message)}), so it may or may not have been created. List the account's creatives before retrying.`,
    };
  }
  if (!result?.success || result?.blocked || result?.throttled) {
    return { success: false, status: 'FAILED', message: String(result?.error || result?.message || 'Meta did not create the creative.') };
  }
  if (!createdId) {
    return {
      success: false,
      verification: 'UNCONFIRMED',
      id: null,
      message: 'UNCONFIRMED: Meta accepted the creative request but returned no creative id. List the account\'s creatives before retrying.',
    };
  }
  const read = await deps.readCreative(userId, accountId, createdId).catch(() => null);
  const creative = read?.creative;
  if (!read?.success || String(creative?.id) !== String(createdId)) {
    return {
      success: false,
      verification: 'UNCONFIRMED',
      id: createdId,
      creative_id: createdId,
      message: `UNCONFIRMED: Meta returned creative ${createdId}, but reading it back failed. Check it with AD_CREATIVE GET before using it.`,
    };
  }
  const summary = {
    id: creative.id, name: creative.name, object_story_spec: creative.object_story_spec,
    ...(creative.asset_feed_spec ? { asset_feed_spec: creative.asset_feed_spec } : {}),
    thumbnail_url: creative.thumbnail_url,
  };
  const mismatches = shapeMismatches(params, creative);
  if (mismatches.length > 0) {
    return {
      success: false,
      verification: 'MISMATCH',
      id: createdId,
      creative_id: createdId,
      creative: summary,
      mismatches,
      message: `MISMATCH: Meta created creative ${createdId}, but it does not hold what was sent (${mismatches.join('; ')}). Do not use it in an ad; check it with AD_CREATIVE GET.`,
    };
  }
  return {
    success: true,
    verification: 'CONFIRMED',
    id: createdId,
    creative_id: createdId,
    creative: summary,
    message: `Creative ${createdId} created and read back. To use it, run AD CREATE with ad_set_id and params.creative_id = "${createdId}" (preview → approval; the ad is created PAUSED).`,
  };
}

/**
 * ENG-2915: up to 10 creatives in one call. params.items is the per-creative list (media plus
 * any per-item overrides); every other params key is shared by all items. An item may carry
 * video_url: all such videos are uploaded first and awaited against ONE shared deadline, so a
 * batch waits about as long as a single upload. Each item is reported on its own; a failed item
 * never hides a created one.
 */
async function bulkCreateCreatives(userId: string, accountId: string, params: any, deps: MetaToolkitCreativeDeps) {
  const { items, ...shared } = params;
  if (!Array.isArray(items) || items.length === 0) {
    throw new MetaToolkitRefusal(`AD_CREATIVE BULK_CREATE needs params.items: 1–${MAX_BULK_CREATIVES} creatives, each with its media (image_hash, image_url, video_id, video_url, or the multi-variant lists).`);
  }
  if (items.length > MAX_BULK_CREATIVES) {
    throw new MetaToolkitRefusal(`AD_CREATIVE BULK_CREATE takes at most ${MAX_BULK_CREATIVES} items per call (got ${items.length}). Split the batch.`);
  }
  if (shared.video_url !== undefined) throw new MetaToolkitRefusal('params.video_url belongs on each item in params.items.');
  if (shared.name !== undefined && typeof shared.name !== 'string') throw new MetaToolkitRefusal('params.name must be a string.');

  const merged: Array<{ params?: any; error?: any }> = items.map((item: any, i: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { error: new MetaToolkitRefusal(`items[${i}] must be an object.`) };
    if (item.items !== undefined) return { error: new MetaToolkitRefusal(`items[${i}] cannot contain items.`) };
    try {
      refuseForbidden(item);
    } catch (error) {
      return { error };
    }
    const name = item.name ?? (shared.name ? `${shared.name} ${i + 1}` : undefined);
    return { params: { ...shared, ...item, ...(name !== undefined ? { name } : {}) } };
  });

  // Upload every video_url first, then wait for all of them together.
  const pending: Array<{ index: number; videoId: string }> = [];
  for (let i = 0; i < merged.length; i++) {
    const entry = merged[i];
    if (!entry.params || entry.params.video_url === undefined) continue;
    try {
      if (entry.params.video_id) throw new MetaToolkitRefusal(`items[${i}]: pass video_url or video_id, not both.`);
      const { fetchUrl } = await resolveAssetUrl(userId, entry.params.video_url, 'video', deps);
      const result = await deps.uploadVideo(userId, fetchUrl, accountId);
      const videoId = result?.video?.id ? String(result.video.id) : '';
      if (!result?.success || !videoId) throw new MetaToolkitRefusal(String(result?.message || result?.error || 'Meta did not accept the video.'));
      const { video_url: _u, ...rest } = entry.params;
      entry.params = { ...rest, video_id: videoId };
      pending.push({ index: i, videoId });
    } catch (error) {
      entry.error = error;
    }
  }
  const deadline = deps.now() + deps.videoWaitMs;
  let waiting = [...pending];
  while (waiting.length > 0) {
    const still: typeof waiting = [];
    for (const p of waiting) {
      try {
        const st = await readVideoStatus(userId, accountId, p.videoId, deps, true);
        if (st.status === 'processing') still.push(p);
        else if (st.status !== 'ready') merged[p.index].error = new MetaToolkitRefusal(videoResult(p.videoId, st).message);
      } catch (error) {
        merged[p.index].error = error;
      }
    }
    waiting = still;
    if (waiting.length === 0 || deps.now() >= deadline) break;
    await deps.sleep(5000);
  }
  const processing = new Set(waiting.map((p) => p.index));

  const results: any[] = [];
  for (let i = 0; i < merged.length; i++) {
    const entry = merged[i];
    const name = entry.params?.name;
    if (entry.error) {
      const refused = entry.error instanceof MetaToolkitRefusal;
      results.push({ index: i, ...(name ? { name } : {}), success: false, status: refused ? 'REFUSED' : 'FAILED', message: entry.error instanceof Error ? entry.error.message : String(entry.error) });
      continue;
    }
    if (processing.has(i)) {
      const videoId = String(entry.params.video_id);
      results.push({
        index: i, ...(name ? { name } : {}), success: false, status: 'VIDEO_NOT_READY', video_id: videoId, video_status: 'processing',
        message: `Video ${videoId} was uploaded but Meta is still processing it. Re-check with UPLOAD_VIDEO params.video_id, then CREATE this item with params.video_id = "${videoId}" (do not upload it again).`,
      });
      continue;
    }
    try {
      results.push({ index: i, ...(name ? { name } : {}), ...(await createCreative(userId, accountId, entry.params, deps)) });
    } catch (error) {
      const refused = error instanceof MetaToolkitRefusal;
      results.push({ index: i, ...(name ? { name } : {}), success: false, status: refused ? 'REFUSED' : 'FAILED', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const confirmed = results.filter((r) => r.verification === 'CONFIRMED').length;
  const created = results.filter((r) => r.creative_id).length;
  const status = confirmed === results.length ? 'ALL_CONFIRMED' : created > 0 ? 'PARTIAL' : 'NONE_CREATED';
  return {
    success: created > 0,
    status,
    requested: results.length,
    created,
    confirmed,
    failed: results.length - created,
    results,
    message:
      `${created} of ${results.length} creatives created (${confirmed} read back CONFIRMED).` +
      (status === 'ALL_CONFIRMED'
        ? ' Use each creative_id in AD CREATE (preview → approval; ads are created PAUSED).'
        : ' Check each item: only items with verification CONFIRMED are ready to use. Do not re-create items that have a creative_id; retry the others on their own with CREATE.'),
  };
}
