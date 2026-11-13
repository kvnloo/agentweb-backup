/**
 * ENG-2823 — Zoma Google Ads toolkit manifest (provider #2; Meta's is metaToolkitManifest.ts).
 *
 * A pure filter over emma/googleAdsTools, which holds the same handler objects Emma
 * registers, so the full Emma registry is never imported and no handler is re-implemented.
 *
 * Surface (enforced twice — narrowed in the advertised schema AND refused at call time):
 *   - call_google_ads_reporting_api: all modes (read-only tool).
 *   - call_google_ads_api reads: LIST of BUDGET, CAMPAIGN, AD_GROUP, KEYWORD, AD,
 *     BIDDING_STRATEGY, CONVERSION_ACTION; LOCATION SEARCH.
 *   - call_google_ads_api guarded writes (googleToolkitWrites.ts): BUDGET CREATE/UPDATE,
 *     CAMPAIGN CREATE (PMax with brand)/UPDATE status|name, AD_GROUP CREATE/UPDATE status|name+cpc_bid (ENG-2959),
 *     CAMPAIGN_CONVERSION_GOAL UPDATE; ENG-2928: KEYWORD ADD/UPDATE status/REMOVE/ADD_NEGATIVE,
 *     AD CREATE (responsive search)/UPDATE status|RSA content (ENG-2979), ASSET_GROUP CREATE/UPDATE status.
 *   - call_google_ads_api direct (non-spending) write: ASSET UPLOAD — no preview token, but the
 *     same write gate, key scope, read-back and metering.
 * Everything else (other REMOVEs, display ads, campaign assets/criteria, conversions, client_id,
 * override_tracking_check) is refused.
 */
import { googleAdsToolRegistry, GOOGLE_ADS_TOOL_NAMES } from '../emma/googleAdsTools';
import type { McpToolRegistry } from './server/registry';
import { MetaToolkitRefusal } from './metaToolkitErrors';

export const GOOGLE_TOOLKIT_TOOL_NAMES = GOOGLE_ADS_TOOL_NAMES;
export type GoogleToolkitToolName = (typeof GOOGLE_TOOLKIT_TOOL_NAMES)[number];

export const GOOGLE_READ_ACTIONS: Record<string, readonly string[]> = {
  BUDGET: ['LIST'],
  CAMPAIGN: ['LIST'],
  AD_GROUP: ['LIST'],
  KEYWORD: ['LIST'],
  AD: ['LIST'],
  BIDDING_STRATEGY: ['LIST'],
  CONVERSION_ACTION: ['LIST'],
  CAMPAIGN_CONVERSION_GOAL: ['LIST'],
  LOCATION: ['SEARCH'],
};

export const GOOGLE_GUARDED_WRITES: Record<string, readonly string[]> = {
  BUDGET: ['CREATE', 'UPDATE'],
  CAMPAIGN: ['CREATE', 'UPDATE'],
  AD_GROUP: ['CREATE', 'UPDATE'],
  CAMPAIGN_CONVERSION_GOAL: ['UPDATE'],
  KEYWORD: ['ADD', 'UPDATE', 'REMOVE', 'ADD_NEGATIVE'],
  AD: ['CREATE', 'UPDATE'],
  ASSET_GROUP: ['CREATE', 'UPDATE'],
};

/** ENG-2928: writes that cannot spend, so they skip the preview token (see googleToolkitWrites). */
export const GOOGLE_DIRECT_WRITES: Record<string, readonly string[]> = {
  ASSET: ['UPLOAD'],
};

export function isGoogleToolkitTool(name: string): name is GoogleToolkitToolName {
  return (GOOGLE_TOOLKIT_TOOL_NAMES as readonly string[]).includes(name);
}

export function isGoogleGuardedWrite(name: string, args: any): boolean {
  return name === 'call_google_ads_api'
    && (GOOGLE_GUARDED_WRITES[String(args?.entity_type)] ?? []).includes(String(args?.action));
}

/** Any write (guarded or direct): needs the write key scope, the write gate, and is metered. */
export function isGoogleToolkitWrite(name: string, args: any): boolean {
  return isGoogleGuardedWrite(name, args) || (name === 'call_google_ads_api'
    && (GOOGLE_DIRECT_WRITES[String(args?.entity_type)] ?? []).includes(String(args?.action)));
}

// Arguments an external caller may send to call_google_ads_api (schema is narrowed to these).
const API_ARGS = [
  'biddable', 'resource_name', 'campaign_id', 'customer_id', 'entity_type', 'action', 'name', 'type', 'budget_resource_name', 'explicitly_shared',
  'bidding_strategy', 'bidding_strategy_resource_name', 'bidding_strategy_target',
  'location_target_ids', 'campaign_resource_name', 'ad_group_resource_name', 'query', 'status',
  'brand_business_name', 'brand_logo_asset_resource_name', 'keywords', 'criterion_resource_name', 'ad_resource_name',
  'headlines', 'descriptions', 'final_url', 'long_headlines', 'square_image_assets', 'landscape_image_assets',
  'logo_assets', 'video_assets', 'asset_group_resource_name',
];

const GOOGLE_ADS_API_DESCRIPTION =
  'Google Ads API for external agents. Reads: LIST of BUDGET, CAMPAIGN, AD_GROUP (campaign_resource_name), KEYWORD/AD (ad_group_resource_name), ' +
  'BIDDING_STRATEGY, CONVERSION_ACTION, CAMPAIGN_CONVERSION_GOAL (campaign_id?); LOCATION SEARCH (query). ' +
  'Guarded writes: BUDGET CREATE (name, amount, explicitly_shared?) / UPDATE (budget_resource_name, amount); ' +
  'CAMPAIGN CREATE (name, type, budget_resource_name, bidding_strategy | bidding_strategy_resource_name, location_target_ids?) / UPDATE (campaign_resource_name, status | name); ' +
  'AD_GROUP CREATE (name, campaign_resource_name, type, cpc_bid?) / UPDATE (ad_group_resource_name, status | name? cpc_bid?). ' +
  'CAMPAIGN/AD_GROUP UPDATE: status is sent alone; a rename or ad-group max CPC change is its own preview showing current vs new (cpc_bid also in micros). ' +
  'CAMPAIGN_CONVERSION_GOAL UPDATE (resource_name from LIST, biddable boolean only): preview shows campaign, category, origin and current/new biddable. ' +
  'Every write is two calls: first without confirm (returns a PREVIEW and preview_token, nothing changes), show the preview to the user, ' +
  'then after their explicit approval repeat the exact same call with confirm=true and the preview_token. ' +
  'New campaigns and ad groups are always created PAUSED; enabling (status=ENABLED) is its own separate preview and approval. ' +
  'Budgets are in MAJOR units of the account currency (amount: 50 = $50.00/day); the preview echoes the micros. ' +
  'A shared budget (explicitly_shared) caps every campaign attached to it; the preview names how many. ' +
  'KEYWORD ADD (ad_group_resource_name, keywords[{text, matchType BROAD|PHRASE|EXACT}]) / UPDATE (criterion_resource_name, status) / REMOVE (criterion_resource_name) / ' +
  'ADD_NEGATIVE (keywords, and exactly one of ad_group_resource_name or campaign_resource_name). ' +
  'AD CREATE responsive search ad (ad_group_resource_name, headlines 3-15 of <=30 chars, descriptions 2-4 of <=90 chars, final_url https) / UPDATE (ad_resource_name, and either status alone or any of headlines / descriptions / final_url for a responsive search ad; the preview shows current vs new). ' +
  'Performance Max end to end: ASSET UPLOAD the logo (asset_type LOGO) and images → BUDGET CREATE → CAMPAIGN CREATE type PERFORMANCE_MAX with brand_business_name (<=25 chars) + brand_logo_asset_resource_name → ' +
  'ASSET_GROUP CREATE (name, campaign_resource_name, final_url, headlines 3-15 <=30, long_headlines 1-5 <=90, descriptions 2-5 <=90 with one <=60, square_image_assets, landscape_image_assets, logo_assets?, video_assets?) → ' +
  'ASSET_GROUP UPDATE status=ENABLED and CAMPAIGN UPDATE status=ENABLED. ' +
  'ASSET UPLOAD (asset_type IMAGE|LOGO with data = https image URL or zoma_prepare_upload file_url; TEXT with data = the text; VIDEO with data = YouTube video id; name) cannot spend, so it runs without a preview but is still read back. ' +
  'Keywords, ads and asset groups are always created PAUSED; enabling each is its own preview and approval. ' +
  'A write is done only when the result says verification CONFIRMED. Other REMOVEs, display ads, campaign assets and other conversion writes are not available.';

function narrowApiDefinition(definition: any): any {
  const def = JSON.parse(JSON.stringify(definition));
  const props = def.inputSchema.properties;
  const kept: Record<string, any> = {};
  for (const key of API_ARGS) if (props[key]) kept[key] = props[key];
  const entities = [...new Set([...Object.keys(GOOGLE_READ_ACTIONS), ...Object.keys(GOOGLE_GUARDED_WRITES), ...Object.keys(GOOGLE_DIRECT_WRITES)])];
  kept.entity_type = { ...props.entity_type, enum: entities };
  kept.action = { type: 'string', enum: ['LIST', 'SEARCH', 'CREATE', 'UPDATE', 'ADD', 'ADD_NEGATIVE', 'REMOVE', 'UPLOAD'], description: 'See the description for which entity supports which action.' };
  kept.status = { type: 'string', enum: ['ENABLED', 'PAUSED'], description: 'CAMPAIGN/AD_GROUP/KEYWORD/AD/ASSET_GROUP UPDATE only (alone, nothing else changes in the same call). Creates are always PAUSED.' };
  kept.keywords = { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, matchType: { type: 'string', enum: ['BROAD', 'PHRASE', 'EXACT'] } }, required: ['text', 'matchType'] }, description: 'KEYWORD ADD / ADD_NEGATIVE: 1-100 keywords (text <=80 chars, <=10 words).' };
  kept.type = { type: 'string', description: 'CAMPAIGN CREATE: SEARCH|DISPLAY|PERFORMANCE_MAX. AD_GROUP CREATE: SEARCH_STANDARD|DISPLAY_STANDARD. AD CREATE: RESPONSIVE_SEARCH_AD (default).' };
  kept.asset_type = { type: 'string', enum: ['IMAGE', 'LOGO', 'TEXT', 'VIDEO'], description: 'ASSET UPLOAD: IMAGE (marketing image), LOGO (square logo), TEXT, or VIDEO (YouTube).' };
  kept.data = { type: 'string', description: 'ASSET UPLOAD: IMAGE/LOGO → public https image URL or the file_url from zoma_prepare_upload; TEXT → the text (<=90 chars); VIDEO → the YouTube video id.' };
  kept.amount = { type: 'number', description: 'BUDGET CREATE/UPDATE: daily budget in MAJOR units of the account currency (50 = $50.00). Converted to micros; the preview echoes both.' };
  kept.cpc_bid = { type: 'number', description: 'AD_GROUP CREATE/UPDATE: max CPC bid in MAJOR units of the account currency (converted to micros).' };
  kept.cpc_bid_ceiling = { type: 'number', description: 'CAMPAIGN CREATE (TARGET_SPEND / TARGET_IMPRESSION_SHARE only): max CPC ceiling in MAJOR units of the account currency.' };
  kept.biddable = { type: 'boolean', description: 'CAMPAIGN_CONVERSION_GOAL UPDATE only: whether the goal drives campaign bidding.' };
  kept.resource_name = { type: 'string', description: 'CAMPAIGN_CONVERSION_GOAL UPDATE: customers/<customer_id>/campaignConversionGoals/<campaignId>~<CATEGORY>~<ORIGIN> from LIST.' };
  kept.campaign_id = { type: 'string', description: 'CAMPAIGN_CONVERSION_GOAL LIST only: optional numeric campaign filter.' };
  kept.confirm = { type: 'boolean', description: 'Writes only. Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.' };
  kept.preview_token = { type: 'string', description: 'Writes only. The preview_token returned by the preview the user approved. Single use, 15 minutes; the call must repeat the previewed arguments exactly.' };
  def.description = GOOGLE_ADS_API_DESCRIPTION;
  def.inputSchema = { ...def.inputSchema, properties: kept, required: ['customer_id', 'entity_type', 'action'] };
  return def;
}

function narrowDefinition(definition: any): any {
  if (definition.name === 'call_google_ads_api') return narrowApiDefinition(definition);
  const def = JSON.parse(JSON.stringify(definition));
  delete def.inputSchema?.properties?.client_id;
  return def;
}

/** Google toolkit tool definitions. Fails loudly when a tool is missing from the registry. */
export function getGoogleToolkitManifest(registry: McpToolRegistry = googleAdsToolRegistry) {
  return GOOGLE_TOOLKIT_TOOL_NAMES.map((name) => {
    const tool = registry.getTool(name);
    if (!tool) throw new Error(`Google Ads toolkit manifest: tool ${name} is not registered`);
    return narrowDefinition(tool.definition);
  });
}

/** Throws MetaToolkitRefusal (the toolkit's tool-level refusal) when outside the surface. */
export function assertGoogleToolkitCall(name: string, args: any): void {
  if (!isGoogleToolkitTool(name)) throw new MetaToolkitRefusal(`Tool ${name} is not part of the Google Ads toolkit.`);
  if (args?.client_id !== undefined) throw new MetaToolkitRefusal('client_id is not available to external Google Ads toolkit callers.');
  if (args?.override_tracking_check !== undefined || args?.tracking_override_token !== undefined) {
    throw new MetaToolkitRefusal('override_tracking_check is not available to external Google Ads toolkit callers.');
  }
  if (name === 'call_google_ads_reporting_api') return;
  const entity = String(args?.entity_type ?? '');
  const action = String(args?.action ?? '');
  if ((GOOGLE_READ_ACTIONS[entity] ?? []).includes(action)) return;
  if (isGoogleToolkitWrite(name, args)) return;
  throw new MetaToolkitRefusal(`${entity} ${action} is not part of the Google Ads toolkit surface.`);
}

/** Execute a toolkit READ through the shared registry, flagged externalMcp. */
export async function executeGoogleToolkitRead(
  name: string,
  args: any,
  context: { userId: string; sessionId?: string },
  registry: McpToolRegistry = googleAdsToolRegistry,
) {
  if (!context?.userId) throw new MetaToolkitRefusal('Google Ads toolkit calls require an authenticated user.');
  assertGoogleToolkitCall(name, args);
  if (isGoogleToolkitWrite(name, args)) throw new MetaToolkitRefusal('Writes go through the guarded write path.');
  return registry.execute(name, args, { ...context, externalMcp: true });
}
