/**
 * Supported file types for knowledge base uploads
 */
export const SUPPORTED_FILE_TYPES = [
  'txt',
  'pdf',
  'html',
  'htm',
  'docx',
  'pptx',
  'xlsx',
  'xlsm',
  'csv',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'mp4',
  'mov',
  'webm',
  'ogg',
  'm4v',
  'avi'
] as const;

export type SupportedFileType = typeof SUPPORTED_FILE_TYPES[number];

/**
 * Get file type from MIME type
 */
function getFileTypeFromMime(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    'text/plain': 'txt',
    'text/html': 'html',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel.sheet.macroEnabled.12': 'xlsm',
    'text/csv': 'csv',
    'application/csv': 'csv',
    'application/vnd.ms-excel': 'csv',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/ogg': 'ogg',
    'video/x-m4v': 'm4v',
    'video/x-msvideo': 'avi'
  };

  return mimeMap[mimeType] || 'unknown';
}

/**
 * Validate file type
 */
export function isSupportedFileType(filename: string, mimeType?: string): boolean {
  const extension = (filename.split('.').pop() || '').toLowerCase();
  
  if (SUPPORTED_FILE_TYPES.includes(extension as SupportedFileType)) {
    return true;
  }

  if (mimeType) {
    if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
      return true;
    }
    const fileType = getFileTypeFromMime(mimeType);
    return SUPPORTED_FILE_TYPES.includes(fileType as SupportedFileType);
  }

  return false;
}

/**
 * Get content type for a file
 */
export function getContentType(filename: string, mimeType?: string): string {
  if (mimeType) return mimeType;

  const extension = (filename.split('.').pop() || '').toLowerCase();
  const mimeMap: Record<string, string> = {
    'txt': 'text/plain',
    'html': 'text/html',
    'htm': 'text/html',
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    'csv': 'text/csv',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'svg': 'image/svg+xml',
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'webm': 'video/webm',
    'ogg': 'video/ogg',
    'm4v': 'video/x-m4v',
    'avi': 'video/x-msvideo'
  };

  return mimeMap[extension] || 'application/octet-stream';
}
