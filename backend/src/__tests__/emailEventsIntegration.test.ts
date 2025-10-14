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

describe('Email Events Integration Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Email Events Pagination Integration', () => {
    it('should handle large datasets with pagination correctly', async () => {
      const emailId = 'email-123';
      const emailDomain = 'example.com';
      
      // Create a large dataset to test pagination
      const largeEventSet = Array.from({ length: 250 }, (_, i) => ({
        eventId: `event-${i + 1}`,
        emailId,
        emailDomain,
        eventType: 'email.delivered',
        createdAt: `2025-01-01T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
        data: {
          email_id: emailId,
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
        processedAt: `2025-01-01T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }));

      // Mock pagination - DynamoDB returns 100 items per page
      const firstPage = largeEventSet.slice(0, 100);
      const secondPage = largeEventSet.slice(100, 200);
      const thirdPage = largeEventSet.slice(200, 250);

      mockDynamodb.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: firstPage,
            LastEvaluatedKey: { eventId: 'event-100' },
          }),
        } as any)
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: secondPage,
            LastEvaluatedKey: { eventId: 'event-200' },
          }),
        } as any)
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: thirdPage,
            LastEvaluatedKey: undefined, // No more pages
          }),
        } as any);

      const result = await emailEventsDb.getEventsByEmailId(emailId);

      expect(mockDynamodb.query).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(250);
      expect(result[0].eventId).toBe('event-1');
      expect(result[249].eventId).toBe('event-250');
    });

    it('should handle empty results from pagination', async () => {
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

    it('should handle single page results', async () => {
      const emailId = 'email-123';
      const mockEvents = [
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
      ];

      mockDynamodb.query.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Items: mockEvents,
          LastEvaluatedKey: undefined,
        }),
      } as any);

      const result = await emailEventsDb.getEventsByEmailId(emailId);

      expect(mockDynamodb.query).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockEvents);
    });

    it('should handle complex pagination scenarios with multiple email IDs', async () => {
      const emailDomain = 'example.com';
      
      // Test getEventsByEmailDomain with pagination
      const largeEventSet = Array.from({ length: 300 }, (_, i) => ({
        eventId: `event-${i + 1}`,
        emailId: `email-${Math.floor(i / 100) + 1}`, // 3 different email IDs
        emailDomain,
        eventType: 'email.delivered',
        createdAt: `2025-01-01T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
        data: {
          email_id: `email-${Math.floor(i / 100) + 1}`,
          created_at: '2025-01-01T00:00:00.000Z',
          from: 'sender@example.com',
          to: ['test@example.com'],
          subject: 'Test Email',
        },
        processedAt: `2025-01-01T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }));

      // Mock pagination for domain query
      const firstPage = largeEventSet.slice(0, 100);
      const secondPage = largeEventSet.slice(100, 200);
      const thirdPage = largeEventSet.slice(200, 300);

      mockDynamodb.query
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: firstPage,
            LastEvaluatedKey: { eventId: 'event-100' },
          }),
        } as any)
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: secondPage,
            LastEvaluatedKey: { eventId: 'event-200' },
          }),
        } as any)
        .mockReturnValueOnce({
          promise: jest.fn().mockResolvedValue({
            Items: thirdPage,
            LastEvaluatedKey: undefined,
          }),
        } as any);

      const result = await emailEventsDb.getEventsByEmailDomain(emailDomain);

      expect(mockDynamodb.query).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(300);
    });

  });
});
