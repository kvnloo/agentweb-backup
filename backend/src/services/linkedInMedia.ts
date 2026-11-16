// ENG-3003 / ENG-3116: a LinkedIn media_url is either an image (image pipeline) or an MP4 video
// (Videos API, multi-part). Sending a video through the image pipeline is accepted and then
// silently dropped by LinkedIn, so what a URL IS is decided from the downloaded bytes.

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'];

// Storage layers (S3 included) often serve files as a generic type, so those are sniffed.
const GENERIC_CONTENT_TYPES = ['', 'application/octet-stream', 'binary/octet-stream'];
// ISO BMFF brands that are still images (HEIC / AVIF), so an `ftyp` box alone is not a video.
const IMAGE_FTYP_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis'];
const MP4_CONTENT_TYPES = ['video/mp4', 'video/x-m4v'];

// The backend shares one 8 GB host with everything else, so a video is spooled to disk (not /tmp, which is
// tmpfs on Amazon Linux 2023) and read back one part at a time. LinkedIn itself allows 500 MB.
export const LINKEDIN_MAX_VIDEO_BYTES = 150 * 1024 * 1024;
export const LINKEDIN_VIDEO_PART_BYTES = 4 * 1024 * 1024;
export const LINKEDIN_MAX_CONCURRENT_MEDIA_UPLOADS = 2;
export const LINKEDIN_VIDEO_URN_PREFIX = 'urn:li:video:';

export class LinkedInUnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedInUnsupportedMediaError';
  }
}

export const LINKEDIN_VIDEO_FORMAT_MESSAGE =
  `LinkedIn only accepts MP4 video (3 seconds to 30 minutes, up to ${LINKEDIN_MAX_VIDEO_BYTES / 1024 / 1024} MB here). Convert the file to MP4 and retry. Nothing was posted.`;

export const LINKEDIN_VIDEO_ALONE_MESSAGE =
  'A LinkedIn post can carry one video or images, not a video together with other media. Nothing was posted - send the video alone, or only images.';

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

export function isVideoUrn(urn: string): boolean {
  return urn.startsWith(LINKEDIN_VIDEO_URN_PREFIX);
}

export type MediaClass =
  | { kind: 'image' }
  | { kind: 'video' }
  | { kind: 'unsupported'; message: string };

const NOT_MEDIA = (contentType: string): MediaClass => ({
  kind: 'unsupported',
  message: `A LinkedIn media_url did not return an image or MP4 video (content-type ${contentType}). Nothing was posted.`,
});

type Sniffed = MediaClass | { kind: 'unknown' };

// An MP4 usually opens with `ftyp`, but some writers put free/wide/skip/mdat/moov first.
const MP4_LEADING_BOXES = ['free', 'wide', 'skip', 'mdat', 'moov'];

function sniff(bytes: Buffer): Sniffed {
  if (bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp') {
    const brand = bytes.toString('latin1', 8, 12).toLowerCase();
    if (IMAGE_FTYP_BRANDS.includes(brand)) return { kind: 'image' };
    if (brand === 'qt  ') return { kind: 'unsupported', message: LINKEDIN_VIDEO_FORMAT_MESSAGE };
    return { kind: 'video' };
  }
  if (bytes.length >= 8 && MP4_LEADING_BOXES.includes(bytes.toString('latin1', 4, 8))) return { kind: 'video' };
  const webmOrMatroska = bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
  const avi = bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'AVI ';
  if (webmOrMatroska || avi) return { kind: 'unsupported', message: LINKEDIN_VIDEO_FORMAT_MESSAGE };
  return { kind: 'unknown' };
}

/** The downloaded bytes are the authority on what a media_url is, not its extension or its content-type. */
export function classifyMedia(contentTypeHeader: unknown, head: Buffer): MediaClass {
  if (head.length === 0) return { kind: 'unsupported', message: 'A LinkedIn media_url returned an empty file. Nothing was posted.' };
  const sniffed = sniff(head);
  if (sniffed.kind !== 'unknown') return sniffed;
  const contentType = String(contentTypeHeader ?? '').split(';')[0].trim().toLowerCase();
  if (contentType.startsWith('image/')) return { kind: 'image' };
  if (MP4_CONTENT_TYPES.includes(contentType)) return { kind: 'video' };
  if (contentType.startsWith('video/')) return { kind: 'unsupported', message: LINKEDIN_VIDEO_FORMAT_MESSAGE };
  if (GENERIC_CONTENT_TYPES.includes(contentType)) return { kind: 'image' }; // unrecognised bytes stay with the image pipeline, as before
  return NOT_MEDIA(contentType);
}

/** Guard for the image-only upload path (also used for link-preview thumbnails). */
export function assertImageDownload(contentTypeHeader: unknown, bytes: Buffer): void {
  const cls = classifyMedia(contentTypeHeader, bytes);
  if (cls.kind === 'image') return;
  const contentType = String(contentTypeHeader ?? '').split(';')[0].trim().toLowerCase() || 'unknown';
  throw new LinkedInUnsupportedMediaError(
    `Expected an image but the URL returned ${cls.kind === 'video' ? 'a video' : `content-type ${contentType}`}. Nothing was posted.`,
  );
}

let activeMediaUploads = 0;
const waitingMediaUploads: Array<() => void> = [];

/** At most LINKEDIN_MAX_CONCURRENT_MEDIA_UPLOADS download-and-upload runs at once, so spooled files stay bounded; the rest queue. */
export async function withMediaUploadSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeMediaUploads >= LINKEDIN_MAX_CONCURRENT_MEDIA_UPLOADS) {
    await new Promise<void>(resolve => waitingMediaUploads.push(resolve));
  } else {
    activeMediaUploads++;
  }
  try {
    return await run();
  } finally {
    const next = waitingMediaUploads.shift();
    if (next) next(); // hand the slot straight over
    else activeMediaUploads--;
  }
}
