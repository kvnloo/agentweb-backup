import { userDb, User } from './db';

// ============================================
// Type Definitions
// ============================================

export type PlatformType = 'linkedin' | 'unipile' | 'meta' | 'twitter' | 'instagram' | 'gmail' | 'youtube' | 'fathom' | 'linkedin_ads' | 'hubspot' | 'attio' | 'google_ads';

/**
 * Base OAuth configuration shared across all platforms
 */
export interface BaseOAuthConfig {
  access_token: string;
  refresh_token?: string;
  token_expires_at: number;
  scopes?: string[]; // Track granted permissions
}

/**
 * Helper function to normalize connected_accounts to array format
 */
const normalizeAccounts = (connectedAccounts: any): ConnectedAccountConfig[] => {
  if (!connectedAccounts) {
    return [];
  }

  if (Array.isArray(connectedAccounts)) {
    // Filter out entries missing required fields — guards against corrupted records.
    return (connectedAccounts as ConnectedAccountConfig[]).filter(
      (acc) => acc && acc.platform && acc.account_id && acc.config
    );
  }

  return [];
};


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
 * LinkedIn Outreach (Unipile) Configuration
 * Unipile manages the actual credentials — we store the Unipile account ID
 * and a far-future expiry so status checks always show 'active'.
 */
export interface LinkedInOutreachConfig {
  account_type: 'personal';
  unipile_account_id: string;
  username?: string;
  // Required by BaseOAuthConfig consumers — Unipile manages auth internally
  access_token: string;
  refresh_token?: undefined;
  token_expires_at: number;
  scopes?: string[];
  // Premium LinkedIn accounts allow 300-char invitation notes (free accounts: 200).
  // User-set in Settings → Connected accounts. Absent/false = free tier.
  is_premium?: boolean;
}

/**
 * Meta Ad Account Configuration
 */
export interface MetaAdAccountConfig extends BaseOAuthConfig {
  account_type: 'ad_account';
  ad_account_id: string;
  currency?: string;
  account_status?: number;
}

/**
 * Meta Page Configuration
 * IMPORTANT: Pages have their own page_access_token separate from user token
 * The page_access_token is stored in the access_token field
 */
export interface MetaPageConfig extends BaseOAuthConfig {
  account_type: 'page';
  page_id: string;
  category?: string;
}


export interface MetaInstagramBusinessConfig extends BaseOAuthConfig {
  account_type: 'instagram_business';
  instagram_account_id: string;
  username?: string;
}

export type MetaConfig = MetaAdAccountConfig | MetaPageConfig | MetaInstagramBusinessConfig;

/**
 * Union type for all platform-specific configurations.
 * Add new platform configs here as they are implemented.
 */
/**
 * Gmail OAuth configuration
 */
export interface GmailConfig extends BaseOAuthConfig {
  account_type: 'gmail';
  email: string;           // Google account email (used as account_id)
  display_name?: string;   // User's display name from Google profile
  picture_url?: string;    // Profile picture URL
  granted_scopes: string[]; // Actual scopes granted (may differ from requested)
}

/**
 * Google Calendar scope URL. Kept in this file because both gmailAuth and
 * prospectMeetingService need to check for it when diagnosing "why is
 * Calendar returning 403".
 */
export const GOOGLE_CALENDAR_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly';

/**
 * Helper: has the user actually granted the calendar.readonly scope on their
 * Gmail connection? Reads BOTH the modern `granted_scopes` field (populated
 * by gmailAuth /connect) and the legacy `BaseOAuthConfig.scopes` field, so
 * records written before the scopes-persistence fix still work.
 */
export const hasGmailCalendarScope = (config: GmailConfig | undefined | null): boolean => {
  if (!config) return false;
  const all = [
    ...(config.granted_scopes || []),
    ...(config.scopes || []),
  ];
  return all.some(s => s.includes('calendar.readonly') || s.includes('calendar'));
};

/**
 * YouTube OAuth configuration
 */
export interface YouTubeConfig extends BaseOAuthConfig {
  account_type: 'channel';
  channel_id: string;
  channel_name: string;
  picture_url?: string;
  subscriber_count?: number;
  video_count?: number;
  granted_scopes: string[];
}

/**
 * Fathom API key configuration (not OAuth — direct API key)
 */
export interface FathomConfig {
  account_type: 'oauth' | 'api_key';
  api_key?: string; // backward compat for old API key accounts
  webhook_id?: string;  // Stored after webhook registration
  webhook_url?: string; // Our endpoint URL
  access_token: string;
  refresh_token?: string;
  token_expires_at: number;
}

export interface LinkedInAdsAdAccountConfig extends BaseOAuthConfig {
  account_type: 'ad_account';
  currency: string;
  status: string;
  scopes?: string[];
}

export interface HubSpotConfig extends BaseOAuthConfig {
  account_type: 'oauth';
  hub_id: number;        // HubSpot portal ID
  hub_domain: string;    // e.g. "mycompany.hubspot.com"
  hubspot_account_type?: 'crm' | 'marketing';
  granted_scopes?: string[];
}

export interface AttioConfig extends BaseOAuthConfig {
  account_type: 'oauth';
  workspace_id: string;
  workspace_name: string;
}

export interface GoogleAdsConfig extends BaseOAuthConfig {
  account_type: 'google_ads';
  customer_id: string;
  currency: string;
  /**
   * The manager (MCC) account id to send as `login-customer-id` on every Google Ads
   * API call for this account. Set when the account is a leaf reached through a manager
   * the user has access to. Omitted/equal to customer_id for standalone/direct accounts.
   */
  login_customer_id?: string;
}

export type PlatformConfig = LinkedInConfig | LinkedInOutreachConfig | MetaConfig | GmailConfig | YouTubeConfig | FathomConfig | LinkedInAdsAdAccountConfig | HubSpotConfig | AttioConfig | GoogleAdsConfig; // | TwitterConfig

/**
 * Per-connection engagement memory: a persona profile generated from LinkedIn data
 * and optionally edited by the user, used to personalize automated engagement comments.
 */
export interface EngagementMemory {
  content: string;       // Markdown persona profile
  lastSyncedAt: string;  // ISO timestamp of last LinkedIn data sync
  createdAt: string;
  updatedAt: string;
}

/**
 * Connected Account configuration stored in the User record
 */
export interface ConnectedAccountConfig {
  platform: PlatformType;
  account_id: string;
  account_name: string;
  config: PlatformConfig;
  engagementMemory?: EngagementMemory;
  /** When true, org members can see and use this account. Default: false (private). */
  sharedWithOrg?: boolean;
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
  engagementMemory?: EngagementMemory;
  sharedWithOrg?: boolean;
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
 * Get connected accounts for a user, including org-shared accounts from other
 * members, each tagged with the userId of the member who OWNS it. The owner id
 * is essential for consumption paths: when a token is refreshed it must be
 * written back to the owner's record (updateAccountTokens(ownerUserId, ...)),
 * not the caller's — otherwise the caller would silently grow a copy of a
 * teammate's account and the owner's stale token would never update.
 *
 * Own accounts are always returned (ownerUserId === callerUserId). Other
 * members' accounts are included only when sharedWithOrg === true.
 * Deduplication is by account_id — the caller's own account wins on conflict.
 */
export const getAccountsWithOwnerIncludingOrgShared = async (
  callerUserId: string
): Promise<ConnectedAccountWithUser[]> => {
  const { orgDb } = await import('./db');

  const user = await userDb.getUserById(callerUserId);
  if (!user) {
    return [];
  }

  const ownAccounts: ConnectedAccountWithUser[] = normalizeAccounts(
    (user as User).connected_accounts
  ).map(acc => ({ ...acc, userId: callerUserId }));

  if (!(user as User).orgId) {
    return ownAccounts;
  }

  const members = await orgDb.getOrgMembers((user as User).orgId!);
  const seen = new Set(ownAccounts.map(a => a.account_id));
  const sharedAccounts: ConnectedAccountWithUser[] = [];

  for (const member of members) {
    if (member.userId === callerUserId) continue;
    const memberAccounts = normalizeAccounts(member.connected_accounts);
    for (const account of memberAccounts) {
      if (account.sharedWithOrg && !seen.has(account.account_id)) {
        seen.add(account.account_id);
        sharedAccounts.push({ ...account, userId: member.userId });
      }
    }
  }

  return [...ownAccounts, ...sharedAccounts];
};

/**
 * Get connected accounts for a user, including org-shared accounts from other members.
 * Own accounts are always returned. Org members' accounts are included only when
 * sharedWithOrg === true. Deduplication is by account_id — own account wins on conflict.
 *
 * Thin wrapper over getAccountsWithOwnerIncludingOrgShared for callers (display/list
 * endpoints) that don't need the owner userId.
 */
export const getAccountsByUserIdIncludingOrgShared = async (userId: string): Promise<ConnectedAccount[]> => {
  return getAccountsWithOwnerIncludingOrgShared(userId);
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
 * Update a connected account's tokens (e.g., after refresh).
 * When accountId is provided, matches by account_id (exact account).
 * Falls back to matching by platform only (first match) when accountId is omitted.
 */
export const updateAccountTokens = async (
  userId: string,
  platform: PlatformType,
  tokens: {
    access_token: string;
    refresh_token?: string;
    token_expires_at: number;
  },
  accountId?: string
): Promise<void> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const accountIndex = accountId
    ? accounts.findIndex(acc => acc.platform === platform && acc.account_id === accountId)
    : accounts.findIndex(acc => acc.platform === platform);

  if (accountIndex < 0) {
    throw new Error(`No ${platform} account${accountId ? ` with id "${accountId}"` : ''} connected`);
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
 * Update arbitrary config fields on a connected account.
 * Used to store webhook_id, webhook_url, etc. after initial creation.
 */
export const updateAccountConfig = async (
  userId: string,
  platform: PlatformType,
  accountId: string,
  configUpdates: Record<string, any>
): Promise<void> => {
  const user = await userDb.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const accountIndex = accounts.findIndex(
    acc => acc.platform === platform && acc.account_id === accountId
  );

  if (accountIndex < 0) {
    throw new Error(`No ${platform} account with id "${accountId}" connected`);
  }

  const existingAccount = accounts[accountIndex];
  const updatedAccount: ConnectedAccountConfig = {
    ...existingAccount,
    config: {
      ...existingAccount.config,
      ...configUpdates,
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

/**
 * Extended Connected Account type that includes userId for owner verification
 */
export interface ConnectedAccountWithUser extends ConnectedAccount {
  userId: string;
}

/**
 * Get a specific connected account by account_id and userId
 * Directly looks up the user to find the account, avoiding full table scan
 */
export const getAccountById = async (
  accountId: string,
  userId: string
): Promise<ConnectedAccountWithUser | null> => {
  try {
    const user = await userDb.getUserById(userId);

    if (user) {
      const accounts = normalizeAccounts((user as User).connected_accounts);
      const account = accounts.find(acc => acc.account_id === accountId);

      if (account) {
        return {
          ...account,
          userId: (user as User).userId,
        };
      }
    }

    return null;
  } catch (error) {
    console.error('Error in getAccountById:', error);
    return null;
  }
};

/**
 * Find the User ID that owns a specific HubSpot Portal.
 * Required for mapping HubSpot webhooks back to local users.
 */
export const getUserIdByHubSpotPortalId = async (portalId: number): Promise<string | null> => {
  try {
    // Note: If you have millions of users, you'd want a GSI on connected_accounts.
    // For now, scanning or iterating is necessary to find the nested config property.
    // The most efficient way right now is using userDb.scanAllItems
    // Wait, let's just scan the users table where connected_accounts contains the given portalId
    const { userDb } = await import('./db');
    const users = await userDb.getAllUsers();

    for (const user of users) {
      if (user.connected_accounts) {
        for (const account of user.connected_accounts) {
          if (account.platform === 'hubspot' && (account.config as any).hub_id === portalId) {
            return user.userId;
          }
        }
      }
    }
    return null;
  } catch (error) {
    console.error('Error resolving HubSpot Portal ID to User ID:', error);
    return null;
  }
};

/**
 * Check if an account token is still valid
 * First checks expiry timestamp, then verifies via API if not expired
 */
export const isTokenValid = async (account: ConnectedAccount): Promise<boolean> => {
  const now = Date.now();

  // First check: is the token expired based on timestamp?
  if (account.config.token_expires_at <= now) {
    // Platforms with a refresh token (e.g. Gmail, LinkedIn) auto-renew — consider them valid.
    // LinkedIn also gets API verification below; others are trusted based on refresh_token presence.
    const canAttemptRefresh = !!account.config.refresh_token;
    if (!canAttemptRefresh) {
      return false;
    }
    // Fall through: token is expired but refresh_token exists, so it can be renewed
  }

  // Second check: verify via API (only for LinkedIn for now)
  if (account.platform === 'linkedin') {
    try {
      // Use adapter for verification which handles auto-refresh
      const { socialPlatformService } = await import('./socialPlatformService');
      const adapter = socialPlatformService.getAdapter(account.platform);
      return await adapter.verifyToken(account);
    } catch (error) {
      console.warn('[isTokenValid] Failed to verify token via API/Adapter:', error);
      // If expired by timestamp AND API check failed/threw, then it's definitely invalid
      if (account.config.token_expires_at <= now) {
        return false;
      }
      return true; // Assume valid if API check fails but timestamp is okay (network error)
    }
  }

  // For other platforms, just use timestamp check
  return true;
};

/**
 * Quick synchronous check for token expiry (timestamp only, no API call)
 * Use this when you don't need the full API verification
 */
export const isTokenNotExpired = (account: ConnectedAccount): boolean => {
  const now = Date.now();
  return account.config.token_expires_at > now;
};

/**
 * Get the engagement memory for a specific connected account
 */
export const getEngagementMemory = async (
  userId: string,
  accountId: string
): Promise<EngagementMemory | null> => {
  const user = await userDb.getUserById(userId);
  if (!user) return null;

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const account = accounts.find(acc => acc.account_id === accountId);
  return account?.engagementMemory || null;
};

/**
 * Save or update the engagement memory for a specific connected account
 */
export const saveEngagementMemory = async (
  userId: string,
  accountId: string,
  memory: EngagementMemory
): Promise<void> => {
  const user = await userDb.getUserById(userId);
  if (!user) throw new Error('User not found');

  const accounts = normalizeAccounts((user as User).connected_accounts);
  const accountIndex = accounts.findIndex(acc => acc.account_id === accountId);
  if (accountIndex < 0) throw new Error('Connected account not found');

  const updatedAccounts = [...accounts];
  updatedAccounts[accountIndex] = {
    ...updatedAccounts[accountIndex],
    engagementMemory: memory,
    updated_at: new Date().toISOString(),
  };

  await userDb.updateUser(userId, {
    connected_accounts: updatedAccounts,
  } as Partial<User>);
};
