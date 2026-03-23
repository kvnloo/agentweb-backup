import { decodeAssetHash, trackVisit, visitMap, hashIp } from '../controllers/assetController';

describe('assetController', () => {
  beforeEach(() => {
    visitMap.clear();
  });

  describe('decodeAssetHash', () => {
    it('should decode a valid base64url-encoded S3 URL (virtual-hosted style)', () => {
      const s3Url = 'https://agentweb-user-files.s3.amazonaws.com/users/abc123/files/123/report.html';
      const encoded = Buffer.from(s3Url).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const result = decodeAssetHash(encoded);
      expect(result).not.toBeNull();
      expect(result!.bucket).toBe('agentweb-user-files');
      expect(result!.key).toBe('users/abc123/files/123/report.html');
    });

    it('should decode a valid base64url-encoded S3 URL (virtual-hosted with region)', () => {
      const s3Url = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/abc123/files/123/report.html';
      const encoded = Buffer.from(s3Url).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const result = decodeAssetHash(encoded);
      expect(result).not.toBeNull();
      expect(result!.bucket).toBe('agentweb-user-files');
      expect(result!.key).toBe('users/abc123/files/123/report.html');
    });

    it('should decode S3 URL from execution-gifs bucket', () => {
      const s3Url = 'https://agentweb-execution-gifs.s3.amazonaws.com/task_results/123/report.html';
      const encoded = Buffer.from(s3Url).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const result = decodeAssetHash(encoded);
      expect(result).not.toBeNull();
      expect(result!.bucket).toBe('agentweb-execution-gifs');
      expect(result!.key).toBe('task_results/123/report.html');
    });

    it('should return null for a non-S3 URL', () => {
      const badUrl = 'https://evil.com/malicious.html';
      const encoded = Buffer.from(badUrl).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(decodeAssetHash(encoded)).toBeNull();
    });

    it('should return null for a disallowed bucket', () => {
      const badUrl = 'https://other-bucket.s3.amazonaws.com/secret/file.html';
      const encoded = Buffer.from(badUrl).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(decodeAssetHash(encoded)).toBeNull();
    });

    it('should return null for non-https URL', () => {
      const badUrl = 'http://agentweb-user-files.s3.amazonaws.com/users/test/file.html';
      const encoded = Buffer.from(badUrl).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      expect(decodeAssetHash(encoded)).toBeNull();
    });

    it('should return null for invalid base64', () => {
      expect(decodeAssetHash('!!!not-base64!!!')).toBeNull();
    });
  });

  describe('trackVisit', () => {
    it('should count the first visit as unique', () => {
      const result = trackVisit('hash123', '1.2.3.4');
      expect(result.count).toBe(1);
      expect(result.isNew).toBe(true);
    });

    it('should not double-count the same IP', () => {
      trackVisit('hash123', '1.2.3.4');
      const result = trackVisit('hash123', '1.2.3.4');
      expect(result.count).toBe(1);
      expect(result.isNew).toBe(false);
    });

    it('should count different IPs separately', () => {
      trackVisit('hash123', '1.2.3.4');
      const result = trackVisit('hash123', '5.6.7.8');
      expect(result.count).toBe(2);
      expect(result.isNew).toBe(true);
    });

    it('should track different assets independently', () => {
      trackVisit('hashA', '1.2.3.4');
      trackVisit('hashB', '1.2.3.4');
      expect(visitMap.get('hashA')?.count).toBe(1);
      expect(visitMap.get('hashB')?.count).toBe(1);
    });
  });

  describe('hashIp', () => {
    it('should produce a consistent 16-char hex string', () => {
      const hash = hashIp('192.168.1.1');
      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
      expect(hashIp('192.168.1.1')).toBe(hash);
    });

    it('should produce different hashes for different IPs', () => {
      expect(hashIp('1.1.1.1')).not.toBe(hashIp('2.2.2.2'));
    });
  });
});
