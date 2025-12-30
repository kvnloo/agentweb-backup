import { userDb, User } from './db';

/**
 * Connected Account configuration stored in the User record
 */
export interface ConnectedAccountConfig {
  platform: string;
  account_id: string;
  account_name: string;
  account_type: 'personal' | 'company_page';
  page_id?: string;
  profile_id?: string;
  access_token: string;
  refresh_token?: string;
  token_expires_at: number;
  scopes: string[];
  connected_at: string;
  updated_at: string;
}

export interface ConnectedAccount {
  platform: string;
  config: Omit<ConnectedAccountConfig, 'platform'>;
}

/**
 * Add or update a connected account for a user
 */
export const createAccount = async (
  userId: string,
  platform: string,
  config: Omit<ConnectedAccountConfig, 'platform' | 'connected_at' | 'updated_at'>
): Promise<ConnectedAccount> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date().toISOString();
  const existingAccounts = (user as User).connected_accounts || [];
  
  // Find existing account for this platform
  const existingIndex = existingAccounts.findIndex(acc => acc.platform === platform);
  const existingAccount = existingIndex >= 0 ? existingAccounts[existingIndex] : null;

  const accountConfig: ConnectedAccountConfig = {
    platform,
    ...config,
    connected_at: existingAccount?.connected_at || now,
    updated_at: now,
  };

  let updatedAccounts: ConnectedAccountConfig[];
  if (existingIndex >= 0) {
    // Update existing account
    updatedAccounts = [...existingAccounts];
    updatedAccounts[existingIndex] = accountConfig;
  } else {
    // Add new account
    updatedAccounts = [...existingAccounts, accountConfig];
  }

  await userDb.updateUser(userId, {
    connected_accounts: updatedAccounts,
  } as Partial<User>);

  const { platform: _, ...configWithoutPlatform } = accountConfig;
  return {
    platform,
    config: configWithoutPlatform,
  };
};

/**
 * Get all connected accounts for a user
 */
export const getAccountsByUserId = async (userId: string): Promise<ConnectedAccount[]> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return [];
  }

  const accounts = (user as User).connected_accounts || [];
  return accounts.map(({ platform, ...config }) => ({
    platform,
    config,
  }));
};

/**
 * Get a specific connected account by platform
 */
export const getAccountByPlatform = async (
  userId: string,
  platform: string
): Promise<ConnectedAccount | null> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return null;
  }

  const accounts = (user as User).connected_accounts || [];
  const account = accounts.find(acc => acc.platform === platform);
  
  if (!account) {
    return null;
  }

  const { platform: _, ...config } = account;
  return {
    platform,
    config,
  };
};

/**
 * Update a connected account's tokens (e.g., after refresh)
 */
export const updateAccountTokens = async (
  userId: string,
  platform: string,
  tokens: {
    access_token: string;
    refresh_token?: string;
    token_expires_at: number;
  }
): Promise<void> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const accounts = (user as User).connected_accounts || [];
  const accountIndex = accounts.findIndex(acc => acc.platform === platform);
  
  if (accountIndex < 0) {
    throw new Error(`No ${platform} account connected`);
  }

  const existingAccount = accounts[accountIndex];
  const updatedAccount: ConnectedAccountConfig = {
    ...existingAccount,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? existingAccount.refresh_token,
    token_expires_at: tokens.token_expires_at,
    updated_at: new Date().toISOString(),
  };

  const updatedAccounts = [...accounts];
  updatedAccounts[accountIndex] = updatedAccount;

  await userDb.updateUser(userId, {
    connected_accounts: updatedAccounts,
  } as Partial<User>);
};

/**
 * Remove a connected account
 */
export const deleteAccount = async (
  userId: string,
  platform: string
): Promise<void> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const accounts = (user as User).connected_accounts || [];
  const filteredAccounts = accounts.filter(acc => acc.platform !== platform);

  // If no accounts were removed, just return
  if (filteredAccounts.length === accounts.length) {
    return;
  }

  await userDb.updateUser(userId, {
    connected_accounts: filteredAccounts,
  } as Partial<User>);
};
