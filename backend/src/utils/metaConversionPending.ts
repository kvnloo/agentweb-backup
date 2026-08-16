/**
 * ENG-926 §C — reading the `metaConversionPending` marker on a lead.
 *
 * The marker records conversions owed to Meta that could not be queued (the async job table
 * was unreachable). It has two readers — crmDb.updateLead's opportunistic retry and the
 * reconciliation sweep — so the parsing lives here rather than in either of them: two copies
 * of "what shape is this field" is exactly how one reader ends up silently skipping rows the
 * other picks up.
 *
 * Three shapes are accepted on purpose:
 *   - a DocumentClient string set, which surfaces as `{ values: [...] }` — the current shape;
 *   - a plain array, which is what a JSON round-trip or a hand-written fixture produces;
 *   - a bare string, the scalar this field started as before a lead was found to be able to
 *     owe more than one conversion. Rows written by an earlier build still carry it, and
 *     dropping them would strand exactly the conversions the marker exists to rescue.
 */
export function parsePendingKinds(raw: unknown): string[] {
  const candidates: unknown[] = Array.isArray((raw as any)?.values)
    ? (raw as any).values
    : Array.isArray(raw)
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? [raw]
        : [];

  // Deduplicated and trimmed: a set cannot contain duplicates, but the array and legacy
  // shapes can, and dispatching the same owed conversion twice would do redundant work
  // before fire-once caught it.
  const seen = new Set<string>();
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}
