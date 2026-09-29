/**
 * Ad placement spec table (ENG-2139, ENG-2128 T7).
 *
 * The placements AgentWeb actually generates or publishes images for:
 * - Meta feed square and 4:5 portrait (onboarding ad images use 1080x1080 and 1080x1350),
 * - Meta story/reel 9:16 (1080x1920),
 * - Google's two marketing-image field types the Ads integration attaches
 *   (`SQUARE_MARKETING_IMAGE`, `MARKETING_IMAGE` in googleAdsService.ts).
 *
 * `maxBytes` is the platform's upload ceiling (Meta 30 MB, Google 5120 KB). Meta uploads are
 * additionally downscaled to 1936px / 8 MB by `metaService.resizeImageForMeta`, so exceeding
 * that repo-internal cap is not a defect and is not checked here.
 *
 * Pure and dependency-free: `imageGeneration.ts` imports it at module scope.
 */

export type PlacementId =
  | 'meta_feed_square'
  | 'meta_feed_portrait'
  | 'meta_story_reel'
  | 'google_square_marketing_image'
  | 'google_marketing_image';

export interface PlacementSpec {
  id: PlacementId;
  platform: 'meta' | 'google';
  label: string;
  /** Recommended pixel size; also the `size` string that maps to this placement. */
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** Allowed relative deviation of width/height from width/height of the spec. */
  aspectTolerance: number;
  maxBytes: number;
}

const MB = 1024 * 1024;

export const PLACEMENT_SPECS: Readonly<Record<PlacementId, PlacementSpec>> = {
  meta_feed_square: {
    id: 'meta_feed_square',
    platform: 'meta',
    label: 'Meta Feed — square 1:1',
    width: 1080,
    height: 1080,
    minWidth: 600,
    minHeight: 600,
    aspectTolerance: 0.03,
    maxBytes: 30 * MB,
  },
  meta_feed_portrait: {
    id: 'meta_feed_portrait',
    platform: 'meta',
    label: 'Meta Feed — portrait 4:5',
    width: 1080,
    height: 1350,
    minWidth: 600,
    minHeight: 750,
    aspectTolerance: 0.03,
    maxBytes: 30 * MB,
  },
  meta_story_reel: {
    id: 'meta_story_reel',
    platform: 'meta',
    label: 'Meta Story/Reel — vertical 9:16',
    width: 1080,
    height: 1920,
    minWidth: 500,
    minHeight: 889,
    aspectTolerance: 0.03,
    maxBytes: 30 * MB,
  },
  google_square_marketing_image: {
    id: 'google_square_marketing_image',
    platform: 'google',
    label: 'Google square marketing image 1:1',
    width: 1200,
    height: 1200,
    minWidth: 300,
    minHeight: 300,
    aspectTolerance: 0.01,
    maxBytes: 5120 * 1024,
  },
  google_marketing_image: {
    id: 'google_marketing_image',
    platform: 'google',
    label: 'Google landscape marketing image 1.91:1',
    width: 1200,
    height: 628,
    minWidth: 600,
    minHeight: 314,
    aspectTolerance: 0.01,
    maxBytes: 5120 * 1024,
  },
};

/** True for a key of `PLACEMENT_SPECS`; validates a placement arriving from a tool call or storage. */
export function isPlacementId(value: unknown): value is PlacementId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLACEMENT_SPECS, value);
}

/** Parses "1080x1350" / "1080 x 1350" into pixels; anything else is null. */
export function parsePixelSize(size: string | undefined): { width: number; height: number } | null {
  const m = size?.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Parses "4:5" / "1344:768" into width/height; anything else is null. */
export function parseRatio(size: string | undefined): number | null {
  const m = size?.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/** The placement whose recommended pixel size is exactly `size` (e.g. "1080x1350"), if any. */
export function placementForSize(size: string | undefined): PlacementSpec | undefined {
  const px = parsePixelSize(size);
  if (!px) return undefined;
  return Object.values(PLACEMENT_SPECS).find((s) => s.width === px.width && s.height === px.height);
}

/**
 * The Meta placement a bare ratio (or a pixel size that is not a placement's exact size) is for
 * (ENG-2187): agent mode asks for "1:1" / "1024x1024" / "4:5", never a placement, so without this
 * the size and file-limit checks never ran. Only Meta placements are considered: a 1:1 request
 * would otherwise match Google's square image too, and agent-mode ads are published to Meta. If
 * more than one Meta placement ever shares a ratio, the strictest (largest minimum, then smallest
 * upload limit) is assumed. Ratios no Meta placement uses (16:9, 3:2, 3:4, …) return undefined.
 */
export function metaPlacementForAspect(aspect: number | null): PlacementSpec | undefined {
  if (aspect === null) return undefined;
  return Object.values(PLACEMENT_SPECS)
    .filter((s) => s.platform === 'meta' && aspectDeviation(aspect, s.width / s.height) <= s.aspectTolerance)
    .sort((a, b) => b.minWidth * b.minHeight - a.minWidth * a.minHeight || a.maxBytes - b.maxBytes)[0];
}

/** Width/height the caller asked for, from a pixel size or a ratio; null for "auto"/absent/garbage. */
export function requestedAspect(size: string | undefined): number | null {
  const px = parsePixelSize(size);
  if (px) return px.width / px.height;
  return parseRatio(size);
}

/** Relative deviation of `actual` from `target` (0 = identical). */
export function aspectDeviation(actual: number, target: number): number {
  return Math.abs(actual - target) / target;
}

/** Aspect ratios Gemini 3 image models accept for `imageConfig.aspectRatio`. */
export const GEMINI_ASPECT_RATIOS = ['1:1', '9:16', '16:9', '3:4', '4:3', '3:2', '2:3', '5:4', '4:5', '21:9'] as const;

/**
 * Snap targets for pixel sizes, in the order and with the 4-decimal values the original
 * `convertSizeToAspectRatio` used — kept rounded so ties resolve exactly as before.
 */
const GEMINI_RATIO_SNAP: ReadonlyArray<readonly [string, number]> = [
  ['1:1', 1.0],
  ['9:16', 0.5625],
  ['16:9', 1.7778],
  ['3:4', 0.75],
  ['4:3', 1.3333],
  ['3:2', 1.5],
  ['2:3', 0.6667],
  ['5:4', 1.25],
  ['4:5', 0.8],
  ['21:9', 2.3333],
];

export type AspectFallback = 'unsupported_ratio' | 'unparseable_size' | 'nearest_ratio';

export interface AspectResolution {
  aspectRatio: string;
  /** Set when the resolved ratio is not what the caller asked for. */
  fallback?: AspectFallback;
}

/** Above this deviation a nearest-ratio snap changes the creative's shape, not just rounding. */
const NEAREST_RATIO_FALLBACK_TOLERANCE = 0.03;

/**
 * How `imageGeneration.ts` turns a `size` into the Gemini 3 `aspectRatio` — the mapping
 * itself is unchanged from the previous private `convertSizeToAspectRatio`; this only
 * reports when it silently substituted a different shape (ENG-2139): an unsupported ratio or
 * an unparseable size becomes 1:1, and a pixel size snaps to the nearest supported ratio
 * (1200x628 → 16:9). "auto"/absent resolves to 1:1 by design and is not a fallback.
 */
export function resolveGeminiAspectRatio(size: string | undefined): AspectResolution {
  if (!size || size === 'auto') return { aspectRatio: '1:1' };

  if (size.includes(':')) {
    if ((GEMINI_ASPECT_RATIOS as readonly string[]).includes(size)) return { aspectRatio: size };
    return { aspectRatio: '1:1', fallback: 'unsupported_ratio' };
  }

  if (size.includes('x')) {
    const [width, height] = size.split('x').map(Number);
    if (!isNaN(width) && !isNaN(height) && width > 0 && height > 0) {
      const ratio = width / height;
      let closest = '1:1';
      let closestValue = 1;
      let minDiff = Infinity;
      for (const [candidate, value] of GEMINI_RATIO_SNAP) {
        const diff = Math.abs(ratio - value);
        if (diff < minDiff) {
          minDiff = diff;
          closest = candidate;
          closestValue = value;
        }
      }
      return aspectDeviation(closestValue, ratio) > NEAREST_RATIO_FALLBACK_TOLERANCE
        ? { aspectRatio: closest, fallback: 'nearest_ratio' }
        : { aspectRatio: closest };
    }
  }

  return { aspectRatio: '1:1', fallback: 'unparseable_size' };
}
