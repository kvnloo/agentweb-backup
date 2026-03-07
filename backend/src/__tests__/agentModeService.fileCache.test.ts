import { AgentModeService } from '../services/agentModeService';

// Mock dependencies
jest.mock('../services/db', () => ({
  chatbotDb: {},
  taskDb: {},
  taskTemplateDb: {},
  userDb: {}
}));

jest.mock('../services/chatbotService', () => ({
  chatbotDb: {},
  searchPlatformKnowledgeBase: jest.fn()
}));

jest.mock('../services/settingsService', () => ({
  settingsService: {
    getSetting: jest.fn()
  }
}));

jest.mock('../utils/secretsManager', () => ({
  getSecret: jest.fn(),
  getGCSPPrivateKey: jest.fn()
}));

jest.mock('../services/metaService', () => ({
  metaService: {},
  MetaService: jest.fn()
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {}
}));

jest.mock('../services/skillService', () => ({
  skillService: {
    getPublishedSkills: jest.fn().mockResolvedValue([])
  }
}));

jest.mock('../services/subscriptionService', () => ({
  getAllowedSkills: jest.fn(),
  resolveSkillsToToolNames: jest.fn(),
  filterFunctionCalls: jest.fn()
}));

jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({
    success: true,
    url: 'https://s3.amazonaws.com/test-file.txt'
  })
}));

describe('AgentModeService - File Cache', () => {
  let service: AgentModeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    service = new AgentModeService();

    // Don't call initialize() to avoid MCP setup
    // Instead, manually start cache cleanup
    (service as any).startFileCacheCleanup();
  });

  afterEach(async () => {
    await service.shutdown();
    jest.useRealTimers();
  });

  describe('Cache Size Limit', () => {
    it('should enforce max cache size by directly testing cleanup method', () => {
      const cache = (service as any).fileContentCache as Map<string, any>;
      const now = Date.now();

      // Add 1050 entries directly to the cache
      for (let i = 0; i < 1050; i++) {
        cache.set(`hash-${i}`, {
          file_url: `https://s3.amazonaws.com/file-${i}.txt`,
          file_name: `file-${i}.txt`,
          file_size: 100,
          timestamp: now
        });
      }

      expect(cache.size).toBe(1050);

      // Trigger cleanup
      (service as any).cleanupFileCache();

      // Cache should be limited to 1000 entries
      expect(cache.size).toBe(1000);
    });

    it('should remove oldest entries when exceeding size limit', () => {
      const cache = (service as any).fileContentCache as Map<string, any>;
      const now = Date.now();

      // Add entries with different timestamps
      cache.set('old-hash', {
        file_url: 'https://s3.amazonaws.com/old.txt',
        file_name: 'old.txt',
        file_size: 100,
        timestamp: now - 1000 // 1 second ago
      });

      // Add 1000 newer entries
      for (let i = 0; i < 1000; i++) {
        cache.set(`hash-${i}`, {
          file_url: `https://s3.amazonaws.com/file-${i}.txt`,
          file_name: `file-${i}.txt`,
          file_size: 100,
          timestamp: now
        });
      }

      expect(cache.size).toBe(1001);

      // Trigger cleanup
      (service as any).cleanupFileCache();

      // Oldest entry should be removed
      expect(cache.size).toBe(1000);
      expect(cache.has('old-hash')).toBe(false);
    });
  });

  describe('Cache Age Limit', () => {
    it('should remove entries older than 1 hour during periodic cleanup', async () => {
      const userId = 'test-user';
      const sessionId = 'test-session';

      // Add a file
      await service.saveFile('old.txt', 'old-content', userId, sessionId);

      const cache = (service as any).fileContentCache as Map<string, any>;
      expect(cache.size).toBe(1);

      // Advance time by 61 minutes (1 hour + 1 minute)
      jest.advanceTimersByTime(61 * 60 * 1000);

      // Trigger periodic cleanup (runs every 10 minutes)
      jest.advanceTimersByTime(10 * 60 * 1000);

      // Cache should be empty after cleanup
      expect(cache.size).toBe(0);
    });

    it('should keep entries younger than 1 hour', async () => {
      const userId = 'test-user';
      const sessionId = 'test-session';

      // Add a file
      await service.saveFile('recent.txt', 'recent-content', userId, sessionId);

      const cache = (service as any).fileContentCache as Map<string, any>;
      expect(cache.size).toBe(1);

      // Advance time by 30 minutes (less than 1 hour)
      jest.advanceTimersByTime(30 * 60 * 1000);

      // Trigger periodic cleanup
      jest.advanceTimersByTime(10 * 60 * 1000);

      // Cache should still have the entry
      expect(cache.size).toBe(1);
    });
  });

  describe('Cache Deduplication', () => {
    it('should return cached URL for duplicate content', async () => {
      const userId = 'test-user';
      const sessionId = 'test-session';
      const content = 'same-content';

      // Save first file
      const result1 = await service.saveFile('file1.txt', content, userId, sessionId);
      expect(result1.success).toBe(true);

      // Save second file with same content but different name
      const result2 = await service.saveFile('file2.txt', content, userId, sessionId);
      expect(result2.success).toBe(true);

      // Should return the same S3 URL (cached)
      expect(result2.file_url).toBe(result1.file_url);

      // Cache should only have 1 entry (deduplicated)
      const cache = (service as any).fileContentCache as Map<string, any>;
      expect(cache.size).toBe(1);
    });

    it('should update timestamp when returning cached file', async () => {
      const userId = 'test-user';
      const sessionId = 'test-session';
      const content = 'cached-content';

      // Save first file
      await service.saveFile('file1.txt', content, userId, sessionId);

      const cache = (service as any).fileContentCache as Map<string, any>;
      const entries = Array.from(cache.values());
      const firstTimestamp = entries[0].timestamp;

      // Advance time 5 minutes
      jest.advanceTimersByTime(5 * 60 * 1000);

      // Request same content again
      await service.saveFile('file2.txt', content, userId, sessionId);

      // Timestamp should be updated
      const updatedEntries = Array.from(cache.values());
      const updatedTimestamp = updatedEntries[0].timestamp;
      expect(updatedTimestamp).toBeGreaterThan(firstTimestamp);
    });
  });

  describe('Cleanup Interval', () => {
    it('should run cleanup every 10 minutes', async () => {
      const userId = 'test-user';
      const sessionId = 'test-session';

      // Add a file that will expire
      await service.saveFile('temp.txt', 'temp-content', userId, sessionId);

      // Advance time by 1 hour (file should expire)
      jest.advanceTimersByTime(60 * 60 * 1000);

      const cache = (service as any).fileContentCache as Map<string, any>;
      expect(cache.size).toBe(1); // Not cleaned yet

      // Advance time by 10 minutes (cleanup interval)
      jest.advanceTimersByTime(10 * 60 * 1000);

      // Cache should be cleaned
      expect(cache.size).toBe(0);
    });

    it('should stop cleanup interval on shutdown', async () => {
      await service.shutdown();

      const interval = (service as any).fileCacheCleanupInterval;
      expect(interval).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty cache cleanup gracefully', async () => {
      const cache = (service as any).fileContentCache as Map<string, any>;
      expect(cache.size).toBe(0);

      // Trigger cleanup on empty cache
      (service as any).cleanupFileCache();

      // Should not throw and cache should still be empty
      expect(cache.size).toBe(0);
    });

    it('should handle cleanup when all entries are expired', async () => {
      const userId = 'test-user';
      const sessionId = 'test-session';

      // Add 10 files
      for (let i = 0; i < 10; i++) {
        await service.saveFile(`file-${i}.txt`, `content-${i}`, userId, sessionId);
      }

      const cache = (service as any).fileContentCache as Map<string, any>;
      expect(cache.size).toBe(10);

      // Advance time by 2 hours (all entries expire)
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);

      // Trigger cleanup
      (service as any).cleanupFileCache();

      // All entries should be removed
      expect(cache.size).toBe(0);
    });

    it('should handle mixed expired and valid entries', () => {
      const cache = (service as any).fileContentCache as Map<string, any>;
      const now = Date.now();
      const oneHourAgo = now - (61 * 60 * 1000); // 61 minutes ago (expired)

      // Add old entries directly to cache
      cache.set('old-hash-1', {
        file_url: 'https://s3.amazonaws.com/old1.txt',
        file_name: 'old1.txt',
        file_size: 100,
        timestamp: oneHourAgo
      });

      cache.set('old-hash-2', {
        file_url: 'https://s3.amazonaws.com/old2.txt',
        file_name: 'old2.txt',
        file_size: 100,
        timestamp: oneHourAgo
      });

      // Add new entries
      cache.set('new-hash-1', {
        file_url: 'https://s3.amazonaws.com/new1.txt',
        file_name: 'new1.txt',
        file_size: 100,
        timestamp: now
      });

      cache.set('new-hash-2', {
        file_url: 'https://s3.amazonaws.com/new2.txt',
        file_name: 'new2.txt',
        file_size: 100,
        timestamp: now
      });

      expect(cache.size).toBe(4);

      // Trigger cleanup
      (service as any).cleanupFileCache();

      // Only new files should remain
      expect(cache.size).toBe(2);

      const entries = Array.from(cache.values());
      const fileNames = entries.map(e => e.file_name);
      expect(fileNames).toContain('new1.txt');
      expect(fileNames).toContain('new2.txt');
      expect(fileNames).not.toContain('old1.txt');
      expect(fileNames).not.toContain('old2.txt');
    });
  });
});
