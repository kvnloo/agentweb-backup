/**
 * adUtm — single source of truth for the UTM parameters Emma stamps onto the
 * destination URLs of ads it deploys (Meta / Google / LinkedIn). ENG-239.
 *
 * The key set is a contract, not a preference: the lead-capture middleware that
 * `v0Service.injectLeadCaptureAttribution` writes into every generated landing
 * page reads only `utm_source|medium|campaign|content|term`. Emit anything else
 * and it is dropped on arrival with no error.
 *
 * `utm_content` is meant to carry the ad ID, which does not exist until after
 * the ad is created. Meta and Google both solve this with click-time macros
 * (`{{ad.id}}`, `{creative}`) that the platform resolves on each click, so macro
 * values must reach the platform un-encoded — percent-encoding the braces breaks
 * resolution. LinkedIn has no macro support, so it ships without `utm_content`.
 */

export type AdPlatform = "meta" | "google" | "linkedin";

/**
 * Exactly the keys the injected landing-page middleware parses, in the order we
 * emit them. Kept in sync with `v0Service.injectLeadCaptureAttribution`.
 */
export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export type UtmKey = (typeof UTM_KEYS)[number];

/**
 * ENG-239's acceptance criteria mandate `utm_medium=paid`.
 *
 * Caveat worth knowing: GA4's default channel grouping keys on `cpc` / `ppc` /
 * `paidsearch`, so `paid` lands in Unassigned rather than Paid Search / Paid
 * Social. Our own attribution is unaffected (the CRM stores the medium verbatim),
 * and reports keyed on source/medium pairs still work. If that ruling changes,
 * flipping this constant is the entire fix.
 */
export const UTM_MEDIUM_PAID = "paid";

/**
 * `utm_source` value per platform.
 *
 * Null-prototype: a plain object literal would resolve `PLATFORM_SOURCE["constructor"]`
 * to a truthy function via the prototype chain, sneaking past the guard in
 * `buildUtmSpec` and stringifying `function Object()` into a live ad's URL.
 */
const PLATFORM_SOURCE: Record<AdPlatform, string> = Object.assign(Object.create(null), {
  meta: "meta",
  google: "google",
  linkedin: "linkedin",
});

/**
 * A platform macro, resolved by the ad platform at click time:
 * Meta `{{ad.id}}` / `{{campaign.id}}`, Google ValueTrack `{creative}` / `{campaignid}`.
 * These pass through un-encoded; everything else is percent-encoded.
 */
const MACRO_RE = /^\{\{[A-Za-z0-9_.]+\}\}$|^\{[A-Za-z0-9_]+\}$/;

export interface UtmSpec {
  source: string;
  medium: string;
  campaign: string;
  content?: string;
  term?: string;
}

/**
 * Build the UTM spec for one platform.
 *
 * `campaign` and `content` may be literal values or platform macros; the caller
 * chooses, because only the caller knows which macros its platform resolves.
 * LinkedIn drops `content` outright — it resolves no macros, and the ad ID is
 * unknown at create time.
 */
export function buildUtmSpec(
  platform: AdPlatform,
  opts: { campaign: string; content?: string; term?: string },
): UtmSpec {
  const source = PLATFORM_SOURCE[platform];
  if (!source) {
    throw new Error(`adUtm: unsupported platform "${platform}"`);
  }
  const campaign = opts.campaign?.trim();
  if (!campaign) {
    throw new Error("adUtm: campaign is required and cannot be empty");
  }

  const spec: UtmSpec = { source, medium: UTM_MEDIUM_PAID, campaign };
  // LinkedIn cannot resolve an ad ID at create time and supports no macros.
  if (platform !== "linkedin" && opts.content?.trim()) {
    spec.content = opts.content.trim();
  }
  if (opts.term?.trim()) {
    spec.term = opts.term.trim();
  }
  return spec;
}

/** Parse a URL, or throw with a message callers can surface. */
function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`adUtm: invalid URL "${url}"`);
  }
}

/**
 * The UTM keys already present on `url`.
 *
 * Matching is case-insensitive so that a user-supplied `UTM_Source=...` still
 * counts as "the user set this" (AC4) and we do not append a near-duplicate —
 * even though the landing-page middleware itself only reads the lowercase form.
 */
export function existingUtmKeys(url: string): Set<UtmKey> {
  const parsed = parseUrl(url);
  const present = new Set<UtmKey>();
  for (const rawKey of parsed.searchParams.keys()) {
    const lower = rawKey.toLowerCase() as UtmKey;
    if ((UTM_KEYS as readonly string[]).includes(lower)) {
      present.add(lower);
    }
  }
  return present;
}

/** Macros pass through verbatim; real values are percent-encoded. */
function encodeValue(value: string): string {
  return MACRO_RE.test(value) ? value : encodeURIComponent(value);
}

/** The spec as `[key, value]` pairs, in `UTM_KEYS` order, skipping unset keys. */
function specEntries(spec: UtmSpec): Array<[UtmKey, string]> {
  const byKey: Record<UtmKey, string | undefined> = {
    utm_source: spec.source,
    utm_medium: spec.medium,
    utm_campaign: spec.campaign,
    utm_content: spec.content,
    utm_term: spec.term,
  };
  return UTM_KEYS.flatMap((key) => {
    const value = byKey[key];
    return value ? ([[key, value]] as Array<[UtmKey, string]>) : [];
  });
}

/**
 * Render the spec as a query string, for platforms that take one as a dedicated
 * field: Meta's `url_tags`, Google's `finalUrlSuffix`. Both append it to the
 * destination URL at delivery.
 *
 * Pass the destination URL's existing UTM keys as `omit` so the platform does
 * not append a second copy of a key the user already set (AC4). Returns `""`
 * when everything is omitted — callers should then skip the write entirely
 * rather than setting an empty field.
 */
export function utmQueryString(spec: UtmSpec, omit: ReadonlySet<string> = new Set()): string {
  return specEntries(spec)
    .filter(([key]) => !omit.has(key))
    .map(([key, value]) => `${key}=${encodeValue(value)}`)
    .join("&");
}

/**
 * Append the spec's UTM params to `url`, per-key.
 *
 * AC4 — "user-provided destination URLs that already contain UTMs are respected,
 * not overwritten" — is implemented as a per-key merge: a key the user set is
 * left exactly as-is, and only the keys they did not set are added. A URL that
 * already carries every key comes back byte-identical.
 *
 * The original string is preserved (rather than round-tripped through `URL`) so
 * that existing encoding and any fragment survive untouched.
 */
export function mergeUtmIntoUrl(url: string, spec: UtmSpec): string {
  const existing = existingUtmKeys(url); // also validates the URL
  const additions = specEntries(spec)
    .filter(([key]) => !existing.has(key))
    .map(([key, value]) => `${key}=${encodeValue(value)}`);

  if (additions.length === 0) return url;

  const hashIndex = url.indexOf("#");
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : url.slice(hashIndex);

  // A bare trailing "?" is a valid empty query. Appending "&" after it would emit
  // `?&utm_source=...`, which strict URL validators on the ad platforms reject.
  const queryIndex = base.indexOf("?");
  const separator = queryIndex === -1 ? "?" : queryIndex === base.length - 1 ? "" : "&";

  return `${base}${separator}${additions.join("&")}${fragment}`;
}
