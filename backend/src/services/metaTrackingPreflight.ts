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
 * Inspect served HTML for Meta pixel installs. Pure and side-effect-free.
 * Returns de-duplicated `PIXEL:<id>` labels (empty ⇒ no pixel detected).
 *
 * Note what is deliberately NOT accepted: the presence of `fbevents.js` alone. A page
 * can load the library and never call `fbq('init', …)`, which measures nothing — and
 * counting it would make this gate pass exactly the pages it exists to catch.
 */
export function detectMetaPixels(html: string): string[] {
  if (!html || typeof html !== 'string') return [];
  const found = new Set<string>();

  // fbq('init', '123456789012345') — quotes may be single or double, whitespace arbitrary.
  for (const m of html.matchAll(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{6,})['"]/gi)) {
    found.add(`PIXEL:${m[1]}`);
  }
  // The <noscript> fallback image: facebook.com/tr?id=123456789012345
  for (const m of html.matchAll(/facebook\.com\/tr\?id=(\d{6,})/gi)) {
    found.add(`PIXEL:${m[1]}`);
  }

  return [...found];
}

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

/* istanbul ignore next — network boundary; unit tests inject `fetchHtml` instead. */
async function defaultFetchHtml(url: string): Promise<string> {
  const MAX_HTML_BYTES = 5 * 1024 * 1024;
  return fetchHtmlFollowingRedirects(url, {
    get: (u: string) =>
      (axios as any).get(u, {
        timeout: 10_000,
        maxRedirects: 0,
        maxContentLength: MAX_HTML_BYTES,
        validateStatus: (s: number) => s >= 200 && s < 400,
        headers: { 'User-Agent': 'AgentWeb-TrackingPreflight/1.0' },
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
