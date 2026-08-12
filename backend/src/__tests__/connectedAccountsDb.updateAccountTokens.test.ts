jest.mock('../services/db', () => ({
  userDb: {
    getUserByIdConsistent: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import { updateAccountTokens } from '../services/connectedAccountsDb';
import { userDb } from '../services/db';

const currentAccount = {
  platform: 'linkedin',
  account_id: 'linkedin-account',
  account_name: 'Rui',
  config: {
    account_type: 'personal',
    access_token: 'old-token',
    refresh_token: 'old-refresh-token',
    token_expires_at: 1,
  },
};

describe('updateAccountTokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      email: 'rui@example.com',
      connected_accounts: [currentAccount],
    });
    (userDb.updateUser as jest.Mock).mockResolvedValue(undefined);
  });

  it('writes refreshed tokens only if the exact current account list is unchanged', async () => {
    await updateAccountTokens('user-1', 'linkedin', {
      access_token: 'new-token',
      refresh_token: 'new-refresh-token',
      token_expires_at: 2,
    }, 'linkedin-account');

    expect(userDb.getUserByIdConsistent).toHaveBeenCalledWith('user-1');
    expect(userDb.updateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        connected_accounts: [expect.objectContaining({
          account_id: 'linkedin-account',
          config: expect.objectContaining({
            access_token: 'new-token',
            refresh_token: 'new-refresh-token',
            token_expires_at: 2,
          }),
        })],
      }),
      expect.objectContaining({
        condition: expect.objectContaining({
          expression: '#expectedConnectedAccounts = :expectedConnectedAccounts',
          names: { '#expectedConnectedAccounts': 'connected_accounts' },
          values: { ':expectedConnectedAccounts': [currentAccount] },
        }),
      }),
    );
  });

  it('fails before writing when the account was disconnected after the caller loaded it', async () => {
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      email: 'rui@example.com',
      connected_accounts: [],
    });

    await expect(updateAccountTokens('user-1', 'linkedin', {
      access_token: 'new-token',
      token_expires_at: 2,
    }, 'linkedin-account')).rejects.toThrow('changed or disconnected');

    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('does not hide a conditional disconnect race as a successful refresh', async () => {
    (userDb.updateUser as jest.Mock).mockRejectedValue(
      Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' }),
    );

    await expect(updateAccountTokens('user-1', 'linkedin', {
      access_token: 'new-token',
      token_expires_at: 2,
    }, 'linkedin-account')).rejects.toMatchObject({
      message: expect.stringContaining('changed or disconnected'),
      code: 'ConnectedAccountChanged',
    });
  });
});
