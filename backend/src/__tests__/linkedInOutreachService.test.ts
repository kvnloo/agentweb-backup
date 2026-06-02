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
        send: jest.fn().mockResolvedValue({ provider_id: 'provider-123' })
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

    it('should reject with a character-limit error when message exceeds 300 chars', async () => {
      const longMessage = 'a'.repeat(301);
      await expect(
        linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, longMessage)
      ).rejects.toThrow('too long');

      // The Unipile API must never be called for an oversized message
      expect(mockUnipileClient.users.sendInvitation).not.toHaveBeenCalled();
    });

    it('should reject for a message of exactly 301 chars', async () => {
      const longMessage = 'a'.repeat(301);
      await expect(
        linkedInOutreachService.sendInvitation('account-id', 'provider-id', false, longMessage)
      ).rejects.toThrow('300 characters');
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

    it('returns user account_id when user has a connected unipile account', async () => {
      mockGetAccountsByUserId.mockResolvedValue([
        { platform: 'unipile', account_id: 'user-acct-123' },
      ]);

      const result = await linkedInOutreachService.resolveAccountId('user-1');

      expect(result).toBe('user-acct-123');
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
