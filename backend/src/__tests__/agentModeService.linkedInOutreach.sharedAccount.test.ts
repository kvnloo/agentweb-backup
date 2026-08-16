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

jest.mock('../services/unipileConnectionsDb', () => ({
  getConnectionByProfileUrlAndAccount: jest.fn().mockResolvedValue(null),
}));

const mockResolveAccountIdWithSource = jest.fn();
const mockSearchPeople = jest.fn();
jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountIdWithSource: (...args: any[]) => mockResolveAccountIdWithSource(...args),
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

const mockGetService = unipileProfileServiceFactory.getUnipileProfileService as jest.Mock;

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

    it('passes explicit account_id straight through without calling the fallback resolver', async () => {
      mockSearchPeople.mockResolvedValue({ items: [], cursor: null });

      const result = await service.linkedinOutreach(userId, {
        action: 'search-people',
        account_id: 'explicit-acct',
        keywords: 'marketing',
      });

      expect(mockResolveAccountIdWithSource).not.toHaveBeenCalled();
      expect(result.data.usedSharedAccount).toBe(false);
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
  });
});
