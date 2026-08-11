import { extractS3KeyFromUrl, getS3ObjectAsBuffer } from './s3Utils';

export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_INLINE_DOCUMENT_IMAGE_BYTES = 20 * 1024 * 1024;

export interface FetchedInlineImage {
  buffer: Buffer;
  contentType?: string;
}

export type InlineImageFetcher = (url: string) => Promise<FetchedInlineImage | null>;

export class InlineS3ImageError extends Error {
  readonly code = 'INLINE_S3_IMAGE_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'InlineS3ImageError';
  }
}

const IMG_SRC_RE = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi;

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

function imageMimeType(url: string, storedContentType?: string): string {
  if (storedContentType?.toLowerCase().startsWith('image/')) return storedContentType;
  const pathname = url.split(/[?#]/, 1)[0];
  const extension = pathname.split('.').pop()?.toLowerCase();
  return (extension && IMAGE_MIME_BY_EXTENSION[extension]) || 'application/octet-stream';
}

function actionableFetchError(url: string, error: unknown): InlineS3ImageError {
  const detail = error instanceof Error ? error.message : String(error);
  return new InlineS3ImageError(
    `Could not inline private image ${url}: ${detail}. ` +
      'Reduce the image size or image count, confirm the asset is still accessible, and retry.',
  );
}

export async function inlineS3ImagesAsDataUris(
  html: string,
  fetcher: InlineImageFetcher,
): Promise<{ html: string; inlined: number; decodedBytes: number }> {
  const candidates = new Map<string, number>();
  for (const match of html.matchAll(IMG_SRC_RE)) {
    const src = match[3];
    if (src && !src.trim().toLowerCase().startsWith('data:')) {
      candidates.set(src, (candidates.get(src) || 0) + 1);
    }
  }

  const dataUris = new Map<string, string>();
  let decodedBytes = 0;
  let inlined = 0;

  for (const [url, occurrences] of candidates) {
    let fetched: FetchedInlineImage | null;
    try {
      fetched = await fetcher(url);
    } catch (error) {
      throw actionableFetchError(url, error);
    }
    if (!fetched) continue;

    const imageBytes = fetched.buffer.byteLength;
    if (imageBytes > MAX_INLINE_IMAGE_BYTES) {
      throw new InlineS3ImageError(
        `Private image exceeds the 5 MB decoded limit: ${url}. ` +
          'Reduce the image size and retry; the document was not created with a broken image.',
      );
    }
    for (let occurrence = 0; occurrence < occurrences; occurrence++) {
      if (decodedBytes + imageBytes > MAX_INLINE_DOCUMENT_IMAGE_BYTES) {
        throw new InlineS3ImageError(
          `Private images exceed the 20 MB aggregate decoded limit after ${inlined} images were inlined; ` +
            `offending asset: ${url}. Reduce image sizes or image count and retry; no partial document was created.`,
        );
      }
      decodedBytes += imageBytes;
      inlined += 1;
    }

    dataUris.set(
      url,
      `data:${imageMimeType(url, fetched.contentType)};base64,${fetched.buffer.toString('base64')}`,
    );
  }

  if (inlined === 0) return { html, inlined, decodedBytes };

  return {
    html: html.replace(IMG_SRC_RE, (full, prefix, quote, src) => {
      const dataUri = dataUris.get(src);
      return dataUri ? `${prefix}${quote}${dataUri}${quote}` : full;
    }),
    inlined,
    decodedBytes,
  };
}

export function createDefaultS3ImageFetcher(
  buckets: string[] = [process.env.AWS_S3_BUCKET || 'agentweb-user-files'],
): InlineImageFetcher {
  return async (url) => {
    for (const bucket of buckets) {
      const key = extractS3KeyFromUrl(url, bucket);
      if (!key) continue;
      const result = await getS3ObjectAsBuffer(key, bucket, MAX_INLINE_IMAGE_BYTES);
      return { buffer: result.buffer, contentType: result.contentType };
    }
    return null;
  };
}
