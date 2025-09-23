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
    // Generate random token for uniqueness
    const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Sanitize filename for S3 key
    const sanitizedFilename = filename
      .replace(/[^a-zA-Z0-9.-]/g, '_')
      .replace(/\s+/g, '_');

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
        'original-filename': filename,
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
