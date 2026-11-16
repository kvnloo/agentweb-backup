import { isDeepStrictEqual } from 'node:util';
import { userDb, User } from './db';
import { invalidateCachedPixels } from './metaPixelsCache';
import { isEvaluationUser } from './evaluationPolicy';
import type { DailyVolumeState } from './linkedInWritePacer';
import { emitAppSignal } from './serverSignalEmitter';

// ============================================
// Type Definitions
// ============================================

export type PlatformType = 'linkedin' | 'unipile' | 'meta' | 'twitter' | 'instagram' | 'gmail' | 'outlook' | 'youtube' | 'fathom' | 'linkedin_ads' | 'hubspot' | 'attio' | 'google_ads' | 'google_drive' | 'calendly' | 'slack' | 'luma' | 'smartlead';

/**
 * ENG-1616 — the subset of `PlatformType` that `postOnConnectedAccount` treats as
 * social-posting-capable. Single source of truth for that allowlist: it used to be
 * duplicated between `agentModeService.postOnConnectedAccount` and the scheduled
 * publish consent guard's `resolveAccountPlatform`, both narrowing an account_id
 * lookup to these platforms before matching — a drift between the two copies would
 * silently break account resolution for the missing platform on one side, with no
 * test or runtime signal to catch it.
 */
export const SOCIAL_POSTING_PLATFORMS: readonly PlatformType[] = ['twitter', 'linkedin', 'instagram', 'youtube'];

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
  /**
   * Self-reported daily LinkedIn connection-request ceiling (linkedInWritePacer.ts).
   * Set directly by the user in Settings, or by Emma via the linkedin_outreach
   * `set-daily-invite-cap` action after asking whether the account has LinkedIn
   * Premium. Deliberately NOT auto-detected — see the pacer's module doc comment.
   * Unset defaults to the conservative free-tier number; the pacer clamps any
   * value to its own absolute system-wide ceiling regardless of what's stored here.
   */
  daily_invite_cap?: number;
  /**
   * Durable daily-volume counters (linkedInWritePacer.ts). Persisted here —
   * not in process memory — specifically so a backend restart (which happens
   * on every merge to `main`) can't reset an account's daily send count to
   * zero mid-day. Written by the pacer's caller, never read/written directly
   * anywhere else.
   */
  daily_volume?: DailyVolumeState;
  /**
   * Persisted session health (ENG-1197).
   *
   * Unipile owns this session's lifecycle, so `token_expires_at` is a sentinel and
   * says nothing about liveness — only a live probe does. That probe's result used
   * to live exclusively in an in-process 10-minute Map, which meant the moment a
   * session died was observed and then thrown away: no stored state, therefore no
   * connected→disconnected TRANSITION, therefore nothing an alert could key on. A
   * daily scheduled run rediscovered it hours later and silently no-opped.
   *
   * Storing it turns a level ("is dead right now", true on every one of the 288
   * daily poll cycles) into an edge ("just died"), which is the only thing safe to
   * notify a customer about. `disconnect_notified_at` then paces the reminder for a
   * session that stays dead for weeks.
   */
  needs_reconnect?: boolean;     // set when a probe proves the session dead; cleared on reconnect
  disconnected_at?: string;      // ISO — when the disconnect was first observed
  last_verified_at?: string;     // ISO — last time a probe proved the session live
  disconnect_notified_at?: string; // ISO — last owner notification, for reminder pacing
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

/**
 * Luma calendar API key (ENG-2338). Keys are scoped to ONE Luma calendar and need
 * a Luma Plus subscription. Like Fathom, the key itself lives in `access_token`
 * (so the shared secret redaction already covers it); there is no expiry, so
 * `token_expires_at` is pinned far in the future and a dead key is flagged via
 * `needs_reconnect` instead.
 */
export interface LumaConfig extends BaseOAuthConfig {
  account_type: 'api_key';
  calendar_url?: string;
  needs_reconnect?: boolean;
}

/**
 * A customer's own Smartlead API key (ENG-673). Smartlead sends their cold email in their account;
 * AgentWeb only holds the key. Like Luma the key itself lives in `access_token` (so the shared
 * secret redaction covers it) and never expires; one connection per user.
 */
export interface SmartleadConfig extends BaseOAuthConfig {
  account_type: 'api_key';
  mailbox_count: number;
  /** Set when Smartlead rejected the key on a probe (revoked, or the plan lapsed); cleared by a reconnect. See services/smartleadConnection.ts. */
  needs_reconnect?: boolean;
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
  // Set after a real-time webhook subscription is registered against this
  // workspace (POST /v2/webhooks — Attio's model is per-workspace, unlike
  // HubSpot's single app-wide subscription list). `webhook_signing_key` is
  // the secret Attio returns at creation time — it's shown only once and
  // must be persisted immediately for HMAC verification of inbound events.
  webhook_id?: string;
  webhook_signing_key?: string;
  // Set when webhook registration fails with 403 (missing webhook:read-write
  // scope on this token — e.g. connected before the scope was added to the
  // app). Cleared on reconnect, same pattern as TwitterXConfig/CalendlyConfig.
  needs_reconnect?: boolean;
}

export interface GoogleAdsConfig extends BaseOAuthConfig {
  account_type: 'google_ads';
  customer_id: string;
  currency: string;
  /**
   * ENG-1362. Google's `test_account` flag, captured at connect time.
   *
   * `true` is Google's guarantee that the account cannot serve ads and cannot spend.
   * `false` means real money. **Absent** means the account was connected before this was
   * recorded — which must be read as billable, never as safe, and is resolved live by
   * `googleAdsService.isTestAccount`.
   *
   * Stored because the account NAME carries no such guarantee: a real, billable, ENABLED
   * account descriptively named "Test" is exactly the case this field disambiguates.
   */
  test_account?: boolean;
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

/** Org-owned Emma Slack bot installation; account_id must equal team_id. */
export interface SlackConfig extends BaseOAuthConfig {
  account_type: 'bot';
  team_id: string;
}

export type PlatformConfig = SlackConfig | LinkedInConfig | LinkedInOutreachConfig | MetaConfig | GmailConfig | OutlookConfig | YouTubeConfig | FathomConfig | LinkedInAdsAdAccountConfig | HubSpotConfig | AttioConfig | GoogleAdsConfig | GoogleDriveConfig | TwitterXConfig | CalendlyConfig | LumaConfig | SmartleadConfig;

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

// ENG-2258: redaction helpers that strip access/refresh tokens and other
// connected-account secrets from a response live in
// `utils/accountSecretRedaction.ts`, not here — this module is `jest.mock`'d
// wholesale across ~90 test files, so a route-facing helper needs to live
// somewhere those mocks don't shadow it.

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
  input: CreateAccountInput,
  // ENG-2686: false when the provider could not confirm the account (e.g. a Unipile
  // ID that getAccount refused); the row is still saved but no integration_connected
  // signal fires for an integration that never happened.
  // ENG-673: resetSharing makes a reconnect private again (a replaced API key must not stay org-shared).
  opts: { providerVerified?: boolean; resetSharing?: boolean } = {}
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
    ...(opts.resetSharing ? { sharedWithOrg: false } : {}),
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
  if (platform === 'hubspot') clearHubSpotPortalCache();

  // ENG-2686: first connection only (a re-OAuth of the same account is not a new integration).
  if (existingIndex < 0 && opts.providerVerified !== false) void emitAppSignal(user as any, 'integration_connected', { platform });

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
      /** Return without writing when the fresh state declines the mutation. */
      skip?: boolean;
    });

/**
 * How many times `updateAccountConfig` retries a write that collided with an
 * in-flight DynamoDB transaction on the same user item, and how long it waits.
 *
 * ENG-1873. `TransactionConflictException` means another request holds a
 * transaction on this item right now — on the users table that is, in practice,
 * the per-completion charge transaction that `tokenUsageService` used to run
 * for each LLM completion (retired in ENG-2286; the retry stays as cheap
 * insurance against any other writer). A tool call executes the moment its completion returns, often
 * while that completion's charge transaction is still committing, so the tool's
 * config write lost the race and was treated as fatal. AWS documents the error
 * as transient; `paymentHistoryDb` and `usageRecordDb` already classify it so.
 *
 * Kept separate from the CAS attempt budget below so it cannot change when a
 * genuine concurrent overwrite gives up with `ConnectedAccountChanged`.
 */
export const TRANSACTION_CONFLICT_RETRIES = 4;
export const transactionConflictBackoffMs = (retry: number): number =>
  25 * 2 ** retry + Math.floor(Math.random() * 25);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  let casAttempts = 0;
  let transactionConflictRetries = 0;
  for (;;) {
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
    const mutation = isDerived
      ? configUpdates(existingAccount.config || {})
      : { updates: configUpdates, unset: options?.unset };
    if (mutation.skip) return;
    const { updates, unset } = mutation;

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
      // ENG-1873: an in-flight transaction on this item (see
      // TRANSACTION_CONFLICT_RETRIES). Back off briefly, then re-read and
      // re-apply exactly as the CAS path does — the merge is recomputed from the
      // fresh read, so a retry can never write a stale snapshot.
      if (
        error?.code === 'TransactionConflictException'
        && transactionConflictRetries < TRANSACTION_CONFLICT_RETRIES
      ) {
        transactionConflictRetries++;
        await sleep(transactionConflictBackoffMs(transactionConflictRetries));
        continue;
      }
      if (error?.code !== 'ConditionalCheckFailedException') throw error;
      casAttempts++;
      if (casAttempts >= 3) {
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
    return await getAccountByIdConsistentOrThrow(accountId, userId, platform);
  } catch (error) {
    console.error('Error in getAccountByIdConsistent:', error);
    return null;
  }
};

/** The same read for a caller that must tell "no such account" from "could not read": a failed read throws instead of returning null. */
export const getAccountByIdConsistentOrThrow = async (
  accountId: string,
  userId: string,
  platform?: PlatformType | PlatformType[]
): Promise<ConnectedAccountWithUser | null> => {
  const user = await userDb.getUserByIdConsistent(userId);
  return findAccountForUser(user as User | undefined, accountId, userId, platform);
};

/**
 * Find the User ID that owns a specific HubSpot Portal.
 * Required for mapping HubSpot webhooks back to local users.
 *
 * ENG-2605. There is no GSI on connected_accounts, so resolving a portal means reading every user.
 * The webhook handler called this once per changed contact: a delivery of N contacts was N full
 * scans of AW-Users (~4 MB each). One snapshot of portal -> owner is now shared by every caller on
 * the instance. It is rebuilt when it is older than HUBSPOT_PORTAL_MAP_TTL_MS (5 min), or when a
 * lookup MISSES on a snapshot older than HUBSPOT_PORTAL_MISS_REFRESH_MS (30 s): portals that
 * installed the app but are unknown here are the common case, so a miss may not rescan on every
 * event, but a portal connected on another instance must be found within seconds. Concurrent
 * rebuilds are shared; if a rebuild fails a stale snapshot still answers; connecting a HubSpot
 * account clears it at once on that instance.
 *
 * A cached HIT is verified before it is returned: one by-id read of the cached owner confirms that
 * user still holds the portal. A portal that moved to another user or was disconnected therefore
 * resolves correctly at once instead of routing events to the former owner for the rest of the TTL.
 * If that read fails, the snapshot is trusted.
 */
const HUBSPOT_PORTAL_MAP_TTL_MS = 5 * 60 * 1000;
// A miss on a snapshot older than this rebuilds once: a portal connected on another instance is then
// found within seconds, not minutes (the webhook handler drops events for an unknown portal).
const HUBSPOT_PORTAL_MISS_REFRESH_MS = 30 * 1000;
let hubspotPortalMapGeneration = 0;
type HubSpotPortalMap = { byPortal: Map<unknown, string>; at: number; invalidated?: boolean };
let hubspotPortalMap: HubSpotPortalMap | null = null;
let hubspotPortalMapInflight: Promise<HubSpotPortalMap> | null = null;

/** Drops the portal -> user snapshot (tests; a new HubSpot connection on this instance). */
export const clearHubSpotPortalCache = (): void => {
  hubspotPortalMap = null;
  // A rebuild already reading users must not publish its pre-change view after this clear.
  hubspotPortalMapGeneration++;
  hubspotPortalMapInflight = null;
};

const loadHubSpotPortalMap = (): Promise<HubSpotPortalMap> => {
  if (!hubspotPortalMapInflight) {
    const generation = hubspotPortalMapGeneration;
    const inflight = (async () => {
      const { userDb } = await import('./db');
      // scanWithFilter, not getAllUsers(): the latter also runs three per-user count scans (tasks, workflows,
      // chat sessions) for the admin dashboard, which this lookup does not need and which let an unrelated
      // table's throttling fail the rebuild. Same population as before: tombstoned (deleted_) users are
      // excluded by scanWithFilter, evaluation users are excluded here, as getAllUsers did by default.
      const users = await userDb.scanWithFilter('attribute_exists(connected_accounts)', {});
      const byPortal = new Map<unknown, string>();
      for (const user of users) {
        if (!user || typeof user.userId !== 'string' || isEvaluationUser(user.userId)) continue;
        if (!user.connected_accounts) continue;
        try {
          for (const account of user.connected_accounts) {
            if (account.platform !== 'hubspot') continue;
            const hubId = (account.config as any)?.hub_id;
            // The first user holding a portal wins, as the per-event scan did.
            if (hubId !== undefined && hubId !== null && !byPortal.has(hubId)) byPortal.set(hubId, user.userId);
          }
        } catch {
          // One malformed record must not hide every other user's portals.
        }
      }
      const snapshot = { byPortal, at: Date.now() };
      // Only publish if nothing cleared the cache while we were reading.
      if (generation === hubspotPortalMapGeneration) hubspotPortalMap = snapshot;
      return snapshot;
    })().finally(() => {
      if (hubspotPortalMapInflight === inflight) hubspotPortalMapInflight = null;
    });
    hubspotPortalMapInflight = inflight;
  }
  return hubspotPortalMapInflight;
};

/** false = the user is gone or no longer holds the portal; undefined = could not tell (trust the snapshot). */
const ownerStillHoldsPortal = async (ownerId: string, portalId: unknown): Promise<boolean | undefined> => {
  try {
    const { userDb } = await import('./db');
    const owner: any = await userDb.getUserById(ownerId);
    if (!owner) return false;
    return (Array.isArray(owner.connected_accounts) ? owner.connected_accounts : []).some(
      (a: any) => a?.platform === 'hubspot' && a?.config?.hub_id === portalId,
    );
  } catch {
    return undefined;
  }
};

export const getUserIdByHubSpotPortalId = async (portalId: number): Promise<string | null> => {
  const cached = hubspotPortalMap;
  let cachedOwnerIsStale = false;
  if (cached && Date.now() - cached.at < HUBSPOT_PORTAL_MAP_TTL_MS) {
    const hit = cached.byPortal.get(portalId);
    if (hit !== undefined) {
      if ((await ownerStillHoldsPortal(hit, portalId)) !== false) return hit;
      // The cached owner no longer holds this portal. Invalidate THIS snapshot once, however many
      // callers notice: the first one drops any rebuild that started before the change (so it can
      // neither be joined nor published) and starts a fresh one; the rest join that rebuild instead
      // of each forcing another full scan. The snapshot itself is kept as the fallback, so other
      // portals keep resolving if the rebuild fails.
      cachedOwnerIsStale = true;
      if (!cached.invalidated) {
        cached.invalidated = true;
        hubspotPortalMapGeneration++;
        hubspotPortalMapInflight = null;
      }
    } else if (Date.now() - cached.at < HUBSPOT_PORTAL_MISS_REFRESH_MS) {
      return null;
    }
    // A miss on a snapshot older than the refresh age falls through to one shared rebuild.
  }
  try {
    return (await loadHubSpotPortalMap()).byPortal.get(portalId) ?? null;
  } catch (error) {
    console.error('Error resolving HubSpot Portal ID to User ID:', error);
    // A stale answer beats dropping a webhook delivery because one rebuild was throttled, but never
    // an owner we have just seen no longer holds the portal, and an expired snapshot's owner is
    // verified like any other hit (this path skips the fresh-snapshot check above). If that read
    // fails too, the snapshot is trusted.
    if (cachedOwnerIsStale) return null;
    const fallback = cached?.byPortal.get(portalId);
    if (fallback === undefined) return null;
    return (await ownerStillHoldsPortal(fallback, portalId)) === false ? null : fallback;
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
 * Find the user (and the specific connected account) that owns a given Attio
 * workspace_id. Used by the incoming Attio webhook to resolve which tenant(s)
 * a delivery belongs to.
 *
 * Returns every match, not a single best-guess userId, following the same
 * ENG-994 lesson `getAccountsByCalendlyUserUri` already documents above:
 * two tenants could in principle connect the same underlying Attio workspace
 * independently, each with their own webhook subscription and signing key —
 * a single-match resolver would silently drop one tenant's deliveries on a
 * collision. The caller verifies each candidate's own webhook_signing_key
 * against the delivery's signature rather than committing to a guess.
 */
export const getAccountsByAttioWorkspaceId = async (
  workspaceId: string
): Promise<Array<{ userId: string; account: ConnectedAccountConfig }>> => {
  try {
    const { userDb } = await import('./db');
    // Deliberately scanWithFilter, not getAllUsers(): this runs on every
    // incoming Attio webhook, unauthenticated until a candidate's signing key
    // verifies below — getAllUsers() additionally starts three count queries
    // (tasks/workflows/chat sessions) per user for admin-dashboard display,
    // irrelevant here and multiplying the cost of every delivery. A full
    // table scan is still unavoidable without a dedicated workspace-to-account
    // index (a schema change, gated separately), but skipping the per-user
    // fan-out removes the dominant, easily-avoidable cost.
    const users = await userDb.scanWithFilter('attribute_exists(connected_accounts)', {});
    const matches: Array<{ userId: string; account: ConnectedAccountConfig }> = [];

    for (const user of users) {
      const accounts = normalizeAccounts((user as User).connected_accounts);
      for (const account of accounts) {
        if (account.platform === 'attio' && (account.config as AttioConfig).workspace_id === workspaceId) {
          matches.push({ userId: user.userId, account });
        }
      }
    }
    return matches;
  } catch (error) {
    console.error('Error resolving Attio workspace_id to accounts:', error);
    return [];
  }
};

/**
 * Check if an account token is still valid
 * First checks expiry timestamp, then verifies via API if not expired
 */
/**
 * Platforms where `config.needs_reconnect` means THE CREDENTIAL IS DEAD.
 *
 * The key is not used consistently, so this cannot be a blanket check:
 *  - hubspot / twitter  — the refresh token was rejected; nothing works until re-OAuth.
 *    twitterService.getClient and HubSpotService.create both refuse outright.
 *  - attio              — set ONLY for a 403 registering the webhook, i.e. a missing
 *                         `webhook:read-write` scope (attioWebhookSubscription.ts:64).
 *                         The token is fine and CRM reads/writes still work; treating it
 *                         as dead would tell Emma a usable account is broken, which is
 *                         the same class of lie in the other direction.
 *  - calendarTools      — returns `needs_reconnect` on a TOOL RESULT, never writes it to
 *                         config, so it is irrelevant here.
 *
 * Attio would be better served by its own key (e.g. `webhook_scope_missing`); until then
 * the exception is explicit rather than implied.
 */
const RECONNECT_MEANS_DEAD_CREDENTIAL = new Set(['hubspot', 'twitter', 'luma', 'smartlead']);

export const isTokenValid = async (account: ConnectedAccount): Promise<boolean> => {
  const now = Date.now();

  // A dead credential outranks every check below, including the refresh_token presence
  // test. Without this, an account that Settings reports as "Reconnect required" was
  // still handed to Emma as `is_active: true` — the assistant telling a customer their
  // integration is fine while the UI tells them it is broken. The Meta Ads branch of
  // routes/connectedAccounts.ts exists for exactly this consistency (ENG-1158).
  if (RECONNECT_MEANS_DEAD_CREDENTIAL.has(account.platform) && (account.config as any)?.needs_reconnect) {
    return false;
  }

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
