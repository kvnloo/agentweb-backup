/**
 * ENG-2430 — Ads Auto Publisher demo (non-functional, dry-run only).
 *
 * Pure planner: campaign spec JSON -> the Meta campaign/adset/ad payloads that a
 * publisher WOULD create. No Emma dependency, no Meta token, no network I/O.
 * Nothing in this directory is imported by app.ts; it is never deployed.
 */

export const OBJECTIVES = [
  'OUTCOME_SALES',
  'OUTCOME_LEADS',
  'OUTCOME_TRAFFIC',
  'OUTCOME_AWARENESS',
  'OUTCOME_ENGAGEMENT',
  'OUTCOME_APP_PROMOTION',
] as const;
export type Objective = (typeof OBJECTIVES)[number];

export interface CreativeSpec {
  name?: string;
  primaryText: string;
  headline: string;
  imageUrl: string;
  linkUrl: string;
  callToAction?: string;
}

export interface CampaignSpec {
  name: string;
  objective: Objective;
  /** Daily budget in the account currency's major unit (e.g. 50 = $50.00). */
  dailyBudget: number;
  audience: {
    countries: string[];
    ageMin?: number;
    ageMax?: number;
    genders?: Array<'male' | 'female'>;
    interests?: string[];
  };
  creatives: CreativeSpec[];
}

export interface PlannedObject {
  type: 'campaign' | 'adset' | 'adcreative' | 'ad';
  ref: string;
  endpoint: string;
  payload: Record<string, unknown>;
}

export interface PlanResult {
  dryRun: true;
  valid: boolean;
  errors: string[];
  objects: PlannedObject[];
}

const OPTIMIZATION_GOAL: Record<Objective, string> = {
  OUTCOME_SALES: 'OFFSITE_CONVERSIONS',
  OUTCOME_LEADS: 'LEAD_GENERATION',
  OUTCOME_TRAFFIC: 'LINK_CLICKS',
  OUTCOME_AWARENESS: 'REACH',
  OUTCOME_ENGAGEMENT: 'POST_ENGAGEMENT',
  OUTCOME_APP_PROMOTION: 'APP_INSTALLS',
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isHttpUrl = (v: unknown): boolean => {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

export function validateSpec(input: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(input)) return ['spec must be a JSON object'];
  const s = input;
  if (!isNonEmptyString(s.name)) errors.push('name is required');
  if (!OBJECTIVES.includes(s.objective as Objective)) {
    errors.push(`objective must be one of ${OBJECTIVES.join(', ')}`);
  }
  if (typeof s.dailyBudget !== 'number' || !Number.isFinite(s.dailyBudget) || s.dailyBudget < 1) {
    errors.push('dailyBudget must be a number >= 1');
  }
  if (!isObj(s.audience)) {
    errors.push('audience is required');
  } else {
    const a = s.audience;
    if (
      !Array.isArray(a.countries) ||
      a.countries.length === 0 ||
      !a.countries.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c))
    ) {
      errors.push('audience.countries must be a non-empty list of ISO-3166 alpha-2 codes');
    }
    const ageMin = a.ageMin ?? 18;
    const ageMax = a.ageMax ?? 65;
    if (typeof ageMin !== 'number' || typeof ageMax !== 'number' || ageMin < 13 || ageMax > 65 || ageMin > ageMax) {
      errors.push('audience age range must satisfy 13 <= ageMin <= ageMax <= 65');
    }
    if (a.genders !== undefined && (!Array.isArray(a.genders) || !a.genders.every((g) => g === 'male' || g === 'female'))) {
      errors.push('audience.genders entries must be "male" or "female"');
    }
  }
  if (!Array.isArray(s.creatives) || s.creatives.length === 0) {
    errors.push('creatives must be a non-empty list');
  } else {
    s.creatives.forEach((c, i) => {
      if (!isObj(c)) {
        errors.push(`creatives[${i}] must be an object`);
        return;
      }
      if (!isNonEmptyString(c.primaryText)) errors.push(`creatives[${i}].primaryText is required`);
      if (!isNonEmptyString(c.headline)) errors.push(`creatives[${i}].headline is required`);
      if (!isHttpUrl(c.imageUrl)) errors.push(`creatives[${i}].imageUrl must be an http(s) URL`);
      if (!isHttpUrl(c.linkUrl)) errors.push(`creatives[${i}].linkUrl must be an http(s) URL`);
    });
  }
  return errors;
}

/** Build the would-be Meta objects. Everything is created PAUSED; nothing is sent anywhere. */
export function planPublish(input: unknown): PlanResult {
  const errors = validateSpec(input);
  if (errors.length > 0) return { dryRun: true, valid: false, errors, objects: [] };
  const spec = input as CampaignSpec;
  const act = 'act_<AD_ACCOUNT_ID>';
  const genderCodes = (spec.audience.genders ?? []).map((g) => (g === 'male' ? 1 : 2));
  const objects: PlannedObject[] = [
    {
      type: 'campaign',
      ref: 'campaign_1',
      endpoint: `POST /${act}/campaigns`,
      payload: {
        name: spec.name,
        objective: spec.objective,
        status: 'PAUSED',
        special_ad_categories: [],
        buying_type: 'AUCTION',
      },
    },
    {
      type: 'adset',
      ref: 'adset_1',
      endpoint: `POST /${act}/adsets`,
      payload: {
        name: `${spec.name} — Ad set 1`,
        campaign_id: '{campaign_1.id}',
        daily_budget: Math.round(spec.dailyBudget * 100),
        billing_event: 'IMPRESSIONS',
        optimization_goal: OPTIMIZATION_GOAL[spec.objective],
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        status: 'PAUSED',
        targeting: {
          geo_locations: { countries: spec.audience.countries },
          age_min: spec.audience.ageMin ?? 18,
          age_max: spec.audience.ageMax ?? 65,
          ...(genderCodes.length ? { genders: genderCodes } : {}),
          ...(spec.audience.interests?.length
            ? { flexible_spec: [{ interests: spec.audience.interests.map((name) => ({ name })) }] }
            : {}),
        },
      },
    },
  ];
  spec.creatives.forEach((c, i) => {
    const n = i + 1;
    objects.push({
      type: 'adcreative',
      ref: `creative_${n}`,
      endpoint: `POST /${act}/adcreatives`,
      payload: {
        name: c.name ?? `${spec.name} — Creative ${n}`,
        object_story_spec: {
          page_id: '<PAGE_ID>',
          link_data: {
            message: c.primaryText,
            name: c.headline,
            link: c.linkUrl,
            picture: c.imageUrl,
            call_to_action: { type: c.callToAction ?? 'LEARN_MORE', value: { link: c.linkUrl } },
          },
        },
      },
    });
    objects.push({
      type: 'ad',
      ref: `ad_${n}`,
      endpoint: `POST /${act}/ads`,
      payload: {
        name: `${spec.name} — Ad ${n}`,
        adset_id: '{adset_1.id}',
        creative: { creative_id: `{creative_${n}.id}` },
        status: 'PAUSED',
      },
    });
  });
  return { dryRun: true, valid: true, errors: [], objects };
}
