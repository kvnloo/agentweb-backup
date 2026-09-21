import sanitizeHtml from 'sanitize-html';

// ENG-1997 — createHtmlFile (and its render/passthrough/fallback branches),
// plus the sibling update_html_file / CSS-selector editor, have no fixed
// {{variable}} template to escape values into the way createHtmlFromTemplate
// does (ENG-1877): the model authors or edits the document directly, so
// blanket HTML-escaping the output would mangle the real markup these tools
// exist to produce. Instead this parses the finished document and strips only
// the constructs that can execute script or hijack the page, regardless of
// where in the document — or which tool — they came from:
//   - <script> tags, except a bare `<script src="...">` (no inline body)
//     pointing at the allowlisted Chart.js CDN path — needed for the option
//     createHtmlFile's own prompt documents.
//   - Any `on*` event-handler attribute, on any tag.
//   - `srcdoc` on any tag (iframe in practice). sanitize-html serializes its
//     value with normal attribute entity-escaping, which is correct for an
//     ordinary attribute but not sufficient here: browsers HTML-decode an
//     attribute value during normal parsing regardless of which attribute it
//     is, and then treat a decoded `srcdoc` specifically as a nested HTML
//     document to parse and render — so an entity-escaped `&lt;script&gt;`
//     re-materializes as a live `<script>` the moment the page loads. This is
//     a well-known sanitizer-bypass class; there is no safe value to allow
//     through, so the attribute is dropped outright rather than filtered.
//   - `<base>` tags — rewrites the resolution of every relative URL/asset in
//     the document; no legitimate use in a generated report/email.
//   - `<meta http-equiv="refresh">` tags — auto-navigates the page to
//     whatever URL is in `content`, and sanitize-html's scheme allowlist
//     (which blocks `javascript:`/`data:` elsewhere) doesn't apply to `meta`'s
//     `content` attribute at all, since it isn't a URL-typed attribute to the
//     library. Evergreen browsers happen to refuse to navigate a meta-refresh
//     to those schemes today, but this tool also renders emails through the
//     same sanitizer, where client/WebView behavior is far less consistent —
//     no legitimate use for it here either way.
//   - `<style>` tags and `style=` attributes containing `@import` or a
//     non-`data:` `url(...)` — sanitize-html does not parse CSS at all, and
//     unrestricted `@import`/`url()` is a live cross-origin fetch triggered
//     just by rendering the page (exfiltration / phishing-overlay vector).
//     Legitimate report styling never needs an external stylesheet, so a
//     match drops the whole tag/attribute rather than trying to edit the CSS.
//   - `javascript:`/unlisted URL schemes in href/src/etc. (sanitize-html's
//     default scheme allowlist already excludes `javascript:`).
// Everything else (structure, tables, images, inline color/spacing CSS)
// passes through unchanged.

const ALLOWED_SCRIPT_HOSTNAME = 'cdn.jsdelivr.net';
const ALLOWED_SCRIPT_PATH_PREFIX = '/npm/chart.js@';
const SUSPICIOUS_CSS = /@import\b|url\s*\(\s*["']?(?!data:)/i;

function isAllowedScriptTag(attribs: Record<string, string>, text: string): boolean {
  const src = attribs?.src;
  if (!src || text.trim().length > 0) return false;
  try {
    const url = new URL(src);
    return url.hostname === ALLOWED_SCRIPT_HOSTNAME && url.pathname.startsWith(ALLOWED_SCRIPT_PATH_PREFIX);
  } catch {
    return false;
  }
}

function stripDangerousAttribs(tagName: string, attribs: Record<string, string>) {
  const cleaned: Record<string, string> = {};
  for (const [name, value] of Object.entries(attribs)) {
    if (/^on/i.test(name) || name.toLowerCase() === 'srcdoc') continue;
    if (name.toLowerCase() === 'style' && SUSPICIOUS_CSS.test(value)) continue;
    cleaned[name] = value;
  }
  return { tagName, attribs: cleaned };
}

export function sanitizeGeneratedHtml(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return html;
  // sanitize-html unconditionally drops the <!DOCTYPE> directive (it isn't a
  // taggable node its allowlist model can express) — every document this tool
  // produces opens with one, and losing it silently pushes the browser into
  // quirks mode. It carries no attacker-controlled content, so re-attach the
  // original verbatim rather than lose it.
  const doctypeMatch = html.match(/^\s*<!doctype[^>]*>/i);
  const sanitized = sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    transformTags: {
      '*': stripDangerousAttribs,
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === 'script') return !isAllowedScriptTag(frame.attribs, frame.text);
      if (frame.tag === 'base') return true;
      if (frame.tag === 'meta') return typeof frame.attribs?.['http-equiv'] === 'string' && frame.attribs['http-equiv'].toLowerCase() === 'refresh';
      if (frame.tag === 'style') return SUSPICIOUS_CSS.test(frame.text);
      return false;
    },
  });
  return doctypeMatch ? doctypeMatch[0] + sanitized : sanitized;
}
