/** One immutable, paused campaign build carried by an existing approval-deck write item. */
import { MetaService } from '../metaService';
import { META_OBJ_GOAL_MAP, META_GOAL_BILLING_MAP, META_WEBSITE_OPTIMIZATION_GOALS } from '../../utils/metaConstants';

export const PAUSED_BUNDLE_ACTION = 'CREATE_PAUSED_BUNDLE';
type Params = Record<string, any>;
export interface PausedMetaBundle {
  requested_ad_count: number;
  campaign: Params;
  ad_set: Params;
  ads: Params[];
  currency?: string;
}
const CAMPAIGN_FIELDS = ['name', 'objective', 'status', 'special_ad_categories', 'spend_cap', 'advantage_campaign_budget', 'budget_amount'];
const AD_SET_FIELDS = ['name', 'status', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'bid_amount', 'optimization_goal', 'billing_event', 'destination_type', 'promoted_object', 'targeting', 'start_time', 'end_time'];

function record(value: unknown): value is Params {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, allowed: string[], label: string): Params {
  if (!record(value)) throw new Error(`${label} must be an object.`);
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length) throw new Error(`${label} contains unsupported fields: ${extra.join(', ')}.`);
  return structuredClone(value);
}
function paused(value: unknown, allowed: string[], label: string): Params {
  const params = fields(value, allowed, label);
  if (typeof params.name !== 'string' || !params.name.trim()) throw new Error(`${label} needs a name.`);
  if (params.status !== undefined && params.status !== 'PAUSED') throw new Error(`${label} must be PAUSED; activation needs separate approval.`);
  params.status = 'PAUSED';
  return params;
}

/** Reject flags, parent overrides, omitted ads and wrong-type elements before any I/O. */
export function parsePausedMetaBundle(input: unknown): PausedMetaBundle {
  const root = fields(input, ['requested_ad_count', 'campaign', 'ad_set', 'ads', 'currency'], 'Paused bundle');
  if (!Number.isSafeInteger(root.requested_ad_count) || root.requested_ad_count < 1 || root.requested_ad_count > 50 ||
      !Array.isArray(root.ads) || root.ads.length !== root.requested_ad_count) {
    throw new Error('List exactly requested_ad_count ads (1–50); a partial brief cannot be approved.');
  }
  const campaign = paused(root.campaign, CAMPAIGN_FIELDS, 'Campaign');
  MetaService.validateCampaignParams('CREATE', campaign);
  if (campaign.special_ad_categories !== undefined && !campaign.special_ad_categories.every((v: unknown) => typeof v === 'string')) {
    throw new Error('special_ad_categories must contain strings.');
  }
  campaign.special_ad_categories ??= [];
  const ad_set = paused(root.ad_set, AD_SET_FIELDS, 'Ad set');
  if (!record(ad_set.targeting) || !record(ad_set.targeting.geo_locations)) throw new Error('Ad set needs explicit targeting.geo_locations.');
  if (!META_OBJ_GOAL_MAP[campaign.objective]?.includes(ad_set.optimization_goal) ||
      !META_GOAL_BILLING_MAP[ad_set.optimization_goal]?.includes(ad_set.billing_event)) {
    throw new Error('Objective, optimization_goal and billing_event must be compatible.');
  }
  ad_set.bid_strategy ??= 'LOWEST_COST_WITHOUT_CAP';
  if (ad_set.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP' && ad_set.bid_amount === undefined) throw new Error('This bid strategy needs bid_amount.');
  if (ad_set.targeting.targeting_automation !== undefined && !record(ad_set.targeting.targeting_automation)) throw new Error('Invalid targeting_automation.');
  ad_set.targeting.targeting_automation = { advantage_audience: 0, ...ad_set.targeting.targeting_automation };
  if (ad_set.destination_type === undefined && META_WEBSITE_OPTIMIZATION_GOALS.includes(ad_set.optimization_goal)) ad_set.destination_type = 'WEBSITE';
  const cbo = campaign.advantage_campaign_budget === true;
  if (campaign.advantage_campaign_budget !== undefined && typeof campaign.advantage_campaign_budget !== 'boolean') throw new Error('advantage_campaign_budget must be boolean.');
  if (cbo ? campaign.budget_amount === undefined || ad_set.daily_budget !== undefined || ad_set.lifetime_budget !== undefined
    : campaign.budget_amount !== undefined || (ad_set.daily_budget === undefined) === (ad_set.lifetime_budget === undefined)) {
    throw new Error('Choose exactly one budget: campaign budget_amount with advantage_campaign_budget=true, or ad-set daily_budget/lifetime_budget.');
  }
  for (const p of [campaign, ad_set]) for (const key of ['budget_amount', 'spend_cap', 'daily_budget', 'lifetime_budget', 'bid_amount']) {
    if (p[key] !== undefined && (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] <= 0)) throw new Error(`${key} must be a positive amount in account currency.`);
  }
  if (ad_set.lifetime_budget !== undefined && (!ad_set.start_time || !ad_set.end_time)) throw new Error('A lifetime budget needs start_time and end_time.');
  const ads = root.ads.map((ad: unknown, i: number) => {
    const p = paused(ad, ['name', 'status', 'creative_id'], `Ad ${i + 1}`);
    if (typeof p.creative_id !== 'string' || !p.creative_id.trim()) throw new Error(`Ad ${i + 1} needs an exact creative_id.`);
    return p;
  });
  if (root.currency !== undefined && (typeof root.currency !== 'string' || !/^[A-Z]{3}$/.test(root.currency))) throw new Error('Invalid bundle currency.');
  return { requested_ad_count: root.requested_ad_count, campaign, ad_set, ads, ...(root.currency ? { currency: root.currency } : {}) };
}

export function pausedBundleSummary(bundle: PausedMetaBundle, account: string): string {
  return `Create one PAUSED campaign, one PAUSED ad set and exactly ${bundle.requested_ad_count} PAUSED ads in account ${account}. ` +
    `This approval never activates delivery or spending. Amounts are in ${bundle.currency} major units. Exact brief:\n${JSON.stringify(bundle, null, 2)}`;
}

export interface PausedBundleDeps {
  normalize: (params: Params) => Promise<{ params: Params; currency?: string }>;
  write: (entity: string, params: Params, campaignId?: string, adSetId?: string) => Promise<any>;
  read: (entity: string, id: string, fields: string[]) => Promise<unknown>;
}

function matches(expected: any, actual: any, field = ''): boolean {
  if (actual === undefined || actual === null) return false;
  if (['start_time', 'end_time'].includes(field)) return Number.isFinite(Date.parse(expected)) && Date.parse(expected) === Date.parse(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length &&
    expected.every(e => actual.some(a => matches(e, a)));
  if (record(expected)) return record(actual) && Object.keys(expected).every(k => matches(expected[k], actual[k], k));
  return typeof expected === 'number' ? (typeof actual === 'number' || typeof actual === 'string') && String(expected) === String(actual) : expected === actual;
}

/** Called ONLY after the enclosing exact manifest was durably claimed. No model-supplied IDs. */
export async function executePausedMetaBundle(input: unknown, deps: PausedBundleDeps) {
  const bundle = parsePausedMetaBundle(input);
  const ledger: Array<{ entity: string; id: string; verified: boolean }> = [];
  let verifiedAds = 0;
  try {
    const campaignMoney = await deps.normalize(bundle.campaign);
    const adSetMoney = await deps.normalize(bundle.ad_set);
    const currencies = [campaignMoney.currency, adSetMoney.currency].filter(Boolean);
    if (!bundle.currency || !currencies.length || currencies.some(currency => currency !== bundle.currency)) throw new Error('Account currency changed after approval.');
    const seenIds = new Set<string>();
    const create = async (entity: string, params: Params, expected: Params, campaignId?: string, adSetId?: string) => {
      const result = await deps.write(entity, structuredClone(params), campaignId, adSetId);
      const key = entity === 'CAMPAIGN' ? 'campaign' : entity === 'AD_SET' ? 'adSet' : 'ad';
      const id = result?.[key]?.id;
      if (typeof id !== 'string' || !id.trim() || seenIds.has(id)) throw new Error(result?.message || `${entity} did not return a distinct created ID; do not retry blindly.`);
      seenIds.add(id);
      const entry = { entity, id, verified: false };
      ledger.push(entry);
      if (result.success !== true || result.awaitingUserConfirmation || result.blocked || result.throttled) throw new Error(result.message || `${entity} was not confirmed.`);
      const node = await deps.read(entity, id, ['id', ...Object.keys(expected).filter(k => k !== 'creative_id')]);
      if (!record(node) || node.id !== id) throw new Error(`${entity} ${id} read-back is missing or has the wrong ID.`);
      for (const [field, requested] of Object.entries(expected)) {
        const applied = field === 'creative_id' ? node.creative?.id : node[field];
        if (!matches(requested, applied, field)) throw new Error(`${entity} ${id} read-back mismatch: ${field}.`);
      }
      entry.verified = true;
      if (entity === 'AD') verifiedAds++;
      return id;
    };
    const { advantage_campaign_budget, budget_amount, ...campaignExpected } = campaignMoney.params;
    campaignExpected.special_ad_categories = bundle.campaign.special_ad_categories.filter((v: string) => v !== 'NONE' && v !== '');
    const campaignId = await create('CAMPAIGN', bundle.campaign, campaignExpected);
    const adSetId = await create('AD_SET', bundle.ad_set, { ...adSetMoney.params, campaign_id: campaignId }, campaignId);
    for (const ad of bundle.ads) await create('AD', ad, { ...ad, adset_id: adSetId }, campaignId, adSetId);
    return { success: true, complete: true, requested_ad_count: bundle.requested_ad_count, verified_ad_count: verifiedAds, ledger,
      message: `Paused bundle verified: ${verifiedAds}/${bundle.requested_ad_count} ads, campaign ${campaignId}, ad set ${adSetId}. Delivery remains PAUSED.` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Verification failed.';
    return { success: false, complete: false, requested_ad_count: bundle.requested_ad_count, verified_ad_count: verifiedAds, ledger,
      message: `Paused bundle INCOMPLETE: ${verifiedAds}/${bundle.requested_ad_count} ads verified. ${detail} Created IDs: ${ledger.map(e => e.id).join(', ') || 'none'}. Do not report completion or recreate the bundle blindly.` };
  }
}
