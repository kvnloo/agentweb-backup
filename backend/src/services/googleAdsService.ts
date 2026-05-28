import axios from 'axios';
import { getGoogleAdsCredentials } from '../utils/secretsManager';
import { userDb } from './db';                          // sibling in services/
import { updateAccountTokens } from './connectedAccountsDb'; // sibling in services/

const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com/v18';
const TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleAdAccount {
  customerId: string;
  name: string;
  currency: string;
}

export interface GoogleAdsAccountCredentials {
  accessToken: string;
  customerId: string;
  currency: string;
}

export class GoogleAdsService {
  // Single-flight refresh guard: userId:accountId → in-flight promise
  private refreshInFlight = new Map<string, Promise<string>>();

  // ── Internal HTTP helper ─────────────────────────────────────────────────

  private async callApi(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    body?: any
  ): Promise<any> {
    const secrets = await getGoogleAdsCredentials();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': secrets.developerToken,
      'login-customer-id': secrets.managerCustomerId,
      'Content-Type': 'application/json',
    };
    const response = method === 'GET'
      ? await axios.get(`${GOOGLE_ADS_API_BASE}${path}`, { headers })
      : await axios.post(`${GOOGLE_ADS_API_BASE}${path}`, body, { headers });
    return response.data;
  }

  async search(customerId: string, accessToken: string, query: string): Promise<any[]> {
    const data = await this.callApi('POST', `/customers/${customerId}/googleAds:search`, accessToken, { query });
    return data.results || [];
  }

  async mutate(customerId: string, accessToken: string, resource: string, operations: any[]): Promise<any> {
    return this.callApi('POST', `/customers/${customerId}/${resource}:mutate`, accessToken, { operations });
  }

  makeAuthError(message: string): Error {
    const err = new Error(message);
    (err as any).isGoogleAdsAuthError = true;
    return err;
  }

  // ── Token refresh (single-flight) ────────────────────────────────────────

  private async refreshAccessToken(userId: string, accountId: string, refreshToken: string): Promise<string> {
    const key = `${userId}:${accountId}`;
    if (this.refreshInFlight.has(key)) {
      return this.refreshInFlight.get(key)!;
    }
    const promise = (async () => {
      const secrets = await getGoogleAdsCredentials();
      const response = await axios.post(TOKEN_REFRESH_URL, new URLSearchParams({
        client_id: secrets.clientId,
        client_secret: secrets.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const { access_token, expires_in } = response.data as { access_token: string; expires_in: number };
      await updateAccountTokens(userId, 'google_ads', {
        access_token,
        token_expires_at: Date.now() + expires_in * 1000,
      }, accountId);
      return access_token;
    })();
    this.refreshInFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.refreshInFlight.delete(key);
    }
  }

  // ── Account credentials + ownership validation ───────────────────────────

  async getAccountCredentials(userId: string, customerId: string): Promise<GoogleAdsAccountCredentials> {
    const user = await userDb.getUserById(userId);
    if (!user) throw this.makeAuthError('User not found');

    const accounts: any[] = Array.isArray(user.connected_accounts)
      ? user.connected_accounts
      : user.connected_accounts ? [user.connected_accounts] : [];

    const account = accounts.find(
      (a: any) => a.platform === 'google_ads' && a.config?.customer_id === customerId
    );
    if (!account) throw this.makeAuthError('Google Ads account not found in your connected accounts. Connect it in Settings.');

    let accessToken = account.config.access_token;
    const isExpired = account.config.token_expires_at && Date.now() > account.config.token_expires_at - 60_000;
    if (isExpired && account.config.refresh_token) {
      accessToken = await this.refreshAccessToken(userId, account.account_id, account.config.refresh_token);
    }

    if (!accessToken) {
      throw this.makeAuthError('No access token available. Please reconnect your Google Ads account in Settings.');
    }

    return { accessToken, customerId, currency: account.config.currency || 'USD' };
  }

  // ── Account listing (used during OAuth finalize) ─────────────────────────

  async listAccessibleAccounts(accessToken: string): Promise<GoogleAdAccount[]> {
    const secrets = await getGoogleAdsCredentials();
    const response = await axios.get(`${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': secrets.developerToken,
      },
    });

    const resourceNames: string[] = (response.data as { resourceNames?: string[] }).resourceNames || [];
    if (resourceNames.length === 0) return [];

    const accounts: GoogleAdAccount[] = [];
    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const results = await this.search(customerId, accessToken,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1'
        );
        if (results.length > 0) {
          const c = results[0].customer;
          accounts.push({ customerId: String(c.id), name: c.descriptiveName || customerId, currency: c.currencyCode || 'USD' });
        }
      } catch {
        accounts.push({ customerId, name: customerId, currency: 'USD' });
      }
    }
    return accounts;
  }

  // ── Budgets ──────────────────────────────────────────────────────────────

  async createBudget(userId: string, customerId: string, params: {
    name: string;
    amountMicros: number;
  }): Promise<{ resourceName: string }> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const data = await this.mutate(customerId, accessToken, 'campaignBudgets', [{
      create: {
        name: params.name,
        amountMicros: String(params.amountMicros),
        deliveryMethod: 'STANDARD',
      },
    }]);
    return { resourceName: data.results[0].resourceName };
  }

  // ── Campaigns ────────────────────────────────────────────────────────────

  async listCampaigns(userId: string, customerId: string): Promise<{ resourceName: string; id: string; name: string; status: string; type: string }[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign ORDER BY campaign.id'
    );
    return results.map((r: any) => ({
      resourceName: r.campaign.resourceName,
      id: String(r.campaign.id),
      name: r.campaign.name,
      status: r.campaign.status,
      type: r.campaign.advertisingChannelType,
    }));
  }

  async createCampaign(userId: string, customerId: string, params: {
    name: string;
    type: 'SEARCH' | 'DISPLAY' | 'PERFORMANCE_MAX';
    budgetResourceName: string;
    biddingStrategy: 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA' | 'TARGET_ROAS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_IMPRESSION_SHARE' | 'MANUAL_CPC';
    biddingStrategyTarget?: number;
    locationTargetIds: number[];
    status?: 'ENABLED' | 'PAUSED';
  }): Promise<{ resourceName: string }> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);

    const biddingField: Record<string, any> = {};
    if (params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') biddingField.maximizeConversions = {};
    else if (params.biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') biddingField.maximizeConversionValue = {};
    else if (params.biddingStrategy === 'TARGET_CPA') biddingField.targetCpa = { targetCpaMicros: String(Math.round((params.biddingStrategyTarget || 0) * 1_000_000)) };
    else if (params.biddingStrategy === 'TARGET_ROAS') biddingField.targetRoas = { targetRoas: params.biddingStrategyTarget || 1 };
    else if (params.biddingStrategy === 'TARGET_IMPRESSION_SHARE') biddingField.targetImpressionShare = {};
    else if (params.biddingStrategy === 'MANUAL_CPC') biddingField.manualCpc = {};

    const data = await this.mutate(customerId, accessToken, 'campaigns', [{
      create: {
        name: params.name,
        advertisingChannelType: params.type,
        campaignBudget: params.budgetResourceName,
        status: params.status || 'PAUSED',
        ...biddingField,
      },
    }]);

    const campaignResourceName = data.results[0].resourceName;

    if (params.locationTargetIds.length > 0) {
      await this.mutate(customerId, accessToken, 'campaignCriteria', params.locationTargetIds.map(id => ({
        create: {
          campaign: campaignResourceName,
          location: { geoTargetConstant: `geoTargetConstants/${id}` },
        },
      })));
    }

    return { resourceName: campaignResourceName };
  }

  async updateCampaign(userId: string, customerId: string, campaignResourceName: string, params: {
    name?: string;
    status?: 'ENABLED' | 'PAUSED';
  }): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: campaignResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (updateMask.length === 0) return; // nothing to update — avoid no-op API call
    await this.mutate(customerId, accessToken, 'campaigns', [{ update, updateMask: updateMask.join(',') }]);
  }

  async pauseCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    return this.updateCampaign(userId, customerId, campaignResourceName, { status: 'PAUSED' });
  }

  async resumeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    return this.updateCampaign(userId, customerId, campaignResourceName, { status: 'ENABLED' });
  }

  // ── Location search ───────────────────────────────────────────────────────

  async searchLocations(userId: string, customerId: string, query: string, locale: string = 'en'): Promise<{ id: string; name: string; countryCode: string; targetType: string }[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const secrets = await getGoogleAdsCredentials();
    const response = await axios.post(`${GOOGLE_ADS_API_BASE}/geoTargetConstants:suggest`, { locale, query }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': secrets.developerToken,
        'login-customer-id': secrets.managerCustomerId,
      },
    });
    const responseData = response.data as { geoTargetConstantSuggestions?: any[] };
    return (responseData.geoTargetConstantSuggestions || []).map((s: any) => ({
      id: String(s.geoTargetConstant.id),
      name: s.geoTargetConstant.name,
      countryCode: s.geoTargetConstant.countryCode,
      targetType: s.geoTargetConstant.targetType,
    }));
  }

  // ── Ad Groups ────────────────────────────────────────────────────────────

  async listAdGroups(userId: string, customerId: string, campaignResourceName: string): Promise<any[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      `SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status, ad_group.type FROM ad_group WHERE ad_group.campaign = '${campaignResourceName}'`
    );
    return results.map((r: any) => ({
      resourceName: r.adGroup.resourceName,
      id: String(r.adGroup.id),
      name: r.adGroup.name,
      status: r.adGroup.status,
      type: r.adGroup.type,
    }));
  }

  async createAdGroup(userId: string, customerId: string, params: {
    name: string;
    campaignResourceName: string;
    type: 'SEARCH_STANDARD' | 'DISPLAY_STANDARD';
    cpcBidMicros?: number;
  }): Promise<{ resourceName: string }> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const data = await this.mutate(customerId, accessToken, 'adGroups', [{
      create: {
        name: params.name,
        campaign: params.campaignResourceName,
        status: 'ENABLED',
        type: params.type,
        ...(params.cpcBidMicros !== undefined && { cpcBidMicros: String(params.cpcBidMicros) }),
      },
    }]);
    return { resourceName: data.results[0].resourceName };
  }

  async updateAdGroup(userId: string, customerId: string, adGroupResourceName: string, params: {
    name?: string;
    status?: 'ENABLED' | 'PAUSED';
    cpcBidMicros?: number;
  }): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: adGroupResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.cpcBidMicros !== undefined) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
    if (updateMask.length === 0) return;
    await this.mutate(customerId, accessToken, 'adGroups', [{ update, updateMask: updateMask.join(',') }]);
  }

  // ── Keywords ─────────────────────────────────────────────────────────────

  async addKeywords(userId: string, customerId: string, adGroupResourceName: string, keywords: {
    text: string;
    matchType: 'BROAD' | 'PHRASE' | 'EXACT';
  }[]): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
      create: {
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        keyword: { text: kw.text, matchType: kw.matchType },
      },
    })));
  }

  async addNegativeKeywords(userId: string, customerId: string, target: {
    campaignResourceName?: string;
    adGroupResourceName?: string;
  }, keywords: { text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }[]): Promise<void> {
    if (!target.campaignResourceName && !target.adGroupResourceName) {
      throw new Error('addNegativeKeywords requires either campaignResourceName or adGroupResourceName');
    }
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    if (target.campaignResourceName) {
      await this.mutate(customerId, accessToken, 'campaignCriteria', keywords.map(kw => ({
        create: {
          campaign: target.campaignResourceName,
          negative: true,
          keyword: { text: kw.text, matchType: kw.matchType },
        },
      })));
    } else if (target.adGroupResourceName) {
      await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
        create: {
          adGroup: target.adGroupResourceName,
          negative: true,
          keyword: { text: kw.text, matchType: kw.matchType },
        },
      })));
    }
  }

  // ── Ads ──────────────────────────────────────────────────────────────────

  async listAds(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type FROM ad_group_ad WHERE ad_group_ad.ad_group = '${adGroupResourceName}'`
    );
    return results.map((r: any) => ({
      resourceName: r.adGroupAd.resourceName,
      adId: String(r.adGroupAd.ad.id),
      status: r.adGroupAd.status,
      type: r.adGroupAd.ad.type,
    }));
  }

  async createAd(userId: string, customerId: string, params: {
    adGroupResourceName: string;
    type: 'RESPONSIVE_SEARCH_AD' | 'RESPONSIVE_DISPLAY_AD';
    headlines: string[];
    descriptions: string[];
    finalUrl: string;
    imageAssetResourceNames?: string[];
  }): Promise<{ resourceName: string }> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);

    let adContent: any;
    if (params.type === 'RESPONSIVE_SEARCH_AD') {
      adContent = {
        responsiveSearchAd: {
          headlines: params.headlines.map(text => ({ text })),
          descriptions: params.descriptions.map(text => ({ text })),
        },
      };
    } else {
      adContent = {
        responsiveDisplayAd: {
          headlines: params.headlines.map(text => ({ text })),
          descriptions: params.descriptions.map(text => ({ text })),
          ...(params.imageAssetResourceNames && {
            marketingImages: params.imageAssetResourceNames.map(asset => ({ asset })),
          }),
        },
      };
    }

    const data = await this.mutate(customerId, accessToken, 'adGroupAds', [{
      create: {
        adGroup: params.adGroupResourceName,
        status: 'ENABLED',
        ad: { ...adContent, finalUrls: [params.finalUrl] },
      },
    }]);
    return { resourceName: data.results[0].resourceName };
  }

  // ── Assets ───────────────────────────────────────────────────────────────

  async uploadAsset(userId: string, customerId: string, asset: {
    type: 'IMAGE' | 'LOGO' | 'VIDEO';
    name: string;
    data: Buffer | string;
  }): Promise<string> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);

    const assetContent: any = {};
    if (asset.type === 'IMAGE' || asset.type === 'LOGO') {
      if (typeof asset.data === 'string') {
        throw new Error('IMAGE/LOGO asset data must be a Buffer, not a string');
      }
      assetContent.imageAsset = { data: asset.data.toString('base64') };
    } else {
      // VIDEO: data is a YouTube video ID string
      if (Buffer.isBuffer(asset.data)) {
        throw new Error('VIDEO asset data must be a YouTube video ID string, not a Buffer');
      }
      assetContent.youtubeVideoAsset = { youtubeVideoId: asset.data };
    }

    const data = await this.mutate(customerId, accessToken, 'assets', [{
      create: { name: asset.name, type: asset.type, ...assetContent },
    }]);
    return data.results[0].resourceName;
  }

  // ── Asset Groups (PMax) ───────────────────────────────────────────────────

  private async createTextAsset(customerId: string, accessToken: string, text: string): Promise<string> {
    const data = await this.mutate(customerId, accessToken, 'assets', [{
      create: { name: text.substring(0, 50), type: 'TEXT', textAsset: { text } },
    }]);
    return data.results[0].resourceName;
  }

  async createAssetGroup(userId: string, customerId: string, params: {
    name: string;
    campaignResourceName: string;
    headlines: string[];
    longHeadlines: string[];
    descriptions: string[];
    squareImageAssets: string[];
    landscapeImageAssets: string[];
    logoAssets: string[];
    videoAssets?: string[];
    finalUrl: string;
  }): Promise<{ resourceName: string }> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);

    const assetGroupData = await this.mutate(customerId, accessToken, 'assetGroups', [{
      create: {
        name: params.name,
        campaign: params.campaignResourceName,
        status: 'ENABLED',
        finalUrls: [params.finalUrl],
      },
    }]);
    const assetGroupResourceName = assetGroupData.results[0].resourceName;

    const headlineResourceNames = await Promise.all(params.headlines.map(t => this.createTextAsset(customerId, accessToken, t)));
    const longHeadlineResourceNames = await Promise.all(params.longHeadlines.map(t => this.createTextAsset(customerId, accessToken, t)));
    const descriptionResourceNames = await Promise.all(params.descriptions.map(t => this.createTextAsset(customerId, accessToken, t)));

    type AssetFieldType = 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION' | 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE' | 'LOGO' | 'YOUTUBE_VIDEO';
    const assetLinkOps: any[] = [];

    const addLinks = (resourceNames: string[], fieldType: AssetFieldType) => {
      for (const asset of resourceNames) {
        assetLinkOps.push({ create: { assetGroup: assetGroupResourceName, asset, fieldType } });
      }
    };

    addLinks(headlineResourceNames, 'HEADLINE');
    addLinks(longHeadlineResourceNames, 'LONG_HEADLINE');
    addLinks(descriptionResourceNames, 'DESCRIPTION');
    addLinks(params.squareImageAssets, 'SQUARE_MARKETING_IMAGE');
    addLinks(params.landscapeImageAssets, 'MARKETING_IMAGE');
    addLinks(params.logoAssets, 'LOGO');
    if (params.videoAssets) addLinks(params.videoAssets, 'YOUTUBE_VIDEO');

    if (assetLinkOps.length > 0) {
      await this.mutate(customerId, accessToken, 'assetGroupAssets', assetLinkOps);
    }

    return { resourceName: assetGroupResourceName };
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  async queryReporting(userId: string, customerId: string, gaqlQuery: string): Promise<any[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    return this.search(customerId, accessToken, gaqlQuery);
  }

  async getQuickMetrics(userId: string, customerId: string, options: {
    campaignIds?: string[];
    datePreset?: string;
  }): Promise<{ campaigns: any[]; totals: any; currency: string }> {
    const { accessToken, currency } = await this.getAccountCredentials(userId, customerId);
    const dateClause = options.datePreset ? `DURING ${options.datePreset}` : 'DURING LAST_30_DAYS';
    const whereClause = options.campaignIds?.length
      ? `WHERE campaign.id IN (${options.campaignIds.join(',')}) AND segments.date ${dateClause}`
      : `WHERE segments.date ${dateClause}`;

    const query = `SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc FROM campaign ${whereClause} ORDER BY metrics.cost_micros DESC`;
    const results = await this.search(customerId, accessToken, query);

    const campaigns = results.map((r: any) => {
      const m = r.metrics;
      const spend = Number(m.costMicros || 0) / 1_000_000;
      const clicks = Number(m.clicks || 0);
      const impressions = Number(m.impressions || 0);
      return {
        id: String(r.campaign.id),
        name: r.campaign.name,
        status: r.campaign.status,
        impressions,
        clicks,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        spendFormatted: spend.toFixed(2),
        conversions: Number(m.conversions || 0),
        avgCpc: clicks > 0 ? (spend / clicks).toFixed(2) : '0.00',
      };
    });

    const totals = campaigns.reduce((acc, c) => ({
      impressions: acc.impressions + c.impressions,
      clicks: acc.clicks + c.clicks,
      spend: acc.spend + parseFloat(c.spendFormatted),
      conversions: acc.conversions + c.conversions,
    }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });

    return { campaigns, totals, currency };
  }
}

export const googleAdsService = new GoogleAdsService();
