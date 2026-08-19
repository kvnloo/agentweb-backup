/**
 * ENG-926 §B — normalisation of the CAPI `user_data` fields we hash.
 *
 * A match happens only when our SHA-256 equals the SHA-256 Meta computed from the same
 * person's data on their side. Normalisation is therefore a wire contract: any divergence
 * costs a match silently, with no error raised anywhere and nothing in our own data that
 * looks wrong.
 *
 * The rules below were READ OFF Meta's own `fbevents.js` rather than interpreted from its
 * documentation. The library was loaded in a clean browser against a dummy pixel id, real
 * values were passed to `fbq('init', …)`, and the request it produced carries both the
 * resulting hash and an `ncud[…]` mask of the normalised value (letters `*`, digits `#`).
 * Reading those masks answered the questions the prose does not:
 *
 *   "O'Brien-Smith"      -> ***********   punctuation dropped
 *   "  van der  BERG  "  -> **********    ALL whitespace dropped, not just the ends
 *   "MacDonald 3rd"      -> *********#**  digits kept
 *   "José"               -> ***~          accent preserved, NOT folded to ASCII
 *   "07911123456"        -> ##########    leading zero dropped
 *
 * Every one of those inputs is pinned by hash in `metaUserDataNormalisation.test.ts`. If
 * Meta ever changes its rules, those tests fail with the exact field and value — which is
 * the only way this class of drift becomes visible at all.
 *
 * ⚠ Do NOT "tidy" these into one shared routine. `em` deliberately keeps `.`/`+`/`@`
 * because stripping them changes the address, `ph` deliberately keeps digits only, and
 * `fn`/`ln` deliberately drop everything that is not alphanumeric. They look similar and
 * are not.
 */

export type NormalisableUserDataField = 'em' | 'ph' | 'fn' | 'ln';

/**
 * Normalise one `user_data` value exactly as Meta does, ready for hashing.
 *
 * Returns `''` for anything unusable. Callers MUST treat empty as "no value" and omit the
 * field: hashing an empty string yields a real, constant hash that Meta would accept as if
 * it identified a person, quietly polluting match rates with a value shared by every
 * customer who left that field blank.
 */
export function normaliseUserDataField(
  field: NormalisableUserDataField,
  raw: string | null | undefined,
): string {
  if (typeof raw !== 'string') return '';

  switch (field) {
    case 'em':
      // Only trim and lowercase. The local part is significant: `.`, `+` and `@` are part
      // of the address, and removing them would hash a different mailbox entirely.
      return raw.trim().toLowerCase();

    case 'ph':
      // Digits only, then drop leading zeros — a national dialling prefix, so "07911123456"
      // and "7911123456" reach the same hash. This does NOT add a missing country code:
      // no user locale is available here, so a number entered without one still
      // under-matches. That is a data-quality gap, not something normalisation can repair,
      // and guessing a country would corrupt numbers that are currently correct.
      return raw.replace(/[^0-9]/g, '').replace(/^0+/, '');

    case 'fn':
    case 'ln':
      // Lowercase, then drop everything that is not a letter or a digit — punctuation AND
      // whitespace, including whitespace inside the name. Accented letters survive because
      // they are letters; folding them to ASCII would break every non-English name that
      // matches today.
      //
      // `\p{L}` and `\p{N}` (with the `u` flag) rather than `[a-z0-9]`, so this is a
      // statement about letters and digits generally rather than about English.
      return [...raw.toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');

    default:
      return '';
  }
}
