/**
 * ENG-508 — get-profile fresh-read + fail-closed guarantees.
 *
 * The Founder LinkedIn audit surfaced a stale headline because the authenticated
 * Unipile read was unavailable and the model fell back to a cached search snippet.
 * Two guarantees protect the authenticated path itself:
 *
 *  1. FRESHNESS: the get-profile dispatch is cache-first with a 30-day TTL
 *     (unipileProfileService HIT_TTL_SECONDS). A caller that needs the CURRENT
 *     profile (e.g. a readiness audit, or "what's my headline right now?") can pass
 *     force_refresh:true to bypass the cache and read live from Unipile. Without it,
 *     the cache-first behaviour is preserved so high-volume outreach loops keep
 *     their dedup/rate-limit benefit.
 *
 *  2. FAIL-CLOSED: when no LinkedIn account can be resolved (neither the user's own
 *     nor a site-wide fallback), get-profile returns an explicit connect-LinkedIn
 *     error and NEVER reaches Unipile — it must never fabricate or degrade to a
 *     non-authenticated value presented as current.
 */

jest.mock('../services/unipileProfileServiceFactory', () => ({
  getUnipileProfileService: jest.fn(),
}));

jest.mock('../services/unipileConnectionsDb', () => ({
  getConnectionByProfileUrlAndAccount: jest.fn(),
}));

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    resolveAccountId: jest.fn(),
    resolveAccountIdWithSource: jest.fn(),
    listUserOwnedUnipileAccountIds: jest.fn().mockResolvedValue([]),
    isAccountConnected: jest.fn().mockResolvedValue(true),
    probeAccountSession: jest.fn().mockResolvedValue('connected'),
    clearStatusCache: jest.fn(),
  },
}));

jest.mock('../services/db', () => ({ crmDb: {} }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/gmailService',  () => ({ gmailService:  { sendEmail: jest.fn() } }));

import { AgentModeService } from '../services/agentModeService';
import * as unipileProfileServiceFactory from '../services/unipileProfileServiceFactory';
import * as unipileConnectionsDb from '../services/unipileConnectionsDb';
import { linkedInOutreachService } from '../services/linkedInOutreachService';

const mockGetService = unipileProfileServiceFactory.getUnipileProfileService as jest.Mock;
const mockGetConnection = unipileConnectionsDb.getConnectionByProfileUrlAndAccount as jest.Mock;
const mockResolveAccountIdWithSource = linkedInOutreachService.resolveAccountIdWithSource as jest.Mock;

describe('AgentModeService.linkedinOutreach get-profile — fresh-read + fail-closed (ENG-508)', () => {
  let service: AgentModeService;
  let mockGetProfile: jest.Mock;
  const userId = 'user-1';
  const accountId = 'unipile-acc-1';

  function stubProfile(rawData: any, fromCache = true) {
    mockGetProfile = jest.fn().mockResolvedValue({
      rawData,
      fromCache,
      found: true,
      checkedAt: '2026-08-03T00:00:00.000Z',
    });
    mockGetService.mockReturnValue({ getProfile: mockGetProfile });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
    mockGetConnection.mockResolvedValue(null);
  });

  it('passes forceRefresh:true through to getProfile when force_refresh is requested', async () => {
    stubProfile({ public_identifier: 'fangfangtan', headline: 'Founder × 2 | AgentWeb' }, false);

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/fangfangtan/',
      account_id: accountId,
      force_refresh: true,
    });

    expect(res.success).toBe(true);
    expect(res.data.headline).toBe('Founder × 2 | AgentWeb');
    expect(mockGetProfile).toHaveBeenCalledWith(
      expect.any(String),
      accountId,
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it('defaults to cache-first (forceRefresh:false) when force_refresh is not set', async () => {
    stubProfile({ public_identifier: 'someone', headline: 'Old cached headline' });

    await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/someone/',
      account_id: accountId,
    });

    expect(mockGetProfile).toHaveBeenCalledWith(
      expect.any(String),
      accountId,
      expect.objectContaining({ forceRefresh: false }),
    );
  });

  it('fails closed with a connect-LinkedIn error and never calls Unipile when no account resolves', async () => {
    stubProfile({ public_identifier: 'nobody', headline: 'should never be read' });
    mockResolveAccountIdWithSource.mockResolvedValue({ accountId: null, usedSharedAccount: false }); // no user account and no site-wide fallback

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/nobody/',
      // no account_id → must resolve, and resolution fails
    });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no linkedin account is connected/i);
    // The authenticated read must never run, so no (possibly stale/fabricated)
    // profile can be returned as if current.
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(res.data).toBeUndefined();
  });
});
