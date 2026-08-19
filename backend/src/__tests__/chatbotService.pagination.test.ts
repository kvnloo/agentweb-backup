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

  describe('getRecentSessionsPage without time range', () => {
    const makeSession = (i: number) => ({
      sessionId: `s-${i}`,
      adminListPartition: 'all',
      updatedAt: `2026-05-15T00:${String(i).padStart(2, '0')}:00.000Z`,
    });

    it('should paginate through multiple DynamoDB pages when limit exceeds first page', async () => {
      // DynamoDB returns 30 items per page (simulates internal page size)
      // With limit=60, the function must issue 2 queries.
      const page1 = Array.from({ length: 30 }, (_, i) => makeSession(i));
      const page2 = Array.from({ length: 30 }, (_, i) => makeSession(30 + i));

      queryPromiseMock
        .mockResolvedValueOnce({
          Items: page1,
          LastEvaluatedKey: { sessionId: 's-29', adminListPartition: 'all', updatedAt: '2026-05-15T00:29:00.000Z' },
        })
        .mockResolvedValueOnce({
          Items: page2,
        });

      const result = await chatbotDb.getRecentSessionsPage(60, undefined, undefined);

      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
      expect(result.sessions).toHaveLength(60);
    });

    it('should return the correct nextCursor when more sessions remain beyond limit', async () => {
      // DynamoDB returns 30 sessions with a cursor indicating there are more.
      // The caller requested limit=30, so we stop here but must return the cursor.
      const page1 = Array.from({ length: 30 }, (_, i) => makeSession(i));
      const nextKey = { sessionId: 's-29', adminListPartition: 'all', updatedAt: '2026-05-15T00:29:00.000Z' };

      queryPromiseMock.mockResolvedValueOnce({
        Items: page1,
        LastEvaluatedKey: nextKey,
      });

      const result = await chatbotDb.getRecentSessionsPage(30, undefined, undefined);

      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
      expect(result.sessions).toHaveLength(30);
      expect(result.lastEvaluatedKey).toEqual(nextKey);
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

      queryPromiseMock
        .mockResolvedValueOnce({ Items: [newSession, oldSession] })
        .mockResolvedValueOnce({ Items: [] }); // (endTime, now] gap query — ENG-1332 follow-up

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

      queryPromiseMock
        .mockResolvedValueOnce({ Items: [session2, session1] })
        .mockResolvedValueOnce({ Items: [] }); // (endTime, now] gap query — ENG-1332 follow-up

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

      queryPromiseMock
        .mockResolvedValueOnce({ Items: [sessionNoDate] })
        .mockResolvedValueOnce({ Items: [] }); // (endTime, now] gap query — ENG-1332 follow-up

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

      queryPromiseMock
        .mockResolvedValueOnce({ Items: [spanningSession] })
        .mockResolvedValueOnce({ Items: [] }); // (endTime, now] gap query — ENG-1332 follow-up

      const timeRange = { startTime: '2026-04-04T00:00:00Z', endTime: '2026-04-05T23:59:59Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].sessionId).toBe('spanning-midnight');
    });

    // ENG-1332: the DynamoDB query above orders by updatedAt, not createdAt. A
    // historical session that was merely touched (not created) during the
    // window can have a more recent updatedAt than a session genuinely
    // created in the window, so a naive updatedAt-DESC pass-through inverts
    // priority — the historical session gets scored first and the real
    // current-window session gets starved out.
    it('prioritizes sessions created within the requested window over historical sessions merely touched within it', async () => {
      const historicalTouched = {
        sessionId: 'historical-touched',
        adminListPartition: 'all',
        createdAt: '2026-02-21T10:30:00.000Z',
        updatedAt: '2026-08-18T13:59:00.000Z',
        title: 'Old session touched recently',
      };
      const currentWindowSession = {
        sessionId: 'current-window',
        adminListPartition: 'all',
        createdAt: '2026-08-17T15:00:00.000Z',
        updatedAt: '2026-08-17T15:05:00.000Z',
        title: 'Created in the requested window',
      };

      // DynamoDB returns updatedAt-DESC order: the historical one sorts first.
      queryPromiseMock
        .mockResolvedValueOnce({ Items: [historicalTouched, currentWindowSession] })
        .mockResolvedValueOnce({ Items: [] }); // (endTime, now] gap query — ENG-1332 follow-up

      const timeRange = { startTime: '2026-08-17T14:00:00Z', endTime: '2026-08-18T14:00:00Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions.map((s: any) => s.sessionId)).toEqual([
        'current-window',
        'historical-touched',
      ]);
    });

    it('sorts multiple in-window sessions by createdAt descending', async () => {
      const older = {
        sessionId: 'older-in-window',
        adminListPartition: 'all',
        createdAt: '2026-08-17T15:00:00.000Z',
        updatedAt: '2026-08-17T15:05:00.000Z',
      };
      const newer = {
        sessionId: 'newer-in-window',
        adminListPartition: 'all',
        createdAt: '2026-08-18T08:00:00.000Z',
        updatedAt: '2026-08-18T08:01:00.000Z',
      };

      queryPromiseMock
        .mockResolvedValueOnce({ Items: [older, newer] })
        .mockResolvedValueOnce({ Items: [] }); // (endTime, now] gap query — ENG-1332 follow-up

      const timeRange = { startTime: '2026-08-17T14:00:00Z', endTime: '2026-08-18T14:00:00Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions.map((s: any) => s.sessionId)).toEqual([
        'newer-in-window',
        'older-in-window',
      ]);
    });

    it('keeps in-window sessions ahead of historical ones when limit truncates the result', async () => {
      const historical1 = {
        sessionId: 'h1',
        adminListPartition: 'all',
        createdAt: '2026-02-01T00:00:00.000Z',
        updatedAt: '2026-08-18T13:59:00.000Z',
      };
      const historical2 = {
        sessionId: 'h2',
        adminListPartition: 'all',
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-08-18T13:58:00.000Z',
      };
      const current = {
        sessionId: 'c1',
        adminListPartition: 'all',
        createdAt: '2026-08-18T08:00:00.000Z',
        updatedAt: '2026-08-18T08:05:00.000Z',
      };

      queryPromiseMock
        .mockResolvedValueOnce({ Items: [historical1, historical2, current] })
        .mockResolvedValueOnce({ Items: [] }); // (endTime, now] gap query — ENG-1332 follow-up

      const timeRange = { startTime: '2026-08-17T14:00:00Z', endTime: '2026-08-18T14:00:00Z' };
      const result = await chatbotDb.getRecentSessionsPage(2, undefined, timeRange);

      expect(result.sessions.map((s: any) => s.sessionId)).toEqual(['c1', 'h1']);
    });

    // ENG-1332 follow-up: the primary query is keyed on updatedAt, so a session
    // created in-window but not touched again until after the window closed
    // (e.g. its final message landed a few seconds past endTime, or the window
    // is being re-queried well after it closed) never matches the `updatedAt
    // BETWEEN start AND end` condition at all — no amount of in-memory
    // reordering can recover a session the primary query never fetched. A
    // second, disjoint query over (endTime, now] closes that gap without a
    // schema change, keeping only sessions whose createdAt genuinely falls in
    // the requested range.
    it('recovers a session created in-window but last updated after endTime via the gap query', async () => {
      const lateTouch = {
        sessionId: 'late-touch',
        adminListPartition: 'all',
        createdAt: '2026-08-18T13:50:00.000Z',
        updatedAt: '2026-08-18T14:00:05.000Z', // 5s after endTime
        title: 'Finished just past the window boundary',
      };
      // A session touched after endTime but created OUTSIDE the requested
      // range must not be pulled in by the gap query.
      const unrelatedLateTouch = {
        sessionId: 'unrelated-late-touch',
        adminListPartition: 'all',
        createdAt: '2026-08-18T14:30:00.000Z',
        updatedAt: '2026-08-18T14:35:00.000Z',
        title: 'Created after the window closed',
      };

      queryPromiseMock
        .mockResolvedValueOnce({ Items: [] }) // primary [start, end] query: nothing
        .mockResolvedValueOnce({ Items: [lateTouch, unrelatedLateTouch] }); // (end, now] gap query

      const timeRange = { startTime: '2026-08-17T14:00:00Z', endTime: '2026-08-18T14:00:00Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions.map((s: any) => s.sessionId)).toEqual(['late-touch']);
      expect(queryPromiseMock).toHaveBeenCalledTimes(2);
    });

    it('skips the gap query when endTime is already at or after now', async () => {
      const currentWindowSession = {
        sessionId: 'current-window',
        adminListPartition: 'all',
        createdAt: '2026-08-18T08:00:00.000Z',
        updatedAt: '2026-08-18T08:05:00.000Z',
      };

      queryPromiseMock.mockResolvedValueOnce({ Items: [currentWindowSession] });

      // endTime far in the future relative to "now" at test execution.
      const timeRange = { startTime: '2026-08-17T14:00:00Z', endTime: '2099-01-01T00:00:00.000Z' };
      const result = await chatbotDb.getRecentSessionsPage(100, undefined, timeRange);

      expect(result.sessions.map((s: any) => s.sessionId)).toEqual(['current-window']);
      expect(queryPromiseMock).toHaveBeenCalledTimes(1);
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
