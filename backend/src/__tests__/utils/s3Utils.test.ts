// Set up mock before any imports
let mockUploadPromise = jest.fn();
const mockUpload = jest.fn(() => ({
  promise: mockUploadPromise
}));

jest.mock('aws-sdk', () => {
  return {
    S3: jest.fn(() => ({
      upload: mockUpload
    }))
  };
});

// Import after mocking
import { uploadFileToS3, uploadFileToS3WithPath, isAllowedUploadType } from '../../utils/s3Utils';

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

  describe('isAllowedUploadType', () => {
    it('should allow safe image types', () => {
      expect(isAllowedUploadType('photo.jpg', 'image/jpeg')).toBe(true);
      expect(isAllowedUploadType('image.png', 'image/png')).toBe(true);
      expect(isAllowedUploadType('anim.gif', 'image/gif')).toBe(true);
      expect(isAllowedUploadType('pic.webp', 'image/webp')).toBe(true);
    });

    it('should allow safe document types', () => {
      expect(isAllowedUploadType('doc.pdf', 'application/pdf')).toBe(true);
      expect(isAllowedUploadType('data.csv', 'text/csv')).toBe(true);
      expect(isAllowedUploadType('notes.txt', 'text/plain')).toBe(true);
    });

    it('should allow video and audio types', () => {
      expect(isAllowedUploadType('clip.mp4', 'video/mp4')).toBe(true);
      expect(isAllowedUploadType('song.mp3', 'audio/mpeg')).toBe(true);
    });

    it('should block HTML files (XSS vector)', () => {
      expect(isAllowedUploadType('page.html', 'text/html')).toBe(false);
      expect(isAllowedUploadType('page.htm', 'text/html')).toBe(false);
      expect(isAllowedUploadType('page.xhtml', 'application/xhtml+xml')).toBe(false);
    });

    it('should block SVG files (script injection vector)', () => {
      expect(isAllowedUploadType('icon.svg', 'image/svg+xml')).toBe(false);
    });

    it('should block JavaScript files', () => {
      expect(isAllowedUploadType('script.js', 'application/javascript')).toBe(false);
      expect(isAllowedUploadType('module.mjs', 'application/javascript')).toBe(false);
    });

    it('should block executable files', () => {
      expect(isAllowedUploadType('app.exe', 'application/octet-stream')).toBe(false);
      expect(isAllowedUploadType('script.sh', 'application/x-sh')).toBe(false);
      expect(isAllowedUploadType('run.bat', 'application/x-msdos-program')).toBe(false);
    });

    it('should block server-side script extensions', () => {
      expect(isAllowedUploadType('page.php', 'text/plain')).toBe(false);
      expect(isAllowedUploadType('page.jsp', 'text/plain')).toBe(false);
      expect(isAllowedUploadType('app.py', 'text/plain')).toBe(false);
    });

    it('should block based on extension even with allowed MIME type', () => {
      // MIME spoofing: claims to be image/jpeg but has .html extension
      expect(isAllowedUploadType('malicious.html', 'image/jpeg')).toBe(false);
    });

    it('should reject unknown MIME types with safe extensions', () => {
      expect(isAllowedUploadType('data.bin', 'application/octet-stream')).toBe(false);
    });

    it('should handle empty filename gracefully', () => {
      expect(isAllowedUploadType('', 'image/jpeg')).toBe(true);
    });

    it('should be case-insensitive for MIME types', () => {
      expect(isAllowedUploadType('photo.jpg', 'IMAGE/JPEG')).toBe(true);
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
});
