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

// resolveOrCreateSeedAudience's stale-member diff fetches the CSV itself
// (separately from UPLOAD_USERS's own fetch) purely to compute hashes to
// compare against the last-synced snapshot. Mocked here so CSV-source tests
// that don't care about stale-member sync don't hit the network.
jest.mock('axios');
jest.mock('../services/metaAudienceSnapshotStore', () => ({
  getAudienceSnapshotRowKeys: jest.fn().mockResolvedValue(null),
  saveAudienceSnapshotRowKeys: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/metaAudienceCampaignTokenStore', () => ({
  claimPreviewToken: jest.fn().mockResolvedValue(true),
  releasePreviewToken: jest.fn().mockResolvedValue(undefined),
  markPreviewTokenSucceeded: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHostname: jest.fn().mockResolvedValue(undefined),
  resolvePinnedPublicAddress: jest.fn().mockResolvedValue({ hostname: 's3.example.com', address: '93.184.216.34', family: 4 }),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import axios from 'axios';
import { AgentModeService } from '../services/agentModeService';
import { getAudienceSnapshotRowKeys, saveAudienceSnapshotRowKeys } from '../services/metaAudienceSnapshotStore';
import { claimPreviewToken, releasePreviewToken, markPreviewTokenSucceeded } from '../services/metaAudienceCampaignTokenStore';
import { assertPublicHostname, resolvePinnedPublicAddress } from '../utils/ssrfGuard';

describe('AgentModeService - ENG-600 audience/campaign workflows', () => {
  let agentModeService: AgentModeService;

  beforeEach(() => {
    agentModeService = new AgentModeService();
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockResolvedValue({ data: 'email,phone\n' });
    (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue(null);
    (saveAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue(undefined);
    (claimPreviewToken as jest.Mock).mockResolvedValue(true);
    (releasePreviewToken as jest.Mock).mockResolvedValue(undefined);
    (markPreviewTokenSucceeded as jest.Mock).mockResolvedValue(undefined);
    (assertPublicHostname as jest.Mock).mockResolvedValue(undefined);
    (resolvePinnedPublicAddress as jest.Mock).mockResolvedValue({ hostname: 's3.example.com', address: '93.184.216.34', family: 4 });
    // Default: no existing ad set matches (falls through to CREATE, the
    // pre-existing behavior every test below expects unless it overrides
    // this to specifically exercise ad-set reuse-by-name-match).
    jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValue({ success: true, adSets: [] } as any);
    // Default: campaign has no CBO (Advantage Campaign Budget), so requested
    // budgets aren't stripped for comparison purposes — the common case.
    jest.spyOn(agentModeService, 'getCampaignForAdSetReuseCheck').mockResolvedValue({});
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
      (axios.get as jest.Mock).mockResolvedValueOnce({ data: 'test@example.com,1234567890' });

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
      // CSV is fetched/parsed exactly once (here) and that same parsed array
      // is what gets uploaded — not the raw URL — so the stale-member hash
      // diff and the actual upload can never see two different snapshots of
      // the same URL's content.
      expect(spy).toHaveBeenNthCalledWith(3, USER_ID, 'UPLOAD_USERS', ACCOUNT_ID, expect.objectContaining({
        id: 'aud_new_1',
        schema: ['EMAIL', 'PHONE'],
        payload: [['test@example.com', '1234567890']],
        confirm: true,
      }));
      expect(result.created).toBe(true);
      expect(result.audience).toEqual({ id: 'aud_new_1', name: 'RankAI Warm List' });
      expect(result.failures).toEqual([]);
    });

    // Greptile finding: the CSV source URL was fetched server-side with no
    // restriction on destination — a caller could point it at an internal/
    // private address (cloud metadata, RFC1918 hosts, loopback) and exfiltrate
    // internal data through the parsed "CSV" response (classic SSRF). Reuses
    // the repo's existing assertPublicHostname guard (utils/ssrfGuard.ts,
    // already used by routes/crm.ts's load-from-url path) rather than
    // reinventing IP-range checks.
    it('rejects a CSV source URL that resolves to a private/internal address (SSRF guard) before attempting CREATE/UPLOAD_USERS', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST
      const { SsrfBlockedError } = require('../utils/ssrfGuard');
      (resolvePinnedPublicAddress as jest.Mock).mockRejectedValueOnce(new SsrfBlockedError());

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'http://169.254.169.254/latest/meta-data/' },
        { dryRun: false }
      )).rejects.toThrow();

      expect(axios.get).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    // Greptile finding: assertPublicHostname only validates the user-supplied
    // URL — if axios follows a redirect (e.g. a 302 to
    // http://169.254.169.254/), the guard is bypassed entirely since the
    // redirect target is never checked. Matches the existing redirect-bypass
    // defense already used in routes/crm.ts's load-from-url path:
    // maxRedirects:0 makes axios surface a redirect as an error instead of
    // silently following it.
    it('disables redirects on the CSV fetch so a redirect cannot bypass the SSRF guard', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, audience: { id: 'aud_x', name: 'RankAI Warm List' } } as any); // CREATE
      spy.mockResolvedValueOnce({ success: true } as any); // UPLOAD_USERS
      (axios.get as jest.Mock).mockResolvedValueOnce({ data: 'test@example.com,1234567890' });

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: false }
      );

      expect(axios.get).toHaveBeenCalledWith('https://s3.example.com/audience.csv', expect.objectContaining({
        maxRedirects: 0,
      }));
    });

    // Greptile finding: resolvePinnedPublicAddress validates one DNS answer,
    // but a caller that does its own SEPARATE lookup afterward (axios.get's
    // default behavior) is vulnerable to DNS rebinding — an attacker DNS
    // server can answer a public IP for validation and a private IP for the
    // actual connection, since they're two independent queries. Pinning
    // axios's connection to the exact address that was validated (via a
    // custom `lookup` function) eliminates the second, unvalidated lookup.
    it('pins the CSV fetch to the exact address validated by the SSRF guard (DNS-rebinding defense)', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, audience: { id: 'aud_y', name: 'RankAI Warm List' } } as any); // CREATE
      spy.mockResolvedValueOnce({ success: true } as any); // UPLOAD_USERS
      (resolvePinnedPublicAddress as jest.Mock).mockResolvedValueOnce({ hostname: 's3.example.com', address: '203.0.113.7', family: 4 });
      (axios.get as jest.Mock).mockResolvedValueOnce({ data: 'test@example.com,1234567890' });

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: false }
      );

      const [, config] = (axios.get as jest.Mock).mock.calls[0];
      expect(typeof config.lookup).toBe('function');
      const callback = jest.fn();
      config.lookup('s3.example.com', {}, callback);
      expect(callback).toHaveBeenCalledWith(null, '203.0.113.7', 4);
    });

    it('fails fast (does not attempt CREATE/UPLOAD_USERS) when the CSV fetch itself fails', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST
      (axios.get as jest.Mock).mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND'));

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: false }
      )).rejects.toThrow('ENOTFOUND');

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('reuses an existing audience by id with no prior snapshot — uses REPLACE_USERS (no baseline to diff against)', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_existing_1', name: 'RankAI Warm List' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, message: 'replaced' } as any); // REPLACE_USERS

      const result = await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: false }
      );

      // No CREATE call — only LIST then REPLACE_USERS against the existing id.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenNthCalledWith(2, USER_ID, 'REPLACE_USERS', ACCOUNT_ID, expect.objectContaining({
        id: 'aud_existing_1',
      }));
      expect(result.created).toBe(false);
      expect(result.audience).toEqual({ id: 'aud_existing_1', name: 'RankAI Warm List' });
    });

    it('reuses an existing audience by id WITH a prior snapshot — uses UPLOAD_USERS (diff-and-delete already handled removals)', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_existing_1', name: 'RankAI Warm List' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, message: 'uploaded' } as any); // UPLOAD_USERS
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValueOnce([]);

      const result = await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'RankAI Warm List',
        { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' },
        { dryRun: false }
      );

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

      const mockGetContactsForList = jest.fn().mockResolvedValue({
        contacts: [
          { contactId: '1', email: 'a@example.com', phone: '111' },
          { contactId: '2', email: 'b@example.com', phone: '' },
          { contactId: '3', email: '', phone: '333' },
          { contactId: '4', email: '', phone: '' }, // neither -> skipped
        ],
        failedChunkContactCount: 0,
      });
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

    // Greptile P1 finding history: a failed HubSpot batch/read chunk used to
    // be silently dropped (the caller reported the partial contact list as
    // complete); a follow-up fix surfaced it as a non-fatal ledger entry, but
    // Greptile's overall confidence assessment flagged that the campaign
    // still launched against a known-incomplete audience either way. This
    // now blocks the whole launch — we cannot say what the correct audience
    // is when part of it failed to read, so proceeding on a partial/wrong
    // segment is worse than requiring a retry.
    it('blocks the launch (throws) when a HubSpot batch/read chunk fails, rather than uploading a known-incomplete audience', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any);

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue({
        getContactsForList: jest.fn().mockResolvedValue({
          contacts: [{ contactId: '1', email: 'a@example.com', phone: '111' }],
          failedChunkContactCount: 100,
        }),
      });

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-42' },
        { dryRun: false }
      )).rejects.toThrow('100 of 101 HubSpot contacts could not be read');

      // Only LIST was attempted — no CREATE/UPLOAD_USERS against a partial audience.
      expect(spy).toHaveBeenCalledTimes(1);
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

      const mockGetContactsForList = jest.fn().mockResolvedValue({
        contacts: [{ contactId: '1', email: 'a@example.com', phone: '111' }],
        failedChunkContactCount: 0,
      });
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

  // ENG-600 Greptile finding (block-merge): reusing an existing audience for
  // a fresh source upload never removed members no longer present in the new
  // source — a contact removed from a HubSpot list (or dropped from a
  // refreshed CSV) stayed in the Meta audience forever. resolveOrCreateSeedAudience
  // now diffs the current source's hashed rows against a snapshot of the last
  // sync (metaAudienceSnapshotStore) and issues a DELETE_USERS removal for
  // anything stale before uploading the fresh set.
  describe('resolveOrCreateSeedAudience — stale-member sync-to-remove', () => {
    const crypto = require('crypto');
    const hashCell = (fieldType: string, value: string): string => {
      let v = value.trim();
      if (!v) return '';
      if (fieldType === 'EMAIL') v = v.toLowerCase();
      else if (fieldType === 'PHONE') v = v.toLowerCase().replace(/[^a-z0-9]/g, '');
      else v = v.toLowerCase();
      return crypto.createHash('sha256').update(v).digest('hex');
    };
    const rowKeyFor = (email: string, phone: string): string =>
      [hashCell('EMAIL', email), hashCell('PHONE', phone)].join('|');

    const mockHubSpotContact = (email: string, phone: string) => ({
      getContactsForList: jest.fn().mockResolvedValue({
        contacts: [{ contactId: '1', email, phone }],
        failedChunkContactCount: 0,
      }),
    });

    it('removes stale members (present in the last snapshot, absent from the current source) before re-uploading, on reuse', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_1', name: 'X' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true } as any); // DELETE_USERS
      spy.mockResolvedValueOnce({ success: true } as any); // UPLOAD_USERS

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue([
        rowKeyFor('a@example.com', '111'),
        rowKeyFor('old@example.com', '999'),
      ]);

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      );

      expect(spy).toHaveBeenNthCalledWith(2, USER_ID, 'DELETE_USERS', ACCOUNT_ID, expect.objectContaining({
        id: 'aud_1',
        schema: ['EMAIL', 'PHONE'],
        payload: [[hashCell('EMAIL', 'old@example.com'), hashCell('PHONE', '999')]],
      }));
      expect(spy).toHaveBeenNthCalledWith(3, USER_ID, 'UPLOAD_USERS', ACCOUNT_ID, expect.any(Object));
      expect(saveAudienceSnapshotRowKeys).toHaveBeenCalledWith(USER_ID, 'aud_1', [rowKeyFor('a@example.com', '111')]);
    });

    // Greptile finding: with no prior snapshot there's no baseline to diff
    // against, so an add-only upload could never remove any pre-existing
    // members not in the current source — they'd stay in the audience
    // forever. REPLACE_USERS (Meta's atomic usersreplace) sidesteps the need
    // for a baseline entirely by setting membership to exactly the current
    // source in one operation.
    it('uses REPLACE_USERS (not UPLOAD_USERS/DELETE_USERS) when there is no prior snapshot (first sync of a reused audience)', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_2', name: 'X' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true } as any); // REPLACE_USERS

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue(null);

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      );

      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).not.toHaveBeenCalledWith(USER_ID, 'DELETE_USERS', expect.anything(), expect.anything());
      expect(spy).not.toHaveBeenCalledWith(USER_ID, 'UPLOAD_USERS', expect.anything(), expect.anything());
      expect(spy).toHaveBeenNthCalledWith(2, USER_ID, 'REPLACE_USERS', ACCOUNT_ID, expect.objectContaining({
        id: 'aud_2', schema: ['EMAIL', 'PHONE'],
      }));
    });

    // Greptile finding: a snapshot READ failure (distinct from a snapshot
    // SAVE failure, already blocking) fell through to an add-only upload
    // with noBaselineReuse left false — same "launch against unreconciled
    // data" category as the other blocking fixes, just via a different path.
    it('blocks the launch (throws) when reading the prior snapshot fails, rather than add-only uploading against unknown state', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_2b', name: 'X' }] } as any); // LIST

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      (getAudienceSnapshotRowKeys as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      )).rejects.toThrow('DynamoDB unavailable');

      // Only LIST attempted — no UPLOAD_USERS/REPLACE_USERS against unknown state.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not call DELETE_USERS when creating a brand-new audience, but still saves a baseline snapshot', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true, audience: { id: 'aud_new', name: 'X' } } as any); // CREATE
      spy.mockResolvedValueOnce({ success: true } as any); // UPLOAD_USERS

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      );

      expect(spy).toHaveBeenCalledTimes(3);
      expect(getAudienceSnapshotRowKeys).not.toHaveBeenCalled();
      expect(saveAudienceSnapshotRowKeys).toHaveBeenCalledWith(USER_ID, 'aud_new', [rowKeyFor('a@example.com', '111')]);
    });

    // Greptile finding: DELETE_USERS failure used to be non-fatal, letting
    // the launch proceed against an audience known to still contain removed
    // contacts. Matches the same "block on known-incomplete data" decision
    // already applied to HubSpot chunk failures and exhausted snapshot
    // saves — throw instead of continuing.
    it('blocks the launch (throws) when DELETE_USERS fails, rather than launching against a known-stale audience', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_3', name: 'X' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: false, message: 'Meta rate limited' } as any); // DELETE_USERS

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue([
        rowKeyFor('a@example.com', '111'),
        rowKeyFor('old@example.com', '999'),
      ]);

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      )).rejects.toThrow('Failed to remove 1 stale member');

      // Only LIST + DELETE_USERS attempted — no UPLOAD_USERS against a
      // known-stale audience, and no snapshot saved reflecting a launch that
      // never happened.
      expect(spy).toHaveBeenCalledTimes(2);
      expect(saveAudienceSnapshotRowKeys).not.toHaveBeenCalled();
    });

    // Greptile finding history: a snapshot-save failure (after retries were
    // exhausted) used to be non-fatal, so the campaign still launched with no
    // reconciliation baseline for the next sync — a future resync would have
    // no prior snapshot to diff against and silently skip stale-member
    // removal entirely. This now blocks the launch instead.
    // Greptile follow-up finding: saving the snapshot AFTER the Meta upload
    // meant a save failure left a successfully-uploaded member with NO
    // record in any snapshot, ever — future diffs can only flag a member as
    // stale by comparing against a PRIOR snapshot that recorded it, so an
    // untracked-from-birth member could never be detected as no-longer-
    // needed and would stay targetable in Meta forever. Uploads are
    // idempotent-additive (a future sync just re-sends whatever's in the
    // current source, self-healing a "snapshot updated, upload not yet
    // retried" mismatch) but deletes are NOT (they depend entirely on
    // snapshot history) — so saving the snapshot BEFORE uploading closes the
    // gap without trading it for a symmetric under-targeting risk.
    it('blocks the launch (throws) when the snapshot save fails, WITHOUT ever attempting the Meta upload', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_4', name: 'X' }] } as any); // LIST

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      // A non-null prior snapshot so this takes the normal diff-then-
      // UPLOAD_USERS path (save-before-upload) — the no-baseline
      // REPLACE_USERS path saves AFTER instead, covered separately below.
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue([rowKeyFor('a@example.com', '111')]);
      (saveAudienceSnapshotRowKeys as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      )).rejects.toThrow('DynamoDB unavailable');

      // Only LIST attempted — UPLOAD_USERS never called, so Meta's state and
      // our tracked state stay consistent (both un-updated) rather than
      // diverging.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('saves the snapshot BEFORE calling UPLOAD_USERS, not after', async () => {
      const callOrder: string[] = [];
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockImplementation(async (_userId: any, action: any) => {
        callOrder.push(action);
        if (action === 'LIST') return { success: true, audiences: [{ id: 'aud_order', name: 'X' }] } as any;
        return { success: true } as any;
      });
      (saveAudienceSnapshotRowKeys as jest.Mock).mockImplementationOnce(async () => {
        callOrder.push('SAVE_SNAPSHOT');
      });
      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      // A non-null prior snapshot so this takes the normal diff-then-
      // UPLOAD_USERS path (not the no-baseline REPLACE_USERS path).
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue([rowKeyFor('a@example.com', '111')]);

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      );

      expect(callOrder.indexOf('SAVE_SNAPSHOT')).toBeGreaterThanOrEqual(0);
      expect(callOrder.indexOf('UPLOAD_USERS')).toBeGreaterThanOrEqual(0);
      expect(callOrder.indexOf('SAVE_SNAPSHOT')).toBeLessThan(callOrder.indexOf('UPLOAD_USERS'));
    });

    // Greptile follow-up finding: for the no-baseline reuse case
    // (REPLACE_USERS), saving the snapshot BEFORE the call has the opposite
    // problem — if REPLACE_USERS then fails, the snapshot now falsely looks
    // like an established baseline exists, so a retry switches to additive
    // UPLOAD_USERS instead of retrying REPLACE_USERS, and pre-existing
    // members that should have been wiped by the replace are never removed.
    // Unlike additive UPLOAD_USERS (which doesn't self-heal an untracked
    // successful add), REPLACE_USERS is fully idempotent regardless of
    // tracking history — it always sets Meta's membership to exactly the
    // current payload — so it doesn't need the save-before reorder: saving
    // AFTER (the original order) is correct here.
    it('saves the snapshot AFTER calling REPLACE_USERS (no-baseline reuse), not before', async () => {
      const callOrder: string[] = [];
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockImplementation(async (_userId: any, action: any) => {
        callOrder.push(action);
        if (action === 'LIST') return { success: true, audiences: [{ id: 'aud_order_2', name: 'X' }] } as any;
        return { success: true } as any;
      });
      (saveAudienceSnapshotRowKeys as jest.Mock).mockImplementationOnce(async () => {
        callOrder.push('SAVE_SNAPSHOT');
      });
      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue(null); // no baseline — REPLACE_USERS path

      await callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      );

      expect(callOrder.indexOf('REPLACE_USERS')).toBeGreaterThanOrEqual(0);
      expect(callOrder.indexOf('SAVE_SNAPSHOT')).toBeGreaterThanOrEqual(0);
      expect(callOrder.indexOf('REPLACE_USERS')).toBeLessThan(callOrder.indexOf('SAVE_SNAPSHOT'));
    });

    it('does NOT save the snapshot when REPLACE_USERS fails (would falsely look like an established baseline on retry)', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_replace_fail', name: 'X' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: false, message: 'Meta rejected the replace' } as any); // REPLACE_USERS
      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue(null); // no baseline

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      )).rejects.toThrow('Meta rejected the replace');

      expect(saveAudienceSnapshotRowKeys).not.toHaveBeenCalled();
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

    // ENG-600 fix: confirm=true alone is no longer sufficient — it must carry
    // the preview_token matching a digest of the current arguments. Tests
    // that want a genuinely confirmed call compute the matching token
    // directly rather than round-tripping through a real preview call first.
    const withConfirm = (args: any) => ({
      ...args,
      confirm: true,
      preview_token: (agentModeService as any).computeAudienceCampaignArgsDigest(args),
    });

    // Greptile P1 finding: computeAudienceCampaignArgsDigest was a plain
    // SHA256 hash of the args with no server secret — any caller (including
    // the model itself) could independently compute the exact same digest
    // from the args alone and pass confirm=true on the very first call,
    // never having gone through an actual preview. The digest must be
    // non-forgeable without the server's secret (HMAC-signed), not just
    // internally consistent with the args.
    it('rejects a self-computed plain-hash token that was never actually issued by a preview call', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      const resolveSpy = jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValue({
        plannedAction: 'create', audience: undefined, created: false, sourceSummary: 'CSV upload (...)', failures: [],
      });
      const args = baseArgs();
      const canonical = {
        account_id: args.account_id,
        campaign_id: args.campaign_id,
        audience_name: args.audience_name,
        audience_source: args.audience_source,
        use_lookalike: false,
        lookalike_ratio: undefined,
        lookalike_country: undefined,
        exclude_audience_id: undefined,
        ad_set_params: args.ad_set_params,
      };
      const forgedToken = require('crypto').createHash('sha256').update(JSON.stringify(canonical)).digest('hex');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, {
        ...args, confirm: true, preview_token: forgedToken,
      });

      expect(result.awaitingUserConfirmation).toBe(true);
      expect(resolveSpy).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), { dryRun: false });
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

    // Greptile P1 finding: createMetaAdsAdSet (pre-existing, unrelated to
    // ENG-600) silently strips daily_budget/lifetime_budget whenever the
    // target campaign has Advantage Campaign Budget (CBO) enabled. Only
    // ENG-600's new confirm-token gate treats ad_set_params as something the
    // user explicitly approved — so without this caveat, a user could
    // "confirm" a specific budget that then silently never applies. Since
    // fixing the pre-existing strip itself is out of scope here, the preview
    // discloses the risk up front instead.
    it('warns in the preview that a daily/lifetime budget may be silently stripped if the campaign uses CBO', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: undefined, created: false, sourceSummary: 'CSV upload (...)', failures: [],
      });

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, {
        ...baseArgs(),
        ad_set_params: { ...baseArgs().ad_set_params, daily_budget: 50 },
      });

      expect(result.summary).toContain('Advantage Campaign Budget');
    });

    it('does not add the CBO budget caveat when no budget is provided in ad_set_params', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: undefined, created: false, sourceSummary: 'CSV upload (...)', failures: [],
      });

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, baseArgs());

      expect(result.summary).not.toContain('Advantage Campaign Budget');
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

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm(baseArgs()));

      expect(result.success).toBe(true);
      expect(result.workflow).toBe('targeted_audience');
      expect(result.ledger.audience).toEqual({ id: 'aud_seed_1', name: 'RankAI Warm List', created: true, subtype: 'CUSTOM' });
      expect(result.ledger.lookalike).toBeNull();
      expect(result.ledger.adSet).toEqual({ id: 'adset_1', name: 'Targeted Ad Set', targetedAudienceId: 'aud_seed_1', excludedAudienceId: undefined });
      expect(result.ledger.failures).toEqual([]);

      const adSetCallArgs = (agentModeService.createMetaAdsAdSet as jest.Mock).mock.calls[0][1];
      expect(adSetCallArgs.targeting.custom_audiences).toEqual([{ id: 'aud_seed_1' }]);
      expect(adSetCallArgs.targeting.excluded_custom_audiences).toBeUndefined();

      // Greptile P1 finding: a valid preview token was never consumed/invalidated
      // after use, so replaying the exact same confirmed call would silently
      // re-execute (e.g. a second ad set under the same campaign) with no new
      // user confirmation. The token must be atomically claimed on success.
      expect(claimPreviewToken).toHaveBeenCalledWith(USER_ID, expect.any(String));

      // Greptile follow-up finding: without marking a successful launch's
      // token permanently consumed, the staleness override added for
      // failed-release retries also made a genuinely completed launch's
      // token replayable after the staleness window.
      expect(markPreviewTokenSucceeded).toHaveBeenCalledWith(USER_ID, expect.any(String));
    });

    // Greptile finding: releasing the confirm token on a downstream failure
    // means a retry could hit exactly this case — Meta creates the ad set
    // but the response is lost/times out, the launch is reported as failed
    // (network error, not a Meta rejection), the token is released, and a
    // retry with the SAME approved args would call createMetaAdsAdSet AGAIN
    // — createMetaAdsAdSet has no idempotency of its own, so an
    // unconditional retry produces a second ad set (duplicate delivery/
    // spend from one confirmation). Reuse-by-name-and-target-match (mirrors
    // the lookalike fix) closes this the same way.
    it('reuses an existing same-named ad set targeting the same audience instead of creating a duplicate', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_6', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValueOnce({
        success: true,
        adSets: [{
          id: 'adset_existing', name: 'Targeted Ad Set',
          // Must fully match what baseArgs() would construct: geo_locations
          // (from ad_set_params.targeting) plus custom_audiences (the
          // resolved seed audience) — key order deliberately different from
          // construction order to prove the comparison isn't order-sensitive.
          // Reflects what Meta actually stores after createMetaAdsAdSet's own
          // normalization: targeting_automation.advantage_audience defaulted
          // to 0, bid_strategy resolved to its default. A retry's raw args
          // (no targeting_automation, no bid_strategy) must still match this
          // via the comparison's own equivalent normalization.
          targeting: {
            custom_audiences: [{ id: 'aud_seed_6' }], geo_locations: { countries: ['US'] },
            targeting_automation: { advantage_audience: 0 },
          },
          daily_budget: null, lifetime_budget: null, start_time: null, end_time: null,
          optimization_goal: null, billing_event: null, bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        }],
      } as any);
      const createAdSetSpy = jest.spyOn(agentModeService, 'createMetaAdsAdSet');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm(baseArgs()));

      expect(createAdSetSpy).not.toHaveBeenCalled();
      expect(result.ledger.adSet).toEqual({
        id: 'adset_existing', name: 'Targeted Ad Set', targetedAudienceId: 'aud_seed_6', excludedAudienceId: undefined,
      });
    });

    it('creates a new ad set (does not reuse) when a same-named one exists but targets a different audience', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_7', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValueOnce({
        success: true,
        adSets: [{
          id: 'adset_other', name: 'Targeted Ad Set',
          targeting: { custom_audiences: [{ id: 'aud_seed_DIFFERENT' }] },
        }],
      } as any);
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_new', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm(baseArgs()));

      expect(agentModeService.createMetaAdsAdSet).toHaveBeenCalled();
      expect(result.ledger.adSet).toEqual({
        id: 'adset_new', name: 'Targeted Ad Set', targetedAudienceId: 'aud_seed_7', excludedAudienceId: undefined,
      });
    });

    // Greptile follow-up finding: name + targeted-audience alone still isn't
    // enough — a same-named ad set targeting the same audience but with a
    // DIFFERENT budget (or any other explicitly-requested knob) must not be
    // reused either, or the launch reports success while actually applying
    // the OLD delivery configuration.
    it('creates a new ad set (does not reuse) when a same-named/same-audience one exists with a different budget', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_8', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValueOnce({
        success: true,
        adSets: [{
          id: 'adset_wrong_budget', name: 'Targeted Ad Set',
          targeting: { custom_audiences: [{ id: 'aud_seed_8' }], geo_locations: { countries: ['US'] } },
          daily_budget: 5000, lifetime_budget: null, // different from the 1000 requested below
        }],
      } as any);
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_new_budget', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), ad_set_params: { ...baseArgs().ad_set_params, daily_budget: 1000 },
      }));

      expect(agentModeService.createMetaAdsAdSet).toHaveBeenCalled();
      expect(result.ledger.adSet.id).toBe('adset_new_budget');
    });

    // Greptile follow-up finding: matching targeting/budget/schedule/
    // optimization_goal/billing_event isn't enough either — a same-named,
    // otherwise-matching ad set with a different bid_strategy,
    // destination_type, or promoted_object must also not be reused, or the
    // campaign delivers with the wrong bidding behavior, conversion
    // destination, or promoted object.
    it('creates a new ad set (does not reuse) when a same-named/otherwise-matching one exists with a different promoted_object', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_9', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValueOnce({
        success: true,
        adSets: [{
          id: 'adset_wrong_promoted_object', name: 'Targeted Ad Set',
          targeting: { custom_audiences: [{ id: 'aud_seed_9' }], geo_locations: { countries: ['US'] } },
          promoted_object: { pixel_id: 'pixel_OLD' }, // different from pixel_NEW requested below
        }],
      } as any);
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_new_promoted_object', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), ad_set_params: { ...baseArgs().ad_set_params, promoted_object: { pixel_id: 'pixel_NEW' } },
      }));

      expect(agentModeService.createMetaAdsAdSet).toHaveBeenCalled();
      expect(result.ledger.adSet.id).toBe('adset_new_promoted_object');
    });

    // Greptile follow-up finding: comparing the RAW requested budget/bid
    // (dollars) against Meta's read-back value (cents — createMetaAdsAdSet
    // multiplies by 100 before calling Meta) defeated reuse for the exact
    // retry case this whole mechanism exists to handle. A legitimate retry
    // with unchanged args (daily_budget: 10, i.e. $10) must match an
    // existing ad set Meta reports as daily_budget: 1000 (cents).
    it('reuses an existing ad set when the requested budget (dollars) matches Meta\'s stored value (cents)', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_10', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValueOnce({
        success: true,
        adSets: [{
          id: 'adset_existing_budget', name: 'Targeted Ad Set',
          targeting: {
            custom_audiences: [{ id: 'aud_seed_10' }], geo_locations: { countries: ['US'] },
            targeting_automation: { advantage_audience: 0 },
          },
          daily_budget: 1000, // $10.00 stored as cents by Meta
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        }],
      } as any);
      const createAdSetSpy = jest.spyOn(agentModeService, 'createMetaAdsAdSet');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), ad_set_params: { ...baseArgs().ad_set_params, daily_budget: 10 }, // $10.00, dollars
      }));

      expect(createAdSetSpy).not.toHaveBeenCalled();
      expect(result.ledger.adSet.id).toBe('adset_existing_budget');
    });

    // Greptile follow-up finding: createMetaAdsAdSet strips daily_budget/
    // lifetime_budget entirely (not just leaves it unconverted) when the
    // campaign has Advantage Campaign Budget (CBO). A retry requesting a
    // budget for a CBO campaign must still match an existing ad set that
    // (correctly) has no budget of its own — the comparison needs to know
    // about CBO, not just blindly cents-convert whatever was requested.
    it('reuses an existing ad set with no budget when the campaign has CBO, even though a budget was requested', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_11', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'getCampaignForAdSetReuseCheck').mockResolvedValueOnce({ daily_budget: 5000 }); // campaign has CBO
      jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValueOnce({
        success: true,
        adSets: [{
          id: 'adset_cbo', name: 'Targeted Ad Set',
          targeting: {
            custom_audiences: [{ id: 'aud_seed_11' }], geo_locations: { countries: ['US'] },
            targeting_automation: { advantage_audience: 0 },
          },
          daily_budget: null, // CBO campaign — ad set has no budget of its own
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        }],
      } as any);
      const createAdSetSpy = jest.spyOn(agentModeService, 'createMetaAdsAdSet');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), ad_set_params: { ...baseArgs().ad_set_params, daily_budget: 10 }, // would get stripped anyway
      }));

      expect(createAdSetSpy).not.toHaveBeenCalled();
      expect(result.ledger.adSet.id).toBe('adset_cbo');
    });

    // Greptile follow-up finding: createMetaAdsAdSet auto-sets start_time to
    // "now" at creation time for an ACTIVE ad set with no explicit
    // start_time — a value that can never be reproduced on a later retry. A
    // retry for an ACTIVE ad set with no start_time requested must still
    // match an existing ACTIVE ad set regardless of its actual (unknowable)
    // start_time.
    it('reuses an existing ACTIVE ad set regardless of its auto-filled start_time, when none was explicitly requested', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_12', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      jest.spyOn(agentModeService, 'listMetaAdsAdSets').mockResolvedValueOnce({
        success: true,
        adSets: [{
          id: 'adset_active', name: 'Targeted Ad Set',
          targeting: {
            custom_audiences: [{ id: 'aud_seed_12' }], geo_locations: { countries: ['US'] },
            targeting_automation: { advantage_audience: 0 },
          },
          status: 'ACTIVE',
          start_time: '2026-01-01T00:00:00.000Z', // auto-filled at original creation — unknowable on retry
          bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        }],
      } as any);
      const createAdSetSpy = jest.spyOn(agentModeService, 'createMetaAdsAdSet');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), ad_set_params: { ...baseArgs().ad_set_params, status: 'ACTIVE' }, // no start_time requested
      }));

      expect(createAdSetSpy).not.toHaveBeenCalled();
      expect(result.ledger.adSet.id).toBe('adset_active');
    });

    it('rejects a replay of an already-claimed preview token, returning a fresh preview instead of re-executing', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      // false = the atomic claim failed, i.e. this exact token was already claimed
      // (by a prior real call, or a concurrent one that won the race).
      (claimPreviewToken as jest.Mock).mockResolvedValueOnce(false);
      const resolveSpy = jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: undefined, created: false, sourceSummary: 'CSV upload (...)', failures: [],
      });
      const createAdSetSpy = jest.spyOn(agentModeService, 'createMetaAdsAdSet');

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm(baseArgs()));

      expect(result.awaitingUserConfirmation).toBe(true);
      expect(createAdSetSpy).not.toHaveBeenCalled();
      expect(resolveSpy).toHaveBeenCalledWith(USER_ID, ACCOUNT_ID, 'RankAI Warm List', { type: 'csv', csvUrl: 'https://s3.example.com/audience.csv' }, { dryRun: true });
    });

    it('creates a Lookalike Audience and attaches it (not the seed) when use_lookalike=true', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'create', audience: { id: 'aud_seed_2', name: 'RankAI Warm List' }, created: true,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      const manageSpy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      manageSpy.mockResolvedValueOnce({ success: true, audiences: [] } as any); // LIST (lookalike reuse-by-name check)
      manageSpy.mockResolvedValueOnce({
        success: true, audience: { id: 'aud_lookalike_1', name: 'RankAI Warm List - Lookalike' },
      } as any); // CREATE
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_2', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), use_lookalike: true, lookalike_ratio: 0.01, lookalike_country: 'US',
      }));

      // ENG-600 live-test finding: Meta rejected lookalike_spec.origin entries
      // missing "type": "custom_audience" with "(#2654) ... No custom_audience
      // ID given for lookalike cluster" — the origin entry must be fully
      // shaped, not just {id}.
      expect(manageSpy).toHaveBeenNthCalledWith(2, USER_ID, 'CREATE', ACCOUNT_ID, expect.objectContaining({
        subtype: 'LOOKALIKE',
        lookalike_spec: { origin: [{ id: 'aud_seed_2', type: 'custom_audience' }], ratio: 0.01, country: 'US' },
      }));
      expect(result.ledger.lookalike).toEqual({ id: 'aud_lookalike_1', name: 'RankAI Warm List - Lookalike', ratio: 0.01, country: 'US' });
      const adSetCallArgs = (agentModeService.createMetaAdsAdSet as jest.Mock).mock.calls[0][1];
      expect(adSetCallArgs.targeting.custom_audiences).toEqual([{ id: 'aud_lookalike_1' }]);
    });

    // Greptile finding: releasing the confirm token on a downstream failure
    // (e.g. ad-set creation) lets the user retry the SAME approved args —
    // but if the earlier lookalike CREATE already succeeded before that
    // failure, an unconditional retry would CREATE again (not idempotent by
    // name), leaving a duplicate lookalike audience from a single
    // confirmation. Reusing an existing same-named lookalike by exact match
    // (same pattern as the seed audience) prevents the duplicate.
    it('reuses an existing same-named Lookalike Audience instead of creating a duplicate on retry', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_3', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      const manageSpy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      manageSpy.mockResolvedValueOnce({
        success: true, audiences: [{
          id: 'aud_lookalike_existing', name: 'RankAI Warm List - Lookalike',
          lookalike_spec: { ratio: 0.01, country: 'US', origin: [{ id: 'aud_seed_3', type: 'custom_audience' }] },
        }],
      } as any); // LIST — finds the lookalike created by a prior (failed-after-this-step) attempt, same spec requested now
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_3', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), use_lookalike: true, lookalike_ratio: 0.01, lookalike_country: 'US',
      }));

      // Only LIST — no CREATE call for the lookalike, since one already exists by name.
      expect(manageSpy).not.toHaveBeenCalledWith(USER_ID, 'CREATE', ACCOUNT_ID, expect.objectContaining({ subtype: 'LOOKALIKE' }));
      expect(result.ledger.lookalike).toEqual({
        id: 'aud_lookalike_existing', name: 'RankAI Warm List - Lookalike', ratio: 0.01, country: 'US',
      });
      const adSetCallArgs = (agentModeService.createMetaAdsAdSet as jest.Mock).mock.calls[0][1];
      expect(adSetCallArgs.targeting.custom_audiences).toEqual([{ id: 'aud_lookalike_existing' }]);
    });

    // Greptile finding: a same-named lookalike from a PRIOR launch with
    // DIFFERENT ratio/country (a deliberate new request, not a retry — the
    // confirm-token digest already includes ratio/country, so reaching this
    // code with a genuinely different digest means a fresh, separately
    // confirmed launch) must NOT be silently reused — the campaign would
    // target the old population while the ledger reports the newly
    // requested ratio/country. Name-only matching isn't sufficient; the
    // existing audience's actual spec must also match.
    it('creates a new Lookalike Audience (does not reuse) when a same-named one exists with a different ratio/country', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_4', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      const manageSpy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      manageSpy.mockResolvedValueOnce({
        success: true, audiences: [{
          id: 'aud_lookalike_old_spec', name: 'RankAI Warm List - Lookalike',
          lookalike_spec: { ratio: 0.05, country: 'CA' }, // different from the 0.01/US requested below
        }],
      } as any); // LIST
      manageSpy.mockResolvedValueOnce({
        success: true, audience: { id: 'aud_lookalike_new', name: 'RankAI Warm List - Lookalike' },
      } as any); // CREATE
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_4', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), use_lookalike: true, lookalike_ratio: 0.01, lookalike_country: 'US',
      }));

      expect(manageSpy).toHaveBeenNthCalledWith(2, USER_ID, 'CREATE', ACCOUNT_ID, expect.objectContaining({
        subtype: 'LOOKALIKE',
        lookalike_spec: { origin: [{ id: 'aud_seed_4', type: 'custom_audience' }], ratio: 0.01, country: 'US' },
      }));
      expect(result.ledger.lookalike).toEqual({
        id: 'aud_lookalike_new', name: 'RankAI Warm List - Lookalike', ratio: 0.01, country: 'US',
      });
    });

    // Greptile follow-up finding: matching ratio/country alone isn't
    // enough — a same-named lookalike with the SAME ratio/country but built
    // from a DIFFERENT seed audience must also not be reused, or the new
    // campaign targets the old seed population entirely.
    it('creates a new Lookalike Audience (does not reuse) when a same-named/same-spec one exists from a different seed audience', async () => {
      delete process.env.META_TEST_ACCOUNT_ALLOWLIST;
      jest.spyOn(agentModeService as any, 'resolveOrCreateSeedAudience').mockResolvedValueOnce({
        plannedAction: 'reuse', audience: { id: 'aud_seed_5', name: 'RankAI Warm List' }, created: false,
        sourceSummary: 'CSV upload (...)', failures: [],
      });
      const manageSpy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      manageSpy.mockResolvedValueOnce({
        success: true, audiences: [{
          id: 'aud_lookalike_old_seed', name: 'RankAI Warm List - Lookalike',
          lookalike_spec: { ratio: 0.01, country: 'US', origin: [{ id: 'aud_seed_OLD', type: 'custom_audience' }] },
        }],
      } as any); // LIST
      manageSpy.mockResolvedValueOnce({
        success: true, audience: { id: 'aud_lookalike_new_seed', name: 'RankAI Warm List - Lookalike' },
      } as any); // CREATE
      jest.spyOn(agentModeService, 'createMetaAdsAdSet').mockResolvedValueOnce({
        success: true, adSet: { id: 'adset_5', name: 'Targeted Ad Set' },
      } as any);

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm({
        ...baseArgs(), use_lookalike: true, lookalike_ratio: 0.01, lookalike_country: 'US',
      }));

      expect(manageSpy).toHaveBeenNthCalledWith(2, USER_ID, 'CREATE', ACCOUNT_ID, expect.objectContaining({
        subtype: 'LOOKALIKE',
        lookalike_spec: { origin: [{ id: 'aud_seed_5', type: 'custom_audience' }], ratio: 0.01, country: 'US' },
      }));
      expect(result.ledger.lookalike).toEqual({
        id: 'aud_lookalike_new_seed', name: 'RankAI Warm List - Lookalike', ratio: 0.01, country: 'US',
      });
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

      const result = await agentModeService.launchRetargetingCampaign(USER_ID, withConfirm({
        ...baseArgs(), audience_name: 'Retargeting Warm List', exclude_audience_id: 'aud_broad_control',
      }));

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

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm(baseArgs()));

      expect(result.success).toBe(false);
      expect(result.ledger.failures).toEqual([{ step: 'launch', message: 'Payload is empty — no user rows to upload.' }]);
      expect(createAdSetSpy).not.toHaveBeenCalled();

      // Greptile finding: once claimed, a failure below (here: seed
      // resolution) left the token permanently consumed — since the digest
      // is deterministic given the same args, re-previewing unchanged
      // arguments would produce the SAME token, already claimed forever.
      // Releasing on failure lets the user retry the exact approved
      // arguments after fixing the underlying problem.
      expect(releasePreviewToken).toHaveBeenCalledWith(USER_ID, expect.any(String));
      // A failed launch must never be marked permanently consumed — that
      // would make the just-released token unreclaimable too.
      expect(markPreviewTokenSucceeded).not.toHaveBeenCalled();
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

      const result = await agentModeService.launchTargetedAudienceCampaign(USER_ID, withConfirm(baseArgs()));

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
