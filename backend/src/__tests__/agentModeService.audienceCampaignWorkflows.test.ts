/**
 * ENG-600: Meta Custom/Lookalike Audiences from HubSpot/CSV + the two new
 * "Launch targeted-audience campaign" / "Launch retargeting campaign"
 * workflows. Covers the shared resolveOrCreateSeedAudience helper first;
 * the two public orchestration methods (launchTargetedAudienceCampaign /
 * launchRetargetingCampaign) are covered in the same file as they're built.
 */

jest.mock('../mcp/client/mcpClientService', () => ({
  McpClientService: jest.fn().mockImplementation(() => ({
    isReady: jest.fn().mockReturnValue(true)
  }))
}));

jest.mock('../services/slackService', () => ({}));

jest.mock('../services/db', () => ({
  userDb: { getUserById: jest.fn() }
}));

jest.mock('../utils/secretsManager', () => ({
  getMetaAccessToken: jest.fn().mockResolvedValue('mock-access-token')
}));

import { AgentModeService } from '../services/agentModeService';

describe('AgentModeService - ENG-600 audience/campaign workflows', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
  });

  const ACCOUNT_ID = '922903076601160';
  const USER_ID = 'user123';

  // Access the private helper the same way other suites in this repo test
  // private AgentModeService methods (e.g. buildMarketingContext).
  const callResolveOrCreateSeedAudience = (...args: any[]) =>
    (agentModeService as any).resolveOrCreateSeedAudience(...args);

  describe('resolveOrCreateSeedAudience', () => {
    it('plans to CREATE when no existing audience matches the name (dry run)', async () => {
      jest.spyOn(agentModeService, 'manageMetaCustomAudiences').mockResolvedValueOnce({
        success: true,
        message: 'Found 0 custom audience(s)',
        audiences: [],
      } as any);

      const result = await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: true }
      );

      expect(result.plannedAction).toBe('create');
      expect(result.audience).toBeUndefined();
      expect(agentModeService.manageMetaCustomAudiences).toHaveBeenCalledWith(USER_ID, 'LIST', ACCOUNT_ID, {});
      // Dry run must not create/upload anything.
      expect(agentModeService.manageMetaCustomAudiences).toHaveBeenCalledTimes(1);
    });

    it('plans to REUSE when an existing audience name matches (case-insensitive, dry run)', async () => {
      jest.spyOn(agentModeService, 'manageMetaCustomAudiences').mockResolvedValueOnce({
        success: true,
        audiences: [{ id: 'aud_existing_1', name: 'rankai warm list' }],
      } as any);

      const result = await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: true }
      );

      expect(result.plannedAction).toBe('reuse');
      expect(result.audience).toEqual({ id: 'aud_existing_1', name: 'rankai warm list' });
      expect(agentModeService.manageMetaCustomAudiences).toHaveBeenCalledTimes(1);
    });

    it('creates a new audience and uploads CSV-sourced users when no name match exists', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, audience: { id: 'aud_new_1', name: 'RankAI Warm List' } } as any); // CREATE
      spy.mockResolvedValueOnce({ success: true, message: 'uploaded' } as any); // UPLOAD_USERS

      const result = await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: false }
      );

      expect(spy).toHaveBeenNthCalledWith(1, USER_ID, 'LIST', ACCOUNT_ID, {});
      expect(spy).toHaveBeenNthCalledWith(2, USER_ID, 'CREATE', ACCOUNT_ID, expect.objectContaining({
        name: 'RankAI Warm List',
        subtype: 'CUSTOM',
        confirm: true,
      }));
      expect(spy).toHaveBeenNthCalledWith(3, USER_ID, 'UPLOAD_USERS', ACCOUNT_ID, expect.objectContaining({
        id: 'aud_new_1',
        schema: ['EMAIL', 'PHONE'],
        payload: 'https://s3.example.com/audience.csv',
        confirm: true,
      }));
      expect(result.created).toBe(true);
      expect(result.audience).toEqual({ id: 'aud_new_1', name: 'RankAI Warm List' });
      expect(result.failures).toEqual([]);
    });

    it('reuses an existing audience by id and still refreshes it with fresh source data', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_existing_1', name: 'RankAI Warm List' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, message: 'uploaded' } as any); // UPLOAD_USERS

      const result = await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: false }
      );

      // No CREATE call — only LIST then UPLOAD_USERS against the existing id.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(2, USER_ID, 'UPLOAD_USERS', ACCOUNT_ID, expect.objectContaining({
        id: 'aud_existing_1',
      }));
      expect(result.created).toBe(false);
      expect(result.audience).toEqual({ id: 'aud_existing_1', name: 'RankAI Warm List' });
    });

    it('resolves a hubspot_list source via getContactsForList and maps rows to EMAIL/PHONE schema', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, audience: { id: 'aud_new_2', name: 'Every.io Segment' } } as any); // CREATE
      spy.mockResolvedValueOnce({ success: true } as any); // UPLOAD_USERS

      const mockGetContactsForList = jest.fn().mockResolvedValue([
        { contactId: '1', email: 'a@example.com', phone: '111' },
        { contactId: '2', email: 'b@example.com', phone: '' },
        { contactId: '3', email: '', phone: '333' },
        { contactId: '4', email: '', phone: '' }, // neither -> skipped
      ]);
      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue({
        getContactsForList: mockGetContactsForList,
      });

      const result = await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'Every.io Segment',
        { type: 'hubspot_list', listId: 'list-42' },
        { dryRun: false }
      );

      expect(mockGetContactsForList).toHaveBeenCalledWith('list-42');
      expect(spy).toHaveBeenNthCalledWith(3, USER_ID, 'UPLOAD_USERS', ACCOUNT_ID, expect.objectContaining({
        schema: ['EMAIL', 'PHONE'],
        payload: [
          ['a@example.com', '111'],
          ['b@example.com', ''],
          ['', '333'],
        ],
      }));
      expect(result.failures).toEqual(['1 of 4 HubSpot contacts had neither email nor phone, skipped.']);
      expect(result.recordsFound).toBe(4);
      expect(result.recordsUsable).toBe(3);
    });

    // ENG-600 live-test finding: a user with 2+ connected HubSpot accounts has
    // no way to disambiguate which one owns a given list_id — resolveHubSpotService
    // throws "Multiple HubSpot accounts found" when accountId is omitted. The
    // hubspot_list source must carry an optional hubspotAccountId through to
    // resolveHubSpotService.
    it('passes hubspotAccountId through to resolveHubSpotService when provided', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any);
      spy.mockResolvedValueOnce({ success: true, audience: { id: 'aud_new_4', name: 'X' } } as any);
      spy.mockResolvedValueOnce({ success: true } as any);

      const mockGetContactsForList = jest.fn().mockResolvedValue([
        { contactId: '1', email: 'a@example.com', phone: '111' },
      ]);
      const resolveHubSpotSpy = jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue({
        getContactsForList: mockGetContactsForList,
      });

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-27', hubspotAccountId: '245815183' },
        { dryRun: false }
      );

      expect(resolveHubSpotSpy).toHaveBeenCalledWith(USER_ID, '245815183');
    });

    it('throws (fails fast) when the LIST lookup fails, without attempting CREATE/UPLOAD_USERS', async () => {
      jest.spyOn(agentModeService, 'manageMetaCustomAudiences').mockResolvedValueOnce({
        success: false, message: 'Meta API unreachable',
      } as any);

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'csv', csvUrl: 'https://s3.example.com/a.csv' },
        { dryRun: false }
      )).rejects.toThrow('Meta API unreachable');
    });

    it('throws (fails fast) when CREATE fails', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any);
      spy.mockResolvedValueOnce({ success: false, message: 'Custom audience requires a "name".' } as any);

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'csv', csvUrl: 'https://s3.example.com/a.csv' },
        { dryRun: false }
      )).rejects.toThrow('Custom audience requires a "name".');
    });

    it('throws (fails fast) when UPLOAD_USERS fails', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any);
      spy.mockResolvedValueOnce({ success: true, audience: { id: 'aud_new_3', name: 'X' } } as any);
      spy.mockResolvedValueOnce({ success: false, message: 'Payload is empty — no user rows to upload.' } as any);

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'csv', csvUrl: 'https://s3.example.com/empty.csv' },
        { dryRun: false }
      )).rejects.toThrow('Payload is empty');
    });
  });

  describe('launchTargetedAudienceCampaign / launchRetargetingCampaign', () => {
    const ORIGINAL_ALLOWLIST = process.env.META_TEST_ACCOUNT_ALLOWLIST;
    afterEach(() => {
      if (ORIGINAL_ALLOWLIST === undefined) delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      else process.env.META_TEST_ACCOUNT_ALLOWLIST = ORIGINAL_ALLOWLIST;
    });

    const baseArgs = () => ({
      account_id: ACCOUNT_ID,
      campaign_id: 'camp_123',
      audience_name: 'RankAI Warm List',
      audience_source: { csv_url: 'https://s3.example.com/audience.csv' },
      ad_set_params: {
        name: 'Targeted Ad Set',
        targeting: { geo_locations: { countries: ['US'] } },
      },
    });

    it('returns a preview (awaitingUserConfirmation) without executing anything when confirm is not set', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      const resolveSpy = jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: undefined, created: false, sourceSummary: 'CSV upload (...)', failures: [],
      });
      const createAdSetSpy = jest.spyOn(agentModeService, 'createMetaAdsAdSet');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, baseArgs());

      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
      expect(resolveSpy).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, 'RankAI Warm List', { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' }, { dryRun: true });
      expect(createAdSetSpy).not.toHaveBeenCalled();
    });

    it('executes end-to-end and returns a completion ledger when confirm=true (targeted, no lookalike)', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create',
        audience: { id: 'aud_seed_1', name: 'RankAI Warm List' },
        created: true,
        sourceSummary: 'CSV upload (https://s3.example.com/audience.csv)',
        failures: [],
        recordsFound: undefined,
        recordsUsable: undefined,
      });
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_1', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, { ...baseArgs(), confirm: true });

      expect(result.success).toBe(true);
      expect(result.workflow).toBe('targeted_audience');
      expect(result.ledger.audience).toEqual({ id: 'aud_seed_1', name: 'RankAI Warm List', created: true, subtype: 'CUSTOM' });
      expect(result.ledger.lookalike).toBeNull();
      expect(result.ledger.adSet).toEqual({ id: 'adset_1', name: 'Targeted Ad Set', targetedAudienceId: 'aud_seed_1', excludedAudienceId: undefined });
      expect(result.ledger.failures).toEqual([]);

      const adSetCallArgs = (agentModeService.createMetaAdsAdSet as jest.Mock).mock.calls[0][1];
      expect(adSetCallArgs.targeting.custom_audiences).toEqual([{ id: 'aud_seed_1' }]);
      expect(adSetCallArgs.targeting.excluded_custom_audiences).toBeUndefined();
    });

    it('creates a Lookalike Audience and attaches it (not the seed) when use_lookalike=true', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: { id: 'aud_seed_2', name: 'RankAI Warm List' }, created: true,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      const manageSpy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences').mockResolvedValueOnce({
        success: true, audience: { id: 'aud_lookalike_1', name: 'RankAI Warm List - Lookalike' },
      } as any);
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_2', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, {
        ...baseArgs(), confirm: true, use_lookalike: true, lookalike_ratio: 0.01, lookalike_country: 'US',
      });

      expect(manageSpy).toHaveBeenCalledWith(USER_ID, 'CREATE', ACCOUNT_ID, expect.objectContaining({
        subtype: 'LOOKALIKE',
        lookalike_spec: { origin: [{ id: 'aud_seed_2' }], ratio: 0.01, country: 'US' },
      }));
      expect(result.ledger.lookalike).toEqual({ id: 'aud_lookalike_1', name: 'RankAI Warm List - Lookalike', ratio: 0.01, country: 'US' });
      const adSetCallArgs = (agentModeService.createMetaAdsAdSet as jest.Mock).mock.calls[0][1];
      expect(adSetCallArgs.targeting.custom_audiences).toEqual([{ id: 'aud_lookalike_1' }]);
    });

    it('rejects use_lookalike=true without lookalike_ratio/lookalike_country before calling anything', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      const resolveSpy = jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, {
        ...baseArgs(), confirm: true, use_lookalike: true,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('lookalike_ratio is required');
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('rejects a retargeting launch missing exclude_audience_id (defensive check) before calling anything', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      const resolveSpy = jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience');

      const result = await agentModeService.launchRetargetingCampaign(USER_ID, { ...baseArgs(), confirm: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain('exclude_audience_id is required');
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('sets targeting.excluded_custom_audiences for a confirmed retargeting launch', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_warm_1', name: 'Retargeting Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_3', name: 'Retargeting Ad Set' },
      } as any);

      const result = await agentModeService.launchRetargetingCampaign(USER_ID, {
        ...baseArgs(), audience_name: 'Retargeting Warm List', confirm: true, exclude_audience_id: 'aud_broad_control',
      });

      expect(result.workflow).toBe('retargeting');
      expect(result.ledger.adSet.excludedAudienceId).toBe('aud_broad_control');
      const adSetCallArgs = (agentModeService.createMetaAdsAdSet as jest.Mock).mock.calls[0][1];
      expect(adSetCallArgs.targeting.excluded_custom_audiences).toEqual([{ id: 'aud_broad_control' }]);
      expect(adSetCallArgs.targeting.custom_audiences).toEqual([{ id: 'aud_warm_1' }]);
    });

    it('fails the whole launch (no ad set created) when seed audience resolution throws', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockRejectedValueOnce(
        new Error('Payload is empty — no user rows to upload.')
      );
      const createAdSetSpy = jest.spyOn(agentModeService, 'createMetaAdsAdSet');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, { ...baseArgs(), confirm: true });

      expect(result.success).toBe(false);
      expect(result.ledger.failures).toEqual([{ step: 'launch', message: 'Payload is empty — no user rows to upload.' }]);
      expect(createAdSetSpy).not.toHaveBeenCalled();
    });

    it('fails the whole launch when ad set creation fails', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: { id: 'aud_seed_3', name: 'RankAI Warm List' }, created: true,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: false, message: 'targeting.geo_locations is required and cannot be empty.',
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, { ...baseArgs(), confirm: true });

      expect(result.success).toBe(false);
      expect(result.message).toContain('geo_locations');
    });

    it('rejects an account outside the allowlist before calling any Meta API', async () => {
      process.env.META_TEST_ACCOUNT_ALLOWLIST = 'some-other-account';
      const resolveSpy = jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, baseArgs());

      expect(result.success).toBe(false);
      expect(result.message).toContain('not in the ENG-600 verification allowlist');
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('proceeds normally when the account is in the allowlist', async () => {
      process.env.META_TEST_ACCOUNT_ALLOWLIST = ACCOUNT_ID;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: undefined, created: false, sourceSummary: 'CSV upload (...)', failures: [],
      });

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, baseArgs());

      expect(result.success).toBe(true);
      expect(result.awaitingUserConfirmation).toBe(true);
    });

    it('rejects audience_source with neither hubspot_list_id nor csv_url', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, { ...baseArgs(), audience_source: {} });
      expect(result.success).toBe(false);
      expect(result.message).toContain('exactly one of hubspot_list_id or csv_url');
    });
  });
});
