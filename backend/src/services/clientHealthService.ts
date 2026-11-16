/**
 * Client Health Assessment Service
 *
 * Provides admin-only tools for assessing client health across three layers:
 * 1. Ads layer — Meta ad account connectivity and campaign status
 * 2. Lander layer — Landing page / website presence
 * 3. Lead quality layer — CRM / lead capture setup
 *
 * Also provides creative variety heuristics from ad-level data.
 */

import { userDb } from './db';
import { getAccountsByUserId } from './connectedAccountsDb';
import { getThresholdsForAccount } from './adsThresholdsDb';
import { resolveThresholds } from './adsThresholds';
import { captureFatigueRecommendations } from './adsRecommendationCapture';
import { isEvaluationUser } from './evaluationPolicy';
import { getProjectionsBatch } from './spendProjectionDb';

// 'onboarding' = activation incomplete (no ad account ever connected). ENG-2133: that is not a
// churn/at-risk signal, so it never shares a status with a connection that broke.
// 'needs-attention' = a setup or reconnect problem (every ad connection expired, or several setup
// gaps). ENG-2188: neither is behavioural evidence, so neither is 'at-risk'. 'at-risk' is reserved
// for the ENG-2143 classifier's behavioural evidence and is not produced here.
type HealthStatus = 'healthy' | 'mediocre' | 'at-risk' | 'blocked' | 'onboarding' | 'needs-attention';

export type AdConnectionState = 'never_connected' | 'connected' | 'expired' | 'other_platform';

/** Non-Meta ad platforms. This service only reads Meta campaigns, but a client advertising here
 * has activated ads and must not read as onboarding. */
const OTHER_AD_PLATFORM_LIST = ['google_ads', 'linkedin_ads'] as const;
const OTHER_AD_PLATFORMS: ReadonlySet<string> = new Set(OTHER_AD_PLATFORM_LIST);

/** The fields the connection classifier reads; ConnectedAccount records satisfy it. */
export interface AdConnectionAccount {
  platform?: string;
  config?: {
    account_type?: string;
    token_expires_at?: number;
    refresh_token?: string;
    has_meta_pages?: boolean;
    meta_page_count?: number;
    meta_page_health_error?: string;
    declined_required_permissions?: string[];
    meta_oauth_health_error?: string;
    granted_scopes?: string[];
  };
}

function isMetaAdAccount(acc: AdConnectionAccount | null | undefined): acc is AdConnectionAccount {
  return acc?.platform === 'meta' && acc.config?.account_type === 'ad_account';
}

/** An ad account whose token is unexpired, carries no expiry, or can refresh. The rule is not
 * Meta-specific: accountHealthClassifier applies it to Google Ads and LinkedIn Ads too (ENG-2143). */
export function hasUsableAdToken(acc: AdConnectionAccount, nowMs: number): boolean {
  const expiresAt = acc.config?.token_expires_at;
  return typeof expiresAt !== 'number' || expiresAt > nowMs || !!acc.config?.refresh_token;
}

/**
 * Classify the client's Meta ad connection without any live API call.
 *
 * - `connected`: a legacy `adAccount` (read with the shared token, which has no per-client
 *   expiry), or a Meta ad account whose token is unexpired, carries no expiry, or can refresh.
 * - `expired`: Meta ad accounts are on record but every token has expired with no refresh token
 *   — a connection that broke (reconnect needed), reported with the latest expiry.
 * - `other_platform`: no Meta ad account, but a Google Ads or LinkedIn Ads account is on record —
 *   ads are activated elsewhere, so the Meta layer is not assessed (expiry there is ENG-2143's).
 * - `never_connected`: no ad account on any platform — an activation state, never a risk state.
 *
 * Same timestamp rule as connectedAccountsDb.isTokenNotExpired, inlined so it stays a pure
 * function of its inputs.
 */
export function classifyMetaAdConnection(
  connectedAccounts: ReadonlyArray<AdConnectionAccount | null | undefined> | null | undefined,
  legacyAdAccount: string | undefined,
  nowMs: number = Date.now(),
): { connection: AdConnectionState; expiredAt?: string } {
  if (typeof legacyAdAccount === 'string' && legacyAdAccount.trim() !== '') return { connection: 'connected' };
  const metaAdAccounts = (connectedAccounts ?? []).filter(isMetaAdAccount);
  if (metaAdAccounts.length === 0) {
    const otherAds = (connectedAccounts ?? []).some((acc) => !!acc?.platform && OTHER_AD_PLATFORMS.has(acc.platform));
    return { connection: otherAds ? 'other_platform' : 'never_connected' };
  }
  if (metaAdAccounts.some((acc) => hasUsableAdToken(acc, nowMs))) return { connection: 'connected' };
  // Every account failed hasUsableAdToken, so each carries a numeric token_expires_at.
  const latestExpiry = Math.max(...metaAdAccounts.map((acc) => acc.config?.token_expires_at ?? 0));
  return { connection: 'expired', expiredAt: new Date(latestExpiry).toISOString() };
}

/** Ad-connection state across every ad platform. */
export interface AdConnectionSummary {
  state: 'never_connected' | 'connected' | 'expired';
  meta: AdConnectionState;
  /** Per non-Meta platform on record. */
  others: Partial<Record<'google_ads' | 'linkedin_ads', 'connected' | 'expired'>>;
  /** Latest token expiry across expired accounts, when `state` is `expired`. */
  expiredAt?: string;
}

/**
 * Meta goes through classifyMetaAdConnection (legacy `adAccount`, ad-account type filter); Google
 * Ads and LinkedIn Ads accounts use the same token rule (`hasUsableAdToken`). Any usable account
 * on any platform makes the account connected; `expired` means every ad account on record has
 * expired. Shared by the Client Health roster, assess_client_health, the renewal cron and the
 * ENG-2143 classifier (ENG-2188: one expiry rule for every surface).
 */
export function classifyAdConnections(
  connectedAccounts: ReadonlyArray<AdConnectionAccount | null | undefined> | null | undefined,
  legacyAdAccount: string | undefined,
  nowMs: number,
): AdConnectionSummary {
  const meta = classifyMetaAdConnection(connectedAccounts, legacyAdAccount, nowMs);
  const others: AdConnectionSummary['others'] = {};
  const expiries: number[] = [];
  if (meta.connection === 'expired' && meta.expiredAt) expiries.push(Date.parse(meta.expiredAt));
  for (const platform of OTHER_AD_PLATFORM_LIST) {
    const accounts = (connectedAccounts ?? []).filter(
      (acc): acc is AdConnectionAccount => acc?.platform === platform,
    );
    if (accounts.length === 0) continue;
    if (accounts.some((acc) => hasUsableAdToken(acc, nowMs))) {
      others[platform] = 'connected';
    } else {
      others[platform] = 'expired';
      expiries.push(Math.max(...accounts.map((acc) => acc.config?.token_expires_at ?? 0)));
    }
  }
  const otherStates = Object.values(others);
  if (meta.connection === 'connected' || otherStates.includes('connected')) {
    return { state: 'connected', meta: meta.connection, others };
  }
  if (meta.connection === 'expired' || otherStates.includes('expired')) {
    return {
      state: 'expired',
      meta: meta.connection,
      others,
      expiredAt: new Date(Math.max(...expiries)).toISOString(),
    };
  }
  return { state: 'never_connected', meta: meta.connection, others };
}

/** Both Meta reads share this boundary. A malformed element makes the read incomplete,
 * rather than letting a partial array manufacture a fatigue recommendation. */
function healthRows(result: any): any[] {
  const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(result)) throw new Error('Invalid Meta health response');
  if (result.error) return [];
  if (!Array.isArray(result.data)) throw new Error('Invalid Meta health data');
  for (const row of result.data) {
    if (!object(row) || typeof row.id !== 'string' || !row.id.trim() ||
        (row.status !== undefined && typeof row.status !== 'string') ||
        (row.campaign_id !== undefined && typeof row.campaign_id !== 'string') ||
        (row.creative !== undefined && !object(row.creative))) throw new Error('Invalid Meta health row');
    if (row.insights !== undefined) {
      if (!object(row.insights) || !Array.isArray(row.insights.data)) throw new Error('Invalid Meta insights');
      for (const insight of row.insights.data) {
        if (!object(insight)) throw new Error('Invalid Meta insight row');
        for (const key of ['date_start', 'date_stop']) {
          if (insight[key] !== undefined && typeof insight[key] !== 'string') throw new Error('Invalid Meta insight date');
        }
        for (const key of ['spend', 'frequency', 'ctr', 'cpm']) {
          const value = insight[key];
          if (value !== undefined &&
              !((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
                Number.isFinite(Number(value)) && Number(value) >= 0)) throw new Error('Invalid Meta insight metric');
        }
      }
    }
  }
  return result.data;
}

interface AdsLayerHealth {
  connected: boolean;
  connection: AdConnectionState;
  /** Across every ad platform (ENG-2188): `expired` only when no ad account on any platform is usable. */
  connection_all_platforms: AdConnectionSummary['state'];
  /** Latest expiry across every platform, when `connection_all_platforms` is `expired`. */
  all_platforms_expired_at?: string;
  token_expired_at?: string;
  ad_account_id?: string;
  active_campaigns: number;
  campaigns?: Array<{ id: string; name: string; status: string; objective: string }>;
  meta_connection_health?: MetaConnectionHealth;
  // ENG-1584 sibling: fetchWithRetryAndPaging is bounded and reports pagingTruncated when a
  // read stops short. false here means active_campaigns undercounts the real total.
  campaigns_complete?: boolean;
}

interface MetaConnectionHealth {
  permissions: 'granted' | 'declined' | 'unknown';
  declined_permissions?: string[];
  permissions_error?: string;
  page_access: 'available' | 'missing' | 'unknown';
  page_count?: number;
  page_error?: string;
  selected_event: 'recent' | 'missing' | 'unknown';
  reconnect_required: boolean;
  reconnect_instructions?: string;
}

interface LanderLayerHealth {
  has_lander: boolean;
  platforms: string[];
}

interface LeadQualityLayerHealth {
  has_crm: boolean;
  platforms: string[];
}

interface CreativeVariety {
  distinct_creatives: number;
  cannibalization_warning: boolean;
  fatigue_warning: boolean;
  top_creatives?: Array<{ id: string; name: string; spend_pct: number }>;
  fatigued_creatives?: Array<{
    id: string;
    name: string;
    reasons: Array<'frequency' | 'ctr_drop' | 'cpm_rise'>;
  }>;
  // Sibling of ads_layer.campaigns_complete: false when the ad-level insights read (the
  // creative-fatigue/cannibalization source data) failed or was truncated despite active
  // campaigns existing. Without this, a failed read reports zero warnings with full confidence
  // — a client's health can look BETTER than it is, not just incomplete.
  creative_data_complete?: boolean;
}

interface PaymentInfo {
  subscription_type: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  has_payment_method: boolean;
  monthly_amount_cents: number | null;
}

interface ClientHealthAssessment {
  client: { userId: string; email: string; displayName: string };
  ads_layer: AdsLayerHealth;
  lander_layer: LanderLayerHealth;
  lead_quality_layer: LeadQualityLayerHealth;
  creative_variety: CreativeVariety;
  status: HealthStatus;
  status_reasons: string[];
  payment: PaymentInfo;
  notes: string;
}

interface ClientSummary {
  userId: string;
  email: string;
  displayName: string;
  roles: string[];
  has_ads: boolean;
  ad_connection: AdConnectionState;
  ad_connection_all_platforms: AdConnectionSummary['state'];
  has_lander: boolean;
  has_crm: boolean;
  last_activity: string | null;
  signup_time: string | null;
  /**
   * This month's settled spend for the account, from the spend ledger (ENG-1250 AC7). Replaces
   * `token_usage_current`, which read the retired legacy counter. null when the account has no
   * settled spend this month, or when the ledger lookup failed (logged).
   */
  spend_current?: { month: string; totalCost: number } | null;
  token_usage_history?: Array<{ month: string; totalTokens: number; totalCost: number }>;
  subscription_type: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  has_payment_method: boolean;
  monthly_amount_cents: number | null;
}

interface LandingPageSignals {
  hasLander: boolean;
  hasLeadCapture: boolean;
}

type LandingPageSignalCache = Map<string, Promise<LandingPageSignals>>;

function buildPaymentInfo(user: any): PaymentInfo {
  return {
    subscription_type: user.subscriptionType || null,
    stripe_customer_id: user.stripe_customer_id || null,
    current_period_end: user.current_period_end || null,
    has_payment_method: user.has_payment_method === true,
    monthly_amount_cents: user.subscription_amount ?? null,
  };
}

const META_RECONNECT_INSTRUCTIONS =
  'Click Edit access, select all current and future Pages, approve all permissions.';

function buildMetaConnectionHealth(account: AdConnectionAccount | undefined): MetaConnectionHealth | undefined {
  if (!account) return undefined;
  const config = account.config ?? {};
  const declined = Array.isArray(config.declined_required_permissions)
    ? config.declined_required_permissions.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    : [];
  const permissionsError = typeof config.meta_oauth_health_error === 'string' && config.meta_oauth_health_error.trim()
    ? config.meta_oauth_health_error.trim()
    : undefined;
  const pageError = typeof config.meta_page_health_error === 'string' && config.meta_page_health_error.trim()
    ? config.meta_page_health_error.trim()
    : undefined;
  const pageCount = typeof config.meta_page_count === 'number' ? config.meta_page_count : undefined;
  const pageAccess =
    config.has_meta_pages === true ? 'available' :
    config.has_meta_pages === false ? 'missing' :
    'unknown';
  const hasGrantedScopeSignal = Array.isArray(config.granted_scopes) && config.granted_scopes.length > 0;
  const hasDeclinedSignal = Array.isArray(config.declined_required_permissions);
  const reconnectRequired = declined.length > 0 || pageAccess === 'missing';

  return {
    permissions: declined.length > 0
      ? 'declined'
      : permissionsError || (!hasGrantedScopeSignal && !hasDeclinedSignal)
        ? 'unknown'
        : 'granted',
    ...(declined.length > 0 ? { declined_permissions: declined } : {}),
    ...(permissionsError ? { permissions_error: permissionsError } : {}),
    page_access: pageAccess,
    ...(pageCount !== undefined ? { page_count: pageCount } : {}),
    ...(pageError ? { page_error: pageError } : {}),
    selected_event: 'unknown',
    reconnect_required: reconnectRequired,
    ...(reconnectRequired ? { reconnect_instructions: META_RECONNECT_INSTRUCTIONS } : {}),
  };
}

/**
 * Resolve deployed landing-page signals across the client's organization.
 *
 * Landing pages are org-visible assets but are stored under the user who
 * created them. Looking only at fields on the client record therefore reports
 * false negatives for teammates such as RankAI's Hugo/Dyllan accounts.
 */
async function getLandingPageSignals(
  client: any,
  cache?: LandingPageSignalCache
): Promise<LandingPageSignals> {
  const cacheKey = client.orgId ? `org:${client.orgId}` : `user:${client.userId}`;
  const cached = cache?.get(cacheKey);
  if (cached) return cached;

  const loadSignals = (async () => {
    try {
      const { getLandingPagesByOwner, getLandingPagesByOrg } = await import('./v0Service');
      const [ownerPages, orgPages] = await Promise.all([
        getLandingPagesByOwner(client.userId),
        client.orgId ? getLandingPagesByOrg(client.orgId, client.userId) : Promise.resolve([]),
      ]);
      const deployedPages = [...ownerPages, ...orgPages].filter(
        (page: any) => page.status === 'deployed'
      );

      return {
        hasLander: deployedPages.length > 0,
        hasLeadCapture: deployedPages.some(
          (page: any) => typeof page.leadListId === 'string' && page.leadListId.trim() !== ''
        ),
      };
    } catch (error) {
      console.warn(
        `Client health: landing-page signals unavailable for ${client.userId}; using legacy signals:`,
        error instanceof Error ? error.message : error
      );
      return { hasLander: false, hasLeadCapture: false };
    }
  })();

  cache?.set(cacheKey, loadSignals);
  return loadSignals;
}

/**
 * Determine overall health status based on the three layers.
 */
function determineStatus(
  adsLayer: AdsLayerHealth,
  landerLayer: LanderLayerHealth,
  leadQualityLayer: LeadQualityLayerHealth,
  creativeVariety: CreativeVariety
): { status: HealthStatus; reasons: string[] } {
  const reasons: string[] = [];
  const allPlatforms = adsLayer.connection_all_platforms;

  if (allPlatforms === 'never_connected') {
    reasons.push('Activation incomplete: no ad account connected yet');
  } else if (allPlatforms === 'expired') {
    reasons.push(`Every ad account connection has expired (latest ${adsLayer.all_platforms_expired_at}) — reconnect needed`);
  } else if (adsLayer.connection === 'expired') {
    reasons.push(`Meta ad account connection expired ${adsLayer.token_expired_at} — reconnect needed (ads still connected on another platform)`);
  }
  const campaignsUnread = adsLayer.connection === 'connected' && adsLayer.campaigns_complete === false;
  if (campaignsUnread) {
    reasons.push('Meta campaign data could not be read — ads status unconfirmed');
  } else if (adsLayer.connected && adsLayer.active_campaigns === 0) {
    reasons.push('No active ad campaigns');
  }
  if (!landerLayer.has_lander) {
    reasons.push('No landing page or website detected');
  }
  if (!leadQualityLayer.has_crm) {
    reasons.push('No CRM or lead capture integration');
  }
  if (creativeVariety.cannibalization_warning) {
    reasons.push('Creative cannibalization: 2 ads taking >80% of spend');
  }
  if (creativeVariety.fatigue_warning) {
    reasons.push('Potential creative fatigue: limited creative variety');
  }

  // Determine status. ENG-2188: an expired connection and setup gaps are reconnect/setup work
  // ('needs-attention'), not churn evidence, so nothing here returns 'at-risk'.
  let status: HealthStatus;
  if (allPlatforms === 'never_connected') {
    status = 'onboarding';
  } else if (allPlatforms === 'expired') {
    status = 'needs-attention';
  } else if (adsLayer.connection === 'connected' && !campaignsUnread &&
             adsLayer.active_campaigns === 0 && !landerLayer.has_lander) {
    status = 'blocked';
  } else if (reasons.length === 0) {
    status = 'healthy';
  } else if (reasons.length <= 2) {
    status = 'mediocre';
  } else {
    status = 'needs-attention';
  }

  return { status, reasons };
}

/**
 * Every client an admin's identifier could mean. An exact email match stands alone; otherwise
 * every user whose display name or email contains the text (case-insensitive), in scan order.
 * ENG-1907: sandbox principals are not clients and never match.
 */
export async function findClientMatches(clientNameOrEmail: string): Promise<any[]> {
  const byEmail = await userDb.getUserByEmail(clientNameOrEmail);
  if (byEmail && !isEvaluationUser(byEmail.userId)) return [byEmail];
  const allUsers = await userDb.getAllUsers();
  const searchLower = clientNameOrEmail.toLowerCase();
  return allUsers.filter(
    (u: any) =>
      !isEvaluationUser(u.userId) &&
      ((u.displayName && u.displayName.toLowerCase().includes(searchLower)) ||
        (u.email && u.email.toLowerCase().includes(searchLower)))
  );
}

/**
 * Pick the Meta ad account an admin read goes through, and whether it is read with the client's
 * own token (`useConnectedAccount`) or the legacy `adAccount` id with the shared token.
 */
export function resolveClientMetaAccount(
  client: { adAccount?: string },
  metaAdAccounts: any[],
  nowMs: number,
): { connectedMetaAccount: any; useConnectedAccount: boolean; resolvedAdAccountId: string | undefined } {
  // ENG-1767: resolve the account id AND token together as a genuine matched pair — preferring
  // the client's own connected Meta account (their own OAuth grant, their own token) over the
  // legacy `adAccount` field, same precedence `getMetaCredentials` already uses and already has
  // tests for ("connected_accounts over adAccount fallback when both exist"). Both must come
  // from the SAME source: using the connected account's id with the shared/global token (or
  // vice versa) silently reintroduces the exact bug this fix exists to close — the shared token
  // queried against an account id it may not be granted access to, returning zero campaigns
  // with no error. Only falls back to the legacy id + shared token TOGETHER, and only when the
  // connected account has no usable (non-empty) access_token of its own.
  // Prefer the first account the campaign fetch can actually use (unexpired AND carrying an
  // account id and token), then any unexpired record, then the first. A stale or incomplete first
  // record must not shadow a working later one (the health status and the fetch agree).
  const hasFetchCredentials = (acc: AdConnectionAccount): boolean => {
    const config = acc.config as { ad_account_id?: string; access_token?: string } | undefined;
    return !!config?.ad_account_id && !!config?.access_token;
  };
  const connectedMetaAccount =
    metaAdAccounts.find((acc) => hasUsableAdToken(acc, nowMs) && hasFetchCredentials(acc)) ??
    metaAdAccounts.find((acc) => hasUsableAdToken(acc, nowMs)) ??
    metaAdAccounts[0];
  const connectedAdAccountId = (connectedMetaAccount?.config as any)?.ad_account_id;
  const connectedAccessToken = connectedMetaAccount?.config?.access_token;
  // An expired connected account never wins over a legacy adAccount: the classifier counts the
  // legacy account as the live connection, so the fetch must read through it too.
  const connectedIsUsable = !!connectedMetaAccount && hasUsableAdToken(connectedMetaAccount, nowMs);
  const legacyAvailable = typeof client.adAccount === 'string' && client.adAccount.trim() !== '';
  const useConnectedAccount =
    !!connectedAdAccountId && !!connectedAccessToken && (connectedIsUsable || !legacyAvailable);
  return {
    connectedMetaAccount,
    useConnectedAccount,
    resolvedAdAccountId: useConnectedAccount ? connectedAdAccountId : (client.adAccount || undefined),
  };
}

/**
 * Assess a single client's health. Admin-only.
 */
export async function assessClientHealth(
  callerUserId: string,
  clientNameOrEmail: string,
  callerIsAdmin?: boolean
): Promise<any> {
  try {
    // Auth gate: check caller is admin.
    // callerIsAdmin may be pre-verified by the route (e.g. from _svc token for delegated sessions).
    const isAdmin = callerIsAdmin !== undefined
      ? callerIsAdmin
      : (await userDb.getUserById(callerUserId))?.isAdmin === true;
    if (!isAdmin) {
      return {
        success: false,
        message: 'Access denied. Only admin users can assess client health.',
        error: 'Admin access required',
      };
    }

    // First match wins here (unchanged); readClientMetaActivity refuses an ambiguous name instead.
    const client = (await findClientMatches(clientNameOrEmail))[0];

    if (!client) {
      return {
        success: false,
        message: `Client "${clientNameOrEmail}" not found.`,
        error: 'Client not found',
      };
    }

    // Get connected accounts
    const connectedAccounts = await getAccountsByUserId(client.userId);

    // --- Ads Layer ---
    const metaAdAccounts = connectedAccounts.filter(
      (acc: any) => acc.platform === 'meta' && acc.config?.account_type === 'ad_account'
    );
    const hasAds = metaAdAccounts.length > 0 || (client.adAccount && client.adAccount.trim() !== '');

    const nowMs = Date.now();
    const { connectedMetaAccount, useConnectedAccount, resolvedAdAccountId } =
      resolveClientMetaAccount(client, metaAdAccounts, nowMs);

    let activeCampaigns: any[] = [];
    let adLevelData: any[] = [];
    // Defaults true: trivially complete when the ad-level fetch is never attempted (no active
    // campaigns to look up, or the campaigns fetch itself already failed — that failure is
    // already signalled via campaigns_complete below, and creative_variety derives from
    // active_campaigns, so a reader who already distrusts one already knows to distrust both).
    // Only flips false when the ad-level fetch is attempted AND it independently fails/truncates.
    let adLevelDataComplete = true;
    /*
     * Defaults to "complete" only when there is nothing to check (`!hasAds`) — `active_campaigns:
     * 0` is genuinely the true count there. When `hasAds`, this starts false and only flips true
     * after a campaigns read actually succeeds cleanly, below. Before this fix it defaulted to
     * true unconditionally and only flipped FALSE on a truncated success — a fetch that THREW
     * (network error, expired token) fell through to the catch block below, which only logs,
     * leaving activeCampaigns empty and campaignsComplete still true: a fetch that read NOTHING
     * reported as "confirmed zero campaigns, complete."
     *
     * ENG-1767 follow-up: `fetchWithRetryAndPaging` does not throw on a Graph API error (bad
     * token, permission revoked, etc.) — by its own documented contract it RETURNS the parsed
     * `{ error: {...} }` body instead, with no `data` array and no `pagingTruncated` flag.
     * Checking only `pagingTruncated` missed exactly this case: a real permission error came back
     * as `activeCampaigns: [], campaignsComplete: true` — confirmed live against a real account
     * whose stored token had lost Graph access — the same "silent wrong zero" failure shape this
     * ticket exists to eliminate, just via a first-page API error instead of a wrong token source.
     */
    let campaignsComplete = !hasAds;

    if (hasAds) {
      try {
        const { getMetaAccessToken } = await import('../utils/secretsManager');
        const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');

        // ENG-1767: use the client's OWN connected token when `useConnectedAccount` selected it
        // above — previously this always used the shared app-wide token regardless, which can
        // silently see zero campaigns for an account the shared token isn't granted access to
        // even though the client's own OAuth grant works fine (confirmed live: a real account
        // with real spend read zero campaigns through the shared token, no error). Only falls
        // back to the shared token for the legacy-only case (no usable connected account at all)
        // — matching `resolvedAdAccountId`'s own fallback above, so id and token never diverge.
        //
        // Refresh BEFORE reading it: unlike the shared token (which never expires from this
        // caller's perspective), a client's own connected token can go stale, and reading a stale
        // token here would trade one silent-wrong-data failure mode for a different one — this
        // client's OWN health check quietly degrading to "unverified" even though the shared token
        // might have coincidentally still worked for them before this fix. `ensureFreshMetaAdAccountToken`
        // never throws — it refreshes proactively when needed and mutates `connectedMetaAccount.config`
        // in place on success (re-read below, not the closure-captured `connectedAccessToken`, since
        // that was captured before this call), or silently leaves the existing token in place if
        // refresh fails (it may still be valid).
        let accessToken: string;
        if (useConnectedAccount) {
          const { ensureFreshMetaAdAccountToken } = await import('./metaTokenRefresh');
          await ensureFreshMetaAdAccountToken(connectedMetaAccount, client.userId);
          accessToken = connectedMetaAccount.config.access_token;
        } else {
          accessToken = await getMetaAccessToken();
        }
        const apiVersion = process.env.META_API_VERSION || 'v25.0';
        const adAccountId = resolvedAdAccountId;

        // Current 14-day window and the prior 14-day window immediately preceding it, used as
        // the baseline for CTR-drop / CPM-rise fatigue checks. Fetched via the Graph API's
        // `time_ranges` array param on a single `insights` edge — NOT via aliasing two separate
        // `insights` sub-fields (e.g. `current:insights.date_preset(...)`), which the Graph API
        // silently drops (confirmed live against a real ad account: the aliased field is simply
        // absent from the response, no error). `time_ranges` returns one row per window in
        // `insights.data`, distinguished by `date_start`/`date_stop`.
        const currentWindowEndDate = new Date();
        const currentWindowStartDate = new Date(currentWindowEndDate);
        currentWindowStartDate.setUTCDate(currentWindowStartDate.getUTCDate() - 13);
        const priorWindowEndDate = new Date(currentWindowStartDate);
        priorWindowEndDate.setUTCDate(priorWindowEndDate.getUTCDate() - 1);
        const priorWindowStartDate = new Date(priorWindowEndDate);
        priorWindowStartDate.setUTCDate(priorWindowStartDate.getUTCDate() - 13);

        const currentWindowStart = currentWindowStartDate.toISOString().slice(0, 10);
        const currentWindowEnd = currentWindowEndDate.toISOString().slice(0, 10);
        const priorWindowStart = priorWindowStartDate.toISOString().slice(0, 10);
        const priorWindowEnd = priorWindowEndDate.toISOString().slice(0, 10);

        if (adAccountId) {
          // Fetch campaigns
          const campaignsData = await fetchWithRetryAndPaging(
            `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`
          );
          activeCampaigns = healthRows(campaignsData).filter(
            (c: any) => c.status === 'ACTIVE'
          );
          campaignsComplete = campaignsData.pagingTruncated !== true && !campaignsData.error;

          // Fetch ad-level data for creative variety + fatigue analysis, requesting both the
          // current and prior 14-day windows via `time_ranges` in one `insights` edge call —
          // returns two rows per ad in `insights.data`, distinguished by `date_start`.
          if (activeCampaigns.length > 0) {
            const filtering = `[{"field":"campaign.id","operator":"IN","value":${JSON.stringify(activeCampaigns.map((c: any) => c.id))}}]`;
            const insightsFields = 'spend,frequency,ctr,cpm,date_start,date_stop';
            const timeRanges = JSON.stringify([
              { since: currentWindowStart, until: currentWindowEnd },
              { since: priorWindowStart, until: priorWindowEnd },
            ]);
            /*
             * ENG-1742 follow-up: unencoded `{...}` in a nested field selector is silently
             * mangled by Graph, and the failure mode depends on the edge/syntax involved —
             * confirmed live 2026-09-04 against a real ad account:
             *   - `creative{id,name}` on this `ads` edge doesn't error, it silently drops the
             *     whole `creative` field from every result (same as the sibling fix in
             *     meta.ts/agentModeService.ts).
             *   - `insights.time_ranges(...){...}` is worse: it hard-errors on EVERY call
             *     ("Syntax error \"Expected end of string...\""), so this feature has never
             *     returned ad-level insights at all, not just missing creative names.
             * `encodeURIComponent` each selector independently — the field-call argument
             * (`time_ranges(...)`) was already correctly encoded; only the two `{...}` sub-field
             * blocks around it needed the same treatment.
             */
            const creativeSelector = encodeURIComponent('creative{id,name}');
            const insightsSelector =
              encodeURIComponent('insights.time_ranges(') +
              encodeURIComponent(timeRanges) +
              encodeURIComponent(`){${insightsFields}}`);
            // Pessimistic the moment we decide to attempt this fetch — mirrors campaignsComplete's
            // own pattern (starts false, only flips true after a full clean read). If the transform
            // below throws on malformed data, this stays false rather than reverting to the outer
            // "nothing to check" default, which would otherwise misreport a crashed read as complete.
            adLevelDataComplete = false;
            const adData = await fetchWithRetryAndPaging(
              `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/ads?fields=id,name,campaign_id,${creativeSelector},status,` +
                `${insightsSelector}` +
                `&filtering=${filtering}&access_token=${accessToken}`
            );
            adLevelData = healthRows(adData).map((ad: any) => {
              // Matched by RELATIVE ORDER (newest date_start = current, oldest = prior), not by
              // exact string equality against our own UTC-computed date strings. Meta buckets
              // insights `date_start` in the AD ACCOUNT's own timezone, not UTC — this codebase
              // has been burned by that exact mismatch before (see ENG-926's "Windows and
              // timing" notes). An exact-match `.find()` would silently return undefined for
              // every ad on any non-UTC account, degrading fatigue detection with no error. We
              // requested exactly two non-overlapping 13-day windows with a 1-day gap between
              // them, so even a several-hour timezone shift cannot reorder them — "later window"
              // is a safe, timezone-agnostic way to identify "current" that exact-string matching
              // is not.
              const rows: any[] = (ad.insights?.data || [])
                .filter((r: any) => typeof r.date_start === 'string')
                .sort((a: any, b: any) => (a.date_start < b.date_start ? 1 : -1)); // newest first
              const [current, prior] = rows;
              return {
                ...ad,
                current_insights: current ? { data: [current] } : undefined,
                prior_insights: prior ? { data: [prior] } : undefined,
              };
            });
            // Only reached once the fetch AND the transform above both completed without
            // throwing — same shape as campaigns_complete: fetchWithRetryAndPaging resolves with
            // {error:{...}} rather than throwing on a Graph API error, so this must be checked
            // explicitly rather than relying on the catch block below, which never runs for that
            // case.
            adLevelDataComplete = adData.pagingTruncated !== true && !adData.error;
          }
        }
      } catch (err) {
        // Non-fatal: ads data unavailable
        console.error('Client health: Error fetching Meta ads data:', err);
      }
    }

    const adConnection = classifyMetaAdConnection(connectedAccounts, client.adAccount, nowMs);
    const allPlatforms = classifyAdConnections(connectedAccounts, client.adAccount, nowMs);
    const metaConnectionHealth = buildMetaConnectionHealth(connectedMetaAccount);
    const adsLayer: AdsLayerHealth = {
      connected: !!hasAds,
      connection: adConnection.connection,
      connection_all_platforms: allPlatforms.state,
      ...(allPlatforms.expiredAt ? { all_platforms_expired_at: allPlatforms.expiredAt } : {}),
      ...(adConnection.expiredAt ? { token_expired_at: adConnection.expiredAt } : {}),
      ad_account_id: resolvedAdAccountId,
      active_campaigns: activeCampaigns.length,
      campaigns: activeCampaigns.map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
      })),
      ...(metaConnectionHealth ? { meta_connection_health: metaConnectionHealth } : {}),
      campaigns_complete: campaignsComplete,
    };

    // --- Lander Layer ---
    const landingPageSignals = await getLandingPageSignals(client);
    // Check both legacy per-user domain fields and deployed org landing pages.
    const hasLander = !!(
      client.productDomain ||
      (client.seoDomains && client.seoDomains.length > 0) ||
      landingPageSignals.hasLander
    );
    const landerPlatforms: string[] = [];
    if (client.productDomain) landerPlatforms.push('product_domain');
    if (client.seoDomains && client.seoDomains.length > 0) landerPlatforms.push('seo_domains');
    if (landingPageSignals.hasLander) landerPlatforms.push('landing_page');

    const landerLayer: LanderLayerHealth = {
      has_lander: hasLander,
      platforms: landerPlatforms,
    };

    // --- Lead Quality Layer ---
    // Check for CRM integrations via connected accounts, email setup, or a
    // deployed landing page wired to a lead list.
    const hasCrm = !!(
      client.emailDomain ||
      landingPageSignals.hasLeadCapture ||
      connectedAccounts.some((acc: any) =>
        acc.platform === 'linkedin' && acc.config?.account_type === 'personal'
      )
    );
    const crmPlatforms: string[] = [];
    if (client.emailDomain) crmPlatforms.push('email_outreach');
    if (connectedAccounts.some((acc: any) => acc.platform === 'linkedin')) {
      crmPlatforms.push('linkedin');
    }
    if (landingPageSignals.hasLeadCapture) {
      crmPlatforms.push('landing_page_lead_capture');
    }

    const leadQualityLayer: LeadQualityLayerHealth = {
      has_crm: hasCrm,
      platforms: crmPlatforms,
    };

    // --- Creative Variety + Fatigue Detection ---
    const activeAds = adLevelData.filter((ad: any) => ad.status === 'ACTIVE');
    const distinctCreatives = new Set(
      activeAds.map((ad: any) => ad.creative?.id).filter(Boolean)
    ).size;

    // Compute spend distribution
    let cannibalizationWarning = false;
    const topCreatives: Array<{ id: string; name: string; spend_pct: number }> = [];
    const fatiguedCreatives: Array<{
      id: string;
      name: string;
      reasons: Array<'frequency' | 'ctr_drop' | 'cpm_rise'>;
    }> = [];

    if (activeAds.length > 0) {
      // Resolved once per assessment (not per-creative) — same thresholds apply to every
      // creative in this ad account.
      const adAccountIdForThresholds = resolvedAdAccountId;
      let resolvedThresholds: Record<string, { value: number; source: string }> = {};
      if (adAccountIdForThresholds) {
        try {
          const storedThresholds = await getThresholdsForAccount('meta', adAccountIdForThresholds);
          resolvedThresholds = resolveThresholds(storedThresholds);
        } catch (err) {
          // Non-fatal: fall back to no fatigue checks rather than failing the whole assessment.
          console.error('Client health: Error resolving ads thresholds:', err);
        }
      }
      const frequencyCritical = resolvedThresholds['creativeFatigue.frequencyCritical']?.value;
      const ctrDropCriticalPct = resolvedThresholds['creativeFatigue.ctrDropCriticalPct']?.value;
      const cpmRiseCriticalPct = resolvedThresholds['creativeFatigue.cpmRiseCriticalPct']?.value;

      const adSpends = activeAds.map((ad: any) => ({
        id: ad.id,
        name: ad.name,
        creativeId: ad.creative?.id,
        spend: parseFloat(ad.current_insights?.data?.[0]?.spend || '0'),
      }));

      const totalSpend = adSpends.reduce((sum: number, a: any) => sum + a.spend, 0);

      if (totalSpend > 0) {
        const sorted = adSpends.sort((a: any, b: any) => b.spend - a.spend);
        const topTwoSpend = sorted.slice(0, 2).reduce((sum: number, a: any) => sum + a.spend, 0);

        if (sorted.length >= 2 && topTwoSpend / totalSpend > 0.8) {
          cannibalizationWarning = true;
        }

        for (const ad of sorted.slice(0, 5)) {
          topCreatives.push({
            id: ad.id,
            name: ad.name,
            spend_pct: Math.round((ad.spend / totalSpend) * 100),
          });
        }
      }

      // Per-creative fatigue checks against the resolved thresholds. `frequency` is an absolute
      // ceiling; `ctr`/`cpm` need the prior-period baseline to express a drop/rise — creatives
      // with no prior-period data (e.g. newly launched) skip those two checks, since there's no
      // baseline to compare against.
      for (const ad of activeAds) {
        const reasons: Array<'frequency' | 'ctr_drop' | 'cpm_rise'> = [];
        const cur = ad.current_insights?.data?.[0];
        const prior = ad.prior_insights?.data?.[0];

        const curFrequency = parseFloat(cur?.frequency || '0');
        if (frequencyCritical !== undefined && curFrequency > frequencyCritical) {
          reasons.push('frequency');
        }

        if (prior) {
          const curCtr = parseFloat(cur?.ctr || '0');
          const priorCtr = parseFloat(prior.ctr || '0');
          if (ctrDropCriticalPct !== undefined && priorCtr > 0) {
            const ctrDropPct = ((priorCtr - curCtr) / priorCtr) * 100;
            if (ctrDropPct > ctrDropCriticalPct) {
              reasons.push('ctr_drop');
            }
          }

          const curCpm = parseFloat(cur?.cpm || '0');
          const priorCpm = parseFloat(prior.cpm || '0');
          if (cpmRiseCriticalPct !== undefined && priorCpm > 0) {
            const cpmRisePct = ((curCpm - priorCpm) / priorCpm) * 100;
            if (cpmRisePct > cpmRiseCriticalPct) {
              reasons.push('cpm_rise');
            }
          }
        }

        if (reasons.length > 0) {
          fatiguedCreatives.push({ id: ad.id, name: ad.name, reasons });
        }
      }
    }

    const fatigueWarning = fatiguedCreatives.length > 0;

    const creativeVariety: CreativeVariety = {
      distinct_creatives: distinctCreatives,
      cannibalization_warning: cannibalizationWarning,
      fatigue_warning: fatigueWarning,
      top_creatives: topCreatives,
      fatigued_creatives: fatiguedCreatives,
      // ANDed with campaignsComplete: the ad-level fetch can succeed cleanly on its own while
      // still being built from a truncated/errored campaigns list (fetchWithRetryAndPaging keeps
      // whatever partial data it already has rather than discarding it on truncation) — that
      // input incompleteness has to propagate here too, not just report the ad-level fetch's own
      // isolated success.
      creative_data_complete: adLevelDataComplete && campaignsComplete,
    };

    if (creativeVariety.creative_data_complete && resolvedAdAccountId) {
      await captureFatigueRecommendations({
        clientUserId: client.userId, accountId: resolvedAdAccountId,
        campaignIds: activeCampaigns.map((c: any) => c.id), ads: activeAds,
        fatigued: fatiguedCreatives, now: new Date().toISOString(),
      });
    }

    // --- Overall Status ---
    const { status, reasons } = determineStatus(adsLayer, landerLayer, leadQualityLayer, creativeVariety);

    const health: ClientHealthAssessment = {
      client: {
        userId: client.userId,
        email: client.email,
        displayName: client.displayName || client.email,
      },
      ads_layer: adsLayer,
      lander_layer: landerLayer,
      lead_quality_layer: leadQualityLayer,
      creative_variety: creativeVariety,
      status,
      status_reasons: reasons,
      payment: buildPaymentInfo(client),
      notes: client.clientHealthNote || '',
    };

    return {
      success: true,
      message: `Health assessment for ${client.displayName || client.email}: ${status.toUpperCase()}`,
      health,
    };
  } catch (error) {
    console.error('Client health assessment error:', error);
    return {
      success: false,
      message: 'Failed to assess client health',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * ENG-3070: an admin reads one named client's Meta change history (the `activities` edge).
 * Read-only. Resolves the client and the account/token pair exactly as assessClientHealth does,
 * but refuses an ambiguous name instead of taking the first match, and never reads any account
 * other than the named client's.
 */
export async function readClientMetaActivity(
  callerUserId: string,
  clientNameOrEmail: string,
  args: { since?: string; until?: string; limit?: number; after?: string } = {},
  callerIsAdmin?: boolean,
): Promise<any> {
  const refuse = (reason: string, message: string, extra: Record<string, unknown> = {}) =>
    ({ success: false, reason, message, ...extra });

  const isAdmin = callerIsAdmin !== undefined
    ? callerIsAdmin
    : (await userDb.getUserById(callerUserId))?.isAdmin === true;
  if (!isAdmin) {
    return { ...refuse('not_admin', 'Access denied. Only admin users can read a client\'s Meta change history.'), error: 'Admin access required' };
  }

  const matches = await findClientMatches(clientNameOrEmail);
  if (matches.length === 0) {
    return { ...refuse('client_not_found', `Client "${clientNameOrEmail}" not found.`), error: 'Client not found' };
  }
  if (matches.length > 1) {
    return refuse(
      'ambiguous_client',
      `"${clientNameOrEmail}" matches ${matches.length} clients. Nothing was read; ask again with the client's exact email.`,
      { matches: matches.slice(0, 10).map((u: any) => ({ email: u.email, displayName: u.displayName })) },
    );
  }
  const client = matches[0];
  const clientRef = { userId: client.userId, email: client.email, displayName: client.displayName };

  const metaAdAccounts = (await getAccountsByUserId(client.userId)).filter(
    (acc: any) => acc.platform === 'meta' && acc.config?.account_type === 'ad_account'
  );
  const nowMs = Date.now();
  const { connectedMetaAccount, useConnectedAccount, resolvedAdAccountId } =
    resolveClientMetaAccount(client, metaAdAccounts, nowMs);

  if (!resolvedAdAccountId) {
    // A connected account id without its own token is not read with the shared token.
    return (connectedMetaAccount?.config as any)?.ad_account_id
      ? refuse('credential_pair_mismatch', 'The client\'s connected Meta ad account has no access token of its own, and the shared token is not used for a client-connected account. Nothing was read; the client needs to reconnect Meta.', { client: clientRef })
      : refuse('no_meta_connection', 'This client has no Meta ad account connected. Nothing was read.', { client: clientRef });
  }
  if (useConnectedAccount && !hasUsableAdToken(connectedMetaAccount, nowMs)) {
    return refuse('no_meta_connection', 'This client\'s Meta connection has expired and cannot refresh. Nothing was read; the client needs to reconnect Meta.', { client: clientRef, ad_account_id: resolvedAdAccountId });
  }

  let accessToken: string;
  if (useConnectedAccount) {
    const { ensureFreshMetaAdAccountToken } = await import('./metaTokenRefresh');
    await ensureFreshMetaAdAccountToken(connectedMetaAccount, client.userId);
    accessToken = connectedMetaAccount.config.access_token;
  } else {
    const { getMetaAccessToken } = await import('../utils/secretsManager');
    accessToken = await getMetaAccessToken();
  }
  const scope = {
    client: clientRef,
    ad_account_id: resolvedAdAccountId,
    credential_source: useConnectedAccount ? 'client_connection' : 'legacy_shared_token',
  };

  const { executeActivityLogRead } = await import('../mcp/metaToolkitDiagnostics');
  const { MetaToolkitRefusal } = await import('../mcp/metaToolkitErrors');
  const readArgs = Object.fromEntries(
    (['since', 'until', 'limit', 'after'] as const).filter((k) => args[k] !== undefined).map((k) => [k, args[k]])
  );
  let data: any;
  try {
    data = await executeActivityLogRead(readArgs, { accountId: resolvedAdAccountId, accessToken });
  } catch (error) {
    if (error instanceof MetaToolkitRefusal) return refuse('invalid_argument', error.message, scope);
    throw error;
  }
  // executeActivityLogRead returns Meta failures as { success: false, ... }; anything without an
  // event array is a failed read, never an empty history.
  if (data?.success === false) return { ...data, reason: 'meta_read_failed', ...scope };
  if (!Array.isArray(data?.data)) {
    return refuse('meta_read_failed', 'Meta returned no activity list for this account. Treat the history as unread, not empty.', scope);
  }
  return {
    success: true,
    ...scope,
    events: data.data.map(withBeforeAfter),
    ...(data.paging ? { paging: data.paging } : {}),
  };
}

/** Lift Meta's own old/new values out of `extra_data` when it parses; add nothing otherwise. */
function withBeforeAfter(event: any) {
  let extra: any = event?.extra_data;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { return event; }
  }
  if (!extra || typeof extra !== 'object' || !('old_value' in extra || 'new_value' in extra)) return event;
  return { ...event, before: extra.old_value ?? null, after: extra.new_value ?? null };
}

/**
 * List all clients (including admins) with quick health indicators. Admin-only.
 */
export async function listAllClients(callerUserId: string, callerIsAdmin?: boolean): Promise<any> {
  try {
    // Auth gate: check caller is admin.
    // callerIsAdmin may be pre-verified by the route (e.g. from _svc token for delegated sessions).
    const isAdmin = callerIsAdmin !== undefined
      ? callerIsAdmin
      : (await userDb.getUserById(callerUserId))?.isAdmin === true;
    if (!isAdmin) {
      return {
        success: false,
        message: 'Access denied. Only admin users can list clients.',
        error: 'Admin access required',
      };
    }

    // ENG-1907: a sandbox take-home account looks like a Pro customer with a Meta
    // connection; it is not a client and must not appear in the roster or its health sweep.
    const allUsers = (await userDb.getAllUsers()).filter((u: any) => !isEvaluationUser(u.userId));
    const landingPageSignalCache: LandingPageSignalCache = new Map();
    const nowMs = Date.now();

    // This month's settled spend per account, from the ledger in one batched read (it replaces
    // the retired legacy counter). Secondary to the health signals, so a failed read must not
    // fail the whole sweep: log it and leave spend_current null rather than invent a figure.
    // Keyed by each client's own id, not their billing owner, to keep the old per-account meaning: pooled
    // usage was charged to the owner's counter only, so a member's own was null. The owner's row carries
    // the pooled total.
    const spendMonth = new Date().toISOString().slice(0, 7);
    let spendByUser = new Map<string, { settledMicroUsd: number }>();
    try {
      spendByUser = await getProjectionsBatch(allUsers.map((u: any) => u.userId), spendMonth);
    } catch (error) {
      console.error('[clientHealth] ledger spend lookup failed; spend_current left null:', error);
    }

    const clients: ClientSummary[] = await Promise.all(
      allUsers.map(async (user: any) => {
        const [accounts, landingPageSignals] = await Promise.all([
          getAccountsByUserId(user.userId),
          getLandingPageSignals(user, landingPageSignalCache),
        ]);

        const hasAds = !!(
          accounts.some(
            (acc: any) => acc.platform === 'meta' && acc.config?.account_type === 'ad_account'
          ) || (user.adAccount && user.adAccount.trim() !== '')
        );

        const hasLander = !!(
          user.productDomain ||
          (user.seoDomains && user.seoDomains.length > 0) ||
          landingPageSignals.hasLander
        );

        const hasCrm = !!(
          user.emailDomain ||
          landingPageSignals.hasLeadCapture ||
          accounts.some((acc: any) => acc.platform === 'linkedin')
        );

        return {
          userId: user.userId,
          email: user.email,
          displayName: user.displayName || user.email,
          roles: user.roles || [],
          has_ads: hasAds,
          ad_connection: classifyMetaAdConnection(accounts, user.adAccount, nowMs).connection,
          ad_connection_all_platforms: classifyAdConnections(accounts, user.adAccount, nowMs).state,
          has_lander: hasLander,
          has_crm: hasCrm,
          last_activity: user.lastLoginTime || null,
          signup_time: user.createdAt || null,
          spend_current: spendByUser.has(user.userId)
            ? { month: spendMonth, totalCost: spendByUser.get(user.userId)!.settledMicroUsd / 1_000_000 }
            : null,
          token_usage_history: user.tokenUsageHistory || [],
          ...buildPaymentInfo(user),
        };
      })
    );

    return {
      success: true,
      message: `Found ${clients.length} client(s)`,
      clients,
    };
  } catch (error) {
    console.error('List all clients error:', error);
    return {
      success: false,
      message: 'Failed to list clients',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
