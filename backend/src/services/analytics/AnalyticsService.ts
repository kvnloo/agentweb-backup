
import { ToolService } from '../../tools/ServiceRegistry';
import { userDb } from '../db';
import { getMetaAccessToken } from '../../utils/secretsManager';
import { fetchWithRetryAndPaging } from '../../utils/metaApiFetch';

/**
 * Analytics Service
 * Manages analytics for Meta Ads, Task Subscribers, and Connected Accounts.
 */
export class AnalyticsService implements ToolService {
  readonly serviceName = 'analytics';

  /**
   * Get Meta Ads Metrics
   */
  async getMetaAdsMetrics(timeframe: string, userId: string, campaign_name?: string): Promise<any> {
    try {
      // Get user from database
      const user = await userDb.getUserById(userId);
      if (!user) {
        return {
          success: false,
          message: 'User not found',
          error: 'User not found'
        };
      }

      // Check if user has ad account configured
      if (!user.adAccount || user.adAccount.trim() === "") {
        return {
          success: false,
          message: 'Ad account not configured. Please configure your Meta ad account first.',
          error: 'Ad account not configured'
        };
      }

      // Get Meta API access token from Secrets Manager
      let accessToken: string;
      try {
        accessToken = await getMetaAccessToken();
      } catch (error: any) {
        console.error('AnalyticsService: Error fetching Meta access token:', error);
        return {
          success: false,
          message: 'Meta access token not configured. Please contact your administrator.',
          error: error.message || 'Failed to fetch access token from Secrets Manager'
        };
      }

      // Get API version from environment or default to v18.0
      const apiVersion = process.env.META_API_VERSION || 'v18.0';

      // Calculate date range based on timeframe
      const endDate = new Date();
      endDate.setDate(endDate.getDate() - 1); // Set to yesterday
      const startDate = new Date(endDate); // Copy endDate
      
      if (timeframe === "7d") {
        startDate.setDate(endDate.getDate() - 6);
      } else if (timeframe === "14d") {
        startDate.setDate(endDate.getDate() - 13);
      } else if (timeframe === "30d") {
        startDate.setDate(endDate.getDate() - 29);
      } else if (timeframe === "90d") {
        startDate.setDate(endDate.getDate() - 89);
      }
      
      const sinceStr = startDate.toISOString().split('T')[0];
      const untilStr = endDate.toISOString().split('T')[0];
      const attributionDays = Math.max(1, Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))) + 1;

      // First, get campaigns to find matching campaign IDs if filtering by campaign name
      let campaignFilterIds: string[] = [];
      if (campaign_name) {
        console.log('AnalyticsService: Getting campaigns to find matching IDs for:', campaign_name);
        const campaignsData = await fetchWithRetryAndPaging(`https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/campaigns?fields=id,name,status,objective&access_token=${accessToken}`);

        if (campaignsData.error) {
          throw new Error(`Campaigns API Error: ${campaignsData.error.message}`);
        }

        const matchingCampaigns = (campaignsData.data || []).filter((campaign: any) =>
          campaign.name && campaign.name.toLowerCase().includes(campaign_name.toLowerCase())
        );

        if (matchingCampaigns.length === 0) {
          return {
            success: true,
            message: `No campaigns found matching "${campaign_name}"`,
            metrics: {
              spend: 0,
              impressions: 0,
              clicks: 0,
              cpc: 0,
              ctr: 0,
              conversions: 0
            },
            campaigns: []
          };
        }

        campaignFilterIds = matchingCampaigns.map((c: any) => c.id);
        console.log(`AnalyticsService: Found ${campaignFilterIds.length} matching campaigns`);
      }

      // Construct metrics query
      let insightsUrl = `https://graph.facebook.com/${apiVersion}/act_${user.adAccount}/insights?fields=campaign_name,spend,impressions,clicks,cpc,ctr,actions&time_range={'since':'${sinceStr}','until':'${untilStr}'}&access_token=${accessToken}`;

      if (campaignFilterIds.length > 0) {
        insightsUrl += `&filtering=[{'field':'campaign.id','operator':'IN','value':[${campaignFilterIds.map(id => `'${id}'`).join(',')}]}]`;
      }

      console.log('AnalyticsService: Fetching insights...');
      const insightsData = await fetchWithRetryAndPaging(insightsUrl);

      if (insightsData.error) {
        throw new Error(`Insights API Error: ${insightsData.error.message}`);
      }

      // Aggregate metrics
      let totalSpend = 0;
      let totalImpressions = 0;
      let totalClicks = 0;
      let totalConversions = 0;

      const campaigns = (insightsData.data || []).map((row: any) => {
        const spend = parseFloat(row.spend || 0);
        const impressions = parseInt(row.impressions || 0);
        const clicks = parseInt(row.clicks || 0);
        
        totalSpend += spend;
        totalImpressions += impressions;
        totalClicks += clicks;

        // Count conversions (purchase, lead, etc.)
        let conversions = 0;
        if (row.actions) {
          row.actions.forEach((action: any) => {
             // simplified conversion logic
             if (['purchase', 'lead', 'complete_registration'].includes(action.action_type)) {
               conversions += parseInt(action.value);
             }
          });
        }
        totalConversions += conversions;

        return {
          campaign_name: row.campaign_name,
          spend,
          impressions,
          clicks,
          cpc: row.cpc ? parseFloat(row.cpc) : 0,
          ctr: row.ctr ? parseFloat(row.ctr) : 0,
          conversions
        };
      });

      const aggregatedMetrics = {
        spend: totalSpend,
        impressions: totalImpressions,
        clicks: totalClicks,
        cpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
        ctr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
        conversions: totalConversions,
        timeframe,
        startDate: sinceStr,
        endDate: untilStr
      };

      return {
        success: true,
        message: `Successfully retrieved Meta Ads metrics for last ${attributionDays} days`,
        metrics: aggregatedMetrics,
        campaigns: campaigns
      };

    } catch (error: any) {
      console.error('AnalyticsService: Error getting Meta Ads metrics:', error);
      return {
        success: false,
        message: 'Failed to get Meta Ads metrics',
        error: error.message
      };
    }
  }

  /**
   * Get Task Subscriber Metrics
   */
  async getTaskSubscriberMetrics(taskId: string, userId: string): Promise<any> {
    try {
      const { TaskSubscriberMetricsService } = await import('../taskSubscriberMetricsService');
      const metrics = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);
      return metrics;
    } catch (error: any) {
       console.error('AnalyticsService: Error getting subscriber metrics:', error);
       return { success: false, message: 'Failed to get subscriber metrics', error: error.message };
    }
  }

  /**
   * Get Task Subscriber Engagement Events
   */
  async getTaskSubscriberEngagementEvents(taskId: string, emailSubject: string | undefined, userId: string): Promise<any> {
    try {
      const { TaskSubscriberMetricsService } = await import('../taskSubscriberMetricsService');
      const events = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);
      return events;
    } catch (error: any) {
      console.error('AnalyticsService: Error getting engagement events:', error);
      return { success: false, message: 'Failed to get engagement events', error: error.message };
    }
  }

  /**
   * List Connected Accounts
   */
  async listConnectedAccounts(userId: string, platform: string = 'all'): Promise<any> {
    try {
      const { getAccountsByUserId, isTokenValid } = await import('../connectedAccountsDb');

      let accounts = await getAccountsByUserId(userId);

      if (platform && platform !== 'all') {
        accounts = accounts.filter(acc => acc.platform === platform);
      }

      return {
        success: true,
        message: `Found ${accounts.length} connected account(s)`,
        accounts: await Promise.all(accounts.map(async acc => ({
          id: acc.account_id,
          platform: acc.platform,
          account_name: acc.account_name,
          account_type: acc.config.account_type,
          is_active: await isTokenValid(acc)
        })))
      };
    } catch (error: any) {
      console.error('AnalyticsService: Error listing connected accounts:', error);
      return { success: false, message: 'Failed to list connected accounts', error: error.message };
    }
  }

  /**
   * Load Connected Account Metrics
   */
  async loadConnectedAccountMetrics(userId: string, accountId: string): Promise<any> {
    try {
      const { getAccountById, isTokenValid } = await import('../connectedAccountsDb');
      const { socialPlatformService } = await import('../../socialPlatformService');

      const account = await getAccountById(accountId, userId);
      if (!account) {
        return { success: false, message: 'Account not found or access denied' };
      }

      if (!(await isTokenValid(account))) {
        return { success: false, message: 'Account token expired' };
      }

      const adapter = socialPlatformService.getAdapter(account.platform);
      const metrics = await adapter.getAccountMetrics(account);

      return {
        success: true,
        metrics
      };
    } catch (error: any) {
      console.error('AnalyticsService: Error loading account metrics:', error);
      return { success: false, message: 'Failed to load metrics', error: error.message };
    }
  }

  /**
   * List Connected Account Posts
   */
  async listConnectedAccountPosts(userId: string, accountId: string, options: any): Promise<any> {
    try {
      const { getAccountById, isTokenValid } = await import('../connectedAccountsDb');
      const { socialPlatformService } = await import('../../socialPlatformService');
      
      const account = await getAccountById(accountId, userId);
      if (!account) {
        return { success: false, message: 'Account not found or access denied' };
      }

       if (!(await isTokenValid(account))) {
        return { success: false, message: 'Account token expired' };
      }

      const adapter = socialPlatformService.getAdapter(account.platform);
      const posts = await adapter.getPosts(account, options?.limit || 10);
      
      return {
        success: true,
        posts
      };

    } catch (error: any) {
      console.error('AnalyticsService: Error listing account posts:', error);
      return { success: false, message: 'Failed to list posts', error: error.message };
    }
  }
}

// Singleton instance
export const analyticsService = new AnalyticsService();
