/**
 * Section-wise HTML rendering for large drafts (ENG-873).
 *
 * `create_html_file` renders a content draft into HTML with one LLM call. That
 * call has a hard per-call budget (Bedrock's 5-minute request/stream timeout),
 * and past a certain draft size a single monolithic render is all-or-nothing:
 * a 40-competitor report either finishes inside the budget or the ENTIRE
 * deliverable is lost. Prod bears that out — renders timed out at 45,000 /
 * 42,232 / 37,604 / 31,213 / 25,580 chars and succeeded at 23,010 and below.
 *
 * Above the single-pass ceiling the draft is therefore split into sections,
 * each rendered as an HTML body FRAGMENT in its own call, and the fragments are
 * assembled into one document under a single stylesheet supplied here (not by
 * the model), so sections cannot drift apart visually. Every call is well
 * inside the per-call budget, and a failure is confined to one section instead
 * of taking the whole report down.
 *
 * These helpers are deliberately pure and deterministic: the split preserves
 * every line of the draft, and the assembly step never depends on the model
 * having followed instructions (see extractHtmlFragment).
 */

import { escapeHtml } from './markdownHtmlReport';

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * The one stylesheet for an assembled document. Sections are rendered
 * independently, so their look must come from here — element selectors only, so
 * a fragment needs no class vocabulary to be styled correctly.
 */
export const CHUNKED_REPORT_STYLESHEET = `
  body { margin:0; padding:0; background-color:#f4f5f7; font-family:${FONT_STACK}; color:#1f2933; }
  .report { max-width:960px; margin:0 auto; padding:36px 30px; background-color:#ffffff; line-height:1.6; font-size:16px; }
  h1 { font-size:32px; line-height:1.2; margin:0 0 20px; color:#0f172a; }
  h2 { font-size:24px; line-height:1.3; margin:34px 0 14px; color:#0f172a; border-bottom:1px solid #e2e8f0; padding-bottom:8px; }
  h3 { font-size:20px; margin:26px 0 12px; color:#0f172a; }
  h4, h5, h6 { font-size:17px; margin:20px 0 10px; color:#0f172a; }
  p { margin:0 0 14px; }
  ul, ol { margin:0 0 14px; padding-left:24px; }
  li { margin:0 0 6px; }
  a { color:#1d4ed8; }
  blockquote { margin:0 0 16px; padding:10px 16px; border-left:4px solid #cbd5e1; background-color:#f8fafc; color:#334155; }
  hr { border:0; border-top:1px solid #e2e8f0; margin:28px 0; }
  table { width:100%; border-collapse:collapse; margin:0 0 20px; font-size:14px; }
  th { border:1px solid #dbe2ea; padding:9px 11px; background-color:#f1f5f9; text-align:left; font-weight:600; color:#0f172a; }
  td { border:1px solid #dbe2ea; padding:9px 11px; vertical-align:top; }
  code { padding:2px 5px; background-color:#eef2f7; border-radius:4px; font-family:'SFMono-Regular',Consolas,monospace; font-size:0.92em; }
  pre { margin:0 0 16px; padding:14px; background-color:#0f172a; color:#e2e8f0; border-radius:6px; overflow-x:auto; font-size:13px; }
  pre code { background:none; color:inherit; padding:0; }
  img { max-width:100%; height:auto; }
  section { margin:0; }
  @media (max-width:640px) { .report { padding:22px 16px; } table { font-size:13px; } }
`;

/** A heading line (`# ` … `### `) starts a new section. */
const SECTION_HEADING = /^\s{0,3}#{1,3}\s+\S/;
const ANY_HEADING = /^\s{0,3}#{1,6}\s+\S/;

/** A fenced code block delimiter (``` or ~~~, optionally with an info string). */
const CODE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Track whether we are inside a fenced code block while walking lines.
 *
 * A fence's contents are literal: a `# comment` line inside one is NOT a
 * heading, and a blank line inside one does NOT end a paragraph. Splitting on
 * either would hand the model half a fence and it would render the remainder as
 * ordinary prose, so both split passes below consult this.
 */
function makeFenceTracker(): (line: string) => boolean {
  let open: string | null = null;
  return (line: string): boolean => {
    const fence = CODE_FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      if (open === null) {
        open = marker;
        return true; // the opening delimiter itself is fenced content
      }
      if (marker[0] === open[0] && marker.length >= open.length) {
        open = null;
        return true; // the closing delimiter too
      }
    }
    return open !== null;
  };
}

/** Group the draft's lines into sections: a heading plus everything under it. */
function splitIntoSections(draft: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  const isFenced = makeFenceTracker();
  for (const line of draft.split('\n')) {
    const fenced = isFenced(line);
    if (!fenced && SECTION_HEADING.test(line) && current.some((l) => l.trim())) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim())) sections.push(current.join('\n'));
  return sections.map((section) => section.trim()).filter(Boolean);
}

/** Split one oversized section into paragraph-sized pieces. Never splits a line. */
function splitIntoParagraphs(section: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  const isFenced = makeFenceTracker();
  const flush = () => {
    const paragraph = current.join('\n').trim();
    if (paragraph) paragraphs.push(paragraph);
    current = [];
  };
  for (const line of section.split('\n')) {
    if (!isFenced(line) && !line.trim()) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return paragraphs;
}

/**
 * Split a draft into render chunks of at most `maxChars`, cutting only at
 * section then paragraph boundaries — never inside a line, so a table row, list
 * item or fenced block is never torn in half. A single paragraph longer than the
 * limit is emitted whole rather than damaged.
 *
 * Every non-blank line of the draft appears exactly once across the chunks, in
 * the original order: the split must never lose content, since the point of the
 * exercise is that completed research survives.
 */
export function splitDraftIntoRenderChunks(draft: string, maxChars: number): string[] {
  const normalised = String(draft ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalised) return [];
  if (!Number.isFinite(maxChars) || maxChars < 1 || normalised.length <= maxChars) {
    return [normalised];
  }

  // Sections that already fit stay atomic; oversized ones drop to paragraphs.
  const pieces: string[] = [];
  for (const section of splitIntoSections(normalised)) {
    if (section.length <= maxChars) pieces.push(section);
    else pieces.push(...splitIntoParagraphs(section));
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;
  for (const piece of pieces) {
    const added = current.length === 0 ? piece.length : currentLength + 2 + piece.length;
    if (current.length > 0 && added > maxChars) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(piece);
    currentLength = current.length === 1 ? piece.length : currentLength + 2 + piece.length;
  }
  if (current.length > 0) chunks.push(current);

  // A chunk must never end on a bare heading: that heading belongs with the
  // content it introduces, or the next section would be rendered with no idea
  // what it is about. Moving it forward can push a chunk slightly over the
  // limit, which is fine — the limit has margin under the real per-call budget.
  for (let i = 0; i < chunks.length - 1; i++) {
    const chunk = chunks[i];
    while (chunk.length > 1 && ANY_HEADING.test(chunk[chunk.length - 1]) &&
           chunk[chunk.length - 1].split('\n').length === 1) {
      chunks[i + 1].unshift(chunk.pop() as string);
    }
  }

  return chunks.filter((chunk) => chunk.length > 0).map((chunk) => chunk.join('\n\n'));
}

/**
 * Elements dropped together with everything inside them: they execute, load
 * external content, or carry their own scripting/styling context, so unwrapping
 * them and keeping the children would be worse than losing the block.
 */
const UNSAFE_CONTAINERS =
  'script|style|iframe|frame|frameset|object|embed|applet|template|noscript|svg|math|form|select|textarea|canvas|audio|video';

/**
 * Everything a report section is allowed to be made of. Anything else is
 * UNWRAPPED — the tag goes, its text stays — so a stray wrapper costs markup,
 * never content.
 */
const ALLOWED_ELEMENTS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'div', 'span',
  'section', 'article', 'header', 'footer', 'aside', 'main', 'nav',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'small', 'sup', 'sub', 'mark',
  'abbr', 'time', 'code', 'pre', 'blockquote', 'details', 'summary',
]);

const VOID_ELEMENTS = new Set(['br', 'hr', 'img', 'col', 'wbr']);

/** Attributes allowed on any element. Note the absence of class/id/style. */
const GLOBAL_ATTRIBUTES = new Set(['title', 'lang', 'dir']);

/** Per-element attributes, on top of the global ones. */
const ELEMENT_ATTRIBUTES: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  td: new Set(['colspan', 'rowspan']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  ol: new Set(['start', 'type']),
  time: new Set(['datetime']),
};

/** Attributes whose value is a URL and therefore needs a scheme check. */
const URL_ATTRIBUTES = new Set(['href', 'src']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':',
  tab: '\t', newline: '\n', sol: '/',
};

/** Decode the entity forms a browser would resolve before acting on a URL. */
function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});?/g, (_m, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[String(name).toLowerCase()] ?? m);
}

/**
 * Allow only schemes that cannot execute. Entities and control characters are
 * resolved first, because `java&#115;cript:` and `java\tscript:` are both
 * `javascript:` by the time the browser follows the link.
 */
function isSafeUrl(value: string): boolean {
  const url = decodeEntities(value).replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase();
  if (!url) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(url);
  return scheme ? /^(https?|mailto|tel)$/.test(scheme[1]) : true;
}

/**
 * Escape an attribute value without double-encoding entities the model already
 * wrote — a QuickChart config arrives full of `&amp;`, and re-escaping it would
 * put a literal "&amp;" in the URL and break the chart.
 */
function escapeAttributeValue(value: string): string {
  return value
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]{1,31};|#\d{1,7};|#x[0-9a-fA-F]{1,6};)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ATTRIBUTE_TOKEN =
  /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

function sanitizeAttributes(element: string, raw: string): string {
  const allowed = ELEMENT_ATTRIBUTES[element];
  let out = '';
  ATTRIBUTE_TOKEN.lastIndex = 0;
  let attribute: RegExpExecArray | null;
  while ((attribute = ATTRIBUTE_TOKEN.exec(raw)) !== null) {
    const name = attribute[1].toLowerCase();
    const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? '';
    // `on*` is re-checked here even though no handler is on any allowlist:
    // this is the one rule that must not depend on the lists staying correct.
    if (name.startsWith('on')) continue;
    if (!GLOBAL_ATTRIBUTES.has(name) && !allowed?.has(name)) continue;
    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value)) continue;
    out += ` ${name}="${escapeAttributeValue(value)}"`;
  }
  return out;
}

/**
 * Quote-aware, so a `>` inside an attribute value does not end the tag early.
 *
 * A bare `<` is excluded from the unquoted run: without that, `<a<b<c ` repeated
 * makes every `<` scan the rest of the input for a `>` that never comes — 4s of
 * blocked event loop on 56K of it. Anything that fails to match here is escaped
 * as text below, so failing fast cannot let markup through.
 */
const TAG_TOKEN = /<(\/)?([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'<])*)>/g;

/** Escape text that sits between tags: a `<` here is not a tag we recognised. */
function escapeTextNode(text: string): string {
  return text.replace(/</g, '&lt;');
}

/**
 * Remove HTML comments by scanning rather than by regex: `<!--` repeated without
 * a terminator makes a lazy `[\s\S]*?` rescan the tail from every marker (1.7s
 * on 60K chars). An unterminated marker drops only itself — whatever follows is
 * sanitised as ordinary content.
 */
function stripComments(html: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const start = html.indexOf('<!--', cursor);
    if (start === -1) return out + html.slice(cursor);
    out += html.slice(cursor, start);
    const end = html.indexOf('-->', start + 4);
    // No terminator left in the string means none for any later marker either,
    // so drop the remaining markers in one pass instead of re-scanning the tail
    // from each of them.
    if (end === -1) return out + html.slice(start + 4).split('<!--').join('');
    cursor = end + 3;
  }
}

/**
 * Rebuild the fragment from an allowlist of elements and attributes.
 *
 * A section's HTML is model output derived from scraped research, and the
 * assembled document is uploaded and served as text/html — so it must not be
 * able to carry an event handler, an active element or a `javascript:` URL into
 * the reader's browser. Every surviving tag and attribute is re-emitted from
 * this function, so nothing reaches the page that was not explicitly allowed.
 */
function sanitizeFragmentHtml(fragment: string): string {
  // Comments and the doctype first: a comment can hide markup, and neither
  // belongs in a body fragment. Anything else declaration-shaped (`<![CDATA[`,
  // `<?xml`) is left to be escaped as text — it is not a tag, so it cannot
  // introduce markup, and scanning for its terminator is what turns a stream of
  // unterminated `<!` into quadratic work.
  let html = stripComments(fragment).replace(/<!doctype[^>]{0,200}>/gi, '');

  // Executable/active containers go with their content. Repeated because one
  // pass leaves the inner element of a nested pair behind. The attribute run is
  // bounded so a run of unterminated openers cannot rescan the whole fragment
  // each time; an opener too long to match is unwrapped by the allowlist below.
  const container = new RegExp(`<(${UNSAFE_CONTAINERS})\\b[^>]{0,1000}>[\\s\\S]*?<\\/\\1\\s*>`, 'gi');
  for (let pass = 0; pass < 3; pass++) {
    const stripped = html.replace(container, '');
    if (stripped === html) break;
    html = stripped;
  }

  let out = '';
  let cursor = 0;
  TAG_TOKEN.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = TAG_TOKEN.exec(html)) !== null) {
    out += escapeTextNode(html.slice(cursor, tag.index));
    cursor = TAG_TOKEN.lastIndex;
    const name = tag[2].toLowerCase();
    if (!ALLOWED_ELEMENTS.has(name)) continue; // unwrap: drop the tag, keep the text
    if (tag[1]) {
      if (!VOID_ELEMENTS.has(name)) out += `</${name}>`;
      continue;
    }
    const attributes = sanitizeAttributes(name, tag[3]);
    out += VOID_ELEMENTS.has(name) ? `<${name}${attributes} />` : `<${name}${attributes}>`;
  }
  return out + escapeTextNode(html.slice(cursor));
}

/**
 * Reduce whatever the model returned for one section to a SAFE body fragment.
 *
 * The prompt asks for a fragment, but the assembly must not depend on that: a
 * model that returns a whole document, wraps it in a code fence, or emits its
 * own <style>/<script> would otherwise produce a broken, self-conflicting or
 * unsafe page. The output is rebuilt from an allowlist (see
 * sanitizeFragmentHtml), which also keeps one section from restyling — or
 * scripting — the rest of the report.
 */
export function extractHtmlFragment(modelOutput: string): string {
  let html = String(modelOutput ?? '').trim();
  if (!html) return '';

  // ```html … ``` fence
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(html);
  if (fenced) html = fenced[1].trim();

  const body = /<body[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html);
  if (body) {
    html = body[1];
  } else {
    html = html
      .replace(/<head[^>]*>[\s\S]*?<\/head\s*>/gi, '')
      .replace(/<\/?html[^>]*>/gi, '');
  }

  return sanitizeFragmentHtml(html).trim();
}

/** Assemble rendered section fragments into one self-contained document. */
export function assembleChunkedHtmlDocument(title: string, fragments: string[]): string {
  const safeTitle = escapeHtml(String(title ?? '').trim() || 'Report');
  const body = fragments
    .map((fragment) => String(fragment ?? '').trim())
    .filter(Boolean)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
<style>${CHUNKED_REPORT_STYLESHEET}</style>
</head>
<body>
<div class="report">
${body}
</div>
</body>
</html>`;
}
