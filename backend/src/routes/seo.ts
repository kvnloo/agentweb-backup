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

    // Fetch metrics for each domain
    const metricsPromises = user.seoDomains.map(async (domain: string) => {
      try {
        // Format domain for Search Console API (sc-domain:example.com or https://example.com)
        const siteUrl = domain.startsWith("http") ? domain : `sc-domain:${domain}`;

        // Calculate date range (last 30 days)
        const endDate = new Date();
        endDate.setDate(endDate.getDate() - 1); // Yesterday
        const startDate = new Date(endDate);
        startDate.setDate(startDate.getDate() - 29); // 30 days total

        const startDateStr = startDate.toISOString().split("T")[0];
        const endDateStr = endDate.toISOString().split("T")[0];

        // Fetch search analytics data using OAuth access token
        const searchAnalyticsUrl = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
        
        const searchAnalyticsResponse = await fetch(searchAnalyticsUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            startDate: startDateStr,
            endDate: endDateStr,
            dimensions: ["query", "page", "device", "country"],
            rowLimit: 1000,
          }),
        });

        if (!searchAnalyticsResponse.ok) {
          const errorData = await searchAnalyticsResponse.json();
          console.error(`Error fetching search analytics for ${domain}:`, errorData);
          return {
            domain,
            error: errorData.error?.message || "Failed to fetch search analytics",
            clicks: 0,
            impressions: 0,
            ctr: 0,
            position: 0,
            topQueries: [],
            topPages: [],
          };
        }

        const searchAnalyticsData = await searchAnalyticsResponse.json();

        // Calculate totals
        const totalClicks = searchAnalyticsData.rows?.reduce((sum: number, row: any) => sum + (row.clicks || 0), 0) || 0;
        const totalImpressions = searchAnalyticsData.rows?.reduce((sum: number, row: any) => sum + (row.impressions || 0), 0) || 0;
        const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
        const avgPosition = searchAnalyticsData.rows?.reduce((sum: number, row: any) => sum + (row.position || 0), 0) / (searchAnalyticsData.rows?.length || 1) || 0;

        // Get top queries (grouped by query)
        const queryMap = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
        searchAnalyticsData.rows?.forEach((row: any) => {
          const query = row.keys?.[0] || "Unknown";
          if (!queryMap.has(query)) {
            queryMap.set(query, { clicks: 0, impressions: 0, ctr: 0, position: 0 });
          }
          const existing = queryMap.get(query)!;
          existing.clicks += row.clicks || 0;
          existing.impressions += row.impressions || 0;
          existing.position += row.position || 0;
        });

        const topQueries = Array.from(queryMap.entries())
          .map(([query, data]) => ({
            query,
            clicks: data.clicks,
            impressions: data.impressions,
            ctr: data.impressions > 0 ? (data.clicks / data.impressions) * 100 : 0,
            position: data.position / (searchAnalyticsData.rows?.filter((r: any) => r.keys?.[0] === query).length || 1),
          }))
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 10);

        // Get top pages (grouped by page)
        const pageMap = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
        searchAnalyticsData.rows?.forEach((row: any) => {
          const page = row.keys?.[1] || "Unknown";
          if (!pageMap.has(page)) {
            pageMap.set(page, { clicks: 0, impressions: 0, ctr: 0, position: 0 });
          }
          const existing = pageMap.get(page)!;
          existing.clicks += row.clicks || 0;
          existing.impressions += row.impressions || 0;
          existing.position += row.position || 0;
        });

        const topPages = Array.from(pageMap.entries())
          .map(([page, data]) => ({
            page,
            clicks: data.clicks,
            impressions: data.impressions,
            ctr: data.impressions > 0 ? (data.clicks / data.impressions) * 100 : 0,
            position: data.position / (searchAnalyticsData.rows?.filter((r: any) => r.keys?.[1] === page).length || 1),
          }))
          .sort((a, b) => b.clicks - a.clicks)
          .slice(0, 10);

        return {
          domain,
          clicks: totalClicks,
          impressions: totalImpressions,
          ctr: avgCtr,
          position: avgPosition,
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

export default router;

