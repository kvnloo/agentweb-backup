import { FacebookAdsApi, User, AdAccount, Campaign, AdSet, AdCreative, Ad, CustomAudience } from 'facebook-nodejs-business-sdk';
import axios from 'axios';
import { MetaAdAccount, MetaPage } from '../types/meta';
import { INTEGRATION_CONFIG } from '../config/integrations';
import { getMetaCredentials } from '../utils/secretsManager';
import { buildUtmSpec, utmQueryString, existingUtmKeys } from '../utils/adUtm';

export interface MetaAdsCampaignParams {
  name: string;
  objective: string;
  status?: string;
  special_ad_categories?: string[];
}

export interface MetaAdsAdSetParams {
  name: string;
  campaign_id: string;
  daily_budget?: number; // Budget in CENTS (e.g., 100 = $1.00). Caller must convert.
  lifetime_budget?: number; // Budget in CENTS (e.g., 5000 = $50.00). Caller must convert.
  start_time?: string;
  end_time?: string;
  billing_event: string;
  optimization_goal: string;
  bid_strategy?: string;
  bid_amount?: number; // Bid in CENTS (e.g., 50 = $0.50). Caller must convert.
  targeting: any;
  status?: string;
  promoted_object?: any;
}

export interface MetaPlacementAsset {
  image_hash?: string;
  image_url?: string;
  // Friendly placement group tokens (e.g. ["story", "reels"]) that this image should serve to.
  // Omit (or set is_default) on exactly one asset to designate the fallback image (typically the
  // square/4:5 Feed image) that serves every placement not matched by another rule.
  placements?: string[];
  is_default?: boolean;
  // Power-user escape hatch: a raw Meta customization_spec to use verbatim instead of `placements`.
  customization_spec?: any;
}

export interface MetaAdsAdCreativeParams {
  name: string;
  page_id: string;
  // Instagram actor for the creative. Required by Meta when the creative serves Instagram
  // placements (e.g. placement_assets targeting story/reels) — without it, attaching the creative
  // to an ad fails with error_subcode 1772103 "Instagram Account Is Missing". For placement_assets
  // creatives the agentMode layer auto-resolves this from the Page when omitted.
  instagram_user_id?: string;
  image_hash?: string;
  image_url?: string;
  video_id?: string;
  carousel_cards?: Array<{
    image_hash?: string;
    image_url?: string;
    title?: string;
    description?: string;
    link_url?: string;
    video_id?: string;
  }>;
  // Placement-level asset customization: map different images to different placements within a
  // single creative (e.g. square → Feed, 9:16 → Stories/Reels) via Meta's asset_feed_spec /
  // asset_customization_rules. Mutually exclusive with video_id and carousel_cards.
  placement_assets?: MetaPlacementAsset[];
  body: string;
  title: string;
  link_url: string;
  call_to_action_type?: string;
  // URL append rules (UTM parameters). Stored on the creative as `url_tags` and applied by Meta to
  // the destination link at delivery time. Must be carried over on a creative swap, otherwise a
  // link_url update silently strips the ad's tracking parameters.
  url_tags?: string;
}

export interface MetaAdsAdParams {
  name: string;
  adset_id: string;
  creative_id: string;
  status?: string;
}

export class MetaService {
  private static instance: MetaService;

  private constructor() {
    // SDK is initialized per request with access token
  }

  public static getInstance(): MetaService {
    if (!MetaService.instance) {
      MetaService.instance = new MetaService();
    }
    return MetaService.instance;
  }

  private appId: string | null = null;
  private appSecret: string | null = null;

  /**
   * Initialize the Facebook Ads API with the provided access token
   */
  private initApi(accessToken: string): InstanceType<typeof FacebookAdsApi> {
    const api = FacebookAdsApi.init(accessToken);
    return api;
  }

  private log(message: string, data?: any) {
    console.log(`[MetaService] ${message}`, data ? JSON.stringify(data, null, 2) : '');
  }

  /**
   * Handle SDK errors
   */
  private handleError(error: any, context?: string): void {
    if (context) {
      console.error(`[MetaAdsError] --- START ERROR LOG ---`);
      console.error(`[MetaAdsError] Context: ${context}`);
      
      const fbError = error.response || error.error || error;
      const responseData = error.response?.data || error.response || {};
      
      const structuredError: any = {
        message: responseData.message || fbError.message || error.message,
        code: responseData.code || fbError.code || error.code,
        error_subcode: responseData.error_subcode || fbError.error_subcode || error.error_subcode,
        error_user_title: responseData.error_user_title || fbError.error_user_title || error.error_user_title,
        error_user_msg: responseData.error_user_msg || fbError.error_user_msg || error.error_user_msg,
        fbtrace_id: responseData.fbtrace_id || fbError.fbtrace_id || error.fbtrace_id,
        classification: 'UNKNOWN_ERROR'
      };

      // Deterministic Error Classification
      const code = Number(structuredError.code);
      if (code === 100) {
        structuredError.classification = 'VALIDATION_ERROR';
      } else if ([1, 2, 4, 17].includes(code)) {
        structuredError.classification = 'RETRYABLE_ERROR';
      } else if (code === 368) {
        structuredError.classification = 'RETRYABLE_WITH_BACKOFF';
      } else if (code === 10 || (code >= 200 && code <= 299)) {
        structuredError.classification = 'PERMISSION_ERROR';
      }

      console.error(`[MetaAdsError] Structured Data:`, JSON.stringify(structuredError, null, 2));
      console.error(`[MetaAdsError] --- END ERROR LOG ---`);
      
      // Attach structured error to the original error object before throwing
      const enhancedError = error instanceof Error ? error : new Error(structuredError.message);
      (enhancedError as any).structuredError = structuredError;
      throw enhancedError;
    }

    console.error('Meta SDK Error:', error);

    // The SDK error structure might vary, but typically it has a response object
    const responseBy = error.response;

    if (responseBy) {
      const status = responseBy.status;
      // Try to extract error message safely
      const data = responseBy.data || {};
      const message = data.error?.message || error.message;

      if (status === 401 || status === 190) {
        throw new Error('Meta access token expired or invalid');
      }
      if (status === 403) {
        throw new Error(`Meta Permission Denied: ${message}`);
      }
      if (status === 429) {
        throw new Error('Meta rate limit exceeded');
      }
      throw new Error(`Meta API Error: ${message}`);
    }

    throw error;
  }

  public setAppCredentials(appId: string, appSecret: string) {
    this.appId = appId;
    this.appSecret = appSecret;
  }

  /**
   * Validate campaign params before hitting the Meta API.
   * Throws a descriptive Error if validation fails.
   */
  public static validateCampaignParams(action: string, params: Partial<MetaAdsCampaignParams>): void {
    if (action !== 'CREATE') return;

    if (!params.name) {
      throw new Error('Campaign CREATE requires "name".');
    }

    const validObjectives = [
      'OUTCOME_TRAFFIC',
      'OUTCOME_AWARENESS',
      'OUTCOME_ENGAGEMENT',
      'OUTCOME_SALES',
      'OUTCOME_LEADS',
      'OUTCOME_APP_PROMOTION'
    ];
    if (!params.objective) {
      throw new Error(`Campaign CREATE requires "objective". Valid values: ${validObjectives.join(', ')}.`);
    }
    if (!validObjectives.includes(params.objective)) {
      throw new Error(`Invalid objective "${params.objective}". Must be one of: ${validObjectives.join(', ')}.`);
    }

    if (params.special_ad_categories !== undefined && !Array.isArray(params.special_ad_categories)) {
      throw new Error('Campaign "special_ad_categories" must be an array (e.g. ["NONE"]).');
    }
  }

  /**
   * Validate ad creative params before hitting the Meta API.
   * Throws a descriptive Error if validation fails.
   */
  public static validateCreativeParams(action: string, params: Partial<MetaAdsAdCreativeParams>): void {
    if (action !== 'CREATE') return;

    // name, page_id, body are required for all creative types
    for (const field of ['name', 'page_id', 'body'] as Array<keyof MetaAdsAdCreativeParams>) {
      if (!params[field]) {
        throw new Error(`Ad Creative CREATE requires "${field}".`);
      }
    }

    const hasVideo = !!params.video_id;
    const hasCarousel = !!params.carousel_cards;
    const hasPlacementAssets = !!params.placement_assets;
    const hasImage = !!(params.image_hash || params.image_url);

    // title and link_url are only required for non-carousel creatives (for carousel they live per-card)
    if (!hasCarousel) {
      for (const field of ['title', 'link_url'] as Array<keyof MetaAdsAdCreativeParams>) {
        if (!params[field]) {
          throw new Error(`Ad Creative CREATE requires "${field}".`);
        }
      }
    }

    // The four creative types are mutually exclusive — exactly one shape per creative.
    const typeCount = [hasVideo, hasCarousel, hasPlacementAssets].filter(Boolean).length;
    if (typeCount > 1) {
      throw new Error(
        'Ad Creative CREATE: "video_id", "carousel_cards", and "placement_assets" are mutually exclusive. ' +
        'For a video creative provide video_id; for carousel provide carousel_cards (2–10 items); ' +
        'for placement-customized images provide placement_assets; for a single image provide image_hash or image_url.'
      );
    }

    if (hasPlacementAssets) {
      MetaService.validatePlacementAssets(params.placement_assets!);
      return; // placement assets validated
    }

    if (hasCarousel) {
      if (!Array.isArray(params.carousel_cards) || params.carousel_cards.length < 2 || params.carousel_cards.length > 10) {
        throw new Error('Ad Creative CREATE: "carousel_cards" must be an array of 2–10 items.');
      }
      for (let i = 0; i < params.carousel_cards.length; i++) {
        const card = params.carousel_cards[i];
        if (!card.image_hash && !card.image_url && !card.video_id) {
          throw new Error(`Ad Creative CREATE: carousel_cards[${i}] must have at least one of image_hash, image_url, or video_id.`);
        }
      }
      return; // carousel validated
    }

    if (hasVideo) {
      // Meta requires a thumbnail for video creatives (image_hash or image_url)
      if (!hasImage) {
        throw new Error(
          'Ad Creative CREATE: video creatives require a thumbnail. ' +
          'Provide image_hash (from UPLOAD_IMAGE) or image_url alongside video_id. ' +
          'Upload a thumbnail image first using AD_CREATIVE UPLOAD_IMAGE, then pass the returned image_hash.'
        );
      }
      return; // video + thumbnail validated
    }

    if (!hasImage) {
      throw new Error(
        'Ad Creative CREATE: must specify a creative type. ' +
        'For a video creative provide video_id + image_hash/image_url (thumbnail); ' +
        'for carousel provide carousel_cards (2–10 items); ' +
        'for placement-customized images provide placement_assets; ' +
        'for image provide image_hash or image_url.'
      );
    }
  }

  /**
   * Friendly placement-group tokens → the Meta customization_spec they expand to.
   * Each spec scopes a rule to specific publisher platforms + positions so a given image
   * only serves the placements it was designed for (e.g. a 9:16 asset for Stories/Reels).
   */
  private static readonly PLACEMENT_SPEC_MAP: Record<string, any> = {
    feed: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['feed'],
      instagram_positions: ['stream'],
    },
    facebook_feed: {
      publisher_platforms: ['facebook'],
      facebook_positions: ['feed'],
    },
    instagram_feed: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['stream'],
    },
    story: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['story'],
      instagram_positions: ['story'],
    },
    stories: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['story'],
      instagram_positions: ['story'],
    },
    facebook_story: {
      publisher_platforms: ['facebook'],
      facebook_positions: ['story'],
    },
    instagram_story: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['story'],
    },
    reels: {
      publisher_platforms: ['facebook', 'instagram'],
      facebook_positions: ['facebook_reels'],
      instagram_positions: ['reels'],
    },
    facebook_reels: {
      publisher_platforms: ['facebook'],
      facebook_positions: ['facebook_reels'],
    },
    instagram_reels: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['reels'],
    },
    explore: {
      publisher_platforms: ['instagram'],
      instagram_positions: ['explore'],
    },
  };

  /** Placement tokens accepted in placement_assets[].placements. */
  public static get supportedPlacementTokens(): string[] {
    return Object.keys(MetaService.PLACEMENT_SPEC_MAP);
  }

  /** True if the given placement token serves an Instagram placement. */
  public static placementTokenTargetsInstagram(token: string): boolean {
    const spec = MetaService.PLACEMENT_SPEC_MAP[String(token).toLowerCase()];
    return !!spec?.publisher_platforms?.includes('instagram');
  }

  /**
   * Validate the placement_assets array used for placement-level image customization.
   * Throws a descriptive Error if validation fails.
   */
  public static validatePlacementAssets(assets: MetaPlacementAsset[]): void {
    if (!Array.isArray(assets) || assets.length < 2) {
      throw new Error(
        'Ad Creative CREATE: "placement_assets" must be an array of at least 2 items ' +
        '(e.g. a square image for Feed and a 9:16 image for Stories/Reels). ' +
        'For a single image use image_hash/image_url instead.'
      );
    }

    let defaultCount = 0;
    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (!asset.image_hash && !asset.image_url) {
        throw new Error(`Ad Creative CREATE: placement_assets[${i}] must have image_hash or image_url.`);
      }

      const isDefault = asset.is_default || !asset.placements || asset.placements.length === 0;
      if (isDefault) {
        defaultCount++;
      } else {
        for (const token of asset.placements!) {
          if (!asset.customization_spec && !MetaService.PLACEMENT_SPEC_MAP[String(token).toLowerCase()]) {
            throw new Error(
              `Ad Creative CREATE: placement_assets[${i}] has unknown placement "${token}". ` +
              `Supported: ${MetaService.supportedPlacementTokens.join(', ')}.`
            );
          }
        }
      }
    }

    if (defaultCount !== 1) {
      throw new Error(
        `Ad Creative CREATE: placement_assets must designate exactly one default/fallback image ` +
        `(via is_default: true or by omitting placements), found ${defaultCount}. ` +
        `The default serves every placement not matched by another asset.`
      );
    }
  }

  /**
   * Expand a list of friendly placement tokens into a single Meta customization_spec by
   * unioning their publisher_platforms / *_positions. Returns null if no tokens map.
   */
  private static buildCustomizationSpec(placements: string[]): any | null {
    const spec: Record<string, Set<string>> = {};
    for (const token of placements) {
      const mapped = MetaService.PLACEMENT_SPEC_MAP[String(token).toLowerCase()];
      if (!mapped) continue;
      for (const key of Object.keys(mapped)) {
        if (!spec[key]) spec[key] = new Set();
        for (const val of mapped[key]) spec[key].add(val);
      }
    }
    const keys = Object.keys(spec);
    if (keys.length === 0) return null;
    const out: Record<string, string[]> = {};
    for (const key of keys) out[key] = Array.from(spec[key]);
    return out;
  }

  /**
   * Validate ad params before hitting the Meta API.
   * Throws a descriptive Error if validation fails.
   */
  public static validateAdParams(action: string, params: Partial<MetaAdsAdParams> & { adset_id?: string }): void {
    if (action !== 'CREATE') return;

    if (!params.name) {
      throw new Error('Ad CREATE requires "name".');
    }
    if (!params.creative_id) {
      throw new Error('Ad CREATE requires "creative_id". Create an ad creative first using AD_CREATIVE CREATE.');
    }
    if (!params.adset_id) {
      throw new Error('Ad CREATE requires "ad_set_id" (top-level parameter). Specify which ad set this ad belongs to.');
    }
  }

  /**
   * Get ad accounts accessible by the user using Facebook SDK
   * @param accessToken - Meta OAuth access token
   * @returns Array of ad account objects
   */
  async getAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
    try {
      this.initApi(accessToken);
      const user = new User('me');
      // Do NOT request 'owner' here: since ~June 2026 Meta silently omits every ad
      // account the user does not personally own (business/shared accounts) from the
      // response when 'owner' is in the field list, leaving most customers with an
      // empty list. 'business' is unused downstream, so it is not requested either.
      const fields = ['id', 'name', 'account_id', 'currency', 'account_status'];

      const adAccountsPath = await user.getAdAccounts(fields);

      return adAccountsPath
        .filter((account: any) => account.account_id)
        .map((account: any) => ({
          id: account.id,
          name: account.name,
          account_id: account.account_id,
          currency: account.currency,
          account_status: account.account_status
        }));

    } catch (error: any) {
      this.handleError(error);
      return []; // Unreachable due to throw in handleError
    }
  }

  /**
   * Re-exchange a still-valid long-lived Meta user access token for a fresh
   * 60-day long-lived token.
   *
   * Meta/Facebook do NOT issue refresh tokens for ad-account (Marketing API)
   * access. Instead, a long-lived token that is not yet expired can be swapped
   * for a new one via grant_type=fb_exchange_token. This MUST be done while the
   * current token is still valid — once expired, the only recovery is a full
   * manual reconnect. This is why refreshes need to happen proactively.
   *
   * @param currentToken - The current (still-valid) long-lived access token.
   * @returns The new access token and its lifetime in seconds. `expires_in`
   *          may be absent if Meta returns a non-expiring token, in which case
   *          callers should fall back to the 60-day convention.
   * @throws if the exchange fails (e.g. token already expired/revoked).
   */
  async extendAccessToken(currentToken: string): Promise<{ access_token: string; expires_in?: number }> {
    const { clientId, clientSecret } = await getMetaCredentials();
    const url = `${INTEGRATION_CONFIG.meta.tokenUrl}`;
    const response = await axios.get<any>(url, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: clientId,
        client_secret: clientSecret,
        fb_exchange_token: currentToken,
      },
      timeout: 15000,
    });

    const accessToken = response.data?.access_token;
    if (!accessToken) {
      throw new Error('Meta token exchange returned no access_token');
    }
    return {
      access_token: accessToken,
      expires_in: response.data?.expires_in,
    };
  }

  /**
   * Get pages managed by the user using Facebook SDK
   * IMPORTANT: Each page has its own page_access_token
   * @param accessToken - Meta OAuth user access token
   * @returns Array of page objects with page-specific tokens
   */
  async getPages(accessToken: string): Promise<MetaPage[]> {
    try {
      this.initApi(accessToken);
      const user = new User('me');
      const fields = ['id', 'name', 'access_token', 'category', 'tasks'];

      // Fetch pages (accounts edge on User)
      const pagesPath = await user.getAccounts(fields);

      const pages = pagesPath.map((page: any) => ({
        id: page.id || page._data?.id,
        name: page.name || page._data?.name,
        access_token: page.access_token || page._data?.access_token,
        category: page.category || page._data?.category,
        tasks: page.tasks || page._data?.tasks
      }));

      if (pages.length > 0) return pages;

      // Meta quirk: tokens whose page access comes via Business Manager task
      // assignment (Facebook Login for Business) return [] from /me/accounts even
      // though the user opted those pages in during consent. The opted-in page IDs
      // ARE present in debug_token granular_scopes, and direct per-page reads work.
      return await this.getPagesFromGranularScopes(accessToken);

    } catch (error: any) {
      this.handleError(error);
      return []; // Unreachable
    }
  }

  /**
   * Best-effort fallback for getPages: enumerate the page IDs the user opted in
   * during OAuth (debug_token granular_scopes → pages_show_list.target_ids) and
   * read each page directly. Returns [] on any failure rather than throwing —
   * callers treat "no pages" as a soft state.
   */
  private async getPagesFromGranularScopes(accessToken: string): Promise<MetaPage[]> {
    try {
      const { getMetaCredentials } = await import('../utils/secretsManager');
      const creds = await getMetaCredentials();
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const appToken = `${creds.clientId}|${creds.clientSecret}`;

      const dbgRes = await fetch(
        `https://graph.facebook.com/${apiVersion}/debug_token?input_token=${accessToken}&access_token=${appToken}`
      );
      const dbg: any = await dbgRes.json();
      const granular: any[] = dbg?.data?.granular_scopes || [];
      const pageIds: string[] = granular.find((g: any) => g.scope === 'pages_show_list')?.target_ids || [];
      if (pageIds.length === 0) return [];

      const pages: MetaPage[] = [];
      for (const pageId of pageIds) {
        const pageRes = await fetch(
          `https://graph.facebook.com/${apiVersion}/${pageId}?fields=id,name,access_token,category&access_token=${accessToken}`
        );
        const page: any = await pageRes.json();
        if (page?.error || !page?.id) {
          console.warn(`[MetaService] getPages granular fallback: skipping page ${pageId}: ${page?.error?.message ?? 'no id in response'}`);
          continue;
        }
        pages.push({
          id: page.id,
          name: page.name,
          access_token: page.access_token,
          category: page.category,
          // tasks omitted — the field is not readable on business-task-assigned pages
        });
      }
      this.log(`getPages granular fallback returned ${pages.length} page(s)`);
      return pages;
    } catch (error: any) {
      console.warn(`[MetaService] getPages granular fallback failed: ${error?.message ?? error}`);
      return [];
    }
  }

  /**
   * Resolve the Instagram actor ID linked to a Facebook Page. Needed when building creatives that
   * serve Instagram placements (asset_feed_spec with story/reels rules), where Meta requires
   * object_story_spec.instagram_user_id or the ad fails with error_subcode 1772103
   * ("Instagram Account Is Missing"). Returns null if no IG account is linked or on error.
   */
  public async getPageInstagramActor(accessToken: string, pageId: string): Promise<string | null> {
    const extractInstagramActor = (result: any): string | null => {
      const data = result?._data || result || {};
      return data.instagram_business_account?.id || data.connected_instagram_account?.id || null;
    };

    try {
      const api = this.initApi(accessToken);
      // Use the generic Graph call — the SDK's Page object is not exported in its TS types.
      const result: any = await api.call('GET', [pageId], {
        fields: 'instagram_business_account,connected_instagram_account',
      });
      const igId = extractInstagramActor(result);
      if (igId) return igId;
    } catch (error: any) {
      console.warn(`[MetaService] getPageInstagramActor user-token lookup failed for page ${pageId}: ${error?.message}`);
    }

    try {
      const pages = await this.getPages(accessToken);
      const page = pages.find((p: any) => String(p.id) === String(pageId));
      const pageAccessToken = page?.access_token;
      if (!pageAccessToken || pageAccessToken === accessToken) return null;

      const pageApi = this.initApi(pageAccessToken);
      const pageResult: any = await pageApi.call('GET', [pageId], {
        fields: 'instagram_business_account,connected_instagram_account',
      });
      return extractInstagramActor(pageResult);
    } catch (error: any) {
      // Non-fatal: callers proceed without an IG actor (Facebook-only placements still work).
      console.warn(`[MetaService] getPageInstagramActor page-token lookup failed for page ${pageId}: ${error?.message}`);
      return null;
    }
  }

  /**
   * Verify if an access token is still valid
   * @param accessToken - Meta OAuth access token
   * @returns Object with valid status and optional error message
   */
  async verifyToken(accessToken: string): Promise<{ valid: boolean; error?: string }> {
    try {
      this.initApi(accessToken);
      const user = new User('me');
      await user.get(['id']); // Simple fetch to verify token
      return { valid: true };
    } catch (error: any) {
      const responseBy = error.response;
      if (responseBy) {
        const status = responseBy.status;
        if (status === 401 || status === 190) {
          return { valid: false, error: 'Token expired or revoked' };
        }
        if (status === 403) {
          return { valid: false, error: 'Token permissions revoked' };
        }
      }

      console.warn('[Meta verifyToken] Error:', error.message);
      return { valid: false, error: 'Could not verify token' };
    }
  }

  /**
   * Get user profile information
   * @param accessToken - Meta OAuth access token
   * @returns User profile with id, name, and email
   */
  async getUserProfile(accessToken: string): Promise<{
    id: string;
    name: string;
    email?: string;
  }> {
    try {
      this.initApi(accessToken);
      // The SDK returns a User object which should contain the requested fields.
      // TypeScript might not know about dynamic fields, so we cast to any to access them.
      const user = new User('me');
      const response = await user.get(['id', 'name', 'email']) as any;

      return {
        id: response.id,
        name: response.name,
        email: response.email
      };
    } catch (error: any) {
      this.handleError(error);
      throw error;
    }
  }

  /**
   * Get a single campaign
   */
  public async getCampaign(adAccountId: string, accessToken: string, campaignId: string) {
    try {
      this.initApi(accessToken);
      const campaign = new Campaign(campaignId);
      const fields = ['id', 'name', 'status', 'objective', 'daily_budget', 'lifetime_budget', 'budget_remaining'];
      this.log(`Fetching campaign: ${campaignId}`);
      const result = await campaign.get(fields);
      return result._data;
    } catch (error) {
      return this.handleError(error, 'getCampaign');
    }
  }

  /**
   * List campaigns for an ad account
   */
  public async listCampaigns(adAccountId: string, accessToken: string) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = ['id', 'name', 'status', 'objective', 'start_time', 'stop_time'];
      this.log(`Listing campaigns for account: ${adAccountId}`, { fields });
      const campaigns = await account.getCampaigns(fields);
      return campaigns.map((c: any) => c._data);
    } catch (error) {
      return this.handleError(error, 'listCampaigns');
    }
  }

  /**
   * Create a new campaign
   */
  public async createCampaign(adAccountId: string, accessToken: string, params: MetaAdsCampaignParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const specialCategories = (params.special_ad_categories || [])
        .filter(cat => cat !== 'NONE' && cat !== '');

      // Use literal strings for keys to avoid any SDK field mapping issues
      const finalParams: any = {
        name: params.name,
        objective: params.objective,
        status: params.status || 'PAUSED',
        special_ad_categories: specialCategories,
        is_adset_budget_sharing_enabled: false, // Required by some accounts when CBO is off
      };

      // Handle Advantage Campaign Budget (CBO)
      if ((params as any).advantage_campaign_budget && (params as any).budget_amount) {
        finalParams.daily_budget = Math.round((params as any).budget_amount * 100);
      }

      this.log(`Attempting createCampaign with literal keys:`, finalParams);
      
      // Request 'id' back to ensure we don't get an empty return
      const campaign = await account.createCampaign(['id'], finalParams);
      return campaign._data;
    } catch (error) {
      return this.handleError(error, 'createCampaign');
    }
  }

  /**
   * Update campaign
   */
  public async updateCampaign(accessToken: string, campaignId: string, params: any) {
    try {
      this.initApi(accessToken);
      const campaign = new Campaign(campaignId);
      this.log(`Updating campaign ${campaignId} with params:`, params);
      await campaign.update([], params);
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'updateCampaign');
    }
  }

  /**
   * Delete a campaign
   */
  public async deleteCampaign(accessToken: string, campaignId: string) {
    try {
      this.initApi(accessToken);
      const campaign = new Campaign(campaignId);
      this.log(`Deleting campaign ${campaignId}`);
      await campaign.delete([], {});
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'deleteCampaign');
    }
  }

  /**
   * List ad sets for an ad account
   */
  public async listAdSets(adAccountId: string, accessToken: string, campaignId?: string) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = ['id', 'name', 'status', 'campaign_id', 'daily_budget', 'lifetime_budget', 'start_time', 'end_time', 'targeting'];
      const params = campaignId ? { campaign_id: campaignId } : {};
      this.log(`Listing ad sets for account: ${adAccountId}`, { fields, ...params });
      const adSets = await account.getAdSets(fields, params);
      return adSets.map((as: any) => as._data);
    } catch (error) {
      return this.handleError(error, 'listAdSets');
    }
  }

  /**
   * Create a new ad set
   */
  public async createAdSet(adAccountId: string, accessToken: string, params: MetaAdsAdSetParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      
      const adSetParams: any = {};
      
      // Mandatory Mapping (Strict !== undefined)
      if (params.name !== undefined) adSetParams[AdSet.Fields.name] = params.name;
      if (params.campaign_id !== undefined) adSetParams[AdSet.Fields.campaign_id] = params.campaign_id;
      if (params.billing_event !== undefined) adSetParams[AdSet.Fields.billing_event] = params.billing_event;
      if (params.optimization_goal !== undefined) adSetParams[AdSet.Fields.optimization_goal] = params.optimization_goal;
      if (params.targeting !== undefined) adSetParams[AdSet.Fields.targeting] = params.targeting;
      if (params.status !== undefined) adSetParams[AdSet.Fields.status] = params.status;
      
      // Monetary values: Expected in CENTS (integer). Caller (agentModeService.createMetaAdsAdSet)
      // converts dollars to cents via Math.round(val * 100) before passing to this method.
      if (params.daily_budget !== undefined) adSetParams[AdSet.Fields.daily_budget] = params.daily_budget;
      if (params.lifetime_budget !== undefined) adSetParams[AdSet.Fields.lifetime_budget] = params.lifetime_budget;
      if (params.bid_strategy !== undefined) adSetParams[AdSet.Fields.bid_strategy] = params.bid_strategy;
      if (params.bid_amount !== undefined) adSetParams[AdSet.Fields.bid_amount] = params.bid_amount;

      // Scheduling
      if (params.start_time !== undefined) adSetParams[AdSet.Fields.start_time] = params.start_time;
      if (params.end_time !== undefined) adSetParams[AdSet.Fields.end_time] = params.end_time;
      if (params.promoted_object !== undefined) adSetParams[AdSet.Fields.promoted_object] = params.promoted_object;

      // Defensive: Ensure no 'id' or other accidental fields
      delete adSetParams.id;
      delete adSetParams.account_id;

      this.log(`Creating ad set in account: ${adAccountId} with payload:`, adSetParams);
      
      // Note: SDK v24.0.1+ internal POST mapping handlesact_ prefix and body params correctly.
      const adSet = await account.createAdSet([], adSetParams);
      return adSet._data;
    } catch (error: any) {
      return this.handleError(error, 'createAdSet');
    }
  }

  /**
   * Get a single ad set with the fields needed to confirm a write target
   * (name + the campaign it belongs to).
   */
  public async getAdSet(accessToken: string, adSetId: string) {
    try {
      this.initApi(accessToken);
      const adSet = new AdSet(adSetId);
      const fields = ['id', 'name', 'status', 'campaign_id'];
      this.log(`Fetching ad set: ${adSetId}`);
      const result = await adSet.get(fields);
      return result._data;
    } catch (error) {
      return this.handleError(error, 'getAdSet');
    }
  }

  /**
   * Update ad set
   */
  public async updateAdSet(accessToken: string, adSetId: string, params: any) {
    try {
      this.initApi(accessToken);
      const adSet = new AdSet(adSetId);
      this.log(`Updating ad set ${adSetId} with params:`, params);
      await adSet.update([], params);
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'updateAdSet');
    }
  }

  /**
   * Delete an ad set
   */
  public async deleteAdSet(accessToken: string, adSetId: string) {
    try {
      this.initApi(accessToken);
      const adSet = new AdSet(adSetId);
      this.log(`Deleting ad set ${adSetId}`);
      await adSet.delete([], {});
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'deleteAdSet');
    }
  }

  /**
   * List ad creatives for an ad account
   */
  public async listAdCreatives(adAccountId: string, accessToken: string) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = ['id', 'name', 'status', 'body', 'title', 'image_url', 'thumbnail_url', 'object_type', 'link_url', 'object_story_spec', 'url_tags'];
      this.log(`Listing ad creatives for account: ${adAccountId}`, { fields });
      const creatives = await account.getAdCreatives(fields);
      return creatives.map((c: any) => c._data);
    } catch (error) {
      return this.handleError(error, 'listAdCreatives');
    }
  }

  /**
   * Resolve the creative-level `url_tags` (UTM append rules) for a creative (ENG-239).
   *
   * An explicitly-supplied `params.url_tags` always wins and is returned verbatim —
   * this both honours a caller who hand-authored tracking and preserves the
   * carried-over `url_tags` on a creative swap (agentModeService's carriedUrlTags).
   *
   * Otherwise we auto-generate Emma's UTM set (utm_source=meta, utm_medium=paid,
   * utm_campaign / utm_content as Meta click-time macros).
   *
   * AC4 trap: Meta APPENDS `url_tags` to the destination link at delivery, so if the
   * link already carries e.g. `utm_source`, emitting it again produces a duplicate
   * param on the click URL. We therefore omit any UTM key the reference URL already
   * carries; if it carries them all, `utmQueryString` returns "" and we return
   * undefined so the caller writes no `url_tags` field at all.
   *
   * AC4 reference URL: `url_tags` is creative-level and Meta applies it to EVERY link
   * on the creative, but there is only one tag string. We reference `params.link_url`
   * (the single-image/video link, and the carousel fallback link at :989). Carousels
   * may omit the top-level link and rely on per-card `child_attachments[].link` (:992),
   * so when `link_url` is absent we fall back to the first card's `link_url`. If no
   * reference URL exists at all, we omit nothing and emit the full set.
   */
  private static resolveUrlTags(params: MetaAdsAdCreativeParams): string | undefined {
    if (params.url_tags) {
      return params.url_tags;
    }
    const spec = buildUtmSpec('meta', { campaign: '{{campaign.id}}', content: '{{ad.id}}' });
    const referenceUrl =
      params.link_url || params.carousel_cards?.find((c) => c.link_url)?.link_url;
    const omit = referenceUrl ? existingUtmKeys(referenceUrl) : new Set<string>();
    const tags = utmQueryString(spec, omit);
    return tags || undefined;
  }

  /**
   * Create a new ad creative (Supports Image, Video, Carousel)
   */
  public async createAdCreative(adAccountId: string, accessToken: string, params: MetaAdsAdCreativeParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);

      // --- Pre-flight Validation ---

      // Media source: at least one must be provided
      const hasMedia = params.image_hash || params.image_url || params.video_id ||
        (params.carousel_cards && params.carousel_cards.length > 0) ||
        (params.placement_assets && params.placement_assets.length > 0);
      if (!hasMedia) {
        throw new Error('Creative requires at least one media source: image_hash, image_url, video_id, carousel_cards, or placement_assets.');
      }

      // PLACEMENT-CUSTOMIZED IMAGE CREATIVE (asset_feed_spec) — different image per placement
      // (e.g. square → Feed, 9:16 → Stories/Reels) in a single creative. Handled separately
      // because it uses asset_feed_spec rather than object_story_spec.{link_data,video_data}.
      if (params.placement_assets && params.placement_assets.length > 0) {
        MetaService.validatePlacementAssets(params.placement_assets);
        return await this.createPlacementCustomizedCreative(account, adAccountId, params);
      }

      // Carousel card count: Meta requires 2-10
      if (params.carousel_cards && params.carousel_cards.length > 0) {
        if (params.carousel_cards.length < 2) {
          throw new Error(`Carousel requires at least 2 cards (got ${params.carousel_cards.length}). Add more cards or use a single image/video creative instead.`);
        }
        if (params.carousel_cards.length > 10) {
          throw new Error(`Carousel supports a maximum of 10 cards (got ${params.carousel_cards.length}).`);
        }
      }

      let objectStorySpec: any = {
        page_id: params.page_id,
      };

      // 1. VIDEO CREATIVE
      if (params.video_id) {
        // Meta requires exactly one thumbnail field in video_data: image_hash (preferred) or image_url.
        // Missing thumbnail → error_subcode 1443226 "Your ad needs a video thumbnail".
        if (!params.image_hash && !params.image_url) {
          throw new Error(
            'Video creative requires a thumbnail. ' +
            'Provide image_hash (from AD_CREATIVE UPLOAD_IMAGE) or image_url alongside video_id.'
          );
        }
        const videoData: any = {
          video_id: params.video_id,
          message: params.body,
          title: params.title,
          call_to_action: params.call_to_action_type ? {
            type: params.call_to_action_type,
            value: { link: params.link_url }
          } : undefined
        };
        // Prefer image_hash (uploaded asset) over image_url
        if (params.image_hash) {
          videoData.image_hash = params.image_hash;
        } else {
          videoData.image_url = params.image_url;
        }
        objectStorySpec.video_data = videoData;
      } 
      // 2. CAROUSEL CREATIVE
      else if (params.carousel_cards && params.carousel_cards.length > 0) {
        objectStorySpec.link_data = {
          message: params.body,
          link: params.link_url, // Fallback/Main link
          caption: params.link_url,
          child_attachments: params.carousel_cards.map(card => ({
            link: card.link_url || params.link_url,
            image_hash: card.image_hash,
            picture: card.image_url,
            name: card.title,
            description: card.description,
            video_id: card.video_id,
            call_to_action: params.call_to_action_type ? { // Inherit CTA or customize per card if needed
                type: params.call_to_action_type, 
                value: { link: card.link_url || params.link_url }
            } : undefined
          })),
          call_to_action: params.call_to_action_type ? {
            type: params.call_to_action_type,
            value: { link: params.link_url }
          } : undefined
        };
      } 
      // 3. SINGLE IMAGE CREATIVE (Default)
      else {
        objectStorySpec.link_data = {
          message: params.body,
          link: params.link_url,
          caption: params.link_url, // Link data caption must be a URL string
          name: params.title,    // Large headline title
          call_to_action: params.call_to_action_type ? {
            type: params.call_to_action_type,
            value: { link: params.link_url }
          } : undefined
        };

        if (params.image_hash) {
          objectStorySpec.link_data.image_hash = params.image_hash;
        } else if (params.image_url) {
          objectStorySpec.link_data.picture = params.image_url;
        }
      }

      const creativeParams: any = {
        [AdCreative.Fields.name]: params.name,
        [AdCreative.Fields.object_story_spec]: objectStorySpec
      };
      // Auto-generate UTM append rules when the caller supplies none (ENG-239), and
      // preserve an explicit value so a link_url swap doesn't strip them.
      const urlTags = MetaService.resolveUrlTags(params);
      if (urlTags) {
        creativeParams.url_tags = urlTags;
      }

      this.log(`Creating ad creative in account: ${adAccountId}`, creativeParams);
      const creative = await account.createAdCreative([], creativeParams);
      return creative._data;
    } catch (error) {
      return this.handleError(error, 'createAdCreative');
    }
  }

  /**
   * Build and create an AdCreative that maps different images to different placements within a
   * single creative, via Meta's asset_feed_spec + asset_customization_rules.
   *
   * Each placement_assets entry must already carry an image_hash (asset_feed_spec.images only
   * accepts hashes, not URLs — the caller resolves URLs to hashes before this point). Exactly one
   * asset is the default/fallback (is_default or no placements); the rest are scoped to placement
   * groups (feed, story, reels, …) which expand to Meta customization_spec objects.
   *
   * Shape matches Meta's Placement Asset Customization docs:
   *   object_story_spec: { page_id }
   *   asset_feed_spec: {
   *     images: [{ hash, adlabels: [{ name }] }, ...],
   *     bodies / titles / link_urls / call_to_action_types: [...],
   *     ad_formats: ['SINGLE_IMAGE'],
   *     optimization_type: 'PLACEMENT',
   *     asset_customization_rules: [
   *       { customization_spec: { publisher_platforms, *_positions }, image_label: { name } },  // scoped
   *       { customization_spec: {}, image_label: { name } },                                     // fallback
   *     ],
   *   }
   */
  private async createPlacementCustomizedCreative(
    account: InstanceType<typeof AdAccount>,
    adAccountId: string,
    params: MetaAdsAdCreativeParams
  ) {
    const assets = params.placement_assets!;

    const images: any[] = [];
    const rules: any[] = [];

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const hash = asset.image_hash;
      if (!hash) {
        // Defensive: the agentMode layer resolves URLs → hashes before calling us.
        throw new Error(
          `placement_assets[${i}] is missing image_hash. Upload the image via AD_CREATIVE UPLOAD_IMAGE first ` +
          `(asset_feed_spec requires image hashes, not URLs).`
        );
      }

      const label = `asset_${i}`;
      images.push({ hash, adlabels: [{ name: label }] });

      const isDefault = asset.is_default || !asset.placements || asset.placements.length === 0;
      if (isDefault) {
        // Per Meta docs, the fallback rule uses an EMPTY customization_spec ({}); it catches
        // every placement not matched by a scoped rule. (NOT { is_default: true } — that is invalid.)
        rules.push({
          customization_spec: {},
          image_label: { name: label },
        });
        continue;
      }

      const customizationSpec = asset.customization_spec || MetaService.buildCustomizationSpec(asset.placements!);
      if (!customizationSpec) {
        throw new Error(`placement_assets[${i}] resolved to an empty customization_spec.`);
      }
      rules.push({
        customization_spec: customizationSpec,
        image_label: { name: label },
      });
    }

    const assetFeedSpec: any = {
      images,
      bodies: [{ text: params.body }],
      titles: [{ text: params.title }],
      link_urls: [{ website_url: params.link_url }],
      ad_formats: ['SINGLE_IMAGE'],
      optimization_type: 'PLACEMENT',
      asset_customization_rules: rules,
    };
    if (params.call_to_action_type) {
      assetFeedSpec.call_to_action_types = [params.call_to_action_type];
    }

    // For asset_feed_spec creatives, all copy/link/format live in asset_feed_spec; object_story_spec
    // carries only the Page (and instagram_user_id). The IG actor is REQUIRED when the rules target
    // Instagram placements (story/reels) — Meta rejects the ad with error_subcode 1772103
    // "Instagram Account Is Missing" otherwise.
    const objectStorySpec: any = {
      page_id: params.page_id,
    };
    if (params.instagram_user_id) {
      objectStorySpec.instagram_user_id = params.instagram_user_id;
    }

    const creativeParams: any = {
      [AdCreative.Fields.name]: params.name,
      [AdCreative.Fields.object_story_spec]: objectStorySpec,
      asset_feed_spec: assetFeedSpec,
    };
    // Auto-generate UTM append rules when the caller supplies none (ENG-239), and
    // preserve an explicit value so a link_url swap doesn't strip them.
    const urlTags = MetaService.resolveUrlTags(params);
    if (urlTags) {
      creativeParams.url_tags = urlTags;
    }

    this.log(`Creating placement-customized ad creative in account: ${adAccountId}`, creativeParams);
    const creative = await account.createAdCreative([], creativeParams);
    return creative._data;
  }

  /**
   * List ads for an ad account
   */
  public async listAds(adAccountId: string, accessToken: string, adSetId?: string) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = [
        'id', 'name', 'status', 'effective_status', 'adset_id', 'campaign_id',
        'creative{id,name,body,title,image_url,thumbnail_url,object_story_spec}'
      ];
      // Include all non-deleted effective statuses so ads paused at the campaign/adset
      // level (effective_status=CAMPAIGN_PAUSED or ADSET_PAUSED) are not silently omitted.
      const params: Record<string, any> = {
        effective_status: [
          'ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED',
          'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED',
          'PENDING_BILLING_INFO', 'IN_PROCESS', 'WITH_ISSUES'
        ]
      };
      if (adSetId) params.adset_id = adSetId;
      this.log(`Listing ads for account: ${adAccountId}`, { fields, ...params });
      const ads = await account.getAds(fields, params);
      return ads.map((a: any) => a._data);
    } catch (error) {
      return this.handleError(error, 'listAds');
    }
  }

  /**
   * Create a new ad
   */
  public async createAd(adAccountId: string, accessToken: string, params: MetaAdsAdParams) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const adParams = {
        [Ad.Fields.name]: params.name,
        [Ad.Fields.adset_id]: params.adset_id,
        [Ad.Fields.creative]: { creative_id: params.creative_id },
        [Ad.Fields.status]: params.status || Ad.Status.paused,
      };
      this.log(`Creating ad in account: ${adAccountId}`, adParams);
      const ad = await account.createAd([], adParams);
      return ad._data;
    } catch (error) {
      return this.handleError(error, 'createAd');
    }
  }

  /**
   * Get a single ad with its creative reference
   */
  public async getAd(accessToken: string, adId: string) {
    try {
      this.initApi(accessToken);
      const ad = new Ad(adId);
      const fields = [
        'id', 'name', 'status', 'effective_status', 'adset_id', 'campaign_id',
        // ad_review_feedback + the creative's own status surface Meta's async policy/technical
        // review verdict, so a post-swap read-back can report PENDING/rejected creatives.
        'ad_review_feedback',
        'creative{id,name,body,title,image_url,thumbnail_url,object_story_spec,status}'
      ];
      this.log(`Fetching ad: ${adId}`);
      const result = await ad.get(fields);
      return result._data;
    } catch (error) {
      return this.handleError(error, 'getAd');
    }
  }

  /**
   * Get a single ad creative with full details including object_story_spec
   */
  public async getAdCreative(accessToken: string, creativeId: string) {
    try {
      this.initApi(accessToken);
      const creative = new AdCreative(creativeId);
      // object_story_spec must be expanded with explicit subfields — the Graph API only returns
      // image_hash when it is named directly; requesting the bare "object_story_spec" field
      // silently drops image_hash and returns only the hosted "picture" URL. Copy/reuse flows
      // (COPY_AD) that read the hash back to attach it to a new creative would otherwise always
      // fall back to re-uploading that low-res preview URL, which Meta's AdCreative create
      // endpoint rejects (error code 100, subcode 1487390).
      const objectStorySpecField =
        'object_story_spec{page_id,' +
        'link_data{link,message,caption,name,image_hash,picture,call_to_action,' +
        'child_attachments{link,image_hash,picture,name,description,video_id,call_to_action}},' +
        'video_data{video_id,image_hash,image_url,title,message,call_to_action}}';
      const fields = [
        'id', 'name', 'body', 'title', 'image_url', 'thumbnail_url',
        'object_type', 'link_url', objectStorySpecField, 'asset_feed_spec', 'url_tags'
      ];
      this.log(`Fetching ad creative: ${creativeId}`);
      const result = await creative.get(fields);
      return result._data;
    } catch (error) {
      return this.handleError(error, 'getAdCreative');
    }
  }

  /**
   * Update ad
   */
  public async updateAd(accessToken: string, adId: string, params: any) {
    try {
      this.initApi(accessToken);
      const ad = new Ad(adId);
      this.log(`Updating ad ${adId} with params:`, params);
      await ad.update([], params);
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'updateAd');
    }
  }

  /**
   * Delete an ad
   */
  public async deleteAd(accessToken: string, adId: string) {
    try {
      this.initApi(accessToken);
      const ad = new Ad(adId);
      this.log(`Deleting ad ${adId}`);
      await ad.delete([], {});
      return { success: true };
    } catch (error) {
      return this.handleError(error, 'deleteAd');
    }
  }

  // Meta's image-ad upload rejects oversized assets with a generic "Invalid parameter".
  // Downscale the longest side to this many pixels (Meta's recommended ad image max) and
  // keep the encoded file under the byte cap before uploading.
  private static readonly META_MAX_IMAGE_DIMENSION = 1936;
  private static readonly META_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

  /**
   * Downscale/re-encode an image so it fits within Meta's ad-image dimension and size
   * limits. Oversized images (e.g. 4096x4096 renders) are otherwise rejected by the
   * Marketing API with an unhelpful generic "Invalid parameter" error.
   *
   * Behaviour:
   * - If the image is already within both limits, the original buffer/filename is returned.
   * - Otherwise the longest side is fit inside META_MAX_IMAGE_DIMENSION (aspect ratio
   *   preserved, never enlarged). PNGs stay PNG (preserving transparency for logo creatives);
   *   only if a re-encoded PNG is still over the byte cap do we fall back to JPEG.
   * - If sharp is unavailable or fails, the original buffer is used so upload still attempts.
   */
  public async resizeImageForMeta(
    fileBuffer: Buffer,
    filename: string
  ): Promise<{ buffer: Buffer; filename: string; resized: boolean }> {
    const MAX_DIM = MetaService.META_MAX_IMAGE_DIMENSION;
    const MAX_BYTES = MetaService.META_MAX_IMAGE_BYTES;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      const metadata = await sharp(fileBuffer).metadata();
      const width = metadata.width || 0;
      const height = metadata.height || 0;
      const longestSide = Math.max(width, height);
      const tooLarge = longestSide > MAX_DIM;
      const tooHeavy = fileBuffer.length > MAX_BYTES;

      if (!tooLarge && !tooHeavy) {
        return { buffer: fileBuffer, filename, resized: false };
      }

      const resizeOpts = { width: MAX_DIM, height: MAX_DIM, fit: 'inside' as const, withoutEnlargement: true };
      const isPng = metadata.format === 'png';

      let out: Buffer;
      let outFilename = filename;
      if (isPng) {
        out = await sharp(fileBuffer).resize(resizeOpts).png({ compressionLevel: 9 }).toBuffer();
        // Transparency-preserving PNG is still too heavy — fall back to JPEG.
        if (out.length > MAX_BYTES) {
          out = await sharp(fileBuffer).resize(resizeOpts).jpeg({ quality: 85 }).toBuffer();
          outFilename = filename.replace(/\.[^/.]+$/, '') + '.jpg';
        }
      } else {
        let quality = 90;
        out = await sharp(fileBuffer).resize(resizeOpts).jpeg({ quality }).toBuffer();
        while (out.length > MAX_BYTES && quality > 40) {
          quality -= 15;
          out = await sharp(fileBuffer).resize(resizeOpts).jpeg({ quality }).toBuffer();
        }
        outFilename = filename.replace(/\.[^/.]+$/, '') + '.jpg';
      }

      this.log(`Resized image for Meta limits`, {
        from: { width, height, bytes: fileBuffer.length },
        to: { bytes: out.length, filename: outFilename },
      });
      return { buffer: out, filename: outFilename, resized: true };
    } catch (error: any) {
      console.error('[MetaService] resizeImageForMeta failed, uploading original buffer:', error?.message);
      return { buffer: fileBuffer, filename, resized: false };
    }
  }

  /**
   * Upload image to ad account
   */
  public async uploadImage(adAccountId: string, accessToken: string, filename: string, fileBuffer: Buffer) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      // Downscale oversized images up front — Meta rejects them with a generic error.
      const prepared = await this.resizeImageForMeta(fileBuffer, filename);
      const uploadFilename = prepared.filename;
      const uploadBuffer = prepared.buffer;
      this.log(`Uploading image to account: ${adAccountId}, filename: ${uploadFilename}`, {
        resized: prepared.resized,
        bytes: uploadBuffer.length,
      });
      const adImage = await account.createAdImage([], {
        filename: uploadFilename,
        bytes: uploadBuffer.toString('base64'),
      });
      // Meta's /adimages endpoint returns the result keyed by the uploaded filename,
      // e.g. { images: { "<filename>": { hash, url, ... } } }. The SDK stores this raw
      // payload on `_data`, so we must unwrap the (single) entry to expose a flat
      // { hash, url, ... } object. Returning the raw map forces every caller to dig the
      // hash out of a filename-keyed object, which is where distinct creatives end up
      // mapped to the wrong hash under batch uploads.
      const data = adImage._data || {};
      if (data.images && typeof data.images === 'object') {
        const keys = Object.keys(data.images);
        if (keys.length > 0) {
          const entry = data.images[keys[0]];
          this.log(`Image uploaded`, { filename: uploadFilename, hash: entry?.hash });
          return entry;
        }
      }
      // Fallback: response was already flat (e.g. { hash, url }).
      return data;
    } catch (error) {
      return this.handleError(error, 'uploadImage');
    }
  }

  /**
   * Upload video to ad account
   */
  public async uploadVideo(adAccountId: string, accessToken: string, videoUrl: string) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      this.log(`Uploading video to account: ${adAccountId}, url: ${videoUrl}`);
      // Using file_url for remote upload which is supported by Meta API
      const adVideo = await account.createAdVideo([], {
        file_url: videoUrl,
      });
      return adVideo._data;
    } catch (error) {
      return this.handleError(error, 'uploadVideo');
    }
  }

  /**
   * List Custom Audiences
   */
  public async listCustomAudiences(adAccountId: string, accessToken: string) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      const fields = [
        'id', 
        'name', 
        'description', 
        'delivery_status', 
        'subtype', 
        'customer_file_source'
      ];
      this.log(`Listing custom audiences for account: ${adAccountId}`, { fields });
      const audiences = await account.getCustomAudiences(fields, { limit: 50 });
      return audiences.map((a: any) => a._data);
    } catch (error) {
      return this.handleError(error, 'listCustomAudiences');
    }
  }

  /**
   * Create Custom Audience (Custom File or Lookalike)
   */
  public async createCustomAudience(adAccountId: string, accessToken: string, params: any) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      
      const audienceParams: any = {
        name: params.name,
        subtype: params.subtype, // CUSTOM, LOOKALIKE, WEBSITE
        description: params.description,
      };

      if (params.subtype === 'CUSTOM') {
          audienceParams.customer_file_source = params.customer_file_source || 'USER_PROVIDED_ONLY';
      } else if (params.subtype === 'LOOKALIKE') {
          audienceParams.lookalike_spec = params.lookalike_spec; 
          // { ratio: 0.01, origin: [{id: '...'}], country: 'US' }
      }

      this.log(`Creating custom audience in account: ${adAccountId}`, audienceParams);
      const audience = await account.createCustomAudience([], audienceParams);
      return audience._data;
    } catch (error) {
      return this.handleError(error, 'createCustomAudience');
    }
  }

  /**
   * Add users to a Custom Audience (from CSV/Hashed data)
   */
  public async uploadCustomAudienceUsers(adAccountId: string, accessToken: string, audienceId: string, schema: string[], payload: string | string[][]) {
    try {
      this.initApi(accessToken);
      const audience = new CustomAudience(audienceId);
      
      this.log(`Uploading users to custom audience: ${audienceId}`, { schema, payloadType: typeof payload });
      
      const params = {
        payload: {
          schema: schema,
          data: payload
        }
      };

      // For 'createUser' edge (POST /users), the first arg is 'fields' (usually empty), second is 'params'
      const result = await audience.createUser(
        [], 
        params
      );
      
      return result._data || result;
    } catch (error) {
       return this.handleError(error, 'uploadCustomAudienceUsers');
    }
  }

  // Geolocation search types must go through the top-level /search endpoint,
  // NOT the ad account 'targetingsearch' edge (which only resolves interests/
  // behaviors/demographics and silently returns interest-style results for
  // geo queries). See ENG-331.
  private static readonly GEO_SEARCH_TYPES = new Set([
    'adgeolocation',
    'adgeolocationmeta',
    'adcountry',
    'adregion',
    'adcity',
    'adzipcode',
  ]);

  /**
   * Search for Detailed Targeting options
   */
  public async searchTargeting(
    adAccountId: string,
    accessToken: string,
    q: string,
    type: string,
    locationTypes?: string[]
  ) {
    // Geolocation lookups (cities, regions, zips, countries) resolve via the
    // top-level /search endpoint, which returns entries with location keys/
    // region_ids usable in ad set geo_locations. The targetingsearch edge does
    // not support these types and returns interest results instead.
    if (MetaService.GEO_SEARCH_TYPES.has(type)) {
      return this.searchGeoLocations(accessToken, q, type, locationTypes);
    }

    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);

      const params: any = {
        q: q,
        type: type,
        class: type // behaviors and demographics often use 'class' parameter
      };

      if (type === 'adinterest') {
          delete params.class;
      }

      this.log(`Searching targeting options in account: ${adAccountId}`, params);

      // 'targetingsearch' edge returns a list of targeting options
      const results = await account.getTargetingSearch([], params);

      // Handle both Cursor and plain array responses
      const data = results.map((item: any) => item._data);
      return data;
    } catch (error) {
      return this.handleError(error, 'searchTargeting');
    }
  }

  /**
   * Search for geo-targeting locations (cities, regions, zips, countries) via the
   * top-level Graph API /search endpoint. Returns entries with a location `key`
   * and `region_id` that can be used directly in an ad set's `geo_locations`.
   */
  private async searchGeoLocations(accessToken: string, q: string, type: string, locationTypes?: string[]) {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      let url = `https://graph.facebook.com/${apiVersion}/search?type=${encodeURIComponent(type)}` +
        `&q=${encodeURIComponent(q)}&limit=25&access_token=${encodeURIComponent(accessToken)}`;
      if (locationTypes && locationTypes.length > 0) {
        url += `&location_types=${encodeURIComponent(JSON.stringify(locationTypes))}`;
      }

      this.log(`Searching geo locations (type=${type})`, { q, locationTypes });

      const { fetchWithRetry } = await import('../utils/metaApiFetch');
      const response = await fetchWithRetry(url);
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'Failed to search geo locations');
      }
      return data.data || [];
    } catch (error) {
      return this.handleError(error, 'searchGeoLocations');
    }
  }

  /**
   * Get insights/performance data
   */
  public async getInsights(adAccountId: string, accessToken: string, params: { timeframe: string, level?: string }) {
    try {
      this.initApi(accessToken);
      const account = new AdAccount(`act_${adAccountId}`);
      
      // Calculate date range based on timeframe using explicit YYYY-MM-DD
      const now = new Date();
      const format = (d: Date) => d.toISOString().split('T')[0];
      
      const daysMap: Record<string, number> = {
        '7d': 7, '14d': 14, '30d': 30, '90d': 90
      };
      const days = daysMap[params.timeframe] || 7;
      const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

      const dateRange = { 
        since: format(since), 
        until: format(now) 
      };

      const level = params.level || 'campaign';
      
      // Define fields based on level to avoid "Invalid field" errors from Meta
      const fields = [
        'impressions',
        'clicks',
        'spend',
        'reach',
        'frequency',
        'objective',
        'cpc',
        'ctr',
      ];

      if (level === 'campaign') {
        fields.push('campaign_id', 'campaign_name');
      } else if (level === 'adset') {
        fields.push('campaign_id', 'campaign_name', 'adset_id', 'adset_name');
      } else if (level === 'ad') {
        fields.push('campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name');
      }

      const searchParams = {
        level: level,
        time_range: dateRange,
      };

      this.log(`Fetching insights for account: ${adAccountId}`, searchParams);
      const insights = await account.getInsights(fields, searchParams);
      return insights.map((i: any) => i._data);
    } catch (error) {
      return this.handleError(error, 'getInsights');
    }
  }

  /**
   * List ad pixels associated with an ad account
   */
  public async listPixels(adAccountId: string, accessToken: string) {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const url = `https://graph.facebook.com/${apiVersion}/act_${adAccountId}/adspixels?fields=id,name,is_created_by_business&access_token=${accessToken}`;
      const { fetchWithRetry } = await import('../utils/metaApiFetch');
      const response = await fetchWithRetry(url);
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'Failed to list pixels');
      }
      return data.data || [];
    } catch (error) {
      return this.handleError(error, 'listPixels');
    }
  }

  /**
   * List datasets (server event data sources) linked to a pixel
   */
  public async listDatasets(pixelId: string, accessToken: string) {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const url = `https://graph.facebook.com/${apiVersion}/${pixelId}/datasets?fields=id,name&access_token=${accessToken}`;
      const { fetchWithRetry } = await import('../utils/metaApiFetch');
      const response = await fetchWithRetry(url);
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'Failed to list datasets');
      }
      return data.data || [];
    } catch (error) {
      return this.handleError(error, 'listDatasets');
    }
  }

  /**
   * Get event match quality (EMQ) scores for a dataset
   */
  public async getDatasetEventStats(datasetId: string, accessToken: string) {
    try {
      const apiVersion = process.env.META_API_VERSION || 'v25.0';
      const url = `https://graph.facebook.com/${apiVersion}/${datasetId}?fields=id,name,event_stats&access_token=${accessToken}`;
      const { fetchWithRetry } = await import('../utils/metaApiFetch');
      const response = await fetchWithRetry(url);
      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'Failed to get dataset event stats');
      }
      return data;
    } catch (error) {
      return this.handleError(error, 'getDatasetEventStats');
    }
  }
}

export const metaService = MetaService.getInstance();
