/**
 * Tests for getMetaAccountCredentials's account-selection logic — the exact function
 * webhooks.ts's forward-lead CAPI send and metaService.resolveMetaPixelForUser rely on
 * to turn a caller-supplied `metaAccountId` (in forward-lead's case, an untrusted value
 * baked into a public, client-side-controllable generated route.ts) into an access token.
 *
 * The one existing indirect test (metaV2Routes.test.ts's "inline token self-heal" block)
 * only exercises a user with a SINGLE connected account — the single-account fallback
 * path never even reads `accountId`. The security-relevant branch — multiple connected
 * accounts, select by `accountId`, and REJECT (never silently fall back) when it doesn't
 * match any of THIS user's own accounts — had zero direct coverage before this file.
 */

jest.mock('../services/metaTokenRefresh', () => ({
  ensureFreshMetaAdAccountToken: jest.fn().mockResolvedValue({ attempted: false, refreshed: false }),
}));

import { getMetaAccountCredentials, getConnectedMetaAccountsList, cleanAccountId } from '../services/metaAccountCredentials';

function makeAccount(accountId: string, overrides: any = {}) {
  return {
    platform: 'meta',
    account_id: accountId,
    account_name: `Account ${accountId}`,
    config: {
      account_type: 'ad_account',
      access_token: `token-${accountId}`,
      ...overrides,
    },
  };
}

describe('getMetaAccountCredentials', () => {
  it('FAIL: throws when the user has zero connected Meta ad accounts', async () => {
    const user = { connected_accounts: [] };
    await expect(getMetaAccountCredentials(user, 'u1')).rejects.toThrow(/No Meta ad account connected/);
  });

  it('FAIL: with 2+ accounts and NO accountId given, throws ambiguous rather than guessing', async () => {
    const user = { connected_accounts: [makeAccount('111'), makeAccount('222')] };
    await expect(getMetaAccountCredentials(user, 'u1')).rejects.toThrow(/Multiple Meta ad accounts found/);
  });

  it('FAIL: with 2+ accounts, an accountId that matches NONE of this user\'s own accounts throws — never silently falls back to a different account', async () => {
    const user = { connected_accounts: [makeAccount('111'), makeAccount('222')] };
    await expect(getMetaAccountCredentials(user, 'u1', '999999999')).rejects.toThrow(
      /not found in your connected accounts/,
    );
  });

  it("SUCCESS: with 2+ accounts, an accountId that matches one of THIS user's own accounts returns that account's own credentials, not another's", async () => {
    const user = {
      connected_accounts: [
        makeAccount('111', { access_token: 'token-for-111' }),
        makeAccount('222', { access_token: 'token-for-222' }),
      ],
    };
    const result = await getMetaAccountCredentials(user, 'u1', '222');
    expect(result.accountId).toBe('222');
    expect(result.accessToken).toBe('token-for-222');
  });

  it('SUCCESS: accountId is accepted with or without the act_ prefix (cleanAccountId normalizes both sides)', async () => {
    const user = { connected_accounts: [makeAccount('act_333')] };
    const result = await getMetaAccountCredentials(user, 'u1', '333');
    expect(result.accountId).toBe('333');
  });

  it('SUCCESS: a single connected account is used even with no accountId given', async () => {
    const user = { connected_accounts: [makeAccount('444')] };
    const result = await getMetaAccountCredentials(user, 'u1');
    expect(result.accountId).toBe('444');
  });

  it('FAIL: non-ad-account or non-meta/facebook connections are excluded from selection entirely', async () => {
    const user = {
      connected_accounts: [
        { platform: 'linkedin', account_id: '555', config: { account_type: 'ad_account', access_token: 't' } },
        { platform: 'meta', account_id: '666', config: { account_type: 'page', access_token: 't' } },
      ],
    };
    await expect(getMetaAccountCredentials(user, 'u1')).rejects.toThrow(/No Meta ad account connected/);
  });
});

describe('getConnectedMetaAccountsList', () => {
  it('SUCCESS: lists only meta/facebook ad_account connections with an access token, cleaning the act_ prefix', () => {
    const user = {
      connected_accounts: [
        makeAccount('act_777'),
        { platform: 'linkedin', account_id: '888', config: { account_type: 'ad_account', access_token: 't' } },
        { platform: 'meta', account_id: '999', config: { account_type: 'ad_account' } }, // no token — excluded
      ],
    };
    const list = getConnectedMetaAccountsList(user);
    expect(list).toHaveLength(1);
    expect(list[0].accountId).toBe('777');
  });
});

describe('cleanAccountId', () => {
  it('strips the act_ prefix', () => {
    expect(cleanAccountId('act_123')).toBe('123');
  });

  it('passes through an id with no prefix unchanged', () => {
    expect(cleanAccountId('123')).toBe('123');
  });

  it('handles an empty/undefined id without throwing', () => {
    expect(cleanAccountId('')).toBe('');
  });
});
