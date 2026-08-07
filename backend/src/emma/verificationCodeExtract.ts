/**
 * ENG-795: pure text helpers for pulling a login/verification code (or a magic
 * link) out of an email body.
 *
 * Kept free of I/O so the parsing rules — which are where this class of feature
 * actually breaks — can be tested exhaustively. The failure mode that matters is
 * NOT "no code found": it is confidently returning the WRONG six digits (an
 * order id, a date, a number lifted out of a URL), because the agent then types
 * it into a login form and the run dies with a useless "invalid code".
 */

/** Characters some senders interleave into a code so scrapers can't read it. */
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;

const NAMED_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

/** Words that sit next to the real code in practically every code email. */
const CODE_KEYWORDS = [
  'verification code',
  'verify code',
  'login code',
  'security code',
  'one-time',
  'one time',
  'passcode',
  'otp',
  'code',
  'verify',
  'verification',
  'sign in',
  'signin',
  'login',
  'pin',
];

/** A link in a code email that is never the magic link. */
const LINK_DENY_MARKERS = [
  'unsubscribe',
  'privacy',
  'terms',
  'preferences',
  'opt-out',
  'optout',
  'mailto:',
  '/help',
  'support.',
  'twitter.com',
  'linkedin.com',
  'facebook.com',
];

/** A link in a code email that plausibly IS the magic link. */
const LINK_ALLOW_MARKERS = [
  'token=',
  'code=',
  'key=',
  'magic',
  '/verify',
  'verify?',
  '/confirm',
  'confirm?',
  '/auth',
  'auth/',
  'signin',
  'sign-in',
  'login',
];

export interface ExtractCodeOptions {
  /** Number of characters in the code. Defaults to 6. */
  codeLength?: number;
  /** Accept letter+digit codes (e.g. "A1B2C3") instead of digits only. */
  alphanumeric?: boolean;
}

export interface ExtractLinkOptions {
  /**
   * Only accept links served by this host or a subdomain of it (e.g. "rankai.ai").
   * Matched against the parsed hostname, never as a substring of the URL — an
   * attacker controls their own path and query, so `evil.com/?ref=rankai.ai`
   * would otherwise pass an origin check.
   */
  allowedHost?: string;
}

/**
 * Flatten an HTML email body to plain text.
 *
 * Tags become whitespace rather than being deleted, so `<td>12</td><td>3456</td>`
 * cannot fuse into the six-digit "123456" that then looks exactly like a code.
 */
export function htmlToText(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return '';

  let text = input
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  for (const [entity, replacement] of Object.entries(NAMED_ENTITIES)) {
    text = text.split(entity).join(replacement);
  }

  // Numeric entities (&#8203; and friends) — decoded, then zero-width stripped,
  // so a code padded with invisible characters reassembles into one token.
  text = text.replace(/&#(\d+);/g, (_m, dec: string) => {
    const code = Number(dec);
    return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ' ';
  });
  text = text.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
    const code = parseInt(hex, 16);
    return Number.isFinite(code) && code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : ' ';
  });

  return text.replace(ZERO_WIDTH, '').replace(/[ \t]+/g, ' ');
}

/**
 * Strip the things that produce false-positive codes, then rejoin codes the
 * sender spaced out for readability ("3 6 6 9 9 0").
 */
function normalizeForCodeScan(body: string): string {
  const text = htmlToText(body)
    // Digits inside a URL are a path segment or an id, never the code the user types.
    .replace(/https?:\/\/\S+/gi, ' ')
    // Dates and clock times, in the formats that appear in email footers.
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/g, ' ')
    .replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');

  // Only runs of SINGLE digits are rejoined — "12 3456" stays two numbers.
  return text.replace(/(?:\d[ \t]){2,}\d/g, (match) => match.replace(/[ \t]/g, ''));
}

/** Index of the nearest code-keyword occurrence to `position`, or null if none. */
function distanceToNearestKeyword(lowerText: string, position: number): number | null {
  let best: number | null = null;
  for (const keyword of CODE_KEYWORDS) {
    let from = lowerText.indexOf(keyword);
    while (from !== -1) {
      const distance = Math.abs(from - position);
      if (best === null || distance < best) best = distance;
      from = lowerText.indexOf(keyword, from + 1);
    }
  }
  return best;
}

/**
 * Pull the verification code out of an email body, or null when nothing in it
 * is confidently a code. Null is a correct, useful answer — the caller reports
 * "no code yet" rather than typing a guess.
 */
export function extractVerificationCode(body: string, options: ExtractCodeOptions = {}): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;

  const codeLength = options.codeLength ?? 6;
  if (!Number.isInteger(codeLength) || codeLength < 3 || codeLength > 12) return null;

  const text = normalizeForCodeScan(body);
  const lowerText = text.toLowerCase();

  const pattern = options.alphanumeric
    ? new RegExp(`(?<![A-Za-z0-9])[A-Z0-9]{${codeLength}}(?![A-Za-z0-9])`, 'g')
    : new RegExp(`(?<![0-9])[0-9]{${codeLength}}(?![0-9])`, 'g');

  const candidates: Array<{ value: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[0];
    // In alphanumeric mode a pure word ("VERIFY", "UPDATE") is not a code.
    if (options.alphanumeric && !/[0-9]/.test(value)) continue;
    candidates.push({ value, index: match.index });
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].value;

  // Several plausible numbers: the one closest to "code"/"verification"/… wins.
  let best = candidates[0];
  let bestDistance = distanceToNearestKeyword(lowerText, best.index);
  for (const candidate of candidates.slice(1)) {
    const distance = distanceToNearestKeyword(lowerText, candidate.index);
    if (distance === null) continue;
    if (bestDistance === null || distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best.value;
}

/** Every URL in the body — href attributes first (they keep their full query). */
function collectUrls(body: string): string[] {
  const urls: string[] = [];

  const hrefPattern = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(body)) !== null) urls.push(match[1]);

  const barePattern = /https?:\/\/[^\s"'<>]+/gi;
  while ((match = barePattern.exec(body)) !== null) urls.push(match[0]);

  return urls
    .map((url) => url.split('&amp;').join('&').replace(/[.,;)\]]+$/, '').trim())
    .filter((url) => /^https?:\/\//i.test(url));
}

/**
 * Pull the sign-in link out of a magic-link email. Returns null rather than a
 * best guess — an unsubscribe link opened as a login link silently unsubscribes
 * the account, which is worse than reporting that no link was found.
 */
export function extractMagicLink(body: string, options: ExtractLinkOptions = {}): string | null {
  if (typeof body !== 'string' || body.length === 0) return null;

  const allowedHost = options.allowedHost?.toLowerCase().trim();

  for (const url of collectUrls(body)) {
    const lower = url.toLowerCase();
    if (LINK_DENY_MARKERS.some((marker) => lower.includes(marker))) continue;

    if (allowedHost) {
      let hostname: string;
      try {
        hostname = new URL(url).hostname.toLowerCase();
      } catch {
        continue;
      }
      // Host equality or a subdomain — never a substring of the whole URL.
      if (hostname !== allowedHost && !hostname.endsWith(`.${allowedHost}`)) continue;
    }

    if (!LINK_ALLOW_MARKERS.some((marker) => lower.includes(marker))) continue;
    return url;
  }
  return null;
}
