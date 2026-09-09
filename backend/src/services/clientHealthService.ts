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

type HealthStatus = 'healthy' | 'mediocre' | 'at-risk' | 'blocked';

interface AdsLayerHealth {
  connected: boolean;
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

  if (!adsLayer.connected) {
    reasons.push('No Meta ad account connected');
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
  if (!adsLayer.connected) {
    status = 'blocked';
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

    if (!client) {
      // Try name match
      const allUsers = await userDb.getAllUsers();
      const searchLower = clientNameOrEmail.toLowerCase();
      client = allUsers.find(
        (u: any) =>
          (u.displayName && u.displayName.toLowerCase().includes(searchLower)) ||
          (u.email && u.email.toLowerCase().includes(searchLower))
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

    // ENG-1767: resolve the account id ONCE, preferring the client's own connected Meta account
    // over the legacy `adAccount` field — same precedence `getMetaCredentials` already uses and
    // already has tests for ("connected_accounts over adAccount fallback when both exist").
    // Reused below for the campaigns/insights fetches, the reported ad_account_id, and the
    // thresholds lookup, replacing three independent re-derivations that previously disagreed on
    // which field won and could silently drift out of sync with each other.
    const resolvedAdAccountId: string | undefined =
      (metaAdAccounts[0]?.config as any)?.ad_account_id || client.adAccount || undefined;

    let activeCampaigns: any[] = [];
    let adLevelData: any[] = [];
    /*
     * Defaults to "complete" only when there is nothing to check (`!hasAds`) — `active_campaigns:
     * 0` is genuinely the true count there. When `hasAds`, this starts false and only flips true
     * after a campaigns read actually succeeds without truncation, below. Before this fix it
     * defaulted to true unconditionally and only flipped FALSE on a truncated success — a fetch
     * that THREW (network error, expired token) fell through to the catch block below, which
     * only logs, leaving activeCampaigns empty and campaignsComplete still true: a fetch that
     * read NOTHING reported as "confirmed zero campaigns, complete."
     */
    let campaignsComplete = !hasAds;

    if (hasAds) {
      try {
        const { getMetaAccessToken } = await import('../utils/secretsManager');
        const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');

        // ENG-1767: use the client's OWN connected token when they have a connected Meta account
        // — previously this always used the shared app-wide token regardless, which can silently
        // see zero campaigns for an account the shared token isn't granted access to even though
        // the client's own OAuth grant works fine (confirmed live: a real account with real spend
        // read zero campaigns through the shared token, no error). Only falls back to the shared
        // token for the legacy-only case (no real connected account at all).
        const accessToken = metaAdAccounts[0]?.config?.access_token || await getMetaAccessToken();
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
          activeCampaigns = (campaignsData.data || []).filter(
            (c: any) => c.status === 'ACTIVE'
          );
          campaignsComplete = campaignsData.pagingTruncated !== true;

          // Fetch ad-level data for creative variety + fatigue analysis, requesting both the
          // current and prior 14-day windows via `time_ranges` in one `insights` edge call —
          // returns two rows per ad in `insights.data`, distinguished by `date_start`.
          if (activeCampaigns.length > 0) {
            const filtering = `[{"field":"campaign.id","operator":"IN","value":${JSON.stringify(activeCampaigns.map((c: any) => c.id))}}]`;
            const insightsFields = 'spend,frequency,ctr,cpm,date_start';
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
            const adData = await fetchWithRetryAndPaging(
              `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/ads?fields=id,name,${creativeSelector},status,` +
                `${insightsSelector}` +
                `&filtering=${filtering}&access_token=${accessToken}`
            );
            adLevelData = (adData.data || []).map((ad: any) => {
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
          }
        }
      } catch (err) {
        // Non-fatal: ads data unavailable
        console.error('Client health: Error fetching Meta ads data:', err);
      }
    }

    const adsLayer: AdsLayerHealth = {
      connected: !!hasAds,
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
    };

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

    const allUsers = await userDb.getAllUsers();
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
