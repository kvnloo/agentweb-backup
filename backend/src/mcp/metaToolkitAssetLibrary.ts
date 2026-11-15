/**
 * ENG-3032 (ENG-2915 slice 2) — read-only lists of the ad account's creative asset libraries.
 *
 *   ads_get_ad_images   GET act_<id>/adimages   (AdImage nodes: hash, name, url, width, height, status)
 *   ads_get_ad_videos   GET act_<id>/advideos   (Video nodes: id, title, status, length, picture)
 *
 * Meta references:
 *   https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/adimages
 *   https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/advideos
 *
 * Reads only: no preview, no write gate, no storage. The ad account is resolved by the gateway
 * with the same ownership rule as every other toolkit call, and the read goes through the
 * account's own `act_<id>` edge, so a caller cannot list a foreign account's library.
 * Paging is one page per call: Graph's `paging.next` URL embeds the access token, so only the
 * opaque `after` cursor is handed back.
 */

import { MetaToolkitRefusal } from './metaToolkitErrors';

export const META_ASSET_LIBRARY_TOOL_NAMES = ['ads_get_ad_images', 'ads_get_ad_videos'] as const;
export type MetaAssetLibraryToolName = (typeof META_ASSET_LIBRARY_TOOL_NAMES)[number];

export function isMetaAssetLibraryTool(name: string): name is MetaAssetLibraryToolName {
  return (META_ASSET_LIBRARY_TOOL_NAMES as readonly string[]).includes(name);
}

export const DEFAULT_ASSET_PAGE = 25;
export const MAX_ASSET_PAGE = 100;

const PAGING_PROPERTIES = {
  account_id: { type: 'string', description: 'Optional Meta ad account id; defaults to the only connected account.' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_ASSET_PAGE, description: `Items per page (default ${DEFAULT_ASSET_PAGE}).` },
  after: { type: 'string', description: 'next_cursor from the previous page. Omit for the first page.' },
};

export const META_ASSET_LIBRARY_TOOL_DEFINITIONS = [
  {
    name: 'ads_get_ad_images',
    description:
      "Read-only list of the images in the ad account's image library: image_hash, name, url, width, height and status. " +
      'Use it to find the image_hash of an image that is already uploaded before creating a creative, instead of uploading it again. ' +
      'One page per call; pass next_cursor as `after` to get the next page.',
    inputSchema: { type: 'object', properties: PAGING_PROPERTIES, additionalProperties: false },
  },
  {
    name: 'ads_get_ad_videos',
    description:
      "Read-only list of the videos in the ad account's video library: video_id, title, status (ready, processing or error), length_seconds and thumbnail_url. " +
      'Use it to find the video_id of a video that is already uploaded, and to check it has finished processing, before creating a creative. ' +
      'One page per call; pass next_cursor as `after` to get the next page.',
    inputSchema: { type: 'object', properties: PAGING_PROPERTIES, additionalProperties: false },
  },
];

export const AD_IMAGE_FIELDS = 'hash,name,url,width,height,status';
export const AD_VIDEO_FIELDS = 'id,title,status,length,picture';

const ALLOWED_ARGS = new Set(Object.keys(PAGING_PROPERTIES));
/** Graph cursors are opaque base64-style tokens; nothing that could carry a second parameter. */
const CURSOR = /^[A-Za-z0-9_\-=]{1,512}$/;

/** Throws before any Graph read when an argument is unknown or malformed. */
export function parseAssetLibraryArgs(args: any): { limit: number; after?: string } {
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    throw new MetaToolkitRefusal('Arguments must be an object.');
  }
  const unknown = Object.keys(args ?? {}).filter((k) => !ALLOWED_ARGS.has(k));
  if (unknown.length) throw new MetaToolkitRefusal(`Unknown argument(s): ${unknown.join(', ')}. Allowed: account_id, limit, after.`);
  let limit = DEFAULT_ASSET_PAGE;
  if (args?.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_ASSET_PAGE) {
      throw new MetaToolkitRefusal(`limit must be an integer from 1 to ${MAX_ASSET_PAGE}.`);
    }
    limit = args.limit;
  }
  if (args?.after === undefined) return { limit };
  if (typeof args.after !== 'string' || !CURSOR.test(args.after)) {
    throw new MetaToolkitRefusal('after must be the next_cursor returned by the previous page.');
  }
  return { limit, after: args.after };
}

function numberOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const rowsOf = (res: any): any[] => (Array.isArray(res?.data) ? res.data : []).filter((r: any) => r && typeof r === 'object' && !Array.isArray(r));

/** Only when Meta says there is another page; the `next` URL itself carries the access token. */
function nextCursor(res: any): string | undefined {
  const after = res?.paging?.cursors?.after;
  return res?.paging?.next && typeof after === 'string' && CURSOR.test(after) ? after : undefined;
}

export function summarizeAdImages(accountId: string, res: any) {
  const images = rowsOf(res).map((r) => ({
    image_hash: stringOrNull(r.hash),
    name: stringOrNull(r.name),
    url: stringOrNull(r.url),
    width: numberOrNull(r.width),
    height: numberOrNull(r.height),
    status: stringOrNull(r.status),
  }));
  const cursor = nextCursor(res);
  return { account_id: accountId, images, count: images.length, ...(cursor ? { next_cursor: cursor } : {}) };
}

export function summarizeAdVideos(accountId: string, res: any) {
  const videos = rowsOf(res).map((r) => ({
    video_id: r.id === undefined || r.id === null ? null : String(r.id),
    title: stringOrNull(r.title),
    // Video.status is an object ({ video_status: 'ready' | 'processing' | 'error', ... }).
    status: stringOrNull(r.status?.video_status) ?? stringOrNull(r.status),
    length_seconds: numberOrNull(r.length),
    thumbnail_url: stringOrNull(r.picture),
  }));
  const cursor = nextCursor(res);
  return { account_id: accountId, videos, count: videos.length, ...(cursor ? { next_cursor: cursor } : {}) };
}

export interface MetaAssetLibraryDeps {
  /** GET act_<accountId>/<edge>, ownership-scoped by the account node. */
  readAccountGraph: (userId: string, accountId: string, edge: 'adimages' | 'advideos', params: Record<string, string>) => Promise<any>;
}

const defaultDeps: MetaAssetLibraryDeps = {
  readAccountGraph: async (userId, accountId, edge, params) => {
    const { agentModeService } = await import('../services/agentModeService');
    return agentModeService.readToolkitMetaAccountGraph(userId, accountId, edge, params);
  },
};

export async function runMetaAssetLibraryTool(
  name: MetaAssetLibraryToolName,
  userId: string,
  accountId: string,
  args: any,
  deps: MetaAssetLibraryDeps = defaultDeps,
) {
  const { limit, after } = parseAssetLibraryArgs(args);
  const images = name === 'ads_get_ad_images';
  const params: Record<string, string> = { fields: images ? AD_IMAGE_FIELDS : AD_VIDEO_FIELDS, limit: String(limit) };
  if (after) params.after = after;
  let res: any;
  try {
    res = await deps.readAccountGraph(userId, accountId, images ? 'adimages' : 'advideos', params);
  } catch (error: any) {
    // Re-thrown as a refusal with Meta's own message only (never the request, which holds the token).
    throw new MetaToolkitRefusal(`Could not read the ${images ? 'image' : 'video'} library from Meta: ${error?.metaError?.message || error?.message || 'Meta request failed'}.`);
  }
  return images ? summarizeAdImages(accountId, res) : summarizeAdVideos(accountId, res);
}
