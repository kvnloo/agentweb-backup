import { isDeepStrictEqual } from 'node:util';
import { userDb, User } from './db';
import { invalidateCachedPixels } from './metaPixelsCache';

// ============================================
// Type Definitions
// ============================================

export type PlatformType = 'linkedin' | 'unipile' | 'meta' | 'twitter' | 'instagram' | 'gmail' | 'outlook' | 'youtube' | 'fathom' | 'linkedin_ads' | 'hubspot' | 'attio' | 'google_ads' | 'google_drive' | 'calendly';

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
  /**
   * Scopes Meta actually granted, read back from debug_token at connect time.
   *
   * Distinct from the inherited `scopes`, which for Meta holds the scopes we
   * REQUESTED and is therefore not a capability signal — a user can decline the
   * ads permissions and still be issued a token (ENG-629 / OPS-79). Absent when
   * the grant could not be determined; never written as [] in that case, since
   * an empty array means "nothing granted". Evaluate via getMetaAdsScopeState.
   */
  granted_scopes?: string[];
  /** Set when Meta authoritatively refused an ads read for lack of permission. */
  ads_scope_revoked_at?: string;
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
 * Outlook / Microsoft 365 OAuth configuration.
 *
 * Unlike Google, Microsoft ROTATES refresh tokens: every refresh returns a new
 * refresh_token that must be persisted, or the connection dies after the first
 * refresh. `refresh_token` is therefore required (offline_access grants it), and
 * `needs_reconnect` is set when a refresh fails — same pattern as TwitterXConfig.
 */
export interface OutlookConfig extends BaseOAuthConfig {
  account_type: 'outlook';
  email: string;            // Mailbox address (used as account_id)
  display_name?: string;    // From the Graph /me profile
  granted_scopes: string[]; // Actual scopes granted (may differ from requested)
  tenant_id?: string;       // Entra tenant the mailbox belongs to
  needs_reconnect?: boolean; // set when a refresh fails; cleared on reconnect
  // refresh_token is inherited optional from BaseOAuthConfig, but Outlook cannot
  // function without one (offline_access grants it). outlookAuth refuses to store
  // an account lacking one, and outlookService throws if it is ever missing.
  // Watermark for outlookBounceMonitorCron (ENG-266 Part 3) — the last receivedDateTime
  // scanned for NDRs, so each run only looks at mail since the previous one.
  lastNdrCheckAt?: string;
}

/**
 * Google Calendar scope URL. Kept in this file because both gmailAuth and
 * prospectMeetingService need to check for it when diagnosing "why is
 * Calendar returning 403".
 */
export const GOOGLE_CALENDAR_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly';

/**
 * Google Calendar write scope. Grants read/write on events (create, update,
 * delete) for calendars the user can access. Required by
 * google_calendar_create_event. `calendar.readonly` alone is NOT sufficient
 * to create events — the Google API returns 403.
 */
export const GOOGLE_CALENDAR_EVENTS_SCOPE =
  'https://www.googleapis.com/auth/calendar.events';

/**
 * Helper: has the user actually granted the calendar.readonly scope on their
 * Gmail connection? Reads BOTH the modern `granted_scopes` field (populated
 * by gmailAuth /connect) and the legacy `BaseOAuthConfig.scopes` field, so
 * records written before the scopes-persistence fix still work.
 *
 * Note: the write scopes (`calendar` / `calendar.events`) also imply read
 * access to events, so they satisfy this check too.
 */
export const hasGmailCalendarScope = (config: GmailConfig | undefined | null): boolean => {
  if (!config) return false;
  const all = [
    ...(config.granted_scopes || []),
    ...(config.scopes || []),
  ];
  // Intentional substring match: 'calendar' catches calendar.events and
  // calendar (full) scopes in addition to calendar.readonly, since all imply
  // at least read access. calendar.events.readonly would also match — acceptable,
  // as it grants the same read capability we need here.
  return all.some(s => s.includes('calendar.readonly') || s.includes('calendar'));
};

/**
 * Helper: has the user granted a Google Calendar *write* scope (needed to
 * create/modify events)? Only the full `calendar` scope or the
 * `calendar.events` scope qualify — every read-only variant (`*.readonly`)
 * is explicitly excluded so we don't mistake `calendar.events.readonly` for
 * write access. Reads both the modern `granted_scopes` and legacy `scopes`
 * fields for the same backward-compat reason as hasGmailCalendarScope.
 */
export const hasGmailCalendarWriteScope = (config: GmailConfig | undefined | null): boolean => {
  if (!config) return false;
  const all = [
    ...(config.granted_scopes || []),
    ...(config.scopes || []),
  ];
  return all.some(s => {
    if (s.endsWith('.readonly')) return false;
    return (
      s.endsWith('/auth/calendar') ||
      s.endsWith('/auth/calendar.events')
    );
  });
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

export interface GoogleDriveConfig extends BaseOAuthConfig {
  account_type: 'oauth';
  email: string;
  display_name?: string;
  picture_url?: string;
  granted_scopes: string[];
}

/**
 * Twitter/X Configuration (official X API v2, OAuth2 Authorization Code + PKCE).
 * Unlike LinkedIn outreach (Unipile sentinel token), X stores real per-user
 * OAuth2 tokens and refreshes them server-side via the refresh_token.
 */
export interface TwitterXConfig extends BaseOAuthConfig {
  account_type: 'personal';
  twitter_user_id: string; // X numeric user id (used as DM participant id)
  username: string;        // X handle without leading @
  refresh_token: string;   // required — offline.access grants this; needed to refresh ~2h access tokens
  needs_reconnect?: boolean; // set when token refresh fails (revoked/expired refresh token); cleared on reconnect
}

/**
 * Calendly OAuth configuration (ENG-524).
 *
 * `booking_tracking_active` is false when the connecting account's Calendly plan
 * doesn't support webhooks (Free tier) — OAuth still succeeds and the account is
 * stored, but no `webhook_id`/`webhook_signing_key` exist and no booking events
 * will ever arrive. Distinct from `needs_reconnect`, which means the OAuth grant
 * itself is broken; this means the grant is fine but the plan doesn't qualify.
 */
export interface CalendlyConfig extends BaseOAuthConfig {
  account_type: 'calendly';
  email?: string;             // From /users/me, used as account_id
  display_name?: string;
  user_uri: string;           // Calendly user URI — resolves the webhook scope
  organization_uri: string;   // Calendly organization URI — required by the webhook subscription body regardless of scope
  webhook_id?: string;        // Set only when booking_tracking_active is true
  webhook_signing_key?: string; // HMAC secret WE generate and hand to Calendly at subscription-create time
  booking_tracking_active: boolean;
  needs_reconnect?: boolean;
  // Which of the customer's own lead lists a booking gets created/updated in
  // (CRM-forward, ENG-524 §6 step 4). Either set explicitly via Settings, or
  // auto-resolved to an idempotent system-managed list on first booking and
  // persisted here so every later delivery reuses it directly — see
  // resolveOrCreateBookingList in calendlyWebhook.ts.
  booking_lead_list_id?: string;
  // ENG-1141: which Meta pixel/ad account CAPI attribution uses for this connection's
  // bookings. Unlike landing pages (per-generation choice, no stored default — a human
  // is present at creation time), a booking webhook is unattended, so this has to be
  // settable once and reused — see resolveMetaPixelWithDefault in metaService.ts, which
  // falls back to the caller's first connected account/first pixel when unset.
  attributionPixelId?: string;
  attributionAccountId?: string;
  // ENG-1141: an explicit "don't wire Meta up at all" choice. Distinct from simply leaving
  // the pair unset, which means "auto-resolve to my first account/pixel" — a customer who
  // connected Calendly purely for scheduling has no way to express "no Meta attribution"
  // otherwise, and would silently get CAPI Schedule events fired against whichever ad
  // account happened to be first. When true, the booking is still created and CRM-forwarded
  // exactly as before; only the CAPI leg is skipped.
  attributionDisabled?: boolean;
}

export type PlatformConfig = LinkedInConfig | LinkedInOutreachConfig | MetaConfig | GmailConfig | OutlookConfig | YouTubeConfig | FathomConfig | LinkedInAdsAdAccountConfig | HubSpotConfig | AttioConfig | GoogleAdsConfig | GoogleDriveConfig | TwitterXConfig | CalendlyConfig;

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

  // On reconnect (existing platform+account_id), spread the existing entry first so
  // top-level fields like sharedWithOrg/engagementMemory survive re-OAuth (ENG-348),
  // then override the refreshed fields.
  const accountConfig: ConnectedAccountConfig = {
    ...existingAccount,
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

  // ENG-1141: which pixels exist for this user just changed. Without this, connecting a
  // Meta account and immediately opening the create dialog would read a cached "no pixels"
  // answer — which the picker reads as "nothing to choose" — and ship a silently untracked
  // page. See services/metaPixelsCache.ts.
  invalidateCachedPixels(userId);

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
 * Deduplication is by platform + account_id — the caller's own account wins on
 * conflict.
 *
 * Platform is part of the key because account_id alone does not identify an
 * account: one Google account connected for both Gmail and Drive carries the
 * same address on both rows. Keying on the id alone dropped whichever of the
 * two came second, and dropped a teammate's shared account entirely if the
 * caller happened to hold any account at the same id on any platform. For a
 * mailbox that is not cosmetic — losing the Gmail row makes it unresolvable
 * again, which is ENG-943's symptom reached by another route, and one the
 * resolver's own "prefer the email platform" guard cannot catch because the row
 * never arrives. Own accounts were never deduped at all, so consumers already
 * handle one address appearing on two platforms.
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
  // platform + account_id, not account_id alone — see the note above. The
  // separator is written as an escape and never as a literal control character:
  // a raw NUL in the source makes git and grep treat this entire file as
  // binary, which silently costs every diff and review of it.
  const identity = (account: { platform: string; account_id: string }) =>
    `${account.platform}\u0000${account.account_id}`;
  const seen = new Set(ownAccounts.map(identity));
  const sharedAccounts: ConnectedAccountWithUser[] = [];

  for (const member of members) {
    if (member.userId === callerUserId) continue;
    const memberAccounts = normalizeAccounts(member.connected_accounts);
    for (const account of memberAccounts) {
      if (account.sharedWithOrg && !seen.has(identity(account))) {
        seen.add(identity(account));
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
  accountId?: string,
  expectedAccount?: ConnectedAccount,
): Promise<void> => {
  const changedError = () => Object.assign(
    new Error(`${platform === 'linkedin' ? 'LinkedIn' : 'Connected'} account changed or disconnected while refreshing; retry`),
    { code: 'ConnectedAccountChanged' },
  );
  // Accounts returned to callers can carry this non-persisted owner marker.
  // It is not a credential/config change and must not make the same stored
  // account look different during a refresh.
  const snapshot = (account: ConnectedAccount): ConnectedAccountConfig => {
    const { userId: _userId, ...persistedAccount } = account as ConnectedAccount & { userId?: string };
    return persistedAccount as ConnectedAccountConfig;
  };
  let sourceAccount = expectedAccount ? snapshot(expectedAccount) : undefined;

  // A full-list write is required by the existing User model. CAS it so token
  // refresh cannot resurrect a disconnected account, but retry once against a
  // fresh primary record when *another* account changed. The target must still
  // exactly match the source snapshot on every attempt; a disconnect/reconnect
  // or target-account edit fails closed rather than accepting an old token.
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = await userDb.getUserByIdConsistent(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const storedAccounts = (user as User).connected_accounts;
    const accounts = normalizeAccounts(storedAccounts);
    const accountIndex = accountId
      ? accounts.findIndex(acc => acc.platform === platform && acc.account_id === accountId)
      : accounts.findIndex(acc => acc.platform === platform);

    if (accountIndex < 0) throw changedError();

    const existingAccount = accounts[accountIndex];
    // If no caller snapshot was supplied, the first strongly current account
    // becomes the source snapshot. LinkedIn passes its pre-write account so a
    // disconnect/reconnect before this lookup is also detected.
    const expected = sourceAccount || snapshot(existingAccount);
    if (!isDeepStrictEqual(snapshot(existingAccount), expected)) throw changedError();
    sourceAccount = expected;

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

    try {
      await userDb.updateUser(userId, {
        connected_accounts: updatedAccounts,
      } as Partial<User>, {
        // Carry the strong-read decision into the write. Otherwise a disconnect
        // between the read and update could be overwritten with the stale account.
        condition: {
          expression: '#expectedConnectedAccounts = :expectedConnectedAccounts',
          names: { '#expectedConnectedAccounts': 'connected_accounts' },
          values: { ':expectedConnectedAccounts': storedAccounts },
        },
      });
      return;
    } catch (error: any) {
      if (error?.code !== 'ConditionalCheckFailedException') throw error;
      if (attempt === 1) throw changedError();
      // Re-read before retrying: the target must still equal `expected`, while
      // unrelated account-list changes are retained in the rebuilt write.
    }
  }
};

/**
 * Update arbitrary config fields on a connected account.
 * Used to store webhook_id, webhook_url, etc. after initial creation.
 */
/**
 * Config keys to REMOVE outright, applied after the merge.
 *
 * A plain merge can only ever add or overwrite, so a field that records a
 * past observation — `ads_scope_revoked_at`, say — has no way to be retracted
 * once it is wrong. Setting it to `undefined` is not equivalent: the key
 * survives the spread and its removal would then depend on marshalling
 * behaviour rather than on anything stated here. Deleting is explicit.
 */
export interface UpdateAccountConfigOptions {
  unset?: string[];
}

/**
 * Either a fixed set of fields to merge (the common case — the value doesn't
 * depend on what's currently stored), or a function of the freshly-read
 * config that returns the merge for THIS attempt (for a caller whose update is
 * *derived* from current state — narrowing a scope list, defaulting a
 * timestamp only if unset).
 *
 * The function form exists because the CAS retry below re-reads on conflict
 * but, with a fixed object, would reapply the SAME pre-computed values against
 * the fresh read — silently correct only when the update doesn't depend on
 * what it's overwriting. For a derived update that's a real bug: two writers
 * racing on one account's capability fields (a sweep's revocation and a
 * concurrent recovery) could have the loser's stale-derived write clobber the
 * winner's fresh state on retry, reversing whichever transition arrived
 * second. The function form re-derives every attempt, closing that gap.
 */
export type AccountConfigMutation =
  | Record<string, any>
  | ((freshConfig: Record<string, any>) => {
      updates: Record<string, any>;
      unset?: string[];
    });

export const updateAccountConfig = async (
  userId: string,
  platform: PlatformType,
  accountId: string,
  configUpdates: AccountConfigMutation,
  options?: UpdateAccountConfigOptions
): Promise<void> => {
  // Compare-and-swap, mirroring updateAccountTokens. The User model forces a
  // whole-list write, so a plain read-modify-write silently discards anything
  // another writer changed in between — a token the refresh cron had just
  // renewed, or a capability marker a concurrent sweep had just set. Conditioning
  // the write on the list we actually read turns that clobber into a retry.
  //
  // Unlike the token path this re-applies the merge rather than failing closed:
  // this function's contract is "merge these fields into whatever is current",
  // so a fresh read followed by the same merge is exactly the right answer —
  // provided the merge itself is recomputed from that fresh read when it needs
  // to be (see AccountConfigMutation above).
  for (let attempt = 0; attempt < 3; attempt++) {
    const user = await userDb.getUserByIdConsistent(userId);
    if (!user) {
      throw new Error('User not found');
    }

    const storedAccounts = (user as User).connected_accounts;
    const accounts = normalizeAccounts(storedAccounts);
    const accountIndex = accounts.findIndex(
      acc => acc.platform === platform && acc.account_id === accountId
    );

    if (accountIndex < 0) {
      throw new Error(`No ${platform} account with id "${accountId}" connected`);
    }

    const existingAccount = accounts[accountIndex];

    const isDerived = typeof configUpdates === 'function';
    const { updates, unset } = isDerived
      ? configUpdates(existingAccount.config || {})
      : { updates: configUpdates, unset: options?.unset };

    const mergedConfig: Record<string, any> = {
      ...existingAccount.config,
      ...updates,
    };
    for (const key of unset || []) {
      delete mergedConfig[key];
    }

    const updatedAccount: ConnectedAccountConfig = {
      ...existingAccount,
      config: mergedConfig as ConnectedAccountConfig['config'],
      updated_at: new Date().toISOString(),
    };

    const updatedAccounts = [...accounts];
    updatedAccounts[accountIndex] = updatedAccount;

    try {
      await userDb.updateUser(userId, {
        connected_accounts: updatedAccounts,
      } as Partial<User>, {
        condition: {
          expression: '#expectedConnectedAccounts = :expectedConnectedAccounts',
          names: { '#expectedConnectedAccounts': 'connected_accounts' },
          values: { ':expectedConnectedAccounts': storedAccounts },
        },
      });
      return;
    } catch (error: any) {
      if (error?.code !== 'ConditionalCheckFailedException') throw error;
      if (attempt === 2) {
        throw Object.assign(
          new Error(`Connected account "${accountId}" changed while updating its config; retry`),
          { code: 'ConnectedAccountChanged' },
        );
      }
      // Loop: re-read and re-apply the merge onto whatever is now current.
    }
  }
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

  // ENG-1141: a disconnect must not leave that account's pixels listed in the picker.
  invalidateCachedPixels(userId);
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

  // ENG-1141: same as deleteAccount — a disconnected account's pixels must stop being
  // offered immediately, not a TTL later.
  invalidateCachedPixels(userId);
};

/**
 * Extended Connected Account type that includes userId for owner verification
 */
export interface ConnectedAccountWithUser extends ConnectedAccount {
  userId: string;
}

const findAccountForUser = (
  user: User | undefined,
  accountId: string,
  userId: string,
  platform?: PlatformType | PlatformType[]
): ConnectedAccountWithUser | null => {
  const platforms = platform === undefined ? null : ([] as PlatformType[]).concat(platform);
  if (!user) return null;

  const accounts = normalizeAccounts(user.connected_accounts);
  const account = accounts.find(
    acc => acc.account_id === accountId && (platforms === null || platforms.includes(acc.platform))
  );

  return account ? { ...account, userId } : null;
};

/**
 * Get a specific connected account by account_id and userId.
 * Directly looks up the user to find the account, avoiding full table scan.
 *
 * `platform` is optional and disambiguates accounts that share the same
 * account_id across different platforms (e.g. a Gmail and a Google Drive
 * connection under the same Google email). Omitting it preserves the
 * pre-existing behavior of matching on account_id alone (first match wins).
 */
export const getAccountById = async (
  accountId: string,
  userId: string,
  platform?: PlatformType | PlatformType[]
): Promise<ConnectedAccountWithUser | null> => {
  try {
    const user = await userDb.getUserById(userId);
    return findAccountForUser(user as User | undefined, accountId, userId, platform);
  } catch (error) {
    console.error('Error in getAccountById:', error);
    return null;
  }
};

/**
 * Strongly current account lookup for external writes. This avoids the
 * eventually consistent UserIdIndex briefly returning an OAuth account after
 * it was disconnected, without adding an extra base-table read to ordinary
 * account listing and analytics paths.
 */
export const getAccountByIdConsistent = async (
  accountId: string,
  userId: string,
  platform?: PlatformType | PlatformType[]
): Promise<ConnectedAccountWithUser | null> => {
  try {
    const user = await userDb.getUserByIdConsistent(userId);
    return findAccountForUser(user as User | undefined, accountId, userId, platform);
  } catch (error) {
    console.error('Error in getAccountByIdConsistent:', error);
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
 * Find the user (and the specific connected account) that owns a given Calendly
 * user_uri. Used by the incoming booking webhook (ENG-524) to resolve who a
 * delivery belongs to. Matches on user_uri, not organization_uri — the webhook
 * subscription is created with scope 'user' bound to a specific user_uri, and a
 * real invitee.created payload carries no organization_uri at all (confirmed via
 * a live test delivery), so organization_uri isn't usable as an anchor here.
 * Returns every account alongside its userId (not just the userId, unlike
 * getUserIdByHubSpotPortalId) since the caller needs each candidate's own
 * config.webhook_signing_key immediately.
 *
 * ENG-994 (live-tested, #2291): this used to return only the FIRST matching
 * account across ALL users, with no awareness of which tenant a given webhook
 * delivery actually belongs to. Two different AgentWeb tenants can each
 * independently connect the SAME underlying Calendly identity (same login,
 * two separate webhook subscriptions) — confirmed live by creating a second
 * tenant sharing a real connection's user_uri: whichever tenant this function
 * happened to return first "won" resolution for EVERY delivery targeting that
 * user_uri, and the other tenant's own genuinely-signed deliveries were
 * silently dropped (no matching key ever attempted for them). DynamoDB scan
 * order isn't guaranteed stable, so which tenant lost was arbitrary and could
 * vary between individual deliveries. Returning every match lets the caller
 * (calendlyWebhook.ts) try each candidate's own signing key against the
 * signature, instead of committing to a single guess.
 */
export const getAccountsByCalendlyUserUri = async (
  userUri: string
): Promise<Array<{ userId: string; account: ConnectedAccountConfig }>> => {
  try {
    const { userDb } = await import('./db');
    const users = await userDb.getAllUsers();
    const matches: Array<{ userId: string; account: ConnectedAccountConfig }> = [];

    for (const user of users) {
      // normalizeAccounts (not a direct User.connected_accounts iteration, unlike
      // getUserIdByHubSpotPortalId above) — db.ts's local connected_accounts type is a
      // stale, narrower union that was never updated to include 'calendly' (or several
      // other real platforms), separate from this file's richer ConnectedAccountConfig.
      const accounts = normalizeAccounts((user as User).connected_accounts);
      for (const account of accounts) {
        if (account.platform === 'calendly' && (account.config as CalendlyConfig).user_uri === userUri) {
          matches.push({ userId: user.userId, account });
        }
      }
    }
    return matches;
  } catch (error) {
    console.error('Error resolving Calendly user_uri to accounts:', error);
    return [];
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
