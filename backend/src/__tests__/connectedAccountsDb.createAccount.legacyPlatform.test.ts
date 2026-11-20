/**
 * ENG-2264: createAccount only matched an existing entry on the exact platform string.
 * Meta accounts connected before the platform name was standardised are stored as
 * 'facebook', while every connect/reconnect flow now writes 'meta', so a reconnect never
 * found the old row: it added a brand-new 'meta' entry and left the old one behind as an
 * orphan, and none of the old row's fields (sharedWithOrg, engagementMemory, created_at)
 * carried over.
 *
 * Contract pinned here:
 *   - a reconnect finds the legacy 'facebook' row and updates it in place, relabelling it
 *     to the current platform and keeping its top-level fields;
 *   - an exact match still wins over a legacy one (so already-duplicated users are not
 *     made worse), and nothing is merged or deleted;
 *   - only 'facebook' -> 'meta' is aliased, and only for the same account_id.
 */

let mockUsers: Record<string, any> = {};
let updateUserCalls: Array<{ userId: string; updates: any }> = [];

jest.mock('../services/db', () => ({
  userDb: {
    getUserById: jest.fn((id: string) => Promise.resolve(mockUsers[id] ?? null)),
    updateUser: jest.fn((userId: string, updates: any) => {
      updateUserCalls.push({ userId, updates });
      return Promise.resolve({ ...mockUsers[userId], ...updates });
    }),
  },
  orgDb: {
    getOrgMembers: jest.fn(() => Promise.resolve([])),
  },
}));

import { createAccount } from '../services/connectedAccountsDb';

const USER_ID = 'user-eng-2264';
const AD_ACCOUNT_ID = 'act_1234567890';

const legacyFacebookRow = (overrides: Record<string, unknown> = {}) => ({
  platform: 'facebook',
  account_id: AD_ACCOUNT_ID,
  account_name: 'Old Ad Account',
  config: { access_token: 'old-token', account_type: 'ad_account', has_meta_pages: true },
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

const metaRow = (overrides: Record<string, unknown> = {}) => ({
  platform: 'meta',
  account_id: AD_ACCOUNT_ID,
  account_name: 'Meta Ad Account',
  config: { access_token: 'meta-token', account_type: 'ad_account' },
  created_at: '2025-06-01T00:00:00.000Z',
  updated_at: '2025-06-01T00:00:00.000Z',
  ...overrides,
});

const reconnectInput = (accountId = AD_ACCOUNT_ID) => ({
  account_id: accountId,
  account_name: 'Fresh Ad Account',
  config: { access_token: 'fresh-token', account_type: 'ad_account', has_meta_pages: true } as any,
});

const storedAccounts = (): any[] => {
  expect(updateUserCalls.length).toBeGreaterThan(0);
  return updateUserCalls[updateUserCalls.length - 1].updates.connected_accounts;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers = {};
  updateUserCalls = [];
});

describe('createAccount — legacy platform spelling (ENG-2264)', () => {
  it("updates a legacy 'facebook' row in place when 'meta' reconnects, instead of adding a duplicate", async () => {
    const engagementMemory = {
      content: '# Persona',
      lastSyncedAt: '2024-06-01T00:00:00.000Z',
      createdAt: '2024-06-01T00:00:00.000Z',
      updatedAt: '2024-06-01T00:00:00.000Z',
    };
    mockUsers[USER_ID] = {
      userId: USER_ID,
      connected_accounts: [legacyFacebookRow({ sharedWithOrg: true, engagementMemory })],
    };

    const result = await createAccount(USER_ID, 'meta', reconnectInput());

    const stored = storedAccounts();
    expect(stored).toHaveLength(1); // the old row was reused, not orphaned
    expect(stored[0].platform).toBe('meta'); // relabelled to the current platform
    expect(stored[0].account_id).toBe(AD_ACCOUNT_ID);
    expect(stored[0].account_name).toBe('Fresh Ad Account');
    expect(stored[0].config.access_token).toBe('fresh-token');
    // The old row's own fields survive the reconnect.
    expect(stored[0].sharedWithOrg).toBe(true);
    expect(stored[0].engagementMemory).toEqual(engagementMemory);
    expect(stored[0].created_at).toBe('2024-01-01T00:00:00.000Z');
    expect(stored[0].updated_at).not.toBe('2024-01-01T00:00:00.000Z');
    expect(result.platform).toBe('meta');
  });

  it('does not touch other accounts on the user while migrating the legacy row', async () => {
    const gmail = {
      platform: 'gmail',
      account_id: 'me@example.com',
      account_name: 'Gmail',
      config: { access_token: 'g' },
      created_at: '2024-02-02T00:00:00.000Z',
      updated_at: '2024-02-02T00:00:00.000Z',
    };
    mockUsers[USER_ID] = { userId: USER_ID, connected_accounts: [gmail, legacyFacebookRow()] };

    await createAccount(USER_ID, 'meta', reconnectInput());

    const stored = storedAccounts();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual(gmail);
    expect(stored[1].platform).toBe('meta');
  });

  it('still adds a new entry when there is no existing row for that account', async () => {
    mockUsers[USER_ID] = { userId: USER_ID, connected_accounts: [] };

    await createAccount(USER_ID, 'meta', reconnectInput());

    const stored = storedAccounts();
    expect(stored).toHaveLength(1);
    expect(stored[0].platform).toBe('meta');
  });

  it("adds a new entry when the legacy 'facebook' row belongs to a different account_id", async () => {
    mockUsers[USER_ID] = { userId: USER_ID, connected_accounts: [legacyFacebookRow({ account_id: 'act_other' })] };

    await createAccount(USER_ID, 'meta', reconnectInput());

    const stored = storedAccounts();
    expect(stored).toHaveLength(2);
    expect(stored[0].platform).toBe('facebook'); // untouched
    expect(stored[0].account_id).toBe('act_other');
    expect(stored[1].platform).toBe('meta');
    expect(stored[1].account_id).toBe(AD_ACCOUNT_ID);
  });

  it('prefers the exact platform match when both a legacy and a current row already exist', async () => {
    // A user who already reconnected before this fix has both rows. The current one is
    // updated; the legacy one is left exactly as it was (no merge, no delete).
    const legacy = legacyFacebookRow();
    mockUsers[USER_ID] = { userId: USER_ID, connected_accounts: [legacy, metaRow({ sharedWithOrg: true })] };

    await createAccount(USER_ID, 'meta', reconnectInput());

    const stored = storedAccounts();
    expect(stored).toHaveLength(2);
    expect(stored[0]).toEqual(legacy);
    expect(stored[1].platform).toBe('meta');
    expect(stored[1].config.access_token).toBe('fresh-token');
    expect(stored[1].sharedWithOrg).toBe(true);
  });

  it("only aliases 'facebook' to 'meta': another platform with the same account_id is a separate account", async () => {
    mockUsers[USER_ID] = { userId: USER_ID, connected_accounts: [legacyFacebookRow()] };

    await createAccount(USER_ID, 'instagram' as any, reconnectInput());

    const stored = storedAccounts();
    expect(stored).toHaveLength(2);
    expect(stored[0].platform).toBe('facebook'); // untouched
    expect(stored[1].platform).toBe('instagram');
  });

  it('keeps the exact-match behaviour for every other platform (unchanged)', async () => {
    const gmail = {
      platform: 'gmail',
      account_id: 'me@example.com',
      account_name: 'Old',
      config: { access_token: 'old' },
      sharedWithOrg: true,
      created_at: '2024-02-02T00:00:00.000Z',
      updated_at: '2024-02-02T00:00:00.000Z',
    };
    mockUsers[USER_ID] = { userId: USER_ID, connected_accounts: [gmail] };

    await createAccount(USER_ID, 'gmail' as any, { account_id: 'me@example.com', account_name: 'New', config: { access_token: 'new' } as any });

    const stored = storedAccounts();
    expect(stored).toHaveLength(1);
    expect(stored[0].account_name).toBe('New');
    expect(stored[0].sharedWithOrg).toBe(true);
  });
});
