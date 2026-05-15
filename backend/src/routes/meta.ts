import express from "express";
import { authenticateToken } from "../middleware/auth";
import { userDb, taskDb } from "../services/db";
import { getMetaAccessToken } from "../utils/secretsManager";

const router = express.Router();

// Action type mappings (shared across all processing functions)
const FORM_ACTIONS = new Set([
  'leadgen',
  'on_facebook_lead',
  'onsite_conversion.lead_form',
  'offsite_conversion.fb_pixel_custom',
  'offsite_conversion.fb_pixel_lead'
]);
const WEBSITE_ACTIONS = new Set([
  'website_lead',
  'lead'
]);

// Apply authentication middleware to all routes
router.use(authenticateToken);

// ---------------------------------------------------------------------------
// Helpers: connected-account fallback
// ---------------------------------------------------------------------------

const CLEAN_ACCOUNT_ID = (id: string) => (id || '').replace('act_', '');

function getConnectedMetaAdAccounts(user: any): any[] {
  return (user.connected_accounts || []).filter((acc: any) =>
    (acc.platform === 'facebook' || acc.platform === 'meta') &&
    acc.config?.account_type === 'ad_account' &&
    acc.config?.access_token
  );
}

function userHasMetaAdAccount(user: any): boolean {
  if (user.adAccount && user.adAccount.trim() !== '') return true;
  return getConnectedMetaAdAccounts(user).length > 0;
}

/**
 * Resolve the ad account ID and access token to use for Meta API calls.
 * Prefers the legacy user.adAccount + Secrets Manager token.
 * Falls back to the first connected Meta ad account if legacy is not set.
 */
async function resolveMetaCredentials(user: any): Promise<{ adAccountId: string; accessToken: string }> {
  if (user.adAccount && user.adAccount.trim() !== '') {
    const accessToken = await getMetaAccessToken();
    return { adAccountId: user.adAccount.trim(), accessToken };
  }
  const connectedAccounts = getConnectedMetaAdAccounts(user);
  if (connectedAccounts.length === 0) {
    throw new Error('Ad account not configured');
  }
  const account = connectedAccounts[0];
  const adAccountId = CLEAN_ACCOUNT_ID(account.account_id || account.config?.ad_account_id || '');
  return { adAccountId, accessToken: account.config.access_token };
}

// ---------------------------------------------------------------------------

// Check if user has ad account configured
router.get("/account-status", async (req, res) => {
  try {
    const userId = (req as any).user.userId;

    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const hasAdAccount = userHasMetaAdAccount(user);

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

    // Resolve ad account credentials (legacy field or connected account fallback)
    let adAccountId: string;
    let accessToken: string;
    try {
      ({ adAccountId, accessToken } = await resolveMetaCredentials(user));
    } catch (error: any) {
      return res.status(400).json({ message: error.message || "Ad account not configured" });
    }

    const apiVersion = process.env.META_API_VERSION || 'v25.0';
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

    // Validate ad account ID format
    if (!adAccountId || !/^\d+$/.test(adAccountId)) {
      return res.status(400).json({
        message: "Invalid ad account ID format",
        error: "Ad account ID must be a numeric string",
        received: adAccountId
      });
    }
    
    // Calculate date range based on timeframe
    // Exclude today since it's not fully complete - use yesterday as end date
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // Set to yesterday
    const startDate = new Date(endDate); // Copy endDate
    if (timeframe === "7d") {
      startDate.setDate(endDate.getDate() - 6); // 7 days total (yesterday - 6 = 7 days)
    } else if (timeframe === "14d") {
      startDate.setDate(endDate.getDate() - 13); // 14 days total
    } else if (timeframe === "30d") {
      startDate.setDate(endDate.getDate() - 29); // 30 days total
    } else if (timeframe === "90d") {
      startDate.setDate(endDate.getDate() - 89); // 90 days total
    }

    // Import Meta API fetch utilities with retry and pagination support
    const { fetchWithRetryAndPaging } = await import('../utils/metaApiFetch');
    
    // Get campaigns using Graph API
    console.log("Fetching campaigns for timeframe:", timeframe);
    let campaigns;
    try {
      const campaignsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`;
      console.log("Campaigns URL:", campaignsUrl);

      const campaignsData = await fetchWithRetryAndPaging(campaignsUrl);
      
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
      const adSetsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adsets?fields=id,name,status,campaign_id,targeting&access_token=${accessToken}`;
      console.log("Ad Sets URL:", adSetsUrl);
      
      const adSetsData = await fetchWithRetryAndPaging(adSetsUrl);
      
      if (adSetsData.error) {
        throw new Error(`Graph API Error: ${adSetsData.error.message}`);
      }
      
      adSets = adSetsData.data || [];
      console.log("Ad Sets fetched successfully:", adSets.length);
    } catch (adSetsError: any) {
      console.error("Error fetching ad sets:", adSetsError);
      throw new Error(`Failed to fetch ad sets: ${adSetsError.message || 'Unknown error'}`);
    }

    // Get ads using Graph API
    console.log("Fetching ads for timeframe:", timeframe);
    let ads;
    try {
      const adsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/ads?fields=id,name,status,adset_id,campaign_id,creative{thumbnail_url,title,body,image_url}&access_token=${accessToken}`;
      console.log("Ads URL:", adsUrl);
      
      const adsData = await fetchWithRetryAndPaging(adsUrl);
      
      if (adsData.error) {
        throw new Error(`Graph API Error: ${adsData.error.message}`);
      }
      
      ads = adsData.data || [];
      console.log("Ads fetched successfully:", ads.length);
    } catch (adsError: any) {
      console.error("Error fetching ads:", adsError);
      throw new Error(`Failed to fetch ads: ${adsError.message || 'Unknown error'}`);
    }

    // Get insights using Graph API - fetch at multiple levels
    console.log("Fetching insights for timeframe:", timeframe);
    let insights, adSetInsights, campaignInsights;
    try {
      // Fetch ad-level insights for ads processing
      const adInsightsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,ad_id,actions,cost_per_action_type&action_breakdowns=action_type&action_report_time=conversion&action_attribution_windows=default&time_range={'since':'${startDate.toISOString().split('T')[0]}','until':'${endDate.toISOString().split('T')[0]}'}&level=ad&access_token=${accessToken}`;
      
      const adInsightsData = await fetchWithRetryAndPaging(adInsightsUrl);
      
      if (adInsightsData.error) {
        throw new Error(`Graph API Error: ${adInsightsData.error.message}`);
      }
      
      insights = adInsightsData.data || [];
      console.log("Ad-level insights fetched successfully:", insights.length);

      // Fetch adset-level insights for ad sets processing
      const adSetInsightsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,adset_id,actions,cost_per_action_type&action_breakdowns=action_type&action_report_time=conversion&action_attribution_windows=default&time_range={'since':'${startDate.toISOString().split('T')[0]}','until':'${endDate.toISOString().split('T')[0]}'}&level=adset&access_token=${accessToken}`;
      
      const adSetInsightsData = await fetchWithRetryAndPaging(adSetInsightsUrl);
      
      if (adSetInsightsData.error) {
        throw new Error(`Graph API Error: ${adSetInsightsData.error.message}`);
      }
      
      adSetInsights = adSetInsightsData.data || [];
      console.log("Adset-level insights fetched successfully:", adSetInsights.length);

      // Fetch campaign-level insights for campaigns processing
      const campaignInsightsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/insights?fields=impressions,clicks,spend,ctr,cpc,reach,frequency,campaign_id,actions,cost_per_action_type&action_breakdowns=action_type&action_report_time=conversion&action_attribution_windows=default&time_range={'since':'${startDate.toISOString().split('T')[0]}','until':'${endDate.toISOString().split('T')[0]}'}&level=campaign&access_token=${accessToken}`;
      
      const campaignInsightsData = await fetchWithRetryAndPaging(campaignInsightsUrl);
      
      if (campaignInsightsData.error) {
        throw new Error(`Graph API Error: ${campaignInsightsData.error.message}`);
      }
      
      campaignInsights = campaignInsightsData.data || [];
      console.log("Campaign-level insights fetched successfully:", campaignInsights.length);
    } catch (insightsError: any) {
      console.error("Error fetching insights:", insightsError);
      throw new Error(`Failed to fetch insights: ${insightsError.message || 'Unknown error'}`);
    }

    // Process the data
    const adPerformance = await processCampaignData(campaigns, campaignInsights, adSets);
    const adSetsData = await processAdSetsData(adSets, adSetInsights, campaigns);
    const adsData = await processAdsData(ads, insights, adSets, campaigns);
    const campaignSummary = generateCampaignSummary(adPerformance);
    
    // Set cache-busting headers
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    
    res.json({
      adPerformance,
      adSetsData,
      adsData,
      campaignSummary,
      timeframe,
      timestamp: new Date().toISOString()
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
async function processCampaignData(campaigns: any, insights: any, adSets: any): Promise<any[]> {
  const campaignMap = new Map();
  
  // Create ad set to campaign mapping
  const adSetToCampaignMap = new Map();
  for (const adSet of adSets) {
    adSetToCampaignMap.set(adSet.id, adSet.campaign_id);
  }
  
  // Initialize campaigns with zero metrics
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
  
      // Process campaign-level insights directly
      for (const insight of insights) {
        const campaignId = insight.campaign_id;
        
        if (campaignMap.has(campaignId)) {
          const campaign = campaignMap.get(campaignId);
          
          // Use campaign-level metrics directly
          campaign.impressions = parseInt(insight.impressions) || 0;
          campaign.clicks = parseInt(insight.clicks) || 0;
          campaign.spend = parseFloat(insight.spend) || 0;
          campaign.reach = parseInt(insight.reach) || 0;
          
          // Debug: log actions for Lead Ad Campaign
          if (campaign.name === "Lead Ad Campaign | Landing Page" && insight.actions) {
            console.log("Lead Ad Campaign actions:", JSON.stringify(insight.actions, null, 2));
          }
          
          // Leads
          if (Array.isArray(insight.actions)) {
            for (const a of insight.actions) {
              if (WEBSITE_ACTIONS.has(a.action_type)) {
                campaign.websiteLeads = (campaign.websiteLeads || 0) + (parseInt(a.value) || 0);
                console.log(`Found website action ${a.action_type}: ${a.value} for campaign ${campaign.name}`);
              }
              if (FORM_ACTIONS.has(a.action_type)) {
                campaign.formLeads = (campaign.formLeads || 0) + (parseInt(a.value) || 0);
                console.log(`Found form action ${a.action_type}: ${a.value} for campaign ${campaign.name}`);
              }
            }
          }
      if (Array.isArray(insight.cost_per_action_type)) {
        for (const c of insight.cost_per_action_type) {
          if (WEBSITE_ACTIONS.has(c.action_type)) {
            campaign.costPerWebsiteLead = parseFloat(c.value) || 0;
          }
          if (FORM_ACTIONS.has(c.action_type)) {
            campaign.costPerFormLead = parseFloat(c.value) || 0;
          }
        }
      }
    }
  }
  
  // Calculate derived metrics (CTR, CPC) after aggregation
  for (const campaign of campaignMap.values()) {
    if (campaign.impressions > 0) {
      campaign.ctr = (campaign.clicks / campaign.impressions) * 100; // Convert to percentage
    }
    if (campaign.clicks > 0) {
      campaign.cpc = campaign.spend / campaign.clicks;
    }
    if (campaign.reach > 0) {
      campaign.frequency = campaign.impressions / campaign.reach;
    }
    // Derived
    if (campaign.websiteLeads > 0) {
      campaign.costPerWebsiteLead = campaign.costPerWebsiteLead || (campaign.spend / campaign.websiteLeads);
    }
    if (campaign.formLeads > 0) {
      campaign.costPerFormLead = campaign.costPerFormLead || (campaign.spend / campaign.formLeads);
    }
    campaign.totalLeads = (campaign.websiteLeads || 0) + (campaign.formLeads || 0);
    if (campaign.totalLeads > 0) {
      campaign.costPerLead = campaign.spend / campaign.totalLeads;
    }
  }
  
  // Return all campaigns regardless of activity
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
  console.log("Processing ad sets:", adSets.length);
  for (const adSet of adSets) {
    console.log(`AdSet: ${adSet.id} - ${adSet.name} (${adSet.status})`);
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
      websiteLeads: 0,
      costPerWebsiteLead: 0,
      formLeads: 0,
      costPerFormLead: 0,
      totalLeads: 0,
      costPerLead: 0,
      lastUpdated: new Date().toISOString(),
    });
  }
  
  // Process insights and merge with ad sets
  console.log("Processing adset insights:", insights.length);
  for (const insight of insights) {
    // For adset-level insights, the adset_id is directly available
    const adSetId = insight.adset_id;
    console.log(`Processing insight for adset ${adSetId}: spend=${insight.spend}, impressions=${insight.impressions}`);
    
    if (adSetsMap.has(adSetId)) {
      const adSet = adSetsMap.get(adSetId);
      adSet.impressions = parseInt(insight.impressions) || 0;
      adSet.clicks = parseInt(insight.clicks) || 0;
      adSet.spend = parseFloat(insight.spend) || 0;
      adSet.ctr = parseFloat(insight.ctr) || 0;
      adSet.cpc = parseFloat(insight.cpc) || 0;
      adSet.reach = parseInt(insight.reach) || 0;
      adSet.frequency = parseFloat(insight.frequency) || 0;
      if (Array.isArray(insight.actions)) {
        for (const a of insight.actions) {
          if (WEBSITE_ACTIONS.has(a.action_type)) {
            adSet.websiteLeads += (parseInt(a.value) || 0);
          }
          if (FORM_ACTIONS.has(a.action_type)) {
            adSet.formLeads += (parseInt(a.value) || 0);
          }
        }
      }
      if (Array.isArray(insight.cost_per_action_type)) {
        for (const c of insight.cost_per_action_type) {
          if (WEBSITE_ACTIONS.has(c.action_type)) {
            adSet.costPerWebsiteLead = parseFloat(c.value) || 0;
          }
          if (FORM_ACTIONS.has(c.action_type)) {
            adSet.costPerFormLead = parseFloat(c.value) || 0;
          }
        }
      }
      // Derived
      if (adSet.websiteLeads > 0) adSet.costPerWebsiteLead = adSet.costPerWebsiteLead || (adSet.spend / adSet.websiteLeads);
      if (adSet.formLeads > 0) adSet.costPerFormLead = adSet.costPerFormLead || (adSet.spend / adSet.formLeads);
      adSet.totalLeads = (adSet.websiteLeads || 0) + (adSet.formLeads || 0);
      if (adSet.totalLeads > 0) adSet.costPerLead = adSet.spend / adSet.totalLeads;
      console.log(`Updated adset ${adSetId} with spend: ${adSet.spend}`);
    } else {
      console.log(`Adset ${adSetId} not found in adSetsMap`);
    }
  }
  
  // Return all ad sets regardless of activity
  return Array.from(adSetsMap.values());
}

// Helper function to process ads data from Meta API
async function processAdsData(ads: any, insights: any, adSets: any, campaigns: any): Promise<any[]> {
  const adsMap = new Map();
  const adSetMap = new Map();
  const campaignMap = new Map();
  
  // Create ad set and campaign lookup maps
  for (const adSet of adSets) {
    adSetMap.set(adSet.id, adSet.name);
  }
  
  for (const campaign of campaigns) {
    campaignMap.set(campaign.id, campaign.name);
  }
  
  // Process ads
  for (const ad of ads) {
    adsMap.set(ad.id, {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      adSetId: ad.adset_id,
      adSetName: adSetMap.get(ad.adset_id) || 'Unknown Ad Set',
      campaignId: ad.campaign_id,
      campaignName: campaignMap.get(ad.campaign_id) || 'Unknown Campaign',
      creative: ad.creative,
      impressions: 0,
      clicks: 0,
      spend: 0,
      ctr: 0,
      cpc: 0,
      reach: 0,
      frequency: 0,
      websiteLeads: 0,
      costPerWebsiteLead: 0,
      formLeads: 0,
      costPerFormLead: 0,
      totalLeads: 0,
      costPerLead: 0,
      lastUpdated: new Date().toISOString(),
    });
  }
  
  // Process insights and merge with ads
  for (const insight of insights) {
    const adId = insight.ad_id;
    if (adsMap.has(adId)) {
      const ad = adsMap.get(adId);
      ad.impressions = parseInt(insight.impressions) || 0;
      ad.clicks = parseInt(insight.clicks) || 0;
      ad.spend = parseFloat(insight.spend) || 0;
      ad.ctr = parseFloat(insight.ctr) || 0;
      ad.cpc = parseFloat(insight.cpc) || 0;
      ad.reach = parseInt(insight.reach) || 0;
      ad.frequency = parseFloat(insight.frequency) || 0;
      if (Array.isArray(insight.actions)) {
        for (const a of insight.actions) {
          if (WEBSITE_ACTIONS.has(a.action_type)) {
            ad.websiteLeads += (parseInt(a.value) || 0);
          }
          if (FORM_ACTIONS.has(a.action_type)) {
            ad.formLeads += (parseInt(a.value) || 0);
          }
        }
      }
      if (Array.isArray(insight.cost_per_action_type)) {
        for (const c of insight.cost_per_action_type) {
          if (WEBSITE_ACTIONS.has(c.action_type)) {
            ad.costPerWebsiteLead = parseFloat(c.value) || 0;
          }
          if (FORM_ACTIONS.has(c.action_type)) {
            ad.costPerFormLead = parseFloat(c.value) || 0;
          }
        }
      }
      if (ad.websiteLeads > 0) ad.costPerWebsiteLead = ad.costPerWebsiteLead || (ad.spend / ad.websiteLeads);
      if (ad.formLeads > 0) ad.costPerFormLead = ad.costPerFormLead || (ad.spend / ad.formLeads);
      ad.totalLeads = (ad.websiteLeads || 0) + (ad.formLeads || 0);
      if (ad.totalLeads > 0) ad.costPerLead = ad.spend / ad.totalLeads;
    }
  }
  
  // Return all ads regardless of activity
  return Array.from(adsMap.values());
}

// Get campaigns and ad sets for ad creation
router.get("/campaigns-and-adsets", async (req, res) => {
  const userId = (req as any).user.userId;
  
  try {
    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Resolve ad account credentials (legacy field or connected account fallback)
    let adAccountId: string;
    let accessToken: string;
    try {
      ({ adAccountId, accessToken } = await resolveMetaCredentials(user));
    } catch (error: any) {
      return res.status(400).json({ message: error.message || "Ad account not configured" });
    }

    const apiVersion = process.env.META_API_VERSION || 'v25.0';

    // Fetch campaigns
    const campaignsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/campaigns?fields=id,name,status&access_token=${accessToken}`;
    const campaignsResponse = await fetch(campaignsUrl);
    const campaignsData = await campaignsResponse.json();

    if (campaignsData.error) {
      throw new Error(`Graph API Error: ${campaignsData.error.message}`);
    }

    // Fetch ad sets
    const adSetsUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adsets?fields=id,name,campaign_id,status&access_token=${accessToken}`;
    const adSetsResponse = await fetch(adSetsUrl);
    const adSetsData = await adSetsResponse.json();

    if (adSetsData.error) {
      throw new Error(`Graph API Error: ${adSetsData.error.message}`);
    }

    // First, get the business account associated with the ad account
    console.log("=== Fetching Business Account ===");
    console.log("Ad Account:", adAccountId);

    const businessUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}?fields=account_id,name,currency,timezone_name,business&access_token=${accessToken}`;
    console.log("Business URL:", businessUrl);
    
    const businessResponse = await fetch(businessUrl);
    const businessData = await businessResponse.json();
    
    console.log("Business API Response:", JSON.stringify(businessData, null, 2));
    
    if (businessData.error) {
      console.error("Business API Error:", businessData.error);
      throw new Error(`Business API Error: ${businessData.error.message}`);
    }
    
    const businessId = businessData.business?.id;
    if (!businessId) {
      throw new Error("No business account found for this ad account.");
    }
    
    console.log("Business ID:", businessId);
    
    // Now fetch pages from the business portfolio
    console.log("=== Fetching Pages from Business Portfolio ===");
    const pagesUrl = `https://graph.facebook.com/${apiVersion}/${businessId}/owned_pages?fields=id,name,category&access_token=${accessToken}`;
    console.log("Pages URL:", pagesUrl);
    
    const pagesResponse = await fetch(pagesUrl);
    const pagesData = await pagesResponse.json();
    
    console.log("Pages API Response:", JSON.stringify(pagesData, null, 2));
    
    if (pagesData.error) {
      console.error("Pages API Error:", pagesData.error);
      throw new Error(`Pages API Error: ${pagesData.error.message}`);
    }
    
    // Load all campaigns and ad sets (not just active ones)
    const allCampaigns = (campaignsData.data || []).map((campaign: any) => ({ 
      id: campaign.id, 
      name: campaign.name,
      status: campaign.status 
    }));
    const allAdSets = (adSetsData.data || []).map((adSet: any) => ({ 
      id: adSet.id, 
      name: adSet.name,
      campaign_id: adSet.campaign_id,
      status: adSet.status 
    }));
    const pages = (pagesData.data || []).map((page: any) => ({ id: page.id, name: page.name }));
    
    console.log("Processed campaigns:", allCampaigns.length);
    console.log("Processed ad sets:", allAdSets.length);
    console.log("Processed pages:", pages);
    console.log("Total pages found:", pages.length);
    
    res.json({
      campaigns: allCampaigns,
      adSets: allAdSets,
      pages: pages
    });
  } catch (error: any) {
    console.error("Error fetching campaigns and ad sets:", error);
    res.status(500).json({ 
      message: "Error fetching campaigns and ad sets",
      error: error.message || "Unknown error"
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/meta/ads-history/:taskId
// Returns all Meta ads created from result_files of the given task's executions.
// ---------------------------------------------------------------------------
router.get("/ads-history/:taskId", async (req, res) => {
  const userId = (req as any).user.userId;
  const { taskId } = req.params;

  try {
    const executions = await taskDb.getTaskExecutions(taskId);
    if (!executions) return res.json([]);

    const ads: any[] = [];
    for (const exec of executions) {
      if (exec.userId !== userId) continue;
      for (const file of exec.result_files || []) {
        if (file.meta_ad) {
          ads.push({
            ...file.meta_ad,
            imageUrl: file.url,
            filename: file.filename,
            executionId: exec.executionId,
          });
        }
      }
    }

    // Sort newest first
    ads.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(ads);
  } catch (error: any) {
    console.error("Error fetching Meta ads history:", error);
    res.status(500).json({ message: "Error fetching ads history", error: error.message });
  }
});

// Create Meta ad (legacy — uses shared server token + user.adAccount)
router.post("/create-ad", async (req, res) => {
  const userId = (req as any).user.userId;
  const { imageUrl, campaignId, adSetId, adName, adText, adHeadline, adDescription, adCallToAction, pageId, taskId, executionId } = req.body;
  
  try {
    // Validate required fields
    if (!imageUrl || !campaignId || !adSetId || !adName || !pageId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Get user from database
    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Resolve ad account credentials (legacy field or connected account fallback)
    let adAccountId: string;
    let accessToken: string;
    try {
      ({ adAccountId, accessToken } = await resolveMetaCredentials(user));
    } catch (error: any) {
      return res.status(400).json({ message: error.message || "Ad account not configured" });
    }

    const apiVersion = process.env.META_API_VERSION || 'v25.0';

    console.log("=== Creating Meta Ad ===");
    console.log("Received pageId:", pageId);
    console.log("Received adName:", adName);
    console.log("Received adSetId:", adSetId);
    console.log("Received imageUrl:", imageUrl);
    console.log("Creating ad with data:", { adName, adSetId, imageUrl, pageId });
    
    // First, verify the ad account exists and get its details
    console.log("=== Verifying Ad Account ===");
    const accountUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}?fields=account_id,name,currency,timezone_name,account_status&access_token=${accessToken}`;
    console.log("Account URL:", accountUrl);
    
    const accountResponse = await fetch(accountUrl);
    const accountData = await accountResponse.json();
    console.log("Account response:", JSON.stringify(accountData, null, 2));
    
    if (accountData.error) {
      console.error("Account verification error:", accountData.error);
      throw new Error(`Account verification failed: ${accountData.error.message}`);
    }
    
    console.log("Account verified:", accountData.name, "Status:", accountData.account_status);
    
    // Try uploading image to the ad account
    console.log("=== Uploading Image ===");
    const uploadUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adimages`;
    console.log("Upload URL:", uploadUrl);
    
    // Download the image
    console.log("=== Downloading Image ===");
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = await imageResponse.arrayBuffer();
    
    // Get file extension from URL for proper filename
    const urlParts = imageUrl.split('.');
    const extension = urlParts[urlParts.length - 1].split('?')[0]; // Remove query params
    
    // Meta adimages API only supports JPEG and PNG
    // Convert unsupported formats (like WebP) to JPEG
    let finalBuffer = imageBuffer;
    let finalExtension = extension;
    let finalMimeType = `image/${extension}`;
    
    if (extension === 'webp' || extension === 'gif' || extension === 'bmp' || extension === 'tiff') {
      console.log(`Converting ${extension} to JPEG for Meta compatibility`);
      try {
        // Try to use sharp for conversion
        const sharp = require('sharp');
        finalBuffer = await sharp(imageBuffer)
          .jpeg({ quality: 90 })
          .toBuffer();
        finalExtension = 'jpg';
        finalMimeType = 'image/jpeg';
        console.log(`Successfully converted ${extension} to JPEG`);
      } catch (sharpError) {
        console.log("Sharp not available, trying basic conversion");
        // Fallback: just use the original buffer but with JPEG MIME type
        finalBuffer = imageBuffer;
        finalExtension = 'jpg';
        finalMimeType = 'image/jpeg';
        console.log(`Using fallback conversion for ${extension}`);
      }
    }
    
    const filename = `ad_image.${finalExtension}`;
    const imageBlob = new Blob([finalBuffer], { type: finalMimeType });
    
    console.log("Image prepared for upload:", filename, "Size:", imageBlob.size, "bytes");
    
    // Upload the converted image
    const uploadData = new FormData();
    uploadData.append('filename', filename);
    uploadData.append('access_token', accessToken);
    uploadData.append('file', imageBlob, filename);
    
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      body: uploadData
    });
    
    const uploadResult = await uploadResponse.json();
    console.log("Image upload response:", JSON.stringify(uploadResult, null, 2));
    
    if (uploadResult.error) {
      console.error("Image upload error:", uploadResult.error);
      throw new Error(`Image upload failed: ${uploadResult.error.message}`);
    }
    
    const imageHash = uploadResult.images[Object.keys(uploadResult.images)[0]].hash;
    console.log("Image hash:", imageHash);
    
    // Create the ad creative with the image hash
    // Use object_story_spec for standard ad creatives (Dynamic Creative is deprecated)
    const creativeData = {
      name: `${adName} - Creative`,
      object_story_spec: {
        page_id: pageId,
        link_data: {
          image_hash: imageHash,
          link: "https://example.com", // Placeholder link
          message: adText || "",
          name: adHeadline || "",
          description: adDescription || "",
          call_to_action: adCallToAction ? {
            type: adCallToAction,
            value: {
              link: "https://example.com"
            }
          } : undefined
        }
      }
    };

    // Create the creative
    const creativeUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adcreatives`;
    const creativeResponse = await fetch(creativeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...creativeData,
        access_token: accessToken
      })
    });

    const creativeResult = await creativeResponse.json();
    
    console.log("Creative creation response:", creativeResult);
    
    if (creativeResult.error) {
      console.error("Creative API Error details:", creativeResult.error);
      
      // Check if it's a Dynamic Creative Ad Set issue
      if (creativeResult.error.error_subcode === 2446391) {
        throw new Error(`Creative API Error: This ad set is configured for Dynamic Creative, which has been deprecated. Please use a different ad set or create a new one without Dynamic Creative enabled. (Code: ${creativeResult.error.code})`);
      }
      
      throw new Error(`Creative API Error: ${creativeResult.error.message} (Code: ${creativeResult.error.code})`);
    }

    // Now create the ad using the creative ID
    const adData = {
      name: adName,
      adset_id: adSetId,
      creative: {
        creative_id: creativeResult.id
      },
      status: 'PAUSED' // Create in paused status for review
    };

    const createAdUrl = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/ads`;
    const createAdResponse = await fetch(createAdUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...adData,
        access_token: accessToken
      })
    });

    const createAdData = await createAdResponse.json();
    
    console.log("Ad creation response:", createAdData);
    
    if (createAdData.error) {
      console.error("Ad creation API Error details:", createAdData.error);
      throw new Error(`Graph API Error: ${createAdData.error.message} (Code: ${createAdData.error.code})`);
    }
    
    // Generate ad management URL using Facebook Ads Manager
    const adManagementUrl = `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${adAccountId}`;
    console.log("Ad Management URL:", adManagementUrl);
    
    // Record the ad creation in the existing image file in result_files
    try {
      const { taskId, executionId, sessionId } = req.body;
      if (taskId && executionId) {
        // Import taskDb to update the execution
        const { taskDb } = await import('../services/db');
        
        // Get the existing execution
        const existingExecution = await taskDb.getTaskExecutionById(executionId);
        
        if (existingExecution && existingExecution.userId === userId) {
          console.log("✅ Found existing execution, adding Meta ad info to image file");
          
          // Find the image file in result_files and add Meta ad information
          const currentResultFiles = existingExecution.result_files || [];
          const updatedResultFiles = currentResultFiles.map((file: any) => {
            if (file.url === imageUrl) {
              // Add Meta ad information to the existing image file
              return {
                ...file,
                meta_ad: {
                  adId: createAdData.id,
                  adName: adName,
                  campaignId: campaignId,
                  adSetId: adSetId,
                  pageId: pageId,
                  creativeId: creativeResult.id,
                  imageHash: imageHash,
                  managementUrl: adManagementUrl,
                  status: 'PAUSED',
                  createdAt: new Date().toISOString()
                }
              };
            }
            return file;
          });
          
          // Update the execution with the modified result files
          await taskDb.updateTaskExecution(executionId, {
            result_files: updatedResultFiles
          });
          
          console.log("✅ Meta ad information added to image file in result_files");
        } else {
          console.log("⚠️ Execution not found or access denied, cannot add ad info");
        }
      }

      // Add assistant message to chat session if sessionId is provided
      if (sessionId) {
        try {
          const { chatbotDb } = await import('../services/chatbotService');
          
          // Create assistant message about the ad creation
          const assistantMessage = {
            role: 'assistant' as const,
            content: `<p>✅ Great news! Your Meta Ad "<strong>${adName}</strong>" has been successfully created and is now live in your account.</p>
<p><strong>Ad Name:</strong> ${adName}<br>
<strong>Manage here:</strong> <a href="${adManagementUrl}" target="_blank">Facebook Business Manager</a></p>
<p>Would you like me to monitor its performance over the next few days and give you optimization suggestions? That way, we can ensure the updated creative works effectively.</p>`,
            metadata: {
              timestamp: new Date().toISOString(),
              portalType: 'agent' as const
            }
          };

          // Add message to session
          await chatbotDb.addMessageToSession(sessionId, assistantMessage);
          console.log("✅ Assistant message added to chat session about Meta ad creation");
        } catch (messageError) {
          console.error("Error adding assistant message to session:", messageError);
          // Don't fail the request if message addition fails
        }
      }
    } catch (recordError) {
      console.error("Error recording ad creation:", recordError);
      // Don't fail the request if recording fails
    }
    
    res.json({
      success: true,
      adId: createAdData.id,
      message: "Ad created successfully in paused status. Please review and publish in Facebook Business Manager.",
      managementUrl: adManagementUrl
    });
  } catch (error: any) {
    console.error("Error creating Meta ad:", error);
    
    // Return the actual error message from Meta API
    const errorMessage = error.message || "Unknown error";
    const statusCode = error.message?.includes('Graph API Error') || error.message?.includes('Creative API Error') || error.message?.includes('Image upload failed') ? 400 : 500;
    
    res.status(statusCode).json({ 
      message: errorMessage,
      error: errorMessage
    });
  }
});


export default router;
