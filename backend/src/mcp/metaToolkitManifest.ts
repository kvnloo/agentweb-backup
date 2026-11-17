/**
 * ENG-2282 — Meta Toolkit v1 manifest for external agents (ENG-2268 child 2).
 *
 * Exposes ONLY the v1 Meta tools defined in docs/integrations/meta-toolkit-product.md §4
 * (ENG-2281) as MCP-compatible tool definitions. It is a pure filter over the Meta-only
 * registry in emma/metaTools, which holds the same handler objects Emma registers, so the
 * full Emma registry is never imported. It never re-implements a handler, so a call goes
 * through the same `registry.execute` → `agentModeService.callMetaMarketingApi` path that Emma uses,
 * and every ENG-2046-family write guard (approval deck, money normalization, anomaly
 * gate, rate shaper, tracking pre-flight) stays in the path. There is no bypass.
 *
 * The v1 exclusions are enforced twice. They are narrowed in the advertised schema, and
 * they are refused at call time. A caller that ignores the schema still cannot reach an
 * excluded action.
 */
import { SIGNAL_READ_DEFINITIONS } from './metaToolkitSignals';
import { metaToolRegistry } from '../emma/metaTools';
import type { McpToolRegistry } from './server/registry';
import { isZomaTool, zomaToolDefinitions } from './zomaToolDefinitions';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { GUARDED_WRITE_ACTIONS, LIFECYCLE_WRITE_ACTIONS } from './metaToolkitWriteSurface';
import { isMetaHealthTool, META_HEALTH_TOOL_DEFINITIONS } from './metaToolkitHealth';
import { isMetaCatalogTool, META_CATALOG_TOOL_DEFINITIONS } from './metaToolkitCatalogs';
import { isMetaCatalogFeedTool, META_CATALOG_FEED_TOOL_DEFINITIONS } from './metaToolkitCatalogFeeds';
import { isMetaEventSourceTool, META_EVENT_SOURCE_TOOL_DEFINITIONS } from './metaToolkitEventSources';
import { isMetaCatalogWriteTool, META_CATALOG_WRITE_TOOL_DEFINITIONS } from './metaToolkitCatalogWrites';
import { isMetaPagesTool, META_PAGES_TOOL_DEFINITIONS } from './metaToolkitPages';
import { AD_ACCOUNTS_TOOL_DEFINITION, AD_ACCOUNTS_TOOL_NAME } from './metaToolkitAdAccounts';
import { isMetaBoostTool, META_BOOST_TOOL_DEFINITIONS } from './metaToolkitBoost';
import { EXPERIMENT_READ_DEFINITIONS } from './metaToolkitExperiments';
import { isMetaExperimentWriteTool, META_EXPERIMENT_WRITE_TOOL_DEFINITIONS } from './metaToolkitExperimentWrites';
import { DIAGNOSTICS_READ_DEFINITIONS } from './metaToolkitDiagnostics';
import { HELP_ARTICLE_DEFINITION } from './metaToolkitHelp';
import { isZomaAdsReportTool, ZOMA_ADS_REPORT_DEFINITION } from './zomaAdsReport';

export const CREATIVE_UPLOAD_ACTIONS = ['UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'BULK_CREATE'] as const;

const META_MARKETING_API_DESCRIPTION =
  'Meta Marketing API for external agents. Reads: LIST, GET, PREVIEW, SEARCH, GET_MATCH_QUALITY. ' +
  'Guarded writes (CAMPAIGN, AD_SET, AD only): CREATE, and UPDATE of status (ACTIVE/PAUSED), budget, name (CAMPAIGN, AD_SET, AD), CAMPAIGN bid_strategy/spend_cap, AD_SET bid_amount/bid_strategy/targeting/start_time/end_time, AD creative_id (swap), ' +
  'ARCHIVE (stops delivery, keeps history), DELETE (irreversible) and COPY (params.deep_copy for CAMPAIGN/AD_SET, ' +
  'params.campaign_id = destination campaign for an AD_SET copy, params.adset_id = destination ad set for an AD copy; copies are created PAUSED). ' +
  'ARCHIVE/DELETE are refused when the entity spent in the last 24 hours unless confirm_recent_spend=true after the user explicitly accepts it; prefer pausing first. ' +
  'Every write is two calls: first without confirm (returns a PREVIEW and preview_token, nothing changes), show the preview to the user, ' +
  'then after their explicit approval repeat the exact same call with confirm=true and the preview_token. ' +
  'New campaigns, ad sets and ads are always created PAUSED; activating (status=ACTIVE) is its own separate preview and approval. ' +
  'Budgets are in MAJOR units of the ad account currency (e.g. 50 = $50.00); the preview echoes the converted amount. ' +
  'A write is done only when the result says verification CONFIRMED. ' +
  'CREATIVES (no preview needed, they cannot spend until an ad uses them): AD_CREATIVE UPLOAD_IMAGE (params.image_url) → image_hash; ' +
  'AD_CREATIVE UPLOAD_VIDEO (params.video_url: any public https URL of the video FILE, e.g. a UGC .mp4 link, max 1 GB) → video_id + thumbnail_url, waits for Meta processing (re-check with params.video_id); ' +
  'AD_CREATIVE CREATE (name, page_id, body, title, link_url, call_to_action_type + image_hash | image_url | video_id [Meta thumbnail used if none given]) → creative_id; ' +
  'or carousel_cards (2-10 cards, each with its own image_hash/image_url/video_id and link_url) or placement_assets, with no top-level image; ' +
  'or MULTI-VARIANT (Advantage+): headlines[] / bodies[] / descriptions[] (up to 5 each) + image_hashes[] / video_ids[] (up to 10 each) + link_url → one creative Meta optimizes; ' +
  'AD_CREATIVE BULK_CREATE (params.items: up to 10 creatives, each with its media and optional overrides; other params are shared; items may use video_url) → per-item results, partial success reported; ' +
  'then AD CREATE with params.creative_id (guarded preview, created PAUSED). For a file on the user\'s computer call zoma_prepare_upload first. ' +
  'Use PAGE LIST for page_id. For custom audiences, lookalikes, customer lists and excluding existing customers use zoma_custom_audiences.';

export const META_TOOLKIT_V1_TOOL_NAMES = [
  'list_meta_ads_campaigns',
  'get_meta_ads_metrics',
  'call_meta_ads_insights_api',
  'call_meta_marketing_api',
] as const;

export type MetaToolkitToolName = (typeof META_TOOLKIT_V1_TOOL_NAMES)[number];

/** ENG-2268 D2: external v1 is reads-only, regardless of plan or granted Meta scopes. */
export const META_TOOLKIT_V1_ACTIONS = ['LIST', 'GET', 'PREVIEW', 'SEARCH', 'GET_MATCH_QUALITY'] as const;

const READ_ACTIONS = new Set<string>(META_TOOLKIT_V1_ACTIONS);

export { MetaToolkitRefusal };

function isV1Tool(name: string): name is MetaToolkitToolName {
  return (META_TOOLKIT_V1_TOOL_NAMES as readonly string[]).includes(name);
}

function narrowDefinition(definition: any): any {
  const def = JSON.parse(JSON.stringify(definition));
  const props = def?.inputSchema?.properties;
  if (props) {
    // client_id is admin-only cross-client access: internal only (§4).
    delete props.client_id;
    if (def.name === 'call_meta_marketing_api') {
      def.description = META_MARKETING_API_DESCRIPTION;
      if (props.action?.enum) {
        props.action.enum = [...META_TOOLKIT_V1_ACTIONS, ...GUARDED_WRITE_ACTIONS, ...LIFECYCLE_WRITE_ACTIONS, ...CREATIVE_UPLOAD_ACTIONS];
      }
      props.confirm = {
        type: 'boolean',
        description: 'Writes only. Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.',
      };
      props.preview_token = {
        type: 'string',
        description: 'Writes only. The preview_token returned by the preview the user approved. Single use, 15 minutes; the call must repeat the previewed arguments exactly.',
      };
      props.confirm_recent_spend = {
        type: 'boolean',
        description: 'ARCHIVE/DELETE only. Set true only when the user explicitly accepts stopping an entity that spent in the last 24 hours (or whose spend could not be checked). Part of the previewed arguments.',
      };
      // The waiver replay is not wired through the deck flow (§4).
      if (props.params?.properties) delete props.params.properties.override_tracking_check;
    }
  }
  if (Array.isArray(def?.inputSchema?.required)) {
    def.inputSchema.required = def.inputSchema.required.filter((k: string) => k !== 'client_id');
  }
  return def;
}

/**
 * Return ONLY the v1 Meta Toolkit tool definitions (name, description, inputSchema).
 * Fails loudly when a v1 tool is missing from the registry. A silently shorter
 * manifest would read as a product change.
 */
export function getMetaToolkitManifest(registry: McpToolRegistry = metaToolRegistry) {
  const metaTools = META_TOOLKIT_V1_TOOL_NAMES.map((name) => {
    const tool = registry.getTool(name);
    if (!tool) throw new Error(`Meta Toolkit manifest: tool ${name} is not registered`);
    return narrowDefinition(tool.definition);
  });
  // ENG-2303: toolkit-local Zoma onboarding tools (handled by the gateway, not the registry).
  // ENG-2916: read-only account health + learning-phase tools (handled by the gateway).
  return [
    ...metaTools,
    ...SIGNAL_READ_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    ...EXPERIMENT_READ_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    // ENG-2980: experiment eligibility + A/B / lift writes (writes are preview → confirm).
    ...META_EXPERIMENT_WRITE_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    JSON.parse(JSON.stringify(HELP_ARTICLE_DEFINITION)),
    ...DIAGNOSTICS_READ_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    ...META_HEALTH_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    ...META_CATALOG_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    // ENG-2925: product + product-set writes (deletes are preview → confirm) and the filter helper.
    ...META_CATALOG_WRITE_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    // ENG-2927: catalog event sources (connect/disconnect are preview → confirm).
    ...META_EVENT_SOURCE_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    // ENG-2926: catalog create/update, feeds, upload sessions, feed rules (deletes are preview → confirm).
    ...META_CATALOG_FEED_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    ...META_PAGES_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    // ENG-3040: read-only list of the connected ad accounts (handled by the gateway, before account resolution).
    JSON.parse(JSON.stringify(AD_ACCOUNTS_TOOL_DEFINITION)),
    // ENG-3033: boost an Instagram post (preview → confirm; campaign, ad set and ad created PAUSED).
    ...META_BOOST_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d))),
    ...zomaToolDefinitions().map((d) => JSON.parse(JSON.stringify(d))),
    // ENG-3134: the one reporting tool (spend, impressions, clicks, CTR, CPC, conversions, ROAS).
    JSON.parse(JSON.stringify(ZOMA_ADS_REPORT_DEFINITION)),
  ];
}

/** Throws MetaToolkitRefusal when the call is outside the v1 surface. */
export function assertMetaToolkitV1Call(name: string, args: any): void {
  if (isZomaTool(name) || isZomaAdsReportTool(name) || isMetaHealthTool(name) || isMetaCatalogTool(name) || isMetaCatalogWriteTool(name) || isMetaEventSourceTool(name) || isMetaCatalogFeedTool(name) || isMetaPagesTool(name) || isMetaBoostTool(name) || isMetaExperimentWriteTool(name) || name === AD_ACCOUNTS_TOOL_NAME) return;
  if (!isV1Tool(name)) {
    throw new MetaToolkitRefusal(`Tool ${name} is not part of the Meta Toolkit.`);
  }
  if (args && args.client_id !== undefined) {
    throw new MetaToolkitRefusal('client_id is not available to external Meta Toolkit callers.');
  }
  if (name !== 'call_meta_marketing_api') return;

  const entity = String(args?.entity_type ?? '');
  const action = String(args?.action ?? '');
  if (args?.params && args.params.override_tracking_check !== undefined) {
    throw new MetaToolkitRefusal('override_tracking_check is not available to external Meta Toolkit callers.');
  }
  if (READ_ACTIONS.has(action)) return;
  throw new MetaToolkitRefusal(`${entity} ${action} is not part of the Meta Toolkit v1 surface.`);
}

/**
 * Execute a Meta Toolkit call on behalf of an external agent. The call goes through the
 * shared registry dispatcher, flagged `externalMcp`, so the registry's own refusals
 * (internalOnly, anonymous, publish consent) and the handler's write guards all apply.
 * Authentication and metering are ENG-2283. This function assumes a resolved userId.
 */
export async function executeMetaToolkitCall(
  name: string,
  args: any,
  context: { userId: string; sessionId?: string; [k: string]: unknown },
  registry: McpToolRegistry = metaToolRegistry,
) {
  if (!context?.userId) throw new MetaToolkitRefusal('Meta Toolkit calls require an authenticated user.');
  assertMetaToolkitV1Call(name, args);
  return registry.execute(name, args, { ...context, externalMcp: true });
}
