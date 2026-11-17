/**
 * ENG-3123 (slice of ENG-678): pure post-performance analysis over the posts
 * returned by getPostsForUser (socialPostsService.ts). No I/O, no storage,
 * no user-facing copy: input in, analysis out.
 *
 * Engagement rate = (likes + comments + shares) / impressions, only when
 * impressions > 0. Posts without usable impressions are counted in `skipped`
 * and never ranked. Ranking happens within a platform first; the combined view
 * compares platform-relative percentiles, never raw counts across platforms.
 */

export interface PerformancePostInput {
  id: string;
  platform: string;
  content?: string;
  createdAt?: string;
  metrics?: {
    likeCount?: number;
    commentCount?: number;
    shareCount?: number;
    impressionCount?: number;
  } | null;
  [key: string]: unknown;
}

export type LengthBucket = 'short' | 'medium' | 'long';

export interface ScoredPost {
  id: string;
  platform: string;
  engagementRate: number;
  /** 1 = best within its platform. */
  platformRank: number;
  /** 0..1 within its platform; 1 = best. Used for the combined ranking. */
  platformPercentile: number;
  lengthBucket: LengthBucket;
  hasMedia: boolean;
  weekday: number | null;
  hourUtc: number | null;
}

export interface FeatureDelta {
  feature: 'lengthBucket' | 'hasMedia' | 'weekday' | 'hourUtc' | 'platform';
  value: string;
  count: number;
  /** Mean platform percentile of posts with this value minus the overall mean. */
  delta: number;
}

export interface PerformanceGroup {
  eligible: number;
  insufficientData: boolean;
  ranked: ScoredPost[];
  topQuartile?: ScoredPost[];
  bottomQuartile?: ScoredPost[];
}

export interface PostPerformanceAnalysis {
  skipped: number;
  byPlatform: Record<string, PerformanceGroup>;
  combined: PerformanceGroup;
  featureDeltas: FeatureDelta[];
}

export const MIN_ELIGIBLE_POSTS = 4;

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function lengthBucket(content: string | undefined): LengthBucket {
  const len = (content ?? '').trim().length;
  if (len < 280) return 'short';
  if (len < 1300) return 'medium';
  return 'long';
}

function detectMedia(post: PerformancePostInput): boolean {
  if (typeof post.hasMedia === 'boolean') return post.hasMedia;
  const candidates = [post.media, post.mediaUrls, post.images, post.mediaUrl];
  if (candidates.some(c => (Array.isArray(c) ? c.length > 0 : !!c))) return true;
  return typeof post.content === 'object' && post.content !== null;
}

function postedAt(createdAt: string | undefined): { weekday: number | null; hourUtc: number | null } {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(t)) return { weekday: null, hourUtc: null };
  const d = new Date(t);
  return { weekday: d.getUTCDay(), hourUtc: d.getUTCHours() };
}

/** Returns null when the post has no usable impressions. */
export function engagementRate(post: PerformancePostInput): number | null {
  const m = post.metrics;
  if (!m) return null;
  const impressions = num(m.impressionCount);
  if (impressions <= 0) return null;
  return (num(m.likeCount) + num(m.commentCount) + num(m.shareCount)) / impressions;
}

function byRateDesc(a: { engagementRate: number; id: string }, b: { engagementRate: number; id: string }) {
  return b.engagementRate - a.engagementRate || a.id.localeCompare(b.id);
}

function group(ranked: ScoredPost[]): PerformanceGroup {
  const eligible = ranked.length;
  if (eligible < MIN_ELIGIBLE_POSTS) return { eligible, insufficientData: true, ranked };
  const q = Math.max(1, Math.floor(eligible / 4));
  return {
    eligible,
    insufficientData: false,
    ranked,
    topQuartile: ranked.slice(0, q),
    bottomQuartile: ranked.slice(eligible - q),
  };
}

export function analyzePostPerformance(posts: PerformancePostInput[]): PostPerformanceAnalysis {
  let skipped = 0;
  const perPlatform = new Map<string, Array<Omit<ScoredPost, 'platformRank' | 'platformPercentile'>>>();

  for (const post of posts) {
    const rate = engagementRate(post);
    if (rate === null) {
      skipped++;
      continue;
    }
    const platform = post.platform || 'unknown';
    const list = perPlatform.get(platform) ?? [];
    list.push({
      id: post.id,
      platform,
      engagementRate: rate,
      lengthBucket: lengthBucket(typeof post.content === 'string' ? post.content : undefined),
      hasMedia: detectMedia(post),
      ...postedAt(post.createdAt),
    });
    perPlatform.set(platform, list);
  }

  const byPlatform: Record<string, PerformanceGroup> = {};
  const all: ScoredPost[] = [];
  for (const [platform, list] of perPlatform) {
    list.sort(byRateDesc);
    const n = list.length;
    const ranked = list.map((p, i) => ({
      ...p,
      platformRank: i + 1,
      platformPercentile: n === 1 ? 1 : 1 - i / (n - 1),
    }));
    byPlatform[platform] = group(ranked);
    all.push(...ranked);
  }

  // Combined: platform-relative percentile, never raw rates across platforms.
  all.sort((a, b) => b.platformPercentile - a.platformPercentile || byRateDesc(a, b));
  const combined = group(all);

  const featureDeltas: FeatureDelta[] = [];
  if (!combined.insufficientData) {
    const mean = all.reduce((s, p) => s + p.platformPercentile, 0) / all.length;
    const features: Array<[FeatureDelta['feature'], (p: ScoredPost) => string | null]> = [
      ['lengthBucket', p => p.lengthBucket],
      ['hasMedia', p => String(p.hasMedia)],
      ['weekday', p => (p.weekday === null ? null : String(p.weekday))],
      ['hourUtc', p => (p.hourUtc === null ? null : String(p.hourUtc))],
      ['platform', p => p.platform],
    ];
    for (const [feature, key] of features) {
      const buckets = new Map<string, number[]>();
      for (const p of all) {
        const k = key(p);
        if (k === null) continue;
        buckets.set(k, [...(buckets.get(k) ?? []), p.platformPercentile]);
      }
      for (const [value, vals] of buckets) {
        const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
        featureDeltas.push({ feature, value, count: vals.length, delta: avg - mean });
      }
    }
  }

  return { skipped, byPlatform, combined, featureDeltas };
}
