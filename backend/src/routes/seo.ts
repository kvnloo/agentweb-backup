import express from "express";
import { authenticateToken } from "../middleware/auth";
import { userDb } from "../services/db";
import { getSecret } from "../utils/secretsManager";
import { JWT } from "google-auth-library";

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

// Get SEO metrics for user's configured domains
router.get("/metrics", async (req, res) => {
  try {
    const userId = (req as any).user.userId;

    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if user has SEO domains configured
    if (!user.seoDomains || user.seoDomains.length === 0) {
      return res.status(400).json({ 
        message: "No SEO domains configured. Please configure domains in the admin panel." 
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
        // Google Search Console uses Pacific Time, so we need to account for that
        // Use UTC for date calculations but be aware GSC data is in PST
        const now = new Date();
        const endDate = new Date(now);
        endDate.setUTCDate(endDate.getUTCDate() - 1); // Yesterday in UTC
        endDate.setUTCHours(0, 0, 0, 0);
        
        const startDate = new Date(endDate);
        
        if (timeframe === "7d") {
          startDate.setUTCDate(endDate.getUTCDate() - 6); // 7 days total
        } else if (timeframe === "14d") {
          startDate.setUTCDate(endDate.getUTCDate() - 13); // 14 days total
        } else if (timeframe === "30d") {
          startDate.setUTCDate(endDate.getUTCDate() - 29); // 30 days total
        } else if (timeframe === "90d") {
          startDate.setUTCDate(endDate.getUTCDate() - 89); // 90 days total
        } else {
          // Default to 30 days if invalid timeframe
          startDate.setUTCDate(endDate.getUTCDate() - 29);
        }
        startDate.setUTCHours(0, 0, 0, 0);

        const startDateStr = startDate.toISOString().split("T")[0];
        const endDateStr = endDate.toISOString().split("T")[0];

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
            rowLimit: 25000, // Increase limit to ensure we get all data
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

        // Calculate totals from daily data (this matches Google Search Console UI)
        const totalClicks = dailyData.reduce((sum, day) => sum + day.clicks, 0);
        const totalImpressions = dailyData.reduce((sum, day) => sum + day.impressions, 0);
        const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
        
        console.log(`[SEO Debug] Calculated totals - Clicks: ${totalClicks}, Impressions: ${totalImpressions}`);

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
            rowLimit: 1000,
          }),
        });

        let topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number }> = [];
        if (queriesResponse.ok) {
          const queriesData = await queriesResponse.json();
          topQueries = (queriesData.rows || [])
            .map((row: any) => ({
              query: row.keys?.[0] || "Unknown",
              clicks: row.clicks || 0,
              impressions: row.impressions || 0,
              ctr: row.impressions > 0 ? ((row.clicks || 0) / row.impressions) * 100 : 0,
              position: row.position || 0,
            }))
            .sort((a, b) => b.clicks - a.clicks)
            .slice(0, 10);
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
            rowLimit: 1000,
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
            .sort((a, b) => b.clicks - a.clicks)
            .slice(0, 10);
        }

        // Calculate average position from top queries (as a representative metric)
        const avgPosition = topQueries.length > 0
          ? topQueries.reduce((sum, q) => sum + q.position, 0) / topQueries.length
          : 0;

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

    res.json({
      metrics,
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

