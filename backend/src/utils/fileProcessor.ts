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
  'xlsm'
] as const;

export type SupportedFileType = typeof SUPPORTED_FILE_TYPES[number];

/**
 * Get file type from MIME type
 */
function getFileTypeFromMime(mimeType?: string): string {
  if (!mimeType) return 'unknown';

  const mimeMap: Record<string, string> = {
    'text/plain': 'txt',
    'text/html': 'html',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-excel.sheet.macroEnabled.12': 'xlsm'
  };

  return mimeMap[mimeType] || 'unknown';
}

/**
 * Validate file type
 */
export function isSupportedFileType(filename: string, mimeType?: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase() || '';
  
  if (SUPPORTED_FILE_TYPES.includes(extension as SupportedFileType)) {
    return true;
  }

  if (mimeType) {
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

  const extension = filename.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    'txt': 'text/plain',
    'html': 'text/html',
    'htm': 'text/html',
    'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12'
  };

  return mimeMap[extension] || 'application/octet-stream';
}
