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
    return { success: true, data: response.data, status: response.status };
  } catch (err: any) {
    const status = err.response?.status;
    const message = err.response?.data?.message || err.response?.data?.serviceErrorCode || err.message;
    console.error(`LinkedIn Ads API error [${method} ${path}]:`, status, message);
    return { success: false, error: message, status };
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

// ─── Ad Account ───────────────────────────────────────────────────────────────

export async function listAdAccounts(accessToken: string): Promise<LinkedInAdsApiResult> {
  return makeRequest('GET', '/rest/adAccounts?q=search&search=(type:(values:List(BUSINESS,ENTERPRISE)))', accessToken);
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
  return makeRequest(
    'GET',
    `/rest/adAccounts/${adAccountId}/adCampaignGroups?q=search&search=${statusFilter}`,
    accessToken
  );
}

export async function createCampaignGroup(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  const body: Record<string, any> = {
    account: `urn:li:sponsoredAccount:${adAccountId}`,
    name: params.name,
    status: params.status || 'ACTIVE',
  };

  if (params.total_budget_amount) {
    body.totalBudget = {
      amount: String(params.total_budget_amount),
      currencyCode: params.total_budget_currency || 'USD',
    };
  }

  if (params.run_schedule_start) {
    body.runSchedule = { start: params.run_schedule_start };
    if (params.run_schedule_end) body.runSchedule.end = params.run_schedule_end;
  }

  if (params.objective_type) body.objectiveType = params.objective_type;

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
  let search = `(status:(values:List(${params.status || 'ACTIVE,PAUSED,DRAFT,ARCHIVED'})))`;
  if (params.campaign_group_id) {
    search = `(campaignGroup:(values:List(urn:li:sponsoredCampaignGroup:${params.campaign_group_id})),${search.slice(1)}`;
  }
  return makeRequest(
    'GET',
    `/rest/adAccounts/${adAccountId}/adCampaigns?q=search&search=${search}`,
    accessToken
  );
}

export async function createCampaign(
  accessToken: string,
  adAccountId: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  const body: Record<string, any> = {
    account: `urn:li:sponsoredAccount:${adAccountId}`,
    name: params.name,
    status: params.status || 'DRAFT',
    type: params.type || 'SPONSORED_UPDATES',
    costType: params.cost_type || 'CPC',
    unitCost: {
      amount: String(params.unit_cost_amount || '2.00'),
      currencyCode: params.unit_cost_currency || 'USD',
    },
    locale: {
      country: params.locale_country || 'US',
      language: params.locale_language || 'en',
    },
    offsiteDeliveryEnabled: params.offsite_delivery_enabled ?? false,
    audienceExpansionEnabled: params.audience_expansion_enabled ?? false,
    creativeSelection: params.creative_selection || 'OPTIMIZED',
  };

  if (params.campaign_group_id) {
    body.campaignGroup = `urn:li:sponsoredCampaignGroup:${params.campaign_group_id}`;
  }

  if (params.objective_type) body.objectiveType = params.objective_type;
  if (params.format) body.format = params.format;

  if (params.daily_budget_amount) {
    body.dailyBudget = {
      amount: String(params.daily_budget_amount),
      currencyCode: params.daily_budget_currency || 'USD',
    };
  }
  if (params.total_budget_amount) {
    body.totalBudget = {
      amount: String(params.total_budget_amount),
      currencyCode: params.total_budget_currency || 'USD',
    };
  }

  if (params.run_schedule_start) {
    body.runSchedule = { start: params.run_schedule_start };
    if (params.run_schedule_end) body.runSchedule.end = params.run_schedule_end;
  }

  if (params.targeting_criteria) body.targetingCriteria = params.targeting_criteria;

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
  const body: Record<string, any> = {
    author: params.author_urn,
    commentary: params.text || '',
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'NONE',
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: true,
    adContext: {
      dscAdAccount: `urn:li:sponsoredAccount:${params.ad_account_id}`,
      dscStatus: 'ACTIVE',
    },
  };

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
  } else if (params.carousel_cards && Array.isArray(params.carousel_cards)) {
    body.content = {
      carousel: {
        cards: params.carousel_cards.map((card: any) => ({
          media: { id: card.image_urn, title: card.title || '' },
          landingPage: card.landing_page,
        })),
      },
    };
    if (params.content_landing_page) {
      body.contentLandingPage = params.content_landing_page;
    }
  }

  return makeRequest('POST', '/rest/posts', accessToken, body);
}

// ─── Creative ─────────────────────────────────────────────────────────────────

export async function listCreatives(
  accessToken: string,
  campaignId: string
): Promise<LinkedInAdsApiResult> {
  return makeRequest(
    'GET',
    `/rest/creatives?q=criteria&criteria.campaign=urn:li:sponsoredCampaign:${campaignId}`,
    accessToken
  );
}

export async function createCreative(
  accessToken: string,
  params: Record<string, any>
): Promise<LinkedInAdsApiResult> {
  let body: Record<string, any> = {
    campaign: `urn:li:sponsoredCampaign:${params.campaign_id}`,
    intendedStatus: params.status || 'ACTIVE',
  };

  if (params.post_urn) {
    // Sponsored content creative (image, video, carousel)
    body.content = { reference: params.post_urn };
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
    return { success: false, error: 'CREATIVE CREATE requires either post_urn, headline (text ad), or inmail_content_urn' };
  }

  return makeRequest('POST', '/rest/creatives', accessToken, body);
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
 */
export async function finalizeVideoUpload(
  accessToken: string,
  videoUrn: string
): Promise<LinkedInAdsApiResult> {
  const encodedUrn = encodeURIComponent(videoUrn);
  return makeRequest('POST', `/rest/videos/${encodedUrn}?action=finalizeUpload`, accessToken, {});
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

  const encodedFacet = encodeURIComponent(params.facet_urn);
  let path: string;

  if (params.query) {
    // Typeahead search within a facet
    path = `/rest/adTargetingEntities?q=typeahead&facet=${encodedFacet}&query=${encodeURIComponent(params.query)}&queryVersion=QUERY_USES_URNS`;
  } else {
    // List all entities for a facet
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
 * @param pivot - CAMPAIGN_GROUP | CAMPAIGN | CREATIVE | MEMBER_JOB_TITLE | etc.
 * @param timeGranularity - DAILY | MONTHLY | YEARLY | ALL
 * @param dateRange - { start: { year, month, day }, end: { year, month, day } }
 * @param fields - array of metric names (impressions, clicks, costInLocalCurrency, etc.)
 * @param filters - optional { campaign_group_ids?, campaign_ids?, creative_ids? }
 */
export async function getAdAnalytics(
  accessToken: string,
  pivot: string,
  timeGranularity: string,
  dateRange: { start: { year: number; month: number; day: number }; end: { year: number; month: number; day: number } },
  fields: string[],
  filters: { campaign_group_ids?: string[]; campaign_ids?: string[]; creative_ids?: string[] } = {}
): Promise<LinkedInAdsApiResult> {
  const params = new URLSearchParams({
    q: 'analytics',
    pivot,
    timeGranularity,
    'dateRange.start.year': String(dateRange.start.year),
    'dateRange.start.month': String(dateRange.start.month),
    'dateRange.start.day': String(dateRange.start.day),
    'dateRange.end.year': String(dateRange.end.year),
    'dateRange.end.month': String(dateRange.end.month),
    'dateRange.end.day': String(dateRange.end.day),
    fields: fields.join(','),
  });

  if (filters.campaign_group_ids) {
    filters.campaign_group_ids.forEach((id, i) => {
      params.append(`pivotValues[${i}]`, `urn:li:sponsoredCampaignGroup:${id}`);
    });
  }
  if (filters.campaign_ids) {
    filters.campaign_ids.forEach((id, i) => {
      params.append(`campaigns[${i}]`, `urn:li:sponsoredCampaign:${id}`);
    });
  }
  if (filters.creative_ids) {
    filters.creative_ids.forEach((id, i) => {
      params.append(`creatives[${i}]`, `urn:li:sponsoredCreative:${id}`);
    });
  }

  return makeRequest('GET', `/rest/adAnalytics?${params.toString()}`, accessToken);
}
