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

const mockRecordUnipileAccountHealth = jest.fn().mockResolvedValue('no-op');
jest.mock('../services/linkedInConnectionHealth', () => ({
  recordUnipileAccountHealth: (...args: any[]) => mockRecordUnipileAccountHealth(...args),
}));

// Mock connectedAccountsDb
const mockGetAccountsByUserId = jest.fn();
const mockGetAccountsByUserIdIncludingOrgShared = jest.fn();
// Resolves by default (daily-volume persistence, ENG-1197 durability follow-up)
// so existing tests that don't care about it don't have to mock it explicitly —
// the pacer's write is best-effort/caught, but an unresolved mock would still
// hang the call.
const mockUpdateAccountConfig = jest.fn().mockResolvedValue(undefined);
const mockGetAccountsWithOwnerIncludingOrgShared = jest.fn();
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsByUserId: (...args: any[]) => mockGetAccountsByUserId(...args),
  getAccountsByUserIdIncludingOrgShared: (...args: any[]) => mockGetAccountsByUserIdIncludingOrgShared(...args),
  getAccountsWithOwnerIncludingOrgShared: (...args: any[]) => mockGetAccountsWithOwnerIncludingOrgShared(...args),
  updateAccountConfig: (...args: any[]) => mockUpdateAccountConfig(...args),
}));

// Mock linkedInOutreachService
const mockSendMessage = jest.fn();
const mockGetLinkedInProfile = jest.fn();
const mockSendInMail = jest.fn();
const mockSendInvitation = jest.fn();
const mockAcceptInvitation = jest.fn();
const mockGetProfile = jest.fn();
const mockListReceivedInvitations = jest.fn().mockResolvedValue({ items: [], cursor: null });
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
// ENG-1558: default mirrors the real no-op contract (unchanged items, zero
// exclusions) so every pre-existing search-people test — none of which pass
// company_size_min/max — keeps working without having to know this exists.
const mockFilterByCompanySize = jest.fn(
  async (...args: any[]) => ({ items: args[0], excludedUnverifiable: 0 }),
);
const mockListSentInvitations = jest.fn();
// ENG-1719: the bulk drain withdraws through the same service call the single-shot
// cancel-invitation action uses.
const mockCancelInvitation = jest.fn().mockResolvedValue({ ok: true });
// A faithful inline copy of isProvenDisconnectError's logic (pure,
// dependency-free). jest.requireActual on this module was tried first, but
// that pulls in linkedInOutreachService.ts's real top-level `import {
// UnipileClient } from 'unipile-node-sdk'` at load time, which interacted
// unreliably with another test file's `{virtual: true}` mock of that same
// package when both ran in the same jest worker — reproducibly ~50% failure
// rate across runs of the combined suite, 0% in isolation. Inlining avoids
// loading the real module's import graph at all.
function isProvenDisconnectErrorMock(error: any): boolean {
  const structured = error?.structuredError;
  const code = structured?.code || error?.body?.code || error?.code || '';
  const status = structured?.status || error?.body?.status || error?.status;
  const classification = structured?.classification || error?.body?.classification || error?.classification;
  if (Number(status) === 403 && code !== 'errors/disconnected_account') return false;
  return code === 'errors/disconnected_account' || classification === 'AUTH_ERROR' || Number(status) === 401;
}
jest.mock('../services/linkedInOutreachService', () => {
  return {
  isProvenDisconnectError: isProvenDisconnectErrorMock,
  linkedInOutreachService: {
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    getLinkedInProfile: (...args: any[]) => mockGetLinkedInProfile(...args),
    sendInMail: (...args: any[]) => mockSendInMail(...args),
    sendInvitation: (...args: any[]) => mockSendInvitation(...args),
    acceptInvitation: (...args: any[]) => mockAcceptInvitation(...args),
    getProfile: (...args: any[]) => mockGetProfile(...args),
    listReceivedInvitations: (...args: any[]) => mockListReceivedInvitations(...args),
    listSentInvitations: (...args: any[]) => mockListSentInvitations(...args),
    cancelInvitation: (...args: any[]) => mockCancelInvitation(...args),
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
    filterByCompanySize: (...args: any[]) => mockFilterByCompanySize(...args),
    clearStatusCache: (...args: any[]) => mockClearStatusCache(...args),
  },
  };
});

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
const mockRecordInviteWithdrawnInCrm = jest.fn().mockResolvedValue(null);
jest.mock('../services/linkedInInviteCrmMirror', () => ({
  mirrorLinkedInInviteToCrm: (...args: any[]) => mockMirrorLinkedInInviteToCrm(...args),
  resolveListIdForAccount: (...args: any[]) => mockResolveListIdForAccount(...args),
  // Real pure name-splitting logic — no reason to stub it, and the accept-invitation
  // tests below assert on the actual firstName/lastName it derives.
  splitInvitedUserName: jest.requireActual('../services/linkedInInviteCrmMirror').splitInvitedUserName,
  INVITE_SENT_EVENT: 'linkedin.invite.sent',
  INVITE_ACCEPTED_EVENT: 'linkedin.invite.accepted',
  INVITE_WITHDRAWN_EVENT: 'linkedin.invite.withdrawn',
  recordInviteWithdrawnInCrm: (...args: any[]) => mockRecordInviteWithdrawnInCrm(...args),
}));

// Mock unipileSentInvitationsDb (ENG-182 pre-invite dedup cache). The pre-check
// uses the publicProfileUrl GSI getter (case-robust, matches the CRM path).
const mockGetSentInvitationByProfileUrlAndAccount = jest.fn().mockResolvedValue(null);
const mockUpsertSentInvitation = jest.fn().mockResolvedValue(undefined);
// ENG-1718: list-sent-invitations now falls back to this same ledger when the live
// read is unusable, so the getter belongs on the ONE mock for this module — a second
// jest.mock for the same path silently overrides the first.
const mockGetAllSentInvitationsByAccount = jest.fn().mockResolvedValue([]);
const mockDeleteSentInvitationByInvitationId = jest.fn().mockResolvedValue(1);
jest.mock('../services/unipileSentInvitationsDb', () => ({
  getSentInvitationByProfileUrlAndAccount: (...args: any[]) => mockGetSentInvitationByProfileUrlAndAccount(...args),
  upsertSentInvitation: (...args: any[]) => mockUpsertSentInvitation(...args),
  getAllSentInvitationsByAccount: (...args: any[]) => mockGetAllSentInvitationsByAccount(...args),
  deleteSentInvitationByInvitationId: (...args: any[]) => mockDeleteSentInvitationByInvitationId(...args),
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
    mockUpdateAccountConfig.mockImplementation(async (...args: any[]) => {
      const mutation = args[3];
      if (typeof mutation === 'function') mutation({});
    });

    // Default: user owns the account (or it is org-shared)
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id' },
    ]);
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id', userId: 'user-1' },
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
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'different-account', userId: 'user-1' },
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

    beforeEach(() => {
      // updateArgs supplies a raw provider_id (not profile_url), which now gets
      // validated via getProfile before getMessagesWithContact is called — see
      // "rejects with a clear error when provider_id does not resolve to a real
      // profile" below. Default to a valid profile so these tests exercise the
      // sync behavior, not the new validation guard.
      mockGetProfile.mockResolvedValue({ provider_id: 'li-provider-123' });
    });

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

    it('rejects with a clear error when a raw provider_id does not resolve to a real profile, instead of silently reporting synced: 0', async () => {
      // getMessagesWithContact treats a chat_attendee 404 as "never messaged"
      // (ENG-1623), which is indistinguishable from a 404 caused by an
      // invalid/nonexistent provider_id. A raw provider_id (no profile_url) is
      // not validated by resolveProviderId, so it must be validated here instead.
      mockGetLeadById.mockResolvedValue(lead);
      mockGetProfile.mockRejectedValue(
        Object.assign(new Error('Attendee not found'), {
          structuredError: { classification: 'NOT_FOUND', message: 'Attendee not found' },
        })
      );

      const result = await service.linkedinOutreach('user-1', updateArgs);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Attendee not found');
      // Must fail before ever reaching the chat lookup, sync, or gate-satisfying write.
      expect(mockGetMessagesWithContact).not.toHaveBeenCalled();
      expect(mockUpdateLeadLinkedInSyncAt).not.toHaveBeenCalled();
    });

    it('does not run the provider_id validation check when a profile_url is supplied (already validated by resolveProviderId)', async () => {
      const urlArgs = { ...updateArgs, provider_id: undefined, profile_url: 'https://www.linkedin.com/in/johndoe/' };
      mockGetLeadById.mockResolvedValue(lead);
      mockResolveProviderId.mockResolvedValue('li-provider-123');
      mockGetMessagesWithContact.mockResolvedValue([]);

      const result = await service.linkedinOutreach('user-1', urlArgs);

      expect(result.success).toBe(true);
      expect(mockGetProfile).not.toHaveBeenCalled();
      expect(mockResolveProviderId).toHaveBeenCalledWith('https://www.linkedin.com/in/johndoe/', true, 'test-account-id');
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
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'different-account', userId: 'user-1' },
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

    it('records health with the real owner for the preflight disconnect on an owned account (ENG-2205)', async () => {
      mockProbeAccountSession.mockResolvedValue('disconnected');

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
        accountId: 'test-account-id',
        ownerUserId: 'user-1',
        state: 'disconnected',
      });
    });

    it('omits ownerUserId for the preflight disconnect on a site-wide pool account (ENG-2205)', async () => {
      // account_id is not in the caller's own account list — usedSharedAccount
      // becomes true (ENG-1198 determination), so recordUnipileAccountHealth
      // must not be told this customer owns it: its owner lookup can never
      // resolve the global fallback pool under an unrelated caller's userId.
      mockListUserOwnedUnipileAccountIds.mockResolvedValue([]);
      mockProbeAccountSession.mockResolvedValue('disconnected');

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
        accountId: 'test-account-id',
        ownerUserId: undefined,
        state: 'disconnected',
      });
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

    it('records health with the real owner for the reactive disconnect on an owned account (ENG-2205)', async () => {
      mockSearchPeople.mockRejectedValue(makeDisconnectedError());

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
        accountId: 'test-account-id',
        ownerUserId: 'user-1',
        state: 'disconnected',
      });
    });

    it('omits ownerUserId for the reactive disconnect on a site-wide pool account (ENG-2205)', async () => {
      mockListUserOwnedUnipileAccountIds.mockResolvedValue([]);
      mockSearchPeople.mockRejectedValue(makeDisconnectedError());

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(mockRecordUnipileAccountHealth).toHaveBeenCalledWith({
        accountId: 'test-account-id',
        ownerUserId: undefined,
        state: 'disconnected',
      });
    });

    it('does not treat a bare 403 (permission/plan restriction) as a proven disconnect (ENG-2205)', async () => {
      const forbiddenError: any = new Error('Forbidden');
      forbiddenError.structuredError = { status: 403, classification: 'AUTH_ERROR' };
      mockSearchPeople.mockRejectedValue(forbiddenError);

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'stealth founder',
      });

      expect(result.message).not.toBe('LinkedIn account disconnected');
      expect(mockRecordUnipileAccountHealth).not.toHaveBeenCalled();
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

  // ENG-1558 — Unipile has no native headcount filter for the People search
  // category (only Companies), so company_size_min/max is applied as a
  // post-filter over linkedInOutreachService.searchPeople's raw results via
  // linkedInOutreachService.filterByCompanySize (unit-tested on its own in
  // linkedInOutreachService.test.ts). These tests cover the dispatcher's
  // wiring: does it call the filter with the right args, and does it shape
  // the response correctly around the result.
  describe('ENG-1558: company-size post-filter wiring', () => {
    it('does not call filterByCompanySize when company_size_min/max are both omitted', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [{ provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'B' }],
        cursor: null,
      });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
      });

      expect(result.success).toBe(true);
      expect(result.data.items).toHaveLength(1);
      // The dispatcher may still call the (no-op-by-default) mock; what
      // matters is it never receives real bounds when the caller passed none.
      if (mockFilterByCompanySize.mock.calls.length > 0) {
        expect(mockFilterByCompanySize.mock.calls[0][1]).toEqual({ min: undefined, max: undefined });
      }
    });

    it('passes company_size_min/max through to filterByCompanySize with the right account', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [{ provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'B' }],
        cursor: null,
      });

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
        company_size_min: 1,
        company_size_max: 200,
      });

      expect(mockFilterByCompanySize).toHaveBeenCalledWith(
        expect.any(Array),
        { min: 1, max: 200 },
        'test-account-id',
      );
    });

    it('returns only the candidates filterByCompanySize kept', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [
          { provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'Startup' },
          { provider_id: 'p2', public_identifier: 'p2', first_name: 'B', last_name: 'Enterprise' },
        ],
        cursor: null,
      });
      mockFilterByCompanySize.mockResolvedValueOnce({
        items: [{ provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'Startup' }],
        excludedUnverifiable: 0,
      });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
        company_size_max: 200,
      });

      expect(result.success).toBe(true);
      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0].last_name).toBe('Startup');
    });

    it('reports companySizeFiltered on the response when candidates were excluded', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [
          { provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'Startup' },
          { provider_id: 'p2', public_identifier: 'p2', first_name: 'B', last_name: 'Enterprise' },
        ],
        cursor: null,
      });
      mockFilterByCompanySize.mockResolvedValueOnce({
        items: [{ provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'Startup' }],
        excludedUnverifiable: 1,
      });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
        company_size_max: 200,
      });

      expect(result.data.companySizeFiltered).toBe(1);
    });

    it('does not add a companySizeFiltered field when nothing was excluded', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [{ provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'B' }],
        cursor: null,
      });
      mockFilterByCompanySize.mockResolvedValueOnce({
        items: [{ provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'B' }],
        excludedUnverifiable: 0,
      });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
        company_size_max: 200,
      });

      expect(result.data.companySizeFiltered).toBeUndefined();
    });

    it('reports a transparent "narrow niche" message, not a false empty/outage, when every candidate is excluded by size', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [
          { provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'One' },
          { provider_id: 'p2', public_identifier: 'p2', first_name: 'B', last_name: 'Two' },
        ],
        cursor: null,
      });
      mockFilterByCompanySize.mockResolvedValueOnce({ items: [], excludedUnverifiable: 2 });

      const result = await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
        company_size_max: 200,
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('excluded all 2');
      expect(result.message).not.toMatch(/unavailable|outage/i);
      expect(mockProbeSearchCapability).not.toHaveBeenCalled();
    });

    it('applies the size filter AFTER the anonymized-result filter (never sizes an unusable placeholder)', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [
          { provider_id: 'p1', public_identifier: 'undefined', first_name: 'LinkedIn', last_name: 'Member' },
          { provider_id: 'p2', public_identifier: 'p2', first_name: 'Real', last_name: 'Person' },
        ],
        cursor: null,
      });
      mockFilterByCompanySize.mockResolvedValueOnce({
        items: [{ provider_id: 'p2', public_identifier: 'p2', first_name: 'Real', last_name: 'Person' }],
        excludedUnverifiable: 0,
      });

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
        company_size_max: 200,
      });

      // Only the real (non-anonymized) item should have reached the filter.
      const passedItems = mockFilterByCompanySize.mock.calls[0][0];
      expect(passedItems).toHaveLength(1);
      expect(passedItems[0].provider_id).toBe('p2');
    });

    // ENG-1558 follow-up: live production testing after this feature shipped
    // found company_size_max excluded 10/10 candidates at every bound tried,
    // including a bound wide enough that it should have been a no-op. Root
    // cause: classic search-people items don't carry `work_experience` (only
    // `headline`), so filterByCompanySize's employer lookup found nothing to
    // resolve and marked every candidate unverifiable. The fix resolves an
    // employer name from the headline (mirroring importLeadsFromSearch's own
    // tiered resolution) before handing items to filterByCompanySize.
    it('resolves an employer from headline (no work_experience on the raw item) before filtering by size', async () => {
      mockSearchPeople.mockResolvedValue({
        items: [
          { provider_id: 'p1', public_identifier: 'p1', first_name: 'A', last_name: 'One', headline: 'Product Manager at Foo Inc' },
        ],
        cursor: null,
      });
      mockFilterByCompanySize.mockResolvedValueOnce({ items: [], excludedUnverifiable: 1 });

      await service.linkedinOutreach('user-1', {
        action: 'search-people',
        account_id: 'test-account-id',
        keywords: 'product manager',
        company_size_max: 200,
      });

      const passedItems = mockFilterByCompanySize.mock.calls[0][0];
      expect(passedItems[0].work_experience).toEqual([{ company: 'Foo Inc', current: true }]);
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

  describe('accept-invitation CRM mirror (ENG-1595)', () => {
    const acceptArgs = {
      action: 'accept-invitation',
      account_id: 'test-account-id',
      invitation_id: 'inv-123',
      shared_secret: 'secret-abc',
      list_id: 'list_owned',
    };

    const RECEIVED_PAGE = {
      items: [
        { id: 'inv-123', sender_profile: { public_id: 'jane-doe', provider_id: 'prov-jane', full_name: 'Jane Doe' } },
      ],
      cursor: null,
    };

    beforeEach(() => {
      mockAcceptInvitation.mockResolvedValue({ object: 'InvitationAccepted' });
      mockListReceivedInvitations.mockResolvedValue(RECEIVED_PAGE);
    });

    it('accepts the invitation and mirrors the now-accepted connection using identity from the received-invitation record, not caller args', async () => {
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });

      const result = await service.linkedinOutreach('user-1', acceptArgs);

      expect(result.success).toBe(true);
      expect(mockListReceivedInvitations).toHaveBeenCalledWith('test-account-id', undefined);
      expect(mockAcceptInvitation).toHaveBeenCalledWith('inv-123', 'test-account-id', 'secret-abc');
      expect(mockGetLeadListById).toHaveBeenCalledWith('list_owned');
      expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          listId: 'list_owned',
          linkedinUrl: 'https://www.linkedin.com/in/jane-doe/',
          firstName: 'Jane',
          lastName: 'Doe',
          invitationId: 'inv-123',
          eventType: 'linkedin.invite.accepted',
        }),
      );
    });

    it('ignores caller-supplied profile_url/first_name/last_name entirely — identity always comes from the verified invitation record', async () => {
      // A model could pass a name/URL for a DIFFERENT person than invitation_id
      // actually belongs to (mistake or otherwise) — the mirror must never
      // attribute the CRM write to whatever the caller merely claims.
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });

      await service.linkedinOutreach('user-1', {
        ...acceptArgs,
        profile_url: 'https://www.linkedin.com/in/someone-else/',
        provider_id: 'prov-someone-else',
        first_name: 'Not',
        last_name: 'Jane',
      });

      expect(mockMirrorLinkedInInviteToCrm).toHaveBeenCalledWith(
        expect.objectContaining({
          linkedinUrl: 'https://www.linkedin.com/in/jane-doe/',
          firstName: 'Jane',
          lastName: 'Doe',
        }),
      );
      // The unverified provider_id must never be resolved as a fallback path.
      expect(mockGetProfile).not.toHaveBeenCalled();
    });

    it('skips the mirror when the invitation is not found in the received-invitations record (identity unverifiable)', async () => {
      mockListReceivedInvitations.mockResolvedValue({ items: [], cursor: null });
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });

      const result = await service.linkedinOutreach('user-1', acceptArgs);

      expect(result.success).toBe(true);
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    it('bounds the received-invitations page scan rather than paging unboundedly', async () => {
      mockListReceivedInvitations.mockImplementation(async (_accountId: string, cursor?: string) => ({
        items: [{ id: `other-${cursor || 0}`, sender_profile: { public_id: 'nope' } }],
        cursor: String((Number(cursor) || 0) + 1),
      }));

      await service.linkedinOutreach('user-1', acceptArgs);

      expect(mockListReceivedInvitations.mock.calls.length).toBeLessThanOrEqual(5);
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    it('still accepts successfully when list_id is omitted — mirrors nothing rather than guessing', async () => {
      const { list_id, ...withoutListId } = acceptArgs as any;

      const result = await service.linkedinOutreach('user-1', withoutListId);

      expect(result.success).toBe(true);
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    // ENG-1595 follow-up: unlike send-invite, accept-invitation must NEVER fall back
    // to the account's bound list when list_id is omitted. Sending an invite is
    // always a deliberate targeting action; accepting one is not — the account
    // owner never decided "every accepted connection is a lead" just by having a
    // list configured. Only an explicit list_id (i.e. the task actually judged this
    // person relevant) may trigger a mirror.
    it('does NOT fall back to the account-bound list when list_id is omitted, even if one is configured', async () => {
      const { list_id, ...withoutListId } = acceptArgs as any;
      mockResolveListIdForAccount.mockResolvedValue('list_bound');

      const result = await service.linkedinOutreach('user-1', withoutListId);

      expect(result.success).toBe(true);
      expect(mockResolveListIdForAccount).not.toHaveBeenCalled();
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    it('skips the mirror (no cross-tenant write) when the resolved list is foreign', async () => {
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'someone-else' });

      const result = await service.linkedinOutreach('user-1', acceptArgs);

      // The accept still succeeds (Unipile already confirmed it); only the CRM write is skipped.
      expect(result.success).toBe(true);
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    it('never fails the accept when the received-invitations lookup throws', async () => {
      mockListReceivedInvitations.mockRejectedValueOnce(new Error('unipile down'));

      const result = await service.linkedinOutreach('user-1', acceptArgs);

      expect(result.success).toBe(true);
      expect(mockAcceptInvitation).toHaveBeenCalled();
      expect(mockMirrorLinkedInInviteToCrm).not.toHaveBeenCalled();
    });

    it('never fails the accept when the CRM mirror throws', async () => {
      mockGetLeadListById.mockResolvedValue({ id: 'list_owned', userId: 'user-1' });
      mockMirrorLinkedInInviteToCrm.mockRejectedValueOnce(new Error('dynamo down'));

      const result = await service.linkedinOutreach('user-1', acceptArgs);

      expect(result.success).toBe(true);
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
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id', userId: 'user-1' },
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
      delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
      delete process.env.LINKEDIN_DAILY_MESSAGE_CAP;
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

    it('does not reserve daily volume when the hourly pacer refuses the write', async () => {
      process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '10';
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockSendInvitation.mockResolvedValue({ id: 'inv-hourly' });

      const first = await service.linkedinOutreach('user-1', inviteArgs);
      const second = await service.linkedinOutreach('user-1', inviteArgs);

      expect(first.success).toBe(true);
      expect(second.success).toBe(false);
      expect(second.message).toBe('LinkedIn write actions are being paced');
      expect(mockUpdateAccountConfig).toHaveBeenCalledTimes(1);
    });

  });

  describe('multi-account routing (ENG-1614)', () => {
    beforeEach(() => {
      __resetWritePacerForTests();
      process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
    });

    afterEach(() => {
      delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
      __resetWritePacerForTests();
      mockIsUnderInvitationCooldown.mockReturnValue(false);
    });

    const routingInviteArgs = {
      action: 'send-invite',
      account_id: 'capped-account',
      profile_url: 'https://www.linkedin.com/in/chang-liu/',
      message: 'Great to connect!',
    };

    it('routes send-invite to an org-shared account with headroom when the requested account is at its daily cap (AC1) and reports the routing decision (AC3)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        {
          platform: 'unipile',
          account_id: 'capped-account',
          userId: 'user-1',
          config: { daily_invite_cap: 10, daily_volume: { invite: { count: 10, windowStartedAt: Date.now() } } },
        },
        {
          platform: 'unipile',
          account_id: 'headroom-account',
          userId: 'teammate-2',
          sharedWithOrg: true,
          config: { daily_invite_cap: 30, daily_volume: { invite: { count: 1, windowStartedAt: Date.now() } } },
        },
      ]);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockSendInvitation.mockResolvedValue({ id: 'inv-routed' });

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(true);
      // The whole write went through the account with headroom, not the capped one.
      expect(mockSendInvitation.mock.calls[0][0]).toBe('headroom-account');
      expect(mockGetSentInvitationByProfileUrlAndAccount.mock.calls[0][1]).toBe('headroom-account');
      // AC3: routing must be visible/reported, never a silent fallback (ENG-1198).
      expect(result.data.accountRouting).toEqual({
        fromAccountId: 'capped-account',
        toAccountId: 'headroom-account',
        reason: expect.stringContaining('headroom-account'),
      });
    });

    it('does not route (and fails normally) when no other connected account has headroom either', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        {
          platform: 'unipile',
          account_id: 'capped-account',
          userId: 'user-1',
          config: { daily_invite_cap: 10, daily_volume: { invite: { count: 10, windowStartedAt: Date.now() } } },
        },
      ]);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn daily volume limit reached');
      expect(mockSendInvitation).not.toHaveBeenCalled();
    });

    it('does not route when the requested account already has headroom (AC5 — single/unconstrained-account behavior unchanged)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        {
          platform: 'unipile',
          account_id: 'capped-account',
          userId: 'user-1',
          config: { daily_invite_cap: 10, daily_volume: { invite: { count: 2, windowStartedAt: Date.now() } } },
        },
      ]);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockSendInvitation.mockResolvedValue({ id: 'inv-unrouted' });

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(true);
      expect(mockSendInvitation.mock.calls[0][0]).toBe('capped-account');
      expect(result.data).not.toHaveProperty('accountRouting');
    });

    const routedAccounts = [
      {
        platform: 'unipile',
        account_id: 'capped-account',
        userId: 'user-1',
        config: { daily_invite_cap: 10, daily_volume: { invite: { count: 10, windowStartedAt: Date.now() } } },
      },
      {
        platform: 'unipile',
        account_id: 'headroom-account',
        userId: 'teammate-2',
        sharedWithOrg: true,
        config: { daily_invite_cap: 30, daily_volume: { invite: { count: 1, windowStartedAt: Date.now() } } },
      },
    ];

    it('discloses the routing decision on the disconnected-session preflight refusal, not just on success (AC3)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(routedAccounts);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockProbeAccountSession.mockImplementation(async (accountId: string) => (
        accountId === 'headroom-account' ? 'disconnected' : 'connected'
      ));

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn account disconnected');
      // The refusal is for the ROUTED account, not the one the caller named —
      // without accountRouting on this payload the customer can't tell why.
      expect(result.accountRouting).toEqual({
        fromAccountId: 'capped-account',
        toAccountId: 'headroom-account',
        reason: expect.stringContaining('headroom-account'),
      });
      expect(mockSendInvitation).not.toHaveBeenCalled();
      mockProbeAccountSession.mockResolvedValue('connected');
    });

    it('routes send-invite to another account when the requested one is under LinkedIn\'s own invitation cooldown, even with daily-cap headroom to spare (ENG-1132 root cause, not just AC1\'s daily-cap case)', async () => {
      // The real production incidents behind this ticket (iTrials/Sweta, Hannah K)
      // were all this in-process "Cannot resend yet" breaker — never the
      // daily_invite_cap. An account can have plenty of daily headroom left and
      // still be unusable this run once LinkedIn itself has rejected one send.
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
        {
          platform: 'unipile',
          account_id: 'capped-account',
          userId: 'user-1',
          config: { daily_invite_cap: 10, daily_volume: { invite: { count: 2, windowStartedAt: Date.now() } } },
        },
        {
          platform: 'unipile',
          account_id: 'headroom-account',
          userId: 'teammate-2',
          sharedWithOrg: true,
          config: { daily_invite_cap: 30, daily_volume: { invite: { count: 1, windowStartedAt: Date.now() } } },
        },
      ]);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockIsUnderInvitationCooldown.mockImplementation((accountId: string) => accountId === 'capped-account');
      mockSendInvitation.mockResolvedValue({ id: 'inv-routed-cooldown' });

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(true);
      expect(mockSendInvitation.mock.calls[0][0]).toBe('headroom-account');
      expect(result.data.accountRouting).toEqual({
        fromAccountId: 'capped-account',
        toAccountId: 'headroom-account',
        reason: expect.stringContaining('cooldown'),
      });
    });

    it('does not route to a candidate that is itself under cooldown — falls through to the requested account\'s own refusal (AC5-style: no viable candidate means unchanged behavior)', async () => {
      // Both accounts are compromised, just for different reasons: capped-account
      // is at its daily cap, headroom-account has daily headroom but is ALSO under
      // an active cooldown. Routing to a candidate that is doomed to fail anyway
      // would misreport what actually happened, so it must not be selected —
      // the refusal stays on the originally-requested account's real state.
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(routedAccounts);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockIsUnderInvitationCooldown.mockImplementation((accountId: string) => accountId === 'headroom-account');

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn daily volume limit reached');
      expect(result.accountRouting).toBeUndefined();
      expect(mockSendInvitation).not.toHaveBeenCalled();
    });

    it('discloses the routing decision on the hourly/burst pacer refusal, not just on success (AC2 + AC3)', async () => {
      process.env.LINKEDIN_WRITE_MIN_GAP_MS = '0';
      process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '1';
      try {
        mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(routedAccounts);
        mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
        mockSendInvitation.mockResolvedValue({ id: 'inv-routed' });

        // First call routes capped-account -> headroom-account and spends its one slot.
        const first = await service.linkedinOutreach('user-1', routingInviteArgs);
        // Second call routes to the same headroom-account, which the hourly pacer now refuses.
        const second = await service.linkedinOutreach('user-1', routingInviteArgs);

        expect(first.success).toBe(true);
        expect(second.success).toBe(false);
        expect(second.message).toBe('LinkedIn write actions are being paced');
        expect(second.accountRouting).toEqual({
          fromAccountId: 'capped-account',
          toAccountId: 'headroom-account',
          reason: expect.stringContaining('headroom-account'),
        });
        expect(mockSendInvitation).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.LINKEDIN_WRITE_MIN_GAP_MS;
        delete process.env.LINKEDIN_WRITE_MAX_PER_HOUR;
      }
    });

    it('discloses the routing decision on the already-pending refusal, not just on the eventual send (CodeRabbit finding on PR #2742)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(routedAccounts);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue({ sentAt: '2026-09-01T00:00:00.000Z' });

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(true);
      expect(result.alreadyInvited).toBe(true);
      expect(result.accountRouting).toEqual({
        fromAccountId: 'capped-account',
        toAccountId: 'headroom-account',
        reason: expect.stringContaining('headroom-account'),
      });
      expect(mockSendInvitation).not.toHaveBeenCalled();
    });

    it('discloses the routing decision on the note-quota decision-gate hold, not just on a clean send (CodeRabbit finding on PR #2742)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(routedAccounts);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      const quotaErr: any = new Error('note quota exceeded');
      quotaErr.noteQuotaExceeded = true;
      mockSendInvitation.mockRejectedValue(quotaErr);

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(false);
      expect(result.requiresDecision).toBe(true);
      expect(result.noteQuotaExceeded).toBe(true);
      expect(result.accountRouting).toEqual({
        fromAccountId: 'capped-account',
        toAccountId: 'headroom-account',
        reason: expect.stringContaining('headroom-account'),
      });
    });

    it('discloses the routing decision on an unexpected/generic send failure, not just the classified refusal paths (CodeRabbit finding on PR #2742)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(routedAccounts);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockSendInvitation.mockRejectedValue(new Error('unexpected upstream failure'));

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(false);
      expect(result.message).toBe('LinkedIn outreach action failed');
      expect(result.accountRouting).toEqual({
        fromAccountId: 'capped-account',
        toAccountId: 'headroom-account',
        reason: expect.stringContaining('headroom-account'),
      });
    });

    it('fetches the org account list only once for a routed write, not once to resolve the account and again to scan candidates (CodeRabbit performance finding on PR #2742)', async () => {
      mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue(routedAccounts);
      mockGetSentInvitationByProfileUrlAndAccount.mockResolvedValue(null);
      mockSendInvitation.mockResolvedValue({ id: 'inv-routed' });

      const result = await service.linkedinOutreach('user-1', routingInviteArgs);

      expect(result.success).toBe(true);
      expect(mockGetAccountsWithOwnerIncludingOrgShared).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * ENG-1718 — the handler wiring, on top of linkedInSentInvitationsView.test.ts
 * which pins the decision. The defect was in this dispatch: any body without an
 * `items` array became `{ success: true, data: <that body> }`, so a non-conforming
 * 200 read as "no pending invitations".
 */
describe('ENG-1718: list-sent-invitations never returns a bare empty result', () => {
  let service: AgentModeService;

  beforeEach(() => {
    service = new AgentModeService();
    mockListSentInvitations.mockReset();
    mockGetAllSentInvitationsByAccount.mockReset();
    mockGetAllSentInvitationsByAccount.mockResolvedValue([]);
  });

  it('falls back to our own ledger when the live read returns the non-conforming {}', async () => {
    // The exact body the SDK hands back at its default validateRequestPayloadLevel
    // of 'warn' when the response fails its own schema.
    mockListSentInvitations.mockResolvedValue({});
    mockGetAllSentInvitationsByAccount.mockResolvedValue([
      { invitationId: 'inv-1', invitedUserPublicId: 'monid', invitedUserName: 'Monica DeVreese', sentAt: '2026-07-28T00:00:00Z' },
    ]);

    const result = await service.linkedinOutreach('user-1', {
      action: 'list-sent-invitations',
      account_id: 'test-account-id',
    });

    expect(result.success).toBe(true);
    expect(result.data.source).toBe('cache');
    expect(result.data.liveUnavailable).toBe(true);
    expect(result.data.totalPending).toBe(1);
    expect(result.data.items[0].sent_at).toBe('2026-07-28T00:00:00Z');
    expect(result.data.notice).toEqual(expect.stringContaining('live read was unavailable'));
  });

  it('says "not tracked here" explicitly when live and ledger genuinely agree on none', async () => {
    mockListSentInvitations.mockResolvedValue({ object: 'InvitationList', items: [], cursor: null });

    const result = await service.linkedinOutreach('user-1', {
      action: 'list-sent-invitations',
      account_id: 'test-account-id',
    });

    expect(result.data.source).toBe('none');
    expect(result.data.liveUnavailable).toBeUndefined();
    expect(result.data.notice).toEqual(expect.stringContaining('outside AgentWeb'));
  });

  it('never reports an unreadable backlog as an empty one', async () => {
    mockListSentInvitations.mockRejectedValue(new Error('502 Bad Gateway'));

    const result = await service.linkedinOutreach('user-1', {
      action: 'list-sent-invitations',
      account_id: 'test-account-id',
    });

    expect(result.data.source).toBe('none');
    expect(result.data.liveUnavailable).toBe(true);
    expect(result.data.notice).toEqual(expect.stringContaining('NOT evidence'));
  });

  it('returns live rows with sent_at, which the old trim dropped', async () => {
    mockListSentInvitations.mockResolvedValue({
      object: 'InvitationList',
      cursor: null,
      items: [{
        object: 'InvitationSent',
        id: 'inv-live-1',
        date: '2026-08-20T00:00:00Z',
        parsed_datetime: '2026-08-20T00:00:00Z',
        invited_user: 'Clara Paye',
        invited_user_id: 'uid-1',
        invited_user_public_id: 'clarapaye',
      }],
    });

    const result = await service.linkedinOutreach('user-1', {
      action: 'list-sent-invitations',
      account_id: 'test-account-id',
    });

    expect(result.data.source).toBe('live');
    expect(result.data.items[0].sent_at).toBe('2026-08-20T00:00:00Z');
    expect(result.data.items[0].id).toBe('inv-live-1');
  });
});

// ENG-1719 / ENG-1609 AC #8 — the bulk drain, wired end-to-end through the tool.
// The drain's own arithmetic and checkpointing are pinned in
// linkedInStaleInvitationDrain.test.ts; this pins the tool wiring: ownership,
// pacing through the real pacer, and the shape the model actually receives.
describe('withdraw-stale-invitations (ENG-1719)', () => {
  let drainService: AgentModeService;
  const DAY = 24 * 60 * 60 * 1000;
  const pendingRow = (publicId: string, ageDays: number) => ({
    accountId: 'test-account-id',
    invitedUserPublicId: publicId,
    publicProfileUrl: `https://www.linkedin.com/in/${publicId}/`,
    invitationId: `inv-${publicId}`,
    invitedUserName: publicId.toUpperCase(),
    invitationText: '',
    sentAt: new Date(Date.now() - ageDays * DAY).toISOString(),
    syncedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    __resetWritePacerForTests();
    drainService = new AgentModeService();
    mockUpdateAccountConfig.mockImplementation(async (...args: any[]) => {
      const mutation = args[3];
      if (typeof mutation === 'function') mutation({});
    });
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id', userId: 'user-1' },
    ]);
    mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
      { platform: 'unipile', account_id: 'test-account-id' },
    ]);
    mockIsAccountConnected.mockResolvedValue(true);
    mockCancelInvitation.mockResolvedValue({ ok: true });
    mockDeleteSentInvitationByInvitationId.mockResolvedValue(1);
    mockRecordInviteWithdrawnInCrm.mockResolvedValue(null);
  });

  const drain = (args: any) => (drainService as any).linkedinOutreach(
    'user-1',
    { action: 'withdraw-stale-invitations', account_id: 'test-account-id', ...args },
  );

  it('AC #1: withdraws the stale backlog in ONE call, oldest first', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([
      pendingRow('fresh', 2), pendingRow('older', 40), pendingRow('oldest', 90),
    ]);

    const result = await drain({ older_than_days: 14 });

    expect(result.success).toBe(true);
    expect(mockCancelInvitation).toHaveBeenCalledTimes(2);
    expect(mockCancelInvitation).toHaveBeenNthCalledWith(1, 'inv-oldest', 'test-account-id');
    expect(mockCancelInvitation).toHaveBeenNthCalledWith(2, 'inv-older', 'test-account-id');
    expect(result.data.withdrawn).toHaveLength(2);
    expect(result.data.stopReason).toBe('completed');
    expect(result.data.notice).toContain('Withdrew 2 invitations older than 14 days');
  });

  it('AC #4: drops the ledger row and records CRM provenance for each withdrawal', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([pendingRow('old', 40)]);

    await drain({ older_than_days: 14, list_id: 'list_test123' });

    expect(mockDeleteSentInvitationByInvitationId).toHaveBeenCalledWith('test-account-id', 'inv-old');
    expect(mockRecordInviteWithdrawnInCrm).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      accountId: 'test-account-id',
      invitationId: 'inv-old',
      listId: 'list_test123',
      linkedinUrl: 'https://www.linkedin.com/in/old/',
    }));
  });

  it('refuses an account the caller does not own or share', async () => {
    mockGetAccountsWithOwnerIncludingOrgShared.mockResolvedValue([]);

    const result = await drain({ older_than_days: 14 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('is not connected to your profile');
    expect(mockCancelInvitation).not.toHaveBeenCalled();
  });

  it('rejects a missing or nonsensical age threshold rather than draining everything', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([pendingRow('old', 40)]);

    for (const bad of [undefined, 0, -5, 'soon']) {
      const result = await drain({ older_than_days: bad });
      expect(result.success).toBe(false);
      expect(result.error).toContain('older_than_days');
    }
    expect(mockCancelInvitation).not.toHaveBeenCalled();
  });

  it('AC #2: stops at the real hourly pacing ceiling and reports how far it got', async () => {
    process.env.LINKEDIN_WRITE_MAX_PER_HOUR = '2';
    try {
      __resetWritePacerForTests();
      mockGetAllSentInvitationsByAccount.mockResolvedValue([
        pendingRow('a', 90), pendingRow('b', 80), pendingRow('c', 70), pendingRow('d', 60),
      ]);

      const result = await drain({ older_than_days: 14 });

      expect(result.success).toBe(true);
      expect(mockCancelInvitation).toHaveBeenCalledTimes(2);
      expect(result.data.stopReason).toBe('paced');
      expect(result.data.withdrawn).toHaveLength(2);
      expect(result.data.remainingStale).toBe(2);
      expect(result.data.notice).toContain('at its write-pacing limit');
    } finally {
      delete process.env.LINKEDIN_WRITE_MAX_PER_HOUR;
      __resetWritePacerForTests();
    }
  });

  it('AC #3: a drain does not consume the account\'s daily invite budget', async () => {
    process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX = '30';
    try {
      mockGetAllSentInvitationsByAccount.mockResolvedValue([
        pendingRow('a', 90), pendingRow('b', 80), pendingRow('c', 70),
      ]);

      await drain({ older_than_days: 14 });

      // Every persisted config mutation from a drain leaves daily_volume.invite
      // untouched — withdrawals are account maintenance, not send volume.
      const mutations = mockUpdateAccountConfig.mock.calls
        .map((call: any[]) => call[3])
        .filter((fn: any) => typeof fn === 'function')
        .map((fn: any) => fn({ daily_volume: { invite: { count: 4, windowStartedAt: Date.now() } } }));
      mutations.forEach((m: any) => {
        expect(m?.updates?.daily_volume?.invite?.count ?? 4).toBe(4);
      });
    } finally {
      delete process.env.LINKEDIN_DAILY_INVITE_ABSOLUTE_MAX;
    }
  });

  it('reports an empty backlog honestly instead of returning a bare empty result', async () => {
    mockGetAllSentInvitationsByAccount.mockResolvedValue([]);

    const result = await drain({ older_than_days: 30 });

    expect(result.success).toBe(true);
    expect(result.data.withdrawn).toEqual([]);
    expect(result.data.notice).toContain('Withdrew nothing older than 30 days');
    expect(mockCancelInvitation).not.toHaveBeenCalled();
  });
});
