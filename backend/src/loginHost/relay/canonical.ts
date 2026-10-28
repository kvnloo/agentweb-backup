/** ENG-2113: JSON with sorted keys, so the same value compares (and hashes) equal however its producer ordered it. Nesting deeper than MAX_DEPTH collapses to a marker (bounded work on hostile input). */
export const CANONICAL_MAX_DEPTH = 32;

export function canonicalJson(v: unknown, depth = 0): string {
  if (depth > CANONICAL_MAX_DEPTH) return '"[too deep]"';
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, depth + 1)).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined) // like JSON.stringify: an undefined member is absent
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k], depth + 1)}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
