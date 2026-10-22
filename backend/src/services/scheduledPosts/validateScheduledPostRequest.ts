/**
 * ENG-2507 (slice of ENG-2501): pure validator for a "schedule an approved social
 * post" request. No persistence, no publishing, no tool registration — storage and
 * firing stay gated on the parent's Requires: Me decision.
 *
 * Never throws; returns a typed ok/error result with field-specific codes.
 */

export const SCHEDULED_POST_PLATFORMS = ['x', 'instagram', 'linkedin'] as const;
export type ScheduledPostPlatform = (typeof SCHEDULED_POST_PLATFORMS)[number];

/** Furthest a post may be scheduled ahead of "now". */
export const SCHEDULED_POST_MAX_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Per-platform content caps. X mirrors TWEET_CHAR_LIMIT in twitterService.ts (the
 * post_on_connected_account X path trims to it; a scheduled post must already fit
 * so the approved text is published unchanged). LinkedIn (3000) and Instagram
 * caption (2200) are the platforms' own hard limits.
 */
export const SCHEDULED_POST_CONTENT_LIMITS: Record<ScheduledPostPlatform, number> = {
  x: 280,
  linkedin: 3000,
  instagram: 2200,
};

export type ScheduledPostErrorCode =
  | 'INVALID_REQUEST'
  | 'PLATFORM_UNSUPPORTED'
  | 'PUBLISH_AT_INVALID'
  | 'PUBLISH_AT_MISSING_TIMEZONE'
  | 'PUBLISH_AT_NOT_FUTURE'
  | 'PUBLISH_AT_BEYOND_HORIZON'
  | 'CONTENT_EMPTY'
  | 'CONTENT_TOO_LONG'
  | 'MEDIA_INVALID'
  | 'MEDIA_REQUIRED';

export interface ScheduledPostError {
  field: 'request' | 'platform' | 'publishAt' | 'content' | 'mediaUrls';
  code: ScheduledPostErrorCode;
  message: string;
}

export interface ValidScheduledPost {
  platform: ScheduledPostPlatform;
  publishAt: Date;
  content: string;
  mediaUrls: string[];
}

export type ScheduledPostValidation =
  | { ok: true; value: ValidScheduledPost }
  | { ok: false; errors: ScheduledPostError[] };

// ISO-8601 date-time with an explicit zone (Z or ±HH:MM).
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_NO_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/;

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function validateScheduledPostRequest(
  input: unknown,
  now: () => Date,
): ScheduledPostValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: [{ field: 'request', code: 'INVALID_REQUEST', message: 'Request must be an object.' }] };
  }
  const req = input as Record<string, unknown>;
  const errors: ScheduledPostError[] = [];

  const platform = req.platform;
  const platformOk =
    typeof platform === 'string' && (SCHEDULED_POST_PLATFORMS as readonly string[]).includes(platform);
  if (!platformOk) {
    errors.push({
      field: 'platform',
      code: 'PLATFORM_UNSUPPORTED',
      message: `platform must be one of: ${SCHEDULED_POST_PLATFORMS.join(', ')}.`,
    });
  }

  let publishAt: Date | undefined;
  const rawAt = req.publishAt;
  if (typeof rawAt !== 'string' || rawAt.trim() === '') {
    errors.push({ field: 'publishAt', code: 'PUBLISH_AT_INVALID', message: 'publishAt must be an ISO-8601 datetime string.' });
  } else if (ISO_NO_TZ.test(rawAt)) {
    errors.push({ field: 'publishAt', code: 'PUBLISH_AT_MISSING_TIMEZONE', message: 'publishAt must include a timezone (Z or ±HH:MM).' });
  } else if (!ISO_WITH_TZ.test(rawAt) || Number.isNaN(new Date(rawAt).getTime())) {
    errors.push({ field: 'publishAt', code: 'PUBLISH_AT_INVALID', message: 'publishAt is not a valid ISO-8601 datetime.' });
  } else {
    const at = new Date(rawAt);
    const nowMs = now().getTime();
    if (at.getTime() <= nowMs) {
      errors.push({ field: 'publishAt', code: 'PUBLISH_AT_NOT_FUTURE', message: 'publishAt must be in the future.' });
    } else if (at.getTime() - nowMs > SCHEDULED_POST_MAX_HORIZON_MS) {
      errors.push({ field: 'publishAt', code: 'PUBLISH_AT_BEYOND_HORIZON', message: 'publishAt must be within 90 days.' });
    } else {
      publishAt = at;
    }
  }

  const content = req.content;
  if (typeof content !== 'string' || content.trim() === '') {
    errors.push({ field: 'content', code: 'CONTENT_EMPTY', message: 'content must be non-empty text.' });
  } else if (platformOk) {
    const limit = SCHEDULED_POST_CONTENT_LIMITS[platform as ScheduledPostPlatform];
    // Count code points so emoji are not double-counted.
    if ([...content].length > limit) {
      errors.push({ field: 'content', code: 'CONTENT_TOO_LONG', message: `content exceeds the ${limit}-character limit for ${platform}.` });
    }
  }

  let mediaUrls: string[] = [];
  let mediaShapeOk = true;
  const rawMedia = req.mediaUrls;
  if (rawMedia !== undefined) {
    if (!Array.isArray(rawMedia) || !rawMedia.every(isHttpUrl)) {
      mediaShapeOk = false;
      errors.push({ field: 'mediaUrls', code: 'MEDIA_INVALID', message: 'mediaUrls must be an array of http(s) URLs.' });
    } else {
      mediaUrls = rawMedia as string[];
    }
  }
  // Instagram has no text-only post type.
  if (platform === 'instagram' && mediaShapeOk && mediaUrls.length === 0) {
    errors.push({ field: 'mediaUrls', code: 'MEDIA_REQUIRED', message: 'Instagram posts require at least one media URL.' });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { platform: platform as ScheduledPostPlatform, publishAt: publishAt!, content: content as string, mediaUrls },
  };
}
