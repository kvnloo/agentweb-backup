import { getPostsForUser } from '../services/socialPostsService';
import * as connectedAccountsDb from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';

jest.mock('../services/connectedAccountsDb');
jest.mock('../services/socialPlatformService');
jest.mock('../services/linkedInService');
jest.mock('../services/linkedInPostsDb');

const mockGetAccountsByUserId = connectedAccountsDb.getAccountsByUserId as jest.Mock;
const mockGetAdapter = socialPlatformService.getAdapter as jest.Mock;

const createMockAccount = (
  overrides: Partial<connectedAccountsDb.ConnectedAccount> = {}
): connectedAccountsDb.ConnectedAccount => ({
  platform: 'linkedin' as connectedAccountsDb.PlatformType,
  account_id: 'acc-1',
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

describe('getPostsForUser — per-account force_reload', () => {
  let listPosts: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    listPosts = jest.fn().mockResolvedValue([]);
    mockGetAdapter.mockReturnValue({ listPosts, getPostMetrics: jest.fn().mockResolvedValue([]) });
    mockGetAccountsByUserId.mockResolvedValue([
      createMockAccount({ account_id: 'acc-1' }),
      createMockAccount({ account_id: 'acc-2' }),
    ]);
  });

  // Maps each account id -> the force_reload flag the adapter was called with.
  const forceReloadByAccount = (): Record<string, boolean> => {
    const map: Record<string, boolean> = {};
    for (const call of listPosts.mock.calls) {
      map[call[0].account_id] = call[1].force_reload;
    }
    return map;
  };

  it('force-reloads only the accounts in forceReloadAccountIds, serving the rest from cache', async () => {
    await getPostsForUser('user-1', { forceReloadAccountIds: ['acc-2'] });

    expect(forceReloadByAccount()).toEqual({ 'acc-1': false, 'acc-2': true });
  });

  it('lets the allow-list override the forceReload boolean per account', async () => {
    // Boolean says "reload everything", but the explicit list scopes it to acc-1.
    await getPostsForUser('user-1', { forceReload: true, forceReloadAccountIds: ['acc-1'] });

    expect(forceReloadByAccount()).toEqual({ 'acc-1': true, 'acc-2': false });
  });

  it('treats an empty allow-list as "force-reload nothing" even when forceReload is true', async () => {
    await getPostsForUser('user-1', { forceReload: true, forceReloadAccountIds: [] });

    expect(forceReloadByAccount()).toEqual({ 'acc-1': false, 'acc-2': false });
  });

  it('falls back to the forceReload boolean for all accounts when no allow-list is given', async () => {
    await getPostsForUser('user-1', { forceReload: true });

    expect(forceReloadByAccount()).toEqual({ 'acc-1': true, 'acc-2': true });
  });

  it('does not force-reload any account on a plain (non-force) read', async () => {
    await getPostsForUser('user-1', {});

    expect(forceReloadByAccount()).toEqual({ 'acc-1': false, 'acc-2': false });
  });
});
