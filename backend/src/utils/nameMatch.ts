/**
 * Pure name-token comparison shared by every enrichment path that needs to
 * confirm a provider's returned profile belongs to the lead it was looked up
 * for (Apollo /people/match, Unipile people-search, etc.).
 *
 * Comparison is case-insensitive and bidirectional-prefix: "rob" matches
 * "robert" and vice-versa, so nicknames / truncations don't cause false
 * rejects. An empty token on either side is treated as "no constraint" — the
 * CALLER decides what to do when it can't verify (trust vs reject); this helper
 * only answers "do the populated tokens contradict each other?".
 */
export function nameTokensMatch(
  aFirst: string | undefined | null,
  aLast: string | undefined | null,
  bFirst: string | undefined | null,
  bLast: string | undefined | null,
): boolean {
  const af = (aFirst ?? '').trim().toLowerCase();
  const al = (aLast ?? '').trim().toLowerCase();
  const bf = (bFirst ?? '').trim().toLowerCase();
  const bl = (bLast ?? '').trim().toLowerCase();

  if (af && bf && !af.startsWith(bf) && !bf.startsWith(af)) return false;
  if (al && bl && !al.startsWith(bl) && !bl.startsWith(al)) return false;
  return true;
}
