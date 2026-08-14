import { userDb } from "./db";
import { resolveAnalyticsConfig, ResolvedAnalyticsConfig } from "./analyticsConfigResolver";
import { getSecret } from "../utils/secretsManager";
import { JWT } from "google-auth-library";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

const pageSpeedStrategy = "mobile";

export async function getGoogleSearchConsoleAccessToken(): Promise<string | null> {
  try {
    const secretName = process.env.NODE_ENV === "production"
      ? "prod/AgentWeb/Google/SearchConsole"
      : "dev/AgentWeb/Google/SearchConsole";

    const serviceAccountJson = await getSecret(secretName);
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (!serviceAccount.private_key || !serviceAccount.client_email) {
      console.error("Service account JSON missing required fields (private_key or client_email)");
      return null;
    }

    const client = new JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });

    const accessToken = await client.getAccessToken();
    return accessToken.token || null;
  } catch (error: any) {
    console.error("Error fetching Google Search Console access token:", error);
    return null;
  }
}

/** Returns the shared Google service-account email users must grant access to. */
export async function getServiceAccountEmail(): Promise<string | null> {
  try {
    const secretName = process.env.NODE_ENV === "production"
      ? "prod/AgentWeb/Google/SearchConsole"
      : "dev/AgentWeb/Google/SearchConsole";
    const serviceAccount = JSON.parse(await getSecret(secretName));
    return serviceAccount.client_email || null;
  } catch (error: any) {
    console.error("Error fetching service account email:", error.message);
    return null;
  }
}

/**
 * Probe a GA4 property with the shared service account. Used by the
 * "Test connection" button so users see permission problems immediately.
 */
export async function testGaProperty(
  propertyId: string,
): Promise<{ ok: boolean; reason?: string; message?: string }> {
  const client = await getGoogleAnalyticsDataClient();
  if (!client) return { ok: false, reason: "error", message: "GA client unavailable" };
  try {
    await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: "yesterday", endDate: "today" }],
      metrics: [{ name: "sessions" }],
      limit: 1,
    });
    return { ok: true };
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (e?.code === 7 || /PERMISSION_DENIED/i.test(msg)) return { ok: false, reason: "permission_denied", message: msg };
    if (e?.code === 5 || e?.code === 3 || /NOT_FOUND|INVALID_ARGUMENT/i.test(msg)) {
      return { ok: false, reason: "not_found", message: msg };
    }
    return { ok: false, reason: "error", message: msg };
  }
}

export async function getGoogleAnalyticsDataClient(): Promise<BetaAnalyticsDataClient | null> {
  try {
    const secretName = process.env.NODE_ENV === "production"
      ? "prod/AgentWeb/Google/SearchConsole"
      : "dev/AgentWeb/Google/SearchConsole";

    const serviceAccountJson = await getSecret(secretName);
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (!serviceAccount.private_key || !serviceAccount.client_email) {
      console.error("Service account JSON missing required fields (private_key or client_email)");
      return null;
    }

    const client = new BetaAnalyticsDataClient({
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      },
    });

    return client;
  } catch (error: any) {
    console.error("Error creating Google Analytics Data client:", error);
    return null;
  }
}

export async function getPageSpeedApiKey(): Promise<string | null> {
  try {
    const secretName = process.env.NODE_ENV === "production"
      ? "prod/AgentWeb/Google/PageSpeed"
      : "dev/AgentWeb/Google/PageSpeed";
    const secretString = await getSecret(secretName);
    const trimmed = secretString.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const apiKey = parsed?.apiKey;
      return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : null;
    } catch (parseError) {
      return trimmed;
    }
  } catch (error) {
    console.error("Error fetching PageSpeed API key:", error);
    return null;
  }
}

function buildPageSpeedUrl(domain: string): string {
  if (!domain) {
    return "";
  }
  if (domain.startsWith("http://") || domain.startsWith("https://")) {
    return domain;
  }
  return `https://${domain}`;
}

export async function getTechnicalSeoScore(domain: string): Promise<number | null> {
  const pageSpeedApiKey = await getPageSpeedApiKey();
  if (!pageSpeedApiKey) {
    return null;
  }

  const targetUrl = buildPageSpeedUrl(domain);
  if (!targetUrl) {
    return null;
  }

  try {
    const pageSpeedUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(targetUrl)}&category=seo&strategy=${encodeURIComponent(pageSpeedStrategy)}&key=${encodeURIComponent(pageSpeedApiKey)}`;
    const response = await fetch(pageSpeedUrl);

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      console.error("PageSpeed Insights API error:", errorData || response.statusText);
      return null;
    }

    const data = await response.json();
    const score = data?.lighthouseResult?.categories?.seo?.score;
    if (typeof score !== "number") {
      return null;
    }

    return Math.round(score * 100);
  } catch (error) {
    console.error("Error fetching PageSpeed Insights data:", error);
    return null;
  }
}

function calculateDateRange(timeframe: string): { startDateStr: string; endDateStr: string } {
  const now = new Date();
  const endDate = new Date(now);
  endDate.setUTCHours(0, 0, 0, 0);

  const startDate = new Date(endDate);

  if (timeframe === "7d") {
    startDate.setUTCDate(endDate.getUTCDate() - 7);
  } else if (timeframe === "14d") {
    startDate.setUTCDate(endDate.getUTCDate() - 14);
  } else if (timeframe === "30d") {
    startDate.setUTCDate(endDate.getUTCDate() - 30);
  } else if (timeframe === "90d") {
    startDate.setUTCDate(endDate.getUTCDate() - 90);
  } else {
    startDate.setUTCDate(endDate.getUTCDate() - 30);
  }
  startDate.setUTCHours(0, 0, 0, 0);

  return {
    startDateStr: startDate.toISOString().split("T")[0],
    endDateStr: endDate.toISOString().split("T")[0],
  };
}

function calculateGaDateRange(timeframe: string): { startDateStr: string; endDateStr: string } {
  const now = new Date();
  const endDate = new Date(now);
  endDate.setUTCHours(0, 0, 0, 0);

  const startDate = new Date(endDate);

  if (timeframe === "7d") {
    startDate.setUTCDate(endDate.getUTCDate() - 6);
  } else if (timeframe === "14d") {
    startDate.setUTCDate(endDate.getUTCDate() - 13);
  } else if (timeframe === "30d") {
    startDate.setUTCDate(endDate.getUTCDate() - 29);
  } else if (timeframe === "90d") {
    startDate.setUTCDate(endDate.getUTCDate() - 89);
  } else {
    startDate.setUTCDate(endDate.getUTCDate() - 29);
  }
  startDate.setUTCHours(0, 0, 0, 0);

  return {
    startDateStr: startDate.toISOString().split("T")[0],
    endDateStr: endDate.toISOString().split("T")[0],
  };
}

export async function fetchSearchConsoleMetrics(userId: string, timeframe: string = "30d", filterDomain?: string, resolvedConfig?: ResolvedAnalyticsConfig): Promise<any> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return { error: "User not found" };
  }

  const resolved = resolvedConfig ?? (await resolveAnalyticsConfig(user));
  if (!resolved.seoDomains || resolved.seoDomains.length === 0) {
    return { message: "Google Search Console is not configured. This is a self-serve setup, not a product bug — do not file a product issue. Guide the user to connect it in Settings → Analytics & SEO (/settings/analytics-seo): (1) in Google Search Console, open Settings → Users and permissions and add the AgentWeb service account email (shown on that page) with \"Full\" permission; (2) back in AgentWeb, add their domain (e.g. example.com, or https://example.com/ for a URL-prefix property) under \"SEO Domains\" and save. (If they belong to an organization and can't see that page, their org owner or an analytics editor must set it up.) You can use the search_user_guide tool for more detail." };
  }

  const accessToken = await getGoogleSearchConsoleAccessToken();
  if (!accessToken) {
    return { error: "Google Search Console API not configured. Please contact support." };
  }

  const { startDateStr, endDateStr } = calculateDateRange(timeframe);

  // Filter to a specific domain if requested
  let domainsToFetch = resolved.seoDomains as string[];
  if (filterDomain) {
    domainsToFetch = domainsToFetch.filter((d: string) => d.toLowerCase().includes(filterDomain.toLowerCase()));
    if (domainsToFetch.length === 0) {
      return { error: `Domain "${filterDomain}" not found in configured domains: ${(resolved.seoDomains as string[]).join(', ')}` };
    }
  }

  const metricsPromises = domainsToFetch.map(async (domain: string) => {
    try {
      console.log('[GSC Debug] Raw domain from DB:', domain);
      console.log('[GSC Debug] domain.startsWith("http"):', domain.startsWith("http"));
      const siteUrl = domain.startsWith("http") ? domain : `sc-domain:${domain}`;
      console.log('[GSC Debug] Formatted siteUrl:', siteUrl);
      const searchAnalyticsUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

      // Fetch daily data
      const dailyDataResponse = await fetch(searchAnalyticsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: startDateStr,
          endDate: endDateStr,
          dimensions: ["date"],
          rowLimit: 25000,
        }),
      });

      let dailyData: Array<{ date: string; clicks: number; impressions: number }> = [];
      if (!dailyDataResponse.ok) {
        const errorData = await dailyDataResponse.json();
        console.error(`Error fetching daily data for ${domain}:`, errorData);
        return {
          domain,
          error: errorData.error?.message || "Failed to fetch daily search analytics",
          clicks: 0, impressions: 0, ctr: 0, position: 0,
          technicalSeoScore: null, dailyData: [], topQueries: [], topPages: [],
        };
      }

      const dailyDataResult = await dailyDataResponse.json();
      dailyData = (dailyDataResult.rows || [])
        .map((row: any) => ({
          date: row.keys?.[0] || "",
          clicks: row.clicks || 0,
          impressions: row.impressions || 0,
        }))
        .filter((item: any) => item.date)
        .sort((a: any, b: any) => a.date.localeCompare(b.date));

      // Fetch overall totals
      const overallResponse = await fetch(searchAnalyticsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: startDateStr,
          endDate: endDateStr,
        }),
      });

      let totalClicks = 0;
      let totalImpressions = 0;
      let avgPosition = 0;
      let avgCtr = 0;

      if (overallResponse.ok) {
        const overallData = await overallResponse.json();
        if (overallData.rows && overallData.rows.length > 0) {
          const overallRow = overallData.rows[0];
          totalClicks = overallRow.clicks || 0;
          totalImpressions = overallRow.impressions || 0;
          avgPosition = overallRow.position || 0;
          avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
        } else {
          totalClicks = dailyData.reduce((sum, day) => sum + day.clicks, 0);
          totalImpressions = dailyData.reduce((sum, day) => sum + day.impressions, 0);
          avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
        }
      } else {
        await overallResponse.json().catch(() => ({}));
        totalClicks = dailyData.reduce((sum, day) => sum + day.clicks, 0);
        totalImpressions = dailyData.reduce((sum, day) => sum + day.impressions, 0);
        avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
      }

      // Fetch top queries
      const queriesResponse = await fetch(searchAnalyticsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: startDateStr,
          endDate: endDateStr,
          dimensions: ["query"],
          rowLimit: 25000,
        }),
      });

      let topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number }> = [];
      let allQueriesData: any = null;
      if (queriesResponse.ok) {
        allQueriesData = await queriesResponse.json();
        topQueries = (allQueriesData.rows || [])
          .map((row: any) => ({
            query: row.keys?.[0] || "Unknown",
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
            ctr: row.impressions > 0 ? ((row.clicks || 0) / row.impressions) * 100 : 0,
            position: row.position || 0,
          }))
          .sort((a: { clicks: number }, b: { clicks: number }) => b.clicks - a.clicks)
          .slice(0, 10);
      }

      // Calculate weighted average position from queries if needed
      if (avgPosition === 0 && allQueriesData && allQueriesData.rows && allQueriesData.rows.length > 0) {
        let totalPositionWeighted = 0;
        let totalImpressionsForPosition = 0;
        allQueriesData.rows.forEach((row: any) => {
          const impressions = row.impressions || 0;
          const position = row.position || 0;
          if (impressions > 0 && position > 0) {
            totalPositionWeighted += position * impressions;
            totalImpressionsForPosition += impressions;
          }
        });
        if (totalImpressionsForPosition > 0) {
          avgPosition = totalPositionWeighted / totalImpressionsForPosition;
        }
      }

      // Fetch top pages
      const pagesResponse = await fetch(searchAnalyticsUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: startDateStr,
          endDate: endDateStr,
          dimensions: ["page"],
          rowLimit: 25000,
        }),
      });

      let topPages: Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number }> = [];
      if (pagesResponse.ok) {
        const pagesData = await pagesResponse.json();
        topPages = (pagesData.rows || [])
          .map((row: any) => ({
            page: row.keys?.[0] || "Unknown",
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
            ctr: row.impressions > 0 ? ((row.clicks || 0) / row.impressions) * 100 : 0,
            position: row.position || 0,
          }))
          .sort((a: { clicks: number }, b: { clicks: number }) => b.clicks - a.clicks)
          .slice(0, 10);
      }

      const technicalSeoScore = await getTechnicalSeoScore(domain);

      return {
        domain,
        clicks: totalClicks,
        impressions: totalImpressions,
        ctr: avgCtr,
        position: avgPosition,
        technicalSeoScore,
        dailyData,
        topQueries,
        topPages,
        dateRange: { startDate: startDateStr, endDate: endDateStr },
      };
    } catch (error: any) {
      console.error(`Error processing domain ${domain}:`, error);
      return {
        domain,
        error: error.message || "Failed to fetch metrics",
        clicks: 0, impressions: 0, ctr: 0, position: 0,
        technicalSeoScore: null, dailyData: [], topQueries: [], topPages: [],
      };
    }
  });

  const metrics = await Promise.all(metricsPromises);
  return {
    search_console_integration_status: "Google Search Console is configured and connected. If a domain shows 0 clicks/impressions, the site may not be indexed yet or had no search traffic in this period. Do NOT tell the user Search Console is not set up.",
    configured_domains: resolved.seoDomains,
    metrics,
    timeframe,
    timestamp: new Date().toISOString(),
  };
}

export async function fetchClarityProjectInfo(userId: string, filterProjectId?: string, resolvedConfig?: ResolvedAnalyticsConfig): Promise<any> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return { error: "User not found" };
  }

  const resolved = resolvedConfig ?? (await resolveAnalyticsConfig(user));
  const clarityProjects = resolved.clarityProjects;
  if (clarityProjects.length === 0) {
    return { message: "Microsoft Clarity is not configured. Use the search_user_guide tool to find setup instructions and share them with the user." };
  }

  let projectsToReturn = clarityProjects;
  if (filterProjectId) {
    projectsToReturn = clarityProjects.filter(p => p.projectId === filterProjectId);
    if (projectsToReturn.length === 0) {
      return { error: `Clarity project "${filterProjectId}" not found in configured projects: ${clarityProjects.map(p => `${p.label} (${p.projectId})`).join(', ')}` };
    }
  }

  return {
    projects: projectsToReturn.map(p => ({
      projectId: p.projectId,
      label: p.label,
      dashboardUrl: `https://clarity.microsoft.com/projects/view/${p.projectId}/dashboard`,
      recordingsUrl: `https://clarity.microsoft.com/projects/view/${p.projectId}/recordings`,
      heatmapsUrl: `https://clarity.microsoft.com/projects/view/${p.projectId}/heatmaps`,
    })),
    timestamp: new Date().toISOString(),
  };
}

export async function fetchGoogleAnalyticsMetrics(userId: string, timeframe: string = "30d", filterPropertyId?: string, resolvedConfig?: ResolvedAnalyticsConfig): Promise<any> {
  const user = await userDb.getUserById(userId);
  if (!user) {
    return { error: "User not found" };
  }

  const resolved = resolvedConfig ?? (await resolveAnalyticsConfig(user));
  const gaProperties = resolved.properties;
  if (gaProperties.length === 0) {
    return { message: "Google Analytics (GA4) is not configured. This is a self-serve setup, not a product bug — do not file a product issue. Guide the user to connect it in Settings → Analytics & SEO (/settings/analytics-seo): (1) in GA4, open Admin → Property Access Management and grant the AgentWeb service account email (shown on that page) \"Viewer\" access; (2) back in AgentWeb, add their numeric GA4 Property ID (e.g. 123456789) under \"Google Analytics\" and save, using \"Test\" to verify access. (If they belong to an organization and can't see that page, their org owner or an analytics editor must set it up.) You can use the search_user_guide tool for more detail." };
  }

  // Filter to a specific property if requested
  let propertiesToFetch = gaProperties;
  if (filterPropertyId) {
    propertiesToFetch = gaProperties.filter(p => p.propertyId === filterPropertyId);
    if (propertiesToFetch.length === 0) {
      return { error: `GA4 property "${filterPropertyId}" not found in configured properties: ${gaProperties.map(p => `${p.label} (${p.propertyId})`).join(', ')}` };
    }
  }

  const gaClient = await getGoogleAnalyticsDataClient();
  if (!gaClient) {
    return { error: "Google Analytics API not configured. Please contact support." };
  }

  const { startDateStr, endDateStr } = calculateGaDateRange(timeframe);

  // Build dimension filter to exclude filtered domains
  let dimensionFilter: any = undefined;
  if (resolved.gaFilteredDomains && resolved.gaFilteredDomains.length > 0) {
    const notExpressions = resolved.gaFilteredDomains.map((domain: string) => ({
      notExpression: {
        filter: {
          fieldName: "hostName",
          stringFilter: {
            matchType: "CONTAINS" as const,
            value: domain,
          },
        },
      },
    }));

    dimensionFilter = {
      andGroup: {
        expressions: notExpressions,
      },
    };
  }

  const metricsPromises = propertiesToFetch.map(async (prop) => {
    const propertyId = prop.propertyId;
    const label = prop.label;

    try {
      // Fetch overall metrics
      const [overallResponse] = await gaClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
        metrics: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "screenPageViews" },
          { name: "averageSessionDuration" },
          { name: "bounceRate" },
        ],
        ...(dimensionFilter && { dimensionFilter }),
      });

      // Fetch top pages by engagement
      let topPagesByEngagement: Array<{
        pageTitle: string;
        pagePath: string;
        sessions: number;
        engagementRate: number;
        userEngagementDuration: number;
        eventCount: number;
      }> = [];

      try {
        const [pagesEngagementResponse] = await gaClient.runReport({
          property: `properties/${propertyId}`,
          dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
          dimensions: [
            { name: "pagePath" },
            { name: "hostName" },
          ],
          metrics: [
            { name: "sessions" },
            { name: "engagementRate" },
            { name: "userEngagementDuration" },
            { name: "eventCount" },
          ],
          orderBys: [
            { metric: { metricName: "userEngagementDuration" }, desc: true },
          ],
          limit: 20,
          ...(dimensionFilter && { dimensionFilter }),
        });

        if (pagesEngagementResponse.rows) {
          pagesEngagementResponse.rows.forEach((row) => {
            const dimensions = row.dimensionValues || [];
            const metrics = row.metricValues || [];
            const pagePath = dimensions[0]?.value || "";
            const hostName = dimensions[1]?.value || "";
            const sessions = parseInt(metrics[0]?.value || "0");
            const engagementRate = parseFloat(metrics[1]?.value || "0") * 100;
            const userEngagementDuration = parseFloat(metrics[2]?.value || "0");
            const eventCount = parseInt(metrics[3]?.value || "0");

            let fullUrl = pagePath;
            if (hostName) {
              const path = pagePath.startsWith("/") ? pagePath : `/${pagePath}`;
              fullUrl = `https://${hostName}${path}`;
            } else if (resolved.seoDomains && resolved.seoDomains.length > 0) {
              const path = pagePath.startsWith("/") ? pagePath : `/${pagePath}`;
              fullUrl = `https://${resolved.seoDomains[0]}${path}`;
            }

            topPagesByEngagement.push({
              pageTitle: pagePath,
              pagePath: fullUrl,
              sessions,
              engagementRate,
              userEngagementDuration,
              eventCount,
            });
          });
        }
      } catch (engagementError: any) {
        console.warn("Error fetching top pages by engagement:", engagementError.message);
      }

      // Same rows, sorted by sessions instead of engagement duration — lets callers answer
      // "top pages by volume" from a field that is already correctly ordered, instead of
      // having to sort topPagesByEngagement themselves (ENG-1187: a hand-sorted ranking over
      // this array was asserted wrong in a client-facing report).
      const topPagesBySessions = [...topPagesByEngagement].sort((a, b) => b.sessions - a.sessions);

      // Fetch daily data for timeline
      const [dailyResponse] = await gaClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "screenPageViews" },
        ],
        keepEmptyRows: false,
        ...(dimensionFilter && { dimensionFilter }),
      });

      // Process overall metrics
      let totalSessions = 0;
      let totalUsers = 0;
      let totalPageViews = 0;
      let avgSessionDuration = 0;
      let bounceRate = 0;

      if (overallResponse.rows && overallResponse.rows.length > 0) {
        const row = overallResponse.rows[0];
        const metrics = row.metricValues || [];
        totalSessions = parseInt(metrics[0]?.value || "0");
        totalUsers = parseInt(metrics[1]?.value || "0");
        totalPageViews = parseInt(metrics[2]?.value || "0");
        avgSessionDuration = parseFloat(metrics[3]?.value || "0");
        bounceRate = parseFloat(metrics[4]?.value || "0") * 100;
      }

      // Process daily data
      const dailyData: Array<{ date: string; sessions: number; users: number; pageViews: number }> = [];
      if (dailyResponse.rows) {
        dailyResponse.rows.forEach((row) => {
          const dimensions = row.dimensionValues || [];
          const metrics = row.metricValues || [];
          const dateValue = dimensions[0]?.value || "";

          if (!dateValue || dateValue.length !== 8) {
            return;
          }

          const sessions = parseInt(metrics[0]?.value || "0");
          const users = parseInt(metrics[1]?.value || "0");
          const pageViews = parseInt(metrics[2]?.value || "0");
          const formattedDate = `${dateValue.substring(0, 4)}-${dateValue.substring(4, 6)}-${dateValue.substring(6, 8)}`;

          dailyData.push({ date: formattedDate, sessions, users, pageViews });
        });
      }
      dailyData.sort((a, b) => a.date.localeCompare(b.date));

      // Fetch traffic sources and conversion breakdown in parallel
      interface TrafficSource {
        source: string;
        medium: string;
        sessions: number;
        users: number;
        pageViews: number;
        avgSessionDuration: number;
        conversions: number;
      }

      interface ConversionBySource {
        source: string;
        medium: string;
        eventName: string;
        conversions: number;
      }

      const [trafficSources, conversionsBySource] = await Promise.all([
        (async (): Promise<TrafficSource[]> => {
          try {
            const [trafficSourcesResponse] = await gaClient.runReport({
              property: `properties/${propertyId}`,
              dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
              dimensions: [
                { name: "sessionSource" },
                { name: "sessionMedium" },
              ],
              metrics: [
                { name: "sessions" },
                { name: "activeUsers" },
                { name: "screenPageViews" },
                { name: "averageSessionDuration" },
                { name: "conversions" },
              ],
              orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
              limit: 50,
              ...(dimensionFilter && { dimensionFilter }),
            });

            const result: TrafficSource[] = [];
            if (trafficSourcesResponse.rows) {
              trafficSourcesResponse.rows.forEach((row) => {
                const dimensions = row.dimensionValues || [];
                const metrics = row.metricValues || [];
                result.push({
                  source: dimensions[0]?.value || "(direct)",
                  medium: dimensions[1]?.value || "(none)",
                  sessions: parseInt(metrics[0]?.value || "0"),
                  users: parseInt(metrics[1]?.value || "0"),
                  pageViews: parseInt(metrics[2]?.value || "0"),
                  avgSessionDuration: parseFloat(metrics[3]?.value || "0"),
                  conversions: parseInt(metrics[4]?.value || "0"),
                });
              });
            }
            return result;
          } catch (trafficError: any) {
            console.warn(`Error fetching traffic sources for property ${propertyId}:`, trafficError.message);
            return [];
          }
        })(),

        (async (): Promise<ConversionBySource[]> => {
          try {
            const [convBySourceResponse] = await gaClient.runReport({
              property: `properties/${propertyId}`,
              dateRanges: [{ startDate: startDateStr, endDate: endDateStr }],
              dimensions: [
                { name: "sessionSource" },
                { name: "sessionMedium" },
                { name: "eventName" },
              ],
              metrics: [{ name: "conversions" }],
              orderBys: [{ metric: { metricName: "conversions" }, desc: true }],
              limit: 100,
              ...(dimensionFilter && { dimensionFilter }),
            });

            const result: ConversionBySource[] = [];
            if (convBySourceResponse.rows) {
              convBySourceResponse.rows.forEach((row) => {
                const dimensions = row.dimensionValues || [];
                const metrics = row.metricValues || [];
                const conversions = parseInt(metrics[0]?.value || "0");
                if (conversions > 0) {
                  result.push({
                    source: dimensions[0]?.value || "(direct)",
                    medium: dimensions[1]?.value || "(none)",
                    eventName: dimensions[2]?.value || "",
                    conversions,
                  });
                }
              });
            }
            return result;
          } catch (convError: any) {
            console.warn(`Error fetching conversions by source for property ${propertyId}:`, convError.message);
            return [];
          }
        })(),
      ]);

      return {
        propertyId,
        label,
        sessions: totalSessions,
        users: totalUsers,
        pageViews: totalPageViews,
        avgSessionDuration,
        bounceRate,
        dailyData,
        trafficSources: trafficSources.sort((a, b) => b.sessions - a.sessions).slice(0, 20),
        conversionsBySource,
        topPagesByEngagement,
        topPagesBySessions,
        dateRange: { startDate: startDateStr, endDate: endDateStr },
      };
    } catch (error: any) {
      console.error(`Error fetching Google Analytics metrics for property ${label} (${propertyId}):`, error);
      return {
        propertyId,
        label,
        error: error.message || "Failed to fetch Google Analytics metrics",
      };
    }
  });

  const metrics = await Promise.all(metricsPromises);
  return {
    ga4_integration_status: "GA4 is configured and connected. If a page or subdomain shows 0 sessions, it means that domain/subdomain is not sending data to this property — GA4 tracking is not installed there. Do NOT ask the user for a Measurement ID; instead, offer to add GA4 tracking to the missing pages.",
    key_event_semantics: "The `conversions` numbers (both in `trafficSources` and in `conversionsBySource`) are historical counts of events that were flagged as key events AT COLLECTION TIME. In GA4, marking or un-marking a key event is not retroactive: already-collected rows keep their conversion counts, and newly-marked events have none before the date they were marked. So an event appearing here with conversions > 0 — commonly `page_view` or `scroll` — does NOT mean it is currently marked as a key event, and an event missing from this list does not mean it isn't. No tool available here reads the property's key-event configuration. Do not state, and do not advise un-marking or marking, which events are key events based on this payload: read the GA4 Admin UI (Admin > Events / Key events) with browser tools, or ask the user.",
    configured_properties: gaProperties.map(p => ({ propertyId: p.propertyId, label: p.label })),
    metrics,
    timeframe,
    timestamp: new Date().toISOString(),
  };
}
