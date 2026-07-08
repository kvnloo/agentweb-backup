import { linkedInOutreachService } from '../services/linkedInOutreachService';
import { UnipileClient } from 'unipile-node-sdk';
import { getUnipileCredentials } from '../utils/secretsManager';

jest.mock('unipile-node-sdk');
jest.mock('../utils/secretsManager');
jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn()
  },
  // crmDb is used by the unipileSearchParamServiceFactory when searchPeople
  // lazy-inits the resolver (worker-subprocess path).
  crmDb: {
    getEnrichmentCacheItem: jest.fn().mockResolvedValue(null),
    putEnrichmentCacheItem: jest.fn().mockResolvedValue(undefined),
  }
}));

const mockUpsertConnections = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/unipileConnectionsDb', () => ({
  upsertConnections: (...a: any[]) => mockUpsertConnections(...a),
  normalizeLinkedInUrl: (url: string) =>
    url ? url.trim().toLowerCase().replace(/\/?$/, '/') : '',
}));

const mockGetUnipileCredentials = getUnipileCredentials as jest.MockedFunction<typeof getUnipileCredentials>;

describe('LinkedInOutreachService', () => {
  let mockUnipileClient: jest.Mocked<UnipileClient>;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Reset the internal cached credentials to ensure isolated tests
    // using ts-ignore because they are private properties
    // @ts-ignore
    linkedInOutreachService.cachedDsn = null;
    // @ts-ignore
    linkedInOutreachService.cachedApiKey = null;
    // @ts-ignore
    linkedInOutreachService.client = null;
    // Reset the per-account invitation cooldown breaker so tests don't leak state
    // (the service is a module singleton shared across tests).
    // @ts-ignore
    linkedInOutreachService.invitationCooldownUntil = new Map();

    mockGetUnipileCredentials.mockResolvedValue({
      dsn: 'api.unipile.com',
      apiKey: 'test-api-key'
    });

    // Setup mock UnipileClient
    mockUnipileClient = {
      users: {
        sendInvitation: jest.fn().mockResolvedValue({ id: 'invitation-id' }),
        getProfile: jest.fn().mockResolvedValue({ network_distance: 'SECOND_DEGREE', is_open_profile: false }),
        getAllRelations: jest.fn().mockResolvedValue({
          object: 'RelationList',
          items: [{ provider_id: 'rel-1', first_name: 'Alice', last_name: 'Smith' }],
          cursor: null
        }),
        getAllInvitationsSent: jest.fn().mockResolvedValue({
          object: 'InvitationList',
          items: [{ id: 'inv-1', provider_id: 'inv-target-1', status: 'PENDING' }],
          cursor: null
        }),
        cancelInvitationSent: jest.fn().mockResolvedValue({ success: true }),
        getCompanyProfile: jest.fn().mockResolvedValue({
          name: 'Acme Corp',
          industry: 'Technology',
          provider_id: 'company-123'
        })
      },
      messaging: {
        startNewChat: jest.fn().mockResolvedValue({ id: 'chat-id' }),
        getAllChatsFromAttendee: jest.fn().mockResolvedValue({ items: [{ id: 'chat-id-123' }] }),
        getAllMessagesFromChat: jest.fn().mockResolvedValue({ items: [] }),
      },
      request: {
        // Default profile lookup echoes back the same id the caller passed, so
        // canonicalisation is a no-op in the baseline tests. Tests that exercise a
        // public-identifier → URN resolution override this per-call.
        send: jest.fn().mockResolvedValue({ provider_id: 'provider-id' })
      },
      account: {
        getOne: jest.fn().mockResolvedValue({ status: 'CONNECTED' }),
      }
    } as unknown as jest.Mocked<UnipileClient>;

    (UnipileClient as jest.Mock).mockImplementation(() => mockUnipileClient);
  });

  describe('credentials caching', () => {
    it('should cache credentials and not call getUnipileCredentials on subsequent calls', async () => {
      // First call should fetch credentials
      await linkedInOutreachService.getClient();
      expect(mockGetUnipileCredentials).toHaveBeenCalledTimes(1);
      
      // Second call should use cached client/credentials
      await linkedInOutreachService.getClient();
      expect(mockGetUnipileCredentials).toHaveBeenCalledTimes(1); // Still 1
    });

    it('should normalize the DSN to include https://', async () => {
      mockGetUnipileCredentials.mockResolvedValueOnce({
        dsn: 'api.unipile.com', // no protocol
        apiKey: 'test-api-key'
      });
      const url = await linkedInOutreachService.getApiUrl();
      expect(url).toBe('https://api.unipile.com');
    });
  });

  describe('sendInvitation', () => {
    it('should send an invitation without a default message if none is provided', async () => {
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);

      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith({
        account_id: 'account-id',
        provider_id: 'provider-id',
        message: undefined // verifies that no default message is added
      });
    });

    it('should send an invitation with the provided message', async () => {
      const customMessage = 'Hey, let us connect!';
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, customMessage);

      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith({
        account_id: 'account-id',
        provider_id: 'provider-id',
        message: customMessage
      });
    });

    it('resolves a public-identifier target to the canonical provider_id before inviting', async () => {
      // ENG-213: the agent passed a public identifier (vanity slug) as provider_id.
      // Unipile's invite endpoint requires the canonical member URN — a public
      // identifier is rejected with a generic "Invalid parameters". The profile
      // lookup accepts either form and reveals the canonical provider_id, so the
      // invite must be sent with that resolved id, not the raw slug.
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'SECOND_DEGREE',
        public_identifier: 'william-kwak',
        provider_id: 'ACoAABcanonicalURN',
      });

      await linkedInOutreachService.sendInvitation('account-id', 'william-kwak', false, 'Hi William');

      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith({
        account_id: 'account-id',
        provider_id: 'ACoAABcanonicalURN',
        message: 'Hi William',
      });
    });

    it('falls back to the passed provider_id when the profile lookup reveals no canonical id', async () => {
      // If the connection-check profile fetch returns no provider_id we must still
      // attempt the invite with what the caller gave us (resilient fallback), never
      // send an undefined provider_id.
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'SECOND_DEGREE',
      });

      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, 'Hello');

      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith({
        account_id: 'account-id',
        provider_id: 'provider-id',
        message: 'Hello',
      });
    });

    it('should reject with a helpful error when target is already a 1st-degree connection (FIRST_DEGREE)', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'FIRST_DEGREE'
      });

      await expect(
        linkedInOutreachService.sendInvitation('account-id', 'provider-id', false)
      ).rejects.toThrow('already connected');

      expect(mockUnipileClient.users.sendInvitation).not.toHaveBeenCalled();
    });

    it('should reject with a helpful error when target is already a 1st-degree connection (DISTANCE_1 raw format)', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'DISTANCE_1'
      });

      await expect(
        linkedInOutreachService.sendInvitation('account-id', 'provider-id', false)
      ).rejects.toThrow('already connected');

      expect(mockUnipileClient.users.sendInvitation).not.toHaveBeenCalled();
    });

    it('self-heals the connection cache when the live API reports an already-connected lead', async () => {
      // Live profile lookup says FIRST_DEGREE but the cache was missing this lead
      // (that's why the CRM offered the invite). The guard must upsert it into the cache.
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'FIRST_DEGREE',
        public_identifier: 'ramesh-lakshminarayanan-72657298',
        member_id: 'ACoAABS6hI4',
        public_profile_url: 'https://www.linkedin.com/in/ramesh-lakshminarayanan-72657298/',
        first_name: 'Ramesh',
        last_name: 'Lakshminarayanan',
        created_at: 1776011706000,
      });

      await expect(
        linkedInOutreachService.sendInvitation('account-id', 'provider-id', false)
      ).rejects.toThrow('already connected');

      expect(mockUpsertConnections).toHaveBeenCalledWith([
        expect.objectContaining({
          accountId: 'account-id',
          memberId: 'ACoAABS6hI4',
          publicProfileUrl: 'https://www.linkedin.com/in/ramesh-lakshminarayanan-72657298/',
          firstName: 'Ramesh',
          lastName: 'Lakshminarayanan',
        }),
      ]);
      expect(mockUnipileClient.users.sendInvitation).not.toHaveBeenCalled();
    });

    it('still throws already-connected even if the self-heal cache write fails', async () => {
      mockUpsertConnections.mockRejectedValueOnce(new Error('dynamo down'));
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'FIRST_DEGREE',
        public_identifier: 'someone',
      });

      await expect(
        linkedInOutreachService.sendInvitation('account-id', 'provider-id', false)
      ).rejects.toThrow('already connected');
      expect(mockUnipileClient.users.sendInvitation).not.toHaveBeenCalled();
    });

    it('does NOT write to the cache when target is SECOND_DEGREE', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'SECOND_DEGREE',
      });

      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);
      expect(mockUpsertConnections).not.toHaveBeenCalled();
    });

    it('should send invitation when target is SECOND_DEGREE (not yet connected)', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'SECOND_DEGREE'
      });

      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalled();
    });

    it('should send invitation when target is OUT_OF_NETWORK', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'OUT_OF_NETWORK'
      });

      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalled();
    });

    it('should proceed with invite when connection status check fails (resilient fallback)', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(new Error('404 Not Found'));

      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalled();
    });

    it('should throw with human-readable message (not SDK class name) when Unipile returns already_invited_recently', async () => {
      const unipileError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: {
          status: 422,
          type: 'errors/already_invited_recently',
          title: 'Should delay new invitation to this recipient',
          detail: 'An invitation has already been sent recently to this recipient. Please try again later.'
        }
      });
      (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValue(unipileError);

      const thrown = await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false).catch(e => e);
      expect(thrown.message).toBe('Should delay new invitation to this recipient');
      expect(thrown.message).not.toBe('UnsuccessfulRequestError');
      expect((thrown as any).structuredError).toBeDefined();
    });

    it('auto-trims an over-limit message to the default 300-char cap instead of failing', async () => {
      const longMessage = 'a'.repeat(301);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, longMessage);

      // The invite is still sent — never fail on length — but with a trimmed note.
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message.length).toBeLessThanOrEqual(300);
    });

    it('trims a 301-char single-token message to exactly the 300-char cap', async () => {
      const longMessage = 'a'.repeat(301);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, longMessage);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message).toBe('a'.repeat(300));
    });

    it('should accept a message of exactly 300 chars', async () => {
      const maxMessage = 'a'.repeat(300);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, maxMessage);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ message: maxMessage })
      );
    });

    it('should accept a message of 299 chars', async () => {
      const shortMessage = 'a'.repeat(299);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, shortMessage);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalled();
    });

    it('should accept invitation with no message (undefined)', async () => {
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, undefined);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalled();
    });

    // ─── Per-account char limit (free 200 / premium 300) ──────────────────────
    it('auto-trims a 201-char message to within 200 chars when maxChars is 200 (free account)', async () => {
      const msg = 'a'.repeat(201);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 200);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message.length).toBeLessThanOrEqual(200);
    });

    it('accepts a 200-char message when maxChars is 200 (free account) unchanged', async () => {
      const msg = 'a'.repeat(200);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 200);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ message: msg })
      );
    });

    it('accepts a 300-char message when maxChars is 300 (premium account) unchanged', async () => {
      const msg = 'a'.repeat(300);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 300);
      expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledWith(
        expect.objectContaining({ message: msg })
      );
    });

    it('trims on a word boundary, preserving whole words and not cutting mid-word', async () => {
      // 21 words of "word" (4 chars) + single spaces = build a >200-char message.
      const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
      const msg = words.join(' '); // well over 200 chars
      expect(msg.length).toBeGreaterThan(200);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 200);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message.length).toBeLessThanOrEqual(200);
      // No partial trailing token: the trimmed note must be a whitespace-delimited
      // prefix of the original (every retained token appears verbatim in the source).
      expect(msg.startsWith(sent.message)).toBe(true);
      expect(sent.message.endsWith(' ')).toBe(false);
    });

    it('does not trim a message that is exactly at the limit', async () => {
      const msg = 'a'.repeat(200);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 200);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message).toBe(msg);
    });

    it('never leaves a dangling lone surrogate when the cut lands inside an emoji', async () => {
      // 199 'a' + 😀 (a surrogate pair, 2 code units) = length 201; cutting at 200
      // would split the emoji. The trimmed note must contain no lone surrogate.
      const msg = 'a'.repeat(199) + '😀';
      expect(msg.length).toBe(201);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 200);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message.length).toBeLessThanOrEqual(200);
      const last = sent.message.charCodeAt(sent.message.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      // The whole emoji was dropped (it didn't fit), leaving the 199 'a's.
      expect(sent.message).toBe('a'.repeat(199));
    });

    it('prefers a sentence boundary over a word boundary when it keeps >=60% of the limit', async () => {
      // First sentence ends with a period inside the budget (>=120 of 200); the
      // trailing sentence pushes the note over 200. Trim should drop the incomplete
      // trailing sentence and keep whole sentence(s), not cut mid-sentence on a word.
      const s1 = 'Ana, your activation-funnel work is the sharpest take I have seen all year and I genuinely keep coming back to re-read it.';
      const s2 = ' Also wanted to add a long trailing tail that pushes us well past the limit so a trim must happen now.';
      const msg = s1 + s2;
      expect(s1.length).toBeGreaterThanOrEqual(Math.floor(200 * 0.6));
      expect(s1.length).toBeLessThanOrEqual(200);
      expect(msg.length).toBeGreaterThan(200);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 200);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message).toBe(s1);
    });

    it('falls back to a word boundary when the only sentence end is below the 60% threshold', async () => {
      // A tiny leading sentence ("Hi.") sits far below 60% of the limit, so honouring
      // it would throw away most of the note. Trim must ignore it and use the word boundary.
      const tail = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
      const msg = `Hi. ${tail}`;
      expect(msg.length).toBeGreaterThan(200);
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, msg, 200);
      const sent = (mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0];
      expect(sent.message.length).toBeLessThanOrEqual(200);
      // Did NOT collapse to the early "Hi." sentence.
      expect(sent.message.length).toBeGreaterThan(100);
      // Still a clean whitespace-delimited prefix, no trailing space.
      expect(msg.startsWith(sent.message)).toBe(true);
      expect(sent.message.endsWith(' ')).toBe(false);
    });

    // ─── Account-level invitation cooldown breaker (ENG-126) ──────────────────
    describe('account-level "Cannot resend yet" cooldown breaker', () => {
      // Shape a Unipile rejection the way handleError expects (body.title becomes
      // the normalized message when no body.message is present).
      function cannotResendYetError() {
        return Object.assign(new Error('UnsuccessfulRequestError'), {
          body: {
            status: 422,
            type: 'errors/cannot_resend_yet',
            title: 'Cannot resend yet',
          },
        });
      }

      it('short-circuits the NEXT invite to any recipient after a "Cannot resend yet" — no second Unipile call', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValueOnce(cannotResendYetError());

        // First send hits the cap and rejects.
        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false)
        ).rejects.toThrow(/cannot resend yet/i);
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);

        // Second send is a DIFFERENT, fresh recipient — must be short-circuited by
        // the breaker: no new sendInvitation call, no profile-fetch round-trip.
        const requestCallsBefore = (mockUnipileClient.request.send as jest.Mock).mock.calls.length;
        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-2', false)
        ).rejects.toThrow(/cannot resend yet/i);

        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1); // still 1
        expect((mockUnipileClient.request.send as jest.Mock).mock.calls.length).toBe(requestCallsBefore);
      });

      it('does NOT arm the account-wide breaker on a per-recipient "Should delay new invitation" rejection', async () => {
        const perRecipient = Object.assign(new Error('UnsuccessfulRequestError'), {
          body: {
            status: 422,
            type: 'errors/already_invited_recently',
            title: 'Should delay new invitation to this recipient',
          },
        });
        (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValueOnce(perRecipient);

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false)
        ).rejects.toThrow(/should delay new invitation/i);

        // A different recipient must still be attempted (breaker not armed).
        await linkedInOutreachService.sendInvitation('acct-A', 'recipient-2', false);
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(2);
      });

      it('scopes the breaker per account — a throttled account does not block a different one', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValueOnce(cannotResendYetError());

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false)
        ).rejects.toThrow(/cannot resend yet/i);

        // acct-B is untouched — its invite must go through to Unipile.
        await linkedInOutreachService.sendInvitation('acct-B', 'recipient-1', false);
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(2);
      });

      it('self-heals: a fresh invite is attempted again once the cooldown window elapses', async () => {
        // Arm an ALREADY-EXPIRED cooldown for the account, then confirm the next
        // send clears it and actually calls Unipile.
        // @ts-ignore private map
        linkedInOutreachService.invitationCooldownUntil.set('acct-A', Date.now() - 1);

        await linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false);
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);
        // @ts-ignore private map — the stale entry was removed.
        expect(linkedInOutreachService.invitationCooldownUntil.has('acct-A')).toBe(false);
      });

      it('a successful send clears a previously armed breaker for that account', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock)
          .mockRejectedValueOnce(cannotResendYetError()) // first: hit the cap
          .mockResolvedValue({ id: 'invitation-id' });     // later: succeeds

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false)
        ).rejects.toThrow(/cannot resend yet/i);
        // @ts-ignore private map — breaker armed.
        expect(linkedInOutreachService.invitationCooldownUntil.has('acct-A')).toBe(true);

        // Simulate the window elapsing so the next call proceeds and succeeds.
        // @ts-ignore private map
        linkedInOutreachService.invitationCooldownUntil.set('acct-A', Date.now() - 1);
        await linkedInOutreachService.sendInvitation('acct-A', 'recipient-2', false);

        // @ts-ignore private map — success cleared the breaker.
        expect(linkedInOutreachService.invitationCooldownUntil.has('acct-A')).toBe(false);
      });
    });

    describe('note-quota "Invalid parameters" fallback (ENG-213)', () => {
      // Free LinkedIn accounts may only attach a note to ~5 invitations per month,
      // but can send ~150 note-less invites per week. Once the note quota is spent,
      // LinkedIn rejects every note-bearing invite with a generic "Invalid parameters"
      // (422) even though the provider_id/recipient are perfectly valid.
      function invalidParametersError() {
        return Object.assign(new Error('UnsuccessfulRequestError'), {
          body: {
            status: 422,
            type: 'errors/invalid_parameters',
            title: 'Invalid parameters',
          },
        });
      }

      it('retries WITHOUT the note when a note-bearing invite is rejected with "Invalid parameters", and succeeds', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock)
          .mockRejectedValueOnce(invalidParametersError()) // note-bearing invite rejected
          .mockResolvedValueOnce({ id: 'invitation-id' });  // note-less retry succeeds

        const result = await linkedInOutreachService.sendInvitation(
          'acct-A', 'recipient-1', false, 'Hi there — would love to connect!'
        );

        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(2);
        // First attempt carried the note.
        expect((mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[0][0]).toEqual(
          expect.objectContaining({ message: 'Hi there — would love to connect!' })
        );
        // Retry dropped the note — and carries the canonical provider_id resolved by
        // the connection-check profile fetch (the mock returns 'provider-id'), not the
        // raw slug, since the invite endpoint only accepts the canonical URN (ENG-213).
        expect((mockUnipileClient.users.sendInvitation as jest.Mock).mock.calls[1][0]).toEqual(
          expect.objectContaining({ account_id: 'acct-A', provider_id: 'provider-id', message: undefined })
        );
        expect(result).toEqual(expect.objectContaining({ note_dropped: true }));
      });

      it('does NOT retry when there was no note — a bare invite rejected with "Invalid parameters" bubbles up', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValueOnce(invalidParametersError());

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false)
        ).rejects.toThrow(/invalid parameters/i);
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);
      });

      it('surfaces the error when the note-less retry ALSO fails (e.g. genuinely invalid provider_id)', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock)
          .mockRejectedValueOnce(invalidParametersError())  // note-bearing attempt
          .mockRejectedValueOnce(invalidParametersError()); // note-less retry also fails

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false, 'Let us connect!')
        ).rejects.toThrow(/invalid parameters/i);
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(2);
      });

      it('does NOT retry note-less on "Cannot resend yet" — that cap is not fixed by dropping the note', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValueOnce(
          Object.assign(new Error('UnsuccessfulRequestError'), {
            body: { status: 422, type: 'errors/cannot_resend_yet', title: 'Cannot resend yet' },
          })
        );

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false, 'A personalised note')
        ).rejects.toThrow(/cannot resend yet/i);
        // Only the single note-bearing attempt — no note-less retry.
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);
        // The account-wide cooldown breaker is still armed.
        // @ts-ignore private map
        expect(linkedInOutreachService.invitationCooldownUntil.has('acct-A')).toBe(true);
      });

      it('does NOT retry note-less on a per-recipient "Should delay new invitation" rejection', async () => {
        (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValueOnce(
          Object.assign(new Error('UnsuccessfulRequestError'), {
            body: { status: 422, type: 'errors/already_invited_recently', title: 'Should delay new invitation to this recipient' },
          })
        );

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false, 'A personalised note')
        ).rejects.toThrow(/should delay new invitation/i);
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);
      });

      it('does NOT retry note-less when the rejection text contains BOTH "Invalid parameters" and an exclusion phrase — the exclusion wins', async () => {
        // If LinkedIn's body pairs the generic "Invalid parameters" wording with a
        // cap/duplicate signal, dropping the note cannot fix it: the exclusion branch
        // must suppress the note-less retry (proving the exclusion regex is decisive,
        // not incidental). Without the exclusion this would fall through and retry.
        (mockUnipileClient.users.sendInvitation as jest.Mock).mockRejectedValueOnce(
          Object.assign(new Error('UnsuccessfulRequestError'), {
            body: { status: 422, type: 'errors/cannot_resend_yet', title: 'Invalid parameters — cannot resend yet' },
          })
        );

        await expect(
          linkedInOutreachService.sendInvitation('acct-A', 'recipient-1', false, 'A personalised note')
        ).rejects.toThrow(/cannot resend yet/i);
        // Single note-bearing attempt only — the exclusion suppressed the note-less retry.
        expect(mockUnipileClient.users.sendInvitation).toHaveBeenCalledTimes(1);
        // And the account-wide cooldown breaker armed off the "cannot resend yet" phrase.
        // @ts-ignore private map
        expect(linkedInOutreachService.invitationCooldownUntil.has('acct-A')).toBe(true);
      });
    });
  });

  describe('sendMessage', () => {
    it('should reject with a helpful error when target is SECOND_DEGREE connection', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'SECOND_DEGREE',
        is_open_profile: false
      });

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');

      expect(mockUnipileClient.messaging.startNewChat).not.toHaveBeenCalled();
    });

    it('should reject with a helpful error when target is OUT_OF_NETWORK', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'OUT_OF_NETWORK',
        is_open_profile: false
      });

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');

      expect(mockUnipileClient.messaging.startNewChat).not.toHaveBeenCalled();
    });

    it('should reject with a helpful error when target is THIRD_DEGREE connection', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'THIRD_DEGREE',
        is_open_profile: false
      });

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');

      expect(mockUnipileClient.messaging.startNewChat).not.toHaveBeenCalled();
    });

    it('should send message successfully when target is FIRST_DEGREE connection', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'FIRST_DEGREE',
        is_open_profile: false
      });

      const result = await linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!');

      expect(mockUnipileClient.messaging.startNewChat).toHaveBeenCalledWith({
        account_id: 'account-id',
        attendees_ids: ['provider-id'],
        text: 'Hello!'
      });
      expect(result).toEqual({ id: 'chat-id' });
    });

    it('should send message successfully when target is DISTANCE_1 (raw format)', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'DISTANCE_1',
        is_open_profile: false
      });

      const result = await linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!');

      expect(mockUnipileClient.messaging.startNewChat).toHaveBeenCalledWith({
        account_id: 'account-id',
        attendees_ids: ['provider-id'],
        text: 'Hello!'
      });
      expect(result).toEqual({ id: 'chat-id' });
    });

    it('should send message successfully when target has open profile (SECOND_DEGREE but is_open_profile=true)', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'SECOND_DEGREE',
        is_open_profile: true
      });

      const result = await linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!');

      expect(mockUnipileClient.messaging.startNewChat).toHaveBeenCalledWith({
        account_id: 'account-id',
        attendees_ids: ['provider-id'],
        text: 'Hello!'
      });
      expect(result).toEqual({ id: 'chat-id' });
    });

    it('should surface a helpful error when startNewChat returns no_connection_with_recipient (pre-flight bypass)', async () => {
      // Simulate pre-flight check incorrectly passing but API rejecting
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({
        network_distance: 'FIRST_DEGREE',
        is_open_profile: false
      });
      const unipileError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: {
          status: 422,
          type: 'errors/no_connection_with_recipient',
          title: 'Recipient cannot be reached',
          detail: 'The recipient appears not to be first degree connection.'
        }
      });
      (mockUnipileClient.messaging.startNewChat as jest.Mock).mockRejectedValue(unipileError);

      await expect(
        linkedInOutreachService.sendMessage('account-id', 'provider-id', false, 'Hello!')
      ).rejects.toThrow('not a 1st-degree connection');
    });
  });

  describe('searchPeople', () => {
    it('should call POST /linkedin/search with classic api and keyword params', async () => {
      const mockResults = {
        object: 'SearchResults',
        items: [{ provider_id: 'p-1', first_name: 'John', last_name: 'Doe' }],
        cursor: null
      };
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce(mockResults);

      const result = await linkedInOutreachService.searchPeople('account-123', {
        keywords: 'software engineer'
      });

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'POST',
        path: ['linkedin', 'search'],
        parameters: { account_id: 'account-123' },
        headers: { 'Content-Type': 'application/json' },
        body: {
          api: 'classic',
          category: 'people',
          keywords: 'software engineer'
        }
      });
      expect(result).toEqual(mockResults);
    });

    it('should put title and company into advanced_keywords', async () => {
      const mockResults = { object: 'SearchResults', items: [], cursor: null };
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce(mockResults);

      await linkedInOutreachService.searchPeople('account-123', {
        keywords: 'engineer',
        title: 'CTO',
        company: 'Acme'
      });

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'POST',
        path: ['linkedin', 'search'],
        parameters: { account_id: 'account-123' },
        headers: { 'Content-Type': 'application/json' },
        body: {
          api: 'classic',
          category: 'people',
          keywords: 'engineer',
          advanced_keywords: { title: 'CTO', company: 'Acme' }
        }
      });
    });

    it('should support URL-based search (overrides all other body params)', async () => {
      const mockResults = { object: 'SearchResults', items: [], cursor: null };
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce(mockResults);

      await linkedInOutreachService.searchPeople('account-123', {
        url: 'https://www.linkedin.com/search/results/people/?keywords=cto'
      });

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'POST',
        path: ['linkedin', 'search'],
        parameters: { account_id: 'account-123' },
        headers: { 'Content-Type': 'application/json' },
        body: {
          url: 'https://www.linkedin.com/search/results/people/?keywords=cto'
        }
      });
    });

    it('should support pagination via cursor only', async () => {
      const mockResults = { object: 'SearchResults', items: [], cursor: 'next-page' };
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce(mockResults);

      await linkedInOutreachService.searchPeople('account-123', {
        cursor: 'page-2-cursor'
      });

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'POST',
        path: ['linkedin', 'search'],
        parameters: { account_id: 'account-123' },
        headers: { 'Content-Type': 'application/json' },
        body: {
          cursor: 'page-2-cursor'
        }
      });
    });

    // Regression: when paginating a URL-based search, importLeadsFromSearch
    // passes BOTH url and cursor on every iteration after the first. The
    // cursor encodes the URL itself, so Unipile resumes correctly when given
    // the cursor. If we instead send `{ url }`, Unipile re-runs the search
    // from page 1 on every iteration, which made the find-leads top-up loop
    // grind through 20 identical pages and report "200 found / 1 imported".
    it('cursor takes precedence over url when both are provided (URL pagination)', async () => {
      const mockResults = { object: 'SearchResults', items: [], cursor: 'page-3-cursor' };
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce(mockResults);

      await linkedInOutreachService.searchPeople('account-123', {
        url: 'https://www.linkedin.com/search/results/people/?keywords=cmo',
        cursor: 'page-2-cursor',
      });

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'POST',
        path: ['linkedin', 'search'],
        parameters: { account_id: 'account-123' },
        headers: { 'Content-Type': 'application/json' },
        body: { cursor: 'page-2-cursor' },
      });
    });

    it('should throw a structured error on API failure', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 400, title: 'Bad search request' }
      });
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(apiError);

      await expect(
        linkedInOutreachService.searchPeople('account-123', { keywords: '' })
      ).rejects.toThrow('Bad search request');
    });

    // Regression: the unipile-node-sdk's RequestSender calls response.blob() (not
    // response.json()) whenever Unipile's error response isn't application/json —
    // e.g. a dead LinkedIn session surfaced as a plain-text/HTML body. Its
    // UnsuccessfulRequestError.message is always ''. Before this fix, that combo
    // fell through every extraction branch in handleError() and collapsed to the
    // generic "Unknown error", which is exactly what was observed in production
    // for session-drop failures ("Unknown error" with no actionable detail).
    it('surfaces the raw response text instead of "Unknown error" when Unipile returns a non-JSON error body', async () => {
      const blobBody = new Blob(['No client session'], { type: 'text/plain' });
      const apiError = Object.assign(new Error(''), { body: blobBody });
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(apiError);

      const thrown = await linkedInOutreachService
        .searchPeople('account-123', { keywords: 'cto' })
        .catch((e) => e);

      expect(thrown.message).toBe('No client session');
      expect(thrown.message).not.toBe('Unknown error');
    });

    it('falls back to "Unknown error" when the non-JSON error body is empty', async () => {
      const blobBody = new Blob([''], { type: 'text/plain' });
      const apiError = Object.assign(new Error(''), { body: blobBody });
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(apiError);

      const thrown = await linkedInOutreachService
        .searchPeople('account-123', { keywords: 'cto' })
        .catch((e) => e);

      expect(thrown.message).toBe('Unknown error');
    });

    // ─── Stage 2: ID-based filters + auto-resolve free-text via UnipileSearchParamService
    describe('id-based filters and auto-resolve', () => {
      const {
        setUnipileSearchParamServiceForTesting,
        __resetUnipileSearchParamServiceForTesting,
      } = require('../services/unipileSearchParamService');

      let mockResolveTopId: jest.Mock;

      beforeEach(() => {
        __resetUnipileSearchParamServiceForTesting();
        mockResolveTopId = jest.fn();
        setUnipileSearchParamServiceForTesting({
          resolveTopId: mockResolveTopId,
          resolve: jest.fn(),
        } as any);
        (mockUnipileClient.request.send as jest.Mock).mockResolvedValue({
          object: 'SearchResults', items: [], cursor: null,
        });
      });

      afterEach(() => {
        __resetUnipileSearchParamServiceForTesting();
      });

      it('passes pre-resolved company_id through without calling resolver', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'engineer',
          company_id: '1441',
        });
        expect(mockResolveTopId).not.toHaveBeenCalled();
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.company).toEqual(['1441']);
        expect(sentBody.advanced_keywords?.company).toBeUndefined();
      });

      it('auto-resolves free-text company to id and uses id in body', async () => {
        mockResolveTopId.mockResolvedValueOnce('1441');
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'engineer',
          company: 'Microsoft',
        });
        expect(mockResolveTopId).toHaveBeenCalledWith(
          'account-123',
          expect.objectContaining({ type: 'COMPANY', keywords: 'Microsoft' }),
        );
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.company).toEqual(['1441']);
        expect(sentBody.advanced_keywords?.company).toBeUndefined();
      });

      it('falls back to free-text advanced_keywords.company when resolver returns null', async () => {
        mockResolveTopId.mockResolvedValueOnce(null);
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'engineer',
          company: 'NonexistentCo',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.company).toBeUndefined();
        expect(sentBody.advanced_keywords).toEqual({ company: 'NonexistentCo' });
      });

      it('falls back to free-text when resolver throws (search must not fail)', async () => {
        mockResolveTopId.mockRejectedValueOnce(new Error('resolver dead'));
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'engineer',
          company: 'Acme',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.company).toBeUndefined();
        expect(sentBody.advanced_keywords).toEqual({ company: 'Acme' });
      });

      it('prefers company_id when both company and company_id are provided', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'engineer',
          company: 'Microsoft',
          company_id: '999',
        });
        expect(mockResolveTopId).not.toHaveBeenCalled();
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.company).toEqual(['999']);
        expect(sentBody.advanced_keywords?.company).toBeUndefined();
      });

      it('passes location_id, industry_id, school_id with correct shapes', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'engineer',
          location_id: '103644278',
          industry_id: '6',
          school_id: '12345',
        });
        expect(mockResolveTopId).not.toHaveBeenCalled();
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.location).toEqual(['103644278']);
        expect(sentBody.industry).toEqual({ include: ['6'], exclude: [] });
        expect(sentBody.school).toEqual(['12345']);
      });

      it('continues to work with no resolver registered (singleton not initialized)', async () => {
        __resetUnipileSearchParamServiceForTesting(); // clear singleton
        // Resolver lazy-inits via the factory; the mocked Unipile request.send
        // returns the default shape (no `items`), so resolveTopId normalizes to
        // empty candidates and we fall back to free-text in advanced_keywords.
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'engineer',
          company: 'Acme',
        });
        const calls = (mockUnipileClient.request.send as jest.Mock).mock.calls;
        // The POST /linkedin/search call is the LAST one (resolver GETs come first).
        const searchCall = calls.find(c => c[0]?.method === 'POST' && c[0]?.path?.[1] === 'search');
        expect(searchCall).toBeDefined();
        const sentBody = searchCall![0].body;
        expect(sentBody.company).toBeUndefined();
        expect(sentBody.advanced_keywords).toEqual({ company: 'Acme' });
      });

      // Regression test for the worker-subprocess bug: searchPeople used to
      // import getUnipileSearchParamService from the bare service file (which
      // throws when the singleton isn't pre-initialized). In a forked worker
      // (e.g. generateMarketingResponseWorker) the singleton was never set, so
      // the resolver always silently returned null and free-text fell through
      // to Unipile's weak advanced_keywords match. Caught in production by
      // Playwright when an SF-Bay-Area location filter returned mostly Seattle
      // and NYC leads. The fix routes the import through the factory's lazy
      // getter so the singleton initializes on first access.
      it('lazy-inits the resolver via the factory when singleton is unset (worker subprocess path)', async () => {
        __resetUnipileSearchParamServiceForTesting(); // simulate fresh worker
        // Mock ONE call (the resolver's GET /search/parameters) to return a real
        // candidate; THEN the search call gets the default empty shape.
        (mockUnipileClient.request.send as jest.Mock)
          .mockResolvedValueOnce({ items: [{ id: '90000084', title: 'San Francisco Bay Area' }] })
          .mockResolvedValueOnce({ object: 'SearchResults', items: [], cursor: null });

        await linkedInOutreachService.searchPeople('account-123', {
          location: 'San Francisco Bay Area',
        });

        const calls = (mockUnipileClient.request.send as jest.Mock).mock.calls;
        // First call: GET /linkedin/search/parameters (resolver lazy-init)
        expect(calls[0][0]).toMatchObject({
          method: 'GET',
          path: ['linkedin', 'search', 'parameters'],
          parameters: expect.objectContaining({ type: 'LOCATION', keywords: 'San Francisco Bay Area' }),
        });
        // Second call: POST /linkedin/search with the resolved id at top-level body.location
        expect(calls[1][0].body.location).toEqual(['90000084']);
        expect(calls[1][0].body.advanced_keywords?.location).toBeUndefined();
      });
    });

    // ─── Auto-injected keywords (Unipile classic search rejects calls without
    // one of keywords/search_url/cursor; backend synthesizes from filters)
    describe('keywords auto-injection for filter-only calls', () => {
      const {
        setUnipileSearchParamServiceForTesting,
        __resetUnipileSearchParamServiceForTesting,
      } = require('../services/unipileSearchParamService');

      beforeEach(() => {
        __resetUnipileSearchParamServiceForTesting();
        setUnipileSearchParamServiceForTesting({
          resolveTopId: jest.fn().mockResolvedValue('1441'),
          resolve: jest.fn(),
        } as any);
        (mockUnipileClient.request.send as jest.Mock).mockResolvedValue({
          object: 'SearchResults', items: [], cursor: null,
        });
      });

      afterEach(() => {
        __resetUnipileSearchParamServiceForTesting();
      });

      it('synthesizes keywords from title when caller omits keywords', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          title: 'CTO',
          company: 'Microsoft',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.keywords).toBe('CTO');
      });

      it('falls back to company when title is absent', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          company: 'Microsoft',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.keywords).toBe('Microsoft');
      });

      it('user-provided keywords always wins over auto-injection', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          keywords: 'AI engineer',
          title: 'CTO',
          company: 'Microsoft',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.keywords).toBe('AI engineer');
      });

      it('falls back through the precedence chain title > company > location > industry > school', async () => {
        // Only school provided
        await linkedInOutreachService.searchPeople('account-123', {
          school: 'Stanford',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.keywords).toBe('Stanford');
      });

      it('does not inject keywords on URL-based search', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          url: 'https://www.linkedin.com/search/results/people/?keywords=foo',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.keywords).toBeUndefined();
        expect(sentBody.url).toBeDefined();
      });

      it('does not inject keywords on cursor pagination', async () => {
        await linkedInOutreachService.searchPeople('account-123', {
          cursor: 'next-page-token',
        });
        const sentBody = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].body;
        expect(sentBody.keywords).toBeUndefined();
        expect(sentBody.cursor).toBe('next-page-token');
      });
    });
  });

  describe('searchParameters', () => {
    it('should call GET /linkedin/search/parameters with type and keywords', async () => {
      const mockResp = {
        items: [
          { id: '1441', title: 'Microsoft', subtitle: 'Software Development' },
          { id: '99', title: 'Microsoft Research' },
        ],
      };
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce(mockResp);

      const result = await linkedInOutreachService.searchParameters('account-123', {
        type: 'COMPANY',
        keywords: 'Microsoft',
      });

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'GET',
        path: ['linkedin', 'search', 'parameters'],
        parameters: { account_id: 'account-123', type: 'COMPANY', keywords: 'Microsoft' },
      });
      expect(result).toEqual(mockResp);
    });

    it('should pass limit when provided', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({ items: [] });

      await linkedInOutreachService.searchParameters('account-123', {
        type: 'LOCATION',
        keywords: 'San Francisco',
        limit: 5,
      });

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'GET',
        path: ['linkedin', 'search', 'parameters'],
        parameters: { account_id: 'account-123', type: 'LOCATION', keywords: 'San Francisco', limit: 5 },
      });
    });

    it('should throw a structured error on API failure', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 429, title: 'Rate limited' },
      });
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(apiError);

      await expect(
        linkedInOutreachService.searchParameters('account-123', { type: 'COMPANY', keywords: 'X' })
      ).rejects.toThrow('Rate limited');
    });
  });

  describe('getProfile', () => {
    it('should return full profile for a provider_id', async () => {
      const mockProfile = {
        provider_id: 'john-doe',
        first_name: 'John',
        last_name: 'Doe',
        headline: 'Software Engineer',
        network_distance: 'SECOND_DEGREE',
        is_open_profile: false
      };
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce(mockProfile);

      const result = await linkedInOutreachService.getProfile('john-doe', 'account-123');

      expect(mockUnipileClient.request.send).toHaveBeenCalledWith({
        method: 'GET',
        path: ['users', 'john-doe'],
        parameters: { account_id: 'account-123', linkedin_sections: '*' }
      });
      expect(result).toEqual(mockProfile);
    });

    it('passes linkedin_sections=* so all profile sections (experience/education/skills) are returned', async () => {
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({ provider_id: 'x' });
      await linkedInOutreachService.getProfile('john-doe', 'account-123');
      const callArgs = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0];
      expect(callArgs.parameters.linkedin_sections).toBe('*');
    });

    it('connection-degree check (used by sendInvitation pre-flight) does NOT request sections — viewer-relative call kept lean', async () => {
      // The check is a network_distance lookup; sections would just waste credits.
      (mockUnipileClient.request.send as jest.Mock).mockResolvedValueOnce({ network_distance: 'SECOND_DEGREE' });
      await linkedInOutreachService.sendInvitation('account-id', 'provider-id', false);
      // The first request.send call here is the connection check, not the invitation itself.
      const params = (mockUnipileClient.request.send as jest.Mock).mock.calls[0][0].parameters;
      expect(params.linkedin_sections).toBeUndefined();
      expect(params.account_id).toBe('account-id');
    });

    it('should throw a structured error when profile is not found', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 404, title: 'Profile not found' }
      });
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(apiError);

      await expect(
        linkedInOutreachService.getProfile('nonexistent', 'account-123')
      ).rejects.toThrow('Profile not found');
    });

    it('should throw a structured error on auth failure', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 401, title: 'Unauthorized' }
      });
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(apiError);

      await expect(
        linkedInOutreachService.getProfile('some-id', 'bad-account')
      ).rejects.toThrow('Unauthorized');
    });
  });

  describe('profile lookup timeout + retry (ENG-144)', () => {
    const TIMEOUT_MS = 30_000;
    const hang = () => new Promise(() => {}); // never resolves — simulates a stuck Unipile session

    afterEach(() => {
      jest.useRealTimers();
    });

    it('times out a hung profile lookup instead of blocking indefinitely, and retries once', async () => {
      jest.useFakeTimers();
      const profile = { provider_id: 'john-doe', first_name: 'John' };
      // First call hangs (stuck session), second call (the automatic retry) succeeds.
      (mockUnipileClient.request.send as jest.Mock)
        .mockImplementationOnce(() => hang())
        .mockResolvedValueOnce(profile);

      const resultPromise = linkedInOutreachService.getProfile('john-doe', 'account-123');
      // Advance past the first internal timeout so the retry fires.
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1);

      await expect(resultPromise).resolves.toEqual(profile);
      expect(mockUnipileClient.request.send).toHaveBeenCalledTimes(2);
    });

    it('rejects with a TIMEOUT_ERROR classification when both the initial call and the retry hang', async () => {
      jest.useFakeTimers();
      (mockUnipileClient.request.send as jest.Mock).mockImplementation(() => hang());

      const resultPromise = linkedInOutreachService.getProfile('john-doe', 'account-123');
      const assertion = expect(resultPromise).rejects.toMatchObject({
        structuredError: { classification: 'TIMEOUT_ERROR' },
      });
      // Two timeouts: the initial lookup and its single retry.
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
      await assertion;
      expect(mockUnipileClient.request.send).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on a real (non-timeout) API error — surfaces it immediately', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 404, title: 'Profile not found' },
      });
      (mockUnipileClient.request.send as jest.Mock).mockRejectedValueOnce(apiError);

      await expect(
        linkedInOutreachService.getProfile('nonexistent', 'account-123')
      ).rejects.toThrow('Profile not found');
      expect(mockUnipileClient.request.send).toHaveBeenCalledTimes(1);
    });

    it('emits greppable CloudWatch markers (PROFILE_LOOKUP_TIMEOUT per attempt + PROFILE_LOOKUP_FAILED_TIMEOUT) so a future hang is diagnosable by time window', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.useFakeTimers();
      (mockUnipileClient.request.send as jest.Mock).mockImplementation(() => hang());

      const resultPromise = linkedInOutreachService.getProfile('john-doe', 'account-123');
      const captured = resultPromise.catch(() => {}); // swallow the eventual rejection
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1); // attempt 1 times out
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1); // retry times out
      await captured;

      const lines = warnSpy.mock.calls.map((c) => `${c[0]} ${c[1] ?? ''}`);
      // One per-attempt timeout marker for each of the 2 attempts…
      expect(lines.filter((l) => l.includes('PROFILE_LOOKUP_TIMEOUT'))).toHaveLength(2);
      // …plus a single terminal marker naming the identifier + account for grepping.
      const terminal = lines.find((l) => l.includes('PROFILE_LOOKUP_FAILED_TIMEOUT'));
      expect(terminal).toBeDefined();
      expect(terminal).toContain('john-doe');
      expect(terminal).toContain('account-123');

      warnSpy.mockRestore();
    });

    it('surfaced timeout error is classified as a retryable "timeout" by the agent error pipeline', async () => {
      // Guards the cross-module contract: the timeout message emitted here must
      // match toolErrorClassifier's timeout regex so the agent tells the model
      // "retry once, then stop" instead of hanging. If the message ever changes
      // and stops matching, this fails loudly.
      const { classifyToolErrorClass } = require('../utils/toolErrorClassifier');
      const { isRetryableErrorClass } = require('../services/agentMode/core/errorRetryability');
      jest.useFakeTimers();
      (mockUnipileClient.request.send as jest.Mock).mockImplementation(() => hang());

      const resultPromise = linkedInOutreachService.getProfile('john-doe', 'account-123');
      const captured = resultPromise.catch((e: any) => e);
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
      const err = await captured;

      const cls = classifyToolErrorClass(err);
      expect(cls).toBe('timeout');
      expect(isRetryableErrorClass(cls)).toBe(true);
    });
  });

  describe('listConnections', () => {
    it('should return connections list', async () => {
      const mockRelations = {
        object: 'RelationList',
        items: [
          { provider_id: 'rel-1', first_name: 'Alice', last_name: 'Smith' },
          { provider_id: 'rel-2', first_name: 'Bob', last_name: 'Jones' }
        ],
        cursor: null
      };
      mockUnipileClient.users.getAllRelations = jest.fn().mockResolvedValue(mockRelations);

      const result = await linkedInOutreachService.listConnections('account-123');

      expect(mockUnipileClient.users.getAllRelations).toHaveBeenCalledWith({
        account_id: 'account-123'
      });
      expect(result).toEqual(mockRelations);
    });

    it('should pass cursor for pagination', async () => {
      const mockRelations = { object: 'RelationList', items: [], cursor: null };
      mockUnipileClient.users.getAllRelations = jest.fn().mockResolvedValue(mockRelations);

      await linkedInOutreachService.listConnections('account-123', 'cursor-abc');

      expect(mockUnipileClient.users.getAllRelations).toHaveBeenCalledWith({
        account_id: 'account-123',
        cursor: 'cursor-abc'
      });
    });

    it('should throw on API failure', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 500, title: 'Internal server error' }
      });
      mockUnipileClient.users.getAllRelations = jest.fn().mockRejectedValue(apiError);

      await expect(
        linkedInOutreachService.listConnections('account-123')
      ).rejects.toThrow('Internal server error');
    });
  });

  describe('listSentInvitations', () => {
    it('should return sent invitations list', async () => {
      const mockInvitations = {
        object: 'InvitationList',
        items: [{ id: 'inv-1', provider_id: 'target-1', status: 'PENDING' }],
        cursor: null
      };
      mockUnipileClient.users.getAllInvitationsSent = jest.fn().mockResolvedValue(mockInvitations);

      const result = await linkedInOutreachService.listSentInvitations('account-123');

      expect(mockUnipileClient.users.getAllInvitationsSent).toHaveBeenCalledWith({
        account_id: 'account-123'
      });
      expect(result).toEqual(mockInvitations);
    });

    it('should pass cursor for pagination', async () => {
      const mockInvitations = { object: 'InvitationList', items: [], cursor: null };
      mockUnipileClient.users.getAllInvitationsSent = jest.fn().mockResolvedValue(mockInvitations);

      await linkedInOutreachService.listSentInvitations('account-123', 'cursor-xyz');

      expect(mockUnipileClient.users.getAllInvitationsSent).toHaveBeenCalledWith({
        account_id: 'account-123',
        cursor: 'cursor-xyz'
      });
    });

    it('should throw on API failure', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 403, title: 'Forbidden' }
      });
      mockUnipileClient.users.getAllInvitationsSent = jest.fn().mockRejectedValue(apiError);

      await expect(
        linkedInOutreachService.listSentInvitations('account-123')
      ).rejects.toThrow('Forbidden');
    });
  });

  describe('getCompanyProfile', () => {
    it('should return company profile', async () => {
      const mockCompany = {
        name: 'Acme Corp',
        industry: 'Technology',
        provider_id: 'company-123'
      };
      mockUnipileClient.users.getCompanyProfile = jest.fn().mockResolvedValue(mockCompany);

      const result = await linkedInOutreachService.getCompanyProfile('company-123', 'account-123');

      expect(mockUnipileClient.users.getCompanyProfile).toHaveBeenCalledWith({
        account_id: 'account-123',
        identifier: 'company-123'
      });
      expect(result).toEqual(mockCompany);
    });

    it('should throw when company is not found', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 404, title: 'Company not found' }
      });
      mockUnipileClient.users.getCompanyProfile = jest.fn().mockRejectedValue(apiError);

      await expect(
        linkedInOutreachService.getCompanyProfile('bad-id', 'account-123')
      ).rejects.toThrow('Company not found');
    });

    it('should throw on rate limit', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 429, title: 'Rate limit exceeded' }
      });
      mockUnipileClient.users.getCompanyProfile = jest.fn().mockRejectedValue(apiError);

      await expect(
        linkedInOutreachService.getCompanyProfile('company-123', 'account-123')
      ).rejects.toThrow('Rate limit exceeded');
    });
  });

  describe('cancelInvitation', () => {
    it('should cancel a sent invitation', async () => {
      mockUnipileClient.users.cancelInvitationSent = jest.fn().mockResolvedValue({ success: true });

      const result = await linkedInOutreachService.cancelInvitation('inv-123', 'account-123');

      expect(mockUnipileClient.users.cancelInvitationSent).toHaveBeenCalledWith({
        account_id: 'account-123',
        invitation_id: 'inv-123'
      });
      expect(result).toEqual({ success: true });
    });

    it('should throw when invitation is not found', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 404, title: 'Invitation not found' }
      });
      mockUnipileClient.users.cancelInvitationSent = jest.fn().mockRejectedValue(apiError);

      await expect(
        linkedInOutreachService.cancelInvitation('bad-id', 'account-123')
      ).rejects.toThrow('Invitation not found');
    });

    it('should throw on server error', async () => {
      const apiError = Object.assign(new Error('UnsuccessfulRequestError'), {
        body: { status: 500, title: 'Server error' }
      });
      mockUnipileClient.users.cancelInvitationSent = jest.fn().mockRejectedValue(apiError);

      await expect(
        linkedInOutreachService.cancelInvitation('inv-123', 'account-123')
      ).rejects.toThrow('Server error');
    });
  });

  describe('isAccountConnected timeout guard (ENG-144)', () => {
    const CHECK_MS = 15_000;
    const hang = () => new Promise(() => {}); // never resolves — stuck upstream

    beforeEach(() => {
      // @ts-ignore private cache — clear so the live probe actually runs
      linkedInOutreachService.connectedStatusCache = new Map();
    });
    afterEach(() => jest.useRealTimers());

    it('treats a hung account probe as NOT connected instead of blocking the caller', async () => {
      jest.useFakeTimers();
      (mockUnipileClient.account.getOne as jest.Mock).mockImplementation(() => hang());

      const settled = linkedInOutreachService.isAccountConnected('acct-hang').then((v) => ({ v }));
      await jest.advanceTimersByTimeAsync(CHECK_MS + 1);

      expect(await settled).toEqual({ v: false });
    });

    it('treats a hung self-profile probe as NOT connected', async () => {
      jest.useFakeTimers();
      (mockUnipileClient.account.getOne as jest.Mock).mockResolvedValue({
        connection_params: { im: { publicIdentifier: 'me' } },
      });
      (mockUnipileClient.request.send as jest.Mock).mockImplementation(() => hang());

      const settled = linkedInOutreachService.isAccountConnected('acct-hang-2').then((v) => ({ v }));
      await jest.advanceTimersByTimeAsync(CHECK_MS + 1);

      expect(await settled).toEqual({ v: false });
    });
  });

  describe('resolveAccountId', () => {
    const mockGetAccountsByUserId = jest.fn();
    const mockGetSetting = jest.fn();

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../services/connectedAccountsDb', () => ({
        getAccountsByUserId: mockGetAccountsByUserId,
      }));
      jest.doMock('../services/settingsService', () => ({
        settingsService: { getSetting: mockGetSetting },
      }));
    });

    it('returns user account_id when user has a live connected unipile account', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'user-acct-123' },
      ]);
      const liveSpy = jest.spyOn(linkedInOutreachService, 'isAccountConnected').mockResolvedValue(true);

      const result = await linkedInOutreachService.resolveAccountId('user-1');

      expect(result).toBe('user-acct-123');
      liveSpy.mockRestore();
    });

    it('skips a dead own account and returns the next LIVE own account (no site-wide fallback)', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'own-dead' },
        { platform: 'unipile', account_id: 'own-live' },
      ]);
      const liveSpy = jest
        .spyOn(linkedInOutreachService, 'isAccountConnected')
        .mockImplementation(async (id: string) => id === 'own-live');

      const result = await linkedInOutreachService.resolveAccountId('user-1');

      expect(result).toBe('own-live');
      // Never consulted site-wide settings because a live own account existed.
      expect(mockGetSetting).not.toHaveBeenCalled();
      liveSpy.mockRestore();
    });

    it('falls back to a site-wide account ONLY after every own account is dead', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'own-dead-1' },
        { platform: 'unipile', account_id: 'own-dead-2' },
      ]);
      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify([{ account_id: 'site-live', enabled: true }]),
      });
      const liveSpy = jest
        .spyOn(linkedInOutreachService, 'isAccountConnected')
        .mockImplementation(async (id: string) => id === 'site-live');

      const result = await linkedInOutreachService.resolveAccountId('user-1');

      expect(result).toBe('site-live');
      liveSpy.mockRestore();
    });

    it('returns null when the user has own accounts but ALL of them (and no site-wide) are dead', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'own-dead-1' },
      ]);
      mockGetSetting.mockResolvedValue(null);
      const liveSpy = jest.spyOn(linkedInOutreachService, 'isAccountConnected').mockResolvedValue(false);

      const result = await linkedInOutreachService.resolveAccountId('user-1');

      expect(result).toBeNull();
      liveSpy.mockRestore();
    });

    it('returns site-wide account_id when user has no account but site-wide accounts are configured', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify([
          { account_id: 'site-acct-abc', enabled: true },
        ]),
      });

      const result = await linkedInOutreachService.resolveAccountId('user-2');

      expect(result).toBe('site-acct-abc');
    });

    it('returns null when user has no account and site-wide accounts are not configured', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue(null);

      const result = await linkedInOutreachService.resolveAccountId('user-3');

      expect(result).toBeNull();
    });

    it('returns null when site-wide accounts list is empty', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue({ settingValue: JSON.stringify([]) });

      const result = await linkedInOutreachService.resolveAccountId('user-4');

      expect(result).toBeNull();
    });

    it('returns null when all site-wide accounts are disabled', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify([
          { account_id: 'site-acct-disabled', enabled: false },
        ]),
      });

      const result = await linkedInOutreachService.resolveAccountId('user-5');

      expect(result).toBeNull();
    });
  });

  describe('resolveUserOwnedAccountId', () => {
    const mockGetAccountsByUserId = jest.fn();
    const mockGetSetting = jest.fn();

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../services/connectedAccountsDb', () => ({
        getAccountsByUserId: mockGetAccountsByUserId,
      }));
      jest.doMock('../services/settingsService', () => ({
        settingsService: { getSetting: mockGetSetting },
      }));
    });

    it('returns the user own account_id when the user has a connected unipile account', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'user-acct-123' },
      ]);

      const result = await linkedInOutreachService.resolveUserOwnedAccountId('user-1');

      expect(result).toBe('user-acct-123');
    });

    it('returns null when the user has no own account, even if site-wide accounts exist', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify([
          { account_id: 'site-acct-abc', enabled: true },
        ]),
      });

      const result = await linkedInOutreachService.resolveUserOwnedAccountId('user-2');

      // No site-wide fallback — must NOT borrow a shared account.
      expect(result).toBeNull();
      expect(mockGetSetting).not.toHaveBeenCalled();
    });

    it('returns null when getAccountsByUserId throws', async () => {
      mockGetAccountsByUserId.mockRejectedValue(new Error('db down'));

      const result = await linkedInOutreachService.resolveUserOwnedAccountId('user-3');

      expect(result).toBeNull();
    });

    it('ignores non-unipile accounts', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'linkedin', account_id: 'li-ads-1' },
        { platform: 'google', account_id: 'g-1' },
      ]);

      const result = await linkedInOutreachService.resolveUserOwnedAccountId('user-4');

      expect(result).toBeNull();
    });
  });

  describe('getInviteCharLimitForAccount', () => {
    const mockGetAccountsByUserIdIncludingOrgShared = jest.fn();

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../services/connectedAccountsDb', () => ({
        getAccountsByUserIdIncludingOrgShared: mockGetAccountsByUserIdIncludingOrgShared,
      }));
    });

    it('returns 300 for a Premium account (config.is_premium === true)', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'acct-1', config: { is_premium: true } },
      ]);
      const limit = await linkedInOutreachService.getInviteCharLimitForAccount('user-1', 'acct-1');
      expect(limit).toBe(300);
    });

    it('returns 200 for a free account (is_premium absent/false)', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'acct-1', config: {} },
      ]);
      const limit = await linkedInOutreachService.getInviteCharLimitForAccount('user-1', 'acct-1');
      expect(limit).toBe(200);
    });

    it('returns 200 when the account is not found for the user', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockResolvedValue([
        { platform: 'unipile', account_id: 'other-acct', config: { is_premium: true } },
      ]);
      const limit = await linkedInOutreachService.getInviteCharLimitForAccount('user-1', 'acct-1');
      expect(limit).toBe(200);
    });

    it('returns 200 (free, never over-promises) when the lookup throws', async () => {
      mockGetAccountsByUserIdIncludingOrgShared.mockRejectedValue(new Error('db down'));
      const limit = await linkedInOutreachService.getInviteCharLimitForAccount('user-1', 'acct-1');
      expect(limit).toBe(200);
    });
  });

  describe('getMessagesWithContact', () => {
    it('uses getAllChatsFromAttendee to find chat then getAllMessagesFromChat for messages', async () => {
      const mockMessages = [
        { id: 'm1', provider_id: 'prov-1', text: 'Hello', is_sender: 1, is_event: 0, sender_id: 'acct-1', timestamp: '2026-01-01T10:00:00.000Z' },
        { id: 'm2', provider_id: 'prov-2', text: 'Hi back!', is_sender: 0, is_event: 0, sender_id: 'lead-1', timestamp: '2026-01-01T10:01:00.000Z' },
      ];
      (mockUnipileClient.messaging.getAllChatsFromAttendee as jest.Mock).mockResolvedValueOnce({
        items: [{ id: 'chat-456' }],
      });
      (mockUnipileClient.messaging.getAllMessagesFromChat as jest.Mock).mockResolvedValueOnce({
        items: mockMessages,
      });

      const result = await linkedInOutreachService.getMessagesWithContact('attendee-id', 'acct-1');

      expect(mockUnipileClient.messaging.getAllChatsFromAttendee).toHaveBeenCalledWith({
        attendee_id: 'attendee-id',
        account_id: 'acct-1',
        limit: 1,
      });
      expect(mockUnipileClient.messaging.getAllMessagesFromChat).toHaveBeenCalledWith(
        expect.objectContaining({ chat_id: 'chat-456', limit: 100 }),
      );
      expect(result).toHaveLength(2);
      expect(result[0].provider_id).toBe('prov-1');
      expect(result[0].is_sender).toBe(1);
      expect(result[1].is_sender).toBe(0);
    });

    it('returns empty array when no chat found for attendee', async () => {
      (mockUnipileClient.messaging.getAllChatsFromAttendee as jest.Mock).mockResolvedValueOnce({
        items: [],
      });

      const result = await linkedInOutreachService.getMessagesWithContact('unknown-attendee', 'acct-1');

      expect(result).toEqual([]);
      expect(mockUnipileClient.messaging.getAllMessagesFromChat).not.toHaveBeenCalled();
    });

    it('returns empty array when the resolved chat has no id (avoids account-wide message dump)', async () => {
      (mockUnipileClient.messaging.getAllChatsFromAttendee as jest.Mock).mockResolvedValueOnce({
        items: [{ id: undefined }],
      });

      const result = await linkedInOutreachService.getMessagesWithContact('attendee-id', 'acct-1');

      expect(result).toEqual([]);
      // Never call getAllMessagesFromChat with an empty chat_id — Unipile would
      // return account-wide messages and dump unrelated conversations onto one lead.
      expect(mockUnipileClient.messaging.getAllMessagesFromChat).not.toHaveBeenCalled();
    });

    it('filters out is_event=1 system messages', async () => {
      (mockUnipileClient.messaging.getAllChatsFromAttendee as jest.Mock).mockResolvedValueOnce({
        items: [{ id: 'chat-789' }],
      });
      (mockUnipileClient.messaging.getAllMessagesFromChat as jest.Mock).mockResolvedValueOnce({
        items: [
          { id: 'm1', provider_id: 'prov-1', text: 'Real message', is_sender: 1, is_event: 0, sender_id: 'acct', timestamp: '2026-01-01T10:00:00.000Z' },
          { id: 'm2', provider_id: 'prov-sys', text: null, is_sender: 0, is_event: 1, sender_id: 'system', timestamp: '2026-01-01T10:00:00.000Z' },
        ],
      });

      const result = await linkedInOutreachService.getMessagesWithContact('attendee-id', 'acct-1');

      expect(result).toHaveLength(1);
      expect(result[0].provider_id).toBe('prov-1');
    });
  });

  describe('resolveAccountIdForEnrichment', () => {
    const mockGetAccountsByUserId = jest.fn();
    const mockGetSetting = jest.fn();

    beforeEach(() => {
      jest.resetModules();
      jest.doMock('../services/connectedAccountsDb', () => ({
        getAccountsByUserId: mockGetAccountsByUserId,
      }));
      jest.doMock('../services/settingsService', () => ({
        settingsService: { getSetting: mockGetSetting },
      }));
      // Clear per-user resolved-account cache between tests
      // @ts-ignore
      linkedInOutreachService.resolvedAccountCache.clear();
      // @ts-ignore
      linkedInOutreachService.connectedStatusCache.clear();
    });

    it('skips dead user accounts and returns first live one', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'dead-acct' },
        { platform: 'unipile', account_id: 'live-acct' },
      ]);
      jest.spyOn(linkedInOutreachService, 'isAccountConnected')
        .mockImplementation(async (id) => id === 'live-acct');

      const result = await linkedInOutreachService.resolveAccountIdForEnrichment('user-1');

      expect(result).toBe('live-acct');
    });

    it('falls back to site-wide account when all user accounts are dead', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'dead-user-acct' },
      ]);
      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify([
          { account_id: 'site-acct-1', enabled: true },
        ]),
      });
      jest.spyOn(linkedInOutreachService, 'isAccountConnected')
        .mockImplementation(async (id) => id === 'site-acct-1');

      const result = await linkedInOutreachService.resolveAccountIdForEnrichment('user-2');

      expect(result).toBe('site-acct-1');
    });

    it('skips disconnected site-wide accounts', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue({
        settingValue: JSON.stringify([
          { account_id: 'dead-site', enabled: true },
          { account_id: 'live-site', enabled: true },
        ]),
      });
      jest.spyOn(linkedInOutreachService, 'isAccountConnected')
        .mockImplementation(async (id) => id === 'live-site');

      const result = await linkedInOutreachService.resolveAccountIdForEnrichment('user-3');

      expect(result).toBe('live-site');
    });

    it('returns null when no live accounts exist anywhere', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue(null);

      const result = await linkedInOutreachService.resolveAccountIdForEnrichment('user-4');

      expect(result).toBeNull();
    });

    it('caches the resolved account and skips db on subsequent calls', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'cached-acct' },
      ]);
      jest.spyOn(linkedInOutreachService, 'isAccountConnected').mockResolvedValue(true);

      await linkedInOutreachService.resolveAccountIdForEnrichment('user-5');
      const second = await linkedInOutreachService.resolveAccountIdForEnrichment('user-5');

      expect(second).toBe('cached-acct');
      expect(mockGetAccountsByUserId).toHaveBeenCalledTimes(1);
    });

    it('does not cache null — retries on every call when no account found', async () => {
      mockGetAccountsByUserId.mockResolvedValue([]);
      mockGetSetting.mockResolvedValue(null);

      await linkedInOutreachService.resolveAccountIdForEnrichment('user-6');
      await linkedInOutreachService.resolveAccountIdForEnrichment('user-6');

      expect(mockGetAccountsByUserId).toHaveBeenCalledTimes(2);
    });

    it('invalidateResolvedAccount clears cache so next call re-resolves', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'acct-7' },
      ]);
      jest.spyOn(linkedInOutreachService, 'isAccountConnected').mockResolvedValue(true);

      await linkedInOutreachService.resolveAccountIdForEnrichment('user-7');
      linkedInOutreachService.invalidateResolvedAccount('user-7');
      await linkedInOutreachService.resolveAccountIdForEnrichment('user-7');

      expect(mockGetAccountsByUserId).toHaveBeenCalledTimes(2);
    });

    it('ignores non-unipile connected accounts', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'gmail', account_id: 'gmail-acct' },
      ]);
      mockGetSetting.mockResolvedValue(null);
      jest.spyOn(linkedInOutreachService, 'isAccountConnected').mockResolvedValue(true);

      const result = await linkedInOutreachService.resolveAccountIdForEnrichment('user-8');

      expect(result).toBeNull();
      expect(linkedInOutreachService.isAccountConnected).not.toHaveBeenCalled();
    });
  });
});
