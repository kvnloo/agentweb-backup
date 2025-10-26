import AWS from 'aws-sdk';
import crypto from 'crypto';

// Initialize S3
const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-west-2',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

export interface S3UploadResult {
  success: boolean;
  url?: string;
  key?: string;
  error?: string;
}

/**
 * Upload file to S3 with automatic key generation and URL return
 * @param content - File content (Buffer or string)
 * @param filename - Original filename
 * @param userId - User ID for path generation
 * @param contentType - MIME content type
 * @returns Promise with upload result including URL
 */
export async function uploadFileToS3(
  content: Buffer | string,
  filename: string,
  userId: string,
  contentType: string
): Promise<S3UploadResult> {
  try {
    // Normalize and sanitize filename to reduce risk of signature issues from non-ASCII chars
    const normalizedFilename = (filename || "")
      .normalize("NFKD")
      // remove combining diacritical marks
      .replace(/[\u0300-\u036f]/g, "");

    // Generate random token for uniqueness
    const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Sanitize filename for S3 key (ASCII-only, safe chars)
    const sanitizedFilename = normalizedFilename
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/\s+/g, '_');

    // S3 object metadata values must be US-ASCII. Prepare a safe metadata value.
    const asciiMetadataFilename = normalizedFilename
      // remove non-ASCII characters
      .replace(/[^\x20-\x7E]/g, '')
      // collapse whitespace/newlines
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      // ensure non-empty
      || sanitizedFilename
      || 'file';

    // Generate S3 key: users/{userId}/files/{timestamp}/{token}/{filename}
    const key = `users/${userId}/files/${Date.now()}/${randomToken}/${sanitizedFilename}`;

    // Upload to S3 directly
    const bucket = process.env.AWS_S3_BUCKET || 'agentweb-user-files';
    const params = {
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      Metadata: {
        'original-filename': asciiMetadataFilename,
        'uploaded-by': 'agent-mode',
        'upload-timestamp': new Date().toISOString()
      }
    };

    const result = await s3.upload(params).promise();

    return {
      success: true,
      url: result.Location,
      key: result.Key
    };
  } catch (error) {
    console.error('Error in uploadFileToS3:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Upload file to S3 with a specific path structure
 * @param content - File content (Buffer or string)
 * @param filename - Original filename
 * @param contentType - MIME content type
 * @param path - Path prefix for the S3 key
 * @returns Promise with upload result including URL
 */
export async function uploadFileToS3WithPath(
  content: Buffer | string,
  filename: string,
  contentType: string,
  path: string
): Promise<S3UploadResult> {
  try {
    // Normalize and sanitize filename to reduce risk of signature issues from non-ASCII chars
    const normalizedFilename = (filename || "")
      .normalize("NFKD")
      // remove combining diacritical marks
      .replace(/[\u0300-\u036f]/g, "");

    // Sanitize filename for S3 key (ASCII-only, safe chars)
    const sanitizedFilename = normalizedFilename
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/\s+/g, '_');

    // S3 object metadata values must be US-ASCII. Prepare a safe metadata value.
    const asciiMetadataFilename = normalizedFilename
      // remove non-ASCII characters
      .replace(/[^\x20-\x7E]/g, '')
      // collapse whitespace/newlines
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      // ensure non-empty
      || sanitizedFilename
      || 'file';

    // Clean and normalize the path
    const cleanPath = path
      .replace(/^\/+|\/+$/g, '') // Remove leading and trailing slashes
      .replace(/\/+/g, '/'); // Replace multiple slashes with single slash

    // Generate S3 key: {path}/{sanitizedFilename}
    const key = cleanPath ? `${cleanPath}/${sanitizedFilename}` : sanitizedFilename;

    // Upload to S3 directly
    const bucket = process.env.AWS_S3_BUCKET || 'agentweb-user-files';
    const params = {
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: contentType,
      Metadata: {
        'original-filename': asciiMetadataFilename,
        'uploaded-by': 'agent-mode',
        'upload-timestamp': new Date().toISOString()
      }
    };

    const result = await s3.upload(params).promise();

    return {
      success: true,
      url: result.Location,
      key: result.Key
    };
  } catch (error) {
    console.error('Error in uploadFileToS3WithPath:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
