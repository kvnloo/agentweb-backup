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
const mockGetAccountsByUserIdIncludingOrgShared = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: (...args: any[]) => mockGetAccountsByUserId(...args),
  getAccountsByUserIdIncludingOrgShared: (...args: any[]) => mockGetAccountsByUserIdIncludingOrgShared(...args),
}));

// Mock linkedInOutreachService
const mockSendMessage = jest.fn();
const mockGetLinkedInProfile = jest.fn();
const mockSendInMail = jest.fn();
const mockSendInvitation = jest.fn();
const mockIsUnderInvitationCooldown = jest.fn((..._args: any[]) => false);
const mockGetMessagesWithContact = jest.fn();
const mockResolveProviderId = jest.fn();
const mockSearchPeople = jest.fn();
const mockResolveAccountId = jest.fn();
const mockResolveAccountIdWithSource = jest.fn();
const mockListUserOwnedUnipileAccountIds = jest.fn();
const mockGetInviteCharLimitForAccount = jest.fn().mockResolvedValue(200);
const mockIsAccountConnected = jest.fn().mockResolvedValue(true);
const mockProbeAccountSession = jest.fn().mockResolvedValue('connected');
const mockProbeSearchCapability = jest.fn().mockResolvedValue('ok');
const mockClearStatusCache = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    getLinkedInProfile: (...args: any[]) => mockGetLinkedInProfile(...args),
    sendInMail: (...args: any[]) => mockSendInMail(...args),
    sendInvitation: (...args: any[]) => mockSendInvitation(...args),
    // ENG-126 breaker check — must be present or send-invite throws before pacing.
    isUnderInvitationCooldown: (...args: any[]) => mockIsUnderInvitationCooldown(...args),
    getMessagesWithContact: (...args: any[]) => mockGetMessagesWithContact(...args),
    resolveProviderId: (...args: any[]) => mockResolveProviderId(...args),
    searchPeople: (...args: any[]) => mockSearchPeople(...args),
    resolveAccountId: (...args: any[]) => mockResolveAccountId(...args),
    resolveAccountIdWithSource: (...args: any[]) => mockResolveAccountIdWithSource(...args),
    listUserOwnedUnipileAccountIds: (...args: any[]) => mockListUserOwnedUnipileAccountIds(...args),
    getInviteCharLimitForAccount: (...args: any[]) => mockGetInviteCharLimitForAccount(...args),
    isAccountConnected: (...args: any[]) => mockIsAccountConnected(...args),
    probeAccountSession: (...args: any[]) => mockProbeAccountSession(...args),
    probeSearchCapability: (...args: any[]) => mockProbeSearchCapability(...args),
    clearStatusCache: (...args: any[]) => mockClearStatusCache(...args),
  },
}));

// Mock emailEventsDb
const mockAddLinkedInMessageEvent = jest.fn().mockResolvedValue(undefined);
const mockGetEventsByEmailDomainAndLeadEmail = jest.fn().mockResolvedValue([]);
jest.mock('../services/emailEventsDb', () => ({
  emailEventsDb: {
    addLinkedInMessageEvent: (...args: any[]) => mockAddLinkedInMessageEvent(...args),
    getEventsByEmailDomainAndLeadEmail: (...args: any[]) => mockGetEventsByEmailDomainAndLeadEmail(...args),
  },
}));

// Mock crmDb
const mockGetLeadById = jest.fn();
const mockUpdateLead = jest.fn().mockResolvedValue(undefined);
const mockUpdateLeadLinkedInSyncAt = jest.fn().mockResolvedValue(undefined);
const mockGetLeadListById = jest.fn();
const mockGetUserById = jest.fn().mockResolvedValue(null);
const mockGetOrgById = jest.fn();
jest.mock('../services/db', () => ({
  crmDb: {
    getLeadById: (...args: any[]) => mockGetLeadById(...args),
    updateLead: (...args: any[]) => mockUpdateLead(...args),
    updateLeadLinkedInSyncAt: (...args: any[]) => mockUpdateLeadLinkedInSyncAt(...args),
    getLeadListById: (...args: any[]) => mockGetLeadListById(...args),
  },
  userDb: {
    getUserById: (...args: any[]) => mockGetUserById(...args),
  },
  orgDb: {
    getOrgById: (...args: any[]) => mockGetOrgById(...args),
  },
}));

// Mock the CRM invite mirror (ENG-787) so we can assert whether the send-invite
// path reconciles the invitee — gated on the list-access check below.
const mockMirrorLinkedInInviteToCrm = jest.fn().mockResolvedValue({ leadId: 'lead_x', listId: 'list_owned', created: true, engagementLogged: true });
const mockResolveListIdForAccount = jest.fn().mockResolvedValue(null);
jest.mock('../services/linkedInInviteCrmMirror', () => ({
  mirrorLinkedInInviteToCrm: (...args: any[]) => mockMirrorLinkedInInviteToCrm(...args),
  resolveListIdForAccount: (...args: any[]) => mockResolveListIdForAccount(...args),
}));

// Mock unipileSentInvitationsDb (ENG-182 pre-invite dedup cache). The pre-check
// uses the publicProfileUrl GSI getter (case-robust, matches the CRM path).
const mockGetSentInvitationByProfileUrlAndAccount = jest.fn().mockResolvedValue(null);
const mockUpsertSentInvitation = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/unipileSentInvitationsDb', () => ({
  getSentInvitationByProfileUrlAndAccount: (...args: any[]) => mockGetSentInvitationByProfileUrlAndAccount(...args),
  upsertSentInvitation: (...args: any[]) => mockUpsertSentInvitation(...args),
}));

// Mock unipileConnectionsDb (normalizeLinkedInUrl used by the write-through upsert)
jest.mock('../services/unipileConnectionsDb', () => ({
  normalizeLinkedInUrl: (url: string) => (url ? url.trim().toLowerCase().replace(/\/?$/, '/') : ''),
}));

import { AgentModeService } from '../services/agentModeService';
import { __resetWritePacerForTests } from '../services/linkedInWritePacer';

describe('AgentModeService - LinkedIn Outreach', () => {
  let service: AgentModeService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();

    // Default: user owns the account (or it is org-shared)
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id' },
    ]);

    // Default: the Unipile session is live. clearAllMocks() does not reset
    // implementations, so re-assert it here or a test that simulates a dead
    // session would leak that state into every test after it.
    mockIsAccountConnected.mockResolvedValue(true);
    mockProbeAccountSession.mockResolvedValue('connected');
    // Default: the account CAN search, so a zero-result search is a real
    // no-match and the ENG-975 guard stays out of the way.
    mockProbeSearchCapability.mockResolvedValue('ok');
    // Default: an explicitly-passed account_id is the user's own (ENG-1198
    // usedSharedAccount determination for read actions).
    mockListUserOwnedUnipileAccountIds.mockResolvedValue(['test-account-id']);
    // ENG-1026 Greptile P1 ("agent-tool authorization gap"): send-message's
    // CRM-linked checks (sync gate, duplicate check, identity check) now
    // require list access before reading a lead. Every test in this file
    // that supplies list_id/lead_id calls as user-1 against list_test123 and
    // expects those checks to run — default to "user-1 owns list_test123"
    // so existing tests keep passing; the dedicated access-denial tests
    // override this per-call.
    mockGetLeadListById.mockResolvedValue({ id: 'list_test123', userId: 'user-1' });
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

    it('blocks duplicate send when identical message text was already sent to this lead', async () => {
      mockGetLeadById.mockResolvedValue(freshLead);
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValue([
        {
          eventType: 'linkedin.message.sent',
          createdAt: '2026-05-15T09:03:05.000Z',
          data: { text: 'Hello, let us connect!' }, // exact same text as validArgs.message
        },
      ]);

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(false);
      expect(result.duplicate).toBe(true);
      expect(result.error).toContain('already sent');
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('allows send when prior message exists but with different text (new follow-up)', async () => {
      mockGetLeadById.mockResolvedValue(freshLead);
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValue([
        {
          eventType: 'linkedin.message.sent',
          createdAt: '2026-05-14T14:44:00.000Z',
          data: { text: 'Hey Steve — scaling consumer brands is serious work. Would love to connect.' },
        },
      ]);
      mockSendMessage.mockResolvedValue({ id: 'msg-followup-id' });

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('allows send when prior events exist but are only received messages (not sent)', async () => {
      mockGetLeadById.mockResolvedValue(freshLead);
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValue([
        {
          eventType: 'linkedin.message.received',
          createdAt: '2026-05-14T14:44:00.000Z',
          data: { text: 'Hello, let us connect!' }, // same text but received, not sent
        },
      ]);
      mockSendMessage.mockResolvedValue({ id: 'msg-id' });

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('blocks send when dedup check throws (spam-safe: error is surfaced, not swallowed)', async () => {
      mockGetLeadById.mockResolvedValue(freshLead);
      mockGetEventsByEmailDomainAndLeadEmail.mockRejectedValue(new Error('DynamoDB timeout'));

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(false);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('returns error when account is not owned or org-shared', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'different-account' },
      ]);

      const result = await service.linkedinOutreach('user-1', validArgs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not connected to your profile');
    });
  });

  describe('send-invite dedup (ENG-182)', () => {
    const inviteArgs = {
      action: 'send-invite',
      account_id: 'test-account-id',
      profile_url: 'https://www.linkedin.com/in/chang-liu/',
      message: 'Great to connect!',
    };

    it('skips the send (no quota used) when a pending invitation already exists in the cache', async () => {
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValueOnce({
        accountId: 'test-account-id',
        invitedUserPublicId: 'chang-liu',
        sentAt: '2026-07-01T00:00:00.000Z',
      });

      const result = await service.linkedinOutreach('user-1', inviteArgs);

      expect(result.success).toBe(true);
      expect(result.alreadyInvited).toBe(true);
      expect(mockSendInvitation).not.toHaveBeenCalled();
      // Must look up by a CANONICAL /in/{publicId}/ URL parsed from the profile URL,
      // scoped to the account (the getter itself lowercases via normalizeLinkedInUrl).
      expect(mockGetSentInvitationByProfileUrlAndAccount).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/chang-liu/',
        'test-account-id',
      );
    });

    it('canonicalizes the lookup URL, stripping query params / trailing slash', async () => {
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValueOnce({ sentAt: null });

      const result = await service.linkedinOutreach('user-1', {
        ...inviteArgs,
        profile_url: 'https://www.linkedin.com/in/chang-liu?miniProfileUrn=urn%3Ali%3Aabc',
      });

      expect(result.alreadyInvited).toBe(true);
      // Query string must be stripped so it matches the cron's clean stored key.
      expect(mockGetSentInvitationByProfileUrlAndAccount).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/chang-liu/',
        'test-account-id',
      );
      expect(mockSendInvitation).not.toHaveBeenCalled();
    });

    it('is case-insensitive on the public id (canonical URL is matched via the lowercasing GSI getter)', async () => {
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValueOnce({ sentAt: null });

      const result = await service.linkedinOutreach('user-1', {
        ...inviteArgs,
        profile_url: 'https://www.linkedin.com/in/Chang-Liu/',
      });

      expect(result.alreadyInvited).toBe(true);
      // Public id is lowercased when building the canonical URL.
      expect(mockGetSentInvitationByProfileUrlAndAccount).toHaveBeenCalledWith(
        'https://www.linkedin.com/in/chang-liu/',
        'test-account-id',
      );
    });

    it('sends and writes the invite through to the cache when no pending invitation exists', async () => {
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValueOnce(null);
      mockSendInvitation.mockResolvedValueOnce({ id: 'inv-xyz' });

      const result = await service.linkedinOutreach('user-1', inviteArgs);

      expect(result.success).toBe(true);
      expect(result.alreadyInvited).toBeUndefined();
      expect(mockSendInvitation).toHaveBeenCalledTimes(1);
      // Write-through with the SAME lowercased publicProfileUrl the GSI reads, so a
      // subsequent run (before the next sync cron) dedups.
      expect(mockUpsertSentInvitation).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'test-account-id',
          invitedUserPublicId: 'chang-liu',
          publicProfileUrl: 'https://www.linkedin.com/in/chang-liu/',
          invitationId: 'inv-xyz',
        })
      );
    });

    it('does NOT dedup or cache when inviting by raw provider_id (cache is keyed by public id)', async () => {
      mockSendInvitation.mockResolvedValueOnce({ id: 'inv-1' });

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        provider_id: 'li-provider-999',
        message: 'Hi',
      });

      expect(result.success).toBe(true);
      expect(mockGetSentInvitationByProfileUrlAndAccount).not.toHaveBeenCalled();
      expect(mockUpsertSentInvitation).not.toHaveBeenCalled();
      expect(mockSendInvitation).toHaveBeenCalledTimes(1);
    });

    it('still sends when the cache lookup throws (dedup is best-effort, never blocks a genuine invite)', async () => {
      mockGetSentInvitationByProfileUrlAndAccount.mockRejectedValueOnce(new Error('dynamo down'));
      mockSendInvitation.mockResolvedValueOnce({ id: 'inv-2' });

      const result = await service.linkedinOutreach('user-1', inviteArgs);

      expect(result.success).toBe(true);
      expect(result.alreadyInvited).toBeUndefined();
      expect(mockSendInvitation).toHaveBeenCalledTimes(1);
    });

    it('does not fail the invite when the write-through cache upsert throws', async () => {
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValueOnce(null);
      mockSendInvitation.mockResolvedValueOnce({ id: 'inv-3' });
      mockUpsertSentInvitation.mockRejectedValueOnce(new Error('dynamo down'));

      const result = await service.linkedinOutreach('user-1', inviteArgs);

      expect(result.success).toBe(true);
      expect(mockSendInvitation).toHaveBeenCalledTimes(1);
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
      // eventId must be keyed on stable provider_id, not ephemeral msg.id
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'linkedin_msg_prov-1',
          eventType: 'linkedin.message.sent',
          text: 'Hi there!',
        })
      );
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: 'linkedin_msg_prov-2',
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
      // eventId must use stable provider_id (prov-1), not ephemeral msg.id (msg-1)
      expect(mockAddLinkedInMessageEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'linkedin_msg_prov-1' })
      );
    });

    it('throws error when lead has no linkedin URL', async () => {
      mockGetLeadById.mockResolvedValue({ ...lead, linkedin: undefined });

      const result = await service.linkedinOutreach('user-1', updateArgs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('LinkedIn URL');
    });

    it('passes account_id to getMessagesWithContact so Unipile can identify the sender side', async () => {
      mockGetLeadById.mockResolvedValue(lead);
      mockGetMessagesWithContact.mockResolvedValue([]);

      await service.linkedinOutreach('user-1', updateArgs);

      // account_id must be passed so Unipile knows which account is "us" and sets is_sender correctly
      expect(mockGetMessagesWithContact).toHaveBeenCalledWith(
        expect.any(String), // providerId
        'test-account-id',  // account_id from args
      );
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

    it('returns error when account is not owned or org-shared', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
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

  // ENG-281. A Unipile LinkedIn session can die while the connection record still
  // exists. list_connected_accounts already reports is_active:false for that state,
  // but linkedinOutreach only discovered it *reactively* — it fired the real Unipile
  // call, waited for a 401, and translated the error. Every action on a dead account
  // therefore burned a full round-trip before failing, and a scheduled/automated run
  // repeated that per recipient. The liveness probe already existed
  // (isAccountConnected, 10-min cached, timeout-bounded) and was already applied to
  // the *fallback* resolution path — it just was never applied when the caller passed
  // an explicit account_id, which is the normal path after list_connected_accounts.
  describe('ENG-281: disconnected-account preflight', () => {
    it('fails fast on a read action without calling Unipile at all', async () => {
      mockProbeAccountSession.mockResolvedValue('disconnected');

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn account disconnected');
      expect(mockProbeAccountSession).toHaveBeenCalledWith('test-account-id');
      // The whole point: the doomed outbound call is never made.
      expect(mockSearchPeople).not.toHaveBeenCalled();
    });

    it('fails fast on a write action before any invite is attempted', async () => {
      mockProbeAccountSession.mockResolvedValue('disconnected');

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        profile_url: 'https://www.linkedin.com/in/someone',
        message: 'hello',
      });

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn account disconnected');
      expect(mockSendInvitation).not.toHaveBeenCalled();
    });

    it('gives the same actionable reconnect guidance as the reactive path', async () => {
      mockProbeAccountSession.mockResolvedValue('disconnected');

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(result.error).toContain('disconnected from Unipile');
      expect(result.error).toContain('Common reasons');
      expect(result.error).toContain('Settings > Connected Accounts');
      expect(result.error).toContain('remove the connection');
    });

    // Greptile P1 on 4b933aeec: the preflight originally blocked on
    // `!isAccountConnected`, which is false for ANY probe failure — including a
    // timeout or a 5xx that says nothing about session validity. Because the probe
    // result is cached for 10 minutes, one blip would suppress a HEALTHY account
    // behind a false "reconnect your LinkedIn" prompt for the whole window. That is
    // a worse failure than the late 401 this preflight exists to remove, so an
    // indeterminate probe must fall through to the real call.
    it('does NOT block when the probe is indeterminate (transient failure, not a dead session)', async () => {
      mockProbeAccountSession.mockResolvedValue('unknown');
      mockSearchPeople.mockResolvedValue({ items: [] });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      // The real call happened; no disconnect response was substituted.
      expect(mockSearchPeople).toHaveBeenCalled();
      expect(result.message).not.toBe('LinkedIn account disconnected');
    });

    it('still surfaces a genuine 401 via the reactive handler when the preflight was indeterminate', async () => {
      mockProbeAccountSession.mockResolvedValue('unknown');
      const err = new Error('Disconnected account');
      (err as any).structuredError = {
        message: 'Disconnected account',
        code: 'errors/disconnected_account',
        status: 401,
        classification: 'AUTH_ERROR',
      };
      mockSearchPeople.mockRejectedValue(err);

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      // Proceeding on 'unknown' does not lose the disconnect signal — the reactive
      // path remains the backstop and returns the identical guidance.
      expect(mockSearchPeople).toHaveBeenCalled();
      expect(result.message).toBe('LinkedIn account disconnected');
      expect(result.error).toContain('disconnected from Unipile');
    });

    it('does not interfere with a live account', async () => {
      mockIsAccountConnected.mockResolvedValue(true);
      mockProbeAccountSession.mockResolvedValue('connected');
      mockSearchPeople.mockResolvedValue({ items: [] });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(result.success).not.toBe(false);
      expect(mockSearchPeople).toHaveBeenCalled();
    });

    it('reports the unconnected-account error, not the disconnect error, when no account exists', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: null, usedSharedAccount: false });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        keywords: 'stealth founder',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No LinkedIn account is connected');
      // No account id to probe — the probe must not run at all.
      expect(mockProbeAccountSession).not.toHaveBeenCalled();
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

    // ENG-281: the preflight probe is cached for 10 minutes, so a session that dies
    // mid-window would keep passing preflight until the cache expired. When the
    // reactive path proves it is dead, drop the cache entry immediately.
    it('invalidates the cached liveness status so the next call preflights correctly', async () => {
      mockSearchPeople.mockRejectedValue(makeDisconnectedError());

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(mockClearStatusCache).toHaveBeenCalledWith('test-account-id');
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

    // The handler used to reject calls without keywords/search_url/cursor.
    // Now that linkedInOutreachService.searchPeople auto-synthesizes keywords
    // from the most-specific structured filter, the early-validation gate must
    // accept any of: keywords, search_url, cursor, OR any structured filter
    // (title / company / location / industry / school + their *_id companions).
    it('accepts a filter-only call (title + company, no keywords) and forwards to searchPeople', async () => {
      mockSearchPeople.mockResolvedValue({ items: [{ provider_id: 'p1', first_name: 'A', last_name: 'B' }], cursor: null });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        title: 'CTO',
        company: 'Microsoft',
      });

      expect(result.success).toBe(true);
      expect(mockSearchPeople).toHaveBeenCalledWith('test-account-id', expect.objectContaining({
        title: 'CTO',
        company: 'Microsoft',
      }));
    });

    it('accepts a school-only call', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        school: 'Stanford',
      });

      expect(result.success).toBe(true);
      expect(mockSearchPeople).toHaveBeenCalled();
    });

    it('rejects a call with no keywords AND no filters at all', async () => {
      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
      });

      expect(result.success).toBe(false);
      expect(result.error || '').toMatch(/keyword|filter|search_url|cursor/i);
      expect(mockSearchPeople).not.toHaveBeenCalled();
    });
  });

  // ENG-975 — a people search that returns zero because the ACCOUNT can no
  // longer search looks byte-identical to one that returns zero because nobody
  // matches. Reported in production: every query on one account came back
  // `success: true, items: [], paging.total_count: 0` while get-profile and
  // list-sent-invitations on the SAME account worked, so the agent read it as
  // "no one matches", tried six query variants, and reported a false empty.
  describe('ENG-975: zero-result search is not silently reported as "no matches"', () => {
    it('returns an explicit failure when the account can no longer search at all', async () => {
      mockSearchPeople.mockResolvedValue({
        object: 'LinkedinSearch',
        items: [],
        paging: { start: 0, page_count: 0, total_count: 0 },
        cursor: null,
      });
      mockProbeSearchCapability.mockResolvedValue('degraded');

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'CMO healthtech',
      });

      expect(mockProbeSearchCapability).toHaveBeenCalledWith('test-account-id');
      expect(result.success).toBe(false);
      expect(result.searchUnavailable).toBe(true);
      expect(result.message).toBe('LinkedIn people search is unavailable');
    });

    it('tells the agent to stop trying query variants and to report the outage', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
      mockProbeSearchCapability.mockResolvedValue('degraded');

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'marketing',
      });

      expect(result.error).toContain('DO NOT');
      expect(result.error).toMatch(/is not "no one matches your filters"/i);
    });

    it('leaves a genuine narrow no-match as a successful empty result', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
      mockProbeSearchCapability.mockResolvedValue('ok');

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'underwater basket weaver at Acme',
      });

      expect(result.success).toBe(true);
      expect(result.data.items).toEqual([]);
    });

    it('does not block on an indeterminate probe', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
      mockProbeSearchCapability.mockResolvedValue('unknown');

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'marketing',
      });

      expect(result.success).toBe(true);
    });

    it('does not probe when the search returned people', async () => {
      mockSearchPeople.mockResolvedValue({ items: [{ provider_id: 'p-1' }], cursor: 'c1' });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'marketing',
      });

      expect(result.success).toBe(true);
      expect(mockProbeSearchCapability).not.toHaveBeenCalled();
    });

    // Paging past the last page legitimately returns zero — that is exhaustion,
    // not an outage, and must not cost a probe or raise a false alarm.
    it('does not probe when a paginated continuation runs out of results', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'marketing',
        cursor: 'page-4-cursor',
      });

      expect(result.success).toBe(true);
      expect(mockProbeSearchCapability).not.toHaveBeenCalled();
    });

    // The same outage empties entity resolution too: the reported session got
    // `candidates: []` for INDUSTRY 'hospital health care'.
    it('surfaces the outage for search-parameters instead of an empty candidate list', async () => {
      const { setUnipileSearchParamServiceForTesting, __resetUnipileSearchParamServiceForTesting } =
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('../services/unipileSearchParamService');
      __resetUnipileSearchParamServiceForTesting();
      setUnipileSearchParamServiceForTesting({
        resolve: jest.fn().mockResolvedValue({ candidates: [], fromCache: true, source: 'cache' }),
      });
      mockProbeSearchCapability.mockResolvedValue('degraded');

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        account_id: 'test-account-id',
        type: 'INDUSTRY',
        keywords: 'hospital health care',
      });

      expect(result.success).toBe(false);
      expect(result.searchUnavailable).toBe(true);
      __resetUnipileSearchParamServiceForTesting();
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
        usedSharedAccount: false,
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
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'site-wide-account', usedSharedAccount: true });
      mockResolve.mockResolvedValue({ candidates: [], fromCache: false, source: 'api' });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-parameters',
        type: 'COMPANY',
        keywords: 'Acme',
      });

      expect(mockResolveAccountIdWithSource).toHaveBeenCalledWith('user-1');
      expect(mockResolve).toHaveBeenCalledWith('site-wide-account', expect.any(Object));
      expect(result.success).toBe(true);
    });
  });

  describe('send-invite', () => {
    it('returns success when sendInvitation resolves', async () => {
      mockSendInvitation.mockResolvedValue({ id: 'invite-123' });
      mockGetInviteCharLimitForAccount.mockResolvedValue(200);

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        provider_id: 'provider-abc',
        message: 'Hi, let us connect!',
      });

      expect(result.success).toBe(true);
      // The per-account invite char limit is resolved and passed through to sendInvitation.
      expect(mockGetInviteCharLimitForAccount).toHaveBeenCalledWith('user-1', 'test-account-id');
      expect(mockSendInvitation).toHaveBeenCalledWith(
        'test-account-id',
        'provider-abc',
        false,
        'Hi, let us connect!',
        200,
        { onNoteQuota: 'skip' }
      );
    });

    // ENG-213: default policy is to HOLD (not silently drop the note) when the
    // account's monthly personalized-note quota is spent.
    it("defaults onNoteQuota to 'skip' (hold) when on_note_quota is not provided", async () => {
      mockSendInvitation.mockResolvedValue({ id: 'invite-123' });
      mockGetInviteCharLimitForAccount.mockResolvedValue(200);

      await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        provider_id: 'provider-abc',
        message: 'Hi, let us connect!',
      });

      expect(mockSendInvitation).toHaveBeenCalledWith(
        'test-account-id', 'provider-abc', false, 'Hi, let us connect!', 200, { onNoteQuota: 'skip' },
      );
    });

    it('returns a requiresDecision gate (does not decide) when the note quota is held', async () => {
      mockGetInviteCharLimitForAccount.mockResolvedValue(200);
      const held: any = new Error('LinkedIn note quota reached — the personalized note could not be attached.');
      held.noteQuotaExceeded = true;
      mockSendInvitation.mockRejectedValue(held);

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        provider_id: 'provider-abc',
        message: 'A deliberately personalised note',
      });

      expect(result.success).toBe(false);
      expect(result.requiresDecision).toBe(true);
      expect(result.noteQuotaExceeded).toBe(true);
      expect(result.error).toMatch(/without the note|skip/i);
    });

    it("re-call with on_note_quota='send_without_note' authorizes a note-less send", async () => {
      mockGetInviteCharLimitForAccount.mockResolvedValue(200);
      mockSendInvitation.mockResolvedValue({ id: 'invite-123', note_dropped: true });

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        provider_id: 'provider-abc',
        message: 'A personalised note',
        on_note_quota: 'send_without_note',
      });

      expect(result.success).toBe(true);
      expect(mockSendInvitation).toHaveBeenCalledWith(
        'test-account-id', 'provider-abc', false, 'A personalised note', 200, { onNoteQuota: 'send_without_note' },
      );
    });

    it('returns success:false with error message when sendInvitation rejects', async () => {
      mockGetInviteCharLimitForAccount.mockResolvedValue(200);
      mockSendInvitation.mockRejectedValue(
        new Error('Invitation message is too long (350 characters). LinkedIn limits invitation notes to 200 characters for this account. Please shorten the message and retry.')
      );

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        provider_id: 'provider-abc',
        message: 'a'.repeat(350),
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('too long');
    });

    // ENG-126: LinkedIn returns "Cannot resend yet" for send-invite on EVERY
    // recipient — even fresh ones — once the account hits its invitation cap.
    // Surfaced verbatim, this reads like a per-recipient cooldown, so the agent
    // moves to the next recipient and repeats, burning 10+ attempts per session.
    // The handler must flag it as the account-level throttle it is and tell the
    // agent to stop and report proactively.
    describe('account-level invitation cooldown ("Cannot resend yet")', () => {
      function makeCooldownError() {
        const err = new Error('Cannot resend yet');
        (err as any).structuredError = {
          message: 'Cannot resend yet',
          status: 422,
          classification: 'VALIDATION_ERROR',
        };
        return err;
      }

      it('flags an account-level throttle instead of surfacing the raw per-recipient error', async () => {
        mockGetInviteCharLimitForAccount.mockResolvedValue(200);
        mockSendInvitation.mockRejectedValue(makeCooldownError());

        const result = await service.linkedinOutreach('user-1', {
          action: 'send-invite',
          account_id: 'test-account-id',
          provider_id: 'provider-abc',
          message: 'Hi, let us connect!',
        });

        expect(result.success).toBe(false);
        expect(result.accountThrottled).toBe(true);
        // Names it as account-level, not per-recipient.
        expect(result.error.toLowerCase()).toContain('account-level');
        // Tells the agent to stop hammering other recipients.
        expect(result.error.toLowerCase()).toContain('do not keep trying');
        // Preserves the raw provider phrase so the error classifier still
        // buckets this as an upstream_rejected LinkedIn business rule.
        expect(result.error).toContain('Cannot resend yet');
      });

      it('does NOT treat "Cannot resend yet" on non-invite actions as an account throttle', async () => {
        // A send-message cooldown is a different code path — the throttle guidance
        // is specific to send-invite and must not leak onto other actions.
        mockSendMessage.mockRejectedValue(makeCooldownError());

        const result = await service.linkedinOutreach('user-1', {
          action: 'send-message',
          account_id: 'test-account-id',
          provider_id: 'provider-abc',
          message: 'Hello!',
        });

        expect(result.success).toBe(false);
        expect(result.accountThrottled).toBeUndefined();
        expect(result.error).toBe('Cannot resend yet');
      });
    });
  });

  // ENG-787 (security): the send-invite CRM mirror creates leads + engagement in
  // the LLM-supplied list_id, so it must verify list access before writing —
  // otherwise a foreign list_id becomes a cross-tenant broken-access-control write.
  describe('send-invite CRM mirror access guard', () => {
    const mirrorArgs = {
      action: 'send-invite',
      account_id: 'test-account-id',
      profile_url: 'https://www.linkedin.com/in/jane-doe/',
      message: 'Hi Jane, let us connect!',
      list_id: 'list_owned',
      first_name: 'Jane',
      last_name: 'Doe',
    };

    beforeEach(() => {
      mockGetInviteCharLimitForAccount.mockResolvedValue(200);
      mockSendInvitation.mockResolvedValue({ id: 'invite-777' });
    });

    it('mirrors the invite when the caller can access the target list', async () => {
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });

      const result = await service.linkedinOutreach('user-1', mirrorArgs);

      expect(result.success).toBe(true);
      expect(mockGetLeadListById).toHaveBeenCalledWith('list_owned');
      expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', listId: 'list_owned', linkedinUrl: 'https://www.linkedin.com/in/jane-doe/' }),
      );
    });

    it('stamps the CRM mirror with the same instant it caches on the pending invite', async () => {
      // The lead's linkedInInviteSentAt must agree with the cache row this send
      // creates, rather than each being stamped from its own clock read.
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });

      await service.linkedinOutreach('user-1', mirrorArgs);

      const cached = mockUpsertSentInvitation.mock.calls[0][0];
      expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
        expect.objectContaining({ sentAt: cached.sentAt }),
      );
    });

    it('never fails the invite when the CRM mirror path throws', async () => {
      // The mirror is best-effort attribution running AFTER Unipile accepted the
      // invite — anything it throws must stay contained, or a CRM hiccup surfaces
      // to the user as a failed invite that actually went out.
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });
      mockMirrorLinkedInInviteToCrm.mockRejectedValueOnce(new Error('dynamo down'));

      const result = await service.linkedinOutreach('user-1', mirrorArgs);

      expect(result.success).toBe(true);
    });

    it('falls back to the list bound to the sending account when the model omits list_id', async () => {
      const { list_id, ...withoutListId } = mirrorArgs as any;
      mockResolveListIdForAccount.mockResolvedValue('list_bound');
      mockGetLeadListById.mockResolvedValue({ id: 'list_bound', userId: 'user-1' });

      await service.linkedinOutreach('user-1', withoutListId);

      expect(mockResolveListIdForAccount).toHaveBeenCalledWith('user-1', 'test-account-id');
      expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
        expect.objectContaining({ listId: 'list_bound' }),
      );
    });

    it('skips the mirror when neither list_id nor an account-bound list resolves', async () => {
      const { list_id, ...withoutListId } = mirrorArgs as any;
      mockResolveListIdForAccount.mockResolvedValue(null);

      const result = await service.linkedinOutreach('user-1', withoutListId);

      expect(result.success).toBe(true);
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    it('skips the mirror (no cross-tenant write) when the list is foreign / inaccessible', async () => {
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'someone-else' });

      const result = await service.linkedinOutreach('user-1', mirrorArgs);

      // The invite still succeeds (Unipile accepted it); only the CRM write is skipped.
      expect(result.success).toBe(true);
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    // Greptile P1 (ENG-1049 follow-up): mirroring was gated on the read-level
    // canOrgMemberAccessList, so any same-org member could create/update leads
    // in another member's list simply by sending an invite with that list_id.
    // Must require owner/org-owner/crm.editor, same as every other CRM write.
    describe('org-share access (ENG-1049)', () => {
      const OWNER = 'owner-1';

      function setSameOrgUsers() {
        mockGetUserById.mockImplementation((id: string) =>
          Promise.resolve(id === OWNER ? { userId: OWNER, orgId: 'org-A' } : { userId: id, orgId: 'org-A' })
        );
      }
      function orgWithCrm(overrides: Record<string, any> = {}) {
        return {
          orgId: 'org-A',
          ownerUserId: 'org-owner-id',
          shareSettings: { crm: { enabled: true, editors: [] as string[] } },
          ...overrides,
        };
      }

      afterEach(() => {
        // jest.clearAllMocks() (outer beforeEach) clears call history but not
        // mockImplementation/mockResolvedValue — reset explicitly so these org
        // fixtures don't leak into unrelated tests later in this file.
        mockGetUserById.mockReset().mockResolvedValue(null);
        mockGetOrgById.mockReset();
      });

      it('skips the mirror (no cross-tenant write) when the caller is a same-org member but not the owner and not a CRM editor', async () => {
        mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: OWNER });
        setSameOrgUsers();
        mockGetOrgById.mockResolvedValue(orgWithCrm());

        const result = await service.linkedinOutreach('user-1', mirrorArgs);

        expect(result.success).toBe(true);
        expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
      });

      it('mirrors when the caller is a listed crm.editor on a list they do not own', async () => {
        mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: OWNER });
        setSameOrgUsers();
        mockGetOrgById.mockResolvedValue(orgWithCrm({ shareSettings: { crm: { enabled: true, editors: ['user-1'] } } }));

        const result = await service.linkedinOutreach('user-1', mirrorArgs);

        expect(result.success).toBe(true);
        expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'user-1', listId: 'list_owned' }),
        );
      });

      it('mirrors when the caller is the org owner on a list they do not personally own', async () => {
        mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: OWNER });
        setSameOrgUsers();
        mockGetOrgById.mockResolvedValue(orgWithCrm({ ownerUserId: 'user-1' }));

        const result = await service.linkedinOutreach('user-1', mirrorArgs);

        expect(result.success).toBe(true);
        expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
          expect.objectContaining({ userId: 'user-1', listId: 'list_owned' }),
        );
      });
    });

    it('skips the mirror when the list does not exist', async () => {
      mockGetLeadListById.mockResolvedValue(null);

      const result = await service.linkedinOutreach('user-1', mirrorArgs);

      expect(result.success).toBe(true);
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    // ENG-787 gap-2: a person the ENG-182 dedup guard SKIPS (already pending) must
    // still be mirrored into the CRM — otherwise pending invitees keep getting no
    // lead/engagement record. The mirror runs even though no quota-spending send happens.
    it('mirrors an already-pending invite even though the send is skipped', async () => {
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValueOnce({
        invitedUserPublicId: 'jane-doe',
        invitationText: 'earlier note',
        sentAt: '2026-07-01T00:00:00.000Z',
      });

      const result = await service.linkedinOutreach('user-1', mirrorArgs);

      expect(result.alreadyInvited).toBe(true);
      expect(mockSendInvitation).not.toHaveBeenCalled();
      // Still mirrored, carrying the original send timestamp for provenance.
      expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
        expect.objectContaining({
          listId: 'list_owned',
          linkedinUrl: 'https://www.linkedin.com/in/jane-doe/',
          sentAt: '2026-07-01T00:00:00.000Z',
        }),
      );
    });
  });

  describe('formatToolError — linkedin_outreach char limit guidance', () => {
    it('returns shorten-and-retry instruction when error message contains "too long"', () => {
      // Access the private method via cast
      const errorContent = (service as any).formatToolError(
        'linkedin_outreach',
        'Invitation message is too long (350 characters). LinkedIn limits invitation notes to 300 characters. Please shorten the message and retry.'
      );
      expect(errorContent).toContain('Do NOT report this as a success');
      expect(errorContent).toContain('300');
      expect(errorContent).toContain('shorten');
    });

    it('returns generic guidance for other linkedin_outreach errors', () => {
      const errorContent = (service as any).formatToolError(
        'linkedin_outreach',
        'Already connected with this person.'
      );
      expect(errorContent).toContain('⚠️ Tool Error');
      expect(errorContent).not.toContain('Do NOT report this as a success');
    });

    it('returns generic guidance for non-linkedin tools even if error contains "too long"', () => {
      const errorContent = (service as any).formatToolError(
        'some_other_tool',
        'This field is too long for the API.'
      );
      expect(errorContent).toContain('⚠️ Tool Error');
      expect(errorContent).not.toContain('Do NOT report this as a success');
    });
  });
});

// ─── ENG-1026: identity cross-check before agent-tool sends ──────────────────

describe('AgentModeService - LinkedIn identity cross-check (ENG-1026)', () => {
  let service: AgentModeService;

  const mismatchProfile = {
    first_name: 'Florence',
    last_name: 'Su',
    headline: 'Technical Program Manager at Snowflake',
    work_experience: [{ position: 'TPM', company: 'Snowflake', current: true }],
  };

  const vivianLead = {
    leadId: 'lead_test456',
    listId: 'list_test123',
    firstName: 'Florence',
    lastName: 'Su',
    company: 'Vivian Health',
    linkedin: 'https://www.linkedin.com/in/florencesu/',
    linkedinMessageSyncAt: new Date().toISOString(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id' },
    ]);
    mockIsAccountConnected.mockResolvedValue(true);
    mockProbeAccountSession.mockResolvedValue('connected');
    mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
    // Earlier suites set persistent implementations (e.g. a rejected duplicate
    // check) that clearAllMocks() does not remove — re-assert clean defaults.
    mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValue([]);
    mockAddLinkedInMessageEvent.mockResolvedValue(undefined);
    mockUpdateLeadLinkedInSyncAt.mockResolvedValue(undefined);
    mockUpdateLead.mockResolvedValue(undefined);
    // ENG-1026 Greptile P1 ("agent-tool authorization gap"): the identity
    // check now requires list access, same as every other CRM write in this
    // file. Default to "user-1 owns list_test123" so the existing tests in
    // this block (all called as user-1 against list_test123) keep passing
    // unmodified; the access-denial tests below override this per-call.
    mockGetLeadListById.mockResolvedValue({ id: 'list_test123', userId: 'user-1' });
  });

  it('send-message with lead context refuses on identity mismatch with a structured error', async () => {
    mockGetLeadById.mockResolvedValue(vivianLead);
    mockGetLinkedInProfile.mockResolvedValue(mismatchProfile);

    const result = await service.linkedinOutreach('user-1', {
      action: 'send-message',
      account_id: 'test-account-id',
      profile_url: 'https://www.linkedin.com/in/florencesu/',
      message: 'Hi Florence!',
      list_id: 'list_test123',
      lead_id: 'lead_test456',
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.code).toBe('linkedin_identity_mismatch');
    expect(result.details).toEqual(expect.objectContaining({ leadCompany: 'Vivian Health' }));
  });

  it('send-invite with lead context refuses on identity mismatch', async () => {
    mockGetLeadById.mockResolvedValue(vivianLead);
    mockGetLinkedInProfile.mockResolvedValue(mismatchProfile);

    const result = await service.linkedinOutreach('user-1', {
      action: 'send-invite',
      account_id: 'test-account-id',
      profile_url: 'https://www.linkedin.com/in/florencesu/',
      message: 'Hi Florence!',
      list_id: 'list_test123',
      lead_id: 'lead_test456',
    });

    expect(mockSendInvitation).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.code).toBe('linkedin_identity_mismatch');
  });

  it('send-message without lead context is unchanged (no fetch, no block)', async () => {
    mockSendMessage.mockResolvedValue({ id: 'msg-1' });
    const result = await service.linkedinOutreach('user-1', {
      action: 'send-message',
      account_id: 'test-account-id',
      profile_url: 'https://www.linkedin.com/in/whoever/',
      message: 'Hello!',
    });
    expect(result.success).toBe(true);
    expect(mockGetLinkedInProfile).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });

  it('send-message stamps the lead on a successful cross-check', async () => {
    mockGetLeadById.mockResolvedValue(vivianLead);
    mockGetLinkedInProfile.mockResolvedValue({
      first_name: 'Florence',
      last_name: 'Su',
      work_experience: [{ position: 'VP Performance Marketing', company: 'Vivian Health', current: true }],
    });
    mockSendMessage.mockResolvedValue({ id: 'msg-1' });

    const result = await service.linkedinOutreach('user-1', {
      action: 'send-message',
      account_id: 'test-account-id',
      profile_url: 'https://www.linkedin.com/in/florencesu/',
      message: 'Hi Florence!',
      list_id: 'list_test123',
      lead_id: 'lead_test456',
    });

    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLead).toHaveBeenCalledWith('list_test123', 'lead_test456', expect.objectContaining({
      linkedinIdentityVerifiedAt: expect.any(String),
    }));
  });

  // ENG-1026 Greptile P1 ("agent-tool authorization gap"): list_id/lead_id are
  // LLM-supplied tool arguments. Without a list-access check, a model-supplied
  // (or manipulated) list_id belonging to ANOTHER TENANT let this code read
  // that tenant's lead identity fields and — on a passing cross-check — stamp
  // (mutate) their lead record, entirely outside any ownership/org-share check.
  // Fixed the same way every other CRM write in this file is gated: resolve
  // the list, require canDestructiveCrmList, and never touch the lead's data
  // at all when access is denied (matches the sibling CRM-mirror access guard
  // immediately above — best-effort skip, not a hard user-facing error, since
  // this is a side-channel guard inside send-message/send-invite, not the
  // primary user-requested action).
  describe('agent-tool list-access guard (security)', () => {
    const FOREIGN_LIST = { id: 'list_test123', userId: 'someone-else' };

    it('send-message: never reads the lead when the caller lacks access to the list, and the send proceeds unprotected by the identity check', async () => {
      mockGetLeadListById.mockResolvedValue(FOREIGN_LIST);
      mockSendMessage.mockResolvedValue({ id: 'msg-1' });

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-message',
        account_id: 'test-account-id',
        profile_url: 'https://www.linkedin.com/in/florencesu/',
        message: 'Hi Florence!',
        list_id: 'list_test123',
        lead_id: 'lead_test456',
      });

      // The foreign tenant's lead is never fetched, never read, never stamped.
      expect(mockGetLeadById).not.toHaveBeenCalled();
      expect(mockGetLinkedInProfile).not.toHaveBeenCalled();
      expect(mockUpdateLead).not.toHaveBeenCalled();
      // The send itself is not blocked by this guard (best-effort side channel).
      expect(result.success).toBe(true);
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    it('send-invite: never reads the lead when the caller lacks access to the list', async () => {
      mockGetLeadListById.mockResolvedValue(FOREIGN_LIST);
      mockGetInviteCharLimitForAccount.mockResolvedValue(200);
      mockSendInvitation.mockResolvedValue({ id: 'invite-1' });

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-invite',
        account_id: 'test-account-id',
        profile_url: 'https://www.linkedin.com/in/florencesu/',
        message: 'Hi Florence!',
        list_id: 'list_test123',
        lead_id: 'lead_test456',
      });

      expect(mockGetLeadById).not.toHaveBeenCalled();
      expect(mockGetLinkedInProfile).not.toHaveBeenCalled();
      expect(mockUpdateLead).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(mockSendInvitation).toHaveBeenCalledTimes(1);
    });

    it('send-message: never reads the lead when the list does not exist', async () => {
      mockGetLeadListById.mockResolvedValue(null);
      mockSendMessage.mockResolvedValue({ id: 'msg-1' });

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-message',
        account_id: 'test-account-id',
        profile_url: 'https://www.linkedin.com/in/florencesu/',
        message: 'Hi Florence!',
        list_id: 'list_test123',
        lead_id: 'lead_test456',
      });

      expect(mockGetLeadById).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('send-message: a same-org listed CRM editor on the list still gets the identity check (access is granted, not just self-ownership)', async () => {
      mockGetLeadListById.mockResolvedValue({ id: 'list_test123', userId: 'owner-1' });
      mockGetUserById.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'owner-1' ? { userId: 'owner-1', orgId: 'org-A' } : { userId: id, orgId: 'org-A' }
        )
      );
      mockGetOrgById.mockResolvedValue({
        orgId: 'org-A',
        ownerUserId: 'org-owner-id',
        shareSettings: { crm: { enabled: true, editors: ['user-1'] } },
      });
      mockGetLeadById.mockResolvedValue(vivianLead);
      mockGetLinkedInProfile.mockResolvedValue(mismatchProfile);

      const result = await service.linkedinOutreach('user-1', {
        action: 'send-message',
        account_id: 'test-account-id',
        profile_url: 'https://www.linkedin.com/in/florencesu/',
        message: 'Hi Florence!',
        list_id: 'list_test123',
        lead_id: 'lead_test456',
      });

      // Access WAS granted (listed editor) -- the identity check ran and refused on mismatch.
      expect(mockGetLeadById).toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.code).toBe('linkedin_identity_mismatch');
    });
  });

  describe('write pacing spends slots only on real Unipile writes (ENG-1197)', () => {
    // The pacer's budget exists to stop a drain bursting the session to death. If a
    // slot is taken before the action's own skip checks, the paths that never reach
    // LinkedIn — an already-pending invite, a duplicate message — spend that budget
    // anyway, and the genuinely-new sends later in the same run get refused for
    // writes that never happened.
    //
    // Ceiling of 1 with a zero gap makes that visible without any wall-clock waiting:
    // under the old placement the SECOND call through a skip path was refused.
    beforeEach(() => {
      __resetWritePacerForTests();
      process.env.LINKEDIN_WRITE_MIN_GAP_MS = '0';
      process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '1';
    });

    afterEach(() => {
      delete process.env.LINKEDIN_WRITE_MIN_GAP_MS;
      delete process.env.LINKEDIN_WRITE_MAX_PER_HOUR;
      __resetWritePacerForTests();
    });

    const inviteArgs = {
      action: 'send-invite',
      account_id: 'test-account-id',
      profile_url: 'https://www.linkedin.com/in/chang-liu/',
      message: 'Great to connect!',
    };

    it('does not spend a slot on an already-pending invite', async () => {
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue({ sentAt: null });

      const results = [
        await service.linkedinOutreach('user-1', inviteArgs),
        await service.linkedinOutreach('user-1', inviteArgs),
        await service.linkedinOutreach('user-1', inviteArgs),
      ];

      // All three skip; none is refused by the pacer despite a ceiling of one.
      for (const result of results) {
        expect(result.alreadyInvited).toBe(true);
        expect(result.message).not.toBe('LinkedIn write actions are being paced');
      }
      expect(mockSendInvitation).not.toHaveBeenCalled();
    });

    it('does not spend a slot on a duplicate message', async () => {
      mockGetLeadById.mockResolvedValue({
        leadId: 'lead_test456',
        listId: 'list_test123',
        linkedin: 'https://www.linkedin.com/in/johndoe/',
        linkedinMessageSyncAt: new Date().toISOString(),
      });
      mockGetEventsByEmailDomainAndLeadEmail.mockResolvedValue([
        { eventType: 'linkedin.message.sent', data: { text: 'Hello, let us connect!' }, createdAt: '2026-08-01T00:00:00.000Z' },
      ]);
      const dupeArgs = {
        action: 'send-message',
        account_id: 'test-account-id',
        provider_id: 'li-provider-123',
        message: 'Hello, let us connect!',
        list_id: 'list_test123',
        lead_id: 'lead_test456',
      };

      const first = await service.linkedinOutreach('user-1', dupeArgs);
      const second = await service.linkedinOutreach('user-1', dupeArgs);

      expect(first.duplicate).toBe(true);
      expect(second.duplicate).toBe(true);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('does not spend a slot while the ENG-126 breaker is armed', async () => {
      // The breaker short-circuits the network call INSIDE sendInvitation, so a
      // paced caller slept a full gap and burned one of the account's hourly writes
      // for a request that never left the process — for the whole hour the breaker
      // is armed, on every queued invite. That inverts the breaker's own purpose.
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockIsUnderInvitationCooldown.mockReturnValue(true);

      const results = [
        await service.linkedinOutreach('user-1', inviteArgs),
        await service.linkedinOutreach('user-1', inviteArgs),
        await service.linkedinOutreach('user-1', inviteArgs),
      ];

      for (const result of results) {
        expect(result.success).toBe(false);
        expect(result.error).toContain('Cannot resend yet');
        // Not the pacer's refusal: the ceiling of one was never touched.
        expect(result.message).not.toBe('LinkedIn write actions are being paced');
      }
      expect(mockSendInvitation).not.toHaveBeenCalled();
      mockIsUnderInvitationCooldown.mockReturnValue(false);
    });

    it('still spends a slot on a send that does reach Unipile', async () => {
      // The control: without this the test above would also pass if pacing were
      // simply switched off.
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockSendInvitation.mockResolvedValue({ id: 'inv-xyz' });

      const first = await service.linkedinOutreach('user-1', inviteArgs);
      const second = await service.linkedinOutreach('user-1', inviteArgs);

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
      expect(second.message).toBe('LinkedIn write actions are being paced');
      expect(mockSendInvitation).toHaveBeenCalledTimes(1);
    });
  });
});
