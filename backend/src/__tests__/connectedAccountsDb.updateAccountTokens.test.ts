jest.mock('../services/db', () => ({
  userDb: {
    getUserByIdConsistent: jest.fn(),
    updateUser: jest.fn(),
  },
}));

import { ConnectedAccount, updateAccountTokens } from '../services/connectedAccountsDb';
import { userDb } from '../services/db';

const currentAccount: ConnectedAccount = {
  platform: 'linkedin',
  account_id: 'linkedin-account',
  account_name: 'Rui',
  config: {
    account_type: 'personal',
    access_token: 'old-token',
    refresh_token: 'old-refresh-token',
    token_expires_at: 1,
  },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const otherAccount = {
  platform: 'gmail',
  account_id: 'other-account',
  account_name: 'Other account',
  config: {
    account_type: 'gmail',
    access_token: 'other-token',
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
    }, 'linkedin-account', currentAccount);

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
    }, 'linkedin-account', currentAccount)).rejects.toThrow('changed or disconnected');

    expect(userDb.updateUser).not.toHaveBeenCalled();
  });

  it('retries after an unrelated account mutation without overwriting it', async () => {
    const conditionalFailure = Object.assign(new Error('conditional failed'), {
      code: 'ConditionalCheckFailedException',
    });
    (userDb.getUserByIdConsistent as jest.Mock)
      .mockResolvedValueOnce({
        userId: 'user-1',
        email: 'rui@example.com',
        connected_accounts: [currentAccount],
      })
      .mockResolvedValueOnce({
        userId: 'user-1',
        email: 'rui@example.com',
        connected_accounts: [currentAccount, otherAccount],
      });
    (userDb.updateUser as jest.Mock)
      .mockRejectedValueOnce(conditionalFailure)
      .mockResolvedValueOnce(undefined);

    await updateAccountTokens('user-1', 'linkedin', {
      access_token: 'new-token',
      token_expires_at: 2,
    }, 'linkedin-account', currentAccount);

    expect(userDb.getUserByIdConsistent).toHaveBeenCalledTimes(2);
    expect(userDb.updateUser).toHaveBeenCalledTimes(2);
    expect(userDb.updateUser).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({
        connected_accounts: [
          expect.objectContaining({
            account_id: 'linkedin-account',
            config: expect.objectContaining({ access_token: 'new-token' }),
          }),
          otherAccount,
        ],
      }),
      expect.objectContaining({
        condition: expect.objectContaining({
          values: { ':expectedConnectedAccounts': [currentAccount, otherAccount] },
        }),
      }),
    );
  });

  it('does not hide a conditional disconnect race as a successful refresh', async () => {
    (userDb.getUserByIdConsistent as jest.Mock)
      .mockResolvedValueOnce({
        userId: 'user-1',
        email: 'rui@example.com',
        connected_accounts: [currentAccount],
      })
      .mockResolvedValueOnce({
        userId: 'user-1',
        email: 'rui@example.com',
        connected_accounts: [],
      });
    (userDb.updateUser as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' }),
    );

    await expect(updateAccountTokens('user-1', 'linkedin', {
      access_token: 'new-token',
      token_expires_at: 2,
    }, 'linkedin-account', currentAccount)).rejects.toMatchObject({
      message: expect.stringContaining('changed or disconnected'),
      code: 'ConnectedAccountChanged',
    });
    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the target account changes during an unrelated-list retry', async () => {
    const changedTarget = {
      ...currentAccount,
      config: { ...currentAccount.config, access_token: 'reconnected-token' },
      updated_at: '2026-01-02T00:00:00.000Z',
    };
    (userDb.getUserByIdConsistent as jest.Mock)
      .mockResolvedValueOnce({
        userId: 'user-1',
        email: 'rui@example.com',
        connected_accounts: [currentAccount],
      })
      .mockResolvedValueOnce({
        userId: 'user-1',
        email: 'rui@example.com',
        connected_accounts: [changedTarget, otherAccount],
      });
    (userDb.updateUser as jest.Mock).mockRejectedValueOnce(
      Object.assign(new Error('conditional failed'), { code: 'ConditionalCheckFailedException' }),
    );

    await expect(updateAccountTokens('user-1', 'linkedin', {
      access_token: 'new-token',
      token_expires_at: 2,
    }, 'linkedin-account', currentAccount)).rejects.toMatchObject({
      code: 'ConnectedAccountChanged',
    });

    expect(userDb.updateUser).toHaveBeenCalledTimes(1);
  });

  it('fails before writing when a same-id account was reconnected before refresh begins', async () => {
    const reconnectedAccount = {
      ...currentAccount,
      config: { ...currentAccount.config, access_token: 'reconnected-token' },
      updated_at: '2026-01-02T00:00:00.000Z',
    };
    (userDb.getUserByIdConsistent as jest.Mock).mockResolvedValue({
      userId: 'user-1',
      email: 'rui@example.com',
      connected_accounts: [reconnectedAccount],
    });

    await expect(updateAccountTokens('user-1', 'linkedin', {
      access_token: 'new-token',
      token_expires_at: 2,
    }, 'linkedin-account', currentAccount)).rejects.toMatchObject({
      code: 'ConnectedAccountChanged',
    });

    expect(userDb.updateUser).not.toHaveBeenCalled();
  });
});
