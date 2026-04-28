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
