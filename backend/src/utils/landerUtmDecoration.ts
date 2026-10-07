/**
 * landerUtmDecoration — the lander outbound-link decoration consumer of the
 * ENG-723 precedence resolver. ENG-726 (slice D of ENG-538 / ENG-327).
 *
 * Generated landers used to do nothing with UTMs. This module injects one
 * platform-owned inline script into the generated site's root layout that
 * decorates outbound links at click time.
 *
 * Why deterministic injection and not a v0 prompt instruction: the same reason
 * the capture route and tracking helper are force-injected (see
 * `injectLeadCaptureAttribution` in v0Service) — asking an LLM to author
 * attribution code is non-deterministic and only verifiable after the fact.
 *
 * Precedence is NOT re-derived here. The configured layers (per-lander override
 * and customer default) are resolved server-side by `resolveLanderParams`, the
 * single shared resolver. The browser only overlays what the resolver itself
 * would take from the visitor — the declared UTM keys and click IDs, trimmed,
 * blank meaning absent — so `visitor > override > default > absent` holds per
 * key. The test suite executes the emitted script and checks it against
 * `resolveLanderParams` for every precedence case.
 *
 * Contract points (ENG-726 acceptance criteria):
 * - AC4: `aw_lander=1` is added under its own key; no customer `utm_*` is touched.
 * - AC5: a customer with neither a default nor an override gets NOTHING injected,
 *   so link behavior is byte-identical to before this slice.
 * - AC6: output is a pure function of its inputs (canonical key order, no clock
 *   or randomness).
 *
 * A parameter already present on a destination link is never overwritten: an
 * explicitly configured destination wins, the same rule the bridge-out redirect
 * in `buildTrackingHelper` follows.
 */

import { UTM_KEYS } from "./adUtm";
import {
  CLICK_ID_KEYS,
  LANDER_PROVENANCE_KEY,
  resolveLanderParams,
  validateUtmConfig,
  type UtmConfig,
} from "./landerUtm";

export const UTM_DECORATION_START = "{/* AgentWeb UTM decoration */}";
export const UTM_DECORATION_END = "{/* End AgentWeb UTM decoration */}";

export interface LanderUtmLayers {
  override?: UtmConfig | null;
  customerDefault?: UtmConfig | null;
}

function hasAnyKey(config: UtmConfig | null | undefined, label: string): boolean {
  if (config === null || config === undefined) return false;
  return Object.keys(validateUtmConfig(config, label)).length > 0;
}

/**
 * The configured layer, resolved by the shared resolver with no visitor input.
 * Returns `null` when neither layer is configured (AC5: inject nothing).
 */
export function resolveConfiguredLanderParams(
  layers: LanderUtmLayers,
): Record<string, string> | null {
  const hasOverride = hasAnyKey(layers.override, "per-lander override");
  const hasDefault = hasAnyKey(layers.customerDefault, "customer default");
  if (!hasOverride && !hasDefault) return null;
  return resolveLanderParams({
    override: layers.override ?? undefined,
    customerDefault: layers.customerDefault ?? undefined,
  }).params;
}

/**
 * The browser script body. `configured` is the resolver's output for the stored
 * layers (including `aw_lander`). Exported for direct execution in tests.
 */
export function buildLanderUtmDecorationScript(configured: Record<string, string>): string {
  const visitorKeys = [...UTM_KEYS, ...CLICK_ID_KEYS];
  return (
    "(function(){" +
    "var C=" + JSON.stringify(configured) + ";" +
    "var V=" + JSON.stringify(visitorKeys) + ";" +
    "var P=" + JSON.stringify(LANDER_PROVENANCE_KEY) + ";" +
    "function resolve(){var s=new URLSearchParams(window.location.search);var r={};" +
    "V.forEach(function(k){var v=s.get(k);if(v!==null){v=v.trim();if(v){r[k]=v;return;}}" +
    "if(Object.prototype.hasOwnProperty.call(C,k)){r[k]=C[k];}});" +
    "r[P]=C[P];return r;}" +
    "function decorate(a){if(!a||!a.href)return;var u;try{u=new URL(a.href,window.location.href);}catch(e){return;}" +
    "if(u.protocol!=='http:'&&u.protocol!=='https:')return;" +
    "if(u.origin===window.location.origin)return;" +
    "var r=resolve();var changed=false;" +
    "Object.keys(r).forEach(function(k){if(r[k]===undefined||u.searchParams.has(k))return;u.searchParams.set(k,r[k]);changed=true;});" +
    "if(changed)a.href=u.toString();}" +
    "function onClick(e){var t=e.target;while(t&&t.nodeName!=='A'){t=t.parentNode;}if(t)decorate(t);}" +
    "document.addEventListener('click',onClick,true);" +
    "document.addEventListener('auxclick',onClick,true);" +
    "})();"
  );
}

function buildLayoutSnippet(configured: Record<string, string>): string {
  const body = buildLanderUtmDecorationScript(configured);
  // Embed as a JSON string literal inside the JSX expression — no template
  // literal, so nothing in the config can break out of the attribute.
  return (
    `        ${UTM_DECORATION_START}\n` +
    `        <script dangerouslySetInnerHTML={{ __html: ${safeJsonString(body)} }} />\n` +
    `        ${UTM_DECORATION_END}`
  );
}

function safeJsonString(s: string): string {
  return JSON.stringify(s)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const BLOCK_RE =
  /[ \t]*\{\/\* AgentWeb UTM decoration \*\/\}[\s\S]*?\{\/\* End AgentWeb UTM decoration \*\/\}\n?/g;

/** Insert (or replace, or with `null` remove) the decoration block in a layout source. */
export function injectUtmDecorationIntoLayout(
  content: string,
  configured: Record<string, string> | null,
): string {
  let updated = content.replace(BLOCK_RE, "");
  if (!configured) return updated;
  const snippet = buildLayoutSnippet(configured);
  if (/<head[^>]*>/.test(updated)) {
    updated = updated.replace(/(<head[^>]*>)/, `$1\n${snippet}`);
  } else if (/<body[^>]*>/.test(updated)) {
    updated = updated.replace(/(<body[^>]*>)/, `$1\n${snippet}`);
  } else {
    return content;
  }
  return updated;
}

/**
 * Inject decoration into the generated file set's root layout, in place.
 * Returns true when a decoration block was written. With no configured layer
 * the files are left untouched (AC5).
 */
export function injectUtmDecorationIntoLayoutFiles(
  files: Array<{ path: string; content: Buffer }>,
  layers: LanderUtmLayers,
): boolean {
  const configured = resolveConfiguredLanderParams(layers);
  if (!configured) return false;
  const layout = files.find(
    (f) => f.path === "app/layout.tsx" || f.path.endsWith("/app/layout.tsx"),
  );
  if (!layout) return false;
  const before = layout.content.toString("utf-8");
  const after = injectUtmDecorationIntoLayout(before, configured);
  if (after === before) return false;
  layout.content = Buffer.from(after, "utf-8");
  return true;
}

