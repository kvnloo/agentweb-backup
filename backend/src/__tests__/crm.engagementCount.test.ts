// Unit tests for CRM engagement counting with sent/received message filtering

// Mock AWS SDK before importing db.ts
const mockDocumentClientMethods = {
  put: jest.fn(),
  get: jest.fn(),
  query: jest.fn(),
  scan: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  batchWrite: jest.fn(),
};

jest.mock('aws-sdk', () => {
  return {
    config: {
      update: jest.fn(),
    },
    DynamoDB: {
      DocumentClient: jest.fn(() => mockDocumentClientMethods),
    },
    S3: jest.fn(() => ({
      upload: jest.fn(),
      getObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
    SecretsManager: jest.fn(() => ({
      getSecretValue: jest.fn(),
    })),
  };
});

// Mock emailEventsDb
const mockGetEventsByEmailDomainAndLeadEmail = jest.fn();
const mockGetEventsByEmailDomain = jest.fn();

jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    getEventsByEmailDomainAndLeadEmail: mockGetEventsByEmailDomainAndLeadEmail,
    getEventsByEmailDomain: mockGetEventsByEmailDomain,
  },
}));

jest.mock('../services/resendService', () => ({
  resendService: {
    getReceivedEmailContent: jest.fn(),
    getDeliveredEmailContent: jest.fn(),
  },
}));

import { crmDb, userDb } from '../services/db';

describe('CRM Engagement Count - Sent vs Received Filtering', () => {
  let getUserByIdSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();

    // Default mock for getLeadById
    mockDocumentClientMethods.get.mockReturnValue({
      promise: jest.fn().mockResolvedValue({
        Item: {
          listId: 'list1',
          leadId: 'lead1',
          email: 'test@example.com',
          linkedin: 'https://www.linkedin.com/in/testuser',
          engagements: [],
        },
      }),
    });
  });

  afterEach(() => {
    if (getUserByIdSpy) {
      getUserByIdSpy.mockRestore();
    }
  });

  describe('getLeadEngagementCount', () => {
    it('should only count sent messages, not received messages for LinkedIn events', async () => {
      // Mock getUserById (no email domain)
      getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'user1' } as any);

      // Mock LinkedIn events with both sent and received
      const linkedInEvents = [
        { eventType: 'linkedin.message.sent', createdAt: '2026-02-01T10:00:00Z' },
        { eventType: 'linkedin.message.sent', createdAt: '2026-02-02T10:00:00Z' },
        { eventType: 'linkedin.message.received', createdAt: '2026-02-01T11:00:00Z' },
        { eventType: 'linkedin.message.received', createdAt: '2026-02-02T11:00:00Z' },
        { eventType: 'linkedin.message.received', createdAt: '2026-02-03T11:00:00Z' },
      ];

      // User has no emailDomain, so only LinkedIn events will be queried
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValueOnce(linkedInEvents);

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      expect(result.total).toBe(2); // Only 2 sent messages
      expect(result.totalAllMessages).toBe(5); // All 5 messages (sent + received)
    });

    it('should filter email events to only count sent events', async () => {
      // Mock getUserById with email domain
      getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockResolvedValue({
        userId: 'user1',
        emailDomain: 'example.com'
      } as any);

      // Mock email events with various types
      const emailEvents = [
        { eventType: 'email.sent', createdAt: '2026-02-01T10:00:00Z' },
        { eventType: 'email.opened', createdAt: '2026-02-01T11:00:00Z' },
        { eventType: 'email.clicked', createdAt: '2026-02-01T12:00:00Z' },
        { eventType: 'email.sent', createdAt: '2026-02-02T10:00:00Z' },
      ];

      // Mock to return email events for email domain, and empty for LinkedIn
      mockGetEventsByEmailDomainAndLeadEmail
        .mockResolvedValueOnce(emailEvents) // First call for email
        .mockResolvedValueOnce([]); // Second call for LinkedIn

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      expect(result.total).toBe(2); // Only 2 sent events
      expect(result.totalAllMessages).toBe(4); // All 4 events
    });

    it('should filter manual engagements to only count sent events', async () => {
      // Mock lead with manual engagements
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            listId: 'list1',
            leadId: 'lead1',
            email: 'test@example.com',
            engagements: [
              { eventType: 'phone.call.sent', createdAt: '2026-02-01T10:00:00Z', eventData: {} },
              { eventType: 'meeting.scheduled', createdAt: '2026-02-02T10:00:00Z', eventData: {} },
              { eventType: 'message.sent', createdAt: '2026-02-03T10:00:00Z', eventData: {} },
            ],
          },
        }),
      });

      getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'user1' } as any);

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      expect(result.total).toBe(2); // Only events with "sent" in name
      expect(result.totalAllMessages).toBe(3); // All 3 engagements
    });

    it('should count last 7 days sent messages only', async () => {
      getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'user1' } as any);

      const now = new Date();
      const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

      const linkedInEvents = [
        { eventType: 'linkedin.message.sent', createdAt: sixDaysAgo.toISOString() },
        { eventType: 'linkedin.message.sent', createdAt: eightDaysAgo.toISOString() },
        { eventType: 'linkedin.message.received', createdAt: sixDaysAgo.toISOString() },
      ];

      // User has no emailDomain, so only LinkedIn events will be queried
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValueOnce(linkedInEvents);

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      expect(result.last7Days).toBe(1); // Only 1 sent message in last 7 days
      expect(result.total).toBe(2); // 2 total sent messages
      expect(result.totalAllMessages).toBe(3); // All 3 messages
    });

    it('should handle mixed event sources correctly', async () => {
      // Mock getUserById with email domain
      getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockResolvedValue({
        userId: 'user1',
        emailDomain: 'example.com'
      } as any);

      // Mock lead with manual engagements
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({
          Item: {
            listId: 'list1',
            leadId: 'lead1',
            email: 'test@example.com',
            linkedin: 'https://www.linkedin.com/in/testuser',
            engagements: [
              { eventType: 'custom.message.sent', createdAt: '2026-02-01T10:00:00Z', eventData: {} },
              { eventType: 'custom.note', createdAt: '2026-02-02T10:00:00Z', eventData: {} },
            ],
          },
        }),
      });

      // Mock email events
      const emailEvents = [
        { eventType: 'email.sent', createdAt: '2026-02-01T10:00:00Z' },
        { eventType: 'email.opened', createdAt: '2026-02-01T11:00:00Z' },
      ];

      // Mock LinkedIn events
      const linkedInEvents = [
        { eventType: 'linkedin.message.sent', createdAt: '2026-02-01T10:00:00Z' },
        { eventType: 'linkedin.message.received', createdAt: '2026-02-02T10:00:00Z' },
      ];

      mockGetEventsByEmailDomainAndLeadEmail
        .mockResolvedValueOnce(emailEvents) // First call for email
        .mockResolvedValueOnce(linkedInEvents); // Second call for LinkedIn

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      // Should count: 1 manual sent + 1 email sent + 1 LinkedIn sent = 3 sent
      expect(result.total).toBe(3);
      // Should count all: 2 manual + 2 email + 2 LinkedIn = 6 total
      expect(result.totalAllMessages).toBe(6);
    });

    it('should return zero counts when no events exist', async () => {
      getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'user1' } as any);
      // User has no emailDomain, so only LinkedIn events will be queried
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValueOnce([]);

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      expect(result.total).toBe(0);
      expect(result.totalAllMessages).toBe(0);
      expect(result.last7Days).toBe(0);
    });

    it('should return zero counts when lead not found', async () => {
      mockDocumentClientMethods.get.mockReturnValue({
        promise: jest.fn().mockResolvedValue({}),
      });

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      expect(result.total).toBe(0);
      expect(result.totalAllMessages).toBe(0);
      expect(result.last7Days).toBe(0);
    });

    it('does not double-count a sent message present as both synthetic send + synced event', async () => {
      getUserByIdSpy = jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'user1' } as any);

      // Same outbound message recorded twice: once at send time (synthetic
      // linkedin_sent_*) and once when the sync re-imported it (linkedin_msg_*).
      const linkedInEvents = [
        { eventId: 'linkedin_sent_1780236070619_lead1', eventType: 'linkedin.message.sent', createdAt: '2026-05-31T14:01:10Z', data: { text: 'Thanks for connecting. would love to learn more about your work.' } },
        { eventId: 'linkedin_msg_2-ABC', eventType: 'linkedin.message.sent', createdAt: '2026-05-31T14:01:10Z', data: { text: 'Thanks for connecting. would love to learn more about your work.' } },
        { eventId: 'linkedin_msg_2-DEF', eventType: 'linkedin.message.sent', createdAt: '2026-05-31T13:41:54Z', data: { text: 'Hi Kfir — different intro message.' } },
      ];
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValueOnce(linkedInEvents);

      const result = await crmDb.getLeadEngagementCount('list1', 'lead1', 'user1');

      // 2 distinct sent messages, not 3.
      expect(result.total).toBe(2);
      expect(result.totalAllMessages).toBe(2);
    });
  });

  describe('getLeadEngagements - dedup', () => {
    beforeEach(() => {
      jest.spyOn(userDb, 'getUserById').mockResolvedValue({ userId: 'user1' } as any);
    });

    it('drops the synthetic send-time duplicate from the activity timeline', async () => {
      const linkedInEvents = [
        { eventId: 'linkedin_sent_1780236070619_lead1', eventType: 'linkedin.message.sent', createdAt: '2026-05-31T14:01:10Z', data: { text: 'Thanks for connecting. would love to learn more about your work.' } },
        { eventId: 'linkedin_msg_2-ABC', eventType: 'linkedin.message.sent', createdAt: '2026-05-31T14:01:10Z', data: { text: 'Thanks for connecting. would love to learn more about your work.' } },
      ];
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValueOnce(linkedInEvents);

      const result = await crmDb.getLeadEngagements('list1', 'lead1', 'user1');
      const linkedinEngagements = result.engagements.filter((e: any) =>
        String(e.eventType || '').startsWith('linkedin'));

      expect(linkedinEngagements).toHaveLength(1);
      // The surviving event is the synced one (stable provider id).
      expect(linkedinEngagements[0].eventData?.text).toContain('Thanks for connecting');
    });

    it('keeps a synthetic send event when the sync has not imported it yet', async () => {
      const linkedInEvents = [
        { eventId: 'linkedin_sent_1780236070619_lead1', eventType: 'linkedin.message.sent', createdAt: '2026-05-31T14:01:10Z', data: { text: 'Only sent, not yet synced.' } },
      ];
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValueOnce(linkedInEvents);

      const result = await crmDb.getLeadEngagements('list1', 'lead1', 'user1');
      const linkedinEngagements = result.engagements.filter((e: any) =>
        String(e.eventType || '').startsWith('linkedin'));

      expect(linkedinEngagements).toHaveLength(1);
    });
  });
});
