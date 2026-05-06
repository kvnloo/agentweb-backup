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
const mockSendInMail = jest.fn();
const mockGetMessagesWithContact = jest.fn();
const mockResolveProviderId = jest.fn();
const mockSearchPeople = jest.fn();
const mockResolveAccountId = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    sendInMail: (...args: any[]) => mockSendInMail(...args),
    getMessagesWithContact: (...args: any[]) => mockGetMessagesWithContact(...args),
    resolveProviderId: (...args: any[]) => mockResolveProviderId(...args),
    searchPeople: (...args: any[]) => mockSearchPeople(...args),
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
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

  describe('send-inmail', () => {
    const validArgs = {
      action: 'send-inmail',
      account_id: 'test-account-id',
      provider_id: 'li-provider-123',
      subject: 'Quick intro',
      message: 'Hi, I wanted to reach out about an opportunity.',
      list_id: 'list_test123',
      lead_id: 'lead_test456',
    };

    const lead = {
      leadId: 'lead_test456',
      listId: 'list_test123',
      linkedin: 'https://www.linkedin.com/in/johndoe/',
    };

    it('returns error when account is not owned by user', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'different-account' },
      ]);

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected to your profile');
      expect(mockSendInMail).not.toHaveBeenCalled();
    });

    it('returns error when subject is missing', async () => {
      const argsNoSubject = { ...validArgs, subject: undefined };

      const result = await service.linkedinOutreach('user-1', argsNoSubject);

      expect(result.success).toBe(false);
      expect(result.error).toContain('subject is required');
      expect(mockSendInMail).not.toHaveBeenCalled();
    });

    it('returns error when message is missing', async () => {
      const argsNoMessage = { ...validArgs, message: undefined };

      const result = await service.linkedinOutreach('user-1', argsNoMessage);

      expect(result.success).toBe(false);
      expect(result.error).toContain('message is required');
      expect(mockSendInMail).not.toHaveBeenCalled();
    });

    it('calls sendInMail with correct arguments', async () => {
      mockSendInMail.mockResolvedValue({ id: 'inmail-id-123' });
      mockGetLeadById.mockResolvedValue(lead);

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(true);
      expect(mockSendInMail).toHaveBeenCalledWith(
        'test-account-id',
        'li-provider-123',
        false, // isUrl=false because provider_id was passed
        'Quick intro',
        'Hi, I wanted to reach out about an opportunity.'
      );
    });

    it('persists sent InMail to AW-EmailEvents when list_id and lead_id are provided', async () => {
      mockSendInMail.mockResolvedValue({ id: 'inmail-id-123' });
      mockGetLeadById.mockResolvedValue(lead);

      await service.linkedinOutreach('user-1', validArgs);

      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledTimes(1);
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'linkedin_inmail_inmail-id-123',
          emailDomain: 'linkedin-list_test123',
          leadEmail: 'https://www.linkedin.com/in/johndoe/',
          eventType: 'linkedin.inmail.sent',
          text: 'Hi, I wanted to reach out about an opportunity.',
          senderId: 'test-account-id',
          messageProviderId: 'inmail-id-123',
        })
      );
    });

    it('does NOT persist InMail when list_id/lead_id are absent', async () => {
      const argsWithoutCrm = {
        action: 'send-inmail',
        account_id: 'test-account-id',
        provider_id: 'li-provider-123',
        subject: 'Quick intro',
        message: 'Hi there!',
      };
      mockSendInMail.mockResolvedValue({ id: 'inmail-id' });

      await service.linkedinOutreach('user-1', argsWithoutCrm);

      expect(mockAddLinkedInMessageEvent).not.toHaveBeenCalled();
      expect(mockUpdateLeadLinkedInSyncAt).not.toHaveBeenCalled();
    });

    it('falls back to timestamp-based ID when Unipile response has no id', async () => {
      mockSendInMail.mockResolvedValue({});
      mockGetLeadById.mockResolvedValue(lead);

      await service.linkedinOutreach('user-1', validArgs);

      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: expect.stringMatching(/^linkedin_inmail_sent_\d+$/),
          eventType: 'linkedin.inmail.sent',
        })
      );
    });
  });

  describe('disconnected account error handling', () => {
    function makeDisconnectedError() {
      const err = new Error('Disconnected account');
      (err as any).structuredError = {
        message: 'Disconnected account',
        code: 'errors/disconnected_account',
        status: 401,
        details: 'The account appears to be disconnected from the provider service.',
        classification: 'AUTH_ERROR',
      };
      return err;
    }

    it('returns actionable disconnected message for search-people with errors/disconnected_account code', async () => {
      mockSearchPeople.mockRejectedValue(makeDisconnectedError());

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn account disconnected');
      expect(result.error).toContain('disconnected from Unipile');
      expect(result.error).toContain('Common reasons');
      expect(result.error).toContain('Settings > Connected Accounts');
      expect(result.error).toContain('remove the connection');
    });

    it('returns actionable disconnected message when classification is AUTH_ERROR without specific code', async () => {
      const err = new Error('Unauthorized');
      (err as any).structuredError = {
        message: 'Unauthorized',
        code: 'errors/unauthorized',
        status: 401,
        classification: 'AUTH_ERROR',
      };
      mockSearchPeople.mockRejectedValue(err);

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn account disconnected');
      expect(result.error).toContain('Settings > Connected Accounts');
      expect(result.error).toContain('remove the connection');
    });

    it('returns generic error for non-auth errors (e.g. rate limit)', async () => {
      const err = new Error('Rate limit exceeded');
      (err as any).structuredError = {
        message: 'Rate limit exceeded',
        status: 429,
        classification: 'RATE_LIMIT_ERROR',
      };
      mockSearchPeople.mockRejectedValue(err);

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn outreach action failed');
      expect(result.error).toBe('Rate limit exceeded');
    });
  });

  describe('search-parameters', () => {
    const { setUnipileSearchParamServiceForTesting, __resetUnipileSearchParamServiceForTesting } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('../services/unipileSearchParamService');
    const mockResolve = jest.fn();

    beforeEach(() => {
      mockResolve.mockReset();
      __resetUnipileSearchParamServiceForTesting();
      setUnipileSearchParamServiceForTesting({ resolve: (...a: any[]) => mockResolve(...a) });
    });

    it('returns trimmed candidates with fromCache and source on success', async () => {
      mockResolve.mockResolvedValue({
        candidates: [
          { id: 'co_123', title: 'Acme Inc', subtitle: 'Software · 2k employees', extra: 'should-be-stripped' },
          { id: 'co_456', title: 'Acme Holdings', subtitle: 'Holding company' },
        ],
        fromCache: true,
        source: 'cache',
      });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        account_id: 'test-account-id',
        type: 'COMPANY',
        keywords: 'Acme',
      });

      expect(result.success).toBe(true);
      expect(mockResolve).toHaveBeenCalledWith('test-account-id', {
        type: 'COMPANY',
        keywords: 'Acme',
        limit: undefined,
      });
      expect(result.data).toEqual({
        candidates: [
          { id: 'co_123', title: 'Acme Inc', subtitle: 'Software · 2k employees' },
          { id: 'co_456', title: 'Acme Holdings', subtitle: 'Holding company' },
        ],
        fromCache: true,
        source: 'cache',
      });
    });

    it('passes through limit and surfaces source=api', async () => {
      mockResolve.mockResolvedValue({
        candidates: [{ id: 'loc_1', title: 'San Francisco' }],
        fromCache: false,
        source: 'api',
      });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        account_id: 'test-account-id',
        type: 'LOCATION',
        keywords: 'San Francisco',
        limit: 5,
      });

      expect(mockResolve).toHaveBeenCalledWith('test-account-id', {
        type: 'LOCATION',
        keywords: 'San Francisco',
        limit: 5,
      });
      expect(result.success).toBe(true);
      expect(result.data.fromCache).toBe(false);
      expect(result.data.source).toBe('api');
    });

    it('returns error when type is missing', async () => {
      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        account_id: 'test-account-id',
        keywords: 'Acme',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('type');
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('returns error when keywords is missing', async () => {
      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        account_id: 'test-account-id',
        type: 'COMPANY',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('keywords');
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('catches resolver errors and returns success: false', async () => {
      mockResolve.mockRejectedValue(new Error('Unipile boom'));

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        account_id: 'test-account-id',
        type: 'COMPANY',
        keywords: 'Acme',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unipile boom');
    });

    it('falls back to site-wide account_id when none is provided', async () => {
      mockResolveAccountId.mockResolvedValue('site-wide-account');
      mockResolve.mockResolvedValue({ candidates: [], fromCache: false, source: 'api' });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        type: 'COMPANY',
        keywords: 'Acme',
      });

      expect(mockResolveAccountId).toHaveBeenCalledWith('user-1');
      expect(mockResolve).toHaveBeenCalledWith('site-wide-account', expect.any(Object));
      expect(result.success).toBe(true);
    });
  });
});
