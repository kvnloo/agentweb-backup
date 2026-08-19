import axios from 'axios';
import { getGoogleAdsCredentials } from '../utils/secretsManager';
import { assertPublicHostname } from '../utils/ssrfGuard';
import { updateAccountTokens } from './connectedAccountsDb'; // sibling in services/
import { buildUtmSpec, mergeUtmIntoQueryString, mergeUtmIntoUrl, readUtmKeys, utmKeysInQueryString, utmQueryString } from '../utils/adUtm';
import { validateNegativeCampaignCriteria } from './googleAdsCampaignCriteria';
import {
  assertCountingType,
  parseTagSnippets,
  diffConversionAction,
  type ConversionActionDrift,
  type ConversionTagPair,
} from '../utils/googleAdsConversionActions';

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
  /**
   * The `login-customer-id` to use for API calls. Equals the manager (MCC) id when the
   * account is a leaf reached through a manager; otherwise equals customerId.
   */
  loginCustomerId: string;
}

/** A leaf (non-manager) Google Ads account the user can connect. */
export interface GoogleAdLeaf {
  customerId: string;
  name: string;
  currency: string;
  /** Manager id to send as login-customer-id, or the account's own id when standalone. */
  loginCustomerId: string;
  /** True if this customerId is already a connected google_ads account for the user. */
  alreadyConnected?: boolean;
}

/** A node in the account-selection tree returned during OAuth finalize. */
export type GoogleAdsAccountNode =
  | { type: 'leaf'; customerId: string; name: string; currency: string; loginCustomerId: string; alreadyConnected?: boolean }
  | { type: 'manager'; customerId: string; name: string; children: GoogleAdLeaf[] };

export class GoogleAdsService {
  // Single-flight refresh guard: userId:accountId → in-flight promise
  private refreshInFlight = new Map<string, Promise<string>>();

  // ── Internal HTTP helper ─────────────────────────────────────────────────

  private async callApi(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    body?: any,
    loginCustomerIdOverride?: string,
  ): Promise<any> {
    const secrets = await getGoogleAdsCredentials();
    // For leaf accounts reached through a manager, the API requires login-customer-id to be
    // the manager id, not the (path) customer id. Callers pass that via the override; standalone
    // accounts fall back to the path customer id (login == customer).
    const loginCustomerId = loginCustomerIdOverride || path.match(/\/customers\/(\d+)\//)?.[1];
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

  async search(customerId: string, accessToken: string, query: string, loginCustomerId?: string): Promise<any[]> {
    const MAX_PAGES = 50; // safety cap (~500k rows at the default page size) to avoid a runaway loop
    const all: any[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const body: any = { query };
      if (pageToken) body.pageToken = pageToken;
      const data = await this.callApi('POST', `/customers/${customerId}/googleAds:search`, accessToken, body, loginCustomerId);
      if (data.results) all.push(...data.results);
      pageToken = data.nextPageToken;
      pages++;
    } while (pageToken && pages < MAX_PAGES);
    return all;
  }

  async mutate(customerId: string, accessToken: string, resource: string, operations: any[], loginCustomerId?: string): Promise<any> {
    return this.callApi('POST', `/customers/${customerId}/${resource}:mutate`, accessToken, { operations }, loginCustomerId);
  }

  async batchMutate(customerId: string, accessToken: string, mutateOperations: any[], loginCustomerId?: string): Promise<any> {
    return this.callApi('POST', `/customers/${customerId}/googleAds:mutate`, accessToken, { mutateOperations }, loginCustomerId);
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
    // Source accounts from the org-shared set so a teammate's Google Ads account
    // shared with the org (sharedWithOrg=true) is usable, not just visible. Each
    // account carries its owner userId so a token refresh updates the owner's record.
    const { getAccountsWithOwnerIncludingOrgShared } = await import('./connectedAccountsDb');
    const accounts = await getAccountsWithOwnerIncludingOrgShared(userId);

    const account = accounts.find(
      (a: any) => a.platform === 'google_ads' && a.config?.customer_id === customerId
    );
    if (!account) throw this.makeAuthError('Google Ads account not found in your connected accounts. Connect it in Settings.');

    const cfg = account.config as any;
    let accessToken = cfg.access_token;
    const isExpired = cfg.token_expires_at && Date.now() > cfg.token_expires_at - 60_000;
    if (isExpired && cfg.refresh_token) {
      accessToken = await this.refreshAccessToken(account.userId, account.account_id, cfg.refresh_token);
    }

    if (!accessToken) {
      throw this.makeAuthError('No access token available. Please reconnect your Google Ads account in Settings.');
    }

    return {
      accessToken,
      customerId,
      currency: cfg.currency || 'USD',
      loginCustomerId: cfg.login_customer_id || customerId,
    };
  }

  // ── Account listing (used during OAuth finalize) ─────────────────────────
  // Builds a 2-level selection tree:
  //   level 0 — standalone/direct leaf accounts AND manager (MCC) accounts the user can access
  //   level 1 — leaf accounts managed under a level-0 manager (descendants flattened to one list)
  // A leaf the user can access both directly and through a discovered manager is shown only
  // under the manager (deduped out of the top level). Managers themselves are not connectable.

  async listAccountHierarchy(accessToken: string): Promise<GoogleAdsAccountNode[]> {
    const secrets = await getGoogleAdsCredentials();
    const response = await axios.get(`${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': secrets.developerToken,
      },
    });

    const resourceNames: string[] = (response.data as { resourceNames?: string[] }).resourceNames || [];
    if (resourceNames.length === 0) return [];

    const directLeaves = new Map<string, GoogleAdLeaf>(); // customerId → level-0 direct/standalone leaf
    const managers: { customerId: string; name: string; children: GoogleAdLeaf[] }[] = [];
    const managedLeafIds = new Set<string>(); // ids appearing under any manager (for dedupe)

    for (const resourceName of resourceNames) {
      const customerId = resourceName.replace('customers/', '');
      try {
        const results = await this.search(customerId, accessToken,
          'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1'
        );
        if (results.length === 0) continue;
        const c = results[0].customer;
        const id = String(c.id);
        if (c.manager === true) {
          // A failure enumerating a manager's children must NOT drop the whole manager —
          // otherwise an MCC-only user (whose accounts are all under one manager) is shown a
          // fake "no accounts" state. Surface the manager with whatever resolved (possibly no
          // children) and log the gap so a transient/partial failure is diagnosable.
          let children: GoogleAdLeaf[] = [];
          try {
            children = await this.listManagerLeaves(id, accessToken);
          } catch (err: any) {
            console.warn(`[GoogleAds] listAccountHierarchy: could not load child accounts for manager ${id}:`, err?.message || err);
          }
          children.forEach(ch => managedLeafIds.add(ch.customerId));
          managers.push({ customerId: id, name: c.descriptiveName || customerId, children });
        } else {
          directLeaves.set(id, {
            customerId: id,
            name: c.descriptiveName || customerId,
            currency: c.currencyCode || 'USD',
            loginCustomerId: id,
          });
        }
      } catch (err: any) {
        // Couldn't even identify this account — skip it, but log so the drop isn't silent.
        console.warn(`[GoogleAds] listAccountHierarchy: skipping customer ${customerId} (probe failed):`, err?.message || err);
      }
    }

    const nodes: GoogleAdsAccountNode[] = [];
    // Top-level leaves first (those not also managed by a discovered manager), then managers.
    for (const [id, leaf] of directLeaves) {
      if (!managedLeafIds.has(id)) {
        nodes.push({ type: 'leaf', customerId: leaf.customerId, name: leaf.name, currency: leaf.currency, loginCustomerId: leaf.loginCustomerId });
      }
    }
    for (const m of managers) {
      nodes.push({ type: 'manager', customerId: m.customerId, name: m.name, children: m.children });
    }
    return nodes;
  }

  // Enumerate every enabled non-manager leaf under a manager (descendants at any depth,
  // flattened). login-customer-id must be the manager id for these queries and for all
  // later API calls against these leaves.
  private async listManagerLeaves(managerId: string, accessToken: string): Promise<GoogleAdLeaf[]> {
    const results = await this.search(managerId, accessToken,
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.manager = false AND customer_client.status = 'ENABLED'",
      managerId,
    );
    const leaves: GoogleAdLeaf[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const cc = r.customerClient;
      if (!cc || cc.manager === true) continue;
      const id = String(cc.id);
      if (id === managerId || seen.has(id)) continue;
      seen.add(id);
      leaves.push({
        customerId: id,
        name: cc.descriptiveName || id,
        currency: cc.currencyCode || 'USD',
        loginCustomerId: managerId,
      });
    }
    return leaves;
  }

  // Flatten the selection tree to the list of connectable leaves (used to validate /connect).
  flattenConnectableLeaves(nodes: GoogleAdsAccountNode[]): GoogleAdLeaf[] {
    const out: GoogleAdLeaf[] = [];
    for (const n of nodes) {
      if (n.type === 'leaf') {
        out.push({ customerId: n.customerId, name: n.name, currency: n.currency, loginCustomerId: n.loginCustomerId });
      } else {
        out.push(...n.children);
      }
    }
    return out;
  }

  // ── Budgets ──────────────────────────────────────────────────────────────

  async createBudget(userId: string, customerId: string, params: {
    name: string;
    amountMicros: number;
    explicitlyShared?: boolean;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const data = await this.mutate(customerId, accessToken, 'campaignBudgets', [{
      create: {
        name: params.name,
        amountMicros: String(params.amountMicros),
        deliveryMethod: 'STANDARD',
        explicitlyShared: params.explicitlyShared ?? false,
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  async updateBudget(userId: string, customerId: string, budgetResourceName: string, amountMicros: number): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignBudgets', [{
      update: { resourceName: budgetResourceName, amountMicros: String(amountMicros) },
      updateMask: 'amount_micros',
    }], loginCustomerId);
  }

  async removeBudget(userId: string, customerId: string, budgetResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignBudgets', [{ remove: budgetResourceName }], loginCustomerId);
  }

  async listBudgets(userId: string, customerId: string): Promise<{ resourceName: string; name: string; amountMicros: string; explicitlyShared: boolean; referenceCount: number }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT campaign_budget.resource_name, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign_budget ORDER BY campaign_budget.name',
      loginCustomerId,
    );
    return results.map((r: any) => ({
      resourceName: r.campaignBudget.resourceName,
      name: r.campaignBudget.name,
      amountMicros: r.campaignBudget.amountMicros,
      explicitlyShared: r.campaignBudget.explicitlyShared,
      referenceCount: r.campaignBudget.referenceCount,
    }));
  }

  // ── Conversion actions (ENG-1322) ─────────────────────────────────────────
  //
  // CREATE / LIST / UPDATE only. REMOVE is deliberately not implemented (Harsha,
  // ENG-1329): removing a conversion action severs historical attribution in the
  // customer's account, and it is the one operation whose damage we cannot undo
  // from our side. Pausing via UPDATE covers what an operator actually needs.

  /** The fields a conversion action's tag and reporting behaviour actually hinge on. */
  private conversionActionSelect(): string {
    return 'SELECT conversion_action.resource_name, conversion_action.id, conversion_action.name, '
      + 'conversion_action.status, conversion_action.type, conversion_action.category, '
      + 'conversion_action.counting_type, conversion_action.primary_for_goal, '
      + 'conversion_action.include_in_conversions_metric, '
      + 'conversion_action.click_through_lookback_window_days, conversion_action.tag_snippets '
      + 'FROM conversion_action';
  }

  private mapConversionAction(row: any): any {
    const ca = row.conversionAction || {};
    return {
      resourceName: ca.resourceName,
      id: ca.id,
      name: ca.name,
      status: ca.status,
      type: ca.type,
      category: ca.category,
      countingType: ca.countingType,
      primaryForGoal: ca.primaryForGoal,
      includeInConversionsMetric: ca.includeInConversionsMetric,
      clickThroughLookbackWindowDays: ca.clickThroughLookbackWindowDays,
      tagSnippets: ca.tagSnippets,
      // The pair the page actually needs. A resource name cannot be installed.
      tag: parseTagSnippets(ca.tagSnippets),
    };
  }

  async listConversionActions(userId: string, customerId: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken, this.conversionActionSelect(), loginCustomerId);
    return results.map((r: any) => this.mapConversionAction(r));
  }

  private async getConversionActionByResourceName(
    customerId: string, accessToken: string, resourceName: string, loginCustomerId?: string,
  ): Promise<any | null> {
    const escaped = resourceName.replace(/'/g, "\\'");
    const rows = await this.search(
      customerId, accessToken,
      `${this.conversionActionSelect()} WHERE conversion_action.resource_name = '${escaped}'`,
      loginCustomerId,
    );
    return rows.length > 0 ? this.mapConversionAction(rows[0]) : null;
  }

  /**
   * Create a conversion action and hand back the tag pair, not just a resource name.
   *
   * Two things this deliberately does NOT do. It does not default `countingType` —
   * that field fails silently and picking for the customer is how reported
   * conversions quietly inflate. And it does not trust the create: the action is
   * read back and diffed field by field, because `createAdGroup`/`createAd` already
   * prove a create can return success while storing something else (ENG-1293).
   */
  async createConversionAction(userId: string, customerId: string, params: {
    name: string;
    category: string;
    countingType: string;
    status?: string;
    primaryForGoal?: boolean;
    clickThroughLookbackWindowDays?: number;
  }): Promise<{ resourceName: string; tag: ConversionTagPair | null; stored: any; drift: ConversionActionDrift[] }> {
    if (!params?.name || !params.name.trim()) {
      throw new Error('name is required to create a conversion action.');
    }
    if (!params?.category || !params.category.trim()) {
      throw new Error(
        'category is required and is never inferred — it decides how Google reports and optimises '
        + 'this action (for example SUBMIT_LEAD_FORM, PURCHASE, SIGNUP, DOWNLOAD).',
      );
    }
    const countingType = assertCountingType(params.countingType);

    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const create: any = {
      name: params.name,
      type: 'WEBPAGE',
      category: params.category,
      countingType,
      status: params.status || 'ENABLED',
    };
    if (params.primaryForGoal !== undefined) create.primaryForGoal = params.primaryForGoal;
    if (params.clickThroughLookbackWindowDays !== undefined) {
      create.clickThroughLookbackWindowDays = params.clickThroughLookbackWindowDays;
    }

    const data = await this.mutate(customerId, accessToken, 'conversionActions', [{ create }], loginCustomerId);
    const resourceName = data.results[0].resourceName;

    const stored = await this.getConversionActionByResourceName(customerId, accessToken, resourceName, loginCustomerId);
    const requested: Record<string, unknown> = {
      name: params.name, category: params.category, countingType, status: create.status,
    };
    if (params.primaryForGoal !== undefined) requested.primaryForGoal = params.primaryForGoal;

    return {
      resourceName,
      tag: stored?.tag ?? null,
      stored,
      drift: diffConversionAction(requested, stored || {}),
    };
  }

  /**
   * Amend an existing conversion action. Only the fields supplied are sent, so an
   * omitted field is left alone rather than reset — and `countingType`, when given,
   * still goes through the same no-inference check as on create.
   */
  async updateConversionAction(userId: string, customerId: string, resourceName: string, params: {
    name?: string;
    status?: string;
    category?: string;
    countingType?: string;
    primaryForGoal?: boolean;
    clickThroughLookbackWindowDays?: number;
  }): Promise<{ resourceName: string; stored: any; drift: ConversionActionDrift[] }> {
    if (!resourceName) throw new Error('conversion_action_resource_name is required for CONVERSION_ACTION UPDATE.');

    const update: any = { resourceName };
    const updateMask: string[] = [];
    const requested: Record<string, unknown> = {};

    if (params.name !== undefined) { update.name = params.name; updateMask.push('name'); requested.name = params.name; }
    if (params.status !== undefined) { update.status = params.status; updateMask.push('status'); requested.status = params.status; }
    if (params.category !== undefined) { update.category = params.category; updateMask.push('category'); requested.category = params.category; }
    if (params.countingType !== undefined) {
      const countingType = assertCountingType(params.countingType);
      update.countingType = countingType; updateMask.push('counting_type'); requested.countingType = countingType;
    }
    if (params.primaryForGoal !== undefined) {
      update.primaryForGoal = params.primaryForGoal; updateMask.push('primary_for_goal'); requested.primaryForGoal = params.primaryForGoal;
    }
    if (params.clickThroughLookbackWindowDays !== undefined) {
      update.clickThroughLookbackWindowDays = params.clickThroughLookbackWindowDays;
      updateMask.push('click_through_lookback_window_days');
      requested.clickThroughLookbackWindowDays = params.clickThroughLookbackWindowDays;
    }

    if (updateMask.length === 0) {
      throw new Error('CONVERSION_ACTION UPDATE requires at least one field to change.');
    }

    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'conversionActions',
      [{ update, updateMask: updateMask.join(',') }], loginCustomerId);

    const stored = await this.getConversionActionByResourceName(customerId, accessToken, resourceName, loginCustomerId);
    return { resourceName, stored, drift: diffConversionAction(requested, stored || {}) };
  }

  // ── Portfolio (shared) bidding strategies ─────────────────────────────────

  async listBiddingStrategies(userId: string, customerId: string): Promise<{ resourceName: string; id: string; name: string; type: string; status: string }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT bidding_strategy.resource_name, bidding_strategy.id, bidding_strategy.name, bidding_strategy.type, bidding_strategy.status FROM bidding_strategy ORDER BY bidding_strategy.name',
      loginCustomerId,
    );
    return results.map((r: any) => ({
      resourceName: r.biddingStrategy.resourceName,
      id: String(r.biddingStrategy.id),
      name: r.biddingStrategy.name,
      type: r.biddingStrategy.type,
      status: r.biddingStrategy.status,
    }));
  }

  // ── Campaigns ────────────────────────────────────────────────────────────

  async listCampaigns(userId: string, customerId: string): Promise<{ resourceName: string; id: string; name: string; status: string; type: string }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      'SELECT campaign.resource_name, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign ORDER BY campaign.id',
      loginCustomerId,
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
    biddingStrategy?: 'MAXIMIZE_CONVERSIONS' | 'TARGET_CPA' | 'TARGET_ROAS' | 'MAXIMIZE_CONVERSION_VALUE' | 'TARGET_IMPRESSION_SHARE' | 'TARGET_SPEND' | 'MANUAL_CPC';
    biddingStrategyResourceName?: string;
    biddingStrategyTarget?: number;
    cpcBidCeilingMicros?: number;
    locationTargetIds: number[];
    status?: 'ENABLED' | 'PAUSED';
    brandBusinessName?: string;
    brandLogoAssetResourceName?: string;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

    // DISPLAY campaigns cannot use MAXIMIZE_CONVERSIONS with a shared budget
    if (params.type === 'DISPLAY' && params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') {
      throw new Error('DISPLAY campaigns do not support MAXIMIZE_CONVERSIONS with a shared budget. Use MANUAL_CPC or TARGET_CPA instead.');
    }

    if (params.biddingStrategy && params.biddingStrategyResourceName) {
      throw new Error('Provide either bidding_strategy (a standard strategy) or bidding_strategy_resource_name (a portfolio/shared strategy), not both.');
    }
    if (!params.biddingStrategy && !params.biddingStrategyResourceName) {
      throw new Error('A campaign requires a bidding strategy: pass bidding_strategy (standard) or bidding_strategy_resource_name (portfolio/shared).');
    }

    const biddingField: Record<string, any> = {};
    // Portfolio/shared strategy: attach by resource-name reference on campaign.bidding_strategy.
    if (params.biddingStrategyResourceName) biddingField.biddingStrategy = params.biddingStrategyResourceName;
    else if (params.biddingStrategy === 'MAXIMIZE_CONVERSIONS') biddingField.maximizeConversions = {};
    else if (params.biddingStrategy === 'MAXIMIZE_CONVERSION_VALUE') biddingField.maximizeConversionValue = {};
    else if (params.biddingStrategy === 'TARGET_CPA') biddingField.targetCpa = { targetCpaMicros: String(Math.round((params.biddingStrategyTarget || 0) * 1_000_000)) };
    else if (params.biddingStrategy === 'TARGET_ROAS') biddingField.targetRoas = { targetRoas: params.biddingStrategyTarget || 1 };
    else if (params.biddingStrategy === 'TARGET_IMPRESSION_SHARE') biddingField.targetImpressionShare = {
      location: 'ANYWHERE_ON_PAGE',
      locationFractionMicros: String(Math.round((params.biddingStrategyTarget || 1) * 1_000_000)),
      cpcBidCeilingMicros: String(params.cpcBidCeilingMicros ?? 100_000_000),
    };
    else if (params.biddingStrategy === 'MANUAL_CPC') biddingField.manualCpc = { enhancedCpcEnabled: false };
    else if (params.biddingStrategy === 'TARGET_SPEND') {
      // Uncapped is valid on CREATE (empty target_spend). A provided ceiling must be positive —
      // Google rejects 0 as TOO_LOW — so reject <= 0 locally rather than send it and get an opaque error.
      if (params.cpcBidCeilingMicros !== undefined && params.cpcBidCeilingMicros <= 0) {
        throw new Error('TARGET_SPEND (Maximize Clicks) requires a positive cpc_bid_ceiling_micros, or omit it for an uncapped strategy. A ceiling of 0 is rejected by Google as TOO_LOW.');
      }
      biddingField.targetSpend = params.cpcBidCeilingMicros !== undefined
        ? { cpcBidCeilingMicros: String(params.cpcBidCeilingMicros) }
        : {};
    }
    else throw new Error(`Unsupported bidding_strategy '${params.biddingStrategy}' for CAMPAIGN CREATE. Supported values: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS, TARGET_IMPRESSION_SHARE, TARGET_SPEND, MANUAL_CPC.`);

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

      const batchResult = await this.batchMutate(customerId, accessToken, mutateOps, loginCustomerId);
      const campaignOpIndex = params.brandBusinessName ? 1 : 0;
      campaignResourceName = batchResult.mutateOperationResponses[campaignOpIndex].campaignResult.resourceName;
    } else {
      const data = await this.mutate(customerId, accessToken, 'campaigns', [{ create: campaignCreate }], loginCustomerId);
      campaignResourceName = data.results[0].resourceName;
    }

    if (params.locationTargetIds.length > 0) {
      await this.mutate(customerId, accessToken, 'campaignCriteria', params.locationTargetIds.map(id => ({
        create: {
          campaign: campaignResourceName,
          location: { geoTargetConstant: `geoTargetConstants/${id}` },
        },
      })), loginCustomerId);
    }

    return { resourceName: campaignResourceName };
  }

  /**
   * ENG-487 — add a PROXIMITY (mile/km-radius) campaign criterion centered on a street
   * address. Google geocodes the address into a geo point server-side; this is
   * additive to (not a replacement for) any existing LOCATION (city) criteria on the
   * campaign — remove those separately via removeCampaignCriterion if only the radius
   * should apply.
   */
  async addProximityCriterion(userId: string, customerId: string, campaignResourceName: string, params: {
    radius: number;
    radiusUnits?: 'MILES' | 'KILOMETERS';
    address: {
      streetAddress?: string;
      cityName?: string;
      postalCode?: string;
      provinceCode?: string;
      provinceName?: string;
      countryCode?: string;
    };
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const address: Record<string, any> = {};
    if (params.address.streetAddress) address.streetAddress = params.address.streetAddress;
    if (params.address.cityName) address.cityName = params.address.cityName;
    if (params.address.postalCode) address.postalCode = params.address.postalCode;
    if (params.address.provinceCode) address.provinceCode = params.address.provinceCode;
    if (params.address.provinceName) address.provinceName = params.address.provinceName;
    if (params.address.countryCode) address.countryCode = params.address.countryCode;
    if (Object.keys(address).length === 0) {
      throw new Error('addProximityCriterion requires at least one address field (street_address, city_name, postal_code, province_code, province_name, country_code)');
    }
    const data = await this.mutate(customerId, accessToken, 'campaignCriteria', [{
      create: {
        campaign: campaignResourceName,
        proximity: {
          radius: params.radius,
          radiusUnits: params.radiusUnits || 'MILES',
          address,
        },
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  /**
   * Remove a campaign-level criterion by resource name, restricted to the given type(s)
   * so a mis-selected resource name (e.g. an audience or demographic criterion) can't be
   * deleted through an action scoped to a narrower purpose (e.g. REMOVE_PROXIMITY).
   */
  async removeCampaignCriterion(userId: string, customerId: string, criterionResourceName: string, allowedTypes?: string[]): Promise<void> {
    this.assertResourceName(criterionResourceName, 'campaignCriteria');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    if (allowedTypes?.length) {
      const rows = await this.search(customerId, accessToken, `SELECT campaign_criterion.type FROM campaign_criterion WHERE campaign_criterion.resource_name = '${criterionResourceName}'`, loginCustomerId);
      const actualType = rows[0]?.campaignCriterion?.type;
      if (!actualType || !allowedTypes.includes(actualType)) {
        throw new Error(`Refusing to remove ${criterionResourceName}: expected criterion type ${allowedTypes.join(' or ')}, found ${actualType || 'unknown (criterion not found)'}`);
      }
    }
    await this.mutate(customerId, accessToken, 'campaignCriteria', [{ remove: criterionResourceName }], loginCustomerId);
  }

  async updateCampaign(userId: string, customerId: string, campaignResourceName: string, params: {
    name?: string;
    status?: 'ENABLED' | 'PAUSED';
    biddingStrategy?: string;
    biddingStrategyResourceName?: string;
    biddingStrategyTarget?: number;
    cpcBidCeilingMicros?: number;
    budgetResourceName?: string;
    finalUrlSuffix?: string;
  }): Promise<boolean> {
    if (params.biddingStrategy && params.biddingStrategyResourceName) {
      throw new Error('Provide either bidding_strategy (a standard strategy) or bidding_strategy_resource_name (a portfolio/shared strategy), not both.');
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: campaignResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.budgetResourceName) { update.campaignBudget = params.budgetResourceName; updateMask.push('campaign_budget'); }
    if (params.finalUrlSuffix !== undefined) { update.finalUrlSuffix = params.finalUrlSuffix; updateMask.push('final_url_suffix'); }
    if (params.biddingStrategyResourceName) {
      // Portfolio/shared strategy: bidding_strategy is a scalar resource-name field, so masking
      // the leaf directly is correct (and setting it detaches any prior embedded strategy).
      update.biddingStrategy = params.biddingStrategyResourceName;
      updateMask.push('bidding_strategy');
    } else if (params.biddingStrategy) {
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
      } else if (params.biddingStrategy === 'TARGET_IMPRESSION_SHARE') {
        update.targetImpressionShare = {
          location: 'ANYWHERE_ON_PAGE',
          locationFractionMicros: String(Math.round((params.biddingStrategyTarget || 1) * 1_000_000)),
          cpcBidCeilingMicros: String(params.cpcBidCeilingMicros ?? 100_000_000),
        };
        updateMask.push('target_impression_share.location', 'target_impression_share.location_fraction_micros', 'target_impression_share.cpc_bid_ceiling_micros');
      } else if (params.biddingStrategy === 'MANUAL_CPC') {
        update.manualCpc = { enhancedCpcEnabled: false };
        updateMask.push('manual_cpc.enhanced_cpc_enabled');
      } else if (params.biddingStrategy === 'TARGET_SPEND') {
        // Maximize Clicks. The Google Ads update mutate can only mask the leaf
        // 'target_spend.cpc_bid_ceiling_micros': masking the bare parent 'target_spend'
        // is rejected with FieldMaskError.FIELD_HAS_SUBFIELDS, and a ceiling of 0 is
        // rejected as TOO_LOW. So a truly uncapped switch isn't expressible on an
        // existing campaign — a real cpc_bid_ceiling_micros is required.
        if (params.cpcBidCeilingMicros === undefined || params.cpcBidCeilingMicros <= 0) {
          throw new Error('TARGET_SPEND (Maximize Clicks) requires a positive cpc_bid_ceiling_micros — the max CPC bid limit in micros (e.g. 9000000 for $9). A ceiling of 0 is rejected by Google as TOO_LOW. Ask the user for their max CPC bid before switching an existing campaign to Maximize Clicks.');
        }
        update.targetSpend = { cpcBidCeilingMicros: String(params.cpcBidCeilingMicros) };
        updateMask.push('target_spend.cpc_bid_ceiling_micros');
      } else {
        throw new Error(`Unsupported bidding_strategy '${params.biddingStrategy}' for CAMPAIGN UPDATE. Supported values: MAXIMIZE_CONVERSIONS, MAXIMIZE_CONVERSION_VALUE, TARGET_CPA, TARGET_ROAS, TARGET_IMPRESSION_SHARE, TARGET_SPEND, MANUAL_CPC.`);
      }
    }
    if (updateMask.length === 0) return false;
    await this.mutate(customerId, accessToken, 'campaigns', [{ update, updateMask: updateMask.join(',') }], loginCustomerId);
    return true;
  }

  async pauseCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    await this.updateCampaign(userId, customerId, campaignResourceName, { status: 'PAUSED' });
  }

  async resumeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    await this.updateCampaign(userId, customerId, campaignResourceName, { status: 'ENABLED' });
  }

  async removeCampaign(userId: string, customerId: string, campaignResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaigns', [{ remove: campaignResourceName }], loginCustomerId);
  }

  /**
   * Validate a Google Ads resource name before it is interpolated into a GAQL WHERE
   * clause (ENG-335). Unlike the other queries in this service, the ENG-335 lookups
   * splice a caller-supplied value into the query, and that value ultimately originates
   * from an LLM tool-call argument. Real resource names are only `customers/<n>/<segment>/<n>`,
   * so we reject anything else rather than let a crafted string alter the query (e.g. one
   * engineered to return zero rows and silently skip the creative-addition gate).
   */
  private assertResourceName(value: string, segment: 'campaigns' | 'adGroups' | 'campaignCriteria'): void {
    const idPattern = segment === 'campaignCriteria' ? '\\d+~\\d+' : '\\d+';
    if (typeof value !== 'string' || !new RegExp(`^customers/\\d+/${segment}/${idPattern}$`).test(value)) {
      throw new Error(`Invalid Google Ads ${segment} resource name`);
    }
  }

  /**
   * Collect the de-duplicated set of final URLs a campaign points at, across its
   * (non-removed) responsive ads and PMax asset groups. Used by the pre-flight
   * tracking gate (ENG-335) before a campaign is enabled/launched.
   */
  async getCampaignFinalUrls(userId: string, customerId: string, campaignResourceName: string): Promise<string[]> {
    this.assertResourceName(campaignResourceName, 'campaigns');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const urls = new Set<string>();

    const adRows = await this.search(customerId, accessToken,
      `SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.resource_name = '${campaignResourceName}' AND ad_group_ad.status != 'REMOVED'`,
      loginCustomerId,
    );
    for (const r of adRows) {
      for (const u of (r.adGroupAd?.ad?.finalUrls || [])) urls.add(u);
    }

    const assetGroupRows = await this.search(customerId, accessToken,
      `SELECT asset_group.final_urls FROM asset_group WHERE campaign.resource_name = '${campaignResourceName}' AND asset_group.status != 'REMOVED'`,
      loginCustomerId,
    );
    for (const r of assetGroupRows) {
      for (const u of (r.assetGroup?.finalUrls || [])) urls.add(u);
    }

    return [...urls];
  }

  /**
   * Current serving status of a campaign (e.g. 'ENABLED', 'PAUSED'), or null if
   * the campaign can't be found. Used by the ENG-335 launch gate to decide whether
   * adding a creative to it serves paid traffic instantly.
   */
  async getCampaignStatus(userId: string, customerId: string, campaignResourceName: string): Promise<string | null> {
    this.assertResourceName(campaignResourceName, 'campaigns');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(customerId, accessToken,
      `SELECT campaign.status FROM campaign WHERE campaign.resource_name = '${campaignResourceName}'`,
      loginCustomerId,
    );
    return rows[0]?.campaign?.status ?? null;
  }

  /**
   * Resolve the parent campaign (resource name + current status) of an ad group.
   * Returns null if the ad group can't be found. Used by the ENG-335 launch gate
   * so a new ad added to a live campaign is checked before it serves.
   */
  async getAdGroupCampaign(userId: string, customerId: string, adGroupResourceName: string): Promise<{ campaignResourceName: string; campaignStatus: string } | null> {
    this.assertResourceName(adGroupResourceName, 'adGroups');
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(customerId, accessToken,
      `SELECT ad_group.campaign, campaign.status FROM ad_group WHERE ad_group.resource_name = '${adGroupResourceName}'`,
      loginCustomerId,
    );
    const row = rows[0];
    if (!row?.adGroup?.campaign) return null;
    return { campaignResourceName: row.adGroup.campaign, campaignStatus: row.campaign?.status ?? '' };
  }

  // ── Location search ───────────────────────────────────────────────────────

  async searchLocations(userId: string, customerId: string, query: string, locale: string = 'en'): Promise<{ id: string; name: string; countryCode: string; targetType: string }[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const secrets = await getGoogleAdsCredentials();
    let response;
    try {
      response = await axios.post(`${GOOGLE_ADS_API_BASE}/geoTargetConstants:suggest`, { locale, locationNames: { names: [query] } }, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': secrets.developerToken,
          'login-customer-id': loginCustomerId,
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
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      `SELECT ad_group.resource_name, ad_group.id, ad_group.name, ad_group.status, ad_group.type FROM ad_group WHERE ad_group.campaign = '${campaignResourceName}'`,
      loginCustomerId,
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
    status?: 'ENABLED' | 'PAUSED';
    cpcBidMicros?: number;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const data = await this.mutate(customerId, accessToken, 'adGroups', [{
      create: {
        name: params.name,
        campaign: params.campaignResourceName,
        status: params.status ?? 'ENABLED',
        type: params.type,
        ...(params.cpcBidMicros !== undefined && { cpcBidMicros: String(params.cpcBidMicros) }),
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  async updateAdGroup(userId: string, customerId: string, adGroupResourceName: string, params: {
    name?: string;
    status?: 'ENABLED' | 'PAUSED';
    cpcBidMicros?: number;
    adRotationMode?: 'OPTIMIZE' | 'ROTATE_FOREVER';
    targetCpaMicros?: number;
    targetRoas?: number;
  }): Promise<boolean> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: adGroupResourceName };
    if (params.name) { update.name = params.name; updateMask.push('name'); }
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.cpcBidMicros !== undefined) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
    if (params.adRotationMode) { update.adRotationMode = params.adRotationMode; updateMask.push('ad_rotation_mode'); }
    if (params.targetCpaMicros !== undefined) { update.targetCpaMicros = String(params.targetCpaMicros); updateMask.push('target_cpa_micros'); }
    if (params.targetRoas !== undefined) { update.targetRoas = params.targetRoas; updateMask.push('target_roas'); }
    if (updateMask.length === 0) return false;
    await this.mutate(customerId, accessToken, 'adGroups', [{ update, updateMask: updateMask.join(',') }], loginCustomerId);
    return true;
  }

  async removeAdGroup(userId: string, customerId: string, adGroupResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroups', [{ remove: adGroupResourceName }], loginCustomerId);
  }

  // ── Keywords ─────────────────────────────────────────────────────────────

  async addKeywords(userId: string, customerId: string, adGroupResourceName: string, keywords: {
    text: string;
    matchType: 'BROAD' | 'PHRASE' | 'EXACT';
  }[]): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
      create: {
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        keyword: { text: kw.text, matchType: kw.matchType },
      },
    })), loginCustomerId);
  }

  async addNegativeKeywords(userId: string, customerId: string, target: {
    campaignResourceName?: string;
    adGroupResourceName?: string;
  }, keywords: { text: string; matchType: 'BROAD' | 'PHRASE' | 'EXACT' }[]): Promise<void> {
    if (!target.campaignResourceName && !target.adGroupResourceName) {
      throw new Error('addNegativeKeywords requires either campaignResourceName or adGroupResourceName');
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    if (target.campaignResourceName) {
      await this.mutate(customerId, accessToken, 'campaignCriteria', keywords.map(kw => ({
        create: {
          campaign: target.campaignResourceName,
          negative: true,
          keyword: { text: kw.text, matchType: kw.matchType },
        },
      })), loginCustomerId);
    } else if (target.adGroupResourceName) {
      await this.mutate(customerId, accessToken, 'adGroupCriteria', keywords.map(kw => ({
        create: {
          adGroup: target.adGroupResourceName,
          negative: true,
          keyword: { text: kw.text, matchType: kw.matchType },
        },
      })), loginCustomerId);
    }
  }

  async addNegativeCampaignCriteria(
    userId: string,
    customerId: string,
    campaignResourceName: string,
    params: {
      placementUrls: string[];
      mobileAppCategoryResourceNames: string[];
    },
  ): Promise<void> {
    const { placementUrls, mobileAppCategoryResourceNames } = validateNegativeCampaignCriteria(
      customerId,
      campaignResourceName,
      params.placementUrls,
      params.mobileAppCategoryResourceNames,
    );

    const operations = [
      ...placementUrls.map((url) => ({
        create: {
          campaign: campaignResourceName,
          negative: true,
          placement: { url },
        },
      })),
      ...mobileAppCategoryResourceNames.map((mobileAppCategoryConstant) => ({
        create: {
          campaign: campaignResourceName,
          negative: true,
          mobileAppCategory: { mobileAppCategoryConstant },
        },
      })),
    ];

    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'campaignCriteria', operations, loginCustomerId);
  }

  async listKeywords(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const query = `SELECT ad_group_criterion.resource_name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative FROM ad_group_criterion WHERE ad_group_criterion.ad_group = '${adGroupResourceName}' AND ad_group_criterion.type = 'KEYWORD'`;
    const results = await this.search(customerId, accessToken, query, loginCustomerId);
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
  }): Promise<boolean> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: criterionResourceName };
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (params.cpcBidMicros !== undefined) { update.cpcBidMicros = String(params.cpcBidMicros); updateMask.push('cpc_bid_micros'); }
    if (updateMask.length === 0) return false;
    await this.mutate(customerId, accessToken, 'adGroupCriteria', [{ update, updateMask: updateMask.join(',') }], loginCustomerId);
    return true;
  }

  async removeKeyword(userId: string, customerId: string, criterionResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupCriteria', [{ remove: criterionResourceName }], loginCustomerId);
  }

  // ── Ads ──────────────────────────────────────────────────────────────────

  /**
   * ENG-239 — the Google `final_url_suffix` Emma stamps on an ad so leads from it
   * reach the CRM with attribution. Returns `undefined` when nothing should be
   * written (so the caller omits the field rather than sending an empty one).
   *
   * `final_url_suffix` is a native field on the `Ad` (`ad_group_ad.ad.final_url_suffix`),
   * appended to the destination URL by Google at click time and shown in the ad's
   * URL options — which is what makes AC1 ("verifiable in the platform's ad
   * settings") hold literally. The generated value uses ValueTrack macros
   * (`{campaignid}`, `{creative}`) that reach the API un-encoded and resolve per
   * click. An explicit caller-supplied suffix wins verbatim; otherwise any UTM key
   * the user already put on `finalUrl` is omitted (AC4), and when every key is
   * already present `utmQueryString` returns "" → we return `undefined`.
   */
  private buildAdFinalUrlSuffix(opts: {
    finalUrl?: string;
    explicitSuffix?: string;
    /** The suffix this ad would otherwise inherit from its campaign. */
    inheritedSuffix?: string;
  }): string | undefined {
    if (opts.explicitSuffix) return opts.explicitSuffix;
    if (!opts.finalUrl) return undefined;
    // If we cannot read the destination URL we do not tag it: it may well already
    // carry a utm_source (`example.com?utm_source=news` fails `new URL()` for want of
    // a scheme), and appending a second one would corrupt the attribution. Nor do we
    // throw — Google should reject a bad URL with its own precise error, not ours.
    const urlKeys = readUtmKeys(opts.finalUrl);
    if (!urlKeys) return undefined;
    const spec = buildUtmSpec('google', { campaign: '{campaignid}', content: '{creative}' });
    // Carry the campaign's suffix forward — an ad-level suffix REPLACES it, so not
    // doing so would silently destroy the client's own tracking (AC4).
    const merged = mergeUtmIntoQueryString(opts.inheritedSuffix, spec, urlKeys);
    return merged || undefined;
  }

  /**
   * The `final_url_suffix` an ad in this ad group would inherit from its campaign.
   *
   * Google resolves the suffix by most-specific level (ad > ad group > campaign >
   * account) and the winner REPLACES the others — they are not concatenated. So we
   * must know what we would be replacing before we write at ad level.
   *
   * Returns `{ ok: false }` if the read fails. Callers then write no generated
   * suffix at all: losing attribution on one ad is recoverable, silently destroying
   * a client's campaign-level tracking is not.
   */
  private async getInheritedFinalUrlSuffix(
    customerId: string,
    accessToken: string,
    adGroupResourceName: string,
    loginCustomerId?: string,
  ): Promise<{ ok: true; suffix?: string } | { ok: false }> {
    try {
      const rows = await this.search(
        customerId,
        accessToken,
        `SELECT ad_group.final_url_suffix, campaign.final_url_suffix FROM ad_group WHERE ad_group.resource_name = '${adGroupResourceName}'`,
        loginCustomerId,
      );
      // Ad group is more specific than campaign, so its own suffix (if set) is
      // the one actually in effect — campaign's is only a fallback.
      const suffix = rows[0]?.adGroup?.finalUrlSuffix || rows[0]?.campaign?.finalUrlSuffix || undefined;
      return { ok: true, suffix };
    } catch (err: any) {
      console.warn(
        `[GoogleAds] could not read inherited final_url_suffix for ${adGroupResourceName}; skipping UTM suffix to avoid clobbering it:`,
        err?.message || err,
      );
      return { ok: false };
    }
  }

  /**
   * Google Ads resource names are always `[A-Za-z0-9_/~-]+` — no quotes, no
   * whitespace. Both retag entry points interpolate their resource name
   * argument directly into a GAQL string literal, so this guard closes that
   * injection vector before the value ever reaches a query (Greptile).
   */
  private isValidGoogleAdsResourceName(name: string): boolean {
    return /^[A-Za-z0-9_/~-]+$/.test(name);
  }

  async listAds(userId: string, customerId: string, adGroupResourceName: string): Promise<any[]> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const results = await this.search(customerId, accessToken,
      `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_display_ad.headlines, ad_group_ad.ad.responsive_display_ad.descriptions FROM ad_group_ad WHERE ad_group_ad.ad_group = '${adGroupResourceName}'`,
      loginCustomerId,
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

  /**
   * Read every destination the UTM audit must judge for this account (ENG-239 AC3).
   * STRICTLY READ-ONLY.
   *
   * TWO resource types, because our tagger writes to two:
   *
   *   1. `ad_group_ad` — a normal ad. Tagged via the ad's native `final_url_suffix`
   *      (`buildAdFinalUrlSuffix`), which Google appends to the final URL at click time.
   *
   *   2. `asset_group` — a Performance Max campaign. A PMax campaign has NO ad_group_ads at
   *      all; its destinations live on `asset_group.final_urls`. Reading only ad_group_ad would
   *      see zero ads for such a campaign and the audit would report it `tagged: true`
   *      VACUOUSLY — a clean bill of health for a campaign we never actually looked at. That
   *      is worse than a false "untagged": the team trusts the report and skips a client who
   *      has no attribution at all.
   *
   * INHERITANCE — the thing that must not be got wrong: Google resolves `final_url_suffix`
   * most-specific-wins (ad > ad group > campaign > account) and the winner REPLACES the
   * others; they are NEVER concatenated. So an ad's effective suffix is its own if set, else
   * the campaign's. Concatenating (or ignoring the campaign level) would report a properly
   * tagged campaign as untagged — a false positive the team would act on.
   *
   * ASSET-GROUP SUFFIX: an asset group has NO `final_url_suffix` field of its own (that is
   * precisely why `createAssetGroup` merges the UTMs straight into `final_urls` — see :1072).
   * Its append field is therefore the CAMPAIGN's suffix and nothing else. Selecting
   * `asset_group.final_url_suffix` in GAQL would not merely be wrong, it would fail the whole
   * query and take the audit down with it.
   *
   * AD-GROUP SUFFIX: `getInheritedFinalUrlSuffix` reads and inherits from the ad group level
   * too (an ad group's own suffix is more specific than its campaign's), so the audit must
   * read it as well — an ad-group-tagged campaign with no ad/campaign-level suffix would
   * otherwise be a false "untagged".
   *
   * `destinationUrls` is the whole `finalUrls` array — every one of them must carry the UTMs,
   * not just `finalUrls[0]`.
   */
  async listAdsForUtmAudit(
    userId: string,
    customerId: string,
    campaignId?: string,
  ): Promise<Array<{
    adId: string;
    campaignId: string;
    campaignName: string;
    destinationUrls: string[];
    appendField?: string;
  }>> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

    // Campaign ids are numeric; the guard keeps a caller-supplied value out of the GAQL text.
    const where = campaignId && /^\d+$/.test(campaignId) ? ` WHERE campaign.id = ${campaignId}` : '';

    const adQuery =
      'SELECT campaign.id, campaign.name, campaign.final_url_suffix, ad_group.final_url_suffix, ' +
      'ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_url_suffix ' +
      'FROM ad_group_ad' + where;

    // NOTE: no `asset_group.final_url_suffix` — that field does not exist on the resource.
    const assetGroupQuery =
      'SELECT campaign.id, campaign.name, campaign.final_url_suffix, ' +
      'asset_group.id, asset_group.final_urls ' +
      'FROM asset_group' + where;

    const [adRows, assetGroupRows] = await Promise.all([
      this.search(customerId, accessToken, adQuery, loginCustomerId),
      this.search(customerId, accessToken, assetGroupQuery, loginCustomerId),
    ]);

    const urls = (value: any): string[] =>
      (Array.isArray(value) ? value : []).filter((u: any) => typeof u === 'string' && u.trim());

    const ads = adRows.map((r: any) => {
      const ad = r.adGroupAd?.ad ?? {};
      const adGroup = r.adGroup ?? {};
      const campaign = r.campaign ?? {};
      return {
        adId: String(ad.id ?? ''),
        campaignId: campaign.id != null ? String(campaign.id) : '',
        campaignName: campaign.name ?? '',
        destinationUrls: urls(ad.finalUrls),
        // Most-specific-wins: ad > ad group > campaign — each level REPLACES the
        // others, never appends to them.
        appendField: ad.finalUrlSuffix || adGroup.finalUrlSuffix || campaign.finalUrlSuffix || undefined,
      };
    });

    const assetGroups = assetGroupRows.map((r: any) => {
      const assetGroup = r.assetGroup ?? {};
      const campaign = r.campaign ?? {};
      return {
        // Namespaced so an asset group is never mistaken for an ad id in the report — the two
        // are different resources and are actioned differently.
        adId: `assetGroup/${assetGroup.id ?? ''}`,
        campaignId: campaign.id != null ? String(campaign.id) : '',
        campaignName: campaign.name ?? '',
        destinationUrls: urls(assetGroup.finalUrls),
        // Campaign level ONLY — an asset group has no suffix field of its own.
        appendField: campaign.finalUrlSuffix || undefined,
      };
    });

    return [...ads, ...assetGroups];
  }

  async createAd(userId: string, customerId: string, params: {
    adGroupResourceName: string;
    type: 'RESPONSIVE_SEARCH_AD' | 'RESPONSIVE_DISPLAY_AD';
    headlines: string[];
    descriptions: string[];
    finalUrl: string;
    status?: 'ENABLED' | 'PAUSED';
    imageAssetResourceNames?: string[];
    /** ENG-239: explicit UTM/tracking suffix; wins over the auto-generated one. */
    finalUrlSuffix?: string;
  }): Promise<{ resourceName: string }> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

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

    // Read what this ad would inherit from its campaign BEFORE writing at ad level —
    // an ad-level suffix replaces the campaign's outright (ENG-239 AC4).
    const inherited = await this.getInheritedFinalUrlSuffix(
      customerId, accessToken, params.adGroupResourceName, loginCustomerId,
    );
    const finalUrlSuffix = inherited.ok
      ? this.buildAdFinalUrlSuffix({
          finalUrl: params.finalUrl,
          explicitSuffix: params.finalUrlSuffix,
          inheritedSuffix: inherited.suffix,
        })
      : params.finalUrlSuffix; // read failed → only an explicitly-supplied suffix is safe to write

    const data = await this.mutate(customerId, accessToken, 'adGroupAds', [{
      create: {
        adGroup: params.adGroupResourceName,
        status: params.status ?? 'ENABLED',
        ad: {
          ...adContent,
          finalUrls: [params.finalUrl],
          ...(finalUrlSuffix ? { finalUrlSuffix } : {}),
        },
      },
    }], loginCustomerId);
    return { resourceName: data.results[0].resourceName };
  }

  /**
   * `finalUrl`/`finalUrlSuffix` params were removed (ENG-239 follow-up):
   * `ad_group_ad.ad.final_url_suffix` is LIVE-VERIFIED IMMUTABLE on UPDATE —
   * Google rejects it with `IMMUTABLE_FIELD: Field 'ad.final_url_suffix' cannot
   * be modified by 'UPDATE' operation`, even though the v24 proto carries no
   * IMMUTABLE annotation on the field. This path was never reachable from any
   * real caller (the AD UPDATE dispatcher only ever passes `status`), so no
   * behavior changes for real traffic — this only removes dead code whose own
   * unit tests were asserting on a write Google's live API always rejects. A
   * suffix can still be set at CREATE time (`createAd`, which uses a `create`
   * mutate op — Google's immutability rule is UPDATE-only) or via `retagAdUtm`,
   * which correctly writes at the CAMPAIGN level instead.
   */
  async updateAd(userId: string, customerId: string, adGroupAdResourceName: string, params: {
    status?: 'ENABLED' | 'PAUSED';
  }): Promise<boolean> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const updateMask: string[] = [];
    const update: any = { resourceName: adGroupAdResourceName };
    if (params.status) { update.status = params.status; updateMask.push('status'); }
    if (updateMask.length === 0) return false;
    await this.mutate(customerId, accessToken, 'adGroupAds', [{ update, updateMask: updateMask.join(',') }], loginCustomerId);
    return true;
  }

  /**
   * Retag ONE existing, already-live ad that's missing UTMs (Harsha's ask —
   * the audit tool can only find these, never fix them). Deliberately single-ad
   * INPUT: never loop or accept a list. But the WRITE lands on that ad's
   * CAMPAIGN, not the ad itself — see below — so retagging affects every ad
   * under that campaign, not just the one named. Callers/tools must disclose
   * this blast radius; it is bigger than the name suggests.
   *
   * LIVE-VERIFIED 2026-07-16 against a real Google Ads account (customer
   * 2883029950): an ad-level `UPDATE` of `final_url_suffix` is REJECTED —
   * `IMMUTABLE_FIELD: Field 'ad.final_url_suffix' cannot be modified by
   * 'UPDATE' operation` — even though the v24 `Ad` proto carries no IMMUTABLE
   * annotation on this field (unlike the ad-type oneof fields, which do). The
   * public proto and the live server's actual validation disagree; proto
   * silence is not proof of mutability. `updateAd`'s finalUrl-based edit path
   * (used at CREATE time, where this write is allowed) cannot be reused here.
   *
   * CAMPAIGN-level `UPDATE` of `final_url_suffix`, by contrast, was confirmed
   * live to succeed and read back correctly, and a newly-created ad under that
   * campaign was confirmed to correctly INHERIT + MERGE (not overwrite) it —
   * exactly the AC4 behavior `mergeUtmIntoQueryString` is designed for. So this
   * reads the ad's final_url (for the AC4 omission check — never duplicate a
   * key the destination already carries) and the campaign's CURRENT
   * `final_url_suffix` (to merge into, not replace), then writes the merged
   * value back to the CAMPAIGN.
   */
  async retagAdUtm(
    userId: string,
    customerId: string,
    adGroupAdResourceName: string,
  ): Promise<{ success: boolean; reason?: 'no_destination_url' | 'invalid_resource_name' }> {
    if (!this.isValidGoogleAdsResourceName(adGroupAdResourceName)) {
      return { success: false, reason: 'invalid_resource_name' };
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(
      customerId,
      accessToken,
      `SELECT ad_group_ad.ad.final_urls, campaign.resource_name, campaign.final_url_suffix `
      + `FROM ad_group_ad WHERE ad_group_ad.resource_name = '${adGroupAdResourceName}'`,
      loginCustomerId,
    );
    const finalUrl = rows[0]?.adGroupAd?.ad?.finalUrls?.[0];
    if (!finalUrl) return { success: false, reason: 'no_destination_url' };

    // Unreadable destination — do not tag; we can't confirm this ad's URL is
    // even a URL, so refuse rather than risk writing anything at all.
    if (!readUtmKeys(finalUrl)) return { success: false };

    const campaignResourceName: string | undefined = rows[0]?.campaign?.resourceName;
    const existingSuffix: string | undefined = rows[0]?.campaign?.finalUrlSuffix;
    const spec = buildUtmSpec('google', { campaign: '{campaignid}', content: '{creative}' });
    // Greptile P1: omission must be driven ONLY by what the EXISTING campaign
    // suffix already defines (mergeUtmIntoQueryString computes that internally
    // from `existingSuffix`) — never by the targeted ad's own URL. The suffix
    // applies to every ad in the campaign at click time; using one ad's URL as
    // the omit mask either strips a key from sibling ads that never had it, or
    // adds a key that duplicates onto one of this ad's OTHER final urls.
    const merged = mergeUtmIntoQueryString(existingSuffix, spec);
    const normalizedExisting = (existingSuffix || '').replace(/^[?&]+/, '').replace(/&+$/, '');
    if (!campaignResourceName || merged === normalizedExisting) return { success: false };

    const success = await this.updateCampaign(userId, customerId, campaignResourceName, { finalUrlSuffix: merged });
    return { success };
  }

  /**
   * Retag ONE existing PMax asset group that's missing UTMs (Harsha's ask,
   * PMax slice — `retagAdUtm` only covers `ad_group_ad`, which a PMax campaign
   * has none of). Deliberately single-target: never loop or accept a list.
   *
   * An asset group has no `final_url_suffix` field of its own (same reason
   * `createAssetGroup` merges straight into `final_urls`) — but it DOES inherit
   * the CAMPAIGN's `final_url_suffix` at delivery. So a key the campaign
   * already supplies must be omitted here too, or the click URL carries it
   * twice. No `content`: Google's docs mark `{creative}` unsupported on PMax
   * (see `createAssetGroup`), so it's never added here either.
   *
   * LIVE-VERIFIED 2026-07-17: `asset_group.final_urls` is writable via UPDATE.
   * That same live run caught a real bug — `updateMask: 'final_urls'` replaces
   * the whole array, so writing back only the first URL silently dropped every
   * other URL a multi-URL PMax asset group had. Fixed by retagging every URL
   * in the array independently and writing the full array back; confirmed live
   * against a real 2-URL asset group that both URLs survive and get tagged.
   */
  async retagAssetGroupUtm(
    userId: string,
    customerId: string,
    assetGroupResourceName: string,
  ): Promise<{ success: boolean; reason?: 'no_destination_url' | 'invalid_resource_name' }> {
    if (!this.isValidGoogleAdsResourceName(assetGroupResourceName)) {
      return { success: false, reason: 'invalid_resource_name' };
    }
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const rows = await this.search(
      customerId,
      accessToken,
      `SELECT asset_group.final_urls, campaign.final_url_suffix `
      + `FROM asset_group WHERE asset_group.resource_name = '${assetGroupResourceName}'`,
      loginCustomerId,
    );
    const finalUrls: string[] = rows[0]?.assetGroup?.finalUrls ?? [];
    if (finalUrls.length === 0) return { success: false, reason: 'no_destination_url' };

    const campaignSuffix: string | undefined = rows[0]?.campaign?.finalUrlSuffix;
    const inheritedKeys = utmKeysInQueryString(campaignSuffix);
    const spec = buildUtmSpec('google', { campaign: '{campaignid}' });

    let changed = false;
    const retaggedUrls = finalUrls.map((finalUrl) => {
      const urlKeys = readUtmKeys(finalUrl);
      if (!urlKeys) return finalUrl; // unreadable — never risk a duplicate, leave as-is

      const omit = new Set<string>([...urlKeys, ...inheritedKeys]);
      const additions = utmQueryString(spec, omit);
      if (!additions) return finalUrl; // this url is already fully tagged

      const hashIndex = finalUrl.indexOf('#');
      const base = hashIndex === -1 ? finalUrl : finalUrl.slice(0, hashIndex);
      const fragment = hashIndex === -1 ? '' : finalUrl.slice(hashIndex);
      const queryIndex = base.indexOf('?');
      const separator = queryIndex === -1 ? '?' : queryIndex === base.length - 1 ? '' : '&';
      changed = true;
      return `${base}${separator}${additions}${fragment}`;
    });

    if (!changed) return { success: false }; // nothing missing on any url

    await this.mutate(customerId, accessToken, 'assetGroups', [{
      update: { resourceName: assetGroupResourceName, finalUrls: retaggedUrls },
      updateMask: 'final_urls',
    }], loginCustomerId);
    return { success: true };
  }

  async removeAd(userId: string, customerId: string, adGroupAdResourceName: string): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    await this.mutate(customerId, accessToken, 'adGroupAds', [{ remove: adGroupAdResourceName }], loginCustomerId);
  }

  // ── Assets ───────────────────────────────────────────────────────────────

  async uploadAsset(userId: string, customerId: string, asset: {
    type: 'IMAGE' | 'LOGO' | 'VIDEO';
    name: string;
    data: Buffer | string;
  }): Promise<string> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

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
    }], loginCustomerId);
    return data.results[0].resourceName;
  }

  async attachCampaignAssets(userId: string, customerId: string, campaignResourceName: string, assets: {
    fieldType: 'BUSINESS_NAME' | 'LOGO' | 'SQUARE_MARKETING_IMAGE' | 'MARKETING_IMAGE' | 'HEADLINE' | 'DESCRIPTION';
    assetResourceName?: string;
    text?: string;
  }[]): Promise<void> {
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const operations: any[] = [];
    for (const asset of assets) {
      let assetResourceName = asset.assetResourceName;
      if (!assetResourceName && asset.text) {
        const textData = await this.mutate(customerId, accessToken, 'assets', [{
          create: { name: asset.text.substring(0, 50), type: 'TEXT', textAsset: { text: asset.text } },
        }], loginCustomerId);
        assetResourceName = textData.results[0].resourceName;
      }
      if (!assetResourceName) {
        throw new Error(`attachCampaignAssets: asset with fieldType "${asset.fieldType}" must provide either assetResourceName or text`);
      }
      operations.push({ create: { campaign: campaignResourceName, asset: assetResourceName, fieldType: asset.fieldType } });
    }
    await this.mutate(customerId, accessToken, 'campaignAssets', operations, loginCustomerId);
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
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);

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

    // ENG-239: PMax asset groups have no `final_url_suffix` field (unlike Ad and
    // Campaign), so the per-asset-group way to tag the destination is to merge the
    // UTMs straight into `final_urls`. `mergeUtmIntoUrl` is per-key, so a UTM the
    // user already set is left untouched (AC4); ValueTrack macros pass through
    // un-encoded and resolve at click time.
    //
    // No `content` here: Google's own developer docs mark `{creative}` unsupported
    // for Performance Max (developers.google.com/google-ads/api/performance-max/
    // valuetrack) -- it never resolves on a PMax asset group, so emitting it would
    // bake literal, permanently-unresolved text into every click URL. Same fallback
    // LinkedIn already uses for a macro it can't supply.
    // Tagging is a best-effort overlay; it must never be the reason a whole PMax
    // build (headlines, images, links — already assembled at this point) gets
    // thrown away. Google surfaces its own precise validation error for a bad URL.
    let finalUrlWithUtm: string;
    try {
      finalUrlWithUtm = mergeUtmIntoUrl(params.finalUrl, buildUtmSpec('google', { campaign: '{campaignid}' }));
    } catch {
      finalUrlWithUtm = params.finalUrl;
    }

    const assetGroupOp = {
      assetGroupOperation: {
        create: {
          resourceName: tempAssetGroupName,
          name: params.name,
          campaign: params.campaignResourceName,
          status: 'PAUSED',
          finalUrls: [finalUrlWithUtm],
        },
      },
    };

    // Order: text assets → asset group → links
    let mutateOps = [...assetOps, assetGroupOp, ...linkOps];
    let batchResult: any;
    try {
      batchResult = await this.batchMutate(customerId, accessToken, mutateOps, loginCustomerId);
    } catch (err: any) {
      // If brand guidelines enforced: logo must not be in asset group — retry without LOGO links
      const errStr = JSON.stringify(err?.response?.data || err?.message || '');
      if (errStr.includes('BRAND_ASSETS_NOT_LINKED_AT_CAMPAIGN_LEVEL') && errStr.includes('LOGO')) {
        const linkOpsNoLogo = linkOps.filter((op: any) => op.assetGroupAssetOperation?.create?.fieldType !== 'LOGO');
        mutateOps = [...assetOps, assetGroupOp, ...linkOpsNoLogo];
        batchResult = await this.batchMutate(customerId, accessToken, mutateOps, loginCustomerId);
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
    const { accessToken, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    return this.search(customerId, accessToken, gaqlQuery, loginCustomerId);
  }

  async getQuickMetrics(userId: string, customerId: string, options: {
    campaignIds?: string[];
    datePreset?: string;
  }): Promise<{ campaigns: any[]; totals: any; currency: string }> {
    const { accessToken, currency, loginCustomerId } = await this.getAccountCredentials(userId, customerId);
    const dateClause = options.datePreset ? `DURING ${options.datePreset}` : 'DURING LAST_30_DAYS';
    const whereClause = options.campaignIds?.length
      ? `WHERE campaign.id IN (${options.campaignIds.join(',')}) AND segments.date ${dateClause}`
      : `WHERE segments.date ${dateClause}`;

    const query = `SELECT campaign.id, campaign.name, campaign.status, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.ctr, metrics.average_cpc FROM campaign ${whereClause} ORDER BY metrics.cost_micros DESC`;
    const results = await this.search(customerId, accessToken, query, loginCustomerId);

    const campaigns = results.map((r: any) => {
      const m = r.metrics;
      const spendRaw = Number(m.costMicros || 0) / 1_000_000;
      const clicks = Number(m.clicks || 0);
      const impressions = Number(m.impressions || 0);
      return {
        id: String(r.campaign.id),
        name: r.campaign.name,
        status: r.campaign.status,
        impressions,
        clicks,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        spendRaw,
        spendFormatted: spendRaw.toFixed(2),
        conversions: Number(m.conversions || 0),
        avgCpc: clicks > 0 ? (spendRaw / clicks).toFixed(2) : '0.00',
      };
    });

    const totals = campaigns.reduce((acc, c) => ({
      impressions: acc.impressions + c.impressions,
      clicks: acc.clicks + c.clicks,
      spend: acc.spend + c.spendRaw,
      conversions: acc.conversions + c.conversions,
    }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });

    return { campaigns, totals, currency };
  }
}

export const googleAdsService = new GoogleAdsService();
