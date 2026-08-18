import { emailEventsDb, EmailEvent } from '../services/emailEventsDb';
import { dynamodb } from '../config/aws';

// Mock the AWS DynamoDB
jest.mock('../config/aws', () => ({
  dynamodb: {
    put: jest.fn(),
    get: jest.fn(),
    query: jest.fn(),
    scan: jest.fn(),
  },
}));

const mockDynamodb = dynamodb as jest.Mocked<typeof dynamodb>;

describe('EmailEventsDb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('addEmailEvent', () => {
    it('should add an email event successfully', async () => {
      const mockEvent = {
        type: 'email.delivered',
        created_at: '2025-01-01T00:00:00.000Z',
        data: {
          email_id: 'email-123',
          to: 'test@example.com',
          from: 'sender@example.com',
          subject: 'Test Email',
        },
      };

      const emailDomain = 'example.com';
      const eventId = 'event-123';

      mockDynamodb.put.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      } as any);

      const result = await emailEventsDb.addEmailEvent(mockEvent as any, emailDomain, eventId);

      expect(mockDynamodb.put).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-EmailEvents'),
        Item: expect.objectContaining({
          eventId,
          emailId: 'email-123',
          emailDomain,
          eventType: 'email.delivered',
          createdAt: '2025-01-01T00:00:00.000Z',
          data: mockEvent.data,
          processedAt: expect.any(String),
        }),
        ConditionExpression: 'attribute_not_exists(eventId)',
      });

      expect(result).toEqual(expect.objectContaining({
        eventId,
        emailId: 'email-123',
        emailDomain,
        eventType: 'email.delivered',
        createdAt: '2025-01-01T00:00:00.000Z',
        data: mockEvent.data,
        processedAt: expect.any(String),
      }));
    });
  });

  describe('getEventsByEmailId', () => {
    it('should return all events for an email ID with pagination', async () => {
      const emailId = 'email-123';
      const mockEvents: EmailEvent[] = [
        {
          eventId: 'event-1',
          emailId,
          emailDomain: 'example.com',
          eventType: 'email.delivered',
          createdAt: '2025-01-01T00:00:00.000Z',
          data: {
          email_id: emailId,
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
          processedAt: '2025-01-01T00:00:00.000Z',
        },
        {
          eventId: 'event-2',
          emailId,
          emailDomain: 'example.com',
          eventType: 'email.opened',
          createdAt: '2025-01-01T01:00:00.000Z',
          data: {
          email_id: emailId,
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
          processedAt: '2025-01-01T01:00:00.000Z',
        },
      ];

      // Mock pagination - first call returns partial data with LastEvaluatedKey
      mockDynamodb.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [mockEvents[0]],
            LastEvaluatedKey: { eventId: 'event-1' },
          }),
        } as any)
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [mockEvents[1]],
            LastEvaluatedKey: undefined, // No more pages
          }),
        } as any);

      const result = await emailEventsDb.getEventsByEmailId(emailId);

      expect(mockDynamodb.query).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockEvents);
    });

    it('should return empty array when no events found', async () => {
      const emailId = 'email-123';

      mockDynamodb.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: undefined,
          LastEvaluatedKey: undefined,
        }),
      } as any);

      const result = await emailEventsDb.getEventsByEmailId(emailId);

      expect(result).toEqual([]);
    });

    it('should handle single page of results', async () => {
      const emailId = 'email-123';
      const mockEvent: EmailEvent = {
        eventId: 'event-1',
        emailId,
        emailDomain: 'example.com',
        eventType: 'email.delivered',
        createdAt: '2025-01-01T00:00:00.000Z',
        data: {
          email_id: emailId,
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
        processedAt: '2025-01-01T00:00:00.000Z',
      };

      mockDynamodb.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: [mockEvent],
          LastEvaluatedKey: undefined,
        }),
      } as any);

      const result = await emailEventsDb.getEventsByEmailId(emailId);

      expect(mockDynamodb.query).toHaveBeenCalledTimes(1);
      expect(result).toEqual([mockEvent]);
    });
  });

  describe('getEventsByEmailDomain', () => {
    it('should return all events for an email domain with pagination', async () => {
      const emailDomain = 'example.com';
      const mockEvents: EmailEvent[] = [
        {
          eventId: 'event-1',
          emailId: 'email-1',
          emailDomain,
          eventType: 'email.delivered',
          createdAt: '2025-01-01T00:00:00.000Z',
          data: {
          email_id: 'email-1',
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
          processedAt: '2025-01-01T00:00:00.000Z',
        },
        {
          eventId: 'event-2',
          emailId: 'email-2',
          emailDomain,
          eventType: 'email.opened',
          createdAt: '2025-01-01T01:00:00.000Z',
          data: {
          email_id: 'email-2',
          created_at: '2025-01-01T01:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email 2',
        },
          processedAt: '2025-01-01T01:00:00.000Z',
        },
      ];

      // Mock pagination
      mockDynamodb.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [mockEvents[0]],
            LastEvaluatedKey: { eventId: 'event-1' },
          }),
        } as any)
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: [mockEvents[1]],
            LastEvaluatedKey: undefined,
          }),
        } as any);

      const result = await emailEventsDb.getEventsByEmailDomain(emailDomain);

      expect(mockDynamodb.query).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockEvents);
    });
  });

  describe('getEventById', () => {
    it('should return an event by ID', async () => {
      const eventId = 'event-123';
      const mockEvent: EmailEvent = {
        eventId,
        emailId: 'email-123',
        emailDomain: 'example.com',
        eventType: 'email.delivered',
        createdAt: '2025-01-01T00:00:00.000Z',
        data: {
          email_id: 'email-123',
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
        processedAt: '2025-01-01T00:00:00.000Z',
      };

      mockDynamodb.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockEvent,
        }),
      } as any);

      const result = await emailEventsDb.getEventById(eventId);

      expect(mockDynamodb.get).toHaveBeenCalledWith({
        TableName: expect.stringContaining('AW-EmailEvents'),
        Key: { eventId },
      });
      expect(result).toEqual(mockEvent);
    });

    it('should return null when event not found', async () => {
      const eventId = 'event-123';

      mockDynamodb.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: undefined,
        }),
      } as any);

      const result = await emailEventsDb.getEventById(eventId);

      expect(result).toBeNull();
    });
  });

  describe('eventExists', () => {
    it('should return true when event exists', async () => {
      const eventId = 'event-123';
      const mockEvent: EmailEvent = {
        eventId,
        emailId: 'email-123',
        emailDomain: 'example.com',
        eventType: 'email.delivered',
        createdAt: '2025-01-01T00:00:00.000Z',
        data: {
          email_id: 'email-123',
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
        processedAt: '2025-01-01T00:00:00.000Z',
      };

      mockDynamodb.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: mockEvent,
        }),
      } as any);

      const result = await emailEventsDb.eventExists(eventId);

      expect(result).toBe(true);
    });

    it('should return false when event does not exist', async () => {
      const eventId = 'event-123';

      mockDynamodb.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: undefined,
        }),
      } as any);

      const result = await emailEventsDb.eventExists(eventId);

      expect(result).toBe(false);
    });
  });


  describe('error handling', () => {
    it('should propagate errors from DynamoDB operations', async () => {
      const emailId = 'email-123';
      const error = new Error('DynamoDB error');

      mockDynamodb.query.mockReturnValue({
        promise: jest.fn().mockRejectedValue(error),
      } as any);

      await expect(emailEventsDb.getEventsByEmailId(emailId)).rejects.toThrow('DynamoDB error');
    });

    it('should handle errors in addEmailEvent', async () => {
      const mockEvent = {
        type: 'email.delivered',
        created_at: '2025-01-01T00:00:00.000Z',
        data: {
          email_id: 'email-123',
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
      };
      const error = new Error('DynamoDB put error');

      mockDynamodb.put.mockReturnValue({
        promise: jest.fn().mockRejectedValue(error),
      } as any);

      await expect(
        emailEventsDb.addEmailEvent(mockEvent as any, 'example.com', 'event-123')
      ).rejects.toThrow('DynamoDB put error');
    });

    // ENG-720: two concurrent deliveries of the same webhook eventId can both
    // pass the caller's getEventById existence check before either write
    // lands. The conditional put makes the second writer lose atomically
    // instead of silently overwriting the first writer's row (and its
    // hardBounceFlagPending marker).
    it('surfaces a ConditionalCheckFailedException as a distinguishable duplicate error', async () => {
      const mockEvent = {
        type: 'email.bounced',
        created_at: '2025-01-01T00:00:00.000Z',
        data: {
          email_id: 'email-123',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
      };
      const conditionalError: any = new Error('The conditional request failed');
      conditionalError.code = 'ConditionalCheckFailedException';

      mockDynamodb.put.mockReturnValue({
        promise: jest.fn().mockRejectedValue(conditionalError),
      } as any);

      await expect(
        emailEventsDb.addEmailEvent(mockEvent as any, 'example.com', 'event-123', undefined, true)
      ).rejects.toMatchObject({ isDuplicateEventId: true });

      expect(mockDynamodb.put).toHaveBeenCalledWith(
        expect.objectContaining({ ConditionExpression: 'attribute_not_exists(eventId)' }),
      );
    });
  });

  describe('addLinkedInMessageEvent', () => {
    it('stores emailId from messageProviderId when provided', async () => {
      mockDynamodb.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) } as any);

      await emailEventsDb.addLinkedInMessageEvent({
        eventId: 'ev-1',
        emailDomain: 'linkedin-list-1',
        leadEmail: 'https://www.linkedin.com/in/john-doe',
        eventType: 'linkedin.message.sent',
        text: 'Hello!',
        timestamp: '2026-01-01T10:00:00.000Z',
        senderId: 'acct-1',
        messageProviderId: 'msg-provider-123',
      });

      expect(mockDynamodb.put).toHaveBeenCalledWith(
        expect.objectContaining({
          Item: expect.objectContaining({ emailId: 'msg-provider-123' }),
        }),
      );
    });

    it('falls back to eventId when messageProviderId is empty (GSI key cannot be empty string)', async () => {
      mockDynamodb.put.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) } as any);

      await emailEventsDb.addLinkedInMessageEvent({
        eventId: 'ev-fallback-1',
        emailDomain: 'linkedin-list-2',
        leadEmail: 'https://www.linkedin.com/in/jane-doe',
        eventType: 'linkedin.message.sent',
        text: 'Hi there!',
        timestamp: '2026-01-01T10:00:00.000Z',
        senderId: 'acct-1',
        messageProviderId: '',
      });

      const putCall = (mockDynamodb.put as jest.Mock).mock.calls[0][0];
      expect(putCall.Item.emailId).toBe('ev-fallback-1');
      expect(putCall.Item.emailId).not.toBe('');
    });
  });
});
