import axios from 'axios';
import { getGoogleAdsCredentials } from '../utils/secretsManager';
import { assertPublicHostname } from '../utils/ssrfGuard';
import { userDb } from './db';                          // sibling in services/
import { updateAccountTokens } from './connectedAccountsDb'; // sibling in services/

const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com/v24';
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
    body?: any,
  ): Promise<any> {
    const secrets = await getGoogleAdsCredentials();
    const loginCustomerId = path.match(/\/customers\/(\d+)\//)?.[1];
    if (!loginCustomerId) throw new Error('Could not determine login-customer-id for Google Ads API call');
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': secrets.developerToken,
      'login-customer-id': loginCustomerId,
      'Content-Type': 'application/json',
    };
    const url = `${GOOGLE_ADS_API_BASE}${path}`;
    if (process.env.NODE_ENV !== 'production') {
      console.log('[GoogleAds] callApi request:', method, url, body ? JSON.stringify(body, null, 2) : '(no body)');
    }
    try {
      const response = method === 'GET'
        ? await axios.get(url, { headers })
        : await axios.post(url, body, { headers });
      if (process.env.NODE_ENV !== 'production') {
        console.log('[GoogleAds] callApi response:', JSON.stringify(response.data, null, 2));
      }
      return response.data;
    } catch (err: any) {
      const detail = err?.response?.data;
      console.error('[GoogleAds] callApi error:', JSON.stringify(detail, null, 2));
      throw err;
    }
  }

  async search(customerId: string, accessToken: string, query: string): Promise<any[]> {
    const MAX_PAGES = 50; // safety cap (~500k rows at the default page size) to avoid a runaway loop
    const all: any[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const body: any = { query };
      if (pageToken) body.pageToken = pageToken;
      const data = await this.callApi('POST', `/customers/${customerId}/googleAds:search`, accessToken, body);
      if (data.results) all.push(...data.results);
      pageToken = data.nextPageToken;
      pages++;
    } while (pageToken && pages < MAX_PAGES);
    return all;
  }

  async mutate(customerId: string, accessToken: string, resource: string, operations: any[]): Promise<any> {
    return this.callApi('POST', `/customers/${customerId}/${resource}:mutate`, accessToken, { operations });
  }

  async batchMutate(customerId: string, accessToken: string, mutateOperations: any[]): Promise<any> {
    return this.callApi('POST', `/customers/${customerId}/googleAds:mutate`, accessToken, { mutateOperations });
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

    return {
      accessToken,
      customerId,
      currency: account.config.currency || 'USD',
    };
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
    const seenIds = new Set<string>();

    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const results = await this.search(customerId, accessToken,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1'
        );
        if (results.length === 0) continue;
        const c = results[0].customer;
        const isManager = c.manager === true;

        if (!isManager && !seenIds.has(String(c.id))) {
          seenIds.add(String(c.id));
          accounts.push({ customerId: String(c.id), name: c.descriptiveName || customerId, currency: c.currencyCode || 'USD' });
        }
      } catch {
        // Skip accounts we can't query
      }
    }
    return accounts;
  }

  // ── Budgets ──────────────────────────────────────────────────────────────

  async createBudget(userId: string, customerId: string, params: {
    name: string;
    amountMicros: number;
    explicitlyShared?: boolean;
  }): Promise<{ resourceName: string }> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const data = await this.mutate(customerId, accessToken, 'campaignBudgets', [{
      create: {
        name: params.name,
        amountMicros: String(params.amountMicros),
        deliveryMethod: 'STANDARD',
        explicitlyShared: params.explicitlyShared ?? false,
      },
    }]);
    return { resourceName: data.results[0].resourceName };
  }

  async updateBudget(userId: string, customerId: string, budgetResourceName: string, amountMicros: number): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignBudgets', [{
      update: { resourceName: budgetResourceName, amountMicros: String(amountMicros) },
      updateMask: 'amount_micros',
    }]);
  }

  async removeBudget(userId: string, customerId: string, budgetResourceName: string): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignBudgets', [{ remove: budgetResourceName }]);
  }

  // ── Campaigns ────────────────────────────────────────────────────────────

  async listCampaigns(userId: string, customerId: string): Promise<{ resourceName: string; id: string; name: string; status: string; type: string }[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign ORDER BY campaign.id',
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
    brandBusinessName?: string;
    brandLogoAssetResourceName?: string;
  }): Promise<{ resourceName: string }> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);

    // DISPLAY campaigns cannot use MAXIMIZE_CONVERSIONS with a shared budget
    if (params.type === 'DISPLAY' && params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') {
      throw new Error('DISPLAY campaigns do not support MAXIMIZE_CONVERSIONS with a shared budget. Use MANUAL_CPC or TARGET_CPA instead.');
    }

    const biddingField: Record<string, any> = {};
    if (params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') biddingField.maximizeConversions = {};
    else if (params.biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') biddingField.maximizeConversionValue = {};
    else if (params.biddingStrategy === 'TARGET_CPA') biddingField.targetCpa = { targetCpaMicros: String(Math.round((params.biddingStrategyTarget || 0) * 1_000_000)) };
    else if (params.biddingStrategy === 'TARGET_ROAS') biddingField.targetRoas = { targetRoas: params.biddingStrategyTarget || 1 };
    else if (params.biddingStrategy === 'TARGET_IMPRESSION_SHARE') biddingField.targetImpressionShare = {
      location: 'ANYWHERE_ON_PAGE',
      locationFractionMicros: String(Math.round((params.biddingStrategyTarget || 1) * 1_000_000)),
      cpcBidCeilingMicros: '10000000',
    };
    else if (params.biddingStrategy === 'MANUAL_CPC') biddingField.manualCpc = { enhancedCpcEnabled: false };

    const campaignCreate = {
      name: params.name,
      advertisingChannelType: params.type,
      campaignBudget: params.budgetResourceName,
      status: params.status || 'PAUSED',
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      ...biddingField,
    };

    let campaignResourceName: string;

    if (params.type === 'PERFORMANCE_MAX' && (params.brandBusinessName || params.brandLogoAssetResourceName)) {
      const tempCampaignName = `customers/${customerId}/campaigns/-1`;
      const mutateOps: any[] = [];
      let textAssetIndex = -1;

      if (params.brandBusinessName) {
        textAssetIndex = mutateOps.length;
        mutateOps.push({
          assetOperation: {
            create: {
              resourceName: `customers/${customerId}/assets/-2`,
              name: params.brandBusinessName.substring(0, 50),
              type: 'TEXT',
              textAsset: { text: params.brandBusinessName },
            },
          },
        });
      }

      mutateOps.push({ campaignOperation: { create: { resourceName: tempCampaignName, ...campaignCreate } } });

      if (params.brandBusinessName) {
        mutateOps.push({
          campaignAssetOperation: {
            create: { campaign: tempCampaignName, asset: `customers/${customerId}/assets/-2`, fieldType: 'BUSINESS_NAME' },
          },
        });
      }
      if (params.brandLogoAssetResourceName) {
        mutateOps.push({
          campaignAssetOperation: {
            create: { campaign: tempCampaignName, asset: params.brandLogoAssetResourceName, fieldType: 'LOGO' },
          },
        });
      }

      const batchResult = await this.batchMutate(customerId, accessToken, mutateOps);
      const campaignOpIndex = params.brandBusinessName ? 1 : 0;
      campaignResourceName = batchResult.mutateOperationResponses[campaignOpIndex].campaignResult.resourceName;
    } else {
      const data = await this.mutate(customerId, accessToken, 'campaigns', [{ create: campaignCreate }]);
      campaignResourceName = data.results[0].resourceName;
    }

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
    biddingStrategy?: string;
    biddingStrategyTarget?: number;
    budgetResourceName?: string;
  }): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: campaignResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.budgetResourceName) { update.campaignBudget = params.budgetResourceName; updateMask.push('campaign_budget'); }
    if (params.biddingStrategy) {
      if (params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') {
        update.maximizeConversions = { targetCpaMicros: '0' };
        updateMask.push('maximize_conversions.target_cpa_micros');
      } else if (params.biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') {
        update.maximizeConversionValue = { targetRoas: 0 };
        updateMask.push('maximize_conversion_value.target_roas');
      } else if (params.biddingStrategy === 'TARGET_CPA') {
        update.targetCpa = { targetCpaMicros: String(Math.round((params.biddingStrategyTarget || 0) * 1_000_000)) };
        updateMask.push('target_cpa.target_cpa_micros');
      } else if (params.biddingStrategy === 'TARGET_ROAS') {
        update.targetRoas = { targetRoas: params.biddingStrategyTarget || 1 };
        updateMask.push('target_roas.target_roas');
      } else if (params.biddingStrategy === 'MANUAL_CPC') {
        update.manualCpc = { enhancedCpcEnabled: false };
        updateMask.push('manual_cpc.enhanced_cpc_enabled');
      }
    }
    if (updateMask.length === 0) return;
    await this.mutate(customerId, accessToken, 'campaigns', [{ update, updateMask: updateMask.join(',') }]);
  }

  async pauseCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    return this.updateCampaign(userId, customerId, campaignResourceName, { status: 'PAUSED' });
  }

  async resumeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    return this.updateCampaign(userId, customerId, campaignResourceName, { status: 'ENABLED' });
  }

  async removeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaigns', [{ remove: campaignResourceName }]);
  }

  // ── Location search ───────────────────────────────────────────────────────

  async searchLocations(userId: string, customerId: string, query: string, locale: string = 'en'): Promise<{ id: string; name: string; countryCode: string; targetType: string }[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const secrets = await getGoogleAdsCredentials();
    let response;
    try {
      response = await axios.post(`${GOOGLE_ADS_API_BASE}/geoTargetConstants:suggest`, { locale, locationNames: { names: [query] } }, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': secrets.developerToken,
          'login-customer-id': customerId,
        },
      });
    } catch (err: any) {
      console.error('[GoogleAds] searchLocations error:', JSON.stringify(err?.response?.data ?? err?.message));
      throw err;
    }
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
      `SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status, ad_group.type FROM ad_group WHERE ad_group.campaign = '${campaignResourceName}'`,
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
    adRotationMode?: 'OPTIMIZE' | 'ROTATE_FOREVER';
    targetCpaMicros?: number;
    targetRoas?: number;
  }): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: adGroupResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.cpcBidMicros !== undefined) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
    if (params.adRotationMode) { update.adRotationMode = params.adRotationMode; updateMask.push('ad_rotation_mode'); }
    if (params.targetCpaMicros !== undefined) { update.targetCpaMicros = String(params.targetCpaMicros); updateMask.push('target_cpa_micros'); }
    if (params.targetRoas !== undefined) { update.targetRoas = params.targetRoas; updateMask.push('target_roas'); }
    if (updateMask.length === 0) return;
    await this.mutate(customerId, accessToken, 'adGroups', [{ update, updateMask: updateMask.join(',') }]);
  }

  async removeAdGroup(userId: string, customerId: string, adGroupResourceName: string): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroups', [{ remove: adGroupResourceName }]);
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

  async listKeywords(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const query = `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative FROM ad_group_criterion WHERE ad_group_criterion.ad_group = '${adGroupResourceName}' AND ad_group_criterion.type = 'KEYWORD'`;
    const results = await this.search(customerId, accessToken, query);
    return results.map((r: any) => ({
      resourceName: r.adGroupCriterion.resourceName,
      text: r.adGroupCriterion.keyword?.text,
      matchType: r.adGroupCriterion.keyword?.matchType,
      status: r.adGroupCriterion.status,
      negative: r.adGroupCriterion.negative,
    }));
  }

  async updateKeyword(userId: string, customerId: string, criterionResourceName: string, params: {
    status?: 'ENABLED' | 'PAUSED';
    cpcBidMicros?: number;
  }): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: criterionResourceName };
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.cpcBidMicros !== undefined) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
    if (updateMask.length === 0) return;
    await this.mutate(customerId, accessToken, 'adGroupCriteria', [{ update, updateMask: updateMask.join(',') }]);
  }

  async removeKeyword(userId: string, customerId: string, criterionResourceName: string): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupCriteria', [{ remove: criterionResourceName }]);
  }

  // ── Ads ──────────────────────────────────────────────────────────────────

  async listAds(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.ad_group = '${adGroupResourceName}'`,
    );
    return results.map((r: any) => ({
      resourceName: r.adGroupAd.resourceName,
      adId: String(r.adGroupAd.ad.id),
      status: r.adGroupAd.status,
      type: r.adGroupAd.ad.type,
      finalUrls: r.adGroupAd.ad.finalUrls,
      headlines: (r.adGroupAd.ad.responsiveSearchAd?.headlines || r.adGroupAd.ad.responsiveDisplayAd?.headlines || []).map((h: any) => h.text),
      descriptions: (r.adGroupAd.ad.responsiveSearchAd?.descriptions || r.adGroupAd.ad.responsiveDisplayAd?.descriptions || []).map((d: any) => d.text),
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
    } else if (params.type === 'RESPONSIVE_DISPLAY_AD') {
      adContent = {
        responsiveDisplayAd: {
          headlines: params.headlines.map(text => ({ text })),
          descriptions: params.descriptions.map(text => ({ text })),
          ...(params.imageAssetResourceNames && {
            marketingImages: params.imageAssetResourceNames.map(asset => ({ asset })),
          }),
        },
      };
    } else {
      // Reject unknown types rather than silently defaulting to a display ad —
      // the agent could otherwise spend on the wrong ad format.
      throw new Error(`Unsupported ad type "${params.type}". Use RESPONSIVE_SEARCH_AD or RESPONSIVE_DISPLAY_AD.`);
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

  async updateAd(userId: string, customerId: string, adGroupAdResourceName: string, params: {
    status?: 'ENABLED' | 'PAUSED';
  }): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: adGroupAdResourceName };
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (updateMask.length === 0) return;
    await this.mutate(customerId, accessToken, 'adGroupAds', [{ update, updateMask: updateMask.join(',') }]);
  }

  async removeAd(userId: string, customerId: string, adGroupAdResourceName: string): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupAds', [{ remove: adGroupAdResourceName }]);
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
      let imageBuffer: Buffer;
      if (Buffer.isBuffer(asset.data)) {
        imageBuffer = asset.data;
      } else if (typeof asset.data === 'string' && asset.data.startsWith('https://')) {
        // The URL is agent/LLM-supplied (call_google_ads_api `data` arg, reachable
        // via chat or indirect prompt injection), so guard against SSRF before the
        // server-side fetch: block private/internal hosts, disable redirects (a 302
        // to a private IP would otherwise bypass the guard), and cap the size.
        // Mirrors the established pattern in routes/crm.ts.
        await assertPublicHostname(asset.data);
        const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10 MB
        // `as any` routes around the legacy @types/axios shim in this repo that
        // doesn't carry maxRedirects/validateStatus on its config interface
        // (same workaround as routes/crm.ts). validateStatus rejects 3xx so a
        // redirect (which maxRedirects:0 stops following) surfaces as an error.
        const response = await axios.get(asset.data, {
          responseType: 'arraybuffer',
          maxRedirects: 0,
          maxContentLength: MAX_ASSET_BYTES,
          maxBodyLength: MAX_ASSET_BYTES,
          timeout: 15000,
          validateStatus: (s: number) => s >= 200 && s < 300,
        } as any);
        imageBuffer = Buffer.from(response.data as ArrayBuffer);
      } else {
        throw new Error('IMAGE/LOGO asset data must be a Buffer or an https:// URL string');
      }
      assetContent.imageAsset = { data: imageBuffer.toString('base64') };
    } else {
      // VIDEO: data is a YouTube video ID string
      if (Buffer.isBuffer(asset.data)) {
        throw new Error('VIDEO asset data must be a YouTube video ID string, not a Buffer');
      }
      assetContent.youtubeVideoAsset = { youtubeVideoId: asset.data };
    }

    // LOGO is a fieldType for CampaignAsset, not a valid AssetType — always upload as IMAGE
    const assetType = asset.type === 'LOGO' ? 'IMAGE' : asset.type === 'VIDEO' ? 'YOUTUBE_VIDEO' : 'IMAGE';
    const data = await this.mutate(customerId, accessToken, 'assets', [{
      create: { name: asset.name, type: assetType, ...assetContent },
    }]);
    return data.results[0].resourceName;
  }

  async attachCampaignAssets(userId: string, customerId: string, campaignResourceName: string, assets: {
    fieldType: 'BUSINESS_NAME' | 'LOGO' | 'SQUARE_MARKETING_IMAGE' | 'MARKETING_IMAGE' | 'HEADLINE' | 'DESCRIPTION';
    assetResourceName?: string;
    text?: string;
  }[]): Promise<void> {
    const { accessToken } = await this.getAccountCredentials(userId, customerId);
    const operations: any[] = [];
    for (const asset of assets) {
      let assetResourceName = asset.assetResourceName;
      if (!assetResourceName && asset.text) {
        const textData = await this.mutate(customerId, accessToken, 'assets', [{
          create: { name: asset.text.substring(0, 50), type: 'TEXT', textAsset: { text: asset.text } },
        }]);
        assetResourceName = textData.results[0].resourceName;
      }
      if (!assetResourceName) {
        throw new Error(`attachCampaignAssets: asset with fieldType "${asset.fieldType}" must provide either assetResourceName or text`);
      }
      operations.push({ create: { campaign: campaignResourceName, asset: assetResourceName, fieldType: asset.fieldType } });
    }
    await this.mutate(customerId, accessToken, 'campaignAssets', operations);
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

    // Build everything as a single batch mutate — order: assets first, then asset group, then links
    const assetOps: any[] = [];
    const linkOps: any[] = [];
    let tempIdx = -2; // -1 reserved for asset group

    const tempAssetGroupName = `customers/${customerId}/assetGroups/-1`;

    type AssetFieldType = 'HEADLINE' | 'LONG_HEADLINE' | 'DESCRIPTION' | 'MARKETING_IMAGE' | 'SQUARE_MARKETING_IMAGE' | 'LOGO' | 'YOUTUBE_VIDEO';

    const addTextAssets = (texts: string[], fieldType: AssetFieldType) => {
      for (const text of texts) {
        const tempName = `customers/${customerId}/assets/${tempIdx--}`;
        assetOps.push({
          assetOperation: {
            create: { resourceName: tempName, name: text.substring(0, 50), type: 'TEXT', textAsset: { text } },
          },
        });
        linkOps.push({
          assetGroupAssetOperation: {
            create: { assetGroup: tempAssetGroupName, asset: tempName, fieldType },
          },
        });
      }
    };

    const addImageAssets = (resourceNames: string[], fieldType: AssetFieldType) => {
      for (const asset of resourceNames) {
        linkOps.push({
          assetGroupAssetOperation: {
            create: { assetGroup: tempAssetGroupName, asset, fieldType },
          },
        });
      }
    };

    addTextAssets(params.headlines, 'HEADLINE');
    addTextAssets(params.longHeadlines, 'LONG_HEADLINE');
    addTextAssets(params.descriptions, 'DESCRIPTION');
    addImageAssets(params.squareImageAssets, 'SQUARE_MARKETING_IMAGE');
    addImageAssets(params.landscapeImageAssets, 'MARKETING_IMAGE');
    addImageAssets(params.logoAssets, 'LOGO');
    if (params.videoAssets) addImageAssets(params.videoAssets, 'YOUTUBE_VIDEO');

    const assetGroupOp = {
      assetGroupOperation: {
        create: {
          resourceName: tempAssetGroupName,
          name: params.name,
          campaign: params.campaignResourceName,
          status: 'PAUSED',
          finalUrls: [params.finalUrl],
        },
      },
    };

    // Order: text assets → asset group → links
    let mutateOps = [...assetOps, assetGroupOp, ...linkOps];
    let batchResult: any;
    try {
      batchResult = await this.batchMutate(customerId, accessToken, mutateOps);
    } catch (err: any) {
      // If brand guidelines enforced: logo must not be in asset group — retry without LOGO links
      const errStr = JSON.stringify(err?.response?.data || err?.message || '');
      if (errStr.includes('BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL') && errStr.includes('LOGO')) {
        const linkOpsNoLogo = linkOps.filter((op: any) => op.assetGroupAssetOperation?.create?.fieldType !== 'LOGO');
        mutateOps = [...assetOps, assetGroupOp, ...linkOpsNoLogo];
        batchResult = await this.batchMutate(customerId, accessToken, mutateOps);
      } else {
        throw err;
      }
    }
    const assetGroupResultIdx = assetOps.length; // asset group is after text assets
    const assetGroupResourceName = batchResult.mutateOperationResponses[assetGroupResultIdx].assetGroupResult.resourceName;

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
