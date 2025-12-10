import express from "express";
import { authenticateToken } from "../middleware/auth";
import { userDb } from "../services/db";
import { getSecret } from "../utils/secretsManager";
import { JWT } from "google-auth-library";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Helper function to get Google Search Console access token using service account
async function getGoogleSearchConsoleAccessToken(): Promise<string | null> {
  try {
    const secretName = process.env.NODE_ENV === "production" 
      ? "prod/AgentWeb/Google/SearchConsole"
      : "dev/AgentWeb/Google/SearchConsole";

    // Service account JSON is stored as plaintext
    const serviceAccountJson = await getSecret(secretName);
    const serviceAccount = JSON.parse(serviceAccountJson);
    
    if (!serviceAccount.private_key || !serviceAccount.client_email) {
      console.error("Service account JSON missing required fields (private_key or client_email)");
      return null;
    }

    // Create JWT client for service account
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

// Helper function to get Google Analytics Data API client
async function getGoogleAnalyticsDataClient(): Promise<BetaAnalyticsDataClient | null> {
  try {
    const secretName = process.env.NODE_ENV === "production" 
      ? "prod/AgentWeb/Google/SearchConsole"
      : "dev/AgentWeb/Google/SearchConsole";

    // Use the same service account as Search Console
    const serviceAccountJson = await getSecret(secretName);
    const serviceAccount = JSON.parse(serviceAccountJson);
    
    if (!serviceAccount.private_key || !serviceAccount.client_email) {
      console.error("Service account JSON missing required fields (private_key or client_email)");
      return null;
    }

    // Create Analytics Data client with service account credentials
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

// Get SEO metrics for user's configured domains
router.get("/metrics", async (req, res) => {
  try {
    const userId = (req as any).user.userId;

    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if user has SEO domains or GA Property ID configured
    if ((!user.seoDomains || user.seoDomains.length === 0) && !user.googleAnalyticsPropertyId) {
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

    // Fetch metrics for each domain
    const metricsPromises = user.seoDomains.map(async (domain: string) => {
      try {
        // Format domain for Search Console API (sc-domain:example.com or https://example.com)
        const siteUrl = domain.startsWith("http") ? domain : `sc-domain:${domain}`;

        // Calculate date range based on timeframe
        // End date is yesterday (most recent complete day)
        const now = new Date();
        const endDate = new Date(now);
        endDate.setUTCDate(endDate.getUTCDate() - 1); // Yesterday in UTC
        endDate.setUTCHours(0, 0, 0, 0);
        
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
        console.log(`[SEO Debug] Date calculation - Start: ${startDateStr}, End: ${endDateStr}, Days: ${daysInRange}, Timeframe: ${timeframe}`);

        const searchAnalyticsUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
        
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
            dailyData: [],
            topQueries: [],
            topPages: [],
          };
        }

        const dailyDataResult = await dailyDataResponse.json();
        
        // Debug logging
        console.log(`[SEO Debug] Domain: ${domain}`);
        console.log(`[SEO Debug] Date range: ${startDateStr} to ${endDateStr}`);
        console.log(`[SEO Debug] Raw API response rows count: ${dailyDataResult.rows?.length || 0}`);
        if (dailyDataResult.rows && dailyDataResult.rows.length > 0) {
          console.log(`[SEO Debug] First row sample:`, JSON.stringify(dailyDataResult.rows[0], null, 2));
          // Check for November 10 specifically
          const nov10Row = dailyDataResult.rows.find((r: any) => r.keys?.[0] === "2025-11-10" || r.keys?.[0] === "2024-11-10");
          if (nov10Row) {
            console.log(`[SEO Debug] November 10 row found:`, JSON.stringify(nov10Row, null, 2));
          }
        }
        
        dailyData = (dailyDataResult.rows || [])
          .map((row: any) => ({
            date: row.keys?.[0] || "",
            clicks: row.clicks || 0,
            impressions: row.impressions || 0,
          }))
          .filter((item: any) => item.date)
          .sort((a: any, b: any) => a.date.localeCompare(b.date));

        // Debug: Check specific date
        const nov10Data = dailyData.find(d => d.date === "2025-11-10" || d.date === "2024-11-10");
        if (nov10Data) {
          console.log(`[SEO Debug] November 10 processed data:`, nov10Data);
        }
        console.log(`[SEO Debug] Total daily data entries: ${dailyData.length}`);
        console.log(`[SEO Debug] Sample dates:`, dailyData.slice(0, 5).map(d => d.date));

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
            console.log(`[SEO Debug] Overall API totals (matches Google UI) - Clicks: ${totalClicks}, Impressions: ${totalImpressions}, Position: ${avgPosition.toFixed(2)}, CTR: ${avgCtr.toFixed(2)}%`);
          } else {
            // Fallback: sum daily data (may not match exactly due to sampling)
            console.log(`[SEO Debug] Overall response has no rows, falling back to daily data sum`);
            totalClicks = dailyData.reduce((sum, day) => sum + day.clicks, 0);
            totalImpressions = dailyData.reduce((sum, day) => sum + day.impressions, 0);
            avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
          }
        } else {
          // Fallback to daily data if overall request fails
          const errorData = await overallResponse.json().catch(() => ({}));
          console.log(`[SEO Debug] Overall request failed:`, errorData);
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
          }),
        });

        let topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number }> = [];
        let allQueriesData: any = null;
        if (queriesResponse.ok) {
          allQueriesData = await queriesResponse.json();
          console.log(`[SEO Debug] Queries response rows: ${allQueriesData.rows?.length || 0}`);
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
            console.log(`[SEO Debug] Calculated weighted position from queries: ${avgPosition.toFixed(2)}`);
          }
        }
        
        console.log(`[SEO Debug] Final totals - Clicks: ${totalClicks}, Impressions: ${totalImpressions}, Position: ${avgPosition.toFixed(2)}, CTR: ${avgCtr.toFixed(2)}%`);

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
          }),
        });

        let topPages: Array<{ page: string; clicks: number; impressions: number; ctr: number; position: number }> = [];
        if (pagesResponse.ok) {
          const pagesData = await pagesResponse.json();
          console.log(`[SEO Debug] Pages response rows: ${pagesData.rows?.length || 0}`);
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

        return {
          domain,
          clicks: totalClicks,
          impressions: totalImpressions,
          ctr: avgCtr,
          position: avgPosition,
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
          dailyData: [],
          topQueries: [],
          topPages: [],
        };
      }
    });

    const metrics = await Promise.all(metricsPromises);

    // Fetch Google Analytics metrics if Property ID is configured
    let gaMetrics: any = null;
    if (user.googleAnalyticsPropertyId) {
      try {
        const gaClient = await getGoogleAnalyticsDataClient();
        if (gaClient) {
          // Calculate date range based on timeframe
          const now = new Date();
          const endDate = new Date(now);
          endDate.setUTCDate(endDate.getUTCDate() - 1); // Yesterday in UTC
          endDate.setUTCHours(0, 0, 0, 0);
          
          const startDate = new Date(endDate);
          const timeframe = (req.query.timeframe as string) || "30d";
          
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

          const startDateStr = startDate.toISOString().split("T")[0];
          const endDateStr = endDate.toISOString().split("T")[0];

          const propertyId = user.googleAnalyticsPropertyId;

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
                { name: "pageTitle" },
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
                  metric: { metricName: "engagementRate" },
                  desc: true,
                },
              ],
              limit: 20,
            });

            if (pagesEngagementResponse.rows) {
              pagesEngagementResponse.rows.forEach((row) => {
                const dimensions = row.dimensionValues || [];
                const metrics = row.metricValues || [];
                const pageTitle = dimensions[0]?.value || "Untitled";
                const pagePath = dimensions[1]?.value || "";
                const hostName = dimensions[2]?.value || "";
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
                } else if (user.seoDomains && user.seoDomains.length > 0) {
                  // Fallback to first SEO domain if hostname not available
                  const path = pagePath.startsWith("/") ? pagePath : `/${pagePath}`;
                  fullUrl = `https://${user.seoDomains[0]}${path}`;
                }

                topPagesByEngagement.push({
                  pageTitle,
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
              const date = row.dimensionValues[0].value || "";
              const sessions = parseInt(row.metricValues[0].value || "0");
              const users = parseInt(row.metricValues[1].value || "0");
              const pageViews = parseInt(row.metricValues[2].value || "0");
              
              dailyData.push({
                date: `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`,
                sessions,
                users,
                pageViews,
              });
            });
          }

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

          gaMetrics = {
            propertyId,
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
        }
      } catch (error: any) {
        console.error("Error fetching Google Analytics metrics:", error);
        gaMetrics = {
          error: error.message || "Failed to fetch Google Analytics metrics",
        };
      }
    }

    res.json({
      metrics,
      gaMetrics,
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

// Debug endpoint to test Google Search Console API directly
router.get("/debug", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const user = await userDb.getUserById(userId);
    if (!user || !user.seoDomains || user.seoDomains.length === 0) {
      return res.status(400).json({ message: "No SEO domains configured" });
    }

    const accessToken = await getGoogleSearchConsoleAccessToken();
    if (!accessToken) {
      return res.status(500).json({ message: "Google Search Console API not configured" });
    }

    const domain = user.seoDomains[0];
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

export default router;

