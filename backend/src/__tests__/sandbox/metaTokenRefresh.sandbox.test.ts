/**
 * ENG-1908: a sandbox Meta connection carries a sentinel token that is meaningless to Meta.
 * The refresh helper must never try to exchange it — no HTTP, no persistence — while a
 * real token near expiry still follows the existing refresh path unchanged.
 */
jest.mock('../../services/metaService', () => ({ metaService: { extendAccessToken: jest.fn() } }));
jest.mock('../../services/connectedAccountsDb', () => ({ updateAccountTokens: jest.fn().mockResolvedValue(undefined) }));

import { ensureFreshMetaAdAccountToken, needsMetaRefresh } from '../../services/metaTokenRefresh';
import { mintSandboxToken } from '../../services/sandbox/sentinel';
import { metaService } from '../../services/metaService';
import { updateAccountTokens } from '../../services/connectedAccountsDb';

const NOW = 1_700_000_000_000;
const account = (access_token: string, token_expires_at: number): any => ({
  platform: 'meta', account_id: '1207000000000001', account_name: 'Sandbox account',
  created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
  config: { account_type: 'ad_account', ad_account_id: '1207000000000001', access_token, token_expires_at },
});

beforeEach(() => jest.clearAllMocks());

describe('sandbox sentinel tokens are never refreshed', () => {
  const sentinel = mintSandboxToken('eval_00000000-0000-4000-8000-000000000001');

  it('needsMetaRefresh is false for a sandbox token even when it is inside the refresh window', () => {
    expect(needsMetaRefresh(account(sentinel, NOW + 1000), NOW)).toBe(false);
    expect(needsMetaRefresh(account(sentinel, NOW - 1000), NOW)).toBe(false);
  });

  it('ensureFreshMetaAdAccountToken returns the connection unchanged with no exchange and no write', async () => {
    const acct = account(sentinel, NOW + 1000);
    const result = await ensureFreshMetaAdAccountToken(acct, 'eval_00000000-0000-4000-8000-000000000001', NOW);
    expect(result).toEqual({ attempted: false, refreshed: false });
    expect(metaService.extendAccessToken).not.toHaveBeenCalled();
    expect(updateAccountTokens).not.toHaveBeenCalled();
    expect(acct.config.access_token).toBe(sentinel);
  });

  it('a real token inside the window still refreshes through the existing path', async () => {
    (metaService.extendAccessToken as jest.Mock).mockResolvedValue({ access_token: 'NEW_TOKEN', expires_in: 5184000 });
    const acct = account('EAAreal', NOW + 1000);
    const result = await ensureFreshMetaAdAccountToken(acct, 'customer-1', NOW);
    expect(result.refreshed).toBe(true);
    expect(metaService.extendAccessToken).toHaveBeenCalledWith('EAAreal');
    expect(updateAccountTokens).toHaveBeenCalledTimes(1);
    expect(acct.config.access_token).toBe('NEW_TOKEN');
  });
});
