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
 *     CAMPAIGN CREATE/UPDATE status, AD_GROUP CREATE/UPDATE status.
 * Everything else (REMOVE, keywords/ads/assets writes, conversions, criteria, client_id,
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
  LOCATION: ['SEARCH'],
};

export const GOOGLE_GUARDED_WRITES: Record<string, readonly string[]> = {
  BUDGET: ['CREATE', 'UPDATE'],
  CAMPAIGN: ['CREATE', 'UPDATE'],
  AD_GROUP: ['CREATE', 'UPDATE'],
};

export function isGoogleToolkitTool(name: string): name is GoogleToolkitToolName {
  return (GOOGLE_TOOLKIT_TOOL_NAMES as readonly string[]).includes(name);
}

export function isGoogleGuardedWrite(name: string, args: any): boolean {
  return name === 'call_google_ads_api'
    && (GOOGLE_GUARDED_WRITES[String(args?.entity_type)] ?? []).includes(String(args?.action));
}

// Arguments an external caller may send to call_google_ads_api (schema is narrowed to these).
const API_ARGS = [
  'customer_id', 'entity_type', 'action', 'name', 'type', 'budget_resource_name', 'explicitly_shared',
  'bidding_strategy', 'bidding_strategy_resource_name', 'bidding_strategy_target',
  'location_target_ids', 'campaign_resource_name', 'ad_group_resource_name', 'query', 'status',
];

const GOOGLE_ADS_API_DESCRIPTION =
  'Google Ads API for external agents. Reads: LIST of BUDGET, CAMPAIGN, AD_GROUP (campaign_resource_name), KEYWORD/AD (ad_group_resource_name), ' +
  'BIDDING_STRATEGY, CONVERSION_ACTION; LOCATION SEARCH (query). ' +
  'Guarded writes: BUDGET CREATE (name, amount, explicitly_shared?) / UPDATE (budget_resource_name, amount); ' +
  'CAMPAIGN CREATE (name, type, budget_resource_name, bidding_strategy | bidding_strategy_resource_name, location_target_ids?) / UPDATE (campaign_resource_name, status); ' +
  'AD_GROUP CREATE (name, campaign_resource_name, type, cpc_bid?) / UPDATE (ad_group_resource_name, status). ' +
  'Every write is two calls: first without confirm (returns a PREVIEW and preview_token, nothing changes), show the preview to the user, ' +
  'then after their explicit approval repeat the exact same call with confirm=true and the preview_token. ' +
  'New campaigns and ad groups are always created PAUSED; enabling (status=ENABLED) is its own separate preview and approval. ' +
  'Budgets are in MAJOR units of the account currency (amount: 50 = $50.00/day); the preview echoes the micros. ' +
  'A shared budget (explicitly_shared) caps every campaign attached to it; the preview names how many. ' +
  'A write is done only when the result says verification CONFIRMED. REMOVE, keywords/ads/assets writes and conversions are not available.';

function narrowApiDefinition(definition: any): any {
  const def = JSON.parse(JSON.stringify(definition));
  const props = def.inputSchema.properties;
  const kept: Record<string, any> = {};
  for (const key of API_ARGS) if (props[key]) kept[key] = props[key];
  kept.entity_type = { ...props.entity_type, enum: Object.keys(GOOGLE_READ_ACTIONS) };
  kept.action = { type: 'string', enum: ['LIST', 'SEARCH', 'CREATE', 'UPDATE'], description: 'See the description for which entity supports which action.' };
  kept.status = { type: 'string', enum: ['ENABLED', 'PAUSED'], description: 'CAMPAIGN/AD_GROUP UPDATE only (alone, nothing else changes in the same call). Creates are always PAUSED.' };
  kept.amount = { type: 'number', description: 'BUDGET CREATE/UPDATE: daily budget in MAJOR units of the account currency (50 = $50.00). Converted to micros; the preview echoes both.' };
  kept.cpc_bid = { type: 'number', description: 'AD_GROUP CREATE: max CPC bid in MAJOR units of the account currency (converted to micros).' };
  kept.cpc_bid_ceiling = { type: 'number', description: 'CAMPAIGN CREATE (TARGET_SPEND / TARGET_IMPRESSION_SHARE only): max CPC ceiling in MAJOR units of the account currency.' };
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
  if (isGoogleGuardedWrite(name, args)) return;
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
  if (isGoogleGuardedWrite(name, args)) throw new MetaToolkitRefusal('Writes go through the guarded preview → confirm path.');
  return registry.execute(name, args, { ...context, externalMcp: true });
}
