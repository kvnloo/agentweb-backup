export type NegativeCampaignCriteriaValidationCode =
  | 'MISSING_IDENTIFIERS'
  | 'INVALID_CUSTOMER_ID'
  | 'INVALID_CAMPAIGN_RESOURCE_NAME'
  | 'CAMPAIGN_CUSTOMER_MISMATCH'
  | 'INVALID_CRITERIA_COLLECTION'
  | 'MISSING_CRITERIA'
  | 'INVALID_PLACEMENT_URL'
  | 'UNSUPPORTED_PLACEMENT_CRITERION_TYPE'
  | 'INVALID_MOBILE_APP_CATEGORY_RESOURCE_NAME';

export class NegativeCampaignCriteriaValidationError extends Error {
  readonly errorType = 'VALIDATION_ERROR';

  constructor(
    readonly errorCode: NegativeCampaignCriteriaValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'NegativeCampaignCriteriaValidationError';
  }
}

export interface NormalizedNegativeCampaignCriteria {
  placementUrls: string[];
  mobileAppCategoryResourceNames: string[];
}

export function validateNegativeCampaignCriteria(
  customerId: unknown,
  campaignResourceName: unknown,
  placementUrlsInput: unknown,
  mobileAppCategoryResourceNamesInput: unknown,
): NormalizedNegativeCampaignCriteria {
  if (!customerId || !campaignResourceName) {
    throw new NegativeCampaignCriteriaValidationError(
      'MISSING_IDENTIFIERS',
      'customer_id and campaign_resource_name are required for CAMPAIGN_CRITERION ADD',
    );
  }
  if (typeof customerId !== 'string' || !/^\d+$/.test(customerId)) {
    throw new NegativeCampaignCriteriaValidationError(
      'INVALID_CUSTOMER_ID',
      'customer_id must be numeric with no dashes for CAMPAIGN_CRITERION ADD',
    );
  }

  const campaignMatch = typeof campaignResourceName === 'string'
    ? /^customers\/(\d+)\/campaigns\/\d+$/.exec(campaignResourceName)
    : null;
  if (!campaignMatch) {
    throw new NegativeCampaignCriteriaValidationError(
      'INVALID_CAMPAIGN_RESOURCE_NAME',
      'campaign_resource_name must use customers/<customer_id>/campaigns/<campaign_id> form',
    );
  }
  if (campaignMatch[1] !== customerId) {
    throw new NegativeCampaignCriteriaValidationError(
      'CAMPAIGN_CUSTOMER_MISMATCH',
      'campaign_resource_name must belong to customer_id',
    );
  }

  if (placementUrlsInput !== undefined && !Array.isArray(placementUrlsInput)) {
    throw new NegativeCampaignCriteriaValidationError(
      'INVALID_CRITERIA_COLLECTION',
      'placement_urls must be an array',
    );
  }
  if (
    mobileAppCategoryResourceNamesInput !== undefined
    && !Array.isArray(mobileAppCategoryResourceNamesInput)
  ) {
    throw new NegativeCampaignCriteriaValidationError(
      'INVALID_CRITERIA_COLLECTION',
      'mobile_app_category_resource_names must be an array',
    );
  }

  const placementUrls = [
    ...new Set((placementUrlsInput ?? []).map((value: unknown) => {
      if (typeof value !== 'string') {
        throw new NegativeCampaignCriteriaValidationError(
          'INVALID_PLACEMENT_URL',
          'Invalid placement URL: every placement must be a string',
        );
      }
      return value.trim();
    })),
  ];
  const mobileAppCategoryResourceNames = [
    ...new Set((mobileAppCategoryResourceNamesInput ?? []).map((value: unknown) => {
      if (typeof value !== 'string') {
        throw new NegativeCampaignCriteriaValidationError(
          'INVALID_MOBILE_APP_CATEGORY_RESOURCE_NAME',
          'Invalid mobile app category resource name: every category must be a string',
        );
      }
      return value.trim();
    })),
  ];

  if (placementUrls.length === 0 && mobileAppCategoryResourceNames.length === 0) {
    throw new NegativeCampaignCriteriaValidationError(
      'MISSING_CRITERIA',
      'At least one placement URL or mobile app category resource name is required',
    );
  }

  for (const placementUrl of placementUrls) {
    if (!placementUrl || /\s/.test(placementUrl)) {
      throw new NegativeCampaignCriteriaValidationError(
        'INVALID_PLACEMENT_URL',
        `Invalid placement URL: ${placementUrl || '(empty)'}`,
      );
    }

    const placementWithoutProtocol = placementUrl.replace(/^https?:\/\//i, '');
    if (placementWithoutProtocol.length > 250) {
      throw new NegativeCampaignCriteriaValidationError(
        'INVALID_PLACEMENT_URL',
        `Invalid placement URL: ${placementUrl} exceeds the 250-character Google Ads limit`,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(
        /^[a-z][a-z\d+.-]*:\/\//i.test(placementUrl)
          ? placementUrl
          : `https://${placementUrl}`,
      );
    } catch {
      throw new NegativeCampaignCriteriaValidationError(
        'INVALID_PLACEMENT_URL',
        `Invalid placement URL: ${placementUrl}`,
      );
    }

    const hostname = parsed.hostname.toLowerCase();
    const hostnameLabels = hostname.split('.');
    const pathDepth = parsed.pathname.split('/').filter(Boolean).length;
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || hostnameLabels.length < 2
      || hostnameLabels.some((label) => !label)
      || parsed.port
      || parsed.username
      || parsed.password
      || pathDepth > 2
    ) {
      throw new NegativeCampaignCriteriaValidationError(
        'INVALID_PLACEMENT_URL',
        `Invalid placement URL: ${placementUrl}`,
      );
    }

    const isHostOrSubdomain = (domain: string) => (
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (
      isHostOrSubdomain('youtube.com')
      || isHostOrSubdomain('youtu.be')
      || isHostOrSubdomain('youtube-nocookie.com')
    ) {
      throw new NegativeCampaignCriteriaValidationError(
        'UNSUPPORTED_PLACEMENT_CRITERION_TYPE',
        `YouTube placement ${placementUrl} requires a dedicated YouTube video or channel criterion`,
      );
    }
    if (isHostOrSubdomain('adsenseformobileapps.com')) {
      throw new NegativeCampaignCriteriaValidationError(
        'UNSUPPORTED_PLACEMENT_CRITERION_TYPE',
        'adsenseformobileapps.com is not an allowed Google Ads placement',
      );
    }
  }

  for (const resourceName of mobileAppCategoryResourceNames) {
    if (!/^mobileAppCategoryConstants\/\d+$/.test(resourceName)) {
      throw new NegativeCampaignCriteriaValidationError(
        'INVALID_MOBILE_APP_CATEGORY_RESOURCE_NAME',
        `Invalid mobile app category resource name: ${resourceName || '(empty)'}`,
      );
    }
  }

  return { placementUrls, mobileAppCategoryResourceNames };
}
