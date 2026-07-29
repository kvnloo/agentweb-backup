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

type HealthStatus = 'healthy' | 'mediocre' | 'at-risk' | 'blocked';

interface AdsLayerHealth {
  connected: boolean;
  ad_account_id?: string;
  active_campaigns: number;
  campaigns?: Array<{ id: string; name: string; status: string; objective: string }>;
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

    let activeCampaigns: any[] = [];
    let adLevelData: any[] = [];

    if (hasAds) {
      try {
        const { getMetaAccessToken } = await import('../utils/secretsManager');
        const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');

        const accessToken = await getMetaAccessToken();
        const apiVersion = process.env.META_API_VERSION || 'v25.0';
        const adAccountId = client.adAccount || (metaAdAccounts[0]?.config as any)?.ad_account_id;

        if (adAccountId) {
          // Fetch campaigns
          const campaignsData = await fetchWithRetryAndPaging(
            `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`
          );
          activeCampaigns = (campaignsData.data || []).filter(
            (c: any) => c.status === 'ACTIVE'
          );

          // Fetch ad-level data for creative variety analysis
          if (activeCampaigns.length > 0) {
            const adData = await fetchWithRetryAndPaging(
              `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/ads?fields=id,name,creative{id,name},status,insights.date_preset(last_14d){spend}&filtering=[{"field":"campaign.id","operator":"IN","value":${JSON.stringify(activeCampaigns.map((c: any) => c.id))}}]&access_token=${accessToken}`
            );
            adLevelData = adData.data || [];
          }
        }
      } catch (err) {
        // Non-fatal: ads data unavailable
        console.error('Client health: Error fetching Meta ads data:', err);
      }
    }

    const adsLayer: AdsLayerHealth = {
      connected: !!hasAds,
      ad_account_id: client.adAccount || (metaAdAccounts[0]?.config as any)?.ad_account_id,
      active_campaigns: activeCampaigns.length,
      campaigns: activeCampaigns.map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
      })),
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

    // --- Creative Variety Heuristic ---
    const activeAds = adLevelData.filter((ad: any) => ad.status === 'ACTIVE');
    const distinctCreatives = new Set(
      activeAds.map((ad: any) => ad.creative?.id).filter(Boolean)
    ).size;

    // Compute spend distribution
    let cannibalizationWarning = false;
    let fatigueWarning = false;
    const topCreatives: Array<{ id: string; name: string; spend_pct: number }> = [];

    if (activeAds.length > 0) {
      const adSpends = activeAds.map((ad: any) => ({
        id: ad.id,
        name: ad.name,
        creativeId: ad.creative?.id,
        spend: parseFloat(ad.insights?.data?.[0]?.spend || '0'),
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

      if (distinctCreatives <= 1) {
        fatigueWarning = true;
      }
    }

    const creativeVariety: CreativeVariety = {
      distinct_creatives: distinctCreatives,
      cannibalization_warning: cannibalizationWarning,
      fatigue_warning: fatigueWarning,
      top_creatives: topCreatives,
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
