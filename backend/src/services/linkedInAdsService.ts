import axios from 'axios';
import { INTEGRATION_CONFIG } from '../config/integrations';
import { buildUtmSpec, mergeUtmIntoUrl } from '../utils/adUtm';

const LI_API_BASE = 'https://api.linkedin.com';
const LI_API_VERSION = INTEGRATION_CONFIG.linkedinAds.apiVersion; // e.g. '202603'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LinkedInAdsApiResult {
  success: boolean;
  data?: any;
  error?: string;
  status?: number;
}

// ─── UTM tagging (ENG-239) ─────────────────────────────────────────────────────

/**
 * Resolve the campaign id/URN to stamp into `utm_campaign`, or `undefined` when
 * no campaign is in scope at the call site.
 *
 * LinkedIn has no native tracking field and no click-time macros, so UTMs are
 * literally appended to each destination URL at create time. The campaign id is
 * required by the creative-creating endpoints (createCreative /
 * createCreativeInline / createDynamicCreative) but NOT by the standalone
 * content endpoints (createPost / createInMailContent /
 * createConversationAdContent), whose content is authored before it is wired to
 * a campaign. Those accept the campaign as an OPTIONAL param so Emma can thread
 * it through when known; when it is absent we leave the URL untagged rather than
 * invent a value or emit `utm_campaign=undefined`.
 *
 * A `urn:li:sponsoredCampaign:123` URN is reduced to its bare numeric id so the
 * emitted `utm_campaign` reads as `123` rather than a percent-encoded URN.
 */
function resolveCampaignForUtm(params: Record<string, any>): string | undefined {
  const raw = params?.campaign_id ?? params?.campaign ?? params?.campaignUrn;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const urnMatch = trimmed.match(/urn:li:sponsoredCampaign:(\d+)/);
  return urnMatch ? urnMatch[1] : trimmed;
}

/**
 * Append LinkedIn UTM params (`utm_source=linkedin`, `utm_medium=paid`,
 * `utm_campaign=<campaign>`) to a destination URL. `utm_content` is never emitted
 * — LinkedIn resolves no ad-id macro and the ad id does not exist at create time
 * (buildUtmSpec drops `content` for the linkedin platform). AC4 per-key merge is
 * handled by `mergeUtmIntoUrl`: a UTM key the user already set is preserved.
 *
 * Guards:
 *  - A missing/empty URL is returned as-is (never call mergeUtmIntoUrl on it).
 *  - No campaign in scope → returned untagged (never emit `utm_campaign=undefined`).
 *  - A malformed user URL (which mergeUtmIntoUrl throws on) is passed through
 *    UNTAGGED rather than throwing. Rationale: tagging is a best-effort overlay on
 *    an Emma-orchestrated multi-step ad build; a bad landing page is user content,
 *    and failing loud here would abort the whole ad creation (and the tagging of
 *    sibling URLs) with our error instead of letting LinkedIn's own endpoint
 *    surface a precise field-level validation error. Losing attribution on one
 *    malformed URL is strictly better than aborting the campaign.
 */
function appendLinkedInUtm(
  url: string | undefined,
  campaign: string | undefined,
): string | undefined {
  if (!url || typeof url !== 'string') return url;
  if (!campaign) return url;
  try {
    return mergeUtmIntoUrl(url, buildUtmSpec('linkedin', { campaign }));
  } catch {
    return url;
  }
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

    // LinkedIn rejects writes with this exact message when the ad account hasn't been
    // added to AgentWeb's Developer Portal app (one shared app for all customers, on
    // LinkedIn's Developer access tier). The raw message reads as if the customer has
    // their own app to fix — without this rewrite, the model tells the user to check
    // "their" LinkedIn Developer Portal, which doesn't exist for them and can't resolve it.
    if (/not configured to access the related advertiser account/i.test(message)) {
      // Body-only endpoints (conversationAds, posts, inMailContents, uploads) carry the
      // account as urn:li:sponsoredAccount:{id} in the body instead of an /adAccounts/{id}
      // path segment — support needs the ID either way to allowlist the account.
      const acctMatch = path.match(/\/adAccounts\/(\d+)/)
        || (body ? JSON.stringify(body).match(/urn:li:sponsoredAccount:(\d+)/) : null);
      const acctNote = acctMatch ? ` (${acctMatch[1]})` : '';
      return {
        success: false,
        error: `${fullError}\n\nThis is an AgentWeb platform configuration gap, not something the customer can fix. ` +
          `AgentWeb uses one shared LinkedIn Developer Portal app for all customers — the customer does not have their own app to configure. ` +
          `Do not tell the user to check "their" LinkedIn Developer Portal or Account Management settings. Instead, tell them this ad account${acctNote} ` +
          `needs to be allowlisted by AgentWeb staff and to contact AgentWeb support — retrying will not resolve it.`,
        status,
      };
    }

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

/**
 * Resolve a LinkedIn targetingCriteria object from the various param shapes Emma may pass.
 * This is the single source of truth shared by CAMPAIGN CREATE and TARGETING ESTIMATE_REACH:
 *   1. targeting_include / targeting_exclude — simple flat arrays (preferred, easiest for the model)
 *   2. targeting_criteria / targetingCriteria — a raw LinkedIn-format object (normalized)
 * Returns null when no targeting was supplied.
 */
export function resolveTargetingCriteria(params: Record<string, any>): any | null {
  if (params.targeting_include && Array.isArray(params.targeting_include)) {
    return buildTargetingCriteria(params.targeting_include, params.targeting_exclude);
  }
  const raw = params.targetingCriteria || params.targeting_criteria;
  if (raw) return normalizeTargetingCriteria(raw);
  return null;
}

/**
 * Serialize a targetingCriteria object into LinkedIn's RestLi 2.0 "reduced" query encoding,
 * e.g. (include:(and:List((or:(urn%3A...:List(urn%3A...))))),exclude:(or:(...))).
 * Structural tokens stay literal; URN keys and values are percent-encoded (per LinkedIn docs).
 */
function encodeTargetingCriteriaParam(tc: any): string {
  const encodeOrMap = (orMap: Record<string, string[]>): string => {
    const entries = Object.entries(orMap).map(([facetUrn, values]) => {
      const encodedValues = (values || []).map((v) => encodeURIComponent(v)).join(',');
      return `${encodeURIComponent(facetUrn)}:List(${encodedValues})`;
    });
    return `(or:(${entries.join(',')}))`;
  };

  const parts: string[] = [];
  const andClauses: any[] = tc?.include?.and || [];
  const includeGroups = andClauses
    .map((clause) => encodeOrMap(normalizeOrClause(clause.or)))
    .join(',');
  parts.push(`include:(and:List(${includeGroups}))`);

  if (tc?.exclude?.or) {
    const excludeEntries = Object.entries(normalizeOrClause(tc.exclude.or)).map(
      ([facetUrn, values]) =>
        `${encodeURIComponent(facetUrn)}:List(${((values as string[]) || []).map((v) => encodeURIComponent(v)).join(',')})`
    );
    parts.push(`exclude:(or:(${excludeEntries.join(',')}))`);
  }

  return `(${parts.join(',')})`;
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
  const targetingCriteria = resolveTargetingCriteria(params);
  if (targetingCriteria) body.targetingCriteria = targetingCriteria;

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
    // ENG-239: append UTMs to each card URL. campaign_id is optional here — a dark
    // post is authored before it is wired to a campaign; untagged when absent.
    const utmCampaign = resolveCampaignForUtm(params);
    body.content = {
      carousel: {
        cards: params.carousel_cards.map((card: any) => ({
          media: { id: card.image_urn, title: card.title || '' },
          landingPage: appendLinkedInUtm(card.landing_page, utmCampaign),
        })),
      },
    };
    // LinkedIn requires contentLandingPage for carousel posts — default to first card's landing page
    body.contentLandingPage = appendLinkedInUtm(
      params.content_landing_page || params.carousel_cards[0]?.landing_page,
      utmCampaign,
    );
  }

  return makeRequest('POST', '/rest/posts', accessToken, body);
}

// ─── Creative ─────────────────────────────────────────────────────────────────

/**
 * Build the Creative-level `leadgenCallToAction` object required for Lead Gen ads.
 * LinkedIn rejects a Lead Gen creative unless BOTH leadgenCallToAction.destination (the
 * Lead Gen Form's adForm URN) and leadgenCallToAction.label (e.g. SIGN_UP, DOWNLOAD) are
 * present. (The API input field is `leadgenCallToAction {destination,label}`; LinkedIn maps
 * it internally to the `Creative/callToAction/target`+`labelType` path seen in its errors.)
 * Accepts the adForm URN with or without the `urn:li:adForm:` prefix.
 *
 * Returns:
 *  - { leadgenCallToAction } when both a form URN and a label type are provided
 *  - { error } when only one of the two is provided (both are required together)
 *  - {} when neither is provided (a normal, non-lead-gen creative)
 */
function buildLeadGenCallToAction(
  params: Record<string, any>
): { leadgenCallToAction?: { destination: string; label: string }; error?: string } {
  const rawForm = params.leadgen_form_urn ?? params.lead_gen_form_urn ?? params.ad_form_urn;
  const rawLabel = params.cta_label_type ?? params.call_to_action_label_type;
  if (!rawForm && !rawLabel) return {};
  if (!rawForm) {
    return { error: 'Lead Gen creative requires leadgen_form_urn (the adForm URN) alongside cta_label_type.' };
  }
  if (!rawLabel) {
    return { error: 'Lead Gen creative requires cta_label_type (e.g. SIGN_UP, DOWNLOAD) alongside leadgen_form_urn.' };
  }
  const form = String(rawForm).trim();
  const destination = form.startsWith('urn:li:adForm:') ? form : `urn:li:adForm:${form}`;
  return { leadgenCallToAction: { destination, label: String(rawLabel).trim().toUpperCase() } };
}

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

// ─── UTM audit (ENG-239 AC3, read side) ───────────────────────────────────────

/**
 * Every key `appendLinkedInUtm` writes a destination URL to, across its eight call
 * sites. Read/write symmetry is the correctness bar for the audit: a shape we fail to
 * read is a healthy ad reported "untagged", and acting on that means republishing a
 * live creative.
 *
 *   landingPage               — carousel card (createPost, createCreativeInline),
 *                               text ad (createCreative), spotlight (createDynamicCreative),
 *                               conversation-ad button (createConversationAdContent)
 *   contentLandingPage        — carousel post (createPost, createCreativeInline)
 *   callToActionLandingPageUrl— InMail CTA (createInMailContent)
 *
 * The snake_case variants are the request-side param names (`card.landing_page`,
 * `content_landing_page`); LinkedIn echoes camelCase, but reading both costs nothing and
 * makes the read strictly a superset of the write.
 */
const LI_LANDING_PAGE_KEYS = new Set([
  'landingPage',
  'landing_page',
  'contentLandingPage',
  'content_landing_page',
  'callToActionLandingPageUrl',
  'call_to_action_landing_page_url',
]);

/**
 * Collect landing pages from anywhere in a creative.
 *
 * A key-based walk rather than a list of fixed paths, deliberately: LinkedIn nests the SAME
 * `landingPage` key differently for every ad format (content.carousel.cards[], content.textAd,
 * content.spotlight, content.sponsoredMessageContent.buttons[], subContent.regular…), and the
 * read-back shape does not always match the write shape. Keying on the field name makes the
 * read total over every format — including formats added later — instead of silently missing
 * whichever one a new writer starts using.
 */
function collectLandingPages(node: any, out: string[], depth = 0): void {
  if (!node || depth > 10) return;
  if (Array.isArray(node)) {
    for (const item of node) collectLandingPages(item, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (LI_LANDING_PAGE_KEYS.has(key)) {
      if (typeof value === 'string' && value.trim()) out.push(value.trim());
    } else {
      collectLandingPages(value, out, depth + 1);
    }
  }
}

/** The bare numeric id in a `urn:li:sponsoredCampaign:123` URN (or the value as-is). */
function bareCampaignId(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  const match = raw.match(/urn:li:sponsoredCampaign:(\d+)/);
  return match ? match[1] : raw;
}

/**
 * Read every creative's landing pages for the UTM audit (ENG-239 AC3). STRICTLY READ-ONLY.
 *
 * `appendField` is always `undefined` — LinkedIn has no native tracking/append field, so the
 * UTMs must be on the URL itself or they are not there at all. Inventing an append field here
 * would make untagged ads look tagged.
 *
 * Throws on an API failure rather than returning []. An empty list is indistinguishable from
 * "campaign has no ads", which the audit reports as vacuously tagged — a silent all-clear is
 * the one failure mode an audit must not have.
 *
 * KNOWN LIMIT: a sponsored-content creative that merely references a post
 * (`content.reference: urn:li:share:…`) carries no landing page of its own — the URL lives on
 * the post, which this endpoint does not expand. Such ads come back with `destinationUrls: []`
 * and the audit classes them `unreadable` (surfaced for a human), never `untagged`. That is the
 * safe direction: it can under-report, never manufacture a false positive to act on.
 */
export async function listAdsForUtmAudit(
  accessToken: string,
  adAccountId: string,
  campaignId?: string,
): Promise<Array<{
  adId: string;
  campaignId: string;
  campaignName: string;
  destinationUrls: string[];
  appendField?: string;
}>> {
  let campaigns: Array<{ id: string; name: string }>;

  if (campaignId) {
    campaigns = [{ id: bareCampaignId(campaignId), name: '' }];
  } else {
    const result = await listCampaigns(accessToken, adAccountId);
    if (!result.success) {
      throw new Error(`LinkedIn UTM audit: could not list campaigns — ${result.error}`);
    }
    campaigns = (result.data?.elements ?? []).map((c: any) => ({
      id: bareCampaignId(c.id),
      name: c.name ?? '',
    }));
  }

  const ads: Array<{
    adId: string;
    campaignId: string;
    campaignName: string;
    destinationUrls: string[];
    appendField?: string;
  }> = [];

  for (const campaign of campaigns) {
    const result = await listCreatives(accessToken, adAccountId, campaign.id);
    if (!result.success) {
      throw new Error(
        `LinkedIn UTM audit: could not list creatives for campaign ${campaign.id} — ${result.error}`,
      );
    }
    for (const creative of result.data?.elements ?? []) {
      const urls: string[] = [];
      collectLandingPages(creative, urls);
      ads.push({
        adId: String(creative.id ?? ''),
        campaignId: bareCampaignId(creative.campaign) || campaign.id,
        campaignName: campaign.name,
        destinationUrls: [...new Set(urls)],
        // LinkedIn has no native append field. Never fabricate one.
        appendField: undefined,
      });
    }
  }

  return ads;
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
    // ENG-239: campaign_id is required by this endpoint, so the URL is always tagged.
    body.content = {
      textAd: {
        headline: params.headline,
        description: params.description || '',
        landingPage: appendLinkedInUtm(params.landing_page, resolveCampaignForUtm(params)),
        ...(params.image_urn ? { image: params.image_urn } : {}),
      },
    };
  } else if (params.inmail_content_urn) {
    // Message ad / conversation ad creative
    body.content = { reference: params.inmail_content_urn };
  } else {
    return { success: false, error: 'CREATIVE CREATE requires either post_urn, vast_tag_url, headline (text ad), or inmail_content_urn' };
  }

  // Lead Gen creatives must carry a leadgenCallToAction linking an existing Lead Gen Form.
  const cta = buildLeadGenCallToAction(params);
  if (cta.error) return { success: false, error: cta.error };
  if (cta.leadgenCallToAction) body.leadgenCallToAction = cta.leadgenCallToAction;

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
    // ENG-239: campaign_id is required by this endpoint, so the URLs are always tagged.
    const utmCampaign = resolveCampaignForUtm(params);
    post.content = {
      carousel: {
        cards: params.carousel_cards.map((card: any) => ({
          media: { id: card.image_urn, title: card.title || '' },
          landingPage: appendLinkedInUtm(card.landing_page, utmCampaign),
        })),
      },
    };
    // LinkedIn requires contentLandingPage for carousel posts — default to first card's landing page
    post.contentLandingPage = appendLinkedInUtm(
      params.content_landing_page || params.carousel_cards[0]?.landing_page,
      utmCampaign,
    );
  }

  const campaignUrn = params.campaign_id.startsWith('urn:') ? params.campaign_id : `urn:li:sponsoredCampaign:${params.campaign_id}`;

  // Lead Gen creatives must carry a leadgenCallToAction linking an existing Lead Gen Form.
  const cta = buildLeadGenCallToAction(params);
  if (cta.error) return { success: false, error: cta.error };

  const body = {
    creative: {
      inlineContent: { post },
      campaign: campaignUrn,
      intendedStatus: params.status || 'ACTIVE',
      ...(cta.leadgenCallToAction ? { leadgenCallToAction: cta.leadgenCallToAction } : {}),
    },
  };

  return makeRequest('POST', `/rest/adAccounts/${adAccountId}/creatives?action=createInline`, accessToken, body);
}

/**
 * Retag ONE existing, already-live LinkedIn creative missing UTMs (Harsha's ask —
 * the audit tool can only find these, never fix them). Deliberately single-creative:
 * never loop or accept a list, so there is no "bulk retag" surface.
 *
 * LIVE-VERIFIED 2026-07-16 against a real LinkedIn ad account: creatives are
 * NOT immutable for this field, and the PARTIAL_UPDATE mechanism works — but
 * `$set` on `content.textAd` is NOT a deep merge. It replaces the whole
 * `textAd` object, so an update carrying only `landingPage` fails validation
 * ("field is required but not found and has no default value" on
 * headline/description). The fix — confirmed live — is to echo every existing
 * `textAd` field back in the patch, not just the one being changed.
 *
 * `textAd` creatives carry a destination URL directly on the creative. The far
 * more common `content.reference` creative type points at an existing LinkedIn
 * POST instead — that case is delegated to `retagPostUtm`, which can only
 * retag the post's `contentLandingPage` (CTA-button destination); an article
 * post's own link or a post with no CTA configured have no retaggable
 * destination and are reported as such, not silently skipped.
 */
export async function retagCreativeUtm(
  accessToken: string,
  adAccountId: string,
  creativeId: string,
  campaign: string,
): Promise<LinkedInAdsApiResult & { alreadyTagged?: boolean }> {
  const creativeUrn = creativeId.startsWith('urn:') ? creativeId : `urn:li:sponsoredCreative:${creativeId}`;
  const encoded = encodeURIComponent(creativeUrn);

  const getResult = await makeRequest('GET', `/rest/adAccounts/${adAccountId}/creatives/${encoded}`, accessToken);
  if (!getResult.success) return getResult;

  const content = (getResult.data as any)?.content;
  if (content?.reference) {
    return retagPostUtm(accessToken, content.reference, campaign);
  }
  if (!content?.textAd) {
    return {
      success: false,
      error: 'UNSUPPORTED_CREATIVE_TYPE — could not determine a retaggable destination for this creative type.',
    };
  }

  const currentUrl: string | undefined = content.textAd.landingPage;
  const campaignForUtm = resolveCampaignForUtm({ campaign_id: campaign });
  const newUrl = appendLinkedInUtm(currentUrl, campaignForUtm);
  if (newUrl === currentUrl) {
    return { success: true, alreadyTagged: true };
  }

  // LIVE-VERIFIED 2026-07-16: LinkedIn's $set on content.textAd is NOT a deep
  // merge -- it replaces the whole textAd object. Sending only landingPage
  // fails with "field is required but not found and has no default value" on
  // headline/description. Every existing field must be echoed back verbatim.
  return makeRequest(
    'POST',
    `/rest/adAccounts/${adAccountId}/creatives/${encoded}`,
    accessToken,
    { patch: { $set: { content: { textAd: { ...content.textAd, landingPage: newUrl } } } } },
    { 'X-RestLi-Method': 'PARTIAL_UPDATE' },
  );
}

/**
 * Read a LinkedIn post/share by URN. Closes a real gap: CREATIVE LIST only
 * returns the bare `content.reference` URN pointer for sponsored-content
 * creatives, never the post's own fields — and POST previously had no read
 * action at all, so a referenced post's destination could never be inspected
 * directly (only inferred indirectly, e.g. via retag idempotency behavior).
 */
export async function getPost(accessToken: string, postUrn: string): Promise<LinkedInAdsApiResult> {
  const encoded = encodeURIComponent(postUrn);
  return makeRequest('GET', `/rest/posts/${encoded}`, accessToken);
}

/**
 * Retag the LinkedIn POST a `content.reference` creative points to (Harsha's
 * ask, sponsored-content slice — `retagCreativeUtm`'s text-ad path only covers
 * creatives that carry a destination directly).
 *
 * `contentLandingPage` (the post's CTA-button destination) is the ONLY post
 * field LinkedIn's own Posts API docs list as updatable via PARTIAL_UPDATE
 * (learn.microsoft.com/linkedin/marketing/.../posts-api — alongside
 * `commentary`, `contentCallToActionLabel`, `lifecycleState`, `adContext`).
 * It's a TOP-LEVEL field, unlike `content.textAd` — so the deep-merge trap
 * that broke the creative retag (LinkedIn replacing the whole nested object)
 * does not apply here; no sibling fields need to be echoed back.
 *
 * What this does NOT cover: an article post's own link
 * (`content.article.source` — not in the updatable-fields list, so presumed
 * locked after publish) or a post with no CTA button configured at all (no
 * `contentLandingPage` to merge into). Both are reported as
 * NO_RETAGGABLE_DESTINATION rather than silently skipped or guessed at — same
 * "needs a human" principle the audit tool already applies to unreadable ads.
 */
export async function retagPostUtm(
  accessToken: string,
  postUrn: string,
  campaign: string,
): Promise<LinkedInAdsApiResult & { alreadyTagged?: boolean }> {
  const encoded = encodeURIComponent(postUrn);
  const getResult = await getPost(accessToken, postUrn);
  if (!getResult.success) return getResult;

  const currentUrl: string | undefined = (getResult.data as any)?.contentLandingPage;
  if (!currentUrl) {
    return {
      success: false,
      error: 'NO_RETAGGABLE_DESTINATION — this post has no landing-page/CTA destination set '
        + '(e.g. an article post\'s own link, or a post with no call-to-action button). '
        + 'LinkedIn does not expose those for edit after publish; a human needs to look.',
    };
  }

  const campaignForUtm = resolveCampaignForUtm({ campaign_id: campaign });
  const newUrl = appendLinkedInUtm(currentUrl, campaignForUtm);
  if (newUrl === currentUrl) {
    return { success: true, alreadyTagged: true };
  }

  return makeRequest(
    'POST',
    `/rest/posts/${encoded}`,
    accessToken,
    { patch: { $set: { contentLandingPage: newUrl } } },
    { 'X-RestLi-Method': 'PARTIAL_UPDATE' },
  );
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
  // The current REST audienceCounts endpoint uses the targetingCriteriaV2 finder: a single
  // RestLi-2.0-encoded `targetingCriteria` query param. The legacy dotted
  // `target.includedTargetingFacets.X[i]=` form is rejected with "Parameter 'target' is required".
  const andClauses = targetingCriteria?.include?.and || [];
  if (!Array.isArray(andClauses) || andClauses.length === 0) {
    return { success: false, error: 'ESTIMATE_REACH requires at least one include targeting facet' };
  }

  const encodedCriteria = encodeTargetingCriteriaParam(targetingCriteria);
  return makeRequest(
    'GET',
    `/rest/audienceCounts?q=targetingCriteriaV2&targetingCriteria=${encodedCriteria}`,
    accessToken
  );
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
    // ENG-239: optional campaign id/URN so the CTA landing page can be UTM-tagged.
    // InMail content is authored before it is wired to a campaign; when absent the
    // URL is left untagged rather than emitting utm_campaign=undefined.
    campaign_id?: string;
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
        // ENG-239: tag the CTA landing page when a campaign is in scope.
        callToActionLandingPageUrl: appendLinkedInUtm(
          params.callToActionLandingPageUrl,
          resolveCampaignForUtm(params),
        ),
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
    // ENG-239: campaign_id is required by this endpoint, so the URL is always tagged.
    body.content = {
      spotlight: {
        headline: params.headline,
        callToAction: params.call_to_action || params.callToAction,
        landingPage: appendLinkedInUtm(
          params.landing_page || params.landingPage,
          resolveCampaignForUtm(params),
        ),
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

  const body: Record<string, any> = {
    parentAccount: `urn:li:sponsoredAccount:${adAccountId}`,
  };
  // LinkedIn's SponsoredConversation schema has no "name" field — only the optional
  // headlineText. Sending "name" is rejected with "unrecognized field found but not
  // allowed". When absent, LinkedIn falls back to the first message content as the headline.
  const headlineText = params.headline_text || params.headlineText || params.name;
  if (headlineText) body.headlineText = headlineText;

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

  // ENG-239: append UTMs to each OPEN_URL button. campaign_id is optional here —
  // conversation content is authored before it is wired to a campaign; when absent
  // the URL is left untagged rather than emitting utm_campaign=undefined.
  const utmCampaign = resolveCampaignForUtm(params);
  const encodedUrn = encodeURIComponent(conversationAdUrn);
  const body: Record<string, any> = {
    body: params.body,
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.footer ? { footer: params.footer } : {}),
    buttons: params.buttons.map((btn: any) => ({
      text: btn.text,
      action: btn.action || 'OPEN_URL',
      ...(btn.url ? { landingPage: appendLinkedInUtm(btn.url, utmCampaign) } : {}),
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
