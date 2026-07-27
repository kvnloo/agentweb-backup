// @ts-nocheck
// Mock AWS SDK BEFORE importing chatbotService
jest.mock('aws-sdk', () => {
  const mockDocClient = {
    get: jest.fn(),
    put: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    batchWrite: jest.fn(),
  };
  
  return {
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocClient),
    },
    S3: jest.fn(() => ({
      putObject: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn(),
    })),
    config: {
      update: jest.fn(),
    },
  };
});

// Mock other dependencies
jest.mock('../db', () => ({
  taskDb: {
    getTaskById: jest.fn(),
  },
}));

jest.mock('../../utils/secretsManager', () => ({
  getGCSPPrivateKey: jest.fn(() => Promise.resolve('mock-private-key')),
}));

jest.mock('../../controllers/guide', () => ({
  getGuide: jest.fn(),
}));

jest.mock('../../controllers/release', () => ({
  getReleases: jest.fn(),
}));



jest.mock('../../controllers/docsController', () => ({
  getUserReleaseNotes: jest.fn(),
}));

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { chatbotDb, ChatbotDB } from '../chatbotService';
import AWS from 'aws-sdk';

describe('ChatbotDB.getUserSessions - Message Loading from Messages Table', () => {
  let mockDocClient: any;
  const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
  const sessionTableName = `${TABLE_PREFIX}AW-ChatSessions`;
  const messagesTableName = `${TABLE_PREFIX}AW-ChatMessages`;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Get the mocked DocumentClient instance
    const DocumentClient = AWS.DynamoDB.DocumentClient as any;
    mockDocClient = new DocumentClient();
  });

  it('should fetch messages from messages table for each session', async () => {
    const userId = 'user-123';
    const sessionId1 = 'session-1';
    const sessionId2 = 'session-2';

    const mockSessions = [
      {
        sessionId: sessionId1,
        userId,
        title: 'Session 1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        messages: [], // Empty in session record
      },
      {
        sessionId: sessionId2,
        userId,
        title: 'Session 2',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        portalType: 'agent',
        messages: [], // Empty in session record
      },
    ];

    const mockMessages1 = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    const mockMessages2 = [
      { role: 'user', content: 'Another message' },
      { role: 'assistant', content: 'Another response' },
    ];

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: mockSessions,
          LastEvaluatedKey: null,
        }),
      } as any)
      // After sorting, session-2 (newer) comes first, then session-1 (older)
      // So we need to mock messages queries in sorted order: session-2 first, then session-1
      // Mock query for messages for session 2 (first after sorting)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { sessionId: sessionId2, messageIndex: 0, message: mockMessages2[0] },
            { sessionId: sessionId2, messageIndex: 1, message: mockMessages2[1] },
          ],
        }),
      })
      // Mock query for messages for session 1 (second after sorting)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { sessionId: sessionId1, messageIndex: 0, message: mockMessages1[0] },
            { sessionId: sessionId1, messageIndex: 1, message: mockMessages1[1] },
          ],
        }),
      });

    const result = await chatbotDb.getUserSessions(userId, 'agent');

    expect(result.sessions).toHaveLength(2);
    // Sessions are sorted by updatedAt descending (newest first)
    // session-2 has updatedAt '2024-01-02', session-1 has '2024-01-01'
    expect(result.sessions[0].sessionId).toBe(sessionId2); // Newer session first
    expect(result.sessions[0].messages).toHaveLength(2);
    expect(result.sessions[0].messages[0].content).toBe('Another message');
    expect(result.sessions[0].messages[1].content).toBe('Another response');

    expect(result.sessions[1].sessionId).toBe(sessionId1); // Older session second
    expect(result.sessions[1].messages).toHaveLength(2);
    expect(result.sessions[1].messages[0].content).toBe('Hello');
    expect(result.sessions[1].messages[1].content).toBe('Hi there!');

    // Verify messages table was queried for each session
    expect(mockDocClient.query).toHaveBeenCalledTimes(3); // 1 for sessions + 2 for messages
  });

  it('should return accurate message counts from messages table', async () => {
    const userId = 'user-123';
    const sessionId = 'session-1';

    const mockSession = {
      sessionId,
      userId,
      title: 'Session 1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'agent',
      messages: [], // Empty in session record
    };

    const mockMessages = [
      { role: 'user', content: 'Message 1' },
      { role: 'assistant', content: 'Response 1' },
      { role: 'user', content: 'Message 2' },
      { role: 'assistant', content: 'Response 2' },
      { role: 'user', content: 'Message 3' },
    ];

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [mockSession],
          LastEvaluatedKey: null,
        }),
      } as any)
      // Mock query for messages
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: mockMessages.map((msg, index) => ({
            sessionId,
            messageIndex: index,
            message: msg,
          })),
        }),
      });

    const result = await chatbotDb.getUserSessions(userId, 'agent');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages).toHaveLength(5);
    // Frontend will display: Math.max(0, messages.length - 1) = 4 messages
  });

  it('should migrate messages from session record to messages table when messages table is empty', async () => {
    const userId = 'user-123';
    const sessionId = 'session-1';

    const mockSession = {
      sessionId,
      userId,
      title: 'Session 1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'agent',
      messages: [
        { role: 'user', content: 'Old message 1' },
        { role: 'assistant', content: 'Old response 1' },
      ], // Messages exist in session record
    };

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [mockSession],
          LastEvaluatedKey: null,
        }),
      } as any)
      // Mock query for messages table (empty - triggers migration)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

    // Mock batchWrite for migration
    // @ts-expect-error - jest.Mock typing issue
    (mockDocClient.batchWrite as jest.Mock).mockReturnValueOnce({
      promise: jest.fn().mockResolvedValue({}),
    });

    const result = await chatbotDb.getUserSessions(userId, 'agent');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages).toHaveLength(2);
    expect(result.sessions[0].messages[0].content).toBe('Old message 1');
    expect(result.sessions[0].messages[1].content).toBe('Old response 1');

    // Verify migration was called
    expect(mockDocClient.batchWrite).toHaveBeenCalled();
  });

  it('should handle sessions with no messages gracefully', async () => {
    const userId = 'user-123';
    const sessionId = 'session-1';

    const mockSession = {
      sessionId,
      userId,
      title: 'Session 1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'agent',
      messages: [], // No messages in session record
    };

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [mockSession],
          LastEvaluatedKey: null,
        }),
      } as any)
      // Mock query for messages table (empty)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

    const result = await chatbotDb.getUserSessions(userId, 'agent');

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages).toHaveLength(0);
  });

  it('should handle errors when fetching messages gracefully', async () => {
    const userId = 'user-123';
    const sessionId = 'session-1';

    const mockSession = {
      sessionId,
      userId,
      title: 'Session 1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'agent',
      messages: [],
    };

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [mockSession],
          LastEvaluatedKey: null,
        }),
      } as any)
      // Mock query for messages table (error)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
    // @ts-expect-error - jest.Mock typing issue
        promise: jest.fn().mockRejectedValue(new Error('Database error') as any),
      });

    const result = await chatbotDb.getUserSessions(userId, 'agent');

    // Should still return session but with empty messages array
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages).toHaveLength(0);
  });

  it('should handle ResourceNotFoundException for messages table (table not created yet)', async () => {
    const userId = 'user-123';
    const sessionId = 'session-1';

    const mockSession = {
      sessionId,
      userId,
      title: 'Session 1',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'agent',
      messages: [],
    };

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [mockSession],
          LastEvaluatedKey: null,
        }),
      } as any)
      // Mock query for messages table (table doesn't exist)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
    // @ts-expect-error - jest.Mock typing issue
        promise: jest.fn().mockRejectedValue({
          code: 'ResourceNotFoundException',
          message: 'Table not found',
        }),
      });

    const result = await chatbotDb.getUserSessions(userId, 'agent');

    // Should return session with empty messages array
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].messages).toHaveLength(0);
  });

  it('should filter out archived sessions', async () => {
    const userId = 'user-123';

    const mockSessions = [
      {
        sessionId: 'session-1',
        userId,
        title: 'Active Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        archived: false,
        messages: [],
      },
      {
        sessionId: 'session-2',
        userId,
        title: 'Archived Session',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        portalType: 'agent',
        archived: true, // Archived session
        messages: [],
      },
    ];

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: mockSessions,
          LastEvaluatedKey: null,
        }),
      } as any)
      // Mock query for messages for session 1
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

    const result = await chatbotDb.getUserSessions(userId, 'agent');

    // Should only return non-archived session
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe('session-1');
    expect(result.sessions[0].archived).toBe(false);
  });

  it('should sort sessions by updatedAt descending', async () => {
    const userId = 'user-123';

    const mockSessions = [
      {
        sessionId: 'session-1',
        userId,
        title: 'Older Session',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'agent',
        messages: [],
      },
      {
        sessionId: 'session-2',
        userId,
        title: 'Newer Session',
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-03T00:00:00Z', // More recent
        portalType: 'agent',
        messages: [],
      },
    ];

    // Mock query for sessions
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: mockSessions,
          LastEvaluatedKey: null,
        }),
      } as any)
      // Mock queries for messages
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      } as any) // session-1
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({ Items: [] }),
      } as any); // session-2

    const result = await chatbotDb.getUserSessions(userId, 'agent', undefined, true);

    // Should be sorted by updatedAt descending (newest first)
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0].sessionId).toBe('session-2'); // Newer first
    expect(result.sessions[1].sessionId).toBe('session-1');
  });

  it('should handle pagination with lastEvaluatedKey', async () => {
    const userId = 'user-123';
    const lastEvaluatedKey = JSON.stringify({ sessionId: 'session-1', createdAt: '2024-01-01T00:00:00Z' });

    const mockSession = {
      sessionId: 'session-2',
      userId,
      title: 'Session 2',
      createdAt: '2024-01-02T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      portalType: 'agent',
      messages: [],
    };

    // Mock query for sessions - first page returns one session with a pagination key
    (mockDocClient.query as jest.Mock)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [mockSession],
          LastEvaluatedKey: { sessionId: 'session-2', createdAt: '2024-01-02T00:00:00Z' },
        }),
      } as any)
      // Second page - no more sessions (loop ends)
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      } as any)
      // Mock query for messages
    // @ts-expect-error - jest.Mock typing issue
      .mockReturnValueOnce({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

    const result = await chatbotDb.getUserSessions(userId, 'agent', 50, true, lastEvaluatedKey);

    expect(result.sessions).toHaveLength(1);
    // After exhausting all pages, lastEvaluatedKey should be undefined
    expect(result.lastEvaluatedKey).toBeUndefined();
  });
});
