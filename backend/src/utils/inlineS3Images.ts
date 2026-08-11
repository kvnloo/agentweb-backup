import { extractS3KeyFromUrl, getS3ObjectAsBuffer } from './s3Utils';
import { Parser } from 'htmlparser2';

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

interface ImageSourceOccurrence {
  url: string;
  valueStart: number;
  valueEnd: number;
  quoted: boolean;
}

function attributeValueRange(
  html: string,
  attributeStart: number,
  attributeEnd: number,
): { valueStart: number; valueEnd: number; quoted: boolean } | null {
  const raw = html.slice(attributeStart, attributeEnd + 1);
  const equals = raw.indexOf('=');
  if (equals === -1) return null;

  let offset = equals + 1;
  while (/\s/.test(raw[offset] || '')) offset++;
  if (offset >= raw.length) return null;

  const quote = raw[offset] === '"' || raw[offset] === "'" ? raw[offset] : null;
  if (!quote) {
    let valueLength = 0;
    while (offset + valueLength < raw.length
      && !/[\s>]/.test(raw[offset + valueLength])) {
      valueLength++;
    }
    return {
      valueStart: attributeStart + offset,
      valueEnd: attributeStart + offset + valueLength,
      quoted: false,
    };
  }

  const closingQuote = raw.endsWith(quote);
  return {
    valueStart: attributeStart + offset + 1,
    valueEnd: closingQuote ? attributeEnd : attributeEnd + 1,
    quoted: true,
  };
}

/**
 * Locate renderable image sources with the repository's existing HTML parser.
 * Source offsets let the caller preserve the original document byte-for-byte
 * outside the actual src values. htmlparser2 treats comments and script text as
 * text; template descendants are explicitly skipped because they are inert.
 */
function findRenderableImageSources(html: string): ImageSourceOccurrence[] {
  const occurrences: ImageSourceOccurrence[] = [];
  let currentTag = '';
  let templateDepth = 0;
  let parser: Parser;

  parser = new Parser(
    {
      onopentagname: (name) => {
        currentTag = name;
      },
      onattribute: (name, value) => {
        if (currentTag !== 'img' || name !== 'src' || templateDepth > 0) return;
        if (parser.startIndex < 0 || parser.endIndex < parser.startIndex) return;
        const range = attributeValueRange(html, parser.startIndex, parser.endIndex);
        if (!range) return;
        occurrences.push({ url: value, ...range });
      },
      onopentag: (name) => {
        if (name === 'template') templateDepth++;
        currentTag = '';
      },
      onclosetag: (name) => {
        if (name === 'template' && templateDepth > 0) templateDepth--;
        currentTag = '';
      },
    },
    { decodeEntities: true, withStartIndices: true, withEndIndices: true } as any,
  );
  parser.end(html);
  return occurrences;
}

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
  const occurrences = findRenderableImageSources(html);
  const candidates = new Map<string, number>();
  for (const occurrence of occurrences) {
    const src = occurrence.url;
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

  let transformed = html;
  for (const occurrence of occurrences.sort((a, b) => b.valueStart - a.valueStart)) {
    const dataUri = dataUris.get(occurrence.url);
    if (!dataUri) continue;
    const replacement = occurrence.quoted ? dataUri : `"${dataUri}"`;
    transformed = transformed.slice(0, occurrence.valueStart)
      + replacement
      + transformed.slice(occurrence.valueEnd);
  }

  return { html: transformed, inlined, decodedBytes };
}

export function createDefaultS3ImageFetcher(
  userId: string,
  buckets: string[] = [process.env.AWS_S3_BUCKET || 'agentweb-user-files'],
): InlineImageFetcher {
  return async (url) => {
    for (const bucket of buckets) {
      const key = extractS3KeyFromUrl(url, bucket);
      if (!key || !key.startsWith(`users/${userId}/`)) continue;
      const result = await getS3ObjectAsBuffer(key, bucket, MAX_INLINE_IMAGE_BYTES);
      return { buffer: result.buffer, contentType: result.contentType };
    }
    return null;
  };
}
