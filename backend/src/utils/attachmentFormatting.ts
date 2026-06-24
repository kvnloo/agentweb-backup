/**
 * Shared formatting for user-message attachments surfaced to the agent (Emma).
 *
 * A single source of truth for the per-attachment hint, used by both the live
 * message path (agentModeController) and the history-reconstruction path
 * (agentModeService) so the two can't drift.
 *
 * The image hint deliberately steers the model to use an uploaded image as a
 * video frame (startFrame/endFrame on generate_video) — not only to describe it.
 * Without this, the model defaults to describe_image and reference images never
 * reach the video model as actual frames. describe_image remains offered for the
 * plain "analyze this image" case.
 */

const IMAGE_MIMETYPES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const VIDEO_MIMETYPES = new Set([
  'video/mp4', 'video/quicktime', 'video/webm', 'video/avi', 'video/x-msvideo',
]);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'webm', 'mkv']);

const IMAGE_HINT =
  ' (image — to turn it into a video, pass this URL as startFrame (and a second image as endFrame) to generate_video; to analyze its contents, use describe_image)';
const VIDEO_HINT = ' (video — use describe_video tool to analyze)';
const DOCUMENT_HINT = ' (document — use read_file_content tool to read its contents)';

export interface AttachmentLike {
  filename?: string;
  url?: string;
  mimetype?: string;
}

/** Return the trailing hint (with a leading space) for an attachment by mimetype/filename. */
export function getAttachmentHint(mimetype?: string, filename?: string): string {
  const mt = (mimetype || '').toLowerCase();
  // split('.') always yields ≥1 element so pop() is never undefined; the `|| ''`
  // covers the no-extension case (filename '' → ext '').
  const ext = ((filename || '').split('.').pop() || '').toLowerCase();
  if (IMAGE_MIMETYPES.has(mt) || IMAGE_EXTS.has(ext)) return IMAGE_HINT;
  if (VIDEO_MIMETYPES.has(mt) || VIDEO_EXTS.has(ext)) return VIDEO_HINT;
  return DOCUMENT_HINT;
}

/** Build the markdown link + hint for a single attachment. */
export function formatAttachmentLine(attachment: AttachmentLike): string {
  const hint = getAttachmentHint(attachment.mimetype, attachment.filename);
  return `[${attachment.filename || 'Attachment'}](${attachment.url})${hint}`;
}

/** Build the newline-joined attachment block for a set of attachments. */
export function formatAttachmentUrls(attachments: AttachmentLike[]): string {
  return attachments.map(formatAttachmentLine).join('\n');
}
