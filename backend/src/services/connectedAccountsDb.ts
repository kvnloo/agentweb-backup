import { userDb, User } from './db';

/**
 * Helper function to normalize connected_accounts to array format
 */
const normalizeAccounts = (connectedAccounts: any): ConnectedAccountConfig[] => {
  if (!connectedAccounts) {
    return [];
  }
  
  if (Array.isArray(connectedAccounts)) {
    return connectedAccounts as ConnectedAccountConfig[];
  }
  
  return [];
};

// ============================================
// Platform Type Definitions
// ============================================

export type PlatformType = 'linkedin' | 'facebook' | 'twitter' | 'instagram';

/**
 * Base OAuth configuration shared across all platforms
 */
export interface BaseOAuthConfig {
  access_token: string;
  refresh_token?: string;
  token_expires_at: number;
  scopes: string[];
}

/**
 * LinkedIn-specific configuration
 */
export interface LinkedInConfig extends BaseOAuthConfig {
  account_type: 'personal' | 'company_page';
  profile_id?: string;
  page_id?: string;
  organization_id?: string;
}

/**
 * Union type for all platform-specific configurations.
 * Add new platform configs here as they are implemented.
 */
export type PlatformConfig = LinkedInConfig; // | FacebookConfig | TwitterConfig

/**
 * Connected Account configuration stored in the User record
 */
export interface ConnectedAccountConfig {
  platform: PlatformType;
  account_id: string;
  account_name: string;
  config: PlatformConfig;
  created_at: string;
  updated_at: string;
}

/**
 * Connected Account return type for API responses
 */
export interface ConnectedAccount {
  platform: PlatformType;
  account_id: string;
  account_name: string;
  config: PlatformConfig;
  created_at: string;
  updated_at: string;
}

/**
 * Input type for creating a connected account
 */
export interface CreateAccountInput {
  account_id: string;
  account_name: string;
  config: PlatformConfig;
}

/**
 * Add or update a connected account for a user
 */
export const createAccount = async (
  userId: string,
  platform: PlatformType,
  input: CreateAccountInput
): Promise<ConnectedAccount> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const now = new Date().toISOString();
  const existingAccounts = normalizeAccounts((user as User).connected_accounts);
  
  // Find existing account for this platform AND account_id (to support multiple accounts per platform)
  const existingIndex = existingAccounts.findIndex(
    acc => acc.platform === platform && acc.account_id === input.account_id
  );
  const existingAccount = existingIndex >= 0 ? existingAccounts[existingIndex] : null;

  const accountConfig: ConnectedAccountConfig = {
    platform,
    account_id: input.account_id,
    account_name: input.account_name,
    config: input.config,
    created_at: existingAccount?.created_at || now,
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

  return accountConfig;
};

/**
 * Get all connected accounts for a user
 */
export const getAccountsByUserId = async (userId: string): Promise<ConnectedAccount[]> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return [];
  }

  const accounts = normalizeAccounts((user as User).connected_accounts);
  return accounts;
};

/**
 * Get a specific connected account by platform
 */
export const getAccountByPlatform = async (
  userId: string,
  platform: PlatformType
): Promise<ConnectedAccount | null> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return null;
  }

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const account = accounts.find(acc => acc.platform === platform);
  
  if (!account) {
    return null;
  }

  return account;
};

/**
 * Update a connected account's tokens (e.g., after refresh)
 */
export const updateAccountTokens = async (
  userId: string,
  platform: PlatformType,
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

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const accountIndex = accounts.findIndex(acc => acc.platform === platform);
  
  if (accountIndex < 0) {
    throw new Error(`No ${platform} account connected`);
  }

  const existingAccount = accounts[accountIndex];
  const updatedAccount: ConnectedAccountConfig = {
    ...existingAccount,
    config: {
      ...existingAccount.config,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? existingAccount.config.refresh_token,
      token_expires_at: tokens.token_expires_at,
    },
    updated_at: new Date().toISOString(),
  };

  const updatedAccounts = [...accounts];
  updatedAccounts[accountIndex] = updatedAccount;

  await userDb.updateUser(userId, {
    connected_accounts: updatedAccounts,
  } as Partial<User>);
};

/**
 * Remove a connected account (all accounts for a platform)
 */
export const deleteAccount = async (
  userId: string,
  platform: PlatformType
): Promise<void> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const filteredAccounts = accounts.filter(acc => acc.platform !== platform);

  // If no accounts were removed, just return
  if (filteredAccounts.length === accounts.length) {
    return;
  }

  await userDb.updateUser(userId, {
    connected_accounts: filteredAccounts,
  } as Partial<User>);
};

/**
 * Remove a specific connected account by platform and account_id
 * This allows deleting individual accounts when multiple accounts exist per platform
 */
export const deleteAccountById = async (
  userId: string,
  platform: PlatformType,
  accountId: string
): Promise<void> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const filteredAccounts = accounts.filter(
    acc => !(acc.platform === platform && acc.account_id === accountId)
  );

  // If no accounts were removed, just return
  if (filteredAccounts.length === accounts.length) {
    return;
  }

  await userDb.updateUser(userId, {
    connected_accounts: filteredAccounts,
  } as Partial<User>);
};

