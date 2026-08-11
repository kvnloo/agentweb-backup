import AWS from 'aws-sdk';
import crypto from 'crypto';

// Initialize S3
const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-west-2',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const DEFAULT_BUCKET = process.env.AWS_S3_BUCKET || 'agentweb-user-files';
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour

/**
 * Extract an S3 key from a public S3 URL.
 * Supports virtual-hosted style (bucket.s3.amazonaws.com/key)
 * and path-style (s3.amazonaws.com/bucket/key).
 */
export function extractS3KeyFromUrl(
  fileUrl: string,
  bucket: string = DEFAULT_BUCKET
): string | null {
  try {
    const url = new URL(fileUrl);
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+/, '');

    // Virtual-hosted style: bucket.s3.amazonaws.com/key or bucket.s3.region.amazonaws.com/key
    if (host.startsWith(`${bucket}.`)) {
      return path || null;
    }

    // Path-style: s3.amazonaws.com/bucket/key
    if (path.startsWith(`${bucket}/`)) {
      return path.substring(bucket.length + 1) || null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Generate a presigned GET URL for an S3 object.
 */
export function generatePresignedUrl(
  key: string,
  bucket: string = DEFAULT_BUCKET,
  expiresIn: number = PRESIGNED_URL_EXPIRY
): string {
  return s3.getSignedUrl('getObject', {
    Bucket: bucket,
    Key: key,
    Expires: expiresIn,
  });
}

/**
 * Convert a public S3 URL to a presigned URL.
 * Returns null if the URL doesn't belong to the specified bucket.
 */
export function presignS3Url(
  publicUrl: string,
  bucket: string = DEFAULT_BUCKET,
  expiresIn: number = PRESIGNED_URL_EXPIRY
): string | null {
  const key = extractS3KeyFromUrl(publicUrl, bucket);
  if (!key) return null;
  return generatePresignedUrl(key, bucket, expiresIn);
}

/**
 * Check if a URL is a public S3 URL for our bucket.
 */
export function isS3Url(url: string, bucket: string = DEFAULT_BUCKET): boolean {
  return extractS3KeyFromUrl(url, bucket) !== null;
}

/**
 * Get an S3 object as a readable stream (for proxying without public access).
 */
export function getS3ObjectStream(key: string, bucket: string = DEFAULT_BUCKET) {
  return s3.getObject({ Bucket: bucket, Key: key }).createReadStream();
}

/**
 * Get S3 object metadata (content type, size, etc.).
 */
export async function getS3ObjectMetadata(key: string, bucket: string = DEFAULT_BUCKET) {
  return s3.headObject({ Bucket: bucket, Key: key }).promise();
}

/**
 * Classify an S3/AWS error as transient (worth retrying) vs terminal.
 * Terminal: the object/bucket is gone or access is denied — retrying cannot help.
 * Transient: throttling, timeouts, 5xx, and connection resets — a short retry helps.
 */
function isTransientS3Error(error: any): boolean {
  const code = error?.code || error?.name || '';
  const status = error?.statusCode;
  const terminalCodes = new Set([
    'NoSuchKey',
    'NoSuchBucket',
    'AccessDenied',
    'AllAccessDisabled',
    'InvalidObjectState',
    'PermanentRedirect',
  ]);
  if (terminalCodes.has(code)) return false;
  if (status === 404 || status === 403) return false;

  const transientCodes = new Set([
    'RequestTimeout',
    'RequestTimeoutException',
    'Throttling',
    'ThrottlingException',
    'SlowDown',
    'ProvisionedThroughputExceededException',
    'InternalError',
    'ServiceUnavailable',
    'TimeoutError',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'NetworkingError',
  ]);
  if (transientCodes.has(code)) return true;
  if (typeof status === 'number' && status >= 500) return true;
  // Unknown error class: treat as transient so a flaky call gets one more chance,
  // but the bounded retry count keeps this from spiraling.
  return true;
}

/**
 * Download an S3 object and return its content as a UTF-8 string.
 *
 * Retries transient failures (throttling, timeouts, 5xx, connection resets) with
 * exponential backoff. Terminal failures (NoSuchKey/NoSuchBucket/AccessDenied) throw
 * immediately so callers can surface a model-actionable "data no longer available"
 * message instead of pointlessly retrying. The success path is unchanged.
 */
export async function getS3ObjectAsString(
  key: string,
  bucket: string = DEFAULT_BUCKET,
  options?: { maxRetries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<string> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 100;
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await s3.getObject({ Bucket: bucket, Key: key }).promise();
      return result.Body?.toString('utf-8') || '';
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isTransientS3Error(error)) throw error;
      // Exponential backoff with light jitter: 100ms, 200ms, 400ms (+ up to 50ms).
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 50);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Read binary S3 content with an optional hard byte ceiling. */
export async function getS3ObjectAsBuffer(
  key: string,
  bucket: string = DEFAULT_BUCKET,
  maxBytes?: number,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const request: AWS.S3.GetObjectRequest = { Bucket: bucket, Key: key };
  // S3 byte ranges are inclusive. Reading at most maxBytes + 1 lets the caller
  // distinguish an exact-limit object from an oversized one without loading an
  // unbounded asset into process memory.
  if (maxBytes !== undefined) request.Range = `bytes=0-${maxBytes}`;

  const result = await s3.getObject(request).promise();
  if (result.Body === undefined || result.Body === null) {
    throw new Error(`S3 object ${bucket}/${key} returned an empty body`);
  }
  const buffer = Buffer.isBuffer(result.Body) ? result.Body : Buffer.from(result.Body as any);
  if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
    const limit = maxBytes % (1024 * 1024) === 0
      ? `${maxBytes / (1024 * 1024)} MB`
      : `${maxBytes} bytes`;
    throw new Error(`decoded image exceeds the ${limit} limit`);
  }
  return { buffer, contentType: result.ContentType };
}

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

export interface ScreenshotUploadResult {
  url: string;
  attachment: {
    url: string;
    filename: string;
    size: number;
    mimetype: string;
    uploadedAt: string;
  };
}

/**
 * Upload a base64 screenshot data URL to S3.
 * Returns null if the input is not a data URL, or if the upload fails.
 * Never passes raw base64 to callers on failure.
 */
export async function uploadScreenshotToS3(
  screenshot: string,
  userId: string
): Promise<ScreenshotUploadResult | null> {
  if (!screenshot.startsWith('data:image')) return null;
  try {
    const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const uploadResult = await uploadFileToS3(
      buffer,
      `screenshot-${Date.now()}.jpg`,
      userId,
      'image/jpeg'
    );
    if (!uploadResult.success || !uploadResult.url) return null;
    return {
      url: uploadResult.url,
      attachment: {
        url: uploadResult.url,
        filename: 'screenshot.jpg',
        size: buffer.length,
        mimetype: 'image/jpeg',
        uploadedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    console.error('Failed to upload screenshot to S3:', err);
    return null;
  }
}
