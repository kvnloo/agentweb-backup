// Tests for searchableText persistence to DynamoDB after enrichment.
// Root cause: enrichHtmlReportsWithSearchableText fetches searchableText from S3
// on every page load but never persists it, causing O(n) S3 fetches per render.
// For accounts with 3000+ reports this consistently exceeds the 20s timeout.
//
// Fix: after enrichment, persist searchableText back to:
//   - assetCache.htmlReports entries in DynamoDB (agent-mode reports)
//   - result_files entries on AW-TaskExecutions (task reports)

import axios from 'axios';
import express from 'express';
import request from 'supertest';
import { ChatbotDB } from '../services/chatbotService';
import { taskDb } from '../services/db';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('aws-sdk', () => ({
  config: { update: jest.fn() },
  DynamoDB: {
    DocumentClient: jest.fn(() => ({
      get: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      put: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      query: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
      update: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      delete: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
      scan: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Items: [] }) }),
    })),
  },
  S3: jest.fn(() => ({
    upload: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ Location: '', Key: '' }) }),
    getObject: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({}) }),
    getSignedUrl: jest.fn(),
  })),
  SecretsManager: jest.fn(() => ({
    getSecretValue: jest.fn().mockReturnValue({ promise: jest.fn().mockResolvedValue({ SecretString: '{}' }) }),
  })),
}));

jest.mock('../services/chatbotService');
jest.mock('../services/db', () => ({
  taskDb: {
    getAllTaskExecutionsByUserId: jest.fn(),
    getTasksByUserId: jest.fn(),
    updateTaskExecutionResultFiles: jest.fn(),
  },
}));
jest.mock('../middleware/auth', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    req.user = { userId: 'user123', isAdmin: false };
    next();
  },
}));

// Prevent classification LLM calls from interfering with searchableText persistence tests
jest.mock('../services/reportClassificationService', () => ({
  classifyReport: jest.fn().mockRejectedValue(new Error('mocked')),
}));

const router = require('../routes/tasks').default;

const HTML_CONTENT = '<html><body><h1>Sales Report Q1</h1><p>Revenue increased by 20%.</p></body></html>';
const EXPECTED_TEXT = 'Sales Report Q1 Revenue increased by 20%.';

describe('Tasks Routes - searchableText persistence', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use('/api/tasks', router);

    mockedAxios.get.mockResolvedValue({ data: HTML_CONTENT, status: 200, statusText: 'OK', headers: {}, config: {} as any });
    (ChatbotDB.prototype.getMessagesFromIndex as jest.Mock).mockResolvedValue([]);
    (ChatbotDB.prototype.getMessagesFromMessagesTable as jest.Mock).mockResolvedValue([]);
    (ChatbotDB.prototype.updateAssetCache as jest.Mock).mockResolvedValue(undefined);
    (ChatbotDB.prototype.persistSearchableTexts as jest.Mock).mockResolvedValue(undefined);
    (taskDb.updateTaskExecutionResultFiles as jest.Mock).mockResolvedValue(undefined);
  });

  describe('agent-mode HTML reports', () => {
    it('should NOT fetch from S3 when searchableText is already cached in assetCache', async () => {
      const sessionId = 'session-with-cache';
      const reportUrl = 'https://s3.example.com/reports/report.html';

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId,
        userId: 'user123',
        title: 'Report Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        messageCount: 5,
        assetScanIndex: 5,
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [{
            url: reportUrl,
            filename: 'report.html',
            generatedAt: '2024-01-01T12:00:00Z',
            searchableText: 'already cached text',
          }],
        },
        messages: [],
      }]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-html-reports')
        .expect(200);

      // S3 fetch should be skipped when searchableText is already cached
      expect(mockedAxios.get).not.toHaveBeenCalledWith(reportUrl, expect.anything());

      // searchableText is stripped from the response to keep payload small
      const taskKey = `agent-mode-${sessionId}`;
      const files = response.body[taskKey]?.executions?.[0]?.result_files || [];
      const file = files.find((f: any) => f.url === reportUrl);
      expect(file).toBeDefined();
      expect(file.searchableText).toBeUndefined();
    });

    it('should background-fetch from S3 and persist searchableText for agent-mode report without cached text', async () => {
      const sessionId = 'session-no-text';
      const reportUrl = 'https://s3.example.com/reports/new-report.html';

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId,
        userId: 'user123',
        title: 'Report Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        messageCount: 3,
        assetScanIndex: 3,
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [{
            url: reportUrl,
            filename: 'new-report.html',
            generatedAt: '2024-01-01T12:00:00Z',
          }],
        },
        messages: [],
      }]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-html-reports')
        .expect(200);

      // Flush fire-and-forget microtasks
      await new Promise(resolve => setImmediate(resolve));

      // Should have fetched the HTML in the background
      expect(mockedAxios.get).toHaveBeenCalledWith(reportUrl, expect.objectContaining({ timeout: 5000 }));

      // Should have persisted the searchableText back to the assetCache
      expect(ChatbotDB.prototype.persistSearchableTexts).toHaveBeenCalledWith(
        sessionId,
        expect.arrayContaining([expect.objectContaining({ url: reportUrl, searchableText: expect.any(String) })])
      );

      // The immediate response does NOT include searchableText (enrichment is async)
      const taskKey = `agent-mode-${sessionId}`;
      const files = response.body[taskKey]?.executions?.[0]?.result_files || [];
      const file = files.find((f: any) => f.url === reportUrl);
      expect(file).toBeDefined();
    });

    it('should persist searchableTexts for multiple agent-mode sessions in one call per session', async () => {
      const sessions = ['session-a', 'session-b'].map(sessionId => ({
        sessionId,
        userId: 'user123',
        title: `Session ${sessionId}`,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        messageCount: 2,
        assetScanIndex: 2,
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [
            { url: `https://s3.example.com/${sessionId}/r1.html`, filename: 'r1.html', generatedAt: '2024-01-01T12:00:00Z' },
            { url: `https://s3.example.com/${sessionId}/r2.html`, filename: 'r2.html', generatedAt: '2024-01-01T12:00:00Z' },
          ],
        },
        messages: [],
      }));

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue(sessions);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      await request(app).get('/api/tasks/executions/with-html-reports').expect(200);
      await new Promise(resolve => setImmediate(resolve));

      // Called once per session that has new searchableTexts
      expect(ChatbotDB.prototype.persistSearchableTexts).toHaveBeenCalledTimes(2);
      expect(ChatbotDB.prototype.persistSearchableTexts).toHaveBeenCalledWith(
        'session-a',
        expect.arrayContaining([
          expect.objectContaining({ url: 'https://s3.example.com/session-a/r1.html' }),
          expect.objectContaining({ url: 'https://s3.example.com/session-a/r2.html' }),
        ])
      );
      expect(ChatbotDB.prototype.persistSearchableTexts).toHaveBeenCalledWith(
        'session-b',
        expect.arrayContaining([
          expect.objectContaining({ url: 'https://s3.example.com/session-b/r1.html' }),
          expect.objectContaining({ url: 'https://s3.example.com/session-b/r2.html' }),
        ])
      );
    });

    it('should skip uncached sessions in main path and not block the response', async () => {
      // Uncached session (no assetCache/assetScanIndex) — should NOT be fetched synchronously
      const uncachedSessionId = 'session-no-cache';
      const cachedSessionId = 'session-with-cache';
      const cachedReportUrl = 'https://s3.example.com/cached/report.html';

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([
        {
          sessionId: uncachedSessionId,
          userId: 'user123',
          title: 'Uncached Session',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T12:00:00Z',
          archived: false,
          messageCount: 50,
          // No assetCache / assetScanIndex
          messages: [],
        },
        {
          sessionId: cachedSessionId,
          userId: 'user123',
          title: 'Cached Session',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T12:00:00Z',
          archived: false,
          messageCount: 2,
          assetScanIndex: 2,
          assetCache: {
            images: [],
            videos: [],
            htmlReports: [{ url: cachedReportUrl, filename: 'report.html', generatedAt: '2024-01-01T12:00:00Z', searchableText: 'cached text' }],
          },
          messages: [],
        },
      ]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-html-reports')
        .expect(200);

      // The uncached session should NOT appear in the response (no assets known yet)
      expect(response.body[`agent-mode-${uncachedSessionId}`]).toBeUndefined();

      // The cached session should appear with its known assets
      const taskKey = `agent-mode-${cachedSessionId}`;
      const files = response.body[taskKey]?.executions?.[0]?.result_files || [];
      expect(files.find((f: any) => f.url === cachedReportUrl)).toBeDefined();

      // Background warm should have been triggered for the uncached session
      // (getMessagesFromMessagesTable called in fire-and-forget)
      await new Promise(resolve => setImmediate(resolve));
      expect(ChatbotDB.prototype.getMessagesFromMessagesTable).toHaveBeenCalledWith(uncachedSessionId);
    });

    it('should cap persisted entries at 10 most-recent per session when session has >10 reports', async () => {
      const sessionId = 'session-many';
      // 15 reports with distinct timestamps so sort order is deterministic
      const htmlReports = Array.from({ length: 15 }, (_, i) => ({
        url: `https://s3.example.com/many/r${String(i).padStart(2, '0')}.html`,
        filename: `r${i}.html`,
        generatedAt: `2024-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`,
      }));

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId,
        userId: 'user123',
        title: 'Many Reports',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-15T12:00:00Z',
        archived: false,
        messageCount: 15,
        assetScanIndex: 15,
        assetCache: { images: [], videos: [], htmlReports },
        messages: [],
      }]);

      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      await request(app).get('/api/tasks/executions/with-html-reports').expect(200);
      await new Promise(resolve => setImmediate(resolve));

      expect(ChatbotDB.prototype.persistSearchableTexts).toHaveBeenCalledTimes(1);
      const [, persistedUpdates] = (ChatbotDB.prototype.persistSearchableTexts as jest.Mock).mock.calls[0];
      // Only 10 entries persisted
      expect(persistedUpdates).toHaveLength(10);
      // They should be the 10 most recent (r05..r14 by generatedAt desc)
      const persistedUrls: string[] = persistedUpdates.map((u: any) => u.url);
      expect(persistedUrls).toContain('https://s3.example.com/many/r14.html');
      expect(persistedUrls).toContain('https://s3.example.com/many/r05.html');
      expect(persistedUrls).not.toContain('https://s3.example.com/many/r04.html');
    });
  });

  describe('task-execution HTML reports', () => {
    it('should NOT fetch from S3 when searchableText already present on result_file', async () => {
      const reportUrl = 'https://s3.example.com/task-reports/exec.html';

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([]);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([{
        executionId: 'exec-1',
        taskId: 'task-1',
        userId: 'user123',
        startTime: '2024-01-01T12:00:00Z',
        archived: false,
        result_files: [{
          url: reportUrl,
          filename: 'exec.html',
          token: 'tok',
          is_html: true,
          searchableText: 'already cached task text',
        }],
      }]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{
        taskId: 'task-1',
        name: 'My Task',
        createdAt: '2024-01-01T00:00:00Z',
        status: 'active',
      }]);

      const response = await request(app)
        .get('/api/tasks/executions/with-html-reports')
        .expect(200);

      expect(mockedAxios.get).not.toHaveBeenCalledWith(reportUrl, expect.anything());

      const files = response.body['task-1']?.executions?.[0]?.result_files || [];
      const file = files.find((f: any) => f.url === reportUrl);
      // searchableText is stripped from the response to keep payload small
      expect(file?.searchableText).toBeUndefined();
    });

    it('should background-fetch from S3 and persist searchableText for task execution report without cached text', async () => {
      const reportUrl = 'https://s3.example.com/task-reports/new-exec.html';

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([]);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([{
        executionId: 'exec-2',
        taskId: 'task-2',
        userId: 'user123',
        startTime: '2024-01-01T12:00:00Z',
        archived: false,
        result_files: [{
          url: reportUrl,
          filename: 'new-exec.html',
          token: 'tok',
          is_html: true,
        }],
      }]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{
        taskId: 'task-2',
        name: 'My Task 2',
        createdAt: '2024-01-01T00:00:00Z',
        status: 'active',
      }]);

      const response = await request(app)
        .get('/api/tasks/executions/with-html-reports')
        .expect(200);

      // Flush fire-and-forget microtasks
      await new Promise(resolve => setImmediate(resolve));

      expect(mockedAxios.get).toHaveBeenCalledWith(reportUrl, expect.objectContaining({ timeout: 5000 }));

      // Should persist back to the execution
      expect(taskDb.updateTaskExecutionResultFiles).toHaveBeenCalledWith(
        'exec-2',
        expect.arrayContaining([expect.objectContaining({ url: reportUrl, searchableText: expect.any(String) })])
      );

      // Immediate response has the file but without searchableText (enrichment is async)
      const files = response.body['task-2']?.executions?.[0]?.result_files || [];
      const file = files.find((f: any) => f.url === reportUrl);
      expect(file).toBeDefined();
    });

    it('should persist searchableTexts grouped by executionId', async () => {
      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([]);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([
        {
          executionId: 'exec-a',
          taskId: 'task-3',
          userId: 'user123',
          startTime: '2024-01-01T12:00:00Z',
          archived: false,
          result_files: [
            { url: 'https://s3.example.com/a/r1.html', filename: 'r1.html', token: '', is_html: true },
            { url: 'https://s3.example.com/a/r2.html', filename: 'r2.html', token: '', is_html: true },
          ],
        },
        {
          executionId: 'exec-b',
          taskId: 'task-3',
          userId: 'user123',
          startTime: '2024-01-01T13:00:00Z',
          archived: false,
          result_files: [
            { url: 'https://s3.example.com/b/r1.html', filename: 'r1.html', token: '', is_html: true },
          ],
        },
      ]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{
        taskId: 'task-3',
        name: 'Task 3',
        createdAt: '2024-01-01T00:00:00Z',
        status: 'active',
      }]);

      await request(app).get('/api/tasks/executions/with-html-reports').expect(200);
      await new Promise(resolve => setImmediate(resolve));

      expect(taskDb.updateTaskExecutionResultFiles).toHaveBeenCalledTimes(2);
      expect(taskDb.updateTaskExecutionResultFiles).toHaveBeenCalledWith(
        'exec-a',
        expect.arrayContaining([
          expect.objectContaining({ url: 'https://s3.example.com/a/r1.html', searchableText: expect.any(String) }),
          expect.objectContaining({ url: 'https://s3.example.com/a/r2.html', searchableText: expect.any(String) }),
        ])
      );
      expect(taskDb.updateTaskExecutionResultFiles).toHaveBeenCalledWith(
        'exec-b',
        expect.arrayContaining([
          expect.objectContaining({ url: 'https://s3.example.com/b/r1.html', searchableText: expect.any(String) }),
        ])
      );
    });
  });

  describe('error handling', () => {
    it('should not call persistSearchableTexts when S3 fetch fails for all reports', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Network error'));

      const sessionId = 'session-fail';
      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId,
        userId: 'user123',
        title: 'Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        messageCount: 1,
        assetScanIndex: 1,
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [{ url: 'https://s3.example.com/fail.html', filename: 'fail.html', generatedAt: '2024-01-01T12:00:00Z' }],
        },
        messages: [],
      }]);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      // Should not throw
      await request(app).get('/api/tasks/executions/with-html-reports').expect(200);

      // No successful enrichments — nothing to persist
      expect(ChatbotDB.prototype.persistSearchableTexts).not.toHaveBeenCalled();
    });

    it('should not call updateTaskExecutionResultFiles when S3 fetch fails for task report', async () => {
      mockedAxios.get.mockRejectedValue(new Error('Timeout'));

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([]);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([{
        executionId: 'exec-fail',
        taskId: 'task-fail',
        userId: 'user123',
        startTime: '2024-01-01T12:00:00Z',
        archived: false,
        result_files: [{ url: 'https://s3.example.com/fail.html', filename: 'fail.html', token: '', is_html: true }],
      }]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([{
        taskId: 'task-fail',
        name: 'Fail Task',
        createdAt: '2024-01-01T00:00:00Z',
        status: 'active',
      }]);

      await request(app).get('/api/tasks/executions/with-html-reports').expect(200);

      expect(taskDb.updateTaskExecutionResultFiles).not.toHaveBeenCalled();
    });
  });

  describe('response payload size', () => {
    it('strips searchableText entirely from the response to keep payload small (long text)', async () => {
      const reportUrl = 'https://s3.example.com/reports/large-report.html';
      const longSearchableText = 'A'.repeat(3000);

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId: 'session-large',
        userId: 'user123',
        title: 'Large Report',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        messageCount: 1,
        assetScanIndex: 1,
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [{
            url: reportUrl,
            filename: 'large-report.html',
            generatedAt: '2024-01-01T12:00:00Z',
            searchableText: longSearchableText,
          }],
        },
      }]);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-html-reports')
        .expect(200);

      const taskKey = 'agent-mode-session-large';
      const files = response.body[taskKey]?.executions?.[0]?.result_files || [];
      const file = files.find((f: any) => f.url === reportUrl);
      expect(file).toBeDefined();
      expect(file.searchableText).toBeUndefined();
    });

    it('strips searchableText entirely from the response even for short text', async () => {
      const reportUrl = 'https://s3.example.com/reports/small-report.html';
      const shortSearchableText = 'Short content';

      (ChatbotDB.prototype.getSessionsWithoutMessages as jest.Mock).mockResolvedValue([{
        sessionId: 'session-small',
        userId: 'user123',
        title: 'Small Report',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T12:00:00Z',
        archived: false,
        messageCount: 1,
        assetScanIndex: 1,
        assetCache: {
          images: [],
          videos: [],
          htmlReports: [{
            url: reportUrl,
            filename: 'small-report.html',
            generatedAt: '2024-01-01T12:00:00Z',
            searchableText: shortSearchableText,
          }],
        },
      }]);
      (taskDb.getAllTaskExecutionsByUserId as jest.Mock).mockResolvedValue([]);
      (taskDb.getTasksByUserId as jest.Mock).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/tasks/executions/with-html-reports')
        .expect(200);

      const taskKey = 'agent-mode-session-small';
      const files = response.body[taskKey]?.executions?.[0]?.result_files || [];
      const file = files.find((f: any) => f.url === reportUrl);
      expect(file).toBeDefined();
      expect(file.searchableText).toBeUndefined();
    });
  });
});
