/**
 * Session-tracking SDK tag injection for generated landing pages (ENG-2327).
 *
 * Adds `<script src="<BACKEND_URL>/sdk/v1/aw.js" data-aw-list="<listId>" async>` to a page, in one of
 * two shapes:
 *   - a Next.js root layout (`app/layout.tsx`)  -> JSX block, delimited by `{/* ... *\/}` comments
 *   - a static HTML page (`public/*.html`)       -> HTML block, delimited by `<!-- ... -->` comments
 *
 * Same safety properties as gtmInjection.ts, and one more: an injector that does not understand the
 * file's shape THROWS a SessionTrackingInjectionError rather than guessing, so the caller can never
 * commit a corrupted file. Pure and dependency-free, so the manual route, the Emma tool and the
 * auto-at-generation path emit byte-identical output.
 *
 *   - idempotent: our own block is always stripped before re-inserting (never duplicates)
 *   - anchored: the block is inserted only after an opening <head ...> (or <body ...> / <html ...>)
 *     tag matched with a word boundary, so `<header>` is never mistaken for `<head>`
 *   - refuses a page that ALREADY carries a tracker (an SDK tag of ours placed by hand, or a bespoke
 *     tracker writing `aw_sess_` rows): a second tracker double-counts every visit
 *   - self-checking: stripping our block from the output must give back the stripped input exactly
 */

/** A real layout is a few KB; GitHub's Contents API caps a file at 1MB. Same bail-out as gtmInjection. */
const MAX_LAYOUT_SIZE_BYTES = 500_000;
const MAX_HTML_SIZE_BYTES = 900_000;

export type SessionTrackingErrorCode =
  | 'existing_tracker'
  | 'unsupported_shape'
  | 'too_large'
  | 'invalid_list_id'
  | 'invalid_sdk_url';

export class SessionTrackingInjectionError extends Error {
  constructor(public readonly code: SessionTrackingErrorCode, message: string) {
    super(message);
    this.name = 'SessionTrackingInjectionError';
  }
}

export type SessionTrackingTarget = 'layout' | 'html';

/** Where the SDK is served from. BACKEND_URL is deployment config, never request input. */
export function sdkScriptUrl(): string {
  const base = (process.env.BACKEND_URL || 'https://api.agentweb.pro').replace(/\/+$/, '');
  return `${base}/sdk/v1/aw.js`;
}

/**
 * The flag for automatic enablement at generation. Default OFF; `true` or `1` turns it on. Lives here
 * (a dependency-free module) so the generation path can check it synchronously, with no import and no
 * await, and flag-off generation is therefore byte-for-byte the code path it was before ENG-2327.
 */
export function isAutoSessionTrackingEnabled(): boolean {
  const v = String(process.env.AUTO_SESSION_TRACKING ?? '').trim().toLowerCase();
  return v === 'true' || v === '1';
}

const LIST_ID_RE = /^[A-Za-z0-9_-]{6,80}$/;
// The src goes into source code we commit: nothing that could close the attribute or the JSX expression.
const SDK_URL_RE = /^https?:\/\/[A-Za-z0-9.:\-]+(\/[A-Za-z0-9._\-/]*)?$/;

const BLOCK_LABEL = 'AgentWeb Session Tracking';
const MARKERS: Record<SessionTrackingTarget, { start: string; end: string }> = {
  layout: { start: `{/* ${BLOCK_LABEL} */}`, end: `{/* End ${BLOCK_LABEL} */}` },
  html: { start: `<!-- ${BLOCK_LABEL} -->`, end: `<!-- End ${BLOCK_LABEL} -->` },
};
const BLOCK_CAPTURE_RE: Record<SessionTrackingTarget, RegExp> = {
  layout: /\{\/\* AgentWeb Session Tracking \*\/\}[\s\S]*?\{\/\* End AgentWeb Session Tracking \*\/\}/g,
  html: /<!-- AgentWeb Session Tracking -->[\s\S]*?<!-- End AgentWeb Session Tracking -->/g,
};

/**
 * Signatures of a tracker that is NOT our managed block: the SDK tag (by attribute or URL) or the
 * session-row id prefix a bespoke tracker writes. Matched against the content with our own block
 * removed, so re-running on a page we already tagged is not mistaken for a foreign tracker.
 */
const FOREIGN_TRACKER_PATTERNS: Array<[string, RegExp]> = [
  ['data-aw-list', /data-aw-list/],
  ['aw_sess_', /aw_sess_/],
  ['/sdk/v1/aw.js', /\/sdk\/v1\/aw\.js/],
];

/**
 * Remove every complete start..end block, plus the indentation before it and the newline after it.
 * indexOf-based (linear) on purpose: a `[ \t]*` regex prefix is quadratic on a long run of spaces.
 * A start marker with no end marker is left in place (and then counts as a foreign tracker).
 */
function stripOurBlocks(content: string, target: SessionTrackingTarget): string {
  const { start, end } = MARKERS[target];
  let out = '';
  let from = 0;
  for (;;) {
    const s = content.indexOf(start, from);
    if (s === -1) break;
    const e = content.indexOf(end, s + start.length);
    if (e === -1) break;
    let lineStart = s;
    while (lineStart > from && (content[lineStart - 1] === ' ' || content[lineStart - 1] === '\t')) lineStart--;
    out += content.slice(from, lineStart);
    from = e + end.length;
    if (content[from] === '\n') from++;
  }
  return out + content.slice(from);
}

/** The signature of a pre-existing tracker on the page (outside our managed block), or null. */
export function findExistingTracker(content: string, target: SessionTrackingTarget): string | null {
  const rest = stripOurBlocks(content, target);
  for (const [label, re] of FOREIGN_TRACKER_PATTERNS) if (re.test(rest)) return label;
  return null;
}

/** The list id carried by our managed block, or null when the page has none (or has several). */
export function extractInstalledListId(content: string, target: SessionTrackingTarget): string | null {
  const blocks = content.match(BLOCK_CAPTURE_RE[target]) ?? [];
  if (blocks.length !== 1) return null;
  const m = /data-aw-list="([^"]*)"/.exec(blocks[0]);
  return m ? m[1] : null;
}

function buildBlock(target: SessionTrackingTarget, listId: string, src: string, indent: string): string {
  if (target === 'layout') {
    return (
      `${indent}{/* ${BLOCK_LABEL} */}\n` +
      `${indent}<script src="${src}" data-aw-list="${listId}" async />\n` +
      `${indent}{/* End ${BLOCK_LABEL} */}`
    );
  }
  return (
    `${indent}<!-- ${BLOCK_LABEL} -->\n` +
    `${indent}<script src="${src}" data-aw-list="${listId}" async></script>\n` +
    `${indent}<!-- End ${BLOCK_LABEL} -->`
  );
}

const squash = (s: string): string => s.replace(/\s+/g, '');

const HEAD_OPEN = /<head(?:\s[^>]*)?>/i;
const BODY_OPEN = /<body(?:\s[^>]*)?>/i;
const HTML_OPEN = /<html(?:\s[^>]*)?>/i;

/** `$1` insertion that keeps the following text on its own line without ever adding a blank one. */
function insertAfter(content: string, re: RegExp, block: string): string {
  return content.replace(re, (open, offset: number) => {
    const next = content.charAt(offset + open.length);
    return `${open}\n${block}${next === '\n' || next === '\r' ? '' : '\n'}`;
  });
}

function assertNotForeign(content: string, target: SessionTrackingTarget, override: boolean): void {
  if (override) return;
  const found = findExistingTracker(content, target);
  if (found) {
    throw new SessionTrackingInjectionError(
      'existing_tracker',
      `This page already carries its own tracker (found "${found}"). Adding the AgentWeb session tag would ` +
        'count every visit twice, so nothing was changed. Pass overrideExistingTracker only if you have ' +
        'confirmed the existing tracker is being removed.',
    );
  }
}

/** Checked BEFORE any regex runs: `[ \t]*` in the block pattern is quadratic on a long run of spaces. */
function assertSize(content: string, target: SessionTrackingTarget): void {
  const cap = target === 'layout' ? MAX_LAYOUT_SIZE_BYTES : MAX_HTML_SIZE_BYTES;
  if (content.length > cap) {
    throw new SessionTrackingInjectionError('too_large', `file is larger than ${cap} bytes; refusing to edit it`);
  }
}

function validate(listId: string): string {
  if (!LIST_ID_RE.test(listId)) {
    throw new SessionTrackingInjectionError('invalid_list_id', `not a valid session list id: "${String(listId).slice(0, 40)}"`);
  }
  const src = sdkScriptUrl();
  // The tag is committed into a customer's public https page: a plain-http (mixed content) or malformed
  // SDK origin would ship a tag that never loads. http is accepted for loopback only (local development).
  if (!SDK_URL_RE.test(src) || (src.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(src))) {
    throw new SessionTrackingInjectionError('invalid_sdk_url', 'BACKEND_URL does not produce a safe SDK script URL (it must be this API\'s https origin)');
  }
  return src;
}

/**
 * Inject (or strip, when `listId` is "") the session-tracking block in a Next.js root layout.
 * Throws SessionTrackingInjectionError for a foreign tracker, an oversized file, or a layout with no
 * <head>/<body> to anchor on. Removal never throws on a foreign tracker (it only removes our block).
 */
export function injectSessionTrackingIntoLayout(
  currentContent: string,
  listId: string,
  opts: { overrideExistingTracker?: boolean } = {},
): string {
  assertSize(currentContent, 'layout');
  const stripped = stripOurBlocks(currentContent, 'layout');
  if (!listId) return stripped;

  const src = validate(listId);
  assertNotForeign(currentContent, 'layout', !!opts.overrideExistingTracker);

  const block = buildBlock('layout', listId, src, '        ');
  let out: string;
  const head = HEAD_OPEN.exec(stripped);
  const headSelfClosing = !!head && /\/\s*>$/.test(head[0]);
  if (head && headSelfClosing) {
    // `<head />` (or `<head className="x" />`): expand it into an open/close pair around our block.
    out = stripped.replace(head[0], `<head>\n${block}\n      </head>`);
  } else if (head) {
    out = insertAfter(stripped, HEAD_OPEN, block);
  } else if (BODY_OPEN.test(stripped)) {
    // No <head> in the layout: first child of <body> (a plain async script is valid anywhere in it).
    out = insertAfter(stripped, BODY_OPEN, block);
  } else {
    throw new SessionTrackingInjectionError(
      'unsupported_shape',
      'app/layout.tsx has no <head> or <body> tag to anchor the tracking tag on, so nothing was changed.',
    );
  }
  // Self-check: removing our block from the output must give back what we started from, ignoring
  // whitespace (a flush `<head><x/>` gains a line break). The `<head />` expansion is the one deliberate
  // structural edit and is checked by verify below.
  if (!headSelfClosing && squash(stripOurBlocks(out, 'layout')) !== squash(stripped)) {
    throw new SessionTrackingInjectionError('unsupported_shape', 'layout edit did not round-trip; refusing to modify it');
  }
  if (!verifySessionTrackingInjection(out, 'layout', listId)) {
    throw new SessionTrackingInjectionError('unsupported_shape', 'tracking tag could not be placed in app/layout.tsx');
  }
  return out;
}

/**
 * Inject (or strip, when `listId` is "") the session-tracking block in a static HTML page: inside
 * <head>, else a new <head> under <html>, else before <body>. A fragment with none of those is refused.
 */
export function injectSessionTrackingIntoHtml(
  currentContent: string,
  listId: string,
  opts: { overrideExistingTracker?: boolean } = {},
): string {
  assertSize(currentContent, 'html');
  const stripped = stripOurBlocks(currentContent, 'html');
  if (!listId) return stripped;

  const src = validate(listId);
  assertNotForeign(currentContent, 'html', !!opts.overrideExistingTracker);

  const block = buildBlock('html', listId, src, '    ');
  let out: string;
  let createdHead = false;
  if (HEAD_OPEN.test(stripped)) {
    out = insertAfter(stripped, HEAD_OPEN, block);
  } else if (HTML_OPEN.test(stripped)) {
    createdHead = true;
    out = stripped.replace(HTML_OPEN, (open) => `${open}\n  <head>\n${block}\n  </head>`);
  } else if (BODY_OPEN.test(stripped)) {
    out = stripped.replace(BODY_OPEN, (open) => `${block}\n${open}`);
  } else {
    throw new SessionTrackingInjectionError(
      'unsupported_shape',
      'This HTML file has no <head>, <html> or <body> tag to anchor the tracking tag on, so nothing was changed.',
    );
  }
  if (!createdHead && squash(stripOurBlocks(out, 'html')) !== squash(stripped)) {
    throw new SessionTrackingInjectionError('unsupported_shape', 'HTML edit did not round-trip; refusing to modify it');
  }
  if (!verifySessionTrackingInjection(out, 'html', listId)) {
    throw new SessionTrackingInjectionError('unsupported_shape', 'tracking tag could not be placed in the HTML file');
  }
  return out;
}

/**
 * Verify that the injection actually reflects `listId`, rather than trusting that a string splice
 * worked. `listId` non-empty => exactly ONE block, carrying exactly that list id and the SDK URL,
 * placed after an opening <head>/<body>/<html> tag (or, in a body-only HTML page, right before <body>). `listId` "" => no block remains.
 */
export function verifySessionTrackingInjection(content: string, target: SessionTrackingTarget, listId: string): boolean {
  const blocks = content.match(BLOCK_CAPTURE_RE[target]) ?? [];
  if (!listId) return blocks.length === 0;
  if (blocks.length !== 1) return false;
  const block = blocks[0];
  if (!block.includes(`data-aw-list="${listId}"`) || !block.includes('/sdk/v1/aw.js')) return false;
  const at = content.indexOf(block);
  const anchor = content.search(/<(?:head|body|html)(?:\s[^>]*)?>/i);
  if (anchor !== -1 && anchor < at) return true;
  // A static page with only a <body> gets the block immediately before it.
  return target === 'html' && content.slice(at + block.length).search(/^\s*<body(?:\s[^>]*)?>/i) !== -1;
}
