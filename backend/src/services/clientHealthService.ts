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

// 'onboarding' = activation incomplete (no ad account ever connected). ENG-2133: that is not a
// churn/at-risk signal, so it never shares a status with a connection that broke.
type HealthStatus = 'healthy' | 'mediocre' | 'at-risk' | 'blocked' | 'onboarding';

export type AdConnectionState = 'never_connected' | 'connected' | 'expired';

/**
 * Classify the client's Meta ad connection without any live API call.
 *
 * - `connected`: a legacy `adAccount` (read with the shared token, which has no per-client
 *   expiry), or a Meta ad account whose token is unexpired, carries no expiry, or can refresh.
 * - `expired`: Meta ad accounts are on record but every token has expired with no refresh token
 *   — a connection that broke (at-risk), reported with the latest expiry.
 * - `never_connected`: nothing on record — an activation state, never a risk state.
 *
 * Same timestamp rule as connectedAccountsDb.isTokenNotExpired, inlined so it stays a pure
 * function of its inputs.
 */
export function classifyMetaAdConnection(
  connectedAccounts: any[],
  legacyAdAccount: string | undefined,
  nowMs: number = Date.now(),
): { connection: AdConnectionState; expiredAt?: string } {
  if (typeof legacyAdAccount === 'string' && legacyAdAccount.trim() !== '') return { connection: 'connected' };
  const metaAdAccounts = (connectedAccounts || []).filter(
    (acc: any) => acc?.platform === 'meta' && acc.config?.account_type === 'ad_account'
  );
  if (metaAdAccounts.length === 0) return { connection: 'never_connected' };
  const usable = metaAdAccounts.some((acc: any) => {
    const expiresAt = acc.config?.token_expires_at;
    return typeof expiresAt !== 'number' || expiresAt > nowMs || !!acc.config?.refresh_token;
  });
  if (usable) return { connection: 'connected' };
  const latestExpiry = Math.max(...metaAdAccounts.map((acc: any) => acc.config.token_expires_at as number));
  return { connection: 'expired', expiredAt: new Date(latestExpiry).toISOString() };
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
  token_expired_at?: string;
  ad_account_id?: string;
  active_campaigns: number;
  campaigns?: Array<{ id: string; name: string; status: string; objective: string }>;
  // ENG-1584 sibling: fetchWithRetryAndPaging is bounded and reports pagingTruncated when a
  // read stops short. false here means active_campaigns undercounts the real total.
  campaigns_complete?: boolean;
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
  has_lander: boolean;
  has_crm: boolean;
  last_activity: string | null;
  signup_time: string | null;
  token_usage_current?: { month: string; totalTokens: number; totalCost: number } | null;
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

  if (adsLayer.connection === 'never_connected') {
    reasons.push('Activation incomplete: no Meta ad account connected yet');
  } else if (adsLayer.connection === 'expired') {
    reasons.push(`Meta ad account connection expired ${adsLayer.token_expired_at} — reconnect needed`);
  }
  if (adsLayer.connected && adsLayer.active_campaigns === 0) {
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

  // Determine status
  let status: HealthStatus;
  if (adsLayer.connection === 'never_connected') {
    status = 'onboarding';
  } else if (adsLayer.connection === 'expired') {
    status = 'at-risk';
  } else if (adsLayer.active_campaigns === 0 && !landerLayer.has_lander) {
    status = 'blocked';
  } else if (reasons.length === 0) {
    status = 'healthy';
  } else if (reasons.length <= 2) {
    status = 'mediocre';
  } else {
    status = 'at-risk';
  }

  return { status, reasons };
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

    // Look up client by email first, then by name
    let client = await userDb.getUserByEmail(clientNameOrEmail);
    // ENG-1907: sandbox principals are not clients — same rule as the name match below.
    if (client && isEvaluationUser(client.userId)) client = undefined;

    if (!client) {
      // Try name match
      const allUsers = await userDb.getAllUsers();
      const searchLower = clientNameOrEmail.toLowerCase();
      client = allUsers.find(
        (u: any) =>
          // ENG-1907: sandbox principals are not clients.
          !isEvaluationUser(u.userId) &&
          ((u.displayName && u.displayName.toLowerCase().includes(searchLower)) ||
            (u.email && u.email.toLowerCase().includes(searchLower)))
      );
    }

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

    // ENG-1767: resolve the account id AND token together as a genuine matched pair — preferring
    // the client's own connected Meta account (their own OAuth grant, their own token) over the
    // legacy `adAccount` field, same precedence `getMetaCredentials` already uses and already has
    // tests for ("connected_accounts over adAccount fallback when both exist"). Both must come
    // from the SAME source: using the connected account's id with the shared/global token (or
    // vice versa) silently reintroduces the exact bug this fix exists to close — the shared token
    // queried against an account id it may not be granted access to, returning zero campaigns
    // with no error. Only falls back to the legacy id + shared token TOGETHER, and only when the
    // connected account has no usable (non-empty) access_token of its own.
    const connectedMetaAccount = metaAdAccounts[0];
    const connectedAdAccountId = (connectedMetaAccount?.config as any)?.ad_account_id;
    const connectedAccessToken = connectedMetaAccount?.config?.access_token;
    const useConnectedAccount = !!connectedAdAccountId && !!connectedAccessToken;

    // Reused below for the campaigns/insights fetches, the reported ad_account_id, and the
    // thresholds lookup, replacing three independent re-derivations that previously disagreed on
    // which field won and could silently drift out of sync with each other.
    const resolvedAdAccountId: string | undefined = useConnectedAccount
      ? connectedAdAccountId
      : (client.adAccount || undefined);

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

    const adConnection = classifyMetaAdConnection(connectedAccounts, client.adAccount);
    const adsLayer: AdsLayerHealth = {
      connected: !!hasAds,
      connection: adConnection.connection,
      ...(adConnection.expiredAt ? { token_expired_at: adConnection.expiredAt } : {}),
      ad_account_id: resolvedAdAccountId,
      active_campaigns: activeCampaigns.length,
      campaigns: activeCampaigns.map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
      })),
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
          ad_connection: classifyMetaAdConnection(accounts, user.adAccount).connection,
          has_lander: hasLander,
          has_crm: hasCrm,
          last_activity: user.lastLoginTime || null,
          signup_time: user.createdAt || null,
          token_usage_current: user.tokenUsage
            ? { month: user.tokenUsage.month, totalTokens: user.tokenUsage.totalTokens, totalCost: user.tokenUsage.totalCost }
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
