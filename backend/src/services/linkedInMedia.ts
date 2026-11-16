// ENG-3003: media_urls on LinkedIn are uploaded through the image pipeline. A video sent that
// way is accepted and returns a share URN, then LinkedIn drops the post asynchronously.

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'];

// Storage layers (S3 included) often serve files as a generic type, so those are sniffed.
const GENERIC_CONTENT_TYPES = ['', 'application/octet-stream', 'binary/octet-stream'];
// ISO BMFF brands that are still images (HEIC / AVIF), so an `ftyp` box alone is not a video.
const IMAGE_FTYP_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'];

export class LinkedInUnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedInUnsupportedMediaError';
  }
}

export const LINKEDIN_VIDEO_UNSUPPORTED_MESSAGE =
  'LinkedIn video posts are not supported yet: media_urls on LinkedIn accept images only, and a video would be dropped by LinkedIn after being accepted. '
  + 'Video upload is currently supported for YouTube only. Nothing was posted - post the text with an image, or upload the video to LinkedIn manually.';

export function isVideoUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/)[0];
  }
  path = path.toLowerCase();
  return VIDEO_EXTENSIONS.some(ext => path.endsWith(ext));
}

function sniffsAsVideo(bytes: Buffer): boolean {
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    return !IMAGE_FTYP_BRANDS.includes(bytes.toString('latin1', 8, 12).toLowerCase());
  }
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return true; // WebM / Matroska
  return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'AVI ';
}

/**
 * The downloaded bytes are the authority on what a media_url is, not its extension. Throws
 * LinkedInUnsupportedMediaError for anything that would not survive LinkedIn's image pipeline.
 */
export function assertImageDownload(contentTypeHeader: unknown, bytes: Buffer): void {
  const contentType = String(contentTypeHeader ?? '').split(';')[0].trim().toLowerCase();
  if (contentType.startsWith('image/')) return;
  if (GENERIC_CONTENT_TYPES.includes(contentType)) {
    if (sniffsAsVideo(bytes)) throw new LinkedInUnsupportedMediaError(LINKEDIN_VIDEO_UNSUPPORTED_MESSAGE);
    return;
  }
  if (contentType.startsWith('video/')) throw new LinkedInUnsupportedMediaError(LINKEDIN_VIDEO_UNSUPPORTED_MESSAGE);
  throw new LinkedInUnsupportedMediaError(
    `A LinkedIn media_url did not return an image (content-type ${contentType}). media_urls on LinkedIn accept images only. Nothing was posted.`,
  );
}
