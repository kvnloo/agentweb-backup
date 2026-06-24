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

/**
 * True when the ORIGINAL token is an initials form — one or more single
 * letters separated only by dots/spaces ("P", "P.", "P.G.", "P. G.", "J.R.").
 * Such a token carries only the leading letter(s) of the name, so it must be
 * compared initial-to-initial (first letter), not as a full prefix — otherwise
 * "P.G." (→ "pg") would fail a prefix test against "paul".
 */
function isInitialsForm(token: string | undefined | null): boolean {
  const t = (token ?? '').trim();
  if (!t) return false;
  // Each whitespace-separated chunk must be a single letter optionally followed
  // by a dot (e.g. "P", "P.", "G."). Two+ such chunks, or a single one, qualify.
  return /^(?:[A-Za-z]\.?)(?:[\s]*[A-Za-z]\.?)*$/.test(t)
    && t.replace(/[^A-Za-z]/g, '').length >= 1
    && t.replace(/[^A-Za-z]/g, '').length <= 3   // initials are short; "pg", "jr", "pgw"
    && /^[A-Za-z](\.|\s|$)/.test(t);             // starts with a lone letter, not e.g. "Paul"
}

/**
 * Compare one name component (first or last) across the two sides, tolerant of
 * initials. Returns false only when the populated tokens genuinely contradict.
 *  - If either side is an initials form, match on the LEADING letter only
 *    (an initial constrains just the first letter).
 *  - Otherwise, bidirectional prefix (nicknames / truncations).
 * An empty token on either side is "no constraint".
 */
function componentMatches(aRaw: string | undefined | null, bRaw: string | undefined | null): boolean {
  const a = normalizeNameToken(aRaw);
  const b = normalizeNameToken(bRaw);
  if (!a || !b) return true;                 // no constraint on at least one side

  const aInit = isInitialsForm(aRaw);
  const bInit = isInitialsForm(bRaw);
  if (aInit || bInit) {
    // Initials constrain only the first letter (e.g. "P." / "P.G." ↔ "Paul").
    return a[0] === b[0];
  }
  return a.startsWith(b) || b.startsWith(a);
}

export function nameTokensMatch(
  aFirst: string | undefined | null,
  aLast: string | undefined | null,
  bFirst: string | undefined | null,
  bLast: string | undefined | null,
): boolean {
  return componentMatches(aFirst, bFirst) && componentMatches(aLast, bLast);
}
