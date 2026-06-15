/**
 * Tests for proactive/inline Meta ad-account token refresh.
 *
 * Meta issues no refresh tokens; a still-valid long-lived token must be
 * re-exchanged via fb_exchange_token before it expires. These tests cover the
 * decision logic (needsMetaRefresh) and the refresh-and-persist behaviour
 * (ensureFreshMetaAdAccountToken), including the failure path that must NOT
 * throw.
 */

jest.mock('../services/metaService', () => ({
  metaService: {
    extendAccessToken: jest.fn(),
  },
}));

jest.mock('../services/connectedAccountsDb', () => ({
  updateAccountTokens: jest.fn().mockResolvedValue(undefined),
}));

import {
  needsMetaRefresh,
  ensureFreshMetaAdAccountToken,
  META_REFRESH_WINDOW_MS,
  META_DEFAULT_TOKEN_TTL_MS,
} from '../services/metaTokenRefresh';
import { metaService } from '../services/metaService';
import { updateAccountTokens } from '../services/connectedAccountsDb';

const NOW = 1_700_000_000_000;

function makeMetaAdAccount(overrides: any = {}): any {
  const { config: configOverride, ...rest } = overrides;
  return {
    platform: 'meta',
    account_id: '26242538088719416',
    account_name: 'Rankai',
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...rest,
    config: {
      account_type: 'ad_account',
      ad_account_id: '26242538088719416',
      access_token: 'OLD_TOKEN',
      token_expires_at: NOW + 60 * 24 * 60 * 60 * 1000, // 60 days out
      ...configOverride,
    },
  };
}

describe('needsMetaRefresh', () => {
  it('FAIL: returns false for a non-Meta account', () => {
    const gmail = makeMetaAdAccount({ platform: 'gmail' });
    expect(needsMetaRefresh(gmail, NOW)).toBe(false);
  });

  it('FAIL: returns false for a Meta page (not an ad_account)', () => {
    const page = makeMetaAdAccount({ config: { account_type: 'page' } });
    expect(needsMetaRefresh(page, NOW)).toBe(false);
  });

  it('FAIL: returns false when token is comfortably far from expiry', () => {
    const account = makeMetaAdAccount({
      config: { token_expires_at: NOW + 30 * 24 * 60 * 60 * 1000 },
    });
    expect(needsMetaRefresh(account, NOW)).toBe(false);
  });

  it('returns true when token expires within the refresh window', () => {
    const account = makeMetaAdAccount({
      config: { token_expires_at: NOW + META_REFRESH_WINDOW_MS - 1000 },
    });
    expect(needsMetaRefresh(account, NOW)).toBe(true);
  });

  it('returns true when token is already expired', () => {
    const account = makeMetaAdAccount({ config: { token_expires_at: NOW - 1000 } });
    expect(needsMetaRefresh(account, NOW)).toBe(true);
  });

  it('returns true when token_expires_at is missing', () => {
    const account = makeMetaAdAccount({ config: { token_expires_at: undefined } });
    expect(needsMetaRefresh(account, NOW)).toBe(true);
  });

  it('recognizes the legacy "facebook" platform value', () => {
    const account = makeMetaAdAccount({ platform: 'facebook', config: { token_expires_at: NOW - 1 } });
    expect(needsMetaRefresh(account, NOW)).toBe(true);
  });
});

describe('ensureFreshMetaAdAccountToken', () => {
  beforeEach(() => jest.clearAllMocks());

  it('no-ops (no attempt) when the token is far from expiry', async () => {
    const account = makeMetaAdAccount();
    const result = await ensureFreshMetaAdAccountToken(account, 'user1', NOW);

    expect(result).toEqual({ attempted: false, refreshed: false });
    expect(metaService.extendAccessToken).not.toHaveBeenCalled();
    expect(updateAccountTokens).not.toHaveBeenCalled();
  });

  it('refreshes, persists, and mutates config when token is within window', async () => {
    (metaService.extendAccessToken as jest.Mock).mockResolvedValue({
      access_token: 'NEW_TOKEN',
      expires_in: 5_184_000, // 60 days in seconds
    });
    const account = makeMetaAdAccount({
      config: { token_expires_at: NOW + 1000 }, // about to expire
    });

    const result = await ensureFreshMetaAdAccountToken(account, 'user1', NOW);

    expect(metaService.extendAccessToken).toHaveBeenCalledWith('OLD_TOKEN');
    expect(result.attempted).toBe(true);
    expect(result.refreshed).toBe(true);
    expect(result.newExpiresAt).toBe(NOW + 5_184_000 * 1000);
    // config mutated in place for the in-flight request
    expect(account.config.access_token).toBe('NEW_TOKEN');
    expect(account.config.token_expires_at).toBe(NOW + 5_184_000 * 1000);
    // persisted with the correct account id + platform
    expect(updateAccountTokens).toHaveBeenCalledWith(
      'user1',
      'meta',
      { access_token: 'NEW_TOKEN', token_expires_at: NOW + 5_184_000 * 1000 },
      '26242538088719416'
    );
  });

  it('falls back to 60-day TTL when Meta returns no expires_in', async () => {
    (metaService.extendAccessToken as jest.Mock).mockResolvedValue({ access_token: 'NEW_TOKEN' });
    const account = makeMetaAdAccount({ config: { token_expires_at: NOW - 1 } });

    const result = await ensureFreshMetaAdAccountToken(account, 'user1', NOW);

    expect(result.refreshed).toBe(true);
    expect(result.newExpiresAt).toBe(NOW + META_DEFAULT_TOKEN_TTL_MS);
    expect(account.config.token_expires_at).toBe(NOW + META_DEFAULT_TOKEN_TTL_MS);
  });

  it('does NOT throw and reports error when the exchange fails', async () => {
    (metaService.extendAccessToken as jest.Mock).mockRejectedValue(new Error('token too old'));
    const account = makeMetaAdAccount({ config: { token_expires_at: NOW - 1 } });

    const result = await ensureFreshMetaAdAccountToken(account, 'user1', NOW);

    expect(result.attempted).toBe(true);
    expect(result.refreshed).toBe(false);
    expect(result.error).toMatch(/token too old/);
    // old token left intact so caller can decide
    expect(account.config.access_token).toBe('OLD_TOKEN');
    expect(updateAccountTokens).not.toHaveBeenCalled();
  });
});
