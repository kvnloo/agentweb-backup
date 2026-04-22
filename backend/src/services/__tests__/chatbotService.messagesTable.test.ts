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
  getGCSPPrivateKey: jest.fn().mockResolvedValue('mock-private-key'),
}));

jest.mock('../../controllers/guide', () => ({
  getGuide: jest.fn(),
}));

jest.mock('../../controllers/release', () => ({
  getReleases: jest.fn(),
}));

jest.mock('../../controllers/api', () => ({
  getApiDocs: jest.fn(),
}));

jest.mock('../../controllers/user-guide', () => ({
  getUserGuide: jest.fn(),
}));

jest.mock('../../controllers/docsController', () => ({
  getUserReleaseNotes: jest.fn(),
}));

import { chatbotDb, ChatMessage, ChatSession } from '../chatbotService';
import { MAX_MESSAGE_SIZE_PER_SESSION } from '../../config';
import AWS from 'aws-sdk';

describe('ChatbotDB - Messages Table', () => {
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

  describe('getChatSession - Migration', () => {
    const sessionId = 'test-session-id';
    const mockSession: ChatSession = {
      sessionId,
      userId: 'test-user-id',
      title: 'Test Session',
      messages: [
        { role: 'user', content: 'Hello', timestamp: '2024-01-01T00:00:00Z' },
        { role: 'assistant', content: 'Hi there!', timestamp: '2024-01-01T00:00:01Z' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'partner',
    };

    it('should migrate messages from session to messages table when messages exist in session but not in messages table', async () => {
      // Mock get session - returns session with messages
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table - returns empty (no messages in messages table yet)
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

      // Mock batchWrite for migration
      mockDocClient.batchWrite.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      // Mock update for incrementMessageCount during migration
      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await chatbotDb.getChatSession(sessionId);

      // Verify session was retrieved
      expect(mockDocClient.get).toHaveBeenCalledWith({
        TableName: sessionTableName,
        Key: { sessionId },
      });

      // Verify messages table was queried
      expect(mockDocClient.query).toHaveBeenCalledWith({
        TableName: messagesTableName,
        KeyConditionExpression: 'sessionId = :sessionId',
        ExpressionAttributeValues: { ':sessionId': sessionId },
        ScanIndexForward: true,
      });

      // Verify migration was called
      expect(mockDocClient.batchWrite).toHaveBeenCalledWith({
        RequestItems: {
          [messagesTableName]: [
            {
              PutRequest: {
                Item: {
                  sessionId,
                  messageIndex: 0,
                  message: mockSession.messages[0],
                },
              },
            },
            {
              PutRequest: {
                Item: {
                  sessionId,
                  messageIndex: 1,
                  message: mockSession.messages[1],
                },
              },
            },
          ],
        },
      });

      // Verify messageCount was set during migration for asset cache tracking
      expect(mockDocClient.update).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: 'ADD messageCount :count SET updatedAt = :updatedAt',
        ExpressionAttributeValues: expect.objectContaining({ ':count': 2 }),
      }));

      // Verify result has messages from session (migrated)
      expect(result).toBeDefined();
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages[0].content).toBe('Hello');
      expect(result!.messages[1].content).toBe('Hi there!');
    });

    it('should use messages from messages table when they exist', async () => {
      const messagesFromTable = [
        { role: 'user', content: 'Message from table', timestamp: '2024-01-01T00:00:00Z' },
      ];

      // Mock get session - returns session without messages
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { ...mockSession, messages: [] },
        }),
      });

      // Mock query messages table - returns messages
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { sessionId, messageIndex: 0, message: messagesFromTable[0] },
          ],
        }),
      });

      const result = await chatbotDb.getChatSession(sessionId);

      // Verify messages table was queried
      expect(mockDocClient.query).toHaveBeenCalled();

      // Verify migration was NOT called
      expect(mockDocClient.batchWrite).not.toHaveBeenCalled();

      // Verify result has messages from messages table
      expect(result).toBeDefined();
      expect(result!.messages).toHaveLength(1);
      expect(result!.messages[0].content).toBe('Message from table');
    });

    it('should return session without messages when neither session nor messages table has messages', async () => {
      // Mock get session - returns session without messages
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: { ...mockSession, messages: [] },
        }),
      });

      // Mock query messages table - returns empty
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

      const result = await chatbotDb.getChatSession(sessionId);

      expect(result).toBeDefined();
      expect(result!.messages).toHaveLength(0);
      expect(mockDocClient.batchWrite).not.toHaveBeenCalled();
    });

    it('should remove messages from session object when returning', async () => {
      // Mock get session - returns session with messages
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table - returns empty
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [],
        }),
      });

      // Mock batchWrite for migration
      mockDocClient.batchWrite.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await chatbotDb.getChatSession(sessionId);

      // Verify result doesn't have messages from session object, but from messages table
      expect(result).toBeDefined();
      // The messages should come from the migration, not from the session object
      expect(result!.messages).toHaveLength(2);
    });
  });

  describe('addMessageToSession', () => {
    const sessionId = 'test-session-id';
    const mockSession: ChatSession = {
      sessionId,
      userId: 'test-user-id',
      title: 'Test Session',
      messages: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'partner',
    };

    const newMessage: ChatMessage = {
      role: 'user',
      content: 'New message',
      timestamp: '2024-01-01T00:00:02Z',
    };

    it('should add message to messages table, not session table', async () => {
      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table - returns empty initially
      mockDocClient.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [],
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [],
          }),
        });

      // Mock batchWrite for adding message
      mockDocClient.batchWrite.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await chatbotDb.addMessageToSession(sessionId, newMessage);

      // Verify message was added to messages table via batchWrite
      expect(mockDocClient.batchWrite).toHaveBeenCalledWith({
        RequestItems: {
          [messagesTableName]: [
            {
              PutRequest: {
                Item: {
                  sessionId,
                  messageIndex: 0,
                  message: newMessage,
                },
              },
            },
          ],
        },
      });

      // Verify session table was only updated for messageCount increment (not messages)
      expect(mockDocClient.update).toHaveBeenCalledTimes(1);
      expect(mockDocClient.update).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: 'ADD messageCount :count SET updatedAt = :updatedAt',
      }));

      // Verify result includes the new message
      expect(result).toBeDefined();
      expect(result!.messages).toHaveLength(1);
      expect(result!.messages[0].content).toBe('New message');
    });

    it('should allow writing even when message count is at or over the limit', async () => {
      const existingMessages = Array.from({ length: MAX_MESSAGE_SIZE_PER_SESSION }, (_, i) => ({
        sessionId,
        messageIndex: i,
        message: {
          role: 'user' as const,
          content: `Message ${i}`,
          timestamp: `2024-01-01T00:00:${i}Z`,
        },
      }));

      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table - returns MAX messages (at limit)
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: existingMessages,
        }),
      });

      mockDocClient.batchWrite.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ UnprocessedItems: {} }),
      });
      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      // Should succeed — the limit is enforced at turn-start, not during writes
      await expect(chatbotDb.addMessageToSession(sessionId, newMessage)).resolves.toBeDefined();
      expect(mockDocClient.batchWrite).toHaveBeenCalled();
    });

    it('should throw error when session not found', async () => {
      // Mock get session - returns null
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: null,
        }),
      });

      await expect(chatbotDb.addMessageToSession(sessionId, newMessage)).rejects.toThrow(
        'Session not found'
      );
    });
  });

  describe('addMessagesToSession', () => {
    const sessionId = 'test-session-id';
    const mockSession: ChatSession = {
      sessionId,
      userId: 'test-user-id',
      title: 'Test Session',
      messages: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'partner',
    };

    const newMessages: ChatMessage[] = [
      { role: 'user', content: 'Message 1', timestamp: '2024-01-01T00:00:02Z' },
      { role: 'assistant', content: 'Message 2', timestamp: '2024-01-01T00:00:03Z' },
    ];

    it('should add multiple messages to messages table', async () => {
      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table - returns empty initially
      mockDocClient.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [],
          }),
        })
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [],
          }),
        });

      // Mock batchWrite for adding messages
      mockDocClient.batchWrite.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await chatbotDb.addMessagesToSession(sessionId, newMessages);

      // Verify messages were added to messages table
      expect(mockDocClient.batchWrite).toHaveBeenCalledWith({
        RequestItems: {
          [messagesTableName]: [
            {
              PutRequest: {
                Item: {
                  sessionId,
                  messageIndex: 0,
                  message: newMessages[0],
                },
              },
            },
            {
              PutRequest: {
                Item: {
                  sessionId,
                  messageIndex: 1,
                  message: newMessages[1],
                },
              },
            },
          ],
        },
      });

      // Verify session table was only updated for messageCount increment (not messages)
      expect(mockDocClient.update).toHaveBeenCalledTimes(1);
      expect(mockDocClient.update).toHaveBeenCalledWith(expect.objectContaining({
        UpdateExpression: 'ADD messageCount :count SET updatedAt = :updatedAt',
      }));

      // Verify result includes the new messages
      expect(result).toBeDefined();
      expect(result!.messages).toHaveLength(2);
    });

    it('should allow writing even when messages would push count over the limit', async () => {
      const existingMessages = Array.from({ length: MAX_MESSAGE_SIZE_PER_SESSION - 1 }, (_, i) => ({
        sessionId,
        messageIndex: i,
        message: {
          role: 'user' as const,
          content: `Message ${i}`,
          timestamp: `2024-01-01T00:00:${i}Z`,
        },
      }));

      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table - returns MAX-1 messages
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: existingMessages,
        }),
      });

      mockDocClient.batchWrite.mockReturnValue({
        promise: jest.fn().mockResolvedValue({ UnprocessedItems: {} }),
      });
      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      // Should succeed — the limit is enforced at turn-start, not during writes
      await expect(chatbotDb.addMessagesToSession(sessionId, newMessages)).resolves.toBeDefined();
      expect(mockDocClient.batchWrite).toHaveBeenCalled();
    });

    it('should return session unchanged when messages array is empty', async () => {
      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      const result = await chatbotDb.addMessagesToSession(sessionId, []);

      // Verify no writes were made
      expect(mockDocClient.batchWrite).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });
  });

  describe('updateMessageInSession', () => {
    const sessionId = 'test-session-id';
    const mockSession: ChatSession = {
      sessionId,
      userId: 'test-user-id',
      title: 'Test Session',
      messages: [
        { role: 'user', content: 'Original', timestamp: '2024-01-01T00:00:00Z' },
      ],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      portalType: 'partner',
    };

    const updatedMessage: ChatMessage = {
      role: 'user',
      content: 'Updated',
      timestamp: '2024-01-01T00:00:00Z',
    };

    it('should update message in messages table, not session table', async () => {
      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { sessionId, messageIndex: 0, message: mockSession.messages[0] },
          ],
        }),
      });

      // Mock update for messages table
      mockDocClient.update.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      await chatbotDb.updateMessageInSession(sessionId, 0, updatedMessage);

      // Verify message was updated in messages table
      expect(mockDocClient.update).toHaveBeenCalledWith({
        TableName: messagesTableName,
        Key: {
          sessionId,
          messageIndex: 0,
        },
        UpdateExpression: 'SET message = :message',
        ExpressionAttributeValues: {
          ':message': updatedMessage,
        },
      });

      // Verify session table was NOT updated
      const updateCalls = mockDocClient.update.mock.calls;
      const sessionTableUpdates = updateCalls.filter(
        (call: any) => call[0].TableName === sessionTableName
      );
      expect(sessionTableUpdates).toHaveLength(0);
    });

    it('should throw error when message index is out of bounds', async () => {
      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [
            { sessionId, messageIndex: 0, message: mockSession.messages[0] },
          ],
        }),
      });

      await expect(chatbotDb.updateMessageInSession(sessionId, 5, updatedMessage)).rejects.toThrow(
        'out of bounds'
      );
    });
  });

  describe('getMessagesFromMessagesTable - Error Handling', () => {
    const sessionId = 'test-session-id';

    it('should handle ResourceNotFoundException gracefully', async () => {
      const mockSession: ChatSession = {
        sessionId,
        userId: 'test-user-id',
        title: 'Test Session',
        messages: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        portalType: 'partner',
      };

      // Mock get session
      mockDocClient.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockSession,
        }),
      });

      // Mock query messages table - table doesn't exist
      mockDocClient.query.mockReturnValue({
        promise: jest.fn().mockRejectedValue({
          code: 'ResourceNotFoundException',
          message: 'Table not found',
        }),
      });

      const result = await chatbotDb.getChatSession(sessionId);

      // Should return session with empty messages array
      expect(result).toBeDefined();
      expect(result!.messages).toHaveLength(0);
    });
  });
});
