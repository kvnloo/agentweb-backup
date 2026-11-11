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
 *   AD_CREATIVE CREATE             → creative from image_hash / image_url / video_id
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
 */
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { getAccountsByUserIdIncludingOrgShared, type ConnectedAccount } from '../services/connectedAccountsDb';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { assertZomaWriteReady, ZomaNotReadyError } from './zomaOnboarding';
import { assertAdsManagementGranted } from './metaToolkitWrites';
import { isOutcomeUnknownFailure } from './zomaWriteGuard';

export const CREATIVE_ASSET_ACTIONS = ['UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'CREATE'] as const;
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
  listAccounts: (userId: string) => Promise<ConnectedAccount[]>;
  bucket: () => string;
  presignPut: (key: string, contentType: string, expiresIn: number) => string;
  presignGet: (key: string, expiresIn: number) => string;
  headObject: (key: string) => Promise<StagedObject | null>;
  resolveHost: (host: string) => Promise<string[]>;
  uploadImage: (userId: string, url: string, accountId: string) => Promise<any>;
  uploadVideo: (userId: string, url: string, accountId: string) => Promise<any>;
  videoStatus: (userId: string, accountId: string, videoId: string, opts?: { justUploaded?: boolean }) => Promise<{ status: string; thumbnail_url?: string; error?: string }>;
  previewCreative: (userId: string, accountId: string, params: any) => Promise<any>;
  dispatch: (userId: string, dispatch: any) => Promise<{ result: any; createdId?: string }>;
  readCreative: (userId: string, accountId: string, creativeId: string) => Promise<any>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  videoWaitMs: number;
}

const ams = async () => (await import('../services/agentModeService')).agentModeService;
const s3 = async () => import('../utils/s3Utils');

const defaultDeps: MetaToolkitCreativeDeps = {
  assertReady: (userId) => assertZomaWriteReady(userId),
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
  uploadImage: async (userId, url, accountId) => (await ams()).uploadMetaAdsImage(userId, url, accountId),
  uploadVideo: async (userId, url, accountId) => (await ams()).uploadMetaAdsVideo(userId, url, accountId),
  videoStatus: async (userId, accountId, videoId, opts) => (await ams()).readToolkitMetaVideoStatus(userId, accountId, videoId, opts),
  previewCreative: async (userId, accountId, params) =>
    (await ams()).previewToolkitMetaWrite(userId, 'AD_CREATIVE', 'CREATE', accountId, undefined, undefined, undefined, params),
  dispatch: async (userId, d) => (await ams()).dispatchToolkitConfirmedMetaWrite(userId, d),
  readCreative: async (userId, accountId, creativeId) =>
    (await ams()).manageMetaAdsAdCreatives(userId, 'GET', accountId, { creative_id: creativeId }),
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
): Promise<{ fetchUrl: string; source: 'staged' | 'url' }> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new MetaToolkitRefusal(`${kind === 'image' ? 'params.image_url' : 'params.video_url'} is required: a public https URL, or the file_url returned by zoma_prepare_upload for a local file.`);
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
  return { fetchUrl: url.toString(), source: 'url' };
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
    await deps.assertReady(userId);
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
  assertAdsManagementGranted(await deps.listAccounts(userId), accountId);

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

  // CREATE
  const types = CREATIVE_TYPE_KEYS.filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '');
  if (types.length === 0) {
    throw new MetaToolkitRefusal('AD_CREATIVE CREATE needs the media: params.image_hash (from UPLOAD_IMAGE), params.image_url, or params.video_id (from UPLOAD_VIDEO) plus a thumbnail.');
  }
  for (const key of ['image_url'] as const) {
    if (typeof params[key] === 'string' && params[key]) {
      params[key] = (await resolveAssetUrl(userId, params[key], 'image', deps)).fetchUrl;
    }
  }
  if (params.video_id) {
    const st = await readVideoStatus(userId, accountId, String(params.video_id), deps, false);
    if (st.status !== 'ready') {
      return { success: false, status: 'VIDEO_NOT_READY', video_status: st.status, message: `Video ${params.video_id} is ${st.status} at Meta; the creative cannot be built until it is ready. Re-check with AD_CREATIVE UPLOAD_VIDEO params.video_id.` };
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
  return {
    success: true,
    verification: 'CONFIRMED',
    id: createdId,
    creative_id: createdId,
    creative: { id: creative.id, name: creative.name, object_story_spec: creative.object_story_spec, thumbnail_url: creative.thumbnail_url },
    message: `Creative ${createdId} created and read back. To use it, run AD CREATE with ad_set_id and params.creative_id = "${createdId}" (preview → approval; the ad is created PAUSED).`,
  };
}
