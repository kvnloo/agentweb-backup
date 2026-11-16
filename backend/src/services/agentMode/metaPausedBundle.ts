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
  /** Server-read content carried inside the existing signed approval payload. */
  creative_preflight?: Params[];
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
export function parsePausedMetaBundle(input: unknown, approved = false): PausedMetaBundle {
  const root = fields(input, ['requested_ad_count', 'campaign', 'ad_set', 'ads', 'currency', ...(approved ? ['creative_preflight'] : [])], 'Paused bundle');
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
  return { requested_ad_count: root.requested_ad_count, campaign, ad_set, ads, ...(root.currency ? { currency: root.currency } : {}),
    ...(approved ? { creative_preflight: root.creative_preflight } : {}) };
}

/** Never accept the model's self-reported count as evidence of what the user requested. */
export function assertPausedBundleUserCount(bundle: PausedMetaBundle, messages: unknown): void {
  if (!Array.isArray(messages) || messages.some(m => !record(m) || typeof m.role !== 'string' || typeof m.content !== 'string')) {
    throw new Error('The user brief could not be verified.');
  }
  const units = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const names = Array.from({ length: 51 }, (_, n) => n < 20 ? units[n]
    : ['twenty', 'thirty', 'forty', 'fifty'][Math.floor(n / 10) - 2] + (n % 10 ? `[- ]${units[n % 10]}` : ''));
  const countPattern = new RegExp(`\\b(\\d+|${names.slice().reverse().join('|')})\\s+(?:(?:paused|new|different|distinct|separate)\\s+)*ads?\\b(?![ -]+sets?\\b)(?:\\s+variants?)?`, 'gi');
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'user' || message.metadata?.approvalDeckAnswer) continue;
    const counts = [...message.content.matchAll(countPattern)].map((match: RegExpMatchArray) =>
      /^\d+$/.test(match[1]) ? Number(match[1]) : names.findIndex(name => new RegExp(`^${name}$`, 'i').test(match[1])));
    if (!counts.length) continue;
    if (new Set(counts).size !== 1) throw new Error('The user brief has ambiguous ad counts; an exact count is required.');
    if (counts[0] !== bundle.requested_ad_count) throw new Error(`The user requested ${counts[0]} ads; the bundle lists ${bundle.requested_ad_count}.`);
    return;
  }
  throw new Error('An explicit ad count in the user brief is required before bundle approval.');
}

const CREATIVE_CONTENT_FIELDS = ['body', 'title', 'image_url', 'link_url', 'object_story_spec', 'asset_feed_spec', 'url_tags'];
const COPY_FIELDS = new Set(['body', 'title', 'message', 'name', 'caption', 'description', 'text', 'link', 'link_url', 'website_url', 'url_tags']);
const OBJECT_FIELDS = new Set(['object_story_spec', 'asset_feed_spec', 'link_data', 'video_data', 'call_to_action']);
const ARRAY_FIELDS = new Set(['child_attachments', 'bodies', 'titles', 'descriptions', 'link_urls', 'images', 'videos', 'asset_customization_rules']);
const PLACEHOLDER = /\blorem\s+ipsum\b|\b(?:TBD|TODO)\b|\b(?:insert|replace)[ _-]+(?:your[ _-]+)?(?:copy|text|headline|title|description|company|brand)\b|\byour[_-](?:text|copy|headline|company|brand)[_-]|\{\{[^}]+\}\}|\[(?:insert|your|company|brand|headline|placeholder)\b[^\]]*\]/i;

function inspectCreativeContent(value: unknown, field: string): boolean {
  if (value === undefined || value === null) {
    if (field === '') throw new Error('Creative content contains a malformed element.');
    return false;
  }
  if (COPY_FIELDS.has(field) && typeof value !== 'string' || OBJECT_FIELDS.has(field) && !record(value) || ARRAY_FIELDS.has(field) && !Array.isArray(value)) {
    throw new Error(`Creative content is malformed at ${field}.`);
  }
  let readable = false;
  if (typeof value === 'string') {
    const isUrl = ['url_tags', 'link', 'link_url', 'website_url', 'image_url'].includes(field);
    // These are live Meta URL macros, not unfinished customer copy (see utils/adUtm.ts).
    const text = isUrl ? value.replace(/\{\{(?:(?:campaign|adset|ad)\.(?:id|name)|placement|site_source_name)\}\}/g, '') : value;
    if (PLACEHOLDER.test(text)) throw new Error(`Creative contains placeholder text at ${field}.`);
    readable = COPY_FIELDS.has(field) && !isUrl && !!value.trim();
  }
  if (Array.isArray(value)) for (const item of value) {
    if (ARRAY_FIELDS.has(field) && !record(item)) throw new Error(`Creative content contains a malformed ${field} element.`);
    if (['bodies', 'titles', 'descriptions'].includes(field) && (!record(item) || typeof item.text !== 'string' || !item.text.trim())) {
      throw new Error(`Creative content contains unreadable ${field} text.`);
    }
    readable = inspectCreativeContent(item, '') || readable;
  }
  else if (record(value)) for (const [key, child] of Object.entries(value)) readable = inspectCreativeContent(child, key) || readable;
  return readable;
}

/** Both preview and execution use this exact read-only preflight, before any parent exists. */
export async function preflightPausedMetaCreatives(bundle: PausedMetaBundle, account: string, read: (id: string) => Promise<unknown>): Promise<Params[]> {
  const snapshots: Params[] = [];
  for (const id of new Set(bundle.ads.map(ad => ad.creative_id))) {
    const creative = await read(id);
    if (!record(creative) || creative.id !== id) throw new Error(`Creative ${id} is unavailable or has the wrong ID.`);
    // Do not let assertOwnedByAccount's string normalization accept arrays/objects as IDs.
    MetaService.assertOwnedByAccount(typeof creative.account_id === 'string' ? creative.account_id : undefined, id, 'Ad creative', account);
    const snapshot: Params = { id };
    for (const field of CREATIVE_CONTENT_FIELDS) if (creative[field] !== undefined && creative[field] !== null) snapshot[field] = creative[field];
    if (!inspectCreativeContent(snapshot, '')) throw new Error(`Creative ${id} has no readable copy to preflight.`);
    snapshots.push(structuredClone(snapshot));
  }
  return snapshots;
}

export function pausedBundleSummary(bundle: PausedMetaBundle, account: string): string {
  return `Create one PAUSED campaign, one PAUSED ad set and exactly ${bundle.requested_ad_count} PAUSED ads in account ${account}. ` +
    `This approval never activates delivery or spending. Amounts are in ${bundle.currency} major units. Exact brief:\n${JSON.stringify(bundle, null, 2)}`;
}

export interface PausedBundleDeps {
  preflight: (bundle: PausedMetaBundle) => Promise<Params[]>;
  normalize: (params: Params) => Promise<{ params: Params; currency?: string }>;
  write: (entity: string, params: Params, campaignId?: string, adSetId?: string) => Promise<any>;
  read: (entity: string, id: string, fields: string[]) => Promise<unknown>;
}

function matches(expected: any, actual: any, field = '', unorderedArrays = true): boolean {
  if (expected === null) return actual === null;
  if (actual === undefined || actual === null) return false;
  if (['start_time', 'end_time'].includes(field)) return Number.isFinite(Date.parse(expected)) && Date.parse(expected) === Date.parse(actual);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length !== actual.length) return false;
    if (!unorderedArrays) return expected.every((e, i) => matches(e, actual[i], '', false));
    const remaining = [...actual];
    return expected.every(e => {
      const index = remaining.findIndex(a => matches(e, a));
      if (index === -1) return false;
      remaining.splice(index, 1);
      return true;
    });
  }
  if (record(expected)) return record(actual) && Object.keys(expected).every(k => matches(expected[k], actual[k], k, unorderedArrays)) &&
    // Meta may annotate targeting IDs with display names; all other extra nested fields fail closed.
    Object.keys(actual).every(k => k in expected || (k === 'name' && typeof expected.id === 'string' && typeof actual.name === 'string'));
  return typeof expected === 'number' ? (typeof actual === 'number' || typeof actual === 'string') && String(expected) === String(actual) : expected === actual;
}

/** Called ONLY after the enclosing exact manifest was durably claimed. No model-supplied IDs. */
export async function executePausedMetaBundle(input: unknown, deps: PausedBundleDeps) {
  const bundle = parsePausedMetaBundle(input, true);
  const ledger: Array<{ entity: string; id: string; verified: boolean }> = [];
  let verifiedAds = 0;
  try {
    const creatives = await deps.preflight(bundle);
    if (!Array.isArray(bundle.creative_preflight) || !matches(bundle.creative_preflight, creatives, '', false)) throw new Error('Creative content changed after approval; review a fresh brief.');
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
      const moneyFields = entity === 'CAMPAIGN' ? ['daily_budget', 'lifetime_budget', 'spend_cap']
        : entity === 'AD_SET' ? ['daily_budget', 'lifetime_budget', 'bid_amount'] : [];
      const node = await deps.read(entity, id, [...new Set(['id', ...Object.keys(expected).filter(k => k !== 'creative_id'), ...moneyFields])]);
      if (!record(node) || node.id !== id) throw new Error(`${entity} ${id} read-back is missing or has the wrong ID.`);
      for (const field of moneyFields) if (expected[field] === undefined && node[field] !== undefined && node[field] !== null && node[field] !== 0 && node[field] !== '0') {
        throw new Error(`${entity} ${id} read-back contains an unapproved ${field}.`);
      }
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
