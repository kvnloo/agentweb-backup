/**
 * getAccountByIdConsistent swallows a failed read and says "no such account"; getAccountByIdConsistentOrThrow does not. The Smartlead webhook
 * cleanup relies on the second: not knowing whether a connection came back must stop it, not read as "it did not" (ENG-673).
 */
let mockGetUserByIdConsistent: (id: string) => Promise<any> = async () => null;

jest.mock('../services/db', () => ({
  userDb: { getUserByIdConsistent: (id: string) => mockGetUserByIdConsistent(id) },
}));

import { getAccountByIdConsistent, getAccountByIdConsistentOrThrow } from '../services/connectedAccountsDb';

const user = { userId: 'u1', connected_accounts: [{ platform: 'smartlead', account_id: 'smartlead-u1', account_name: 'Smartlead', config: {} }] };

describe('strong read of one connected account', () => {
  it('finds the account when it is there, and says null when it is not', async () => {
    mockGetUserByIdConsistent = async () => user;
    expect((await getAccountByIdConsistentOrThrow('smartlead-u1', 'u1', 'smartlead'))?.account_id).toBe('smartlead-u1');
    mockGetUserByIdConsistent = async () => ({ userId: 'u1', connected_accounts: [] });
    expect(await getAccountByIdConsistentOrThrow('smartlead-u1', 'u1', 'smartlead')).toBeNull();
  });

  it('a failed read THROWS in the strict variant and returns null in the lenient one', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetUserByIdConsistent = async () => { throw new Error('dynamo down'); };
    await expect(getAccountByIdConsistentOrThrow('smartlead-u1', 'u1', 'smartlead')).rejects.toThrow('dynamo down');
    expect(await getAccountByIdConsistent('smartlead-u1', 'u1', 'smartlead')).toBeNull();
  });
});
