/**
 * Unit tests for isTokenValid().
 *
 * Bug context: Gmail accounts were shown as is_active=false in the Emma tool
 * even after a successful reconnect because isTokenValid() only recognised
 * LinkedIn as a platform that can auto-renew via refresh_token. Any other
 * platform with an expired access_token (including Gmail, whose tokens expire
 * after ~1 hour) was incorrectly declared invalid even though a refresh_token
 * was present.
 *
 * Fix: canAttemptRefresh now checks for any refresh_token, not just LinkedIn.
 */

jest.mock('../services/socialPlatformService', () => ({
  socialPlatformService: {
    getAdapter: jest.fn().mockReturnValue({
      verifyToken: jest.fn().mockResolvedValue(true),
    }),
  },
}));

import { isTokenValid, ConnectedAccount } from '../services/connectedAccountsDb';

const NOW = Date.now();
const EXPIRED = NOW - 10_000;   // 10 seconds in the past
const FUTURE  = NOW + 3_600_000; // 1 hour in the future

function makeAccount(
  platform: string,
  token_expires_at: number,
  refresh_token?: string,
): ConnectedAccount {
  return {
    platform: platform as any,
    account_id: 'acct-1',
    account_name: 'Test Account',
    config: {
      account_type: 'personal',
      access_token: 'access',
      refresh_token,
      token_expires_at,
      scopes: [],
    } as any,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

describe('isTokenValid', () => {
  describe('Gmail', () => {
    it('returns true when access token is still valid', async () => {
      const account = makeAccount('gmail', FUTURE, 'refresh-token');
      expect(await isTokenValid(account)).toBe(true);
    });

    it('returns true when access token is expired but refresh_token exists', async () => {
      // Core bug: expired Gmail token with refresh_token was returning false
      const account = makeAccount('gmail', EXPIRED, 'refresh-token');
      expect(await isTokenValid(account)).toBe(true);
    });

    it('returns false when access token is expired and no refresh_token', async () => {
      const account = makeAccount('gmail', EXPIRED, undefined);
      expect(await isTokenValid(account)).toBe(false);
    });
  });

  describe('Other OAuth platforms with refresh tokens (e.g. HubSpot)', () => {
    it('returns true when access token is expired but refresh_token exists', async () => {
      const account = makeAccount('hubspot', EXPIRED, 'refresh-token');
      expect(await isTokenValid(account)).toBe(true);
    });

    it('returns false when access token is expired and no refresh_token', async () => {
      const account = makeAccount('hubspot', EXPIRED, undefined);
      expect(await isTokenValid(account)).toBe(false);
    });
  });

  describe('LinkedIn (existing behaviour preserved)', () => {
    it('returns true when access token is valid (delegates to adapter)', async () => {
      const account = makeAccount('linkedin', FUTURE, 'refresh-token');
      expect(await isTokenValid(account)).toBe(true);
    });

    it('returns true when access token is expired but refresh_token exists (adapter handles refresh)', async () => {
      const account = makeAccount('linkedin', EXPIRED, 'refresh-token');
      expect(await isTokenValid(account)).toBe(true);
    });

    it('returns false when access token is expired and no refresh_token', async () => {
      const { socialPlatformService } = require('../services/socialPlatformService');
      socialPlatformService.getAdapter.mockReturnValueOnce({
        verifyToken: jest.fn().mockResolvedValue(false),
      });
      const account = makeAccount('linkedin', EXPIRED, undefined);
      expect(await isTokenValid(account)).toBe(false);
    });
  });

  describe('Platforms without refresh tokens (e.g. Twitter/X)', () => {
    it('returns true when access token is still valid', async () => {
      const account = makeAccount('twitter', FUTURE, undefined);
      expect(await isTokenValid(account)).toBe(true);
    });

    it('returns false when access token is expired', async () => {
      const account = makeAccount('twitter', EXPIRED, undefined);
      expect(await isTokenValid(account)).toBe(false);
    });
  });
});

/*
 * A dead credential must read as dead to Emma, not just to the Settings page.
 *
 * routes/connectedAccounts.ts reports a flagged hubspot/twitter account as
 * "Reconnect required", while isTokenValid trusted the mere PRESENCE of a refresh_token —
 * so list_connected_accounts handed the model `is_active: true` for the same account. The
 * assistant then tells a customer their integration is fine while the UI says it is
 * broken. That is the inconsistency the Meta Ads branch of that route exists to prevent
 * (ENG-1158), reached here through a different door.
 *
 * Attio is deliberately exempt: it sets the same key for a 403 registering the webhook
 * (a missing webhook:read-write scope), where the token is valid and CRM reads/writes
 * still work. Reporting that account as dead would be the same lie inverted.
 */
describe('isTokenValid and a dead credential', () => {
  const account = (platform: string, config: Record<string, unknown> = {}): any => ({
    platform,
    account_id: 'acct-1',
    account_name: 'Test',
    config: {
      access_token: 'tok',
      refresh_token: 'refresh',
      // Expired, so the refresh_token-presence path is the one under test.
      token_expires_at: Date.now() - 60 * 60 * 1000,
      ...config,
    },
  });

  it.each([['hubspot'], ['twitter']])(
    'reports a flagged %s account as invalid despite a refresh_token',
    async (platform) => {
      await expect(isTokenValid(account(platform, { needs_reconnect: true }))).resolves.toBe(false);
    },
  );

  it.each([['hubspot'], ['twitter']])(
    'still reports an UNflagged %s account as valid', async (platform) => {
      await expect(isTokenValid(account(platform))).resolves.toBe(true);
      await expect(isTokenValid(account(platform, { needs_reconnect: false }))).resolves.toBe(true);
    },
  );

  it('does NOT report a flagged attio account as invalid — its flag means a missing webhook scope, not a dead token', async () => {
    await expect(isTokenValid(account('attio', { needs_reconnect: true }))).resolves.toBe(true);
  });

  it('a flagged account with no refresh_token is invalid for the original reason too', async () => {
    await expect(
      isTokenValid(account('hubspot', { needs_reconnect: true, refresh_token: undefined })),
    ).resolves.toBe(false);
  });
});
