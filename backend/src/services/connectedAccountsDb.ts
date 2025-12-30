import { userDb, User } from './db';

/**
 * Connected Account configuration stored in the User record
 */
export interface ConnectedAccountConfig {
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
  config: ConnectedAccountConfig;
}

/**
 * Add or update a connected account for a user
 */
export const createAccount = async (
  userId: string,
  platform: string,
  config: Omit<ConnectedAccountConfig, 'connected_at' | 'updated_at'>
): Promise<ConnectedAccount> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date().toISOString();
  const existingAccounts = (user as User).connected_accounts || {};
  
  const accountConfig: ConnectedAccountConfig = {
    ...config,
    connected_at: existingAccounts[platform]?.connected_at || now,
    updated_at: now,
  };

  const updatedAccounts = {
    ...existingAccounts,
    [platform]: accountConfig,
  };

  await userDb.updateUser(userId, {
    connected_accounts: updatedAccounts,
  } as Partial<User>);

  return {
    platform,
    config: accountConfig,
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

  const accounts = (user as User).connected_accounts || {};
  return Object.entries(accounts).map(([platform, config]) => ({
    platform,
    config: config as ConnectedAccountConfig,
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

  const accounts = (user as User).connected_accounts || {};
  const config = accounts[platform];
  
  if (!config) {
    return null;
  }

  return {
    platform,
    config: config as ConnectedAccountConfig,
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

  const accounts = (user as User).connected_accounts || {};
  const existingConfig = accounts[platform];
  
  if (!existingConfig) {
    throw new Error(`No ${platform} account connected`);
  }

  const updatedConfig = {
    ...existingConfig,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? existingConfig.refresh_token,
    token_expires_at: tokens.token_expires_at,
    updated_at: new Date().toISOString(),
  };

  await userDb.updateUser(userId, {
    connected_accounts: {
      ...accounts,
      [platform]: updatedConfig,
    },
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

  const accounts = (user as User).connected_accounts || {};
  
  if (!accounts[platform]) {
    return; // Already removed
  }

  // Remove the platform from accounts
  const { [platform]: _, ...remainingAccounts } = accounts;

  await userDb.updateUser(userId, {
    connected_accounts: remainingAccounts,
  } as Partial<User>);
};
