import { AgentModeService } from '../services/agentModeService';
import { DynamoDB } from 'aws-sdk';
// ENG-2103 (F2): updateHtmlFile's body now lives in emma/impl/htmlUpdate.ts
// and calls fetchFileContent/uploadUpdatedFile there directly (not
// `this.<method>`), so the spies below target that module instead of the
// class singleton.
import * as htmlUpdateImpl from '../emma/impl/htmlUpdate';

// Mock AWS SDK
jest.mock('aws-sdk', () => ({
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    }))
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
  })),
  config: {
    update: jest.fn()
  }
}));

// Mock axios
jest.mock('axios', () => ({
  get: jest.fn(),
}));

// Mock crypto
// ENG-2103 F2 full-suite checkpoint: spread the REAL crypto module rather than
// a bare { createHash } stub — see readFileContent.test.ts's comment on this
// same pattern for why (agentModeController.ts's uuid.v4() call needs
// crypto.randomFillSync at module load).
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  createHash: jest.fn()
}));

// Mock s3Utils
// Who may write which S3 key (the ENG-2988 rule) is a boundary here, covered with the real policy in updateHtmlFile.storageAccess.test.ts.
// These tests are about what the tool does with the file once it may write it.
jest.mock('../services/storageAccessPolicy', () => ({
  ...jest.requireActual('../services/storageAccessPolicy'),
  decideStorageAccess: jest.fn().mockResolvedValue({ allow: true }),
}));

jest.mock('../utils/s3Utils', () => ({
  // the file name the upload would write (the write check authorises that exact key)
  sanitizeS3Filename: (name: string) => name,
  extractS3KeyFromUrl: (url: string) => jest.requireActual('../utils/s3Utils').extractS3KeyFromUrl(url),
  uploadFileToS3WithPath: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/bucket/updated_file_v2.html',
    key: 'updated_file_v2.html'
  })
}));

describe('updateHtmlFile', () => {
  let agentModeService: AgentModeService;
  let mockDynamoDB: jest.Mocked<DynamoDB>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    mockDynamoDB = {
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    } as any;

    agentModeService = new AgentModeService();
    (agentModeService as any).dynamoDB = mockDynamoDB;

    // Setup crypto mock
    const mockHash = {
      update: jest.fn().mockReturnThis(),
      digest: jest.fn().mockReturnValue('mock-hash-123')
    };
    const { createHash } = require('crypto');
    createHash.mockReturnValue(mockHash);
  });

  describe('update_type validation', () => {
    it('should reject invalid update_type', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'invalid',
        [],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('update_type must be either "part" or "full"');
    });

    it('should accept valid update_type "part"', async () => {
      // Mock fetchFileContent
      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockResolvedValue('<html><h1>Old</h1></html>');
      // Mock performDirectReplacement
      jest.spyOn(agentModeService as any, 'performDirectReplacement').mockReturnValue({
        content: '<html><h1>New</h1></html>',
        changeCount: 1
      });

      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ old_content: '<h1>Old</h1>', new_content: '<h1>New</h1>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
    });

    it('should accept valid update_type "full"', async () => {
      // Mock fetchFileContent
      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockResolvedValue('<html>Old</html>');

      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'full',
        [{ old_content_hash: 'mock-hash-123', new_content: '<html>New</html>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
    });
  });

  describe('full replacement (update_type="full")', () => {
    beforeEach(() => {
      // Mock fetchFileContent to return test content
      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockResolvedValue('<html>Test content</html>');
      
      // Mock createHash to return consistent hash
      const mockHash = jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        digest: jest.fn().mockReturnValue('test-hash-123')
      }));
      require('crypto').createHash = mockHash;
    });

    it('should require old_content_hash for full replacement', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'full',
        [{ new_content: '<html>New</html>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('old_content_hash is required');
    });

    it('should reject old_content when update_type is full', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'full',
        [{ old_content_hash: 'hash123', old_content: '<h1>Old</h1>', new_content: '<html>New</html>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('should not have old_content when update_type="full"');
    });

    it('should verify file hash matches for full replacement', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'full',
        [{ old_content_hash: 'wrong-hash', new_content: '<html>New</html>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('File hash mismatch');
    });

    it('should succeed when hash matches for full replacement', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'full',
        [{ old_content_hash: 'test-hash-123', new_content: '<html>New</html>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.method).toBe('mixed_replacement');
      expect(result.replacements[0].old_content_hash).toBe('test-hash-123');
    });

    it('should reject expected_count other than 1 for full replacement', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'full',
        [{ old_content_hash: 'test-hash-123', new_content: '<html>New</html>', expected_count: 2 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Full replacement only supports expected_count of 1');
    });
  });

  describe('part replacement (update_type="part")', () => {
    beforeEach(() => {
      // Mock fetchFileContent to return test content
      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockResolvedValue('<html><h1>Old Title</h1></html>');
      
      // Mock performDirectReplacement
      jest.spyOn(agentModeService as any, 'performDirectReplacement').mockReturnValue({
        content: '<html><h1>New Title</h1></html>',
        changeCount: 1
      });
    });

    it('should require old_content for part replacement', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ new_content: '<h1>New</h1>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('old_content is required');
    });

    it('should reject old_content_hash when update_type is part', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ old_content: '<h1>Old</h1>', old_content_hash: 'hash123', new_content: '<h1>New</h1>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('should not have old_content_hash when update_type="part"');
    });

    it('should succeed when old_content is found for part replacement', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ old_content: '<h1>Old Title</h1>', new_content: '<h1>New Title</h1>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.method).toBe('mixed_replacement');
      expect(result.replacements[0].old_content).toBe('<h1>Old Title</h1>');
    });

    it('should fail when old_content is not found for part replacement', async () => {
      jest.spyOn(agentModeService as any, 'performDirectReplacement').mockReturnValue(null);

      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ old_content: '<h1>Not Found</h1>', new_content: '<h1>New</h1>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('old_content was not found');
    });

    it('should fail when expected_count does not match actual count for part replacement', async () => {
      // ENG-2103 F2: performContentReplacements/performDirectReplacement now live in
      // emma/impl/shared/contentReplacements.ts as plain functions calling each other
      // directly (not via `this`), so jest.spyOn(agentModeService, 'performDirectReplacement')
      // no longer intercepts this internal call. Exercise the real mismatch instead of
      // mocking the collaborator: content with two real occurrences of old_content
      // against expected_count: 1 hits the exact same "changeCount !== expected_count"
      // branch performDirectReplacement's own regex-count logic produces.
      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockResolvedValue(
        '<html><h1>Old Title</h1><h1>Old Title</h1></html>'
      );

      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ old_content: '<h1>Old Title</h1>', new_content: '<h1>New Title</h1>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toContain('Expected 1 occurrences of old_content, but found 2');
    });
  });

  describe('createVersionedFilename', () => {
    it('should add _v2 to filename without existing version', () => {
      const result = (agentModeService as any).createVersionedFilename('https://s3.amazonaws.com/bucket/file.html');
      expect(result).toBe('file_v2.html');
    });

    it('should increment existing version number', () => {
      const result = (agentModeService as any).createVersionedFilename('https://s3.amazonaws.com/bucket/file_v2.html');
      expect(result).toBe('file_v3.html');
    });

    it('should handle filename without extension', () => {
      const result = (agentModeService as any).createVersionedFilename('https://s3.amazonaws.com/bucket/file');
      expect(result).toBe('file_v2');
    });

    it('should handle complex filename with existing version', () => {
      const result = (agentModeService as any).createVersionedFilename('https://s3.amazonaws.com/bucket/newsletter_2024_v3.html');
      expect(result).toBe('newsletter_2024_v4.html');
    });

    it('should handle multiple version patterns correctly', () => {
      const result = (agentModeService as any).createVersionedFilename('https://s3.amazonaws.com/bucket/html_digital_marketing_newsletter2_1761399141269_v3.html');
      expect(result).toBe('html_digital_marketing_newsletter2_1761399141269_v4.html');
    });
  });

  describe('performDirectReplacement', () => {
    it('should perform exact string replacement for small content', () => {
      const result = (agentModeService as any).performDirectReplacement(
        'Hello World',
        'World',
        'Universe'
      );

      expect(result).toEqual({
        content: 'Hello Universe',
        changeCount: 1
      });
    });

    it('should handle multiple occurrences', () => {
      const result = (agentModeService as any).performDirectReplacement(
        'Hello World, Hello World',
        'World',
        'Universe'
      );

      expect(result).toEqual({
        content: 'Hello Universe, Hello Universe',
        changeCount: 2
      });
    });

    it('should return null when old content not found', () => {
      const result = (agentModeService as any).performDirectReplacement(
        'Hello World',
        'NotFound',
        'Universe'
      );

      expect(result).toBeNull();
    });

    it('should handle large content with exact match', () => {
      const largeContent = '<html>' + 'x'.repeat(2000) + '</html>';
      const newContent = '<html>' + 'y'.repeat(2000) + '</html>';
      
      const result = (agentModeService as any).performDirectReplacement(
        largeContent,
        largeContent,
        newContent,
        true
      );

      expect(result).toEqual({
        content: newContent,
        changeCount: 1
      });
    });

    it('should handle large content with exact match', () => {
      const largeContent = '<html>' + 'x'.repeat(2000) + '</html>';
      const newContent = '<html>' + 'y'.repeat(2000) + '</html>';
      
      const result = (agentModeService as any).performDirectReplacement(
        largeContent,
        largeContent,
        newContent
      );

      expect(result).toEqual({
        content: newContent,
        changeCount: 1
      });
    });
  });

  describe('extractPathFromS3Url', () => {
    it('should extract path from S3 URL', () => {
      const result = (agentModeService as any).extractPathFromS3Url('https://s3.amazonaws.com/bucket/path/to/file.html');
      expect(result).toBe('bucket/path/to');
    });

    it('should return empty string for URL without path', () => {
      const result = (agentModeService as any).extractPathFromS3Url('https://s3.amazonaws.com/bucket/file.html');
      expect(result).toBe('bucket');
    });

    it('should handle complex S3 URLs', () => {
      const result = (agentModeService as any).extractPathFromS3Url('https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/123/files/456/789/file.html');
      expect(result).toBe('users/123/files/456/789');
    });
  });

  describe('error handling', () => {
    it('should handle fetchFileContent errors', async () => {
      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockRejectedValue(new Error('Network error'));

      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ old_content: '<h1>Old</h1>', new_content: '<h1>New</h1>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to update HTML file');
    });

    it('should handle uploadFileToS3WithPath errors', async () => {
      const { uploadFileToS3WithPath } = require('../utils/s3Utils');
      uploadFileToS3WithPath.mockResolvedValue({
        success: false,
        error: 'Upload failed'
      });

      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockResolvedValue('<html>Test</html>');
      jest.spyOn(agentModeService as any, 'performDirectReplacement').mockReturnValue({
        content: '<html>Updated</html>',
        changeCount: 1
      });

      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [{ old_content: '<html>Test</html>', new_content: '<html>Updated</html>', expected_count: 1 }],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Failed to update HTML file');
    });
  });

  describe('integration scenarios', () => {
    it('should handle mixed replacement types in single call', async () => {
      jest.spyOn(htmlUpdateImpl, 'fetchFileContent').mockResolvedValue('<html>Test content</html>');
      jest.spyOn(agentModeService as any, 'performDirectReplacement').mockReturnValue({
        content: '<html>Updated content</html>',
        changeCount: 1
      });
      jest.spyOn(htmlUpdateImpl, 'uploadUpdatedFile').mockResolvedValue({
        url: 'https://s3.amazonaws.com/bucket/new-file.html'
      });

      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [
          { old_content: 'Test', new_content: 'Updated', expected_count: 1 },
          { old_content: 'content', new_content: 'data', expected_count: 1 }
        ],
        'user123',
        'session123'
      );

      expect(result.success).toBe(true);
      expect(result.replacements).toHaveLength(2);
    });

    it('should handle empty replacement instructions', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        [],
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('At least one replacement instruction is required');
    });

    it('should handle non-array replacement instructions', async () => {
      const result = await (agentModeService as any).updateHtmlFile(
        'https://s3.amazonaws.com/bucket/file.html',
        'part',
        'not an array',
        'user123',
        'session123'
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('replacement_json must be an array of replacement instructions');
    });
  });
});
