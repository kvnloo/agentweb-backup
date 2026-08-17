/**
 * ENG-1198 — linkedin_outreach must not silently fall back to a platform-wide
 * shared Unipile account. When the user's own account is disconnected/absent
 * and a read action (search-people, get-profile) borrows a site-wide shared
 * account instead, the response must say so explicitly (usedSharedAccount +
 * sharedAccountId), because network_distance and "already connected/pending"
 * inferences computed by that shared account are NOT relative to the user's
 * own network. Results with public_identifier === 'undefined' (LinkedIn's
 * anonymized/out-of-network placeholder) must not be returned as fake
 * /in/undefined profile links either.
 */

jest.mock('../services/unipileProfileServiceFactory', () => ({
  getUnipileProfileService: jest.fn(),
}));

jest.mock('../services/unipileCompanyServiceFactory', () => ({
  getUnipileCompanyService: jest.fn(),
}));

jest.mock('../services/unipileSearchParamServiceFactory', () => ({
  getUnipileSearchParamService: jest.fn(),
}));

const mockGetConnection = jest.fn().mockResolvedValue(null);
jest.mock('../services/unipileConnectionsDb', () => ({
  getConnectionByProfileUrlAndAccount: (...args: any[]) => mockGetConnection(...args),
}));

const mockResolveAccountIdWithSource = jest.fn();
const mockListUserOwnedUnipileAccountIds = jest.fn().mockResolvedValue([]);
const mockSearchPeople = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountIdWithSource: (...args: any[]) => mockResolveAccountIdWithSource(...args),
    listUserOwnedUnipileAccountIds: (...args: any[]) => mockListUserOwnedUnipileAccountIds(...args),
    searchPeople: (...args: any[]) => mockSearchPeople(...args),
    isAccountConnected: jest.fn().mockResolvedValue(true),
    probeAccountSession: jest.fn().mockResolvedValue('connected'),
    probeSearchCapability: jest.fn().mockResolvedValue('ok'),
    clearStatusCache: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({ crmDb: {} }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/gmailService', () => ({ gmailService: { sendEmail: jest.fn() } }));

import { AgentModeService } from '../services/agentModeService';
import * as unipileProfileServiceFactory from '../services/unipileProfileServiceFactory';
import * as unipileCompanyServiceFactory from '../services/unipileCompanyServiceFactory';
import * as unipileSearchParamServiceFactory from '../services/unipileSearchParamServiceFactory';

const mockGetService = unipileProfileServiceFactory.getUnipileProfileService as jest.Mock;
const mockGetCompanyService = unipileCompanyServiceFactory.getUnipileCompanyService as jest.Mock;
const mockGetSearchParamService = unipileSearchParamServiceFactory.getUnipileSearchParamService as jest.Mock;

describe('AgentModeService.linkedinOutreach — shared-account fallback disclosure (ENG-1198)', () => {
  let service: AgentModeService;
  const userId = 'user-1';

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  describe('search-people', () => {
    it('flags usedSharedAccount + sharedAccountId when the fallback resolved a site-wide account', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'shared-acct-1', usedSharedAccount: true });
      mockSearchPeople.mockResolvedValue({
        items: [{ provider_id: 'p1', public_identifier: 'jsmith', network_distance: 'SECOND_DEGREE', public_profile_url: 'https://www.linkedin.com/in/jsmith' }],
        cursor: null,
      });

      const result = await service.linkedinOutreach(userId, {
        action: 'search-people',
        keywords: 'CMO healthtech',
      });

      expect(mockResolveAccountIdWithSource).toHaveBeenCalledWith(userId);
      expect(result.success).toBe(true);
      expect(result.data.usedSharedAccount).toBe(true);
      expect(result.data.sharedAccountId).toBe('shared-acct-1');
    });

    it('strips network_distance from items when the account used is a shared account', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'shared-acct-1', usedSharedAccount: true });
      mockSearchPeople.mockResolvedValue({
        items: [{ provider_id: 'p1', public_identifier: 'jsmith', network_distance: 'SECOND_DEGREE', public_profile_url: 'https://www.linkedin.com/in/jsmith' }],
        cursor: null,
      });

      const result = await service.linkedinOutreach(userId, {
        action: 'search-people',
        keywords: 'CMO healthtech',
      });

      expect(result.data.items[0]).not.toHaveProperty('network_distance');
    });

    it('keeps network_distance when the user\'s own account was used', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'own-acct-1', usedSharedAccount: false });
      mockSearchPeople.mockResolvedValue({
        items: [{ provider_id: 'p1', public_identifier: 'jsmith', network_distance: 'SECOND_DEGREE', public_profile_url: 'https://www.linkedin.com/in/jsmith' }],
        cursor: null,
      });

      const result = await service.linkedinOutreach(userId, {
        action: 'search-people',
        keywords: 'CMO healthtech',
      });

      expect(result.data.usedSharedAccount).toBe(false);
      expect(result.data.items[0].network_distance).toBe('SECOND_DEGREE');
    });

    it('filters out anonymized results whose public_identifier is the literal string "undefined"', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'own-acct-1', usedSharedAccount: false });
      mockSearchPeople.mockResolvedValue({
        items: [
          { provider_id: 'p1', public_identifier: 'jsmith', network_distance: 'SECOND_DEGREE', public_profile_url: 'https://www.linkedin.com/in/jsmith' },
          { provider_id: 'p2', public_identifier: 'undefined', network_distance: 'OUT_OF_NETWORK', public_profile_url: 'https://www.linkedin.com/in/undefined' },
        ],
        cursor: null,
      });

      const result = await service.linkedinOutreach(userId, {
        action: 'search-people',
        keywords: 'CMO healthtech',
      });

      expect(result.data.items).toHaveLength(1);
      expect(result.data.items[0].public_identifier).toBe('jsmith');
    });

    it('passes explicit account_id straight through without calling the fallback resolver, but still checks ownership', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
      mockListUserOwnedUnipileAccountIds.mockResolvedValue(['explicit-acct']);

      const result = await service.linkedinOutreach(userId, {
        action: 'search-people',
        account_id: 'explicit-acct',
        keywords: 'marketing',
      });

      expect(mockResolveAccountIdWithSource).not.toHaveBeenCalled();
      expect(mockListUserOwnedUnipileAccountIds).toHaveBeenCalledWith(userId);
      expect(result.data.usedSharedAccount).toBe(false);
    });

    it('flags usedSharedAccount:true when the explicit account_id is not one of the user\'s own accounts (e.g. an echoed-back sharedAccountId)', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });
      mockListUserOwnedUnipileAccountIds.mockResolvedValue(['own-acct-1']);

      const result = await service.linkedinOutreach(userId, {
        action: 'search-people',
        account_id: 'shared-acct-1',
        keywords: 'marketing',
      });

      expect(mockResolveAccountIdWithSource).not.toHaveBeenCalled();
      expect(result.data.usedSharedAccount).toBe(true);
      expect(result.data.sharedAccountId).toBe('shared-acct-1');
    });
  });

  describe('get-profile', () => {
    function stubProfile(rawData: any, fromCache = true) {
      mockGetService.mockReturnValue({
        getProfile: jest.fn().mockResolvedValue({ rawData, fromCache, found: true, checkedAt: '2026-08-16T00:00:00.000Z' }),
      });
    }

    it('flags usedSharedAccount + strips network_distance when the fallback resolved a site-wide account', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'shared-acct-1', usedSharedAccount: true });
      stubProfile({ public_identifier: 'jsmith', first_name: 'J', network_distance: 'THIRD_DEGREE' }, false);

      const result = await service.linkedinOutreach(userId, {
        action: 'get-profile',
        profile_url: 'https://www.linkedin.com/in/jsmith',
      });

      expect(result.success).toBe(true);
      expect(result.data.usedSharedAccount).toBe(true);
      expect(result.data.sharedAccountId).toBe('shared-acct-1');
      expect(result.data).not.toHaveProperty('network_distance');
    });

    it('does not flag usedSharedAccount when the user\'s own account was used', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'own-acct-1', usedSharedAccount: false });
      stubProfile({ public_identifier: 'jsmith', first_name: 'J', network_distance: 'THIRD_DEGREE' }, false);

      const result = await service.linkedinOutreach(userId, {
        action: 'get-profile',
        profile_url: 'https://www.linkedin.com/in/jsmith',
      });

      expect(result.data.usedSharedAccount).toBe(false);
      expect(result.data).not.toHaveProperty('sharedAccountId');
      expect(result.data.network_distance).toBe('THIRD_DEGREE');
    });

    it('omits is_relationship/connected_at (and skips the connection lookup) when the fallback resolved a site-wide account', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'shared-acct-1', usedSharedAccount: true });
      mockGetConnection.mockResolvedValue({ accountId: 'shared-acct-1', connectedAt: 1780960142000 });
      stubProfile({ public_identifier: 'jsmith', first_name: 'J' }, true);

      const result = await service.linkedinOutreach(userId, {
        action: 'get-profile',
        profile_url: 'https://www.linkedin.com/in/jsmith',
      });

      expect(result.success).toBe(true);
      // A shared account's connection state belongs to a stranger, not this
      // user — must not be reconciled/returned as "already connected/pending".
      expect(mockGetConnection).not.toHaveBeenCalled();
      expect(result.data).not.toHaveProperty('is_relationship');
      expect(result.data).not.toHaveProperty('connected_at');
    });

    it('flags anonymized:true and drops the fabricated /in/undefined URL when public_identifier is the literal string "undefined"', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'own-acct-1', usedSharedAccount: false });
      stubProfile({
        public_identifier: 'undefined',
        public_profile_url: 'https://www.linkedin.com/in/undefined',
        first_name: 'Anon',
      }, false);

      const result = await service.linkedinOutreach(userId, {
        action: 'get-profile',
        provider_id: 'ACoAAA-anon',
      });

      expect(result.success).toBe(true);
      expect(result.data.anonymized).toBe(true);
      expect(result.data).not.toHaveProperty('public_profile_url');
    });
  });

  describe('get-company', () => {
    function stubCompany(rawData: any) {
      mockGetCompanyService.mockReturnValue({
        getCompany: jest.fn().mockResolvedValue({ rawData }),
      });
    }

    it('flags usedSharedAccount + sharedAccountId when the fallback resolved a site-wide account', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'shared-acct-1', usedSharedAccount: true });
      stubCompany({ name: 'Acme Inc', industry: 'Software' });

      const result = await service.linkedinOutreach(userId, {
        action: 'get-company',
        company_id: 'acme',
      });

      expect(result.success).toBe(true);
      expect(result.data.usedSharedAccount).toBe(true);
      expect(result.data.sharedAccountId).toBe('shared-acct-1');
    });

    it('does not flag usedSharedAccount when the user\'s own account was used', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'own-acct-1', usedSharedAccount: false });
      stubCompany({ name: 'Acme Inc', industry: 'Software' });

      const result = await service.linkedinOutreach(userId, {
        action: 'get-company',
        company_id: 'acme',
      });

      expect(result.data.usedSharedAccount).toBe(false);
      expect(result.data).not.toHaveProperty('sharedAccountId');
    });
  });

  describe('search-parameters', () => {
    function stubResolve(resolveResult: any) {
      mockGetSearchParamService.mockReturnValue({
        resolve: jest.fn().mockResolvedValue(resolveResult),
      });
    }

    it('flags usedSharedAccount + sharedAccountId when the fallback resolved a site-wide account', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'shared-acct-1', usedSharedAccount: true });
      stubResolve({ candidates: [{ id: 'co_1', title: 'Acme' }], fromCache: false, source: 'api' });

      const result = await service.linkedinOutreach(userId, {
        action: 'search-parameters',
        type: 'COMPANY',
        keywords: 'Acme',
      });

      expect(result.success).toBe(true);
      expect(result.data.usedSharedAccount).toBe(true);
      expect(result.data.sharedAccountId).toBe('shared-acct-1');
    });

    it('does not flag usedSharedAccount when the user\'s own account was used', async () => {
      mockResolveAccountIdWithSource.mockResolvedValue({ accountId: 'own-acct-1', usedSharedAccount: false });
      stubResolve({ candidates: [{ id: 'co_1', title: 'Acme' }], fromCache: false, source: 'api' });

      const result = await service.linkedinOutreach(userId, {
        action: 'search-parameters',
        type: 'COMPANY',
        keywords: 'Acme',
      });

      expect(result.data.usedSharedAccount).toBe(false);
      expect(result.data).not.toHaveProperty('sharedAccountId');
    });
  });
});
