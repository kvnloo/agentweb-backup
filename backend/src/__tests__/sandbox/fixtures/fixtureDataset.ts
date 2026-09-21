import type {
  SandboxDataset, SandboxInsightsDaily, SandboxInsightsBreakdownDaily, SandboxAction,
} from '../../../services/sandbox/types';

/**
 * Deterministic, reconciling synthetic dataset for the sandbox simulator tests (ENG-1908).
 * Every number is a pure function of (day index, ad index), so account totals equal the sum
 * of rows, breakdown rows sum back to the daily rows, and pixel stats equal the lead/landing
 * page counts of the same day. The shape mirrors the compiler's phase-4 output.
 */
export const FIXTURE_ACCOUNT_ID = '1207000000000001';
export const FIXTURE_WINDOW = { since: '2026-04-09', until: '2026-04-30' };
const DAYS = 22;

const id = (n: number) => `1202100000000${String(n).padStart(5, '0')}`;
export const FIXTURE_IDS = {
  campaigns: [id(101), id(102), id(103)],
  adsets: [id(201), id(202), id(203), id(204)],
  ads: [id(301), id(302), id(303), id(304), id(305), id(306)],
  creatives: [id(401), id(402), id(403), id(404), id(405), id(406)],
  page: '100000000000001',
  pixel: '900000000000001',
  audience: '2390000000000001',
  business: '3000000000000001',
};

const AD_TO_ADSET = [0, 0, 1, 1, 2, 3];
const ADSET_TO_CAMPAIGN = [0, 0, 1, 2];
const AD_BASE_IMPRESSIONS = [420, 310, 550, 260, 380, 150];

export function dayAt(index: number): string {
  const d = new Date(Date.UTC(2026, 3, 9 + index));
  return d.toISOString().slice(0, 10);
}

/** Largest-remainder split of `total` by `shares` (sums exactly to total). */
export function splitByShares(total: number, shares: number[]): number[] {
  const raw = shares.map(s => total * s);
  const floors = raw.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => [v - floors[i], i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (remainder <= 0) break; floors[i]++; remainder--; }
  return floors;
}

export const AGE_GENDER_BUCKETS: Array<{ age: string; gender: string; share: number }> = [
  { age: '25-34', gender: 'female', share: 0.15 }, { age: '25-34', gender: 'male', share: 0.12 },
  { age: '35-44', gender: 'female', share: 0.20 }, { age: '35-44', gender: 'male', share: 0.18 },
  { age: '45-54', gender: 'female', share: 0.20 }, { age: '45-54', gender: 'male', share: 0.15 },
];
export const PLACEMENT_BUCKETS: Array<{ publisher_platform: string; platform_position: string; share: number }> = [
  { publisher_platform: 'facebook', platform_position: 'feed', share: 0.45 },
  { publisher_platform: 'instagram', platform_position: 'feed', share: 0.25 },
  { publisher_platform: 'instagram', platform_position: 'instagram_stories', share: 0.15 },
  { publisher_platform: 'facebook', platform_position: 'facebook_reels', share: 0.15 },
];

function dailyMetrics(dayIndex: number, adIndex: number) {
  const campaign = ADSET_TO_CAMPAIGN[AD_TO_ADSET[adIndex]];
  // The TRAFFIC campaign was paused after ten days.
  if (campaign === 2 && dayIndex >= 10) return null;
  const wobble = 1 + ((dayIndex * 7 + adIndex * 3) % 5) / 10;
  const impressions = Math.round(AD_BASE_IMPRESSIONS[adIndex] * wobble);
  const clicks = Math.round(impressions * 0.031);
  const inline_link_clicks = Math.round(clicks * 0.75);
  const landing = Math.floor(inline_link_clicks * 0.7);
  const lead = Math.floor(inline_link_clicks / 10);
  const registration = Math.floor(lead * 0.6);
  const spend = impressions * 8 + clicks * 12; // cents
  const reach = Math.round(impressions * 0.8);
  return { impressions, clicks, inline_link_clicks, landing, lead, registration, spend, reach };
}

function actionsFor(m: NonNullable<ReturnType<typeof dailyMetrics>>): SandboxAction[] {
  const actions: SandboxAction[] = [
    { action_type: 'link_click', value: m.inline_link_clicks },
    { action_type: 'landing_page_view', value: m.landing },
  ];
  if (m.lead > 0) {
    actions.push({ action_type: 'lead', value: m.lead });
    actions.push({ action_type: 'offsite_conversion.fb_pixel_lead', value: m.lead });
  }
  if (m.registration > 0) actions.push({ action_type: 'complete_registration', value: m.registration });
  return actions;
}

export function buildFixtureDataset(overrides: Partial<SandboxDataset> = {}): SandboxDataset {
  const t = (day: string) => `${day}T00:00:00+0000`;
  const campaigns = [
    { name: 'Founder Demos — Lead Gen', objective: 'OUTCOME_LEADS', status: 'ACTIVE' as const, daily_budget: 5000 },
    { name: 'Agency Owners — Lead Gen', objective: 'OUTCOME_LEADS', status: 'ACTIVE' as const, daily_budget: 4000 },
    { name: 'Blog Traffic — Spring', objective: 'OUTCOME_TRAFFIC', status: 'PAUSED' as const, daily_budget: 1500 },
  ].map((c, i) => ({
    id: FIXTURE_IDS.campaigns[i], account_id: FIXTURE_ACCOUNT_ID, name: c.name, status: c.status,
    effective_status: c.status, objective: c.objective, daily_budget: c.daily_budget, budget_remaining: c.daily_budget,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP', start_time: t(FIXTURE_WINDOW.since), special_ad_categories: [],
    created_time: t('2026-04-08'), updated_time: t(FIXTURE_WINDOW.until),
  }));
  const adsets = [
    { name: 'Founders 25-54 US', optimization_goal: 'LEAD_GENERATION', billing_event: 'IMPRESSIONS', destination_type: 'ON_AD' },
    { name: 'Founders — Retargeting', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', destination_type: 'WEBSITE',
      promoted_object: { pixel_id: FIXTURE_IDS.pixel, custom_event_type: 'LEAD' } },
    { name: 'Agency owners — Broad', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS', destination_type: 'WEBSITE',
      promoted_object: { pixel_id: FIXTURE_IDS.pixel, custom_event_type: 'LEAD' } },
    { name: 'Blog readers — Interests', optimization_goal: 'LINK_CLICKS', billing_event: 'LINK_CLICKS', destination_type: 'WEBSITE' },
  ].map((a, i) => ({
    id: FIXTURE_IDS.adsets[i], account_id: FIXTURE_ACCOUNT_ID, campaign_id: FIXTURE_IDS.campaigns[ADSET_TO_CAMPAIGN[i]], name: a.name,
    status: 'ACTIVE' as const, effective_status: 'ACTIVE', optimization_goal: a.optimization_goal, billing_event: a.billing_event,
    destination_type: a.destination_type, ...(a.promoted_object ? { promoted_object: a.promoted_object } : {}),
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP', start_time: t(FIXTURE_WINDOW.since),
    targeting: { geo_locations: { countries: ['US'] }, age_min: 25, age_max: 54, publisher_platforms: ['facebook', 'instagram'] },
  }));
  const adcreatives = FIXTURE_IDS.creatives.map((cid, i) => ({
    id: cid, account_id: FIXTURE_ACCOUNT_ID, name: `Creative ${i + 1}`, status: 'ACTIVE',
    body: `Body copy for creative ${i + 1}`, title: `Headline ${i + 1}`,
    image_url: `https://assets.example.invalid/sandbox/creative_${i + 1}.jpg`,
    thumbnail_url: `https://assets.example.invalid/sandbox/creative_${i + 1}_thumb.jpg`,
    image_hash: `hash${String(i + 1).padStart(28, '0')}`, object_type: 'SHARE',
    link_url: 'https://landing.example.invalid/demo', url_tags: 'utm_source=meta&utm_campaign={{campaign.name}}',
    object_story_spec: { page_id: FIXTURE_IDS.page, link_data: { link: 'https://landing.example.invalid/demo', message: `Body copy for creative ${i + 1}`,
      name: `Headline ${i + 1}`, image_hash: `hash${String(i + 1).padStart(28, '0')}`, picture: `https://assets.example.invalid/sandbox/creative_${i + 1}.jpg`,
      call_to_action: { type: 'LEARN_MORE', value: { link: 'https://landing.example.invalid/demo' } } } },
    created_time: t('2026-04-08'),
  }));
  const adimages = adcreatives.map((c, i) => ({ hash: c.image_hash!, url: c.image_url!, name: `creative_${i + 1}.jpg`, width: 1080, height: 1080, status: 'ACTIVE' as const }));
  const ads = FIXTURE_IDS.ads.map((aid, i) => ({
    id: aid, account_id: FIXTURE_ACCOUNT_ID, adset_id: FIXTURE_IDS.adsets[AD_TO_ADSET[i]],
    campaign_id: FIXTURE_IDS.campaigns[ADSET_TO_CAMPAIGN[AD_TO_ADSET[i]]], name: `Ad ${i + 1}`,
    status: 'ACTIVE' as const, effective_status: 'ACTIVE', creative: { id: FIXTURE_IDS.creatives[i] },
    ad_review_feedback: null, created_time: t('2026-04-08'), updated_time: t('2026-04-08'),
  }));

  const insightsDaily: SandboxInsightsDaily[] = [];
  const insightsBreakdownDaily: SandboxInsightsBreakdownDaily[] = [];
  const pixelDays: Array<{ date: string; events: Record<string, number> }> = [];
  for (let d = 0; d < DAYS; d++) {
    const date = dayAt(d);
    let leadTotal = 0, pageViews = 0;
    for (let a = 0; a < ads.length; a++) {
      const m = dailyMetrics(d, a);
      if (!m) continue;
      const ad = ads[a];
      insightsDaily.push({ date, ad_id: ad.id, adset_id: ad.adset_id, campaign_id: ad.campaign_id, impressions: m.impressions, reach: m.reach,
        clicks: m.clicks, inline_link_clicks: m.inline_link_clicks, spend: m.spend, actions: actionsFor(m) });
      leadTotal += m.lead; pageViews += m.landing;
      const pushBreakdown = (breakdown: SandboxInsightsBreakdownDaily['breakdown'], buckets: Array<Record<string, string | number>>) => {
        const shares = buckets.map(b => b.share as number);
        const imp = splitByShares(m.impressions, shares), rch = splitByShares(m.reach, shares), clk = splitByShares(m.clicks, shares);
        const spd = splitByShares(m.spend, shares), lnk = splitByShares(m.inline_link_clicks, shares), led = splitByShares(m.lead, shares);
        buckets.forEach((b, k) => {
          const { share, ...dims } = b;
          const actions: SandboxAction[] = [{ action_type: 'link_click', value: lnk[k] }];
          if (led[k] > 0) { actions.push({ action_type: 'lead', value: led[k] }); actions.push({ action_type: 'offsite_conversion.fb_pixel_lead', value: led[k] }); }
          insightsBreakdownDaily.push({ date, ad_id: ad.id, adset_id: ad.adset_id, campaign_id: ad.campaign_id, breakdown,
            dims: dims as Record<string, string>, impressions: imp[k], reach: rch[k], clicks: clk[k], spend: spd[k], actions });
        });
      };
      pushBreakdown('age,gender', AGE_GENDER_BUCKETS);
      pushBreakdown('publisher_platform,platform_position', PLACEMENT_BUCKETS);
    }
    pixelDays.push({ date, events: { PageView: pageViews, Lead: leadTotal } });
  }

  const dataset: SandboxDataset = {
    meta: { datasetId: 'fixture-agentweb', version: 1, schemaVersion: 1, caseId: 'fixture', frozenWindow: { ...FIXTURE_WINDOW },
      dateShift: 'anchor_until_to_yesterday_utc', approximations: ['reach = sum of daily reach', 'breakdowns allocated by fixed shares'], createdAt: '2026-09-12T00:00:00.000Z' },
    account: { id: `act_${FIXTURE_ACCOUNT_ID}`, account_id: FIXTURE_ACCOUNT_ID, name: 'AgentWeb Sandbox', currency: 'USD', timezone_name: 'UTC', account_status: 1,
      business: { id: FIXTURE_IDS.business, name: 'AgentWeb Sandbox Business' } },
    pages: [{ id: FIXTURE_IDS.page, name: 'AgentWeb', category: 'Software', tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MANAGE', 'MODERATE'], instagram_business_account: { id: '17800000000000001' } }],
    pixels: [{ id: FIXTURE_IDS.pixel, name: 'AgentWeb Pixel', last_fired_time: t(FIXTURE_WINDOW.until), is_created_by_business: true, statsByDay: pixelDays }],
    customAudiences: [{ id: FIXTURE_IDS.audience, name: 'Website visitors 30d', subtype: 'WEBSITE', delivery_status: { code: 200, description: 'This audience is ready for use.' },
      approximate_count_lower_bound: 1200, time_created: t('2026-04-01'), time_updated: t(FIXTURE_WINDOW.until) }],
    campaigns, adsets, adcreatives, adimages, ads, insightsDaily, insightsBreakdownDaily,
    landers: [{ url: 'https://landing.example.invalid/demo', pixelIds: [FIXTURE_IDS.pixel] }],
    targetingCatalog: { interests: [{ id: '6003139266461', name: 'Marketing', audience_size_lower_bound: 1000000, path: ['Interests', 'Business and industry', 'Marketing'] }],
      geo: [{ key: 'US', name: 'United States', type: 'country', country_code: 'US', supports_region: true, supports_city: true }] },
  };
  return { ...dataset, ...overrides };
}

/** Sum of a daily-row metric across the whole fixture window for a set of ad ids (or all). */
export function fixtureTotal(dataset: SandboxDataset, metric: 'impressions' | 'clicks' | 'spend' | 'reach' | 'inline_link_clicks', adIds?: string[]): number {
  return dataset.insightsDaily.filter(r => !adIds || adIds.includes(r.ad_id)).reduce((n, r) => n + r[metric], 0);
}
export function fixtureActionTotal(dataset: SandboxDataset, actionType: string, adIds?: string[]): number {
  return dataset.insightsDaily.filter(r => !adIds || adIds.includes(r.ad_id))
    .reduce((n, r) => n + (r.actions.find(a => a.action_type === actionType)?.value ?? 0), 0);
}
