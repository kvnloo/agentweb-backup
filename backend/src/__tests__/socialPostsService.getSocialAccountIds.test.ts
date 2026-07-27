import { getSocialAccountIds } from '../services/socialPostsService';
import * as connectedAccountsDb from '../services/connectedAccountsDb';

jest.mock('../services/connectedAccountsDb');
jest.mock('../services/socialPlatformService');
jest.mock('../services/linkedInService');
jest.mock('../services/linkedInPostsDb');

const mockGetAccountsByUserId = connectedAccountsDb.getAccountsByUserId as jest.Mock;

const createMockAccount = (
  overrides: Partial<connectedAccountsDb.ConnectedAccount> = {}
): connectedAccountsDb.ConnectedAccount => ({
  platform: 'linkedin' as connectedAccountsDb.PlatformType,
  account_id: 'urn:li:organization:acme',
  account_name: 'Acme Corp',
  config: {
    account_type: 'company_page',
    access_token: 'token123',
    token_expires_at: Date.now() + 100000,
  } as any,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

describe('getSocialAccountIds', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─── FAIL / exclusion cases ──────────────────────────────────────────────

  it('excludes personal LinkedIn accounts — force_reload is a no-op for them', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      createMockAccount({
        account_id: 'urn:li:person:jane',
        config: { account_type: 'personal', access_token: 't', token_expires_at: Date.now() + 1000 } as any,
      }),
    ]);

    const ids = await getSocialAccountIds('user-1');

    expect(ids).toEqual([]);
  });

  it('excludes Instagram accounts — the adapter does not accept a force_reload option', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      createMockAccount({
        platform: 'instagram' as connectedAccountsDb.PlatformType,
        account_id: 'ig-acme',
        config: { account_type: 'instagram_business', access_token: 't', token_expires_at: Date.now() + 1000 } as any,
      }),
    ]);

    const ids = await getSocialAccountIds('user-1');

    expect(ids).toEqual([]);
  });

  it('excludes accounts on unrelated platforms', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      createMockAccount({
        platform: 'twitter' as connectedAccountsDb.PlatformType,
        account_id: 'tw-acme',
        config: { account_type: 'personal', access_token: 't', token_expires_at: Date.now() + 1000 } as any,
      }),
    ]);

    const ids = await getSocialAccountIds('user-1');

    expect(ids).toEqual([]);
  });

  it('returns an empty array for a user with no connected accounts', async () => {
    mockGetAccountsByUserId.mockResolvedValue([]);

    const ids = await getSocialAccountIds('user-1');

    expect(ids).toEqual([]);
  });

  // ─── SUCCESS case ─────────────────────────────────────────────────────────

  it('returns only LinkedIn company-page account ids, filtering out no-op accounts in the same list', async () => {
    mockGetAccountsByUserId.mockResolvedValue([
      createMockAccount({ account_id: 'urn:li:organization:acme' }), // company_page — eligible
      createMockAccount({
        account_id: 'urn:li:person:jane',
        config: { account_type: 'personal', access_token: 't', token_expires_at: Date.now() + 1000 } as any,
      }), // personal — excluded
      createMockAccount({
        platform: 'instagram' as connectedAccountsDb.PlatformType,
        account_id: 'ig-acme',
        config: { account_type: 'instagram_business', access_token: 't', token_expires_at: Date.now() + 1000 } as any,
      }), // instagram — excluded
      createMockAccount({ account_id: 'urn:li:organization:beta' }), // company_page — eligible
    ]);

    const ids = await getSocialAccountIds('user-1');

    expect(ids).toEqual(['urn:li:organization:acme', 'urn:li:organization:beta']);
  });
});
