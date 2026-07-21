import { extractS3KeyFromUrl, getS3ObjectAsBuffer } from './s3Utils';

/**
 * Inline private-S3 `<img>` sources into HTML as base64 data URIs (ENG-278).
 *
 * Problem: when a generated HTML report embeds `<img src="https://<private-bucket>
 * .s3...amazonaws.com/...">`, the browser fetches that URL anonymously and gets a
 * 403, so the image renders blank. The fix is to fetch the bytes server-side (with
 * our credentials) and rewrite the src to a self-contained `data:` URI.
 *
 * The core `inlineS3ImagesAsDataUris` is a PURE string transform parameterised by a
 * fetcher, so it is trivially unit-testable with a mocked fetch. The default fetcher
 * (`createDefaultS3ImageFetcher`) recognises our own bucket URLs and pulls the bytes
 * via the S3 SDK.
 */

export interface FetchedImage {
  buffer: Buffer;
  contentType: string;
}

/**
 * Resolves an image URL to its raw bytes + MIME type.
 *
 * Contract:
 *  - return `null`  → the URL is NOT one we handle (e.g. a third-party CDN, a
 *    relative path). The caller leaves the `<img src>` untouched.
 *  - return bytes   → inline them as a data URI.
 *  - throw          → the URL IS one we handle but the fetch failed. The caller
 *    counts it as a failure, logs it, and leaves the original src (the image was
 *    already broken, so we degrade to the pre-existing behaviour rather than
 *    corrupting the whole document).
 */
export type S3ImageFetcher = (url: string) => Promise<FetchedImage | null>;

// Matches `<img ... src="..."|'...'`, capturing the prefix up to and including
// `src=`, the quote character, and the URL. Non-greedy so it stops at the first
// closing quote. Attribute order and other attributes are preserved by the prefix.
const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

/**
 * Rewrite every `<img>` whose src the fetcher recognises into a base64 data URI.
 * Non-recognised images, existing `data:` URIs, and all other markup are left
 * byte-for-byte unchanged (behaviour-preserving when there is nothing to inline).
 *
 * Fetches are de-duplicated: an image referenced N times is fetched once.
 */
export async function inlineS3ImagesAsDataUris(
  html: string,
  fetcher: S3ImageFetcher,
): Promise<{ html: string; inlined: number; failed: number }> {
  if (!html || typeof html !== 'string') {
    return { html: html ?? '', inlined: 0, failed: 0 };
  }

  // Collect the unique candidate src URLs (skip empties and existing data URIs).
  const candidates = new Set<string>();
  for (const match of html.matchAll(IMG_SRC_RE)) {
    const src = match[3];
    if (src && !src.trim().toLowerCase().startsWith('data:')) {
      candidates.add(src);
    }
  }
  if (candidates.size === 0) {
    return { html, inlined: 0, failed: 0 };
  }

  const dataUriByUrl = new Map<string, string>();
  let inlined = 0;
  let failed = 0;

  for (const url of candidates) {
    let fetched: FetchedImage | null;
    try {
      fetched = await fetcher(url);
    } catch (err) {
      // Recognised-but-unfetchable: log loudly, leave the original src in place.
      failed++;
      console.warn(`inlineS3Images: failed to inline image ${url}:`, err);
      continue;
    }
    if (!fetched) {
      // Not one of our images — leave it exactly as the author wrote it.
      continue;
    }
    const contentType = fetched.contentType || 'application/octet-stream';
    const base64 = fetched.buffer.toString('base64');
    dataUriByUrl.set(url, `data:${contentType};base64,${base64}`);
    inlined++;
  }

  if (dataUriByUrl.size === 0) {
    return { html, inlined, failed };
  }

  const newHtml = html.replace(IMG_SRC_RE, (full, prefix, quote, src) => {
    const dataUri = dataUriByUrl.get(src);
    return dataUri ? `${prefix}${quote}${dataUri}${quote}` : full;
  });

  return { html: newHtml, inlined, failed };
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  tiff: 'image/tiff',
  tif: 'image/tiff',
};

/** Best-effort MIME from a URL's file extension (query string stripped). */
function guessImageMimeFromUrl(url: string): string | undefined {
  const pathPart = url.split('?')[0].split('#')[0];
  const ext = pathPart.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_MIME_BY_EXT[ext] : undefined;
}

/**
 * Fetcher that inlines images living in our own S3 bucket(s). Any URL that does
 * not resolve to a key in one of `buckets` returns null (left untouched); a
 * recognised URL whose object can't be read throws (surfaced as a failure).
 *
 * @param buckets Bucket names to treat as ours. Defaults to the configured
 *   `AWS_S3_BUCKET` (falling back to `agentweb-user-files`).
 */
export function createDefaultS3ImageFetcher(buckets?: string[]): S3ImageFetcher {
  const bucketList =
    buckets && buckets.length > 0
      ? buckets
      : [process.env.AWS_S3_BUCKET || 'agentweb-user-files'];

  return async (url: string): Promise<FetchedImage | null> => {
    let matchedKey: string | null = null;
    let matchedBucket: string | null = null;
    for (const bucket of bucketList) {
      const key = extractS3KeyFromUrl(url, bucket);
      if (key) {
        matchedKey = key;
        matchedBucket = bucket;
        break;
      }
    }
    if (!matchedKey || !matchedBucket) {
      return null; // not our image
    }

    const { buffer, contentType } = await getS3ObjectAsBuffer(matchedKey, matchedBucket);

    // Prefer an image/* content type stored on the object; otherwise infer from
    // the extension so the data URI declares a renderable MIME rather than a
    // generic octet-stream.
    const resolvedType =
      contentType && contentType.toLowerCase().startsWith('image/')
        ? contentType
        : guessImageMimeFromUrl(url) || contentType || 'application/octet-stream';

    return { buffer, contentType: resolvedType };
  };
}
