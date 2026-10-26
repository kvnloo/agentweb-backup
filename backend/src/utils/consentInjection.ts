/**
 * ENG-2667 (ENG-2665 slice 2): consent banner + Google Consent Mode v2 for generated LPs.
 *
 * Pure post-processor over a root layout that has ALREADY been through the GTM / Meta Pixel /
 * Google Ads injectors. It is a no-op unless the site's attribution mode (ENG-2666) is
 * 'consent'; 'on' and 'off' sites are returned byte-identical.
 *
 * In 'consent' mode it:
 *   1. Prepends a consent-default block as the FIRST child of <head>, so
 *      `gtag('consent','default', denied…)` runs before any Google tag (GTM or Ads) loads.
 *      A returning visitor whose `aw_consent` cookie is "granted" is updated to granted
 *      immediately.
 *   2. Rewrites our own Meta Pixel block so `fbq('init')` (which sets _fbp/_fbc) is wrapped in
 *      `window.__awPixelInit` and only runs once consent is granted. The <noscript> image
 *      beacon is dropped: it would fire without consent and cannot be gated.
 *   3. Appends a small, script-rendered Accept/Reject banner before </body>. The choice is
 *      persisted in the first-party `aw_consent` cookie that the ENG-2666 middleware reads to
 *      gate aw_first_touch / aw_last_touch. The banner never touches the page's forms, so lead
 *      submission works under either choice.
 *
 * Banner copy is deliberately neutral placeholder text; final client-facing copy needs Harsha's
 * review before any client rollout (ENG-2667 AC5).
 */
/** Mirrors v0Service.AttributionCookiesMode (ENG-2666); kept local so this util stays dependency-free. */
export type AttributionCookiesMode = "on" | "off" | "consent";

export const CONSENT_COOKIE = "aw_consent";
const CONSENT_DEFAULT_START = "{/* AgentWeb Consent Default */}";
const CONSENT_DEFAULT_END = "{/* End AgentWeb Consent Default */}";
const CONSENT_BANNER_START = "{/* AgentWeb Consent Banner */}";
const CONSENT_BANNER_END = "{/* End AgentWeb Consent Banner */}";

export const CONSENT_BANNER_TEXT =
  "We use cookies to measure ad performance. Accept to allow measurement cookies, or reject to continue without them.";

const GRANTED_CHECK = `document.cookie.split('; ').indexOf('${CONSENT_COOKIE}=granted')>-1`;

function consentDefaultSnippet(): string {
  return (
    `        ${CONSENT_DEFAULT_START}\n` +
    `        <script dangerouslySetInnerHTML={{ __html: \`window.dataLayer = window.dataLayer || [];\n` +
    `function gtag(){dataLayer.push(arguments);}\n` +
    `gtag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', wait_for_update: 500 });\n` +
    `if (${GRANTED_CHECK}) { gtag('consent', 'update', { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' }); }\` }} />\n` +
    `        ${CONSENT_DEFAULT_END}`
  );
}

function consentBannerSnippet(): string {
  const text = CONSENT_BANNER_TEXT.replace(/'/g, "\\'");
  return (
    `        ${CONSENT_BANNER_START}\n` +
    `        <script dangerouslySetInnerHTML={{ __html: \`(function(){\n` +
    `function choose(v){\n` +
    `  document.cookie='${CONSENT_COOKIE}='+v+'; Path=/; Max-Age=15552000; SameSite=Lax';\n` +
    `  if (v === 'granted') {\n` +
    `    if (typeof window.gtag === 'function') { window.gtag('consent', 'update', { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' }); }\n` +
    `    if (typeof window.__awPixelInit === 'function') { window.__awPixelInit(); }\n` +
    `  }\n` +
    `  var el = document.getElementById('aw-consent-banner'); if (el) { el.remove(); }\n` +
    `}\n` +
    `if (document.cookie.split('; ').some(function(c){ return c.indexOf('${CONSENT_COOKIE}=') === 0; })) { return; }\n` +
    `var b = document.createElement('div'); b.id = 'aw-consent-banner'; b.setAttribute('role', 'dialog');\n` +
    `b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#111;color:#fff;padding:12px 16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;font:14px sans-serif';\n` +
    `var t = document.createElement('span'); t.textContent = '${text}'; b.appendChild(t);\n` +
    `[['Accept','granted'],['Reject','denied']].forEach(function(o){ var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = o[0]; btn.setAttribute('data-aw-consent', o[1]); btn.style.cssText = 'padding:6px 14px;border-radius:4px;border:1px solid #fff;background:' + (o[1] === 'granted' ? '#fff;color:#111' : 'transparent;color:#fff') + ';cursor:pointer'; btn.onclick = function(){ choose(o[1]); }; b.appendChild(btn); });\n` +
    `document.body.appendChild(b);\n` +
    `})();\` }} />\n` +
    `        ${CONSENT_BANNER_END}`
  );
}

const PIXEL_BLOCK = /\{\/\* Meta Pixel Code \*\/\}[\s\S]*?\{\/\* End Meta Pixel Code \*\/\}/g;
const PIXEL_SCRIPT_OPEN = "<script dangerouslySetInnerHTML={{ __html: `!function(f,b,e,v,n,t,s)";
const PIXEL_SCRIPT_CLOSE = "fbq('track', 'PageView');` }} />";

function deferPixelBlock(block: string): string {
  if (!block.includes(PIXEL_SCRIPT_OPEN) || !block.includes(PIXEL_SCRIPT_CLOSE)) return block;
  return block
    .replace(
      PIXEL_SCRIPT_OPEN,
      "<script dangerouslySetInnerHTML={{ __html: `window.__awPixelInit=function(){if(window.__awPixelDone)return;window.__awPixelDone=1;\n!function(f,b,e,v,n,t,s)",
    )
    .replace(
      PIXEL_SCRIPT_CLOSE,
      `fbq('track', 'PageView');};\nif (${GRANTED_CHECK}) { window.__awPixelInit(); }\` }} />`,
    )
    .replace(/[ \t]*<noscript><img[\s\S]*?<\/noscript>\n?/, "");
}

function strip(content: string, start: string, end: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`[ \\t]*${esc(start)}[\\s\\S]*?${esc(end)}\\n?`, "g"), "");
}

/**
 * Apply consent gating to a root layout. No-op (byte-identical) unless mode === 'consent'.
 * Idempotent: existing consent blocks are stripped before re-insertion, and an already
 * deferred pixel block is left as-is.
 */
export function applyConsentModeToLayout(content: string, mode: AttributionCookiesMode | undefined): string {
  if (mode !== "consent") return content;
  let out = strip(strip(content, CONSENT_DEFAULT_START, CONSENT_DEFAULT_END), CONSENT_BANNER_START, CONSENT_BANNER_END);

  out = out.replace(PIXEL_BLOCK, deferPixelBlock);

  if (/<head[^>]*>/.test(out)) {
    out = out.replace(/(<head[^>]*>)/, `$1\n${consentDefaultSnippet()}`);
  } else if (/<body[^>]*>/.test(out)) {
    out = out.replace(/(<body[^>]*>)/, `${consentDefaultSnippet()}\n      $1`);
  } else {
    return content;
  }
  if (/<\/body>/.test(out)) {
    out = out.replace(/(\s*<\/body>)/, `\n${consentBannerSnippet()}$1`);
  } else {
    return content;
  }
  return out;
}

/** Mutates app/layout.tsx in a files array; returns true when consent gating was applied. */
export function applyConsentModeToLayoutFiles(
  files: Array<{ path: string; content: Buffer }>,
  mode: AttributionCookiesMode | undefined,
): boolean {
  if (mode !== "consent") return false;
  const layout = files.find((f) => f.path === "app/layout.tsx" || f.path.endsWith("/app/layout.tsx"));
  if (!layout) return false;
  const before = layout.content.toString("utf-8");
  const after = applyConsentModeToLayout(before, mode);
  if (after === before) return false;
  layout.content = Buffer.from(after, "utf-8");
  return true;
}
