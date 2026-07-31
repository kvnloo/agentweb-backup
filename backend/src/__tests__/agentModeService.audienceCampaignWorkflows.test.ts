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
}));
jest.mock('../utils/ssrfGuard', () => ({
  assertPublicHostname: jest.fn().mockResolvedValue(undefined),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import axios from 'axios';
import { AgentModeService } from '../services/agentModeService';
import { getAudienceSnapshotRowKeys, saveAudienceSnapshotRowKeys } from '../services/metaAudienceSnapshotStore';
import { claimPreviewToken, releasePreviewToken } from '../services/metaAudienceCampaignTokenStore';
import { assertPublicHostname } from '../utils/ssrfGuard';

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
    (assertPublicHostname as jest.Mock).mockResolvedValue(undefined);
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
      (assertPublicHostname as jest.Mock).mockRejectedValueOnce(new SsrfBlockedError());

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
    it('blocks the launch (throws) when the snapshot save fails after exhausting retries', async () => {
      const spy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences');
      spy.mockResolvedValueOnce({ success: true, audiences: [{ id: 'aud_4', name: 'X' }] } as any); // LIST
      spy.mockResolvedValueOnce({ success: true } as any); // UPLOAD_USERS

      jest.spyOn(agentModeService as any, 'resolveHubSpotService').mockResolvedValue(
        mockHubSpotContact('a@example.com', '111')
      );
      (getAudienceSnapshotRowKeys as jest.Mock).mockResolvedValue(null);
      (saveAudienceSnapshotRowKeys as jest.Mock).mockRejectedValueOnce(new Error('DynamoDB unavailable'));

      await expect(callResolveOrCreateSeedAudience(
        USER_ID, ACCOUNT_ID, 'X',
        { type: 'hubspot_list', listId: 'list-1' },
        { dryRun: false }
      )).rejects.toThrow('DynamoDB unavailable');
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
      const manageSpy = jest.spyOn(agentModeService, 'manageMetaCustomAudiences').mockResolvedValueOnce({
        success: true, audience: { id: 'aud_lookalike_1', name: 'RankAI Warm List - Lookalike' },
      } as any);
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
      expect(manageSpy).toHaveBeenCalledWith(USER_ID, 'CREATE', ACCOUNT_ID, expect.objectContaining({
        subtype: 'LOOKALIKE',
        lookalike_spec: { origin: [{ id: 'aud_seed_2', type: 'custom_audience' }], ratio: 0.01, country: 'US' },
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
