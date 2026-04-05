import { userDb, crmDb } from "./db";
import { fetchSearchConsoleMetrics } from "./seoService";
import { MetaService } from "./metaService";
import { getAccountByPlatform } from "./connectedAccountsDb";

// ─── Types ──────────────────────────────────────────────────────────────

interface SourceBreakdown {
  name: string;
  count: number;
  status: "ok" | "error" | "unavailable";
  error?: string;
}

interface BusinessFunnelStage {
  name: string;
  count: number;
  previousCount: number;
  conversionRate: number;
  sources: SourceBreakdown[];
}

interface FunnelBottleneck {
  stage: string;
  conversionRate: number;
  suggestion: string;
}

export interface BusinessFunnelMetrics {
  stages: BusinessFunnelStage[];
  bottleneck: FunnelBottleneck | null;
  period: { start: string; end: string };
  generatedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

const FOUNDER_USER_ID = "be754b6c-767e-44ec-b181-4042cfe45ea9";
const SEO_DOMAIN = "agentweb.pro";

// Stages that are placeholders (data source not connected)
const PLACEHOLDER_STAGES = new Set(["Contacted", "Talked", "Committed"]);

// ─── Helpers ────────────────────────────────────────────────────────────

function parsePeriodDays(period: string): number {
  const match = period.match(/^(\d+)d$/);
  return match ? parseInt(match[1], 10) : 30;
}

function getDateRange(days: number): { start: Date; end: Date; startStr: string; endStr: string } {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);

  return {
    start,
    end,
    startStr: start.toISOString().split("T")[0],
    endStr: end.toISOString().split("T")[0],
  };
}

function getPreviousDateRange(days: number): { start: Date; end: Date } {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - days);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start, end };
}

function safeSource(name: string, count: number): SourceBreakdown {
  return { name, count, status: "ok" };
}

function errorSource(name: string, error: string): SourceBreakdown {
  return { name, count: 0, status: "error", error };
}

function unavailableSource(name: string): SourceBreakdown {
  return { name, count: 0, status: "unavailable" };
}

// ─── Data Fetchers ──────────────────────────────────────────────────────

async function fetchGSCData(
  timeframe: string
): Promise<{ impressions: number; clicks: number; status: "ok" | "error" }> {
  try {
    const result = await fetchSearchConsoleMetrics(FOUNDER_USER_ID, timeframe, SEO_DOMAIN);
    if (result.error || !result.metrics || result.metrics.length === 0) {
      return { impressions: 0, clicks: 0, status: "error" };
    }

    let impressions = 0;
    let clicks = 0;
    for (const m of result.metrics) {
      impressions += m.impressions || 0;
      clicks += m.clicks || 0;
    }

    return { impressions, clicks, status: "ok" };
  } catch (error: any) {
    console.error("[BusinessFunnelService] GSC fetch error:", error.message);
    return { impressions: 0, clicks: 0, status: "error" };
  }
}

async function fetchMetaAdsData(
  timeframe: string
): Promise<{ impressions: number; clicks: number; status: "ok" | "error" | "unavailable" }> {
  try {
    // Get the founder's Meta connected account
    const metaAccount = await getAccountByPlatform(FOUNDER_USER_ID, "meta");
    if (!metaAccount) {
      return { impressions: 0, clicks: 0, status: "unavailable" };
    }

    const accessToken = (metaAccount.config as any)?.access_token;
    if (!accessToken) {
      return { impressions: 0, clicks: 0, status: "unavailable" };
    }

    // Get the ad account ID from the user record
    const user = await userDb.getUserById(FOUNDER_USER_ID);
    const adAccountId = user?.adAccount;
    if (!adAccountId) {
      return { impressions: 0, clicks: 0, status: "unavailable" };
    }

    const metaService = MetaService.getInstance();
    const insights = await metaService.getInsights(adAccountId, accessToken, {
      timeframe,
      level: "account",
    });

    if (!insights || !Array.isArray(insights) || insights.length === 0) {
      return { impressions: 0, clicks: 0, status: "ok" };
    }

    let impressions = 0;
    let clicks = 0;
    for (const row of insights) {
      impressions += parseInt(row.impressions || "0", 10);
      clicks += parseInt(row.clicks || "0", 10);
    }

    return { impressions, clicks, status: "ok" };
  } catch (error: any) {
    console.error("[BusinessFunnelService] Meta Ads fetch error:", error.message);
    return { impressions: 0, clicks: 0, status: "error" };
  }
}

async function fetchLeadCount(
  periodStart: Date
): Promise<{ total: number; thisMonth: number; status: "ok" | "error" }> {
  try {
    const leadLists = await crmDb.getLeadListsByUserId(FOUNDER_USER_ID);
    let total = 0;
    let thisMonth = 0;

    for (const list of leadLists) {
      let lastKey: any = null;
      do {
        const result = await crmDb.getLeadsByListId(list.listId, 100, lastKey);
        total += result.items.length;

        // Count leads created in the current period
        for (const lead of result.items) {
          const createdAt = lead.createdAt ? new Date(lead.createdAt) : null;
          if (createdAt && createdAt >= periodStart) {
            thisMonth++;
          }
        }

        lastKey = result.lastEvaluatedKey;
      } while (lastKey);
    }

    return { total, thisMonth, status: "ok" };
  } catch (error: any) {
    console.error("[BusinessFunnelService] Lead count fetch error:", error.message);
    return { total: 0, thisMonth: 0, status: "error" };
  }
}

interface UserCounts {
  totalUsers: number;
  newUsers: number;
  paidUsers: number;
  activeUsers: number;
  retainedUsers: number;
  churnedUsers: number;
}

async function fetchUserAndSubscriptionData(
  periodStart: Date,
  previousPeriodStart: Date,
  previousPeriodEnd: Date
): Promise<{ data: UserCounts; previousData: UserCounts; status: "ok" | "error" }> {
  try {
    // Use scanWithFilter for efficiency instead of getAllUsers (which fetches task/workflow counts)
    const allUsers = await userDb.scanWithFilter(
      "attribute_exists(userId)",
      {}
    );

    const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

    let totalUsers = allUsers.length;
    let newUsers = 0;
    let prevNewUsers = 0;
    let paidUsers = 0;
    let prevPaidUsers = 0;
    let activeUsers = 0;
    let prevActiveUsers = 0;
    let retainedUsers = 0;
    let prevRetainedUsers = 0;
    let churnedUsers = 0;
    let prevChurnedUsers = 0;

    for (const user of allUsers) {
      const createdAt = user.createdAt ? new Date(user.createdAt) : null;

      // New users in current period
      if (createdAt && createdAt >= periodStart) {
        newUsers++;
      }
      // New users in previous period
      if (createdAt && createdAt >= previousPeriodStart && createdAt < previousPeriodEnd) {
        prevNewUsers++;
      }

      // Paid users (active or trialing subscription)
      const subStatus = user.subscription_status;
      if (subStatus === "active" || subStatus === "trialing") {
        paidUsers++;

        // Retained = paid user whose account was created more than one period ago
        if (createdAt && createdAt < periodStart) {
          retainedUsers++;
        }
      }

      // Churned = canceled subscription
      if (subStatus === "canceled" || subStatus === "canceling") {
        churnedUsers++;
      }

      // Active = has token usage in the current month
      const tokenMonth = user.tokenUsage?.month;
      const tokenCount = user.tokenUsage?.totalTokens || 0;
      if (tokenMonth === currentMonth && tokenCount > 0) {
        activeUsers++;
      }
    }

    // For previous period, approximate with the same data
    // (we don't have historical subscription snapshots, so use rough estimates)
    const previousData: UserCounts = {
      totalUsers: Math.max(0, totalUsers - newUsers),
      newUsers: prevNewUsers,
      paidUsers: Math.max(0, paidUsers),
      activeUsers: Math.max(0, activeUsers),
      retainedUsers: Math.max(0, retainedUsers),
      churnedUsers: Math.max(0, churnedUsers),
    };

    return {
      data: { totalUsers, newUsers, paidUsers, activeUsers, retainedUsers, churnedUsers },
      previousData,
      status: "ok",
    };
  } catch (error: any) {
    console.error("[BusinessFunnelService] User data fetch error:", error.message);
    const empty: UserCounts = {
      totalUsers: 0,
      newUsers: 0,
      paidUsers: 0,
      activeUsers: 0,
      retainedUsers: 0,
      churnedUsers: 0,
    };
    return { data: empty, previousData: empty, status: "error" };
  }
}

// ─── Main Aggregator ────────────────────────────────────────────────────

export async function getBusinessFunnelMetrics(period: string = "30d"): Promise<BusinessFunnelMetrics> {
  const days = parsePeriodDays(period);
  const timeframe = `${days}d`;
  const dateRange = getDateRange(days);
  const previousRange = getPreviousDateRange(days);

  // Fetch all data sources in parallel
  const [gscData, metaData, leadData, userData] = await Promise.all([
    fetchGSCData(timeframe),
    fetchMetaAdsData(timeframe),
    fetchLeadCount(dateRange.start),
    fetchUserAndSubscriptionData(dateRange.start, previousRange.start, previousRange.end),
  ]);

  // Build stages
  const stages: BusinessFunnelStage[] = [];

  // 1. Aware: GSC impressions + Meta Ads impressions
  const awareCount = gscData.impressions + metaData.impressions;
  const awareSources: SourceBreakdown[] = [
    gscData.status === "ok"
      ? safeSource("Google Search Console", gscData.impressions)
      : errorSource("Google Search Console", "Failed to fetch GSC data"),
    metaData.status === "ok"
      ? safeSource("Meta Ads", metaData.impressions)
      : metaData.status === "unavailable"
      ? unavailableSource("Meta Ads")
      : errorSource("Meta Ads", "Failed to fetch Meta Ads data"),
  ];
  stages.push({
    name: "Aware",
    count: awareCount,
    previousCount: 0,
    conversionRate: 100,
    sources: awareSources,
  });

  // 2. Clicked: GSC clicks + Meta Ads clicks
  const clickedCount = gscData.clicks + metaData.clicks;
  const clickedSources: SourceBreakdown[] = [
    gscData.status === "ok"
      ? safeSource("Google Search Console", gscData.clicks)
      : errorSource("Google Search Console", "Failed to fetch GSC data"),
    metaData.status === "ok"
      ? safeSource("Meta Ads", metaData.clicks)
      : metaData.status === "unavailable"
      ? unavailableSource("Meta Ads")
      : errorSource("Meta Ads", "Failed to fetch Meta Ads data"),
  ];
  stages.push({
    name: "Clicked",
    count: clickedCount,
    previousCount: 0,
    conversionRate: awareCount > 0 ? parseFloat(((clickedCount / awareCount) * 100).toFixed(2)) : 0,
    sources: clickedSources,
  });

  // 3. Identified: Leads + new user signups
  const identifiedCount = leadData.thisMonth + userData.data.newUsers;
  const identifiedSources: SourceBreakdown[] = [
    leadData.status === "ok"
      ? safeSource("Lead Lists", leadData.thisMonth)
      : errorSource("Lead Lists", "Failed to fetch lead data"),
    userData.status === "ok"
      ? safeSource("User Signups", userData.data.newUsers)
      : errorSource("User Signups", "Failed to fetch user data"),
  ];
  stages.push({
    name: "Identified",
    count: identifiedCount,
    previousCount: userData.previousData.newUsers,
    conversionRate: clickedCount > 0 ? parseFloat(((identifiedCount / clickedCount) * 100).toFixed(2)) : 0,
    sources: identifiedSources,
  });

  // 4. Contacted: Placeholder
  stages.push({
    name: "Contacted",
    count: 0,
    previousCount: 0,
    conversionRate: 0,
    sources: [unavailableSource("SalesRobot (not connected)")],
  });

  // 5. Talked: Placeholder
  stages.push({
    name: "Talked",
    count: 0,
    previousCount: 0,
    conversionRate: 0,
    sources: [unavailableSource("Calendly (not connected)")],
  });

  // 6. Committed: Placeholder
  stages.push({
    name: "Committed",
    count: 0,
    previousCount: 0,
    conversionRate: 0,
    sources: [unavailableSource("Manual tracking")],
  });

  // 7. Paid: Active paying subscribers
  // Conversion rate from Identified (skipping placeholders)
  stages.push({
    name: "Paid",
    count: userData.data.paidUsers,
    previousCount: userData.previousData.paidUsers,
    conversionRate: identifiedCount > 0
      ? parseFloat(((userData.data.paidUsers / identifiedCount) * 100).toFixed(2))
      : 0,
    sources: [
      userData.status === "ok"
        ? safeSource("Stripe (active/trialing)", userData.data.paidUsers)
        : errorSource("Stripe", "Failed to fetch subscription data"),
    ],
  });

  // 8. Active: Users with token usage > 0 this month
  stages.push({
    name: "Active",
    count: userData.data.activeUsers,
    previousCount: userData.previousData.activeUsers,
    conversionRate: userData.data.paidUsers > 0
      ? parseFloat(((userData.data.activeUsers / userData.data.paidUsers) * 100).toFixed(2))
      : 0,
    sources: [
      userData.status === "ok"
        ? safeSource("Token Usage (current month)", userData.data.activeUsers)
        : errorSource("Token Usage", "Failed to fetch usage data"),
    ],
  });

  // 9. Retained: Subscribers who signed up before the current period
  stages.push({
    name: "Retained",
    count: userData.data.retainedUsers,
    previousCount: userData.previousData.retainedUsers,
    conversionRate: userData.data.paidUsers > 0
      ? parseFloat(((userData.data.retainedUsers / userData.data.paidUsers) * 100).toFixed(2))
      : 0,
    sources: [
      userData.status === "ok"
        ? safeSource("Stripe (month 2+ subscribers)", userData.data.retainedUsers)
        : errorSource("Stripe", "Failed to fetch retention data"),
    ],
  });

  // 10. Churned: Canceled subscriptions
  stages.push({
    name: "Churned",
    count: userData.data.churnedUsers,
    previousCount: userData.previousData.churnedUsers,
    conversionRate:
      userData.data.paidUsers + userData.data.churnedUsers > 0
        ? parseFloat(
            ((userData.data.churnedUsers / (userData.data.paidUsers + userData.data.churnedUsers)) * 100).toFixed(2)
          )
        : 0,
    sources: [
      userData.status === "ok"
        ? safeSource("Stripe (canceled/canceling)", userData.data.churnedUsers)
        : errorSource("Stripe", "Failed to fetch churn data"),
    ],
  });

  // Find bottleneck: worst conversion rate among stages with real data
  let bottleneck: FunnelBottleneck | null = null;
  let worstRate = Infinity;

  for (let i = 1; i < stages.length; i++) {
    const stage = stages[i];
    // Skip placeholder stages and Churned (it's not a conversion stage)
    if (PLACEHOLDER_STAGES.has(stage.name) || stage.name === "Churned") continue;

    // Find the previous non-placeholder stage
    const prevStage = findPreviousRealStage(stages, i);
    if (!prevStage || prevStage.count === 0) continue;

    const rate = (stage.count / prevStage.count) * 100;
    if (rate < worstRate) {
      worstRate = rate;
      bottleneck = {
        stage: stage.name,
        conversionRate: parseFloat(rate.toFixed(2)),
        suggestion: getBottleneckSuggestion(stage.name, rate),
      };
    }
  }

  return {
    stages,
    bottleneck,
    period: {
      start: dateRange.startStr,
      end: dateRange.endStr,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Find the previous stage with real data (skipping placeholders).
 */
function findPreviousRealStage(stages: BusinessFunnelStage[], currentIndex: number): BusinessFunnelStage | null {
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (!PLACEHOLDER_STAGES.has(stages[i].name)) {
      return stages[i];
    }
  }
  return null;
}

/**
 * Generate actionable suggestions based on which stage is the bottleneck.
 */
function getBottleneckSuggestion(stageName: string, rate: number): string {
  const suggestions: Record<string, string> = {
    Clicked:
      "Low CTR. Improve meta titles/descriptions and ad copy to drive more clicks from impressions.",
    Identified:
      "Visitors aren't converting to leads/signups. Add lead magnets, improve CTAs, or simplify the signup flow.",
    Paid:
      "Leads aren't converting to paid. Review pricing, onboarding experience, and value demonstration.",
    Active:
      "Paid users aren't engaging. Improve onboarding, send activation emails, or add feature tutorials.",
    Retained:
      "Low retention. Investigate churn reasons, improve product value, and add re-engagement campaigns.",
  };

  return (
    suggestions[stageName] ||
    `${stageName} conversion is ${rate.toFixed(1)}%. Investigate drop-off reasons.`
  );
}
