import { userDb, crmDb } from "./db";
import { fetchSearchConsoleMetrics } from "./seoService";
import { MetaService } from "./metaService";
import { getAccountByPlatform } from "./connectedAccountsDb";
import { getProspectMeetingMetrics, ProspectMeetingMetrics } from "./prospectMeetingService";
import { getSmartLeadMetrics, SmartLeadMetrics } from "./smartleadService";
import { getUnipileOutreachMetrics, UnipileOutreachMetrics } from "./unipileOutreachService";

// ─── Types ──────────────────────────────────────────────────────────────

interface SourceDetail {
  label: string;       // e.g. "37angels.com — Alex Kimmet"
  count: number;       // meetings with this prospect
  talkedCount: number;
  lastDate: string;    // ISO date of most recent meeting
  contacts: string[];  // email addresses
  recordingUrl?: string; // Fathom link to most recent recording
}

interface SourceBreakdown {
  name: string;
  count: number;
  status: "ok" | "error" | "unavailable";
  error?: string;
  details?: SourceDetail[]; // expandable drill-down
}

export interface FunnelStage {
  name: string;
  count: number;
  previousCount: number;
  conversionRate: number; // from previous stage
  sources: SourceBreakdown[];
  status: "ok" | "unavailable" | "error";
}

export interface ConstraintAnalysis {
  stage: string;
  conversionRate: number;
  type: "more" | "metrics" | "market" | "model" | "money_leads" | "money_sales" | "money_ltv" | "money_cashflow" | "manpower";
  moseyM: "More" | "Metrics" | "Market" | "Model" | "Money" | "Manpower";
  moneySubType?: "leads" | "sales" | "ltv" | "cashflow";
  suggestion: string;
}

export interface ChannelPipeline {
  channel: "seo" | "linkedin" | "outbound" | "paid_ads";
  displayName: string;
  stages: FunnelStage[];
  constraint: ConstraintAnalysis | null;
}

export interface ChannelComparison {
  channel: string;
  leads: number;
  conversionPercent: number;
  demos: number;
  closePercent: number;
  paid: number;
  cac: number;
}

export interface FunnelMetricsResponse {
  channels: ChannelPipeline[];
  comparison: ChannelComparison[];
  aggregate: {
    totalLeads: number;
    totalPaid: number;
    netNewRevenue: {
      newCustomers: number;
      description: string;
    };
    netRetainedRevenue: {
      retainedCustomers: number;
      churnedCustomers: number;
      retentionRate: number;
      description: string;
    };
    overallConstraint: ConstraintAnalysis | null;
  };
  period: { start: string; end: string };
  generatedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────

// Founders account — has GSC, Meta Ads, CRM lead lists, ad account
const FOUNDER_USER_ID = "be754b6c-767e-44ec-b181-4042cfe45ea9";
// Harsha's account — has Gmail (Google Calendar), Fathom, Unipile connected
const HARSHA_USER_ID = "1743956381327";
const SEO_DOMAIN = "agentweb.pro";

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

/**
 * Build the Talked stage's source breakdown, propagating any classified
 * calendar error so the frontend can show an actionable banner (e.g. "Calendar
 * API is disabled — enable it in GCP console") instead of a misleading zero.
 *
 * Mirrors the classifications from prospectMeetingService.CalendarFetchError.
 */
function buildTalkedSources(meetingData: ProspectMeetingMetrics): SourceBreakdown[] {
  if (meetingData.calendarError) {
    const err = meetingData.calendarError;
    const message: Record<typeof err, string> = {
      service_disabled: "Google Calendar API is disabled in the GCP project — enable it at console.cloud.google.com.",
      scope_not_granted: "Calendar scope was not granted on the Gmail connection — reconnect Gmail and accept calendar access.",
      insufficient_permissions: "Google token is missing calendar.readonly — reconnect Gmail to re-prompt for calendar permission.",
      quota_exceeded: "Google Calendar API quota exceeded — retry after the rate limit resets.",
      forbidden_unknown: "Google Calendar returned 403 with an unrecognized reason. Check CloudWatch for details.",
      unknown: "Google Calendar fetch failed for a non-403 reason. Check CloudWatch for details.",
    } as const;
    return [errorSource("Google Calendar", message[err])];
  }

  // Build expandable detail from de-duped prospects
  const details: SourceDetail[] = (meetingData.prospects || []).map(p => {
    const latestMeeting = p.meetings.find(m => m.recordingUrl);
    return {
      label: `${p.domain} — ${p.contacts[0]?.split('@')[0] || 'unknown'}`,
      count: p.meetingCount,
      talkedCount: p.talkedCount,
      lastDate: p.lastMeetingDate,
      contacts: p.contacts,
      ...(latestMeeting?.recordingUrl && { recordingUrl: latestMeeting.recordingUrl }),
    };
  });

  return [{
    name: "Google Calendar + Fathom",
    count: meetingData.uniqueProspectsTalked ?? meetingData.totalMeetings,
    status: "ok" as const,
    details,
  }];
}

function makeStage(
  name: string,
  count: number,
  previousCount: number,
  prevStageCount: number,
  sources: SourceBreakdown[],
): FunnelStage {
  const hasOk = sources.some(s => s.status === "ok");
  const allUnavailable = sources.every(s => s.status === "unavailable");
  const hasError = sources.some(s => s.status === "error");

  let status: "ok" | "unavailable" | "error";
  if (allUnavailable) {
    status = "unavailable";
  } else if (hasOk) {
    status = "ok";
  } else {
    status = hasError ? "error" : "unavailable";
  }

  return {
    name,
    count,
    previousCount,
    conversionRate: prevStageCount > 0 ? parseFloat(((count / prevStageCount) * 100).toFixed(2)) : 0,
    sources,
    status,
  };
}

// ─── Constraint Classification (Hormozi "Mosey 6" Framework) ────────────
//
// The 6 M's checked in order — exit at the first one that's the constraint:
// 1. More — Can you just do more of what works?
// 2. Metrics — Do you have the data?
// 3. Market — Is the market big enough? (almost always yes)
// 4. Model — Is the business model right for your goals?
// 5. Money — Can you afford to grow? (leads/sales/ltv/cashflow)
// 6. Manpower — Do you have the people?

function classifyConstraint(stages: FunnelStage[]): ConstraintAnalysis | null {
  const okStages = stages.filter(s => s.status === "ok");
  const unavailableCount = stages.filter(s => s.status === "unavailable").length;

  // ── M1: MORE ──
  // If top-of-funnel count is low, you just need to do more volume.
  // "If you can double your company doing one thing, why do three?"
  const topStage = stages.find(s => s.status === "ok");
  if (topStage && topStage.count < 1000 && topStage.count > 0) {
    return {
      stage: topStage.name,
      conversionRate: 0,
      type: "more",
      moseyM: "More",
      suggestion: `Only ${topStage.count.toLocaleString()} ${topStage.name.toLowerCase()}. Can you just do more? More is the highest risk-adjusted return. Do more of what's already working before trying to optimize.`,
    };
  }

  // ── M2: METRICS ──
  // If you can't see your numbers, that's the constraint.
  // "If you can't do more because you don't know your numbers, knowing your numbers becomes priority #1."
  if (unavailableCount >= 3) {
    return {
      stage: "tracking",
      conversionRate: 0,
      type: "metrics",
      moseyM: "Metrics",
      suggestion: `${unavailableCount} of ${stages.length} stages have no data. You can't grow what you can't measure. Connect your data sources first — that's your #1 priority.`,
    };
  }

  // ── M3: MARKET — Skip (SaaS with global reach, market is never too small) ──

  // ── M4: MODEL — Skip (checked at business level, not per-channel) ──

  // ── M5: MONEY ──
  // Find the worst conversion rate and classify which Money sub-constraint it is.
  // "Is it because leads cost too much, sales close rate too low, LTV too low, or cash flow too slow?"
  let worstStage: FunnelStage | null = null;
  let worstRate = Infinity;

  for (const stage of okStages) {
    // Skip the first stage (top of funnel has no conversion from a previous stage)
    if (stages.indexOf(stage) === 0) continue;
    if (stage.conversionRate <= 0) continue;
    if (stage.conversionRate < worstRate) {
      worstRate = stage.conversionRate;
      worstStage = stage;
    }
  }

  if (!worstStage) return null;

  const stageIndex = stages.indexOf(worstStage);
  const totalStages = stages.length;
  const position = stageIndex / totalStages;

  // Map funnel position to Money sub-type
  let type: ConstraintAnalysis["type"];
  let moneySubType: ConstraintAnalysis["moneySubType"];
  let suggestion: string;

  if (position <= 0.3) {
    // Top of funnel: leads too expensive / not enough clicks
    type = "money_leads";
    moneySubType = "leads";
    suggestion = `${worstStage.name} conversion is ${worstRate.toFixed(1)}%. Your leads cost too much or you're not getting enough. Improve ad creative, hooks, landing pages, or lead magnets.`;
  } else if (position <= 0.55) {
    // Mid funnel: sales/conversion problem
    type = "money_sales";
    moneySubType = "sales";
    suggestion = `${worstStage.name} conversion is ${worstRate.toFixed(1)}%. You're not closing enough. Add a VSSL before sales calls, improve lead nurture, add proof, or train your sales process.`;
  } else if (position <= 0.8) {
    // Lower funnel: LTV problem (active/paid)
    type = "money_ltv";
    moneySubType = "ltv";
    suggestion = `${worstStage.name} conversion is ${worstRate.toFixed(1)}%. You're not making enough per customer. Improve onboarding, raise prices, add upsells, or increase delivery quality.`;
  } else {
    // Bottom: retention/churn = also LTV
    type = "money_ltv";
    moneySubType = "ltv";
    suggestion = `${worstStage.name} conversion is ${worstRate.toFixed(1)}%. Customers aren't staying. This is a retention problem — fix delivery, add long-term stickiness, or build compounding vehicles.`;
  }

  return {
    stage: worstStage.name,
    conversionRate: worstRate,
    type,
    moseyM: "Money",
    moneySubType,
    suggestion,
  };
}

// ─── Data Fetchers ──────────────────────────────────────────────────────

interface GSCData {
  impressions: number;
  clicks: number;
  status: "ok" | "error";
}

async function fetchGSCData(timeframe: string): Promise<GSCData> {
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

interface MetaAdsData {
  impressions: number;
  clicks: number;
  leads: number;
  spend: number;
  status: "ok" | "error" | "unavailable";
}

async function fetchMetaAdsData(timeframe: string): Promise<MetaAdsData> {
  try {
    const metaAccount = await getAccountByPlatform(FOUNDER_USER_ID, "meta");
    if (!metaAccount) {
      return { impressions: 0, clicks: 0, leads: 0, spend: 0, status: "unavailable" };
    }

    const accessToken = (metaAccount.config as any)?.access_token;
    if (!accessToken) {
      return { impressions: 0, clicks: 0, leads: 0, spend: 0, status: "unavailable" };
    }

    const user = await userDb.getUserById(FOUNDER_USER_ID);
    const adAccountId = user?.adAccount;
    if (!adAccountId) {
      return { impressions: 0, clicks: 0, leads: 0, spend: 0, status: "unavailable" };
    }

    const metaService = MetaService.getInstance();
    const insights = await metaService.getInsights(adAccountId, accessToken, {
      timeframe,
      level: "account",
    });

    if (!insights || !Array.isArray(insights) || insights.length === 0) {
      return { impressions: 0, clicks: 0, leads: 0, spend: 0, status: "ok" };
    }

    let impressions = 0;
    let clicks = 0;
    let leads = 0;
    let spend = 0;
    for (const row of insights) {
      impressions += parseInt(row.impressions || "0", 10);
      clicks += parseInt(row.clicks || "0", 10);
      spend += parseFloat(row.spend || "0");

      // Extract lead actions from the actions array if present
      if (Array.isArray(row.actions)) {
        for (const action of row.actions) {
          if (
            action.action_type === "lead" ||
            action.action_type === "offsite_conversion.fb_pixel_lead" ||
            action.action_type === "onsite_conversion.lead_grouped"
          ) {
            leads += parseInt(action.value || "0", 10);
          }
        }
      }
    }

    return { impressions, clicks, leads, spend, status: "ok" };
  } catch (error: any) {
    console.error("[BusinessFunnelService] Meta Ads fetch error:", error.message);
    return { impressions: 0, clicks: 0, leads: 0, spend: 0, status: "error" };
  }
}

interface LeadData {
  total: number;
  thisMonth: number;
  status: "ok" | "error";
}

async function fetchLeadCount(periodStart: Date): Promise<LeadData> {
  try {
    const leadLists = await crmDb.getLeadListsByUserId(FOUNDER_USER_ID);
    let total = 0;
    let thisMonth = 0;

    for (const list of leadLists) {
      let lastKey: any = null;
      do {
        const result = await crmDb.getLeadsByListId(list.listId, 100, lastKey);
        total += result.items.length;

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
  previousPeriodEnd: Date,
): Promise<{ data: UserCounts; previousData: UserCounts; status: "ok" | "error" }> {
  try {
    const allUsers = await userDb.scanWithFilter("attribute_exists(userId)", {});

    const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

    let totalUsers = allUsers.length;
    let newUsers = 0;
    let prevNewUsers = 0;
    let paidUsers = 0;
    let activeUsers = 0;
    let retainedUsers = 0;
    let churnedUsers = 0;

    for (const user of allUsers) {
      const createdAt = user.createdAt ? new Date(user.createdAt) : null;

      if (createdAt && createdAt >= periodStart) {
        newUsers++;
      }
      if (createdAt && createdAt >= previousPeriodStart && createdAt < previousPeriodEnd) {
        prevNewUsers++;
      }

      const subStatus = user.subscription_status;
      if (subStatus === "active" || subStatus === "trialing") {
        paidUsers++;
        if (createdAt && createdAt < periodStart) {
          retainedUsers++;
        }
      }

      if (subStatus === "canceled" || subStatus === "canceling") {
        churnedUsers++;
      }

      // Prefer lastActiveAt (set on session creation, non-delegated) over token usage for active user count.
      // lastActiveAt is more accurate — it reflects real user interactions regardless of token consumption.
      // Fall back to tokenUsage for users who were active before lastActiveAt was introduced.
      const lastActive = user.lastActiveAt || (user.tokenUsage?.month === currentMonth && user.tokenUsage?.totalTokens > 0 ? new Date().toISOString() : null);
      if (lastActive && new Date(lastActive) >= periodStart) {
        activeUsers++;
      }
    }

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

// ─── Channel Pipeline Builders ──────────────────────────────────────────

function buildSEOPipeline(
  gscData: GSCData,
  userData: { data: UserCounts; previousData: UserCounts; status: "ok" | "error" },
): ChannelPipeline {
  const stages: FunnelStage[] = [];

  // 1. Impressions
  const impressionsSources = gscData.status === "ok"
    ? [safeSource("Google Search Console", gscData.impressions)]
    : [errorSource("Google Search Console", "Failed to fetch GSC data")];
  stages.push(makeStage("Impressions", gscData.impressions, 0, 0, impressionsSources));
  // First stage: force conversionRate to 100
  stages[0].conversionRate = 100;

  // 2. Clicks
  const clicksSources = gscData.status === "ok"
    ? [safeSource("Google Search Console", gscData.clicks)]
    : [errorSource("Google Search Console", "Failed to fetch GSC data")];
  stages.push(makeStage("Clicks", gscData.clicks, 0, gscData.impressions, clicksSources));

  // 3. Signups (proxy: total new signups — no UTM tracking yet)
  const signupSources = userData.status === "ok"
    ? [safeSource("User Signups (all channels)", userData.data.newUsers)]
    : [errorSource("User Signups", "Failed to fetch user data")];
  stages.push(makeStage("Signups", userData.data.newUsers, userData.previousData.newUsers, gscData.clicks, signupSources));

  // 4. Active
  const activeSources = userData.status === "ok"
    ? [safeSource("Token Usage (current month)", userData.data.activeUsers)]
    : [errorSource("Token Usage", "Failed to fetch usage data")];
  stages.push(makeStage("Active", userData.data.activeUsers, userData.previousData.activeUsers, userData.data.newUsers, activeSources));

  // 5. Paid
  const paidSources = userData.status === "ok"
    ? [safeSource("Stripe (active/trialing)", userData.data.paidUsers)]
    : [errorSource("Stripe", "Failed to fetch subscription data")];
  stages.push(makeStage("Paid", userData.data.paidUsers, userData.previousData.paidUsers, userData.data.activeUsers, paidSources));

  // 6. Retained
  const retainedSources = userData.status === "ok"
    ? [safeSource("Stripe (month 2+ subscribers)", userData.data.retainedUsers)]
    : [errorSource("Stripe", "Failed to fetch retention data")];
  stages.push(makeStage("Retained", userData.data.retainedUsers, userData.previousData.retainedUsers, userData.data.paidUsers, retainedSources));

  return {
    channel: "seo",
    displayName: "SEO",
    stages,
    constraint: classifyConstraint(stages),
  };
}

function buildLinkedInPipeline(
  meetingData: ProspectMeetingMetrics,
  userData: { data: UserCounts; status: "ok" | "error" },
): ChannelPipeline {
  const stages: FunnelStage[] = [];

  // 1. Post Impressions — unavailable
  stages.push(makeStage("Post Impressions", 0, 0, 0, [unavailableSource("LinkedIn Analytics (not connected)")]));
  stages[0].conversionRate = 100;

  // 2. Engagement — unavailable
  stages.push(makeStage("Engagement", 0, 0, 0, [unavailableSource("LinkedIn Analytics (not connected)")]));

  // 3. Profile/Link Clicks — unavailable
  stages.push(makeStage("Profile/Link Clicks", 0, 0, 0, [unavailableSource("LinkedIn Analytics (not connected)")]));

  // 4. Identified — unavailable (leads from LinkedIn)
  stages.push(makeStage("Identified", 0, 0, 0, [unavailableSource("LinkedIn Lead Tracking (not connected)")]));

  // 5. Talked — use prospect meeting service. When the calendar fetch failed
  // (e.g. 403 SERVICE_DISABLED), buildTalkedSources surfaces the classified
  // reason as an errorSource so the funnel doesn't lie with a zero.
  const talkedSources = buildTalkedSources(meetingData);
  stages.push(makeStage("Talked", meetingData.uniqueProspectsTalked ?? meetingData.totalMeetings, meetingData.previousPeriodMeetings, 0, talkedSources));

  // 6. Paid
  const paidSources = userData.status === "ok"
    ? [safeSource("Stripe (active/trialing)", userData.data.paidUsers)]
    : [errorSource("Stripe", "Failed to fetch subscription data")];
  stages.push(makeStage("Paid", userData.data.paidUsers, 0, meetingData.totalMeetings, paidSources));

  // 7. Retained
  const retainedSources = userData.status === "ok"
    ? [safeSource("Stripe (month 2+ subscribers)", userData.data.retainedUsers)]
    : [errorSource("Stripe", "Failed to fetch subscription data")];
  stages.push(makeStage("Retained", userData.data.retainedUsers, 0, userData.data.paidUsers, retainedSources));

  return {
    channel: "linkedin",
    displayName: "LinkedIn",
    stages,
    constraint: classifyConstraint(stages),
  };
}

function buildOutboundPipeline(
  leadData: LeadData,
  smartLeadData: SmartLeadMetrics,
  unipileData: UnipileOutreachMetrics,
  meetingData: ProspectMeetingMetrics,
  userData: { data: UserCounts; status: "ok" | "error" },
): ChannelPipeline {
  const stages: FunnelStage[] = [];

  // 1. List Size — SmartLead total leads loaded (fallback to CRM lead lists)
  const listSources: SourceBreakdown[] = [];
  let listSize = 0;

  if (smartLeadData.status === "ok") {
    listSources.push(safeSource("SmartLead Campaigns", smartLeadData.totalLeadsLoaded));
    listSize += smartLeadData.totalLeadsLoaded;
  } else if (smartLeadData.status === "error") {
    listSources.push(errorSource("SmartLead", smartLeadData.error || "Failed to fetch SmartLead data"));
  } else {
    listSources.push(unavailableSource("SmartLead (not configured)"));
  }

  // Also include CRM lead lists as a secondary source
  if (leadData.status === "ok" && leadData.total > 0) {
    listSources.push(safeSource("CRM Lead Lists", leadData.total));
    listSize += leadData.total;
  }

  // Include Unipile LinkedIn targets in list size
  // Connection requests = new strangers targeted
  // DMs sent = total people contacted (includes existing connections)
  // Show both separately so you can see the breakdown
  if (unipileData.status === "ok") {
    if (unipileData.accountBreakdown && unipileData.accountBreakdown.length > 0) {
      for (const acct of unipileData.accountBreakdown) {
        if (acct.connectionRequestsSent > 0) {
          listSources.push(safeSource(`LinkedIn requests — ${acct.accountName.split(' ')[0]}`, acct.connectionRequestsSent));
          listSize += acct.connectionRequestsSent;
        }
        // DMs to existing connections (people messaged who didn't need a connection request)
        const existingConnectionDMs = Math.max(0, acct.messagesSent - acct.connectionRequestsSent);
        if (existingConnectionDMs > 0) {
          listSources.push(safeSource(`LinkedIn existing — ${acct.accountName.split(' ')[0]}`, existingConnectionDMs));
          listSize += existingConnectionDMs;
        }
      }
    } else {
      if (unipileData.totalConnectionRequests > 0) {
        listSources.push(safeSource("LinkedIn connection requests", unipileData.totalConnectionRequests));
        listSize += unipileData.totalConnectionRequests;
      }
      const existingDMs = Math.max(0, unipileData.totalMessagesSent - unipileData.totalConnectionRequests);
      if (existingDMs > 0) {
        listSources.push(safeSource("LinkedIn existing connections DMed", existingDMs));
        listSize += existingDMs;
      }
    }
  }

  stages.push(makeStage("List Size", listSize, 0, 0, listSources));
  stages[0].conversionRate = 100;

  // 2. Contacted — SmartLead leads in progress + completed (emails sent) + Unipile LinkedIn messages
  const smartLeadContacted = smartLeadData.status === "ok"
    ? smartLeadData.leadsInProgress + smartLeadData.leadsCompleted + smartLeadData.leadsReplied
    : 0;
  const unipileContacted = unipileData.status === "ok" ? unipileData.totalMessagesSent : 0;
  const contactedCount = smartLeadContacted + unipileContacted;

  const contactedSources: SourceBreakdown[] = [];
  if (smartLeadData.status === "ok") {
    contactedSources.push(safeSource("SmartLead (emails sent)", smartLeadContacted));
  } else if (smartLeadData.status === "error") {
    contactedSources.push(errorSource("SmartLead", smartLeadData.error || "Failed to fetch SmartLead data"));
  } else {
    contactedSources.push(unavailableSource("SmartLead (not configured)"));
  }

  if (unipileData.status === "ok") {
    // Show per-person breakdown
    if (unipileData.accountBreakdown && unipileData.accountBreakdown.length > 0) {
      for (const acct of unipileData.accountBreakdown) {
        if (acct.messagesSent > 0) {
          contactedSources.push(safeSource(`LinkedIn — ${acct.accountName.split(' ')[0]}`, acct.messagesSent));
        }
      }
      // If no one sent anything, still show aggregate
      if (!unipileData.accountBreakdown.some(a => a.messagesSent > 0)) {
        contactedSources.push(safeSource("Unipile LinkedIn (messages sent)", 0));
      }
    } else {
      contactedSources.push(safeSource("Unipile LinkedIn (messages sent)", unipileContacted));
    }
  } else if (unipileData.status === "error") {
    contactedSources.push(errorSource("Unipile LinkedIn", unipileData.error || "Failed to fetch Unipile data"));
  } else {
    contactedSources.push(unavailableSource("Unipile LinkedIn (not connected)"));
  }

  stages.push(makeStage("Contacted", contactedCount, 0, listSize, contactedSources));

  // 3. Replies — SmartLead leads that replied + Unipile LinkedIn replies received
  const smartLeadReplied = smartLeadData.status === "ok" ? smartLeadData.leadsReplied : 0;
  const unipileReplied = unipileData.status === "ok" ? unipileData.totalRepliesReceived : 0;
  const repliedCount = smartLeadReplied + unipileReplied;

  const repliesSources: SourceBreakdown[] = [];
  if (smartLeadData.status === "ok") {
    repliesSources.push(safeSource("SmartLead (replies)", smartLeadReplied));
  } else if (smartLeadData.status === "error") {
    repliesSources.push(errorSource("SmartLead", smartLeadData.error || "Failed to fetch SmartLead data"));
  } else {
    repliesSources.push(unavailableSource("SmartLead (not configured)"));
  }

  if (unipileData.status === "ok") {
    // Show per-person breakdown for replies too
    if (unipileData.accountBreakdown && unipileData.accountBreakdown.length > 0) {
      for (const acct of unipileData.accountBreakdown) {
        if (acct.repliesReceived > 0) {
          repliesSources.push(safeSource(`LinkedIn replies — ${acct.accountName.split(' ')[0]}`, acct.repliesReceived));
        }
      }
      if (!unipileData.accountBreakdown.some(a => a.repliesReceived > 0)) {
        repliesSources.push(safeSource("Unipile LinkedIn (replies received)", 0));
      }
    } else {
      repliesSources.push(safeSource("Unipile LinkedIn (replies received)", unipileReplied));
    }
  } else if (unipileData.status === "error") {
    repliesSources.push(errorSource("Unipile LinkedIn", unipileData.error || "Failed to fetch Unipile data"));
  } else {
    repliesSources.push(unavailableSource("Unipile LinkedIn (not connected)"));
  }

  stages.push(makeStage("Replies", repliedCount, 0, contactedCount, repliesSources));

  // 4. Talked — prospect meetings. Uses classified calendar error from
  // prospectMeetingService so a SERVICE_DISABLED is visible, not a silent zero.
  const talkedSources = buildTalkedSources(meetingData);
  stages.push(makeStage("Talked", meetingData.uniqueProspectsTalked ?? meetingData.totalMeetings, meetingData.previousPeriodMeetings, repliedCount, talkedSources));

  // 5. Paid
  const paidSources = userData.status === "ok"
    ? [safeSource("Stripe (active/trialing)", userData.data.paidUsers)]
    : [errorSource("Stripe", "Failed to fetch subscription data")];
  stages.push(makeStage("Paid", userData.data.paidUsers, 0, meetingData.totalMeetings, paidSources));

  // 6. Retained
  const retainedSources = userData.status === "ok"
    ? [safeSource("Stripe (month 2+ subscribers)", userData.data.retainedUsers)]
    : [errorSource("Stripe", "Failed to fetch subscription data")];
  stages.push(makeStage("Retained", userData.data.retainedUsers, 0, userData.data.paidUsers, retainedSources));

  return {
    channel: "outbound",
    displayName: "Outbound",
    stages,
    constraint: classifyConstraint(stages),
  };
}

function buildPaidAdsPipeline(
  metaData: MetaAdsData,
  meetingData: ProspectMeetingMetrics,
  userData: { data: UserCounts; status: "ok" | "error" },
): ChannelPipeline {
  const stages: FunnelStage[] = [];

  // 1. Impressions
  const impressionsSources = metaData.status === "ok"
    ? [safeSource("Meta Ads", metaData.impressions)]
    : metaData.status === "unavailable"
      ? [unavailableSource("Meta Ads (not connected)")]
      : [errorSource("Meta Ads", "Failed to fetch Meta Ads data")];
  stages.push(makeStage("Impressions", metaData.impressions, 0, 0, impressionsSources));
  stages[0].conversionRate = 100;

  // 2. Clicks
  const clicksSources = metaData.status === "ok"
    ? [safeSource("Meta Ads", metaData.clicks)]
    : metaData.status === "unavailable"
      ? [unavailableSource("Meta Ads (not connected)")]
      : [errorSource("Meta Ads", "Failed to fetch Meta Ads data")];
  stages.push(makeStage("Clicks", metaData.clicks, 0, metaData.impressions, clicksSources));

  // 3. Leads (form submissions / lead actions from Meta)
  const leadsSources = metaData.status === "ok"
    ? [safeSource("Meta Ads (lead actions)", metaData.leads)]
    : metaData.status === "unavailable"
      ? [unavailableSource("Meta Ads (not connected)")]
      : [errorSource("Meta Ads", "Failed to fetch Meta Ads data")];
  stages.push(makeStage("Leads", metaData.leads, 0, metaData.clicks, leadsSources));

  // 4. Talked — prospect meetings. Uses classified calendar error from
  // prospectMeetingService so a SERVICE_DISABLED is visible, not a silent zero.
  const talkedSources = buildTalkedSources(meetingData);
  stages.push(makeStage("Talked", meetingData.uniqueProspectsTalked ?? meetingData.totalMeetings, meetingData.previousPeriodMeetings, metaData.leads, talkedSources));

  // 5. Paid
  const paidSources = userData.status === "ok"
    ? [safeSource("Stripe (active/trialing)", userData.data.paidUsers)]
    : [errorSource("Stripe", "Failed to fetch subscription data")];
  stages.push(makeStage("Paid", userData.data.paidUsers, 0, meetingData.totalMeetings, paidSources));

  // 6. Retained
  const retainedSources = userData.status === "ok"
    ? [safeSource("Stripe (month 2+ subscribers)", userData.data.retainedUsers)]
    : [errorSource("Stripe", "Failed to fetch subscription data")];
  stages.push(makeStage("Retained", userData.data.retainedUsers, 0, userData.data.paidUsers, retainedSources));

  return {
    channel: "paid_ads",
    displayName: "Paid Ads",
    stages,
    constraint: classifyConstraint(stages),
  };
}

// ─── Comparison Table ───────────────────────────────────────────────────

function buildComparison(channels: ChannelPipeline[], metaSpend: number): ChannelComparison[] {
  return channels.map(ch => {
    // Find key stages by name
    const leadsStage = ch.stages.find(s =>
      s.name === "Signups" || s.name === "Identified" || s.name === "Leads" || s.name === "List Size"
    );
    const demosStage = ch.stages.find(s => s.name === "Talked");
    const paidStage = ch.stages.find(s => s.name === "Paid");

    const leads = leadsStage?.count || 0;
    const demos = demosStage?.count || 0;
    const paid = paidStage?.count || 0;

    // Estimate CAC per channel
    let cac = 0;
    if (ch.channel === "paid_ads" && paid > 0) {
      cac = Math.round(metaSpend / paid);
    }
    // SEO, LinkedIn, Outbound: CAC is $0 (organic/time-based, not ad spend tracked)

    return {
      channel: ch.displayName,
      leads,
      conversionPercent: leads > 0 ? parseFloat(((demos / leads) * 100).toFixed(1)) : 0,
      demos,
      closePercent: demos > 0 ? parseFloat(((paid / demos) * 100).toFixed(1)) : 0,
      paid,
      cac,
    };
  });
}

// ─── Main Aggregator ────────────────────────────────────────────────────

// ─── Response Cache (5 min TTL) ─────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const responseCache = new Map<string, { data: FunnelMetricsResponse; timestamp: number }>();

export async function getBusinessFunnelMetrics(
  period: string = "30d",
  _channel?: string,
): Promise<FunnelMetricsResponse> {
  // Check cache
  const cacheKey = `funnel_${period}`;
  const cached = responseCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const days = parsePeriodDays(period);
  const timeframe = `${days}d`;
  const dateRange = getDateRange(days);
  const previousRange = getPreviousDateRange(days);

  // Fetch all data sources in parallel
  const [gscData, metaData, leadData, userData, meetingData, smartLeadData, unipileData] = await Promise.all([
    fetchGSCData(timeframe),
    fetchMetaAdsData(timeframe),
    fetchLeadCount(dateRange.start),
    fetchUserAndSubscriptionData(dateRange.start, previousRange.start, previousRange.end),
    getProspectMeetingMetrics(period),
    getSmartLeadMetrics(),
    getUnipileOutreachMetrics(period),
  ]);

  // Build per-channel pipelines
  const seoPipeline = buildSEOPipeline(gscData, userData);
  const linkedInPipeline = buildLinkedInPipeline(meetingData, { data: userData.data, status: userData.status });
  const outboundPipeline = buildOutboundPipeline(leadData, smartLeadData, unipileData, meetingData, { data: userData.data, status: userData.status });
  const paidAdsPipeline = buildPaidAdsPipeline(metaData, meetingData, { data: userData.data, status: userData.status });

  const channels: ChannelPipeline[] = [seoPipeline, linkedInPipeline, outboundPipeline, paidAdsPipeline];

  // Build comparison table
  const comparison = buildComparison(channels, metaData.spend);

  // Aggregate metrics
  const totalLeads = comparison.reduce((sum, c) => sum + c.leads, 0);
  const totalPaid = userData.data.paidUsers;

  // Net New vs Net Retained Revenue
  const netNewRevenue = {
    newCustomers: userData.data.newUsers,
    description: `${userData.data.newUsers} new signups this period`,
  };
  const netRetainedRevenue = {
    retainedCustomers: userData.data.retainedUsers,
    churnedCustomers: userData.data.churnedUsers || 0,
    retentionRate: userData.data.paidUsers > 0
      ? parseFloat(((userData.data.retainedUsers / (userData.data.retainedUsers + (userData.data.churnedUsers || 0))) * 100).toFixed(1))
      : 0,
    description: `${userData.data.retainedUsers} retained, ${userData.data.churnedUsers || 0} churned`,
  };

  // Overall constraint: pick the worst constraint across channels with real data
  const channelsWithData = channels.filter(ch =>
    ch.stages.some(s => s.status === "ok" && s.count > 0),
  );
  const overallConstraint = channelsWithData.length > 0
    ? channelsWithData[0].constraint
    : classifyConstraint([
        ...seoPipeline.stages,
        ...paidAdsPipeline.stages,
      ]);

  const result: FunnelMetricsResponse = {
    channels,
    comparison,
    aggregate: {
      totalLeads,
      totalPaid,
      netNewRevenue,
      netRetainedRevenue,
      overallConstraint,
    },
    period: {
      start: dateRange.startStr,
      end: dateRange.endStr,
    },
    generatedAt: new Date().toISOString(),
  };

  // Cache the response for 5 minutes
  responseCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
}
