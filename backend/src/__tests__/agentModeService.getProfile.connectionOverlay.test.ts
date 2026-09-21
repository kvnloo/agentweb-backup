/**
 * ENG-440 — get-profile connection-signal overlay.
 *
 * The global Unipile profile cache strips is_relationship/connected_at because
 * they are viewer-relative. The linkedinOutreach('get-profile') handler must
 * therefore re-derive them for THIS account from our per-account
 * AW-UnipileConnections cache (the authoritative ENG-377 path), so the agent's
 * invite-vs-DM decision has a correct, non-leaked connection signal — while
 * NEVER mutating the shared cached rawData object.
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
    // These tests always pass an explicit account_id that IS the user's own
    // account, so usedSharedAccount must resolve to false (ENG-1198) — the
    // whole point of this suite is to exercise the overlay on a genuine own
    // account, not a borrowed shared one.
    listUserOwnedUnipileAccountIds: jest.fn().mockResolvedValue(['unipile-acc-1']),
    // linkedinOutreach preflights the Unipile session before every action (ENG-281).
    // These tests exercise the connection overlay on a live account, so the probe
    // reports connected; the disconnected path is covered in
    // agentModeService.linkedInOutreach.test.ts.
    isAccountConnected: jest.fn().mockResolvedValue(true),
    probeAccountSession: jest.fn().mockResolvedValue('connected'),
    clearStatusCache: jest.fn(),
  },
}));

// Minimal stubs for transitive dependencies pulled in by agentModeService
jest.mock('../services/db', () => ({ crmDb: {} }));
jest.mock('../services/resendService', () => ({ resendService: { sendEmail: jest.fn() } }));
jest.mock('../services/gmailService',  () => ({ gmailService:  { sendEmail: jest.fn() } }));

import { AgentModeService } from '../services/agentModeService';
import * as unipileProfileServiceFactory from '../services/unipileProfileServiceFactory';
import * as unipileConnectionsDb from '../services/unipileConnectionsDb';

const mockGetService = unipileProfileServiceFactory.getUnipileProfileService as jest.Mock;
const mockGetConnection = unipileConnectionsDb.getConnectionByProfileUrlAndAccount as jest.Mock;

describe('AgentModeService.linkedinOutreach get-profile — connection overlay (ENG-440)', () => {
  let service: AgentModeService;
  const userId = 'user-1';
  const accountId = 'unipile-acc-1';

  /** Wire the cached profile service to return a given rawData blob.
   *  fromCache defaults to true (cache hit); pass false to model a live response. */
  function stubProfile(rawData: any, fromCache = true) {
    mockGetService.mockReturnValue({
      getProfile: jest.fn().mockResolvedValue({
        rawData,
        fromCache,
        found: true,
        checkedAt: '2026-07-21T00:00:00.000Z',
      }),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentModeService();
  });

  it('sets is_relationship:true + connected_at from the per-account cache on a hit where the blob lacks it', async () => {
    // Global-cache hit → viewer-relative fields already stripped from the blob.
    const rawData = { public_identifier: 'srisunda', first_name: 'Sri' };
    stubProfile(rawData);
    mockGetConnection.mockResolvedValue({ accountId, memberId: 'sri', connectedAt: 1780960142000 });

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'http://www.linkedin.com/in/srisunda',
      account_id: accountId,
    });

    expect(res.success).toBe(true);
    expect(res.data.is_relationship).toBe(true);
    expect(res.data.connected_at).toBe(1780960142000);
    // The lookup key is built from the profile's authoritative public_identifier
    // (getConnectionByProfileUrlAndAccount normalizes scheme/www internally anyway).
    expect(mockGetConnection).toHaveBeenCalledWith(
      'https://www.linkedin.com/in/srisunda',
      accountId,
    );
  });

  it('does NOT mutate the shared cached rawData object (no cross-viewer re-leak)', async () => {
    const rawData: any = { public_identifier: 'srisunda', first_name: 'Sri' };
    stubProfile(rawData);
    mockGetConnection.mockResolvedValue({ accountId, connectedAt: 1780960142000 });

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/srisunda/',
      account_id: accountId,
    });

    // The returned object carries the overlay...
    expect(res.data.is_relationship).toBe(true);
    // ...but the original cached blob must stay untouched.
    expect(rawData).not.toHaveProperty('is_relationship');
    expect(rawData).not.toHaveProperty('connected_at');
    expect(res.data).not.toBe(rawData);
  });

  it('reports is_relationship:false when neither the per-account cache nor the blob shows a connection', async () => {
    stubProfile({ public_identifier: 'stranger', first_name: 'Stranger' });
    mockGetConnection.mockResolvedValue(null);

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/stranger/',
      account_id: accountId,
    });

    expect(res.data.is_relationship).toBe(false);
    expect(res.data).not.toHaveProperty('connected_at');
  });

  it('keeps is_relationship:true from a LIVE blob even when the per-account cache has no row (union)', async () => {
    // Cold call (fromCache:false): live blob legitimately carries this viewer's
    // is_relationship; connections cache lags.
    stubProfile(
      { public_identifier: 'julia', first_name: 'Julia', is_relationship: true, connected_at: 1780001882000 },
      false,
    );
    mockGetConnection.mockResolvedValue(null);

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/julia/',
      account_id: accountId,
    });

    expect(res.data.is_relationship).toBe(true);
    // A live response's own connected_at is retained when we have no cache row.
    expect(res.data.connected_at).toBe(1780001882000);
  });

  it('discards stale is_relationship/connected_at from a legacy cache-hit row (no cross-viewer leak)', async () => {
    // A row persisted BEFORE the strip fix still carries another viewer's state.
    // On a cache hit we must NOT trust it — only the per-account cache decides.
    stubProfile(
      { public_identifier: 'leaky', first_name: 'Leaky', is_relationship: true, connected_at: 999000000000 },
      true, // fromCache
    );
    mockGetConnection.mockResolvedValue(null); // this viewer has no connection row

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/leaky/',
      account_id: accountId,
    });

    // The leaked true/timestamp must be dropped, not passed through.
    expect(res.data.is_relationship).toBe(false);
    expect(res.data).not.toHaveProperty('connected_at');
  });

  it('overrides a legacy cache-hit is_relationship with the authoritative per-account cache', async () => {
    // Legacy row says false, but THIS account is genuinely connected per our cache.
    stubProfile(
      { public_identifier: 'realconn', first_name: 'Real', is_relationship: false, connected_at: 111000000000 },
      true, // fromCache
    );
    mockGetConnection.mockResolvedValue({ accountId, connectedAt: 1777170167000 });

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/realconn/',
      account_id: accountId,
    });

    expect(res.data.is_relationship).toBe(true);
    expect(res.data.connected_at).toBe(1777170167000); // authoritative, not the legacy 111...
  });

  it('builds the lookup URL from public_identifier when called by provider_id', async () => {
    stubProfile({ public_identifier: 'jinbaik', first_name: 'Jin' });
    mockGetConnection.mockResolvedValue({ accountId, connectedAt: 1777170167000 });

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      provider_id: 'ACoAAA-jin',
      account_id: accountId,
    });

    expect(res.data.is_relationship).toBe(true);
    expect(res.data.connected_at).toBe(1777170167000);
    expect(mockGetConnection).toHaveBeenCalledWith(
      'https://www.linkedin.com/in/jinbaik',
      accountId,
    );
  });

  it('does not throw and still returns the profile if the connection lookup fails', async () => {
    stubProfile({ public_identifier: 'srisunda', first_name: 'Sri' });
    mockGetConnection.mockRejectedValue(new Error('DynamoDB timeout'));

    const res = await service.linkedinOutreach(userId, {
      action: 'get-profile',
      profile_url: 'https://www.linkedin.com/in/srisunda/',
      account_id: accountId,
    });

    expect(res.success).toBe(true);
    expect(res.data.first_name).toBe('Sri');
    expect(res.data.is_relationship).toBe(false);
  });

  describe('an anonymized profile must not borrow a stranger\'s connection state', () => {
    // LinkedIn anonymizes out-of-network profiles with `public_identifier` set to the
    // literal string "undefined", and Unipile builds `public_profile_url` from that
    // same value. Both were used to derive the key passed to
    // getConnectionByProfileUrlAndAccount — a GSI lookup returning Items[0]. So EVERY
    // anonymized profile queried the same `/in/undefined` key, and the connection-sync
    // cron writes rows under exactly that key, which means the overlay could hand the
    // agent an unrelated person's is_relationship / connected_at and drive the
    // invite-vs-message decision off it.
    const anonymized = {
      first_name: 'LinkedIn',
      last_name: 'Member',
      public_identifier: 'undefined',
      public_profile_url: 'https://www.linkedin.com/in/undefined',
    };

    it('never queries the connection cache with the fabricated URL', async () => {
      stubProfile(anonymized);

      await service.linkedinOutreach(userId, {
        action: 'get-profile', account_id: accountId, provider_id: 'ACoAAA123',
      });

      for (const call of mockGetConnection.mock.calls) {
        expect(String(call[0])).not.toContain('/in/undefined');
      }
    });

    it('does not report a connection borrowed from that shared key', async () => {
      // A row really does sit under the fabricated key — written by the sync cron for
      // some other anonymized profile. If the lookup runs, this stranger's state
      // surfaces as the user's own.
      stubProfile(anonymized);
      mockGetConnection.mockResolvedValue({ publicId: 'someone-else', connectedAt: 1780960142000 });

      const res: any = await service.linkedinOutreach(userId, {
        action: 'get-profile', account_id: accountId, provider_id: 'ACoAAA123',
      });

      expect(res.success).toBe(true);
      expect(res.data.connected_at).toBeUndefined();
      expect(res.data.is_relationship).toBe(false);
    });

    it('does not hand back the sentinel the fabricated URL is built from', async () => {
      // Dropping public_profile_url alone left `public_identifier: "undefined"` on the
      // payload, which is the exact slug needed to rebuild the dead link.
      stubProfile(anonymized);

      const res: any = await service.linkedinOutreach(userId, {
        action: 'get-profile', account_id: accountId, provider_id: 'ACoAAA123',
      });

      expect(res.data.anonymized).toBe(true);
      expect(res.data.public_identifier).toBeUndefined();
      expect(JSON.stringify(res.data)).not.toContain('/in/undefined');
    });

    it('still overlays connection state for a REAL profile', async () => {
      // Guards the fix from over-reaching: the ENG-440 overlay must still work.
      stubProfile({ first_name: 'Sri', public_identifier: 'sri-real', public_profile_url: 'https://www.linkedin.com/in/sri-real' });
      mockGetConnection.mockResolvedValue({ publicId: 'sri-real', connectedAt: 1780960142000 });

      const res: any = await service.linkedinOutreach(userId, {
        action: 'get-profile', account_id: accountId, provider_id: 'ACoAAA999',
      });

      expect(res.data.is_relationship).toBe(true);
      expect(res.data.connected_at).toBe(1780960142000);
    });
  });
});
