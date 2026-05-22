import express from "express";
import { authenticateToken } from "../middleware/auth";
import { userDb, orgDb } from "../services/db";
import { canViewItem } from "../services/orgShareService";
import { getSecret, getLandingPagesConfig } from "../utils/secretsManager";
import { calculateFunnelMetrics, DEFAULT_FUNNEL_STAGES, validateFunnelStages } from "../services/funnelService";
import {
  getGoogleSearchConsoleAccessToken,
  getGoogleAnalyticsDataClient,
  getTechnicalSeoScore,
  getServiceAccountEmail,
  testGaProperty,
} from "../services/seoService";
import { resolveAnalyticsConfig, resolveConfigTarget } from "../services/analyticsConfigResolver";
import { readAnalyticsConfig, writeAnalyticsConfig } from "../services/analyticsConfigStore";
import { validateAnalyticsConfig } from "../services/analyticsConfigValidator";

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Get the caller's editable analytics config (self-service Settings tab).
router.get("/config", async (req, res) => {
  try {
    const user = await userDb.getUserById((req as any).user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    const target = await resolveConfigTarget(user);
    const config = await readAnalyticsConfig(target);
    const serviceAccountEmail = await getServiceAccountEmail();
    res.json({
      config,
      canEdit: target.canEdit,
      scope: target.kind === "org" ? "org" : "self",
      serviceAccountEmail,
    });
  } catch (error: any) {
    console.error("Error fetching analytics config:", error.message);
    res.status(500).json({ message: "Failed to fetch analytics config" });
  }
});

// Shared guard: load the caller, resolve the write target, enforce canEdit.
async function loadEditableTarget(req: any, res: any) {
  const user = await userDb.getUserById(req.user.userId);
  if (!user) { res.status(404).json({ message: "User not found" }); return null; }
  const target = await resolveConfigTarget(user);
  if (!target.canEdit) { res.status(403).json({ message: "Not allowed to edit analytics config" }); return null; }
  return target;
}

// Save GA4 properties, primary, filtered domains, product domain.
router.put("/config/ga", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const v = validateAnalyticsConfig({
      googleAnalyticsProperties: req.body.googleAnalyticsProperties,
      primaryAnalyticsPropertyId: req.body.primaryAnalyticsPropertyId,
      gaFilteredDomains: req.body.gaFilteredDomains,
      productDomain: req.body.productDomain,
    });
    if (!v.ok) return res.status(400).json({ message: v.error });
    await writeAnalyticsConfig(target, v.value);
    res.json({ ok: true, config: await readAnalyticsConfig(target) });
  } catch (error: any) {
    console.error("Error saving GA config:", error.message);
    res.status(500).json({ message: "Failed to save GA config" });
  }
});

// Save SEO domains.
router.put("/config/seo-domains", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const v = validateAnalyticsConfig({ seoDomains: req.body.seoDomains });
    if (!v.ok) return res.status(400).json({ message: v.error });
    await writeAnalyticsConfig(target, v.value);
    res.json({ ok: true, config: await readAnalyticsConfig(target) });
  } catch (error: any) {
    console.error("Error saving SEO domains:", error.message);
    res.status(500).json({ message: "Failed to save SEO domains" });
  }
});

// Save Clarity projects.
router.put("/config/clarity", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const v = validateAnalyticsConfig({ clarityProjects: req.body.clarityProjects });
    if (!v.ok) return res.status(400).json({ message: v.error });
    await writeAnalyticsConfig(target, v.value);
    res.json({ ok: true, config: await readAnalyticsConfig(target) });
  } catch (error: any) {
    console.error("Error saving Clarity config:", error.message);
    res.status(500).json({ message: "Failed to save Clarity config" });
  }
});

// Per-user cooldown for the GA test probe (2s) — prevents property-ID enumeration.
const gaTestCooldown = new Map<string, number>();

// Live-test a GA4 property with the shared service account.
router.post("/config/ga/test", async (req, res) => {
  try {
    const target = await loadEditableTarget(req, res);
    if (!target) return;
    const propertyId = String(req.body.propertyId || "").trim();
    if (!/^\d+$/.test(propertyId)) {
      return res.status(400).json({ ok: false, reason: "invalid", message: "Property ID must be numeric" });
    }
    const uid = (req as any).user.userId;
    const now = Date.now();
    if (now - (gaTestCooldown.get(uid) ?? 0) < 2000) {
      return res.status(429).json({ ok: false, reason: "rate_limited", message: "Please wait before testing again" });
    }
    gaTestCooldown.set(uid, now);
    res.json(await testGaProperty(propertyId));
  } catch (error: any) {
    console.error("Error testing GA property:", error.message);
    res.status(500).json({ ok: false, reason: "error", message: "Failed to test GA property" });
  }
});

// Get SEO metrics for user's configured domains
router.get("/metrics", async (req, res) => {
  try {
    const userId = (req as any).user.userId;

    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Resolve the effective analytics config (org owner's when org sharing is on).
    const resolved = await resolveAnalyticsConfig(user);

    // Check if effective config has SEO domains or a GA property configured.
    // When ?domain= is passed (e.g. from a landing page link) we still proceed so the
    // frontend can show the "not configured yet" callout with setup instructions.
    const domainFilterParam = (req.query.domain as string) || null;
    if (resolved.properties.length === 0 && resolved.seoDomains.length === 0 && !domainFilterParam) {
      return res.status(400).json({
        message: "No SEO domains or Google Analytics Property ID configured. Please configure SEO/AEO settings in the admin panel."
      });
    }

    // Get Google Search Console access token using service account
    const accessToken = await getGoogleSearchConsoleAccessToken();
    if (!accessToken) {
      return res.status(500).json({ 
        message: "Google Search Console API not configured. Please contact support." 
      });
    }

    // Get timeframe from query parameter (default to 30d)
    const timeframe = (req.query.timeframe as string) || "30d";

    // Optional: filter to a single domain (e.g., when navigating from a landing page card)
    const domainFilter = (req.query.domain as string) || null;

    // Helper to extract bare hostname from a domain entry (handles both "example.com" and "https://example.com")
    function bareHost(d: string): string {
      try { return new URL(d.startsWith("http") ? d : `https://${d}`).hostname; } catch { return d; }
    }

    // Filter seoDomains to only the requested domain if ?domain= is specified.
    // Special case: if ?domain= is a subdomain of a managed root domain (e.g., foo.agentwebforms.com)
    // and the root domain (agentwebforms.com) is configured, use the root domain entry but apply
    // a GSC page filter to scope results to the specific subdomain.
    let gscPageFilter: string | null = null; // hostname to use as GSC page dimensionFilter
    const domainsToFetch: string[] = (() => {
      if (!domainFilter) return (resolved.seoDomains || []);
      const filtered = (resolved.seoDomains || []).filter((d: string) => bareHost(d) === bareHost(domainFilter));
      if (filtered.length > 0) return filtered;
      // No exact match — check if any configured domain is the parent of domainFilter
      const parent = (resolved.seoDomains || []).find((d: string) => {
        const h = bareHost(d);
        return domainFilter.endsWith(`.${h}`);
      });
      if (parent) {
        // Use the parent domain entry but filter GSC pages to just the subdomain
        gscPageFilter = domainFilter;
        return [parent];
      }
      return [];
    })();

    // Fetch metrics for each domain
    const metricsPromises = domainsToFetch.map(async (domain: string) => {
      try {
        // Format domain for Search Console API (sc-domain:example.com or https://example.com)
        console.log(`[GSC Fetch] Raw domain from DB: "${domain}"`);
        const siteUrl = domain.startsWith("http") ? domain : `sc-domain:${domain}`;
        console.log(`[GSC Fetch] Formatted siteUrl: "${siteUrl}"`);

        // Calculate date range based on timeframe
        // End date is today
        const now = new Date();
        const endDate = new Date(now);
        endDate.setUTCHours(0, 0, 0, 0); // Today in UTC
        
        const startDate = new Date(endDate);
        
        // For N days, go back (N) days from end date to match Google UI
        // Google includes both start and end dates, so we need to go back N days to get N+1 days total
        // But to match Google's behavior, we go back one extra day
        if (timeframe === "7d") {
          startDate.setUTCDate(endDate.getUTCDate() - 7); // Go back 7 days to match Google's start date
        } else if (timeframe === "14d") {
          startDate.setUTCDate(endDate.getUTCDate() - 14); // Go back 14 days
        } else if (timeframe === "30d") {
          startDate.setUTCDate(endDate.getUTCDate() - 30); // Go back 30 days
        } else if (timeframe === "90d") {
          startDate.setUTCDate(endDate.getUTCDate() - 90); // Go back 90 days
        } else {
          // Default to 30 days if invalid timeframe
          startDate.setUTCDate(endDate.getUTCDate() - 30);
        }
        startDate.setUTCHours(0, 0, 0, 0);
        startDate.setUTCHours(0, 0, 0, 0);

        const startDateStr = startDate.toISOString().split("T")[0];
        const endDateStr = endDate.toISOString().split("T")[0];
        
        const daysInRange = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        const searchAnalyticsUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

        // When viewing a specific subdomain that lives under a managed root property (e.g.,
        // foo.agentwebforms.com under sc-domain:agentwebforms.com), scope all GSC requests
        // to pages whose URL contains that subdomain hostname.
        const gscDimFilterGroups = gscPageFilter
          ? [{ filters: [{ dimension: "page", operator: "contains", expression: gscPageFilter }] }]
          : undefined;

        // Fetch daily data for timeline chart
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
            rowLimit: 25000, // Increased to ensure we get all daily data
            ...(gscDimFilterGroups && { dimensionFilterGroups: gscDimFilterGroups }),
          }),
        });

        let dailyData: Array<{ date: string; clicks: number; impressions: number }> = [];
        if (!dailyDataResponse.ok) {
          const errorData = await dailyDataResponse.json();
          console.error(`Error fetching daily data for ${domain}:`, errorData);
          return {
            domain,
            error: errorData.error?.message || "Failed to fetch daily search analytics",
            clicks: 0,
            impressions: 0,
            ctr: 0,
            position: 0,
            technicalSeoScore: null,
            dailyData: [],
            topQueries: [],
            topPages: [],
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


        // Fetch overall totals without dimensions - this matches Google UI exactly
        // Google calculates totals from the full dataset, not just daily breakdown
        const overallResponse = await fetch(searchAnalyticsUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            startDate: startDateStr,
            endDate: endDateStr,
            // No dimensions = overall totals (matches Google UI calculation exactly)
            ...(gscDimFilterGroups && { dimensionFilterGroups: gscDimFilterGroups }),
          }),
        });

        let totalClicks = 0;
        let totalImpressions = 0;
        let avgPosition = 0;
        let avgCtr = 0;

        if (overallResponse.ok) {
          const overallData = await overallResponse.json();
          // When no dimensions are specified, API returns totals matching Google UI
          if (overallData.rows && overallData.rows.length > 0) {
            const overallRow = overallData.rows[0];
            totalClicks = overallRow.clicks || 0;
            totalImpressions = overallRow.impressions || 0;
            avgPosition = overallRow.position || 0; // Weighted average position from Google
            avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
          } else {
            // Fallback: sum daily data (may not match exactly due to sampling)
            totalClicks = dailyData.reduce((sum, day) => sum + day.clicks, 0);
            totalImpressions = dailyData.reduce((sum, day) => sum + day.impressions, 0);
            avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
          }
        } else {
          // Fallback to daily data if overall request fails
          await overallResponse.json().catch(() => ({}));
          totalClicks = dailyData.reduce((sum, day) => sum + day.clicks, 0);
          totalImpressions = dailyData.reduce((sum, day) => sum + day.impressions, 0);
          avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
        }
        
        // Fetch top queries (single dimension to avoid aggregation issues)
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
            rowLimit: 25000, // Increased to get all queries
            ...(gscDimFilterGroups && { dimensionFilterGroups: gscDimFilterGroups }),
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
        
        // If we still don't have position, calculate weighted average from queries
        if (avgPosition === 0 && allQueriesData && allQueriesData.rows && allQueriesData.rows.length > 0) {
          // Calculate weighted average position: sum(position * impressions) / sum(impressions)
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

        // Fetch top pages (single dimension to avoid aggregation issues)
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
            rowLimit: 25000, // Increased to get all pages
            ...(gscDimFilterGroups && { dimensionFilterGroups: gscDimFilterGroups }),
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
          dateRange: {
            startDate: startDateStr,
            endDate: endDateStr,
          },
        };
      } catch (error: any) {
        console.error(`Error processing domain ${domain}:`, error);
        return {
          domain,
          error: error.message || "Failed to fetch metrics",
          clicks: 0,
          impressions: 0,
          ctr: 0,
          position: 0,
          technicalSeoScore: null,
          dailyData: [],
          topQueries: [],
          topPages: [],
        };
      }
    });

    const metrics = await Promise.all(metricsPromises);

    // Fetch Google Analytics metrics for all configured properties.
    // For *.agentwebforms.com subdomains, also inject the platform-owned GA4 property from Secrets Manager
    // so traffic shows up without requiring per-user config.
    let gaMetricsArray: any[] = [];
    let gaProperties = resolved.properties;

    if (domainFilter) {
      const lpConfig = await getLandingPagesConfig();
      if (lpConfig && bareHost(domainFilter).endsWith(`.${lpConfig.gscDomain}`)) {
        const alreadyHas = gaProperties.some((p: any) => p.propertyId === lpConfig.ga4PropertyId);
        if (!alreadyHas) {
          gaProperties = [...gaProperties, { propertyId: lpConfig.ga4PropertyId, label: lpConfig.gscDomain }];
        }
      }
    }

    if (gaProperties.length > 0) {
      const gaClient = await getGoogleAnalyticsDataClient();

      if (gaClient) {
        // Fetch metrics for each property in parallel
        const gaMetricsPromises = gaProperties.map(async (property) => {
          try {
            // Calculate date range based on timeframe
            const now = new Date();
            const endDate = new Date(now);
            endDate.setUTCHours(0, 0, 0, 0); // Today in UTC

            const startDate = new Date(endDate);
            const timeframe = (req.query.timeframe as string) || "30d";

            if (timeframe === "7d") {
              startDate.setUTCDate(endDate.getUTCDate() - 6); // 7 days total (including end date)
            } else if (timeframe === "14d") {
              startDate.setUTCDate(endDate.getUTCDate() - 13); // 14 days total
            } else if (timeframe === "30d") {
              startDate.setUTCDate(endDate.getUTCDate() - 29); // 30 days total
            } else if (timeframe === "90d") {
              startDate.setUTCDate(endDate.getUTCDate() - 89); // 90 days total
            } else {
              startDate.setUTCDate(endDate.getUTCDate() - 29); // Default 30 days total
            }
            startDate.setUTCHours(0, 0, 0, 0);

            const startDateStr = startDate.toISOString().split("T")[0];
            const endDateStr = endDate.toISOString().split("T")[0];

            const propertyId = property.propertyId;

            // Build dimension filter to exclude filtered domains (and optionally include only one host)
            let dimensionFilter: any = undefined;
            const filterExpressions: any[] = [];

            if (resolved.gaFilteredDomains && resolved.gaFilteredDomains.length > 0) {
              filterExpressions.push(
                ...resolved.gaFilteredDomains.map((domain: string) => ({
                  notExpression: {
                    filter: {
                      fieldName: "hostName",
                      stringFilter: { matchType: "CONTAINS" as const, value: domain },
                    },
                  },
                }))
              );
            }

            if (domainFilter) {
              filterExpressions.push({
                filter: {
                  fieldName: "hostName",
                  stringFilter: { matchType: "EXACT" as const, value: bareHost(domainFilter) },
                },
              });
            }

            if (filterExpressions.length === 1) {
              dimensionFilter = filterExpressions[0];
            } else if (filterExpressions.length > 1) {
              dimensionFilter = { andGroup: { expressions: filterExpressions } };
            }

            // Fetch overall metrics (basic metrics first)
            const [overallResponse] = await gaClient.runReport({
              property: `properties/${propertyId}`,
              dateRanges: [
                {
                  startDate: startDateStr,
                  endDate: endDateStr,
                },
              ],
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
                dateRanges: [
                  {
                    startDate: startDateStr,
                    endDate: endDateStr,
                  },
                ],
                dimensions: [
                  // Only use pagePath and hostName to avoid duplicate rows for different page titles
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
                  {
                    metric: { metricName: "userEngagementDuration" },
                    desc: true,
                  },
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

                  // Construct full URL with domain
                  let fullUrl = pagePath;
                  if (hostName) {
                    // Ensure path starts with /
                    const path = pagePath.startsWith("/") ? pagePath : `/${pagePath}`;
                    fullUrl = `https://${hostName}${path}`;
                  } else if (resolved.seoDomains && resolved.seoDomains.length > 0) {
                    // Fallback to first SEO domain if hostname not available
                    const path = pagePath.startsWith("/") ? pagePath : `/${pagePath}`;
                    fullUrl = `https://${resolved.seoDomains[0]}${path}`;
                  }

                  // Use the path as the title since we're grouping by path
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
              // Continue without engagement data
            }

            // Fetch daily data for timeline
            const [dailyResponse] = await gaClient.runReport({
              property: `properties/${propertyId}`,
              dateRanges: [
                {
                  startDate: startDateStr,
                  endDate: endDateStr,
                },
              ],
              dimensions: [{ name: "date" }],
              metrics: [
                { name: "sessions" },
                { name: "activeUsers" },
                { name: "screenPageViews" },
              ],
              keepEmptyRows: false,
              ...(dimensionFilter && { dimensionFilter }),
            });

            // Fetch traffic sources for AEO analysis
            const [trafficSourcesResponse] = await gaClient.runReport({
              property: `properties/${propertyId}`,
              dateRanges: [
                {
                  startDate: startDateStr,
                  endDate: endDateStr,
                },
              ],
              dimensions: [
                { name: "sessionSource" },
                { name: "sessionMedium" },
              ],
              metrics: [
                { name: "sessions" },
                { name: "activeUsers" },
                { name: "screenPageViews" },
                { name: "averageSessionDuration" },
              ],
              orderBys: [
                {
                  metric: { metricName: "sessions" },
                  desc: true,
                },
              ],
              limit: 50,
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
              bounceRate = parseFloat(metrics[4]?.value || "0") * 100; // Convert to percentage
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

                // GA4 returns date in YYYYMMDD format, convert to YYYY-MM-DD
                const formattedDate = `${dateValue.substring(0, 4)}-${dateValue.substring(4, 6)}-${dateValue.substring(6, 8)}`;

                dailyData.push({
                  date: formattedDate,
                  sessions,
                  users,
                  pageViews,
                });
              });
            }

            // Sort daily data by date to ensure proper chronological order
            dailyData.sort((a, b) => a.date.localeCompare(b.date));

            // Process traffic sources
            interface TrafficSource {
              source: string;
              medium: string;
              sessions: number;
              users: number;
              pageViews: number;
              avgSessionDuration: number;
            }

            const trafficSources: TrafficSource[] = [];

            if (trafficSourcesResponse.rows) {
              trafficSourcesResponse.rows.forEach((row) => {
                const dimensions = row.dimensionValues || [];
                const metrics = row.metricValues || [];
                const source = dimensions[0]?.value || "(direct)";
                const medium = dimensions[1]?.value || "(none)";
                const sessions = parseInt(metrics[0]?.value || "0");
                const users = parseInt(metrics[1]?.value || "0");
                const pageViews = parseInt(metrics[2]?.value || "0");
                const avgSessionDuration = parseFloat(metrics[3]?.value || "0");

                trafficSources.push({
                  source,
                  medium,
                  sessions,
                  users,
                  pageViews,
                  avgSessionDuration,
                });
              });
            }

            return {
              propertyId,
              label: property.label,
              sessions: totalSessions,
              users: totalUsers,
              pageViews: totalPageViews,
              avgSessionDuration,
              bounceRate,
              dailyData: dailyData.sort((a, b) => a.date.localeCompare(b.date)),
              trafficSources: trafficSources.sort((a, b) => b.sessions - a.sessions).slice(0, 20),
              topPagesByEngagement,
              dateRange: {
                startDate: startDateStr,
                endDate: endDateStr,
              },
            };
          } catch (error: any) {
            console.error(`Error fetching Google Analytics metrics for property ${property.propertyId}:`, error);
            return {
              propertyId: property.propertyId,
              label: property.label,
              error: error.message || "Failed to fetch Google Analytics metrics",
            };
          }
        });

        gaMetricsArray = await Promise.all(gaMetricsPromises);
      }
    }

    // For backward compatibility, also provide gaMetrics as single object (first property)
    const gaMetrics = gaMetricsArray.length > 0 ? gaMetricsArray[0] : null;

    // Calculate funnel metrics if GA4 is configured and funnelId provided
    let funnelMetrics: any = null;
    const funnelId = req.query.funnelId as string;
    const funnelOwnerId = (req.query.funnelOwnerId as string) || (req as any).user.userId;

    if (resolved.primaryPropertyId && funnelId) {
      try {
        // A shared funnel may belong to another org member — gate the cross-member case.
        if (funnelOwnerId !== (req as any).user.userId) {
          const org = user.orgId ? await orgDb.getOrgById(user.orgId) : null;
          const owner = await userDb.getUserById(funnelOwnerId);
          const orgLike = org
            ? { orgId: org.orgId, ownerUserId: org.ownerUserId, shareSettings: org.shareSettings }
            : null;
          const userLike = { userId: user.userId, orgId: user.orgId, orgRole: user.orgRole };
          if (!owner || owner.orgId !== user.orgId ||
              !canViewItem({ userId: funnelOwnerId }, userLike, orgLike, owner.orgId, "funnels")) {
            throw new Error("Funnel not accessible");
          }
        }

        // Fetch funnel config from AW-Settings (keyed to the funnel's owner)
        const AWS = require("aws-sdk");
        const dynamodb = new AWS.DynamoDB.DocumentClient({ region: process.env.AWS_REGION || "us-west-2" });
        const TABLE_PREFIX = process.env.NODE_ENV === "production" ? "" : "Dev-";

        const funnelResult = await dynamodb.get({
          TableName: `${TABLE_PREFIX}AW-Settings`,
          Key: { settingName: `funnels_${funnelOwnerId}` },
        }).promise();

        const funnel = funnelResult.Item?.funnels?.[funnelId];

        if (funnel && funnel.stages) {
          const gaClient = await getGoogleAnalyticsDataClient();
          if (gaClient) {
            // Use same date range as GA metrics
            const now = new Date();
            const endDate = new Date(now);
            endDate.setUTCHours(0, 0, 0, 0);

            const startDate = new Date(endDate);
            const timeframe = (req.query.timeframe as string) || "30d";

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

            const startDateStr = startDate.toISOString().split("T")[0];
            const endDateStr = endDate.toISOString().split("T")[0];

            // Funnel metrics run against the caller's resolved analytics config.
            // For org users this is the shared org-level GA4 property, so a
            // shared funnel's owner and viewer always use the same property.
            funnelMetrics = await calculateFunnelMetrics(
              gaClient,
              resolved.primaryPropertyId,
              { startDate: startDateStr, endDate: endDateStr },
              funnel.stages
            );

            // Add funnel name to metrics
            funnelMetrics.funnelName = funnel.name;
          }
        }
      } catch (error: any) {
        console.error("Error calculating funnel metrics:", error);
        funnelMetrics = {
          stages: [],
          totalSessions: 0,
          completionRate: 0,
          error: error.message || "Failed to calculate funnel metrics",
        };
      }
    }

    res.json({
      metrics,
      gaMetrics,  // Backward compatibility: first property or null
      gaMetricsArray,  // New format: array of all properties
      funnelMetrics,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error fetching SEO metrics:", error);
    res.status(500).json({ 
      message: "Error fetching SEO metrics",
      error: error.message || "Unknown error"
    });
  }
});

// Get user's funnel configuration
router.get("/funnel-config", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await userDb.getUserById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Return user's custom config or defaults
    const funnelConfig = user.funnelConfig || { stages: DEFAULT_FUNNEL_STAGES };

    res.json({
      success: true,
      funnelConfig,
      isDefault: !user.funnelConfig,
    });
  } catch (error: any) {
    console.error("Error fetching funnel config:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching funnel configuration",
      error: error.message || "Unknown error",
    });
  }
});

// Update user's funnel configuration
router.put("/funnel-config", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const { stages } = req.body;

    // Validate stages
    if (!stages || !Array.isArray(stages)) {
      return res.status(400).json({
        success: false,
        message: "Stages array is required",
      });
    }

    // Validate funnel stages
    const validationErrors = validateFunnelStages(stages);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid funnel configuration",
        errors: validationErrors,
      });
    }

    // Update user's funnel config
    await userDb.updateUser(userId, {
      funnelConfig: { stages },
    });

    res.json({
      success: true,
      message: "Funnel configuration updated successfully",
      funnelConfig: { stages },
    });
  } catch (error: any) {
    console.error("Error updating funnel config:", error);
    res.status(500).json({
      success: false,
      message: "Error updating funnel configuration",
      error: error.message || "Unknown error",
    });
  }
});

// Get service account email for setup instructions
router.get("/service-account-email", async (req, res) => {
  try {
    const secretName = process.env.NODE_ENV === "production"
      ? "prod/AgentWeb/Google/SearchConsole"
      : "dev/AgentWeb/Google/SearchConsole";

    const serviceAccountJson = await getSecret(secretName);
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (!serviceAccount.client_email) {
      return res.status(500).json({
        success: false,
        message: "Service account email not found in configuration"
      });
    }

    res.json({
      success: true,
      serviceAccountEmail: serviceAccount.client_email
    });
  } catch (error: any) {
    console.error("Error fetching service account email:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch service account email",
      error: error.message
    });
  }
});

// Debug endpoint to test Google Search Console API directly
router.get("/debug", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const resolvedDebug = await resolveAnalyticsConfig(user);
    if (!resolvedDebug.seoDomains || resolvedDebug.seoDomains.length === 0) {
      return res.status(400).json({ message: "No SEO domains configured" });
    }

    const accessToken = await getGoogleSearchConsoleAccessToken();
    if (!accessToken) {
      return res.status(500).json({ message: "Google Search Console API not configured" });
    }

    const domain = resolvedDebug.seoDomains[0];
    const siteUrl = domain.startsWith("http") ? domain : `sc-domain:${domain}`;
    
    // Test with a specific date range around November 10
    const startDateStr = "2024-11-01";
    const endDateStr = "2024-11-20";
    
    const searchAnalyticsUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
    
    const response = await fetch(searchAnalyticsUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: startDateStr,
        endDate: endDateStr,
        dimensions: ["date"],
        rowLimit: 1000,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return res.status(response.status).json({ error: errorData });
    }

    const data = await response.json();
    
    // Find November 10 specifically
    const nov10Row = data.rows?.find((r: any) => r.keys?.[0] === "2024-11-10");
    
    res.json({
      domain,
      dateRange: { startDate: startDateStr, endDate: endDateStr },
      totalRows: data.rows?.length || 0,
      nov10Data: nov10Row || null,
      allRows: data.rows || [],
      rawResponse: data,
    });
  } catch (error: any) {
    console.error("Debug endpoint error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get product feature usage metrics from Google Analytics
router.get("/product-metrics", async (req, res) => {
  try {
    const userId = (req as any).user.userId;

    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Resolve the effective analytics config (org owner's when org sharing is on).
    const resolved = await resolveAnalyticsConfig(user);

    // Check if effective config has a product domain and GA property configured
    if (!resolved.productDomain || !resolved.primaryPropertyId) {
      return res.status(400).json({
        message: "Product domain or Google Analytics Property ID not configured. Please configure in the admin panel."
      });
    }

    // Get Google Analytics Data API client
    const gaClient = await getGoogleAnalyticsDataClient();
    if (!gaClient) {
      return res.status(500).json({
        message: "Google Analytics API not configured. Please contact support."
      });
    }

    // Get timeframe from query parameter (default to 30d)
    const timeframe = (req.query.timeframe as string) || "30d";

    // Calculate date range
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

    const startDateStr = startDate.toISOString().split("T")[0];
    const endDateStr = endDate.toISOString().split("T")[0];

    const propertyId = resolved.primaryPropertyId;

    // Fetch overall product metrics
    const [overallResponse] = await gaClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [
        {
          startDate: startDateStr,
          endDate: endDateStr,
        },
      ],
      dimensionFilter: {
        andGroup: {
          expressions: [
            {
              filter: {
                fieldName: "hostName",
                stringFilter: {
                  matchType: "CONTAINS" as const,
                  value: resolved.productDomain,
                },
              },
            },
            {
              notExpression: {
                filter: {
                  fieldName: "hostName",
                  stringFilter: {
                    matchType: "CONTAINS" as const,
                    value: "localhost",
                  },
                },
              },
            },
          ],
        },
      },
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "screenPageViews" },
        { name: "eventCount" },
        { name: "engagementRate" },
        { name: "averageSessionDuration" },
      ],
    });

    const overallMetrics = overallResponse.rows?.[0]?.metricValues || [];
    const activeUsers = parseInt(overallMetrics[0]?.value || "0");
    const sessions = parseInt(overallMetrics[1]?.value || "0");
    const pageViews = parseInt(overallMetrics[2]?.value || "0");
    const totalEvents = parseInt(overallMetrics[3]?.value || "0");
    const engagementRate = parseFloat(overallMetrics[4]?.value || "0");
    const avgSessionDuration = parseFloat(overallMetrics[5]?.value || "0");

    // Fetch daily trend data
    const [dailyResponse] = await gaClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [
        {
          startDate: startDateStr,
          endDate: endDateStr,
        },
      ],
      dimensionFilter: {
        andGroup: {
          expressions: [
            {
              filter: {
                fieldName: "hostName",
                stringFilter: {
                  matchType: "CONTAINS" as const,
                  value: resolved.productDomain,
                },
              },
            },
            {
              notExpression: {
                filter: {
                  fieldName: "hostName",
                  stringFilter: {
                    matchType: "CONTAINS" as const,
                    value: "localhost",
                  },
                },
              },
            },
          ],
        },
      },
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "eventCount" },
      ],
      orderBys: [
        {
          dimension: {
            dimensionName: "date",
          },
        },
      ],
    });

    const dailyData = (dailyResponse.rows || []).map((row: any) => {
      const dateStr = row.dimensionValues?.[0]?.value || "";
      const formattedDate = dateStr.length === 8
        ? `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`
        : dateStr;

      return {
        date: formattedDate,
        users: parseInt(row.metricValues?.[0]?.value || "0"),
        sessions: parseInt(row.metricValues?.[1]?.value || "0"),
        events: parseInt(row.metricValues?.[2]?.value || "0"),
      };
    });

    // Fetch feature usage by page path (product features)
    const [featureResponse] = await gaClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [
        {
          startDate: startDateStr,
          endDate: endDateStr,
        },
      ],
      dimensionFilter: {
        andGroup: {
          expressions: [
            {
              filter: {
                fieldName: "hostName",
                stringFilter: {
                  matchType: "CONTAINS" as const,
                  value: resolved.productDomain,
                },
              },
            },
            {
              notExpression: {
                filter: {
                  fieldName: "hostName",
                  stringFilter: {
                    matchType: "CONTAINS" as const,
                    value: "localhost",
                  },
                },
              },
            },
          ],
        },
      },
      dimensions: [
        { name: "pagePath" },
        { name: "pageTitle" },
      ],
      metrics: [
        { name: "screenPageViews" },
        { name: "activeUsers" },
        { name: "userEngagementDuration" }, // Total duration in seconds
      ],
      orderBys: [
        {
          metric: {
            metricName: "userEngagementDuration",
          },
          desc: true,
        },
      ],
      limit: 50,
    });

    // Function to tokenize path segments (replace dynamic parts with <token>)
    const tokenizePath = (path: string): string => {
      return path
        .split('/')
        .map(segment => {
          // Match UUID patterns (8-4-4-4-12 hex digits)
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
            return '<token>';
          }
          // Match numeric IDs
          if (/^\d+$/.test(segment)) {
            return '<token>';
          }
          // Match long alphanumeric hashes (e.g., abc123def456ghi789)
          if (/^[a-z0-9]{20,}$/i.test(segment)) {
            return '<token>';
          }
          // Match short alphanumeric codes with dashes (e.g., abc-def-ghi)
          if (/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/i.test(segment)) {
            return '<token>';
          }
          // Match MongoDB ObjectId (24 hex characters)
          if (/^[0-9a-f]{24}$/i.test(segment)) {
            return '<token>';
          }
          return segment;
        })
        .join('/');
    };

    // Map raw data first
    const rawFeatureData = (featureResponse.rows || []).map((row: any) => ({
      pagePath: row.dimensionValues?.[0]?.value || "/",
      pageTitle: row.dimensionValues?.[1]?.value || "Unknown",
      users: parseInt(row.metricValues?.[1]?.value || "0"),
      pageViews: parseInt(row.metricValues?.[0]?.value || "0"),
      totalDuration: parseFloat(row.metricValues?.[2]?.value || "0"),
    }));

    // Group by tokenized path
    const groupedFeatures = new Map<string, {
      pagePath: string;
      pageTitle: string;
      users: number;
      pageViews: number;
      totalDuration: number;
    }>();

    rawFeatureData.forEach(feature => {
      const tokenized = tokenizePath(feature.pagePath);

      if (groupedFeatures.has(tokenized)) {
        const existing = groupedFeatures.get(tokenized)!;
        existing.users += feature.users;
        existing.pageViews += feature.pageViews;
        existing.totalDuration += feature.totalDuration;
      } else {
        groupedFeatures.set(tokenized, {
          pagePath: tokenized,
          pageTitle: feature.pageTitle, // Use first title encountered
          users: feature.users,
          pageViews: feature.pageViews,
          totalDuration: feature.totalDuration,
        });
      }
    });

    // Convert to array and calculate avgDuration, then sort by totalDuration desc
    const featureUsage = Array.from(groupedFeatures.values())
      .map(feature => ({
        pagePath: feature.pagePath,
        pageTitle: feature.pageTitle,
        users: feature.users,
        pageViews: feature.pageViews,
        avgDuration: feature.pageViews > 0
          ? Math.round((feature.totalDuration / feature.pageViews) * 100) / 100
          : 0,
        totalDuration: Math.round(feature.totalDuration * 100) / 100,
      }))
      .sort((a, b) => b.totalDuration - a.totalDuration);

    res.json({
      productDomain: resolved.productDomain,
      metrics: {
        activeUsers,
        sessions,
        pageViews,
        totalEvents,
        engagementRate,
        avgSessionDuration,
      },
      dailyData,
      featureUsage,
      dateRange: {
        startDate: startDateStr,
        endDate: endDateStr,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error fetching product metrics:", error);
    res.status(500).json({
      message: "Error fetching product metrics",
      error: error.message || "Unknown error"
    });
  }
});

export default router;
