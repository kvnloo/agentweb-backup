/**
 * ENG-2747 / ENG-2781 decision 4 (Harsha, 2026-11-03, option B): Zoma is read-only on Databricks.
 * Writes are disabled for Databricks-origin tokens until server-enforced human approval exists,
 * because an agent running inside a Databricks workflow can confirm its own previews.
 *
 * How a Databricks caller is recognised: Databricks connects to Zoma over OAuth, registering a
 * client whose redirect URI is on the customer's workspace host (documented as
 * https://<workspace-hostname>/login/oauth/http.html). Any OAuth client with a redirect URI on a
 * Databricks host is treated as Databricks-origin. `aw_` keys and Zoma device tokens carry no
 * client, so the Databricks listing must offer OAuth only.
 *
 * What a Databricks caller may call (deny-by-default):
 *   - tools in READ_ONLY_TOOLKIT_TOOLS (verified reads),
 *   - zoma_status, zoma_usage, ads_get_errors, ads_get_help_article (onboarding / local reads),
 *   - call_meta_marketing_api with a read action (LIST, GET, PREVIEW, SEARCH, GET_MATCH_QUALITY)
 *     and no confirm / preview_token.
 * Everything else, including tools added later, is refused and hidden from tools/list.
 */
import { READ_ONLY_TOOLKIT_TOOLS } from './toolkitToolAnnotations';

/** Hosts Databricks serves workspaces from (AWS, Azure, GCP). Matched as a dot-boundary suffix. */
const DATABRICKS_HOST_SUFFIXES = [
  'databricks.com', // AWS and GCP workspaces
  'azuredatabricks.net', // Azure
  'databricks.azure.cn', // Azure China
  'cloud.databricks.us', // AWS GovCloud
  'databricksapps.com', // Databricks Apps
];

const DATABRICKS_EXTRA_ALLOWED = new Set(['zoma_status', 'zoma_usage', 'ads_get_errors', 'ads_get_help_article']);

/** Same list as META_TOOLKIT_V1_ACTIONS in metaToolkitManifest.ts (kept local to avoid an import cycle). */
const MARKETING_API_READ_ACTIONS = new Set(['LIST', 'GET', 'PREVIEW', 'SEARCH', 'GET_MATCH_QUALITY']);

export function isDatabricksRedirectUri(uri: string): boolean {
  let host: string;
  try {
    host = new URL(uri).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return DATABRICKS_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export function isDatabricksClient(redirectUris: readonly string[] | null | undefined): boolean {
  return Array.isArray(redirectUris) && redirectUris.some((u) => typeof u === 'string' && isDatabricksRedirectUri(u));
}

/** True when a Databricks-origin caller may make this call. */
export function isDatabricksAllowedCall(toolName: string, args: unknown): boolean {
  if (READ_ONLY_TOOLKIT_TOOLS.has(toolName) || DATABRICKS_EXTRA_ALLOWED.has(toolName)) return true;
  if (toolName === 'call_meta_marketing_api') {
    const a = (args ?? {}) as Record<string, unknown>;
    return MARKETING_API_READ_ACTIONS.has(String(a.action ?? '')) && a.confirm === undefined && a.preview_token === undefined;
  }
  return false;
}

export const DATABRICKS_READ_ONLY_MESSAGE =
  'Zoma on Databricks is read-only: this call can change your ad account, so it is not available from Databricks. ' +
  'Reads work here. To make changes, connect Zoma directly from Claude, ChatGPT, Codex or Cursor (https://api.agentweb.pro/api/meta-toolkit/skill.md).';

type ToolSchema = { properties?: Record<string, { enum?: unknown[] } | undefined> };

/**
 * The tools a Databricks-origin caller sees: allowed tools only. call_meta_marketing_api stays,
 * narrowed to its read actions with the write-only properties removed.
 */
export function databricksToolView<T extends { name: string; description?: string; inputSchema?: unknown }>(tools: T[]): T[] {
  const out: T[] = [];
  for (const tool of tools) {
    if (READ_ONLY_TOOLKIT_TOOLS.has(tool.name) || DATABRICKS_EXTRA_ALLOWED.has(tool.name)) {
      out.push(tool);
    } else if (tool.name === 'call_meta_marketing_api') {
      const copy = JSON.parse(JSON.stringify(tool)) as T;
      const props = (copy.inputSchema as ToolSchema | undefined)?.properties;
      if (props?.action?.enum) props.action.enum = [...MARKETING_API_READ_ACTIONS];
      if (props) {
        delete props.confirm;
        delete props.preview_token;
        delete props.confirm_recent_spend;
      }
      // Narrowed to reads, so label it read-only for this caller (annotations come from the route).
      const annotated = copy as T & { annotations?: Record<string, boolean> };
      if (annotated.annotations) {
        annotated.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
      }
      copy.description = 'Meta Marketing API, read-only on Databricks. Reads: LIST, GET, PREVIEW, SEARCH, GET_MATCH_QUALITY.';
      out.push(copy);
    }
  }
  return out;
}
