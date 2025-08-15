import express from "express";
import { authenticateToken } from "../middleware/auth";
import { userDb } from "../services/db";

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Check if user has ad account configured
router.get("/account-status", async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    
    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if user has ad account configured
    const hasAdAccount = !!(user.adAccount && user.adAccount.trim() !== "");
    
    res.json({ hasAdAccount });
  } catch (error) {
    console.error("Error checking ad account status:", error);
    res.status(500).json({ message: "Error checking ad account status" });
  }
});

// Get ad performance data using Meta Business SDK
router.get("/ad-performance", async (req, res) => {
  const userId = (req as any).user.userId;
  const { timeframe = "7d" } = req.query;
  
  try {
    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Check if user has ad account configured
    if (!user.adAccount || user.adAccount.trim() === "") {
      return res.status(400).json({ message: "Ad account not configured" });
    }

    // Initialize Facebook Ads API with access token
    console.log("Environment variables:", {
      NODE_ENV: process.env.NODE_ENV,
      META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN ? "EXISTS" : "MISSING",
      META_APP_ID: process.env.META_APP_ID ? "EXISTS" : "MISSING",
      META_APP_SECRET: process.env.META_APP_SECRET ? "EXISTS" : "MISSING"
    });
    
    const accessToken = process.env.META_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({ 
        message: "Meta access token not configured",
        error: "META_ACCESS_TOKEN environment variable is missing"
      });
    }

    // Get API version from environment or default to v18.0
    const apiVersion = process.env.META_API_VERSION || 'v18.0';
    console.log("Using Meta Graph API version:", apiVersion);
    
    // Test the access token with a simple API call first
    try {
      console.log("Testing access token with /me endpoint...");
      const testResponse = await fetch(`https://graph.facebook.com/${apiVersion}/me?access_token=${accessToken}`);
      const testData = await testResponse.json();
      console.log("Token test response:", testData);
      
      if (testData.error) {
        return res.status(401).json({
          message: "Meta access token validation failed",
          error: testData.error.message,
          details: testData.error
        });
      }
    } catch (tokenError: any) {
      console.error("Token validation error:", tokenError);
      return res.status(401).json({
        message: "Meta access token validation failed",
        error: "Could not validate access token",
        details: tokenError.toString()
      });
    }
    
    console.log("Using Graph API for ad account:", user.adAccount);
    console.log("Ad Account ID type:", typeof user.adAccount);
    console.log("Ad Account ID length:", user.adAccount?.length);
    
    // Validate ad account ID format
    if (!user.adAccount || !/^\d+$/.test(user.adAccount)) {
      return res.status(400).json({
        message: "Invalid ad account ID format",
        error: "Ad account ID must be a numeric string",
        received: user.adAccount
      });
    }
    
    // Calculate date range based on timeframe
    const endDate = new Date();
    const startDate = new Date();
    if (timeframe === "7d") {
      startDate.setDate(endDate.getDate() - 7);
    } else if (timeframe === "30d") {
      startDate.setDate(endDate.getDate() - 30);
    } else if (timeframe === "90d") {
      startDate.setDate(endDate.getDate() - 90);
    }

    // Get campaigns using Graph API
    console.log("Fetching campaigns for timeframe:", timeframe);
    let campaigns;
    try {
      const campaignsUrl = `https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`;
      console.log("Campaigns URL:", campaignsUrl);
      
      const campaignsResponse = await fetch(campaignsUrl);
      const campaignsData = await campaignsResponse.json();
      
      if (campaignsData.error) {
        throw new Error(`Graph API Error: ${campaignsData.error.message}`);
      }
      
      campaigns = campaignsData.data || [];
      console.log("Campaigns fetched successfully:", campaigns.length);
    } catch (campaignError: any) {
      console.error("Error fetching campaigns:", campaignError);
      throw new Error(`Failed to fetch campaigns: ${campaignError.message || 'Unknown error'}`);
    }

          // Get ad sets using Graph API
      console.log("Fetching ad sets for timeframe:", timeframe);
      let adSets;
      try {
        const adSetsUrl = `https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/adsets?fields=id,name,status,campaign_id,targeting&access_token=${accessToken}`;
        console.log("Ad Sets URL:", adSetsUrl);
        
        const adSetsResponse = await fetch(adSetsUrl);
        const adSetsData = await adSetsResponse.json();
        
        if (adSetsData.error) {
          throw new Error(`Graph API Error: ${adSetsData.error.message}`);
        }
        
        adSets = adSetsData.data || [];
        console.log("Ad Sets fetched successfully:", adSets.length);
      } catch (adSetsError: any) {
        console.error("Error fetching ad sets:", adSetsError);
        throw new Error(`Failed to fetch ad sets: ${adSetsError.message || 'Unknown error'}`);
      }

      // Get insights using Graph API
      console.log("Fetching insights for timeframe:", timeframe);
      let insights;
      try {
        const insightsUrl = `https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id&time_range={'since':'${startDate.toISOString().split('T')[0]}','until':'${endDate.toISOString().split('T')[0]}'}&level=adset&access_token=${accessToken}`;
        console.log("Insights URL:", insightsUrl);
        
        const insightsResponse = await fetch(insightsUrl);
        const insightsData = await insightsResponse.json();
        
        if (insightsData.error) {
          throw new Error(`Graph API Error: ${insightsData.error.message}`);
        }
        
        insights = insightsData.data || [];
        console.log("Insights fetched successfully:", insights.length);
      } catch (insightsError: any) {
        console.error("Error fetching insights:", insightsError);
        throw new Error(`Failed to fetch insights: ${insightsError.message || 'Unknown error'}`);
      }

    // Process the data
    const adPerformance = await processCampaignData(campaigns, insights);
    const adSetsData = await processAdSetsData(adSets, insights, campaigns);
    const campaignSummary = generateCampaignSummary(adPerformance);
    
    res.json({
      adPerformance,
      adSetsData,
      campaignSummary
    });
  } catch (error: any) {
    console.error("Error fetching ad performance:", error);
    
    // Expose the real error to the client
    res.status(500).json({ 
      message: "Error fetching ad performance data",
      error: error.message || "Unknown error",
      details: error.toString(),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Helper function to process campaign data from Meta API
async function processCampaignData(campaigns: any, insights: any): Promise<any[]> {
  const campaignMap = new Map();
  
  // Process campaigns
  for (const campaign of campaigns) {
    campaignMap.set(campaign.id, {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      objective: campaign.objective,
      impressions: 0,
      clicks: 0,
      spend: 0,
      ctr: 0,
      cpc: 0,
      reach: 0,
      frequency: 0,
      lastUpdated: new Date().toISOString(),
    });
  }
  
  // Process insights and merge with campaigns
  for (const insight of insights) {
    const campaignId = insight.campaign_id;
    if (campaignMap.has(campaignId)) {
      const campaign = campaignMap.get(campaignId);
      campaign.impressions = parseInt(insight.impressions) || 0;
      campaign.clicks = parseInt(insight.clicks) || 0;
      campaign.spend = parseFloat(insight.spend) || 0;
      campaign.ctr = parseFloat(insight.ctr) || 0;
      campaign.cpc = parseFloat(insight.cpc) || 0;
      campaign.reach = parseInt(insight.reach) || 0;
      campaign.frequency = parseFloat(insight.frequency) || 0;
    }
  }
  
  return Array.from(campaignMap.values());
}

// Helper function to generate campaign summary
function generateCampaignSummary(adPerformance: any[]): any {
  const totalImpressions = adPerformance.reduce((sum, c) => sum + c.impressions, 0);
  const totalClicks = adPerformance.reduce((sum, c) => sum + c.clicks, 0);
  const totalSpend = adPerformance.reduce((sum, c) => sum + c.spend, 0);
  const activeCampaigns = adPerformance.filter(c => c.status === "ACTIVE").length;

  return {
    totalCampaigns: adPerformance.length,
    activeCampaigns,
    totalSpend,
    totalImpressions,
    totalClicks,
    averageCtr: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
    averageCpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
  };
}

// Helper function to process ad sets data from Meta API
async function processAdSetsData(adSets: any, insights: any, campaigns: any): Promise<any[]> {
  const adSetsMap = new Map();
  const campaignMap = new Map();
  
  // Create campaign lookup map
  for (const campaign of campaigns) {
    campaignMap.set(campaign.id, campaign.name);
  }
  
  // Process ad sets
  for (const adSet of adSets) {
    adSetsMap.set(adSet.id, {
      id: adSet.id,
      name: adSet.name,
      status: adSet.status,
      campaignId: adSet.campaign_id,
      campaignName: campaignMap.get(adSet.campaign_id) || 'Unknown Campaign',
      targeting: adSet.targeting,
      impressions: 0,
      clicks: 0,
      spend: 0,
      ctr: 0,
      cpc: 0,
      reach: 0,
      frequency: 0,
      lastUpdated: new Date().toISOString(),
    });
  }
  
  // Process insights and merge with ad sets
  for (const insight of insights) {
    const adSetId = insight.adset_id;
    if (adSetsMap.has(adSetId)) {
      const adSet = adSetsMap.get(adSetId);
      adSet.impressions = parseInt(insight.impressions) || 0;
      adSet.clicks = parseInt(insight.clicks) || 0;
      adSet.spend = parseFloat(insight.spend) || 0;
      adSet.ctr = parseFloat(insight.ctr) || 0;
      adSet.cpc = parseFloat(insight.cpc) || 0;
      adSet.reach = parseInt(insight.reach) || 0;
      adSet.frequency = parseFloat(insight.frequency) || 0;
    }
  }
  
  return Array.from(adSetsMap.values());
}



export default router;
