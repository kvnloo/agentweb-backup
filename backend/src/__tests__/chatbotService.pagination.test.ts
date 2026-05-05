import { chatbotDb } from '../services/chatbotService';

// Track query calls to simulate pagination
const queryPromiseMock = jest.fn();

jest.mock('aws-sdk', () => {
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => ({
        query: jest.fn(() => ({ promise: queryPromiseMock })),
        get: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({ Item: null }) })),
        put: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        update: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
        batchWrite: jest.fn(() => ({ promise: jest.fn().mockResolvedValue({}) })),
      })),
    },
    S3: jest.fn(() => ({
      upload: jest.fn().mockReturnThis(),
      promise: jest.fn(),
    })),
    config: { update: jest.fn() },
  };
});

jest.mock('openai', () => jest.fn(() => ({})));
jest.mock('@google-cloud/discoveryengine', () => ({
  EngineServiceClient: jest.fn(),
  SearchServiceClient: jest.fn(),
}));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn(),
}));
jest.mock('../controllers/guide', () => ({ getGuide: jest.fn() }));
jest.mock('../controllers/release', () => ({ getReleases: jest.fn() }));
jest.mock('../controllers/api', () => ({ getApiDocs: jest.fn() }));
jest.mock('../controllers/user-guide', () => ({ getUserGuide: jest.fn() }));
jest.mock('../controllers/docsController', () => ({ getUserReleaseNotes: jest.fn() }));
jest.mock('../services/db', () => ({ taskDb: {} }));
jest.mock('../utils/secretsManager', () => ({ getGCSPPrivateKey: jest.fn() }));

describe('DynamoDB pagination in chatbotService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getMessagesFromMessagesTable', () => {
    it('should paginate through multiple DynamoDB pages', async () => {
      // Page 1: 2 messages, has more
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { messageIndex: 0, message: { role: 'user', content: 'Hello' } },
          { messageIndex: 1, message: { role: 'assistant', content: 'Hi there' } },
        ],
        LastEvaluatedKey: { sessionId: 'sess-1', messageIndex: 1 },
      });
      // Page 2: 2 more messages, has more
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { messageIndex: 2, message: { role: 'user', content: 'How are you?' } },
          { messageIndex: 3, message: { role: 'assistant', content: 'Good!' } },
        ],
        LastEvaluatedKey: { sessionId: 'sess-1', messageIndex: 3 },
      });
      // Page 3: last message, no more pages
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { messageIndex: 4, message: { role: 'user', content: 'Bye' } },
        ],
      });

      const messages = await chatbotDb.getMessagesFromMessagesTable('sess-1');

      expect(messages).toHaveLength(5);
      expect(messages[0].content).toBe('Hello');
      expect(messages[4].content).toBe('Bye');
      expect(queryPromiseMock).toHaveBeenCalledTimes(3);
    });

    it('should return all messages when result fits in single page', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { messageIndex: 0, message: { role: 'user', content: 'Hello' } },
        ],
      });

      const messages = await chatbotDb.getMessagesFromMessagesTable('sess-1');

      expect(messages).toHaveLength(1);
      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no messages exist', async () => {
      queryPromiseMock.mockResolvedValueOnce({ Items: [] });

      const messages = await chatbotDb.getMessagesFromMessagesTable('sess-1');

      expect(messages).toHaveLength(0);
      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getMessageStats', () => {
    it('should aggregate stats across multiple DynamoDB pages', async () => {
      // Page 1
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { message: { role: 'user', content: 'msg1' } },
          { message: { role: 'assistant', content: 'reply1', usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } } },
        ],
        LastEvaluatedKey: { sessionId: 'sess-1', messageIndex: 1 },
      });
      // Page 2
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { message: { role: 'user', content: 'msg2' } },
          { message: { role: 'tool', content: '{"success":true}' } },
          { message: { role: 'assistant', content: 'reply2', usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 } } },
        ],
      });

      const stats = await chatbotDb.getMessageStats('sess-1');

      expect(stats.totalMessages).toBe(5);
      expect(stats.messagesByRole.user).toBe(2);
      expect(stats.messagesByRole.assistant).toBe(2);
      expect(stats.messagesByRole.tool).toBe(1);
      expect(stats.totalTokens).toBe(430);
      expect(stats.successfulToolCalls).toBe(1);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });

    it('should return correct stats for single page', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Items: [
          { message: { role: 'user', content: 'Hello' } },
        ],
      });

      const stats = await chatbotDb.getMessageStats('sess-1');

      expect(stats.totalMessages).toBe(1);
      expect(stats.messagesByRole.user).toBe(1);
      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getRecentSessionsPage with time range', () => {
    it('should include sessions created before the window if they had messages within it', async () => {
      // updatedAt only changes when real messages are written, so any session returned by
      // the DynamoDB BETWEEN query was genuinely active during the window — include it.
      const oldSession = {
        sessionId: 'old-session',
        adminListPartition: 'all',
        createdAt: '2026-03-29T03:00:00.000Z',
        updatedAt: '2026-04-05T03:34:58.926Z',
        title: 'Multi-day Task',
      };
      const newSession = {
        sessionId: 'new-session',
        adminListPartition: 'all',
        createdAt: '2026-04-05T10:00:00.000Z',
        updatedAt: '2026-04-05T10:01:00.000Z',
        title: 'Daily Task',
      };

      queryPromiseMock.mockResolvedValueOnce({
        Items: [newSession, oldSession],
      });

      const timeRange = { startTime: '2026-04-04T00:00:00Z', endTime: '2026-04-05T23:59:59Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions).toHaveLength(2);
    });

    it('should include sessions whose createdAt is within the time range', async () => {
      const session1 = {
        sessionId: 'sess-1',
        adminListPartition: 'all',
        createdAt: '2026-04-04T10:00:00.000Z',
        updatedAt: '2026-04-04T10:01:00.000Z',
        title: 'Session 1',
      };
      const session2 = {
        sessionId: 'sess-2',
        adminListPartition: 'all',
        createdAt: '2026-04-05T09:00:00.000Z',
        updatedAt: '2026-04-05T09:01:00.000Z',
        title: 'Session 2',
      };

      queryPromiseMock.mockResolvedValueOnce({
        Items: [session2, session1],
      });

      const timeRange = { startTime: '2026-04-04T00:00:00Z', endTime: '2026-04-05T23:59:59Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions).toHaveLength(2);
    });

    it('should handle sessions without createdAt by including them', async () => {
      const sessionNoDate = {
        sessionId: 'legacy-session',
        adminListPartition: 'all',
        updatedAt: '2026-04-05T10:00:00.000Z',
        title: 'Legacy Session',
      };

      queryPromiseMock.mockResolvedValueOnce({
        Items: [sessionNoDate],
      });

      const timeRange = { startTime: '2026-04-05T00:00:00Z', endTime: '2026-04-05T23:59:59Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions).toHaveLength(1);
    });

    it('should include sessions created just before startTime if they had messages within the window', async () => {
      // A session started 1 second before midnight but with a message sent during the window.
      // Since updatedAt only changes on real messages, this session was active in the window.
      const spanningSession = {
        sessionId: 'spanning-midnight',
        adminListPartition: 'all',
        createdAt: '2026-04-03T23:59:59.000Z',
        updatedAt: '2026-04-05T10:00:00.000Z',
        title: 'Late Night Start',
      };

      queryPromiseMock.mockResolvedValueOnce({
        Items: [spanningSession],
      });

      const timeRange = { startTime: '2026-04-04T00:00:00Z', endTime: '2026-04-05T23:59:59Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].sessionId).toBe('spanning-midnight');
    });

  });

  describe('getMessageCountFromMessagesTable', () => {
    it('should sum counts across multiple DynamoDB pages', async () => {
      // Page 1: count of 50, has more
      queryPromiseMock.mockResolvedValueOnce({
        Count: 50,
        LastEvaluatedKey: { sessionId: 'sess-1', messageIndex: 49 },
      });
      // Page 2: count of 50, has more
      queryPromiseMock.mockResolvedValueOnce({
        Count: 50,
        LastEvaluatedKey: { sessionId: 'sess-1', messageIndex: 99 },
      });
      // Page 3: count of 23, done
      queryPromiseMock.mockResolvedValueOnce({
        Count: 23,
      });

      const count = await (chatbotDb as any).getMessageCountFromMessagesTable('sess-1');

      expect(count).toBe(123);
      expect(queryPromiseMock).toHaveBeenCalledTimes(3);
    });

    it('should return count for single page', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Count: 10,
      });

      const count = await (chatbotDb as any).getMessageCountFromMessagesTable('sess-1');

      expect(count).toBe(10);
      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
    });

    it('should return 0 when no messages exist', async () => {
      queryPromiseMock.mockResolvedValueOnce({
        Count: 0,
      });

      const count = await (chatbotDb as any).getMessageCountFromMessagesTable('sess-1');

      expect(count).toBe(0);
    });
  });
});
