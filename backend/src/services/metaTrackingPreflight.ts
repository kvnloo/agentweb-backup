/**
 * Deterministic pre-flight tracking gate for Meta campaign launches (ENG-941).
 *
 * Before a Meta campaign, ad set or ad goes ACTIVE, every destination it points at
 * must be *measurable*: the served HTML has to carry a Meta pixel, and that pixel
 * has to be one the launching ad account actually owns. Spending on a destination
 * that structurally cannot report a conversion is blocked by default.
 *
 * The pixel-identity half matters as much as presence. RankAI churned with ~$5.2k
 * spent and zero conversion signal (ENG-443), and `hireemma.ai` ran with a pixel on
 * the page that the campaign's ad account did not own (§16 of the ENG-885 handoff).
 * A naive "is there any tracking?" check passes both. Comparing the detected pixel
 * against the account's own pixels is what makes this gate mean something.
 *
 * Mirrors googleAdsTrackingPreflight.ts (ENG-335) deliberately rather than inventing
 * a second pattern: pure, no LLM, no model judgement, with fetching behind a
 * mockable boundary so the whole gate is unit-testable with the network stubbed.
 * The SSRF-safe manual redirect follower is imported from that module rather than
 * duplicated — one copy of that security-sensitive logic, not two.
 *
 * v1 SPA caveat, inherited from ENG-335: a destination that injects its pixel only
 * client-side can false-negative here, because we inspect the served HTML rather
 * than executing the page. That is why the explicit override path exists.
 */
import axios from 'axios';
import { assertPublicHostname } from '../utils/ssrfGuard';
import { fetchHtmlFollowingRedirects } from './googleAdsTrackingPreflight';

export type MetaUrlTrackingStatus = 'measured' | 'unmeasured' | 'unverifiable';

export interface MetaUrlTrackingResult {
  url: string;
  status: MetaUrlTrackingStatus;
  /** Labelled pixels detected in the served HTML, e.g. `PIXEL:1012387921717047`. */
  mechanisms: string[];
  /** Human-readable list of what was looked for (constant, for messaging/audit). */
  checkedFor: string[];
  /** Populated only when status === 'unverifiable' (fetch failed / non-2xx / timeout). */
  error?: string;
}

export interface MetaPreflightGateResult {
  /** True only when every checked destination is 'measured' (or there were none). */
  ok: boolean;
  results: MetaUrlTrackingResult[];
  /** Destinations that are 'unmeasured' or 'unverifiable' — i.e. why a launch is blocked. */
  blockedUrls: MetaUrlTrackingResult[];
  /** Human-readable explanation naming each blocked destination and what was checked. */
  message: string;
}

export interface MetaPreflightDeps {
  /** Injectable fetch boundary. Must resolve to the served HTML or throw on failure. */
  fetchHtml?: (url: string) => Promise<string>;
}

/** The measurement mechanisms this gate recognises (surfaced to users verbatim). */
export const META_TRACKING_MECHANISMS: string[] = [
  'Meta pixel base code (fbq init)',
  'Meta pixel noscript fallback (facebook.com/tr?id=…)',
];

/**
 * Remove the parts of a JavaScript source that never execute: comments, and string or
 * template literals whose *content* is itself pixel-shaped text.
 *
 * Restricting the scan to executable `<script>` blocks (the previous narrowing) still
 * counted an install snippet a page merely *displays* — `// fbq('init', …)` left behind by
 * a migration, or `var snippet = "fbq('init', …)"` rendered into a help page. Both sit in
 * a live script and neither ever runs.
 *
 * Written as a single-pass scanner rather than another regex because the two constructs
 * nest: a comment can contain a quote, a string can contain a comment marker, and no
 * regex reads that correctly (three regex passes each narrowed the hole without closing
 * it). String literals that do NOT contain an fbq call are preserved verbatim, because a
 * genuine install carries its pixel id in exactly such a literal — dropping all literals
 * would delete the id this function exists to read.
 *
 * Failure direction is deliberate: an exotic construct this scanner misreads (a regex
 * literal containing an unbalanced quote, say) can only cause text to be dropped, which
 * yields "no pixel found" — a block. Failing toward a block is the same choice the rest
 * of the gate makes.
 *
 * Known residual, stated rather than implied: an `fbq('init', …)` inside a dead branch
 * (`if (false) { … }`) is real, parseable code and still reads as an install. Answering
 * that needs an executor, not a parser, and it is not an accident mode — it requires
 * someone to deliberately write unreachable pixel code on their own landing page.
 */
export function stripInertJavaScript(src: string): string {
  /*
   * Deliberately broader than what `beaconPixelId` accepts. This half only decides whether a
   * literal is DOCUMENTATION rather than code, and the two must not drift: matching
   * `tr?id=` while the beacon parser accepts `id` in any query position left a reordered URL
   * (`tr?ev=PageView&id=…`) surviving here and counted as an install there. Whenever one
   * half accepts more than the other recognises, the difference is a bypass — so this one
   * takes any facebook.com/tr reference, and over-stripping only ever costs a block.
   */
  const isInert = (body: string) => /fbq\s*\(/i.test(body) || /facebook\.com\/tr\b/i.test(body);
  /*
   * A `/` starts a regex literal only where an expression may begin; after a value it is
   * division. Deciding on the previous significant character keeps `total / 2` and
   * `(a + b) / 2` as arithmetic — treating those as regexes would swallow live code up to
   * the next slash, which is how a scrubber starts causing false blocks.
   */
  const REGEX_START_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n']);
  /*
   * A regex can also follow a KEYWORD (`return /…/`, `typeof /…/`, `case /…/`), where the
   * previous significant character is a plain letter and the set above says "division".
   * Matched on a word boundary so an identifier merely ENDING in a keyword (`myreturn / 2`)
   * stays arithmetic — mis-reading that would swallow the live code after it.
   */
  const REGEX_START_AFTER_KEYWORD = /\b(return|typeof|instanceof|case|in|of|do|else|void|delete|new|yield|await|throw)$/;
  /*
   * `)` is the genuinely ambiguous one: `(a + b) / 2` is division, but `if (x) /re/.test(s)`
   * is a regex. What separates them is the word before the OPENING paren, so each `(` is
   * pushed onto a stack recording whether it opened a control clause, and the matching `)`
   * pops it. Guessing either way without that context breaks real code — as division it
   * leaves inert patterns readable as installs, as regex it swallows live code.
   */
  const CONTROL_KEYWORD = /\b(if|for|while|switch|catch|with)$/;
  const parenStack: boolean[] = [];
  let lastClosedParenWasControl = false;
  let prevSignificant = '';
  let sinceLineStart = '';
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '(') parenStack.push(CONTROL_KEYWORD.test(sinceLineStart.trimEnd()));
    else if (c === ')') lastClosedParenWasControl = parenStack.pop() === true;
    const regexPosition =
      REGEX_START_AFTER.has(prevSignificant) ||
      REGEX_START_AFTER_KEYWORD.test(sinceLineStart.trimEnd()) ||
      (prevSignificant === ')' && lastClosedParenWasControl);
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && regexPosition) {
      // A regex literal is real code, but a PATTERN never initializes a pixel — matching
      // `fbq('init', …)` is in fact what a consent-manager or a scanner does. Dropped
      // wholesale rather than inspected: there is no case where keeping one adds signal.
      let j = i + 1;
      let inClass = false;
      let terminated = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) { terminated = true; break; }
        j++;
      }
      if (terminated) {
        out += ' ';
        prevSignificant = ' ';
        sinceLineStart += ' ';
        i = j + 1;
        continue;
      }
      // Unterminated on this line — not a regex after all; fall through and treat as a
      // plain character rather than swallowing the rest of the file.
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      prevSignificant = '\n';
      sinceLineStart = '';
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let body = '';
      while (j < src.length) {
        if (src[j] === '\\') { body += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        if (src[j] === c) break;
        // An unterminated single-line string is a mis-parse (most often an apostrophe in
        // text this scanner reached anyway). Stop at the newline so the rest of the file
        // is still scanned normally instead of being swallowed to EOF.
        if (c !== '`' && src[j] === '\n') break;
        body += src[j];
        j++;
      }
      const closed = j < src.length && src[j] === c;
      out += isInert(body) ? ' ' : c + body + (closed ? c : '');
      // A string is a VALUE, so a `/` after it is division, never a regex.
      prevSignificant = c;
      sinceLineStart += c;
      i = closed ? j + 1 : j;
      continue;
    }
    out += c;
    if (c === '\n' || !/\s/.test(c)) prevSignificant = c;
    sinceLineStart = c === '\n' ? '' : sinceLineStart + c;
    i++;
  }
  return out;
}

/**
 * Inspect served HTML for Meta pixel installs. Pure and side-effect-free.
 * Returns de-duplicated `PIXEL:<id>` labels (empty ⇒ no pixel detected).
 *
 * Note what is deliberately NOT accepted: the presence of `fbevents.js` alone. A page
 * can load the library and never call `fbq('init', …)`, which measures nothing — and
 * counting it would make this gate pass exactly the pages it exists to catch.
 */
/**
 * The pixel id of a Meta beacon request, or undefined.
 *
 * Substring matching counted any URL that merely CONTAINED `facebook.com/tr?id=<pixel>` —
 * a proxy or redirect carrying it as a query parameter, a lookalike path on someone else's
 * CDN — as an install, when no request reaches Meta at all. The src is parsed and its host
 * checked, so what counts is where the browser actually sends the request.
 *
 * An unparseable src yields nothing, which reads as "no pixel found" — a block. That is the
 * direction this whole gate fails in.
 */
function beaconPixelId(src: string): string | undefined {
  if (!src) return undefined;
  let parsed: URL;
  try {
    // Base covers protocol-relative (`//www.facebook.com/tr`) and relative srcs alike; a
    // relative one can never be a Meta beacon, and its host will not match below.
    parsed = new URL(src.trim(), 'https://relative.invalid');
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return undefined;
  if (!/^\/tr\/?$/.test(parsed.pathname)) return undefined;
  const id = parsed.searchParams.get('id') ?? '';
  return /^\d{6,}$/.test(id) ? id : undefined;
}

/**
 * Parse a tag's attribute string into name → value.
 *
 * Anchoring a regex at `type=` or `src=` inside the raw tag text kept binding to the wrong
 * thing — first `data-src`, then serialized markup inside another attribute's VALUE, then
 * metadata mentioning `type="text/javascript"` ahead of the real `type="text/template"`.
 * Consuming each value as a unit makes all of those unreachable by construction, which no
 * amount of anchoring on a flat string can achieve. First occurrence wins, matching how a
 * browser treats a duplicated attribute.
 */
function parseTagAttributes(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (attrs || '').matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/**
 * The script types a browser actually executes.
 *
 * Substring matching was the bug: `text/javascript-template` and
 * `application/javascript+handlebars` both CONTAIN "javascript" while being templates a
 * browser never runs. Per the HTML spec an unrecognised type is not executed at all, so
 * this is an exact allowlist with any `;charset=…` parameter trimmed off.
 */
function isExecutableScriptType(type: string): boolean {
  const bare = type.split(';')[0].trim().toLowerCase();
  return (
    bare === 'module' ||
    bare === 'text/javascript' ||
    bare === 'application/javascript' ||
    bare === 'text/ecmascript' ||
    bare === 'application/ecmascript' ||
    bare === 'text/jscript' ||
    bare === 'application/x-javascript'
  );
}

export function detectMetaPixels(html: string): string[] {
  if (!html || typeof html !== 'string') return [];
  const found = new Set<string>();

  /*
   * Strip places where pixel-shaped text is documentation rather than an install:
   * HTML comments (including commented-out snippets left behind by a migration) and
   * escaped/`<code>`/`<pre>` blocks, which is how a page ends up "measured" merely by
   * explaining how to install a pixel. A commented-out pixel measures nothing, and
   * counting it would pass exactly the page this gate exists to catch.
   */
  html = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    /*
     * `<template>` joins code/pre/textarea for a different reason worth stating: its
     * contents ARE parsed as markup, but they are inert until cloned — no image inside one
     * is ever requested, and no script inside one ever runs. A component library shipping a
     * pixel snippet in a template would otherwise read as an install on every page.
     */
    .replace(/<(code|pre|textarea|template|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    /*
     * A <script> nested in <noscript> runs only when scripting is DISABLED — never, for the
     * browsers a paid campaign's traffic actually arrives in. Emptied rather than dropping
     * the whole container, because <noscript> is also where the legitimate <img> beacon
     * lives: stripping it wholesale would delete the very fallback this gate accepts.
     */
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, block =>
      block.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' '))
    // Escaped script blocks: strip the WHOLE block, not just its escaped tags. Removing only
    // `&lt;script&gt;` leaves the fbq call between them looking like a live install, which is
    // precisely how a docs page explaining pixel setup would read as measured.
    .replace(/&lt;script[\s\S]*?&lt;\/script&gt;/gi, ' ')
    .replace(/&lt;[\s\S]{0,400}?&gt;/g, ' ');

  /*
   * An `fbq('init', …)` only measures anything if it EXECUTES, so look for it inside
   * executable <script> blocks rather than anywhere in the document. Scanning the whole
   * page treats prose, JSON config and JS string literals as an install — the "inert pixel
   * text" false pass. Blocks with a `type` that is not JavaScript (text/template,
   * application/json, text/x-handlebars) are markup or data, never executed, so they are
   * excluded too.
   */
  const executable: string[] = [];
  /*
   * Each script block is rewritten in place: an executable one keeps only its code that
   * actually runs (comments and inert literals stripped), a non-executable one is emptied.
   * Rewriting rather than only collecting matters for the `<noscript>` scan below, which
   * runs over the whole document — otherwise a tracking URL sitting in a JS string would
   * still be counted there after being correctly discarded here.
   */
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_full, attrs: string, body: string) => {
    // All three attribute-value forms, not just the quoted one: `<script type=text/template>`
    // is valid HTML, and matching only quoted values read it as executable.
    const parsed = parseTagAttributes(attrs);
    const type = parsed.get('type')?.toLowerCase();
    // A script with a `src` loads the external file and its inline content is ignored
    // ENTIRELY by the browser, whatever the type says — so a snippet written between those
    // tags never runs. (The external file itself is out of reach here: this gate reads the
    // served HTML rather than following and executing every script it references.)
    if (parsed.has('src')) return '<script></script>';
    if (type && !isExecutableScriptType(type)) return '<script></script>';
    const live = stripInertJavaScript(body);
    executable.push(live);
    return `<script>${live}</script>`;
  });

  for (const m of executable.join('\n').matchAll(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{6,})['"]/gi)) {
    found.add(`PIXEL:${m[1]}`);
  }
  /*
   * The <noscript> fallback, which measures by REQUESTING an image:
   *   <img src="https://www.facebook.com/tr?id=123456789012345&ev=PageView"/>
   *
   * Matched only as an actual `<img>` source, never as free text. Scanning the whole
   * document counted a page that merely mentions the URL — a link to it, a support article
   * quoting it, a dashboard printing it — as an install, which is the same inert-text false
   * pass the script scan above exists to prevent, one element type over.
   */
  /*
   * The tag's attributes are walked rather than pattern-matched against the raw tag text.
   * Anchoring on `src=` inside the tag kept binding to the wrong thing: first `data-src`
   * (a word boundary sits inside it), then serialized markup like
   * `data-doc='example src="…"'`, where the match landed INSIDE another attribute's value.
   * Consuming each value as a unit makes embedded text unreachable by construction, which a
   * position-anchored regex over the same string cannot be.
   *
   * Only a real `src` counts: it is the attribute the browser actually requests, and a
   * beacon URL anywhere else is documentation that fires nothing.
   */
  for (const tag of html.matchAll(/<img\b([^>]*)>/gi)) {
    const id = beaconPixelId(parseTagAttributes(tag[1]).get('src') ?? '');
    if (id) found.add(`PIXEL:${id}`);
  }

  return [...found];
}

/**
 * Request headers for the destination fetch.
 *
 * A BROWSER user-agent, matching `googleAdsTrackingPreflight` deliberately rather than by
 * accident — this file previously sent `AgentWeb-TrackingPreflight/1.0`, which is the exact
 * mistake that module's own note was written to avoid:
 *
 *   "a custom bot UA is far more likely to be handed a WAF/bot-challenge page (no tracking
 *    snippet ⇒ a false 'unmeasured' block on a legitimately-tracked landing page)"
 *
 * That applies with more force here, because THIS gate blocks launches on that verdict — so
 * the bot UA was costing real false blocks — and ENG-926 §G's daily check reuses this same
 * fetcher, where the same false reading would page a human every morning.
 *
 * We want the HTML a genuine visitor is served. `Accept-*` mirror a normal navigation for
 * the same reason. Exported so the choice is pinned by a test rather than living only inside
 * an istanbul-ignored network boundary, where a refactor could silently revert it.
 */
export const PREFLIGHT_FETCH_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** How many destinations to fetch at once. Bounded: fast enough for a launch, polite to the site. */
const FETCH_CONCURRENCY = 5;

/**
 * Destinations a browser pixel can never live on, so blocking them would be a false block.
 *
 * A Meta campaign can point at a deep link or an app store listing, where measurement runs
 * through the Meta SDK or app events rather than a page pixel. Fetching `whatsapp://…` is
 * meaningless, and an App Store page is someone else's HTML we could never instrument.
 * These are skipped — not passed as measured, simply not treated as web destinations this
 * gate can speak about. Campaigns whose ONLY destinations are these end up with nothing to
 * check, which is the same "nothing serving" case the gate already lets through.
 */
function isUnmeasurableByDesign(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true; // not a URL at all — nothing to fetch
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  return APP_STORE_HOSTS.has(host);
}

/** App-store destinations measure through app events, never a page pixel. */
const APP_STORE_HOSTS = new Set([
  'apps.apple.com',
  'itunes.apple.com',
  'play.google.com',
  'apps.microsoft.com',
]);

/** Strip the `PIXEL:` label back to a bare id for comparison against the account's pixels. */
function pixelIds(mechanisms: string[]): string[] {
  return mechanisms.map(m => m.replace(/^PIXEL:/, ''));
}

/**
 * The guarded fetcher this gate uses when a caller injects nothing.
 *
 * EXPORTED so §G's per-run URL cache can wrap THIS rather than substitute its own — the
 * redirect follower and `assertPublicHostname` SSRF guard must stay in the path. A cache that
 * called `axios` directly would be a quiet way to lose both.
 */
/* istanbul ignore next — network boundary; unit tests inject `fetchHtml` instead. */
export async function defaultFetchHtml(url: string): Promise<string> {
  const MAX_HTML_BYTES = 5 * 1024 * 1024;
  return fetchHtmlFollowingRedirects(url, {
    get: (u: string) =>
      (axios as any).get(u, {
        timeout: 10_000,
        maxRedirects: 0,
        maxContentLength: MAX_HTML_BYTES,
        validateStatus: (s: number) => s >= 200 && s < 400,
        headers: PREFLIGHT_FETCH_HEADERS,
        responseType: 'text',
      }),
    assertPublic: assertPublicHostname,
  });
}

/**
 * Check every destination a launch would send paid traffic to.
 *
 * @param urls            Destination URLs (creative `link_url`s). Duplicates are fetched once.
 * @param accountPixelIds Pixel ids owned by the launching ad account. Empty ⇒ nothing on this
 *                        account could ever receive a conversion, so every destination blocks.
 */
export async function preflightMetaTrackingGate(
  urls: string[],
  accountPixelIds: string[],
  deps: MetaPreflightDeps = {},
): Promise<MetaPreflightGateResult> {
  const fetchHtml = deps.fetchHtml ?? defaultFetchHtml;
  const ownedPixels = new Set((accountPixelIds ?? []).filter(Boolean).map(String));

  const unique = [...new Set((urls ?? []).filter((u): u is string => typeof u === 'string' && u.trim() !== ''))]
    .filter(u => !isUnmeasurableByDesign(u));

  /*
   * Checked with bounded concurrency rather than one at a time. A campaign with twenty ads
   * would otherwise mean twenty sequential fetches at a 10s timeout each — minutes of
   * latency on a launch, which is its own kind of failure. Bounded rather than unbounded so
   * a large campaign can't open fifty sockets at once against a customer's site.
   */
  const results: MetaUrlTrackingResult[] = [];
  for (let i = 0; i < unique.length; i += FETCH_CONCURRENCY) {
    const batch = unique.slice(i, i + FETCH_CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (url): Promise<MetaUrlTrackingResult> => {
        try {
          const html = await fetchHtml(url);
          const mechanisms = detectMetaPixels(html);
          const onPage = pixelIds(mechanisms);
          // Measured requires BOTH: a pixel is installed, and at least one installed pixel
          // belongs to the account paying for the traffic.
          const measured = onPage.length > 0 && onPage.some(id => ownedPixels.has(id));
          return {
            url,
            status: measured ? 'measured' : 'unmeasured',
            mechanisms,
            checkedFor: META_TRACKING_MECHANISMS,
          };
        } catch (err: any) {
          return {
            url,
            status: 'unverifiable',
            mechanisms: [],
            checkedFor: META_TRACKING_MECHANISMS,
            error: err?.message || String(err),
          };
        }
      }),
    );
    results.push(...settled);
  }

  const blockedUrls = results.filter(r => r.status !== 'measured');
  const ok = blockedUrls.length === 0;

  return { ok, results, blockedUrls, message: buildMessage(blockedUrls, ownedPixels) };
}

/**
 * Explain the block in terms someone can act on: which destination, what we looked for,
 * what we found instead, and — the case people misread most often — that a pixel *was*
 * present but belongs to a different account.
 */
function buildMessage(blocked: MetaUrlTrackingResult[], ownedPixels: Set<string>): string {
  if (blocked.length === 0) return '';

  const owned = [...ownedPixels];
  const lines = blocked.map(r => {
    if (r.status === 'unverifiable') {
      return `  • ${r.url} — could not verify (${r.error}). Treated as unmeasured rather than assumed working.`;
    }
    const onPage = pixelIds(r.mechanisms);
    if (onPage.length === 0) {
      return `  • ${r.url} — no Meta pixel found in the served HTML.`;
    }
    return (
      `  • ${r.url} — found pixel ${onPage.join(', ')}, which this ad account does not own. ` +
      `Conversions would be reported to a pixel the campaign cannot optimise against.`
    );
  });

  const accountLine = owned.length
    ? `This ad account's pixel(s): ${owned.join(', ')}.`
    : `This ad account has no Meta pixel at all, so no destination can report a conversion to it. Create a pixel in Meta Events Manager first.`;

  return (
    `Launch blocked: paid Meta traffic would go to ${blocked.length} destination(s) that cannot report conversions.\n` +
    `${lines.join('\n')}\n` +
    `${accountLine}\n` +
    `Checked for: ${META_TRACKING_MECHANISMS.join('; ')}.\n` +
    `Fix the tracking, or relaunch with an explicit tracking-check override if this destination is measured in a way this check cannot see (e.g. a client-side-only install).`
  );
}
