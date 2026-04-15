/**
 * Unit tests for AgentModeService - LinkedIn Outreach (linkedinOutreach)
 * Tests cover: send-message with CRM persistence, update-conversation-history
 */

// Mock unipile-node-sdk
jest.mock('unipile-node-sdk', () => ({
  UnipileClient: jest.fn().mockImplementation(() => ({})),
}), { virtual: true });

// Mock AWS / secretsManager
jest.mock('../utils/secretsManager', () => ({
  getUnipileCredentials: jest.fn().mockResolvedValue({ dsn: 'https://api.unipile.com', apiKey: 'test-key' }),
  getJwtSecret: jest.fn().mockResolvedValue('test-jwt-secret'),
}));

// Mock connectedAccountsDb
const mockGetAccountsByUserId = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: (...args: any[]) => mockGetAccountsByUserId(...args),
}));

// Mock linkedInOutreachService
const mockSendMessage = jest.fn();
const mockGetMessagesWithContact = jest.fn();
const mockResolveProviderId = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    getMessagesWithContact: (...args: any[]) => mockGetMessagesWithContact(...args),
    resolveProviderId: (...args: any[]) => mockResolveProviderId(...args),
  },
}));

// Mock emailEventsDb
const mockAddLinkedInMessageEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    addLinkedInMessageEvent: (...args: any[]) => mockAddLinkedInMessageEvent(...args),
  },
}));

// Mock crmDb
const mockGetLeadById = jest.fn();
const mockUpdateLeadLinkedInSyncAt = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...args: any[]) => mockGetLeadById(...args),
    updateLeadLinkedInSyncAt: (...args: any[]) => mockUpdateLeadLinkedInSyncAt(...args),
  },
  userDb: {
    getUserById: jest.fn().mockResolvedValue(null),
  },
}));

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService - LinkedIn Outreach', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();

    // Default: user owns the account
    mockGetAccountsByUserId.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id' },
    ]);
  });

  describe('send-message', () => {
    const validArgs = {
      action: 'send-message',
      account_id: 'test-account-id',
      provider_id: 'li-provider-123',
      message: 'Hello, let us connect!',
      list_id: 'list_test123',
      lead_id: 'lead_test456',
    };

    const freshLead = {
      leadId: 'lead_test456',
      listId: 'list_test123',
      linkedin: 'https://www.linkedin.com/in/johndoe/',
      linkedinMessageSyncAt: new Date().toISOString(), // freshly synced
    };

    it('persists sent message to AW-EmailEvents when list_id and lead_id are provided', async () => {
      mockGetLeadById.mockResolvedValue(freshLead);
      mockSendMessage.mockResolvedValue({ id: 'msg-unipile-id-123' });

      await service.linkedinOutreach('user-1', validArgs);

      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(1);
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'linkedin_msg_msg-unipile-id-123',
          emailDomain: 'linkedin-list_test123',
          leadEmail: 'https://www.linkedin.com/in/johndoe/',
          eventType: 'linkedin.message.sent',
          text: 'Hello, let us connect!',
          senderId: 'test-account-id',
          messageProviderId: 'msg-unipile-id-123',
        })
      );
    });

    it('updates linkedinMessageSyncAt after persisting sent message', async () => {
      mockGetLeadById.mockResolvedValue(freshLead);
      mockSendMessage.mockResolvedValue({ id: 'msg-unipile-id-123' });

      await service.linkedinOutreach('user-1', validArgs);

      expect(mockUpdateLeadLinkedInSyncAt).toHaveBeenCalledWith(
        'list_test123',
        'lead_test456',
        expect.any(String)
      );
    });

    it('falls back to timestamp-based message ID when Unipile response has no id', async () => {
      mockGetLeadById.mockResolvedValue(freshLead);
      mockSendMessage.mockResolvedValue({}); // no id in response

      await service.linkedinOutreach('user-1', validArgs);

      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: expect.stringMatching(/^linkedin_msg_sent_\d+$/),
          eventType: 'linkedin.message.sent',
        })
      );
    });

    it('does NOT persist message when list_id/lead_id are absent', async () => {
      const argsWithoutCrm = {
        action: 'send-message',
        account_id: 'test-account-id',
        provider_id: 'li-provider-123',
        message: 'Hello!',
        // no list_id or lead_id
      };
      mockSendMessage.mockResolvedValue({ id: 'msg-id' });

      await service.linkedinOutreach('user-1', argsWithoutCrm);

      expect(mockAddLinkedInMessageEvent).not.toHaveBeenCalled();
      expect(mockUpdateLeadLinkedInSyncAt).not.toHaveBeenCalled();
    });

    it('does NOT persist message when lead has no linkedin URL', async () => {
      mockGetLeadById.mockResolvedValue({ ...freshLead, linkedin: undefined });
      mockSendMessage.mockResolvedValue({ id: 'msg-id' });

      await service.linkedinOutreach('user-1', validArgs);

      expect(mockAddLinkedInMessageEvent).not.toHaveBeenCalled();
    });

    it('blocks send and returns error when sync is stale (>24h)', async () => {
      const staleLead = {
        ...freshLead,
        linkedinMessageSyncAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      };
      mockGetLeadById.mockResolvedValue(staleLead);

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(false);
      expect(result.requiresSync).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('blocks send and returns error when sync has never been done', async () => {
      const unsyncedLead = { ...freshLead, linkedinMessageSyncAt: undefined };
      mockGetLeadById.mockResolvedValue(unsyncedLead);

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(false);
      expect(result.requiresSync).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('returns error when account is not owned by user', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'different-account' },
      ]);

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected to your profile');
    });
  });

  describe('update-conversation-history', () => {
    const updateArgs = {
      action: 'update-conversation-history',
      account_id: 'test-account-id',
      provider_id: 'li-provider-123',
      list_id: 'list_test123',
      lead_id: 'lead_test456',
    };

    const lead = {
      leadId: 'lead_test456',
      listId: 'list_test123',
      linkedin: 'https://www.linkedin.com/in/johndoe/',
    };

    it('returns synced: 0 and stamps syncAt when no message history exists', async () => {
      mockGetLeadById.mockResolvedValue(lead);
      mockGetMessagesWithContact.mockResolvedValue([]); // no messages

      const result = await service.linkedinOutreach('user-1', updateArgs);

      expect(result.success).toBe(true);
      expect(result.data.synced).toBe(0);
      expect(mockUpdateLeadLinkedInSyncAt).toHaveBeenCalledWith(
        'list_test123',
        'lead_test456',
        expect.any(String)
      );
      expect(mockAddLinkedInMessageEvent).not.toHaveBeenCalled();
    });

    it('syncs messages and stamps syncAt when message history exists', async () => {
      mockGetLeadById.mockResolvedValue(lead);
      mockGetMessagesWithContact.mockResolvedValue([
        {
          id: 'msg-1',
          provider_id: 'prov-1',
          text: 'Hi there!',
          is_sender: 1,
          is_event: 0,
          sender_id: 'sender-1',
          timestamp: '2026-04-01T10:00:00.000Z',
        },
        {
          id: 'msg-2',
          provider_id: 'prov-2',
          text: 'Hello back!',
          is_sender: 0,
          is_event: 0,
          sender_id: 'sender-2',
          timestamp: '2026-04-01T10:01:00.000Z',
        },
      ]);

      const result = await service.linkedinOutreach('user-1', updateArgs);

      expect(result.success).toBe(true);
      expect(result.data.synced).toBe(2);
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(2);
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'linkedin_msg_msg-1',
          eventType: 'linkedin.message.sent',
          text: 'Hi there!',
        })
      );
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'linkedin_msg_msg-2',
          eventType: 'linkedin.message.received',
          text: 'Hello back!',
        })
      );
    });

    it('stores all messages returned by getMessagesWithContact (filtering is done in the service)', async () => {
      // getMessagesWithContact already filters is_event=1 internally — we get pre-filtered results
      mockGetLeadById.mockResolvedValue(lead);
      mockGetMessagesWithContact.mockResolvedValue([
        { id: 'msg-1', provider_id: 'prov-1', text: 'Real message', is_sender: 1, is_event: 0, sender_id: 's1', timestamp: '2026-04-01T10:00:00.000Z' },
      ]);

      const result = await service.linkedinOutreach('user-1', updateArgs);

      expect(result.data.synced).toBe(1);
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(1);
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'linkedin_msg_msg-1' })
      );
    });

    it('throws error when lead has no linkedin URL', async () => {
      mockGetLeadById.mockResolvedValue({ ...lead, linkedin: undefined });

      const result = await service.linkedinOutreach('user-1', updateArgs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('LinkedIn URL');
    });
  });
});
