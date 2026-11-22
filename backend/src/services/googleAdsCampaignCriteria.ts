export type NegativeCampaignCriteriaValidationCode =
  | 'MISSING_IDENTIFIERS'
  | 'INVALID_CUSTOMER_ID'
  | 'INVALID_CAMPAIGN_RESOURCE_NAME'
  | 'CAMPAIGN_CUSTOMER_MISMATCH'
  | 'INVALID_CRITERIA_COLLECTION'
  | 'MISSING_CRITERIA'
  | 'INVALID_PLACEMENT_URL'
  | 'UNSUPPORTED_PLACEMENT_CRITERION_TYPE'
  | 'INVALID_MOBILE_APP_CATEGORY_RESOURCE_NAME'
  | 'INVALID_AD_GROUP_RESOURCE_NAME'
  | 'INVALID_DEVICE'
  | 'INVALID_BID_MODIFIER';

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

// ENG-2036: device bid adjustments. Google auto-creates one DEVICE campaign criterion per
// device type with these fixed criterion IDs, so campaign scope is an UPDATE of
// customers/<c>/campaignCriteria/<campaignId>~<criterionId>; ad-group scope uses
// adGroupBidModifiers.
export const DEVICE_CRITERION_IDS = {
  DESKTOP: '30000',
  MOBILE: '30001',
  TABLET: '30002',
  CONNECTED_TV: '30004',
} as const;

export type BidAdjustmentDevice = keyof typeof DEVICE_CRITERION_IDS;

export interface NormalizedDeviceBidAdjustment {
  device: BidAdjustmentDevice;
  /** Google bid_modifier: 1 + percent/100. 0 excludes the device. */
  bidModifier: number;
}

export interface NormalizedDeviceBidAdjustments {
  scope: 'CAMPAIGN' | 'AD_GROUP';
  customerId: string;
  /** campaign id (CAMPAIGN scope) or ad group resource name (AD_GROUP scope). */
  campaignId?: string;
  adGroupResourceName?: string;
  adjustments: NormalizedDeviceBidAdjustment[];
}

function deviceValidationError(code: NegativeCampaignCriteriaValidationCode, message: string) {
  return new NegativeCampaignCriteriaValidationError(code, message);
}

export function validateDeviceBidAdjustments(
  customerId: unknown,
  campaignResourceName: unknown,
  adGroupResourceName: unknown,
  adjustmentsInput: unknown,
): NormalizedDeviceBidAdjustments {
  if (typeof customerId !== 'string' || !/^\d+$/.test(customerId)) {
    throw deviceValidationError('INVALID_CUSTOMER_ID', 'customer_id must be numeric with no dashes for SET_DEVICE_BID_ADJUSTMENT');
  }
  if (Boolean(campaignResourceName) === Boolean(adGroupResourceName)) {
    throw deviceValidationError(
      'MISSING_IDENTIFIERS',
      'Pass exactly one of campaign_resource_name or ad_group_resource_name for SET_DEVICE_BID_ADJUSTMENT',
    );
  }

  let campaignId: string | undefined;
  let adGroup: string | undefined;
  if (campaignResourceName) {
    const m = typeof campaignResourceName === 'string'
      ? /^customers\/(\d+)\/campaigns\/(\d+)$/.exec(campaignResourceName) : null;
    if (!m) {
      throw deviceValidationError('INVALID_CAMPAIGN_RESOURCE_NAME', 'campaign_resource_name must use customers/<customer_id>/campaigns/<campaign_id> form');
    }
    if (m[1] !== customerId) throw deviceValidationError('CAMPAIGN_CUSTOMER_MISMATCH', 'campaign_resource_name must belong to customer_id');
    campaignId = m[2];
  } else {
    const m = typeof adGroupResourceName === 'string'
      ? /^customers\/(\d+)\/adGroups\/\d+$/.exec(adGroupResourceName) : null;
    if (!m) {
      throw deviceValidationError('INVALID_AD_GROUP_RESOURCE_NAME', 'ad_group_resource_name must use customers/<customer_id>/adGroups/<ad_group_id> form');
    }
    if (m[1] !== customerId) throw deviceValidationError('CAMPAIGN_CUSTOMER_MISMATCH', 'ad_group_resource_name must belong to customer_id');
    adGroup = adGroupResourceName as string;
  }

  if (!Array.isArray(adjustmentsInput) || adjustmentsInput.length === 0) {
    throw deviceValidationError('MISSING_CRITERIA', 'device_bid_adjustments must be a non-empty array of {device, bid_modifier_percent}');
  }
  const seen = new Set<string>();
  const adjustments = adjustmentsInput.map((raw: any) => {
    const device = typeof raw?.device === 'string' ? raw.device.trim().toUpperCase() : raw?.device;
    if (!Object.prototype.hasOwnProperty.call(DEVICE_CRITERION_IDS, device)) {
      throw deviceValidationError('INVALID_DEVICE', `Unknown device ${String(raw?.device)}; use MOBILE, TABLET, DESKTOP or CONNECTED_TV`);
    }
    if (seen.has(device)) throw deviceValidationError('INVALID_DEVICE', `Device ${device} listed more than once`);
    seen.add(device);
    const pct = raw?.bid_modifier_percent;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < -100 || pct > 900) {
      throw deviceValidationError('INVALID_BID_MODIFIER', `bid_modifier_percent for ${device} must be a number from -100 (exclude) to 900`);
    }
    const bidModifier = pct === -100 ? 0 : Math.round((1 + pct / 100) * 10000) / 10000;
    // 0 means device opt-out in Google Ads; only an explicit -100 may produce it.
    if (pct !== -100 && bidModifier <= 0) {
      throw deviceValidationError('INVALID_BID_MODIFIER', `bid_modifier_percent for ${device} is too close to -100; use exactly -100 to exclude the device`);
    }
    return { device: device as BidAdjustmentDevice, bidModifier };
  });

  return adGroup
    ? { scope: 'AD_GROUP', customerId, adGroupResourceName: adGroup, adjustments }
    : { scope: 'CAMPAIGN', customerId, campaignId, adjustments };
}

/** Pure: build the Google Ads mutate resource + operations for a validated adjustment set. */
export function buildDeviceBidAdjustmentOperations(
  n: NormalizedDeviceBidAdjustments,
  existingAdGroupModifiers: Partial<Record<BidAdjustmentDevice, string>> = {},
): {
  resource: 'campaignCriteria' | 'adGroupBidModifiers';
  operations: any[];
} {
  if (n.scope === 'CAMPAIGN') {
    return {
      resource: 'campaignCriteria',
      operations: n.adjustments.map((a) => ({
        update: {
          resourceName: `customers/${n.customerId}/campaignCriteria/${n.campaignId}~${DEVICE_CRITERION_IDS[a.device]}`,
          bidModifier: a.bidModifier,
        },
        updateMask: 'bid_modifier',
      })),
    };
  }
  return {
    resource: 'adGroupBidModifiers',
    operations: n.adjustments.map((a) => {
      const existing = existingAdGroupModifiers[a.device];
      return existing
        ? { update: { resourceName: existing, bidModifier: a.bidModifier }, updateMask: 'bid_modifier' }
        : { create: { adGroup: n.adGroupResourceName, bidModifier: a.bidModifier, device: { type: a.device } } };
    }),
  };
}
