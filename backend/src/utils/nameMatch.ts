/**
 * Pure name-token comparison shared by every enrichment path that needs to
 * confirm a provider's returned profile belongs to the lead it was looked up
 * for (Apollo /people/match, Unipile people-search, etc.).
 *
 * Comparison is case-insensitive, accent/punctuation-insensitive, and
 * bidirectional-prefix:
 *   - "rob" matches "robert" and vice-versa (nicknames / truncations).
 *   - "p" / "p." matches "paul" (initials, with or without a dot).
 *   - "josé" matches "jose"; "o'brien" matches "obrien" (diacritics/punctuation).
 *
 * An empty token on either side is treated as "no constraint" — the CALLER
 * decides what to do when it can't verify (trust vs reject); this helper only
 * answers "do the populated tokens contradict each other?".
 *
 * NOTE ON INITIALS: a single-letter token ("P") prefix-matches every name
 * starting with that letter ("Paul", "Peter"). This is intentional — the
 * matcher must not lose correct same-letter matches — so initials are
 * inherently low-precision. Downstream disambiguation (LLM context pick +
 * low-confidence taint) is what prevents an initials-only match from silently
 * attaching the wrong same-letter person.
 */

/**
 * Normalize a name token for comparison:
 *  - Unicode NFKD decompose + strip combining marks → drops accents
 *    (José → jose, Renée → renee).
 *  - Lowercase.
 *  - Remove every character that is not a latin letter or digit → drops dots,
 *    apostrophes, hyphens, and inner whitespace ("o'brien" → "obrien",
 *    "anne-marie" → "annemarie", "j.r." → "jr").
 * Returns '' when nothing comparable remains (e.g. a token of only punctuation),
 * which the caller treats as "no constraint" just like an originally-empty token.
 */
export function normalizeNameToken(token: string | undefined | null): string {
  return (token ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');        // drop dots, apostrophes, hyphens, spaces
}

export function nameTokensMatch(
  aFirst: string | undefined | null,
  aLast: string | undefined | null,
  bFirst: string | undefined | null,
  bLast: string | undefined | null,
): boolean {
  const af = normalizeNameToken(aFirst);
  const al = normalizeNameToken(aLast);
  const bf = normalizeNameToken(bFirst);
  const bl = normalizeNameToken(bLast);

  if (af && bf && !af.startsWith(bf) && !bf.startsWith(af)) return false;
  if (al && bl && !al.startsWith(bl) && !bl.startsWith(al)) return false;
  return true;
}
