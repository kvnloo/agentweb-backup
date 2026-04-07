import axios from 'axios';
import { INTEGRATION_CONFIG } from '../config/integrations';

const LI_API_BASE = 'https://api.linkedin.com';
const LI_API_VERSION = INTEGRATION_CONFIG.linkedinAds.apiVersion; // e.g. '202603'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LinkedInAdsApiResult {
  success: boolean;
  data?: any;
  error?: string;
  status?: number;
}

// ─── Core HTTP client ─────────────────────────────────────────────────────────

/**
 * Make an authenticated request to the LinkedIn Ads REST API.
 * All ads endpoints are under /rest/ and require the LinkedIn-Version header.
 */
async function makeRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  accessToken: string,
  body?: any,
  extraHeaders?: Record<string, string>
): Promise<LinkedInAdsApiResult> {
  const url = `${LI_API_BASE}${path}`;
  const config: any = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': LI_API_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    data: body,
  };

  try {
    const response = await axios(config);
    // LinkedIn POST endpoints return the created resource URN in x-restli-id header (body is empty)
    const resourceId = response.headers?.['x-restli-id'];
    const data = response.data && Object.keys(response.data).length > 0
      ? response.data
      : resourceId ? { id: resourceId } : response.data;
    return { success: true, data, status: response.status };
  } catch (err: any) {
    const status = err.response?.status;
    const errData = err.response?.data;
    const message = errData?.message || errData?.serviceErrorCode || err.message;
    const details = errData?.errorDetails;

    // errorDetails.inputErrors: validation errors with input.inputPath.fieldPath
    const inputErrors: any[] = details?.inputErrors ?? (Array.isArray(details) ? details : []);
    // errorDetails.conditionalInputErrors: cross-field conflicts (e.g. carousel vs video type)
    const conditionalErrors: any[] = details?.conditionalInputErrors ?? [];

    const formatError = (d: any): string => {
      const fieldPath = d.input?.inputPath?.fieldPath ?? d.inputPath?.fieldPath ?? d.inputPath ?? '';
      const desc = d.description ?? d.message ?? JSON.stringify(d);
      return fieldPath ? `  - ${fieldPath}: ${desc}` : `  - ${desc}`;
    };

    const allErrors = [
      ...inputErrors.map(formatError),
      ...conditionalErrors.map(formatError),
    ];
    const fullError = allErrors.length > 0 ? `${message}\n${allErrors.join('\n')}` : message;
    console.error(`LinkedIn Ads API error [${method} ${path}]:`, status, fullError, errData ? JSON.stringify(errData) : '');
    return { success: false, error: fullError, status };
  }
}

// ─── Token management ─────────────────────────────────────────────────────────

/**
 * Refresh a LinkedIn access token using the stored refresh token.
 * Returns new access_token, refresh_token, and expires_in (seconds).
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const response = await axios.post(
    INTEGRATION_CONFIG.linkedinAds.tokenUrl,
    null,
    {
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );

  const { access_token, refresh_token, expires_in } = response.data as { access_token: string; refresh_token: string; expires_in: number };
  if (!access_token) throw new Error('LinkedIn Ads token refresh returned no access_token');
  return { access_token, refresh_token, expires_in };
}

// ─── Pagination helper ────────────────────────────────────────────────────────

/**
 * Fetch all pages from a LinkedIn cursor-based paginated endpoint (v202401+).
 *
 * Used for q=search endpoints (pageSize up to 1000) and q=criteria endpoints
 * (pageSize up to 100). Loops until metadata.nextPageToken is absent.
 *
 * @param baseUrl     - Full path + existing query string (no pageSize/pageToken)
 * @param accessToken - Bearer token
 * @param pageSize    - Items per page: 1000 for q=search, 100 for q=criteria
 * @param extraHeaders - Optional extra request headers (e.g. X-RestLi-Method)
 */
async function fetchAllPages(
  baseUrl: string,
  accessToken: string,
  pageSize: number,
  extraHeaders?: Record<string, string>
): Promise<LinkedInAdsApiResult> {
  const allElements: any[] = [];
  let pageToken: string | undefined;

  do {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const url = `${baseUrl}${sep}pageSize=${pageSize}${tokenParam}`;

    const result = await makeRequest('GET', url, accessToken, undefined, extraHeaders);
    if (!result.success) return result;

    allElements.push(...(result.data?.elements ?? []));
    pageToken = result.data?.metadata?.nextPageToken ?? undefined;
  } while (pageToken);

  return { success: true, data: { elements: allElements } };
}

// ─── Ad Account ───────────────────────────────────────────────────────────────

export async function listAdAccounts(accessToken: string): Promise<LinkedInAdsApiResult> {
  return fetchAllPages(
    '/rest/adAccounts?q=search&search=(type:(values:List(BUSINESS,ENTERPRISE)))',
    accessToken,
    1000
  );
}

// ─── Campaign Group ───────────────────────────────────────────────────────────

export async function listCampaignGroups(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any> = {}
): Promise<LinkedInAdsApiResult> {
  const statusFilter = params.status
    ? `(status:(values:List(${params.status})))`
    : `(status:(values:List(ACTIVE,PAUSED,DRAFT,ARCHIVED)))`;
  return fetchAllPages(
    `/rest/adAccounts/${adAccountId}/adCampaignGroups?q=search&search=${statusFilter}`,
    accessToken,
    1000
  );
}

export async function createCampaignGroup(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  // LinkedIn does not allow creating a campaign group with PAUSED status — must be ACTIVE or DRAFT.
  // Map PAUSED → DRAFT so the caller can then UPDATE to PAUSED after creation.
  const status = params.status === 'PAUSED' ? 'DRAFT' : (params.status || 'ACTIVE');

  const body: Record<string, any> = {
    account: `urn:li:sponsoredAccount:${adAccountId}`,
    name: params.name,
    status,
  };

  // totalBudget: accept nested object or flat params
  const totalBudget = params.totalBudget || (params.total_budget_amount ? { amount: params.total_budget_amount, currencyCode: params.total_budget_currency || 'USD' } : undefined);
  if (totalBudget) body.totalBudget = { amount: String(totalBudget.amount), currencyCode: totalBudget.currencyCode || 'USD' };

  // runSchedule.start is required by LinkedIn API
  const scheduleStart = params.runSchedule?.start || params.run_schedule_start;
  if (!scheduleStart) throw new Error('run_schedule_start is required for campaign group creation (epoch ms). Ask the user when the campaign group should start.');
  body.runSchedule = { start: scheduleStart };
  const scheduleEnd = params.runSchedule?.end || params.run_schedule_end;
  if (scheduleEnd) body.runSchedule.end = scheduleEnd;

  const objectiveType = params.objectiveType || params.objective_type;
  if (objectiveType) body.objectiveType = objectiveType;

  return makeRequest('POST', `/rest/adAccounts/${adAccountId}/adCampaignGroups`, accessToken, body);
}


export async function updateCampaignGroup(
  accessToken: string,
  adAccountId: string,
  campaignGroupId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  const setFields: Record<string, any> = {};
  if (params.status !== undefined) setFields.status = params.status;
  if (params.name !== undefined) setFields.name = params.name;
  if (params.total_budget_amount !== undefined) {
    setFields.totalBudget = {
      amount: String(params.total_budget_amount),
      currencyCode: params.total_budget_currency || 'USD',
    };
  }
  if (params.run_schedule_end !== undefined) {
    setFields.runSchedule = { end: params.run_schedule_end };
  }

  return makeRequest(
    'POST',
    `/rest/adAccounts/${adAccountId}/adCampaignGroups/${campaignGroupId}`,
    accessToken,
    { patch: { $set: setFields } },
    { 'X-RestLi-Method': 'PARTIAL_UPDATE' }
  );
}

// ─── Campaign ─────────────────────────────────────────────────────────────────

export async function listCampaigns(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any> = {}
): Promise<LinkedInAdsApiResult> {
  // LinkedIn REST API does not support combining campaignGroup + status in a single search expression.
  // When filtering by campaign group, use it as the sole search filter.
  // When filtering by status only, use the status filter.
  let path: string;
  if (params.campaign_group_id) {
    const rawId = String(params.campaign_group_id);
    const groupUrn = rawId.startsWith('urn:li:') ? rawId : `urn:li:sponsoredCampaignGroup:${rawId}`;
    path = `/rest/adAccounts/${adAccountId}/adCampaigns?q=search&search=(campaignGroup:(values:List(${encodeURIComponent(groupUrn)})))`;
  } else {
    const statuses = params.status || 'ACTIVE,PAUSED,DRAFT,ARCHIVED';
    path = `/rest/adAccounts/${adAccountId}/adCampaigns?q=search&search=(status:(values:List(${statuses})))`;
  }
  return fetchAllPages(path, accessToken, 1000);
}

/**
 * Build LinkedIn targetingCriteria from a simple flat array format that is easy for the
 * model to generate without needing URN strings as JSON keys.
 *
 * Input (simple flat format Emma passes):
 *   targeting_include: [
 *     { facet_urn: "urn:li:adTargetingFacet:locations", values: ["urn:li:geo:103644278"] },
 *     { facet_urn: "urn:li:adTargetingFacet:titles",    values: ["urn:li:title:100"] }
 *   ]
 *   targeting_exclude: [
 *     { facet_urn: "urn:li:adTargetingFacet:seniorities", values: ["urn:li:seniority:1"] }
 *   ]
 *
 * Output (LinkedIn API format):
 *   { "include": { "and": [ { "or": { "urn:...": ["urn:..."] } } ] },
 *     "exclude": { "or": { "urn:...": ["urn:..."] } } }
 */
function buildTargetingCriteria(
  include: Array<{ facet_urn: string; values: string[] }>,
  exclude?: Array<{ facet_urn: string; values: string[] }>
): any {
  const tc: any = {
    include: {
      and: include.map(({ facet_urn, values }) => ({
        or: { [facet_urn]: values },
      })),
    },
  };
  if (exclude && exclude.length > 0) {
    const excludeMap: Record<string, string[]> = {};
    for (const { facet_urn, values } of exclude) {
      excludeMap[facet_urn] = values;
    }
    tc.exclude = { or: excludeMap };
  }
  return tc;
}

/**
 * Normalize a raw targetingCriteria object (may have or-clauses as arrays instead of maps).
 */
function normalizeOrClause(or: any): Record<string, any> {
  if (Array.isArray(or)) {
    return Object.assign({}, ...or);
  }
  return or;
}

function normalizeTargetingCriteria(tc: any): any {
  if (!tc) return tc;
  const result: any = {};
  if (tc.include) {
    result.include = {};
    if (Array.isArray(tc.include.and)) {
      result.include.and = tc.include.and.map((clause: any) =>
        clause.or ? { or: normalizeOrClause(clause.or) } : clause
      );
    } else {
      result.include = tc.include;
    }
  }
  if (tc.exclude) {
    result.exclude = tc.exclude.or
      ? { or: normalizeOrClause(tc.exclude.or) }
      : tc.exclude;
  }
  return result;
}

export async function createCampaign(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  // Accept both camelCase (schema-style) and snake_case (legacy) param formats
  const costType = params.costType || params.cost_type || 'CPC';
  const unitCostAmount = params.unitCost?.amount || params.unit_cost_amount || '2.00';
  const unitCostCurrency = params.unitCost?.currencyCode || params.unit_cost_currency || 'USD';

  const campaignType = params.type || 'SPONSORED_UPDATES';

  // LinkedIn requires format when type=DYNAMIC (e.g. SPOTLIGHT, JOBS, FOLLOW_COMPANY)
  if (campaignType === 'DYNAMIC' && !params.format) {
    return { success: false, error: 'format is required when campaign type is DYNAMIC. Use SPOTLIGHT, JOBS, or FOLLOW_COMPANY.' };
  }

  const body: Record<string, any> = {
    account: `urn:li:sponsoredAccount:${adAccountId}`,
    name: params.name,
    status: params.status || 'DRAFT',
    type: campaignType,
    costType,
    unitCost: {
      amount: String(unitCostAmount),
      currencyCode: unitCostCurrency,
    },
    locale: {
      country: params.locale_country || 'US',
      language: params.locale_language || 'en',
    },
    offsiteDeliveryEnabled: params.offsite_delivery_enabled ?? false,
    audienceExpansionEnabled: params.audience_expansion_enabled ?? false,
    creativeSelection: params.creative_selection || (campaignType === 'SPONSORED_INMAILS' ? 'ROUND_ROBIN' : 'OPTIMIZED'),
  };

  // campaignGroup: accept full URN or numeric ID
  const campaignGroupUrn = params.campaignGroup?.startsWith('urn:') ? params.campaignGroup
    : (params.campaign_group_id ? `urn:li:sponsoredCampaignGroup:${params.campaign_group_id}` : undefined);
  if (campaignGroupUrn) body.campaignGroup = campaignGroupUrn;

  const objectiveType = params.objectiveType || params.objective_type;
  if (objectiveType) body.objectiveType = objectiveType;
  if (params.format) body.format = params.format;

  // dailyBudget: accept nested object or flat params
  const dailyBudget = params.dailyBudget || (params.daily_budget_amount ? { amount: params.daily_budget_amount, currencyCode: params.daily_budget_currency || 'USD' } : undefined);
  if (dailyBudget) body.dailyBudget = { amount: String(dailyBudget.amount), currencyCode: dailyBudget.currencyCode || 'USD' };

  // totalBudget: accept nested object or flat params
  const totalBudget = params.totalBudget || (params.total_budget_amount ? { amount: params.total_budget_amount, currencyCode: params.total_budget_currency || 'USD' } : undefined);
  if (totalBudget) body.totalBudget = { amount: String(totalBudget.amount), currencyCode: totalBudget.currencyCode || 'USD' };

  // runSchedule: required by LinkedIn — default to now if not provided
  const scheduleStart = params.runSchedule?.start || params.run_schedule_start || Date.now();
  body.runSchedule = { start: scheduleStart };
  const scheduleEnd = params.runSchedule?.end || params.run_schedule_end;
  if (scheduleEnd) body.runSchedule.end = scheduleEnd;

  // targetingCriteria: prefer simple flat format (targeting_include/targeting_exclude arrays),
  // fall back to raw object (targetingCriteria / targeting_criteria) with normalization
  if (params.targeting_include && Array.isArray(params.targeting_include)) {
    body.targetingCriteria = buildTargetingCriteria(params.targeting_include, params.targeting_exclude);
  } else {
    const targetingCriteria = params.targetingCriteria || params.targeting_criteria;
    if (targetingCriteria) body.targetingCriteria = normalizeTargetingCriteria(targetingCriteria);
  }

  // politicalIntent: required in LinkedIn API v202603+
  body.politicalIntent = params.politicalIntent || 'NOT_POLITICAL';

  return makeRequest('POST', `/rest/adAccounts/${adAccountId}/adCampaigns`, accessToken, body);
}

export async function updateCampaign(
  accessToken: string,
  adAccountId: string,
  campaignId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  const setFields: Record<string, any> = {};
  if (params.status !== undefined) setFields.status = params.status;
  if (params.name !== undefined) setFields.name = params.name;
  if (params.daily_budget_amount !== undefined) {
    setFields.dailyBudget = {
      amount: String(params.daily_budget_amount),
      currencyCode: params.daily_budget_currency || 'USD',
    };
  }
  if (params.total_budget_amount !== undefined) {
    setFields.totalBudget = {
      amount: String(params.total_budget_amount),
      currencyCode: params.total_budget_currency || 'USD',
    };
  }
  if (params.targeting_criteria !== undefined) setFields.targetingCriteria = params.targeting_criteria;
  if (params.unit_cost_amount !== undefined) {
    setFields.unitCost = {
      amount: String(params.unit_cost_amount),
      currencyCode: params.unit_cost_currency || 'USD',
    };
  }

  return makeRequest(
    'POST',
    `/rest/adAccounts/${adAccountId}/adCampaigns/${campaignId}`,
    accessToken,
    { patch: { $set: setFields } },
    { 'X-RestLi-Method': 'PARTIAL_UPDATE' }
  );
}

// ─── Post (sponsored dark post) ───────────────────────────────────────────────

/**
 * Create a sponsored post (dark post) via the Posts API.
 * feedDistribution=NONE means it won't appear in the organic company feed.
 * lifecycleState=PUBLISHED (not DRAFT) so it can be served as an ad.
 */
export async function createPost(
  accessToken: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  // feed_distribution=NONE → dark post (ad only, never on company page)
  // feed_distribution=MAIN_FEED → post appears on company page AND runs as sponsored ad
  const feedDistribution = params.feed_distribution || 'NONE';
  const isDarkPost = feedDistribution === 'NONE';

  const body: Record<string, any> = {
    author: params.author_urn,
    commentary: params.text || params.commentary || '',
    visibility: params.visibility || 'PUBLIC',
    distribution: {
      feedDistribution,
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: true,
  };

  // adContext is only for dark posts (DSC). LinkedIn rejects adContext on MAIN_FEED posts.
  // MAIN_FEED posts are organic — they get sponsored by referencing the post URN in a creative.
  if (isDarkPost && params.ad_account_id) {
    body.adContext = {
      dscAdAccount: `urn:li:sponsoredAccount:${params.ad_account_id}`,
      dscStatus: 'ACTIVE',
    };
  }

  if (params.image_urn) {
    body.content = {
      media: {
        id: params.image_urn,
        title: params.title || '',
      },
    };
  } else if (params.video_urn) {
    body.content = {
      media: {
        id: params.video_urn,
        title: params.title || '',
      },
    };
  } else if (params.document_urn) {
    // Document Ads: reference the uploaded document URN
    body.content = {
      media: {
        id: params.document_urn,
        title: params.title || '',
      },
    };
  } else if (params.article_url) {
    // Article Ads: link to an external article
    body.content = {
      article: {
        source: params.article_url,
        title: params.article_title || '',
        description: params.article_description || '',
        ...(params.thumbnail_urn ? { thumbnail: params.thumbnail_urn } : {}),
      },
    };
  } else if (params.carousel_cards && Array.isArray(params.carousel_cards)) {
    body.content = {
      carousel: {
        cards: params.carousel_cards.map((card: any) => ({
          media: { id: card.image_urn, title: card.title || '' },
          landingPage: card.landing_page,
        })),
      },
    };
    // LinkedIn requires contentLandingPage for carousel posts — default to first card's landing page
    body.contentLandingPage = params.content_landing_page || params.carousel_cards[0]?.landing_page;
  }

  return makeRequest('POST', '/rest/posts', accessToken, body);
}

// ─── Creative ─────────────────────────────────────────────────────────────────

export async function listCreatives(
  accessToken: string,
  adAccountId: string,
  campaignId: string
): Promise<LinkedInAdsApiResult> {
  const rawId = campaignId.startsWith('urn:li:sponsoredCampaign:') ? campaignId : `urn:li:sponsoredCampaign:${campaignId}`;
  const campaignUrn = encodeURIComponent(rawId);
  // q=criteria uses cursor-based pagination with max pageSize=100 (v202603 docs)
  return fetchAllPages(
    `/rest/adAccounts/${adAccountId}/creatives?q=criteria&campaigns=List(${campaignUrn})`,
    accessToken,
    100,
    { 'X-RestLi-Method': 'FINDER' }
  );
}

export async function createCreative(
  accessToken: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  // Carousel must use createCreativeInline — referencing a carousel post URN causes a LinkedIn type conflict
  if (params.carousel_cards) {
    return { success: false, error: 'Carousel ads must use CREATIVE/CREATE_INLINE, not CREATIVE/CREATE. Use createCreativeInline instead.' };
  }

  if (!params.campaign_id) return { success: false, error: 'CREATIVE CREATE requires campaign_id' };

  let body: Record<string, any> = {
    campaign: params.campaign_id.startsWith('urn:') ? params.campaign_id : `urn:li:sponsoredCampaign:${params.campaign_id}`,
    intendedStatus: params.status || 'ACTIVE',
  };

  if (params.vast_tag_url) {
    // VAST Tag Video Ad — third-party video served via VAST tag URL (e.g. Innovid)
    body.content = {
      thirdPartyVastTagVideoAd: {
        vastTagUrl: params.vast_tag_url,
      },
    };
  } else if (params.reference || params.post_urn) {
    // Sponsored content creative (image, video, article, document, event post URN)
    body.content = { reference: params.reference || params.post_urn };
    // Event Ads: optional pre-event registration image
    if (params.pre_event_registration_image) {
      body.content.preEventRegistrationImage = params.pre_event_registration_image;
    }
  } else if (params.headline) {
    // Text ad creative (no post needed)
    body.content = {
      textAd: {
        headline: params.headline,
        description: params.description || '',
        landingPage: params.landing_page,
        ...(params.image_urn ? { image: params.image_urn } : {}),
      },
    };
  } else if (params.inmail_content_urn) {
    // Message ad / conversation ad creative
    body.content = { reference: params.inmail_content_urn };
  } else {
    return { success: false, error: 'CREATIVE CREATE requires either post_urn, vast_tag_url, headline (text ad), or inmail_content_urn' };
  }

  const adAccountId = params.ad_account_id;
  if (!adAccountId) return { success: false, error: 'CREATIVE CREATE requires ad_account_id' };
  return makeRequest('POST', `/rest/adAccounts/${adAccountId}/creatives`, accessToken, body);
}

/**
 * Create a creative and its post in a single API call using the createInline action.
 * This is the recommended approach — avoids the separate POST/CREATE + CREATIVE/CREATE steps
 * and ensures the post URN is correctly wired as the creative reference.
 */
export async function createCreativeInline(
  accessToken: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  const adAccountId = params.ad_account_id;
  if (!adAccountId) return { success: false, error: 'CREATIVE CREATE_INLINE requires ad_account_id' };
  if (!params.campaign_id) return { success: false, error: 'CREATIVE CREATE_INLINE requires campaign_id' };
  if (!params.author_urn) return { success: false, error: 'CREATIVE CREATE_INLINE requires author_urn (organization URN)' };

  const post: Record<string, any> = {
    adContext: {
      dscAdAccount: `urn:li:sponsoredAccount:${adAccountId}`,
      dscStatus: 'ACTIVE',
    },
    author: params.author_urn,
    commentary: params.commentary || params.text || '',
    visibility: params.visibility || 'PUBLIC',
    distribution: {
      feedDistribution: 'NONE',
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: true,
  };

  if (params.image_urn) {
    post.content = { media: { id: params.image_urn, title: params.title || '' } };
  } else if (params.video_urn) {
    post.content = { media: { id: params.video_urn, title: params.title || '' } };
  } else if (params.carousel_cards && Array.isArray(params.carousel_cards)) {
    post.content = {
      carousel: {
        cards: params.carousel_cards.map((card: any) => ({
          media: { id: card.image_urn, title: card.title || '' },
          landingPage: card.landing_page,
        })),
      },
    };
    // LinkedIn requires contentLandingPage for carousel posts — default to first card's landing page
    post.contentLandingPage = params.content_landing_page || params.carousel_cards[0]?.landing_page;
  }

  const campaignUrn = params.campaign_id.startsWith('urn:') ? params.campaign_id : `urn:li:sponsoredCampaign:${params.campaign_id}`;

  const body = {
    creative: {
      inlineContent: { post },
      campaign: campaignUrn,
      intendedStatus: params.status || 'ACTIVE',
    },
  };

  return makeRequest('POST', `/rest/adAccounts/${adAccountId}/creatives?action=createInline`, accessToken, body);
}

// ─── Image upload ─────────────────────────────────────────────────────────────

/**
 * Step 1: Initialize image upload. Returns uploadUrl and image URN.
 */
export async function initializeImageUpload(
  accessToken: string,
  ownerUrn: string
): Promise<LinkedInAdsApiResult> {
  return makeRequest('POST', '/rest/images?action=initializeUpload', accessToken, {
    initializeUploadRequest: { owner: ownerUrn },
  });
}

/**
 * Step 2: PUT binary image data to the signed uploadUrl.
 * The uploadUrl is returned by initializeImageUpload.
 * No Authorization header is needed for the PUT.
 */
export async function uploadImageBinary(uploadUrl: string, imageBuffer: Buffer, contentType = 'image/jpeg'): Promise<void> {
  await axios.put(uploadUrl, imageBuffer, {
    headers: { 'Content-Type': contentType },
  });
}

// ─── Video upload ─────────────────────────────────────────────────────────────

/**
 * Step 1: Initialize video upload.
 */
export async function initializeVideoUpload(
  accessToken: string,
  ownerUrn: string,
  fileSizeBytes: number
): Promise<LinkedInAdsApiResult> {
  return makeRequest('POST', '/rest/videos?action=initializeUpload', accessToken, {
    initializeUploadRequest: {
      owner: ownerUrn,
      fileSizeBytes,
      uploadCaptions: false,
      uploadThumbnail: false,
    },
  });
}

/**
 * Step 3: Finalize video upload after all parts are uploaded.
 * uploadToken is returned by initializeVideoUpload (may be empty string).
 * uploadedPartIds are the ETag values returned by each uploadVideoPart call.
 */
export async function finalizeVideoUpload(
  accessToken: string,
  videoUrn: string,
  uploadToken: string = '',
  uploadedPartIds: string[] = []
): Promise<LinkedInAdsApiResult> {
  return makeRequest('POST', '/rest/videos?action=finalizeUpload', accessToken, {
    finalizeUploadRequest: {
      video: videoUrn,
      uploadToken,
      uploadedPartIds,
    },
  });
}

// ─── Targeting ────────────────────────────────────────────────────────────────

export async function listTargetingFacets(accessToken: string): Promise<LinkedInAdsApiResult> {
  return makeRequest('GET', '/rest/adTargetingFacets', accessToken);
}

export async function searchTargetingEntities(
  accessToken: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  if (!params.facet_urn) {
    return { success: false, error: 'TARGETING SEARCH requires facet_urn' };
  }

  // Normalize common facet URN aliases
  const FACET_ALIASES: Record<string, string> = {
    'urn:li:adTargetingFacet:jobTitles': 'urn:li:adTargetingFacet:titles',
  };
  const facetUrn = FACET_ALIASES[params.facet_urn] || params.facet_urn;
  const encodedFacet = encodeURIComponent(facetUrn);
  let path: string;

  // These facets have predefined values and do not support q=typeahead
  const TYPEAHEAD_UNSUPPORTED_FACETS = [
    'urn:li:adTargetingFacet:staffCountRanges',
    'urn:li:adTargetingFacet:seniorities',
    'urn:li:adTargetingFacet:industries',
    'urn:li:adTargetingFacet:functions',
  ];

  const supportsTypeahead = !TYPEAHEAD_UNSUPPORTED_FACETS.includes(params.facet_urn);

  if (params.query && supportsTypeahead) {
    // Typeahead search within a facet
    path = `/rest/adTargetingEntities?q=typeahead&facet=${encodedFacet}&query=${encodeURIComponent(params.query)}&queryVersion=QUERY_USES_URNS`;
  } else {
    // List all entities for a facet (also used for facets that don't support typeahead)
    path = `/rest/adTargetingEntities?q=adTargetingFacet&facet=${encodedFacet}&queryVersion=QUERY_USES_URNS`;
  }

  if (params.locale_language) {
    path += `&locale=(language:${params.locale_language},country:${params.locale_country || 'US'})`;
  }

  return makeRequest('GET', path, accessToken);
}

export async function getAudienceCount(
  accessToken: string,
  targetingCriteria: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  // Build query params from targeting criteria
  const facets = targetingCriteria?.include?.and || [];
  let queryParts = ['q=targetingCriteria'];
  let idx = 0;
  for (const group of facets) {
    const orFacets = group?.or || {};
    for (const [facetUrn, values] of Object.entries(orFacets)) {
      const encodedFacet = encodeURIComponent(facetUrn);
      (values as string[]).forEach((val: string, i: number) => {
        queryParts.push(`target.includedTargetingFacets.${encodedFacet}[${idx + i}]=${encodeURIComponent(val)}`);
      });
      idx += (values as string[]).length;
    }
  }
  return makeRequest('GET', `/rest/audienceCounts?${queryParts.join('&')}`, accessToken);
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * Fetch ad analytics. LinkedIn analytics is synchronous (no polling needed).
 *
 * @param sponsorAccountId - LinkedIn Ads numeric account ID (required facet for all requests)
 * @param pivot - CAMPAIGN_GROUP | CAMPAIGN | CREATIVE | MEMBER_JOB_TITLE | etc.
 * @param timeGranularity - DAILY | MONTHLY | YEARLY | ALL
 * @param dateRange - { start: { year, month, day }, end: { year, month, day } }
 * @param fields - array of metric names (impressions, clicks, costInLocalCurrency, etc.)
 * @param filters - optional { campaign_group_ids?, campaign_ids?, creative_ids? }
 */
export async function getAdAnalytics(
  accessToken: string,
  sponsorAccountId: string,
  pivot: string,
  timeGranularity: string,
  dateRange: { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } },
  fields: string[],
  filters: { campaign_group_ids?: string[]; campaign_ids?: string[]; creative_ids?: string[] } = {}
): Promise<LinkedInAdsApiResult> {
  // LinkedIn RestLI requires dateRange as an encoded object, not flat dot-notation keys.
  // fields must not be URL-encoded (commas must stay literal).
  const { start, end } = dateRange;
  const dateRangeParam = `dateRange=(start:(year:${start.year},month:${start.month},day:${start.day}),end:(year:${end.year},month:${end.month},day:${end.day}))`;
  const fieldsParam = `fields=${fields.join(',')}`;

  // LinkedIn requires at least one facet filter. accounts= is always included.
  const accountUrn = sponsorAccountId.startsWith('urn:li:') ? sponsorAccountId : `urn:li:sponsoredAccount:${sponsorAccountId}`;
  const parts: string[] = [
    `q=analytics`,
    `pivot=${encodeURIComponent(pivot)}`,
    `timeGranularity=${encodeURIComponent(timeGranularity)}`,
    dateRangeParam,
    `accounts=List(${encodeURIComponent(accountUrn)})`,
    fieldsParam,
  ];

  // RestLI array syntax: param=List(urn%3Ali%3A...,urn%3Ali%3A...)
  // Per LinkedIn docs, URNs inside List() must be URL-encoded.
  // Guard against callers passing full URNs vs bare numeric IDs.
  const toUrn = (prefix: string, id: string) =>
    id.startsWith('urn:li:') ? id : `${prefix}:${id}`;
  const encodeUrns = (prefix: string, ids: string[]) =>
    ids.map(id => encodeURIComponent(toUrn(prefix, id))).join(',');

  if (filters.campaign_group_ids?.length) {
    // Docs: filter by campaign group uses "campaignGroups" param, not "pivotValues"
    parts.push(`campaignGroups=List(${encodeUrns('urn:li:sponsoredCampaignGroup', filters.campaign_group_ids)})`);
  }
  if (filters.campaign_ids?.length) {
    parts.push(`campaigns=List(${encodeUrns('urn:li:sponsoredCampaign', filters.campaign_ids)})`);
  }
  if (filters.creative_ids?.length) {
    parts.push(`creatives=List(${encodeUrns('urn:li:sponsoredCreative', filters.creative_ids)})`);
  }

  return makeRequest('GET', `/rest/adAnalytics?${parts.join('&')}`, accessToken);
}

// ─── InMail (Message Ad) ──────────────────────────────────────────────────────

/**
 * Create InMail content for a Message Ad.
 * POST /rest/inMailContents
 *
 * @param sender  - Person URN (urn:li:person:ID) or organization URN acting as sender
 * @param subject - InMail subject line
 * @param htmlBody - InMail body (HTML allowed)
 * @param callToActionText - CTA button text (max 20 chars)
 * @param callToActionLandingPageUrl - URL the CTA button links to
 */
export async function createInMailContent(
  accessToken: string,
  params: {
    ad_account_id: string;
    name: string;
    sender: string;
    subject: string;
    htmlBody: string;
    callToActionText: string;
    callToActionLandingPageUrl: string;
    salutationText?: string;
    senderName?: string;
    senderTitle?: string;
    senderCompany?: string;
  }
): Promise<LinkedInAdsApiResult> {
  if (!params.ad_account_id) return { success: false, error: 'createInMailContent requires ad_account_id' };
  if (!params.sender) return { success: false, error: 'createInMailContent requires sender (person URN: urn:li:person:ID)' };
  if (!params.subject) return { success: false, error: 'createInMailContent requires subject' };
  if (!params.htmlBody) return { success: false, error: 'createInMailContent requires htmlBody' };
  if (!params.callToActionText) return { success: false, error: 'createInMailContent requires callToActionText (max 20 chars)' };
  if (!params.callToActionLandingPageUrl) return { success: false, error: 'createInMailContent requires callToActionLandingPageUrl' };

  const body: Record<string, any> = {
    account: `urn:li:sponsoredAccount:${params.ad_account_id}`,
    name: params.name,
    sender: params.sender,
    subject: params.subject,
    htmlBody: params.htmlBody,
    subContent: {
      regular: {
        callToActionText: params.callToActionText,
        callToActionLandingPageUrl: params.callToActionLandingPageUrl,
      },
    },
  };

  if (params.salutationText) body.salutationText = params.salutationText;
  if (params.senderName) body.senderName = params.senderName;
  if (params.senderTitle) body.senderTitle = params.senderTitle;
  if (params.senderCompany) body.senderCompany = params.senderCompany;

  return makeRequest('POST', '/rest/inMailContents', accessToken, body);
}

/**
 * Send a test InMail to verify the message ad content before launching.
 * POST /rest/inMailContents/{inMailContentUrn}?action=sendTestInMail
 */
export async function sendTestInMail(
  accessToken: string,
  inMailContentUrn: string,
  recipientEmail: string
): Promise<LinkedInAdsApiResult> {
  const encodedUrn = encodeURIComponent(inMailContentUrn);
  return makeRequest('POST', `/rest/inMailContents/${encodedUrn}?action=sendTestInMail`, accessToken, {
    recipient: recipientEmail,
  });
}

// ─── Video upload (multipart) ─────────────────────────────────────────────────

/**
 * Step 2: PUT one video part to the signed uploadUrl.
 * LinkedIn returns per-part upload URLs from initializeVideoUpload.
 * No Authorization header needed for PUT.
 * Returns the ETag from the response header — required for finalizeVideoUpload.
 */
export async function uploadVideoPart(uploadUrl: string, buffer: Buffer): Promise<string> {
  const response = await axios.put(uploadUrl, buffer, {
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  // LinkedIn returns the part ID as an ETag header — must be passed to finalizeUpload
  return response.headers?.['etag'] || response.headers?.['ETag'] || '';
}

// ─── Document upload ──────────────────────────────────────────────────────────

/**
 * Step 1: Initialize document upload.
 * POST /rest/documents?action=initializeUpload
 * Returns uploadUrl and document URN.
 */
export async function initializeDocumentUpload(
  accessToken: string,
  ownerUrn: string
): Promise<LinkedInAdsApiResult> {
  return makeRequest('POST', '/rest/documents?action=initializeUpload', accessToken, {
    initializeUploadRequest: { owner: ownerUrn },
  });
}

/**
 * Step 2: PUT binary document data to the signed uploadUrl.
 * No Authorization header needed for the PUT.
 */
export async function uploadDocumentBinary(uploadUrl: string, buffer: Buffer, contentType = 'application/pdf'): Promise<void> {
  await axios.put(uploadUrl, buffer, {
    headers: { 'Content-Type': contentType },
  });
}

// ─── Dynamic Ads (Jobs / Spotlight / Follower) ────────────────────────────────

/**
 * Create a Dynamic Ad creative (Jobs, Spotlight, or Follower).
 * Campaign must have type=DYNAMIC and matching format.
 *
 * format=JOBS:          content.jobs   → { headline, buttonLabel } (preApproved template or custom text)
 * format=SPOTLIGHT:     content.spotlight → { headline, callToAction, landingPage, description?, backgroundImage?, logo? }
 * format=FOLLOW_COMPANY: content.follow → { headline, description?, callToAction? } (pre-approved templates only)
 */
export async function createDynamicCreative(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  if (!adAccountId) return { success: false, error: 'createDynamicCreative requires ad_account_id' };
  if (!params.campaign_id) return { success: false, error: 'createDynamicCreative requires campaign_id' };
  if (!params.format) return { success: false, error: 'createDynamicCreative requires format (JOBS|SPOTLIGHT|FOLLOW_COMPANY)' };

  const campaignUrn = params.campaign_id.startsWith('urn:') ? params.campaign_id : `urn:li:sponsoredCampaign:${params.campaign_id}`;

  const body: Record<string, any> = {
    campaign: campaignUrn,
    intendedStatus: params.status || 'ACTIVE',
  };

  const fmt = params.format.toUpperCase();
  if (fmt === 'JOBS') {
    body.content = {
      jobs: {
        headline: params.headline,
        buttonLabel: params.button_label || params.buttonLabel,
      },
    };
  } else if (fmt === 'SPOTLIGHT') {
    // LinkedIn requires logo if the company page doesn't have a profile logo.
    // Use MEDIA/UPLOAD_IMAGE to upload a logo image first and pass the resulting image URN as logo_urn.
    if (!params.logo_urn) {
      return {
        success: false,
        error: 'SPOTLIGHT dynamic ads require logo_urn. Upload a logo first using MEDIA/UPLOAD_IMAGE and pass the returned image_urn as logo_urn.',
      };
    }
    body.content = {
      spotlight: {
        headline: params.headline,
        callToAction: params.call_to_action || params.callToAction,
        landingPage: params.landing_page || params.landingPage,
        logo: params.logo_urn,
        ...(params.description ? { description: params.description } : {}),
        ...(params.background_image_urn ? { backgroundImage: params.background_image_urn } : {}),
      },
    };
  } else if (fmt === 'FOLLOW_COMPANY') {
    body.content = {
      follow: {
        headline: params.headline,
        ...(params.description ? { description: params.description } : {}),
        ...(params.call_to_action || params.callToAction ? { callToAction: params.call_to_action || params.callToAction } : {}),
      },
    };
  } else {
    return { success: false, error: `Unknown dynamic ad format "${params.format}". Use JOBS, SPOTLIGHT, or FOLLOW_COMPANY.` };
  }

  return makeRequest('POST', `/rest/adAccounts/${adAccountId}/creatives`, accessToken, body);
}

// ─── Conversation Ads ──────────────────────────────────────────────────────────

/**
 * Create a Conversation Ad container.
 * POST /rest/conversationAds
 * After creation, add message nodes via createConversationAdContent,
 * then set the first node via setConversationAdFirstContent.
 */
export async function createConversationAd(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  if (!adAccountId) return { success: false, error: 'createConversationAd requires ad_account_id' };
  if (!params.name) return { success: false, error: 'createConversationAd requires name' };

  const body: Record<string, any> = {
    parentAccount: `urn:li:sponsoredAccount:${adAccountId}`,
    name: params.name,
  };

  return makeRequest('POST', '/rest/conversationAds', accessToken, body);
}

/**
 * Add a message node to a Conversation Ad.
 * POST /rest/conversationAds/{conversationAdUrn}/sponsoredMessageContents
 *
 * Each node has a body text and up to 5 CTA buttons.
 * buttons format: [{ text, action: 'OPEN_URL'|'SEND_MESSAGE', url? }]
 */
export async function createConversationAdContent(
  accessToken: string,
  conversationAdUrn: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  if (!conversationAdUrn) return { success: false, error: 'createConversationAdContent requires conversation_ad_urn' };
  if (!params.body) return { success: false, error: 'createConversationAdContent requires body (message text)' };
  if (!params.buttons || !Array.isArray(params.buttons) || params.buttons.length === 0) {
    return { success: false, error: 'createConversationAdContent requires buttons array (1–5 buttons)' };
  }

  const encodedUrn = encodeURIComponent(conversationAdUrn);
  const body: Record<string, any> = {
    body: params.body,
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.footer ? { footer: params.footer } : {}),
    buttons: params.buttons.map((btn: any) => ({
      text: btn.text,
      action: btn.action || 'OPEN_URL',
      ...(btn.url ? { landingPage: btn.url } : {}),
    })),
  };

  return makeRequest('POST', `/rest/conversationAds/${encodedUrn}/sponsoredMessageContents`, accessToken, body);
}

/**
 * Set the first message node in a Conversation Ad (required before launching).
 * PATCH /rest/conversationAds/{conversationAdUrn}
 */
export async function setConversationAdFirstContent(
  accessToken: string,
  conversationAdUrn: string,
  firstContentUrn: string
): Promise<LinkedInAdsApiResult> {
  const encodedUrn = encodeURIComponent(conversationAdUrn);
  return makeRequest(
    'POST',
    `/rest/conversationAds/${encodedUrn}`,
    accessToken,
    { patch: { $set: { firstContent: firstContentUrn } } },
    { 'X-RestLi-Method': 'PARTIAL_UPDATE' }
  );
}
