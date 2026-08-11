// Set up mock before any imports
let mockUploadPromise = jest.fn();
const mockUpload = jest.fn(() => ({
  promise: mockUploadPromise
}));
const mockGetSignedUrl = jest.fn();
const mockGetObject = jest.fn();
const mockHeadObject = jest.fn();

jest.mock('aws-sdk', () => {
  return {
    S3: jest.fn(() => ({
      upload: mockUpload,
      getSignedUrl: mockGetSignedUrl,
      getObject: mockGetObject,
      headObject: mockHeadObject,
    }))
  };
});

// Import after mocking
import {
  uploadFileToS3,
  uploadFileToS3WithPath,
  extractS3KeyFromUrl,
  generatePresignedUrl,
  presignS3Url,
  isS3Url,
  getS3ObjectStream,
  getS3ObjectMetadata,
  getS3ObjectAsString,
  getS3ObjectAsBuffer,
  uploadScreenshotToS3,
} from '../../utils/s3Utils';

describe('s3Utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AWS_S3_BUCKET = 'test-bucket';
    mockUploadPromise = jest.fn();
    mockUpload.mockImplementation(() => ({
      promise: mockUploadPromise
    }));
  });

  afterEach(() => {
    delete process.env.AWS_S3_BUCKET;
  });

  describe('uploadFileToS3', () => {
    it('should upload file successfully and return result', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/users/user-123/files/123/token/test.txt',
        Key: 'users/user-123/files/123/token/test.txt'
      });

      const result = await uploadFileToS3(
        Buffer.from('test content'),
        'test.txt',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(true);
      expect(result.url).toBeDefined();
      expect(result.key).toBeDefined();
    });

    it('should handle upload errors gracefully', async () => {
      mockUploadPromise.mockRejectedValue(new Error('Upload failed'));

      const result = await uploadFileToS3(
        Buffer.from('test content'),
        'test.txt',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Upload failed');
    });

    it('should sanitize filename with special characters', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/users/user-123/files/123/token/file_name.txt',
        Key: 'users/user-123/files/123/token/file_name.txt'
      });

      const result = await uploadFileToS3(
        Buffer.from('test content'),
        'file name with spaces!@#$.txt',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(true);
    });

    it('should handle non-ASCII characters in filename', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/users/user-123/files/123/token/cafe.txt',
        Key: 'users/user-123/files/123/token/cafe.txt'
      });

      const result = await uploadFileToS3(
        Buffer.from('test content'),
        'café.txt',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(true);
    });

    it('should handle empty filename', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/users/user-123/files/123/token/',
        Key: 'users/user-123/files/123/token/'
      });

      const result = await uploadFileToS3(
        Buffer.from('test content'),
        '',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(true);
    });

    it('should handle unknown errors', async () => {
      mockUploadPromise.mockRejectedValue('Unknown error type');

      const result = await uploadFileToS3(
        Buffer.from('test content'),
        'test.txt',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should use default bucket when env var not set', async () => {
      delete process.env.AWS_S3_BUCKET;
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/agentweb-user-files/users/user-123/files/123/token/test.txt',
        Key: 'users/user-123/files/123/token/test.txt'
      });

      const result = await uploadFileToS3(
        Buffer.from('test content'),
        'test.txt',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(true);
    });

    it('should handle string content', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/users/user-123/files/123/token/test.txt',
        Key: 'users/user-123/files/123/token/test.txt'
      });

      const result = await uploadFileToS3(
        'string content',
        'test.txt',
        'user-123',
        'text/plain'
      );

      expect(result.success).toBe(true);
    });
  });

  describe('uploadFileToS3WithPath', () => {
    it('should upload file with custom path', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/custom/path/test.txt',
        Key: 'custom/path/test.txt'
      });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'test.txt',
        'text/plain',
        'custom/path'
      );

      expect(result.success).toBe(true);
      expect(result.key).toContain('custom/path');
    });

    it('should handle path with leading/trailing slashes', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/clean/path/test.txt',
        Key: 'clean/path/test.txt'
      });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'test.txt',
        'text/plain',
        '///clean//path///'
      );

      expect(result.success).toBe(true);
    });

    it('should handle empty path', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/test.txt',
        Key: 'test.txt'
      });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'test.txt',
        'text/plain',
        ''
      );

      expect(result.success).toBe(true);
    });

    it('should handle upload errors', async () => {
      mockUploadPromise.mockRejectedValue(new Error('Path upload failed'));

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'test.txt',
        'text/plain',
        'custom/path'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path upload failed');
    });

    it('should sanitize filename in path upload', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/path/file_name.txt',
        Key: 'path/file_name.txt'
      });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'file name!@#.txt',
        'text/plain',
        'path'
      );

      expect(result.success).toBe(true);
    });

    it('should handle unknown errors in path upload', async () => {
      mockUploadPromise.mockRejectedValue({ code: 'UnknownError' });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'test.txt',
        'text/plain',
        'path'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle non-ASCII characters in filename for path upload', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/path/cafe.txt',
        Key: 'path/cafe.txt'
      });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'café.txt',
        'text/plain',
        'path'
      );

      expect(result.success).toBe(true);
    });

    it('should handle empty filename in path upload', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/path/',
        Key: 'path/'
      });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        '',
        'text/plain',
        'path'
      );

      expect(result.success).toBe(true);
    });
    it('should use default bucket when env var not set', async () => {
      delete process.env.AWS_S3_BUCKET;
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/agentweb-user-files/path/test.txt',
        Key: 'path/test.txt'
      });

      const result = await uploadFileToS3WithPath(
        Buffer.from('test content'),
        'test.txt',
        'text/plain',
        'path'
      );

      expect(result.success).toBe(true);
      expect(result.key).toBe('path/test.txt');
    });
  });

  describe('extractS3KeyFromUrl', () => {
    it('should extract key from virtual-hosted style URL', () => {
      const key = extractS3KeyFromUrl(
        'https://test-bucket.s3.amazonaws.com/users/123/file.txt',
        'test-bucket'
      );
      expect(key).toBe('users/123/file.txt');
    });

    it('should extract key from virtual-hosted style URL with region', () => {
      const key = extractS3KeyFromUrl(
        'https://test-bucket.s3.us-west-2.amazonaws.com/users/123/file.txt',
        'test-bucket'
      );
      expect(key).toBe('users/123/file.txt');
    });

    it('should extract key from path-style URL', () => {
      const key = extractS3KeyFromUrl(
        'https://s3.amazonaws.com/test-bucket/users/123/file.txt',
        'test-bucket'
      );
      expect(key).toBe('users/123/file.txt');
    });

    it('should return null for non-matching bucket', () => {
      const key = extractS3KeyFromUrl(
        'https://other-bucket.s3.amazonaws.com/file.txt',
        'test-bucket'
      );
      expect(key).toBeNull();
    });

    it('should return null for non-S3 URL', () => {
      const key = extractS3KeyFromUrl(
        'https://example.com/file.txt',
        'test-bucket'
      );
      expect(key).toBeNull();
    });

    it('should return null for invalid URL', () => {
      const key = extractS3KeyFromUrl('not-a-url', 'test-bucket');
      expect(key).toBeNull();
    });

    it('should use default bucket when none specified', () => {
      delete process.env.AWS_S3_BUCKET;
      const key = extractS3KeyFromUrl(
        'https://agentweb-user-files.s3.amazonaws.com/users/123/file.txt'
      );
      expect(key).toBe('users/123/file.txt');
    });

    it('should return null for virtual-hosted URL with no key (empty path)', () => {
      const key = extractS3KeyFromUrl('https://test-bucket.s3.amazonaws.com', 'test-bucket');
      expect(key).toBeNull();
    });

    it('should return null for path-style URL with no key (trailing slash only)', () => {
      const key = extractS3KeyFromUrl('https://s3.amazonaws.com/test-bucket/', 'test-bucket');
      expect(key).toBeNull();
    });
  });

  describe('generatePresignedUrl', () => {
    it('should call S3 getSignedUrl with correct params', () => {
      mockGetSignedUrl.mockReturnValue('https://presigned-url.example.com');

      const result = generatePresignedUrl('users/123/file.txt', 'test-bucket');

      expect(mockGetSignedUrl).toHaveBeenCalledWith('getObject', {
        Bucket: 'test-bucket',
        Key: 'users/123/file.txt',
        Expires: 3600,
      });
      expect(result).toBe('https://presigned-url.example.com');
    });

    it('should accept custom expiry', () => {
      mockGetSignedUrl.mockReturnValue('https://presigned-url.example.com');

      generatePresignedUrl('file.txt', 'test-bucket', 7200);

      expect(mockGetSignedUrl).toHaveBeenCalledWith('getObject', {
        Bucket: 'test-bucket',
        Key: 'file.txt',
        Expires: 7200,
      });
    });

    it('should use default bucket when none specified', () => {
      delete process.env.AWS_S3_BUCKET;
      mockGetSignedUrl.mockReturnValue('https://presigned-url.example.com');
      generatePresignedUrl('file.txt');
      expect(mockGetSignedUrl).toHaveBeenCalledWith('getObject', expect.objectContaining({
        Key: 'file.txt',
      }));
    });
  });

  describe('presignS3Url', () => {
    it('should convert a public S3 URL to a presigned URL', () => {
      mockGetSignedUrl.mockReturnValue('https://presigned-url.example.com');

      const result = presignS3Url(
        'https://test-bucket.s3.amazonaws.com/users/123/file.txt',
        'test-bucket'
      );

      expect(result).toBe('https://presigned-url.example.com');
    });

    it('should return null for non-S3 URL', () => {
      const result = presignS3Url(
        'https://example.com/file.txt',
        'test-bucket'
      );
      expect(result).toBeNull();
    });

    it('should use default bucket when none specified', () => {
      delete process.env.AWS_S3_BUCKET;
      const result = presignS3Url('https://example.com/file.txt');
      expect(result).toBeNull();
    });
  });

  describe('isS3Url', () => {
    it('should return true for matching S3 URL', () => {
      expect(isS3Url(
        'https://test-bucket.s3.amazonaws.com/file.txt',
        'test-bucket'
      )).toBe(true);
    });

    it('should return false for non-matching URL', () => {
      expect(isS3Url(
        'https://example.com/file.txt',
        'test-bucket'
      )).toBe(false);
    });

    it('should use default bucket when none specified', () => {
      delete process.env.AWS_S3_BUCKET;
      expect(isS3Url('https://example.com/file.txt')).toBe(false);
    });
  });

  describe('getS3ObjectStream', () => {
    it('should call s3.getObject with correct params and return a stream', () => {
      const mockStream = { pipe: jest.fn() };
      mockGetObject.mockReturnValue({ createReadStream: () => mockStream });

      const result = getS3ObjectStream('users/123/file.txt', 'test-bucket');

      expect(mockGetObject).toHaveBeenCalledWith({ Bucket: 'test-bucket', Key: 'users/123/file.txt' });
      expect(result).toBe(mockStream);
    });

    it('should use default bucket when none specified', () => {
      delete process.env.AWS_S3_BUCKET;
      const mockStream = { pipe: jest.fn() };
      mockGetObject.mockReturnValue({ createReadStream: () => mockStream });

      getS3ObjectStream('file.txt');

      expect(mockGetObject).toHaveBeenCalledWith({ Bucket: 'agentweb-user-files', Key: 'file.txt' });
    });
  });

  describe('getS3ObjectMetadata', () => {
    it('should call s3.headObject with correct params', async () => {
      const mockMetadata = { ContentType: 'text/html', ContentLength: 1234 };
      mockHeadObject.mockReturnValue({ promise: () => Promise.resolve(mockMetadata) });

      const result = await getS3ObjectMetadata('users/123/file.txt', 'test-bucket');

      expect(mockHeadObject).toHaveBeenCalledWith({ Bucket: 'test-bucket', Key: 'users/123/file.txt' });
      expect(result).toEqual(mockMetadata);
    });

    it('should use default bucket when none specified', async () => {
      delete process.env.AWS_S3_BUCKET;
      mockHeadObject.mockReturnValue({ promise: () => Promise.resolve({}) });

      await getS3ObjectMetadata('file.txt');

      expect(mockHeadObject).toHaveBeenCalledWith({ Bucket: 'agentweb-user-files', Key: 'file.txt' });
    });
  });

  describe('getS3ObjectAsString', () => {
    it('should return string content from S3 object', async () => {
      mockGetObject.mockReturnValue({
        promise: () => Promise.resolve({ Body: Buffer.from('hello world') }),
      });

      const result = await getS3ObjectAsString('path/to/file.txt', 'test-bucket');

      expect(mockGetObject).toHaveBeenCalledWith({ Bucket: 'test-bucket', Key: 'path/to/file.txt' });
      expect(result).toBe('hello world');
    });

    it('should return empty string when Body is undefined', async () => {
      mockGetObject.mockReturnValue({
        promise: () => Promise.resolve({ Body: undefined }),
      });

      const result = await getS3ObjectAsString('path/to/file.txt', 'test-bucket');

      expect(result).toBe('');
    });

    it('should use default bucket when none specified', async () => {
      delete process.env.AWS_S3_BUCKET;
      mockGetObject.mockReturnValue({
        promise: () => Promise.resolve({ Body: Buffer.from('content') }),
      });

      await getS3ObjectAsString('file.txt');

      expect(mockGetObject).toHaveBeenCalledWith({ Bucket: 'agentweb-user-files', Key: 'file.txt' });
    });

    it('retries a transient error then succeeds (behavior preserved on success)', async () => {
      const transient = Object.assign(new Error('throttled'), { code: 'Throttling' });
      mockGetObject
        .mockReturnValueOnce({ promise: () => Promise.reject(transient) })
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Body: Buffer.from('recovered') }) });

      const noSleep = jest.fn(() => Promise.resolve());
      const result = await getS3ObjectAsString('flaky.txt', 'test-bucket', { sleep: noSleep });

      expect(result).toBe('recovered');
      expect(mockGetObject).toHaveBeenCalledTimes(2);
      expect(noSleep).toHaveBeenCalledTimes(1);
    });

    it('retries 5xx server errors with backoff', async () => {
      const serverErr = Object.assign(new Error('internal'), { statusCode: 503 });
      mockGetObject
        .mockReturnValueOnce({ promise: () => Promise.reject(serverErr) })
        .mockReturnValueOnce({ promise: () => Promise.reject(serverErr) })
        .mockReturnValueOnce({ promise: () => Promise.resolve({ Body: Buffer.from('ok') }) });

      const noSleep = jest.fn(() => Promise.resolve());
      const result = await getS3ObjectAsString('flaky.txt', 'test-bucket', { sleep: noSleep });

      expect(result).toBe('ok');
      expect(mockGetObject).toHaveBeenCalledTimes(3);
    });

    it('does NOT retry terminal NoSuchKey errors', async () => {
      const notFound = Object.assign(new Error('The specified key does not exist.'), { code: 'NoSuchKey' });
      mockGetObject.mockReturnValue({ promise: () => Promise.reject(notFound) });

      const noSleep = jest.fn(() => Promise.resolve());
      await expect(getS3ObjectAsString('gone.txt', 'test-bucket', { sleep: noSleep })).rejects.toThrow('key does not exist');
      expect(mockGetObject).toHaveBeenCalledTimes(1);
      expect(noSleep).not.toHaveBeenCalled();
    });

    it('does NOT retry terminal AccessDenied errors', async () => {
      const denied = Object.assign(new Error('Access Denied'), { code: 'AccessDenied' });
      mockGetObject.mockReturnValue({ promise: () => Promise.reject(denied) });

      const noSleep = jest.fn(() => Promise.resolve());
      await expect(getS3ObjectAsString('denied.txt', 'test-bucket', { sleep: noSleep })).rejects.toThrow('Access Denied');
      expect(mockGetObject).toHaveBeenCalledTimes(1);
    });

    it('gives up after maxRetries on persistent transient errors', async () => {
      const transient = Object.assign(new Error('timeout'), { code: 'TimeoutError' });
      mockGetObject.mockReturnValue({ promise: () => Promise.reject(transient) });

      const noSleep = jest.fn(() => Promise.resolve());
      await expect(
        getS3ObjectAsString('flaky.txt', 'test-bucket', { maxRetries: 2, sleep: noSleep }),
      ).rejects.toThrow('timeout');
      // initial attempt + 2 retries = 3 calls
      expect(mockGetObject).toHaveBeenCalledTimes(3);
      expect(noSleep).toHaveBeenCalledTimes(2);
    });
  });

  describe('getS3ObjectAsBuffer', () => {
    it('uses a bounded range and accepts an object exactly at the byte limit', async () => {
      mockGetObject.mockReturnValue({
        promise: () => Promise.resolve({ Body: Buffer.alloc(5), ContentType: 'image/png' }),
      });

      const result = await getS3ObjectAsBuffer('private/chart.png', 'test-bucket', 5);

      expect(mockGetObject).toHaveBeenCalledWith({
        Bucket: 'test-bucket',
        Key: 'private/chart.png',
        Range: 'bytes=0-5',
      });
      expect(result).toEqual({ buffer: Buffer.alloc(5), contentType: 'image/png' });
    });

    it('rejects the max-plus-one sentinel returned by the bounded range', async () => {
      mockGetObject.mockReturnValue({
        promise: () => Promise.resolve({ Body: Buffer.alloc(6), ContentType: 'image/png' }),
      });

      await expect(getS3ObjectAsBuffer('private/huge.png', 'test-bucket', 5)).rejects.toThrow(
        /exceeds the 5 bytes limit/i,
      );
    });

    it('rejects an absent body instead of treating it as an empty image', async () => {
      mockGetObject.mockReturnValue({ promise: () => Promise.resolve({}) });

      await expect(getS3ObjectAsBuffer('private/missing.png', 'test-bucket', 5)).rejects.toThrow(
        /empty body/i,
      );
    });
  });

  describe('uploadScreenshotToS3', () => {
    it('should upload a valid base64 screenshot and return result', async () => {
      mockUploadPromise.mockResolvedValue({
        Location: 'https://s3.amazonaws.com/test-bucket/users/user-1/screenshot-123.jpg',
        Key: 'users/user-1/screenshot-123.jpg',
      });

      const result = await uploadScreenshotToS3('data:image/png;base64,abc123', 'user-1');

      expect(result).not.toBeNull();
      expect(result!.url).toBeDefined();
    });

    it('should return null for non-image data URI', async () => {
      const result = await uploadScreenshotToS3('data:text/plain;base64,abc', 'user-1');

      expect(result).toBeNull();
      expect(mockUpload).not.toHaveBeenCalled();
    });

    it('should return null when upload fails', async () => {
      mockUploadPromise.mockResolvedValue({ Location: undefined, Key: undefined });

      const result = await uploadScreenshotToS3('data:image/png;base64,abc123', 'user-1');

      expect(result).toBeNull();
    });

    it('should return null and log error when upload throws', async () => {
      mockUploadPromise.mockRejectedValue(new Error('Network error'));

      const result = await uploadScreenshotToS3('data:image/png;base64,abc123', 'user-1');

      expect(result).toBeNull();
    });
  });
});
