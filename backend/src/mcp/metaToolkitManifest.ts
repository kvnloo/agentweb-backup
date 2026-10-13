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
import { metaToolRegistry } from '../emma/metaTools';
import type { McpToolRegistry } from './server/registry';
import { isZomaTool, ZOMA_TOOL_DEFINITIONS } from './zomaToolDefinitions';
import { MetaToolkitRefusal } from './metaToolkitErrors';
import { GUARDED_WRITE_ACTIONS } from './metaToolkitWriteSurface';

const META_MARKETING_API_DESCRIPTION =
  'Meta Marketing API for external agents. Reads: LIST, GET, PREVIEW, SEARCH, GET_MATCH_QUALITY. ' +
  'Guarded writes (CAMPAIGN, AD_SET, AD only): CREATE, and UPDATE of status (ACTIVE/PAUSED) or budget. ' +
  'Every write is two calls: first without confirm (returns a PREVIEW and preview_token, nothing changes), show the preview to the user, ' +
  'then after their explicit approval repeat the exact same call with confirm=true and the preview_token. ' +
  'New campaigns, ad sets and ads are always created PAUSED; activating (status=ACTIVE) is its own separate preview and approval. ' +
  'Budgets are in MAJOR units of the ad account currency (e.g. 50 = $50.00); the preview echoes the converted amount. ' +
  'A write is done only when the result says verification CONFIRMED. DELETE, creatives, audiences and uploads are not available.';

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
      if (props.action?.enum) props.action.enum = [...META_TOOLKIT_V1_ACTIONS, ...GUARDED_WRITE_ACTIONS];
      props.confirm = {
        type: 'boolean',
        description: 'Writes only. Omit to get a PREVIEW (nothing changes). Set true only after the user explicitly approved that preview, together with its preview_token.',
      };
      props.preview_token = {
        type: 'string',
        description: 'Writes only. The preview_token returned by the preview the user approved. Single use, 15 minutes; the call must repeat the previewed arguments exactly.',
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
  return [...metaTools, ...ZOMA_TOOL_DEFINITIONS.map((d) => JSON.parse(JSON.stringify(d)))];
}

/** Throws MetaToolkitRefusal when the call is outside the v1 surface. */
export function assertMetaToolkitV1Call(name: string, args: any): void {
  if (isZomaTool(name)) return;
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
