import axios from 'axios';
import { userDb, orgDb } from './db';
import { decryptPassword } from '../utils/crypto';
import { getForeplayApiKey } from '../utils/secretsManager';
import { isFeatureEffectivelyEnabled } from './orgShareService';

const FOREPLAY_API = 'https://public.api.foreplay.co';

export interface ForeplayBoard {
  id: string;
  name: string;
  description?: string;
}

export interface ForeplayAdCard {
  ctaText: string;
  description: string;
  headline: string;
  image: string;
  video: string;
  title: string;
  type: string;
  transcription: string;
}

export interface ForeplayAd {
  id: string;
  adId: string;
  name: string;
  brandName: string;
  brandId: string;
  description: string;
  headline: string;
  ctaTitle: string;
  ctaType: string;
  displayFormat: string;
  publisherPlatform: string[];
  linkUrl: string;
  live: boolean;
  categories: string[];
  niches: string[];
  languages: string[];
  marketTarget: string;
  creativeTargeting: string;
  productCategory: string;
  startedRunning: number | string;
  runningDuration: { days: number; hours: number; minutes: number };
  thumbnail: string;
  video: string;
  image: string;
  avatar: string;
  transcription: string;
  cards: ForeplayAdCard[];
  savedAt?: string;
}

export interface ForeplayUsage {
  creditsUsed: number;
  creditsRemaining: number;
  plan: string;
}

// ─── In-memory cache ─────────────────────────────────────────────────────────
// Keys are the decrypted API token (unique per user). TTL 5 minutes.

const FOREPLAY_CACHE_TTL_MS = 5 * 60 * 1000;

const boardsCache = new Map<string, { data: ForeplayBoard[]; expiresAt: number }>();
const boardAdsCache = new Map<string, { data: ForeplayAd[]; expiresAt: number }>();
const swipefileCache = new Map<string, { data: { ads: ForeplayAd[]; cursor?: string }; expiresAt: number }>();

/**
 * Clear all cached Foreplay data for a given API token.
 * Call this when a user disconnects their Foreplay account.
 */
export function clearForeplayCacheForToken(token: string): void {
  boardsCache.delete(token);
  for (const key of boardAdsCache.keys()) {
    if (key.startsWith(`${token}:`)) boardAdsCache.delete(key);
  }
  for (const key of swipefileCache.keys()) {
    if (key.startsWith(`${token}:`)) swipefileCache.delete(key);
  }
}

/**
 * Get the Foreplay API token for a user.
 *
 * Resolution order:
 *   1. If the user belongs to an org AND is entitled to the org's knowledgeBase
 *      feature (org owner, KB editor, or sharing toggle on), use the org token.
 *   2. Fall back to user.secrets.foreplay_api_token (solo users or per-user tokens).
 *   3. Fall back to platform-wide key from Secrets Manager.
 *
 * Returns null only if none of the above exist.
 *
 * SECURITY: this is an authorization boundary. The org token must NOT be handed
 * to a plain org member when shareSettings.knowledgeBase is off — otherwise they
 * could read the org's Foreplay data the admin chose to keep private. Any new
 * caller that needs the org token must go through this gate.
 */
export async function getAccessToken(userId: string): Promise<string | null> {
  const user = await userDb.getUserById(userId);

  // 1. Org-level token — gated on the caller's knowledgeBase entitlement.
  if (user?.orgId) {
    try {
      const org = await orgDb.getOrgById(user.orgId);
      const entitled = isFeatureEffectivelyEnabled(
        { userId, orgId: user.orgId, orgRole: user.orgRole as 'owner' | 'member' | undefined },
        org,
        'knowledgeBase',
      );
      if (entitled) {
        const orgEncrypted = (org?.secrets as Record<string, string> | undefined)?.foreplay_api_token;
        if (orgEncrypted) {
          const decrypted = decryptPassword(orgEncrypted);
          return decrypted.password;
        }
      }
    } catch {
      // fall through to user-level token
    }
  }

  // 2. Per-user token fallback
  const secrets = (user?.secrets as Record<string, string>) || {};
  if (secrets.foreplay_api_token) {
    try {
      const decrypted = decryptPassword(secrets.foreplay_api_token);
      return decrypted.password;
    } catch {
      // fall through to platform key
    }
  }

  // 3. Platform-wide key from Secrets Manager
  return getForeplayApiKey();
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function mapCard(card: any): ForeplayAdCard {
  return {
    ctaText: card.cta_text || '',
    description: card.description || '',
    headline: card.headline || card.title || '',
    image: card.image || '',
    video: card.video || '',
    title: card.title || '',
    type: card.type || '',
    transcription: card.full_transcription || '',
  };
}

function mapAd(ad: any): ForeplayAd {
  const cards = (ad.cards || []).map(mapCard);
  // For DCO ads, top-level description/headline may be null — pull from first card
  const firstCard = cards[0];
  const description = ad.description || firstCard?.description || '';
  const headline = ad.headline || firstCard?.headline || '';

  return {
    id: ad.id || '',
    adId: ad.ad_id || '',
    name: ad.name || '',
    brandName: ad.name || '',
    brandId: ad.brand_id || '',
    description,
    headline,
    ctaTitle: ad.cta_title || firstCard?.ctaText || '',
    ctaType: ad.cta_type || '',
    displayFormat: ad.display_format || '',
    publisherPlatform: ad.publisher_platform || [],
    linkUrl: ad.link_url || '',
    live: ad.live || false,
    categories: ad.categories || [],
    niches: ad.niches || [],
    languages: ad.languages || [],
    marketTarget: ad.market_target || '',
    creativeTargeting: ad.creative_targeting || '',
    productCategory: ad.product_category || '',
    startedRunning: ad.started_running || '',
    runningDuration: ad.running_duration || { days: 0, hours: 0, minutes: 0 },
    thumbnail: ad.thumbnail || '',
    video: ad.video || firstCard?.video || '',
    image: ad.image || firstCard?.image || '',
    avatar: ad.avatar || '',
    transcription: ad.full_transcription || firstCard?.transcription || '',
    cards,
    savedAt: ad.saved_at || undefined,
  };
}

/**
 * Check API usage / credits remaining.
 */
export async function getUsage(token: string): Promise<ForeplayUsage> {
  const response = await axios.get<any>(`${FOREPLAY_API}/api/usage`, {
    headers: authHeaders(token),
  });
  const data = response.data?.data || response.data;
  return {
    creditsUsed: data.credits_used || 0,
    creditsRemaining: data.credits_remaining || 0,
    plan: data.plan || '',
  };
}

/**
 * List user's boards (collections).
 */
export async function listBoards(token: string): Promise<ForeplayBoard[]> {
  const cached = boardsCache.get(token);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const response = await axios.get<any>(`${FOREPLAY_API}/api/boards`, {
    headers: authHeaders(token),
  });
  const boards = response.data?.data || response.data || [];
  const result = (Array.isArray(boards) ? boards : []).map((b: any) => ({
    id: b.id || b._id || '',
    name: b.name || '',
    description: b.description || undefined,
  }));
  boardsCache.set(token, { data: result, expiresAt: Date.now() + FOREPLAY_CACHE_TTL_MS });
  return result;
}

/**
 * Get ads in a board (paginated with cursor).
 */
export async function getBoardAds(
  token: string,
  boardId: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ ads: ForeplayAd[]; cursor?: string }> {
  const params: Record<string, string> = {};
  if (options.limit) params.limit = String(options.limit);
  if (options.cursor) params.cursor = options.cursor;
  params.board_id = boardId;

  const response = await axios.get<any>(`${FOREPLAY_API}/api/board/ads`, {
    headers: authHeaders(token),
    params,
  });
  const data = response.data;
  const ads = (data?.data || []).map(mapAd);
  const nextCursor = data?.metadata?.cursor || undefined;
  return { ads, cursor: nextCursor };
}

/**
 * Get all ads in a board (auto-paginate).
 */
export async function getAllBoardAds(token: string, boardId: string): Promise<ForeplayAd[]> {
  const cacheKey = `${token}:${boardId}`;
  const cached = boardAdsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const allAds: ForeplayAd[] = [];
  let cursor: string | undefined;
  do {
    const result = await getBoardAds(token, boardId, { limit: 250, cursor });
    allAds.push(...result.ads);
    cursor = result.cursor;
  } while (cursor);
  boardAdsCache.set(cacheKey, { data: allAds, expiresAt: Date.now() + FOREPLAY_CACHE_TTL_MS });
  return allAds;
}

/**
 * Get user's personal swipefile ads (paginated with cursor).
 * First-page results (no cursor) are cached for 5 minutes.
 */
export async function getSwipefileAds(
  token: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ ads: ForeplayAd[]; cursor?: string }> {
  const cacheKey = `${token}:swipefile:${options.limit ?? 'default'}`;
  if (!options.cursor) {
    const cached = swipefileCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;
  }

  const params: Record<string, string> = {};
  if (options.limit) params.limit = String(options.limit);
  if (options.cursor) params.cursor = options.cursor;

  const response = await axios.get<any>(`${FOREPLAY_API}/api/swipefile/ads`, {
    headers: authHeaders(token),
    params,
  });
  const data = response.data;
  const ads = (data?.data || []).map(mapAd);
  const nextCursor = data?.metadata?.cursor || undefined;
  const result = { ads, cursor: nextCursor };

  if (!options.cursor) {
    swipefileCache.set(cacheKey, { data: result, expiresAt: Date.now() + FOREPLAY_CACHE_TTL_MS });
  }
  return result;
}

/**
 * Search the global ad discovery database.
 * Note: costs 1 credit per ad returned.
 */
export async function searchDiscoveryAds(
  token: string,
  options: {
    query?: string;
    limit?: number;
    cursor?: string;
    format?: string[];
    platform?: string[];
    niche?: string[];
    language?: string[];
    market?: string;
    live?: boolean;
    sort?: string;
  } = {}
): Promise<{ ads: ForeplayAd[]; cursor?: string }> {
  const params: Record<string, string> = {};
  if (options.query) params.query = options.query;
  if (options.limit) params.limit = String(options.limit);
  if (options.cursor) params.cursor = options.cursor;
  if (options.format?.length) params.format = options.format.join(',');
  if (options.platform?.length) params.platform = options.platform.join(',');
  if (options.niche?.length) params.niche = options.niche.join(',');
  if (options.language?.length) params.language = options.language.join(',');
  if (options.market) params.market = options.market;
  if (options.live !== undefined) params.live = String(options.live);
  if (options.sort) params.sort = options.sort;

  const response = await axios.get<any>(`${FOREPLAY_API}/api/discovery/ads`, {
    headers: authHeaders(token),
    params,
  });
  const data = response.data;
  const ads = (data?.data || []).map(mapAd);
  const nextCursor = data?.metadata?.cursor || undefined;
  return { ads, cursor: nextCursor };
}

/**
 * Get a single ad by its Facebook ad_id (numeric) or Foreplay internal id.
 * Tries path param first (ad_id), falls back to query param.
 */
export async function getAd(token: string, adId: string): Promise<ForeplayAd> {
  try {
    // Try as Facebook ad_id (path param)
    const response = await axios.get<any>(`${FOREPLAY_API}/api/ad/${adId}`, {
      headers: authHeaders(token),
    });
    const data = response.data?.data || response.data;
    return mapAd(data);
  } catch (err: any) {
    if (err.response?.status === 404) {
      // Try as query param (may work with internal ID)
      const response = await axios.get<any>(`${FOREPLAY_API}/api/ad`, {
        headers: authHeaders(token),
        params: { ad_id: adId },
      });
      const data = response.data?.data || response.data;
      return mapAd(data);
    }
    throw err;
  }
}

/**
 * Format an ad as markdown for LLM consumption.
 */
export function formatAdAsMarkdown(ad: ForeplayAd): string {
  const parts: string[] = [];
  parts.push(`# ${ad.name || ad.headline || 'Untitled Ad'}`);
  parts.push('');

  if (ad.brandName || ad.name) parts.push(`**Brand:** ${ad.brandName || ad.name}`);
  if (ad.displayFormat) parts.push(`**Format:** ${ad.displayFormat}`);
  if (ad.publisherPlatform?.length) parts.push(`**Platform:** ${ad.publisherPlatform.join(', ')}`);
  if (ad.live !== undefined) parts.push(`**Live:** ${ad.live ? 'Yes' : 'No'}`);
  if (ad.startedRunning) {
    const dateStr = typeof ad.startedRunning === 'number'
      ? new Date(ad.startedRunning).toISOString().split('T')[0]
      : ad.startedRunning;
    parts.push(`**Started Running:** ${dateStr}`);
  }
  if (ad.runningDuration?.days) parts.push(`**Running Duration:** ${ad.runningDuration.days} days`);
  if (ad.marketTarget) parts.push(`**Market:** ${ad.marketTarget}`);
  if (ad.creativeTargeting) parts.push(`**Creative Targeting:** ${ad.creativeTargeting}`);
  if (ad.productCategory) parts.push(`**Product Category:** ${ad.productCategory}`);
  if (ad.niches?.length) parts.push(`**Niches:** ${ad.niches.join(', ')}`);
  if (ad.categories?.length) parts.push(`**Categories:** ${ad.categories.join(', ')}`);
  if (ad.languages?.length) parts.push(`**Languages:** ${ad.languages.join(', ')}`);

  if (ad.headline) {
    parts.push('');
    parts.push('## Headline');
    parts.push(ad.headline);
  }

  if (ad.description) {
    parts.push('');
    parts.push('## Description / Ad Copy');
    parts.push(ad.description);
  }

  if (ad.ctaTitle) {
    parts.push('');
    parts.push(`**CTA:** ${ad.ctaTitle}${ad.ctaType ? ` (${ad.ctaType})` : ''}`);
  }

  if (ad.linkUrl) {
    parts.push(`**Link:** ${ad.linkUrl}`);
  }

  if (ad.transcription) {
    parts.push('');
    parts.push('## Video Transcription');
    parts.push(ad.transcription);
  }

  // Cards (DCO ads have multiple creatives)
  if (ad.cards?.length > 1) {
    parts.push('');
    parts.push(`## Ad Variations (${ad.cards.length} cards)`);
    ad.cards.forEach((card, i) => {
      parts.push('');
      parts.push(`### Card ${i + 1}${card.type ? ` (${card.type})` : ''}`);
      if (card.headline) parts.push(`**Headline:** ${card.headline}`);
      if (card.description) parts.push(`**Copy:** ${card.description}`);
      if (card.ctaText) parts.push(`**CTA:** ${card.ctaText}`);
      if (card.image) parts.push(`**Image:** ${card.image}`);
      if (card.video) parts.push(`**Video:** ${card.video}`);
      if (card.transcription) parts.push(`**Transcription:** ${card.transcription}`);
    });
  }

  // Media references (top-level)
  const media: string[] = [];
  if (ad.image) media.push(`- Image: ${ad.image}`);
  if (ad.video) media.push(`- Video: ${ad.video}`);
  if (ad.thumbnail) media.push(`- Thumbnail: ${ad.thumbnail}`);
  if (media.length) {
    parts.push('');
    parts.push('## Media');
    parts.push(...media);
  }

  return parts.join('\n');
}
