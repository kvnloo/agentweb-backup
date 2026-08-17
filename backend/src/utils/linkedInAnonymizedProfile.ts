/**
 * Detecting LinkedIn's anonymized out-of-network profiles (ENG-1198 follow-up).
 *
 * When a search or profile lookup crosses a network boundary LinkedIn will not
 * reveal, Unipile returns the record with `public_identifier` set to the literal
 * four-letter string `"undefined"` — not null, not absent. That string is truthy,
 * so every naive `identifier ? buildUrl(identifier) : null` builds
 * `https://www.linkedin.com/in/undefined`, a URL that resolves to nothing and
 * belongs to nobody.
 *
 * ENG-1198 fixed three call sites independently and left three copies of the same
 * literal comparison behind. This is that comparison, once, so a fourth site can't
 * quietly get it wrong — and so the *other* half stays covered: Unipile also sends
 * its own `public_profile_url` already built from that same bad identifier, which a
 * check on the identifier alone never sees.
 */

/** The sentinel Unipile uses for a profile it will not identify. */
const ANONYMIZED_IDENTIFIER = 'undefined';

/**
 * True when this `public_identifier` is LinkedIn's anonymized placeholder rather
 * than a real profile slug.
 */
export function isAnonymizedIdentifier(publicIdentifier: unknown): boolean {
  return publicIdentifier === ANONYMIZED_IDENTIFIER;
}

/**
 * True when this URL is the fabricated `/in/undefined` profile link.
 *
 * Needed alongside the identifier check because Unipile populates
 * `public_profile_url` itself, so a caller that falls back to that field recreates
 * the fake URL even after correctly rejecting the identifier it came from.
 */
export function isFabricatedProfileUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  return /\/in\/undefined\/?$/i.test(stripUrlSuffix(url));
}

/**
 * Strip query AND fragment. Splitting on '?' alone leaves '#about' attached, which
 * pushes the path off the end of the anchored match and lets a fabricated URL
 * through.
 */
function stripUrlSuffix(url: string): string {
  return url.split('?')[0].split('#')[0].trim();
}

/**
 * A usable profile slug, or null. Collapses both failure shapes — the anonymized
 * sentinel and an absent value — into the one thing callers should branch on.
 */
export function usablePublicIdentifier(publicIdentifier: unknown): string | null {
  if (typeof publicIdentifier !== 'string') return null;
  const trimmed = publicIdentifier.trim();
  if (!trimmed || isAnonymizedIdentifier(trimmed)) return null;
  return trimmed;
}

/** A usable profile URL, or null — rejecting the fabricated `/in/undefined` form. */
export function usableProfileUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const cleaned = stripUrlSuffix(url);
  if (!cleaned || isFabricatedProfileUrl(cleaned)) return null;
  return cleaned;
}
