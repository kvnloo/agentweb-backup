import { createAccount } from '../connectedAccountsDb';

const mockGetUserById = jest.fn();
const mockUpdateUser = jest.fn();
jest.mock('../db', () => ({
  userDb: {
    getUserById: (...a: any[]) => mockGetUserById(...a),
    updateUser: (...a: any[]) => mockUpdateUser(...a),
  },
}));
jest.mock('../metaPixelsCache', () => ({ invalidateCachedPixels: jest.fn() }));
jest.mock('../serverSignalEmitter', () => ({ emitAppSignal: jest.fn() }));

const existing = {
  platform: 'smartlead',
  account_id: 'smartlead-u1',
  account_name: 'Smartlead',
  config: { account_type: 'api_key', access_token: 'old' },
  sharedWithOrg: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const input = { account_id: 'smartlead-u1', account_name: 'Smartlead', config: { account_type: 'api_key', access_token: 'new' } as any };

describe('createAccount resetSharing (ENG-673)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue({ id: 'u1', connected_accounts: [{ ...existing }] });
  });

  it('keeps sharedWithOrg on a plain reconnect (ENG-348)', async () => {
    const acc = await createAccount('u1', 'smartlead' as any, input);
    expect(acc.sharedWithOrg).toBe(true);
  });

  it('makes the reconnected account private again, in a single write, when resetSharing is set', async () => {
    const acc = await createAccount('u1', 'smartlead' as any, input, { resetSharing: true });
    expect(acc.sharedWithOrg).toBe(false);
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
    const saved = mockUpdateUser.mock.calls[0][1].connected_accounts;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ sharedWithOrg: false, created_at: existing.created_at });
    expect(saved[0].config.access_token).toBe('new');
  });
});
