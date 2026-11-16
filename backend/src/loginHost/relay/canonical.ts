import { createHash } from "crypto";

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

/**
 * sha256 of the FULL canonical form (keys sorted, undefined members absent) with NO depth collapse: two values that differ only deep down differ. Iterative (an
 * explicit work stack), so a value nested past the call stack hashes fine and never throws. For identity checks (idempotency), not for display.
 */
export function canonicalDigest(value: unknown): string {
  const hash = createHash("sha256");
  const work: Array<{ lit: string } | { v: unknown }> = [{ v: value }];
  while (work.length) {
    const item = work.pop() as { lit: string } | { v: unknown };
    if ("lit" in item) {
      hash.update(item.lit);
      continue;
    }
    const v = item.v;
    if (Array.isArray(v)) {
      work.push({ lit: "]" });
      for (let i = v.length - 1; i >= 0; i--) {
        work.push({ v: v[i] });
        if (i > 0) work.push({ lit: "," });
      }
      work.push({ lit: "[" });
    } else if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      work.push({ lit: "}" });
      for (let i = keys.length - 1; i >= 0; i--) {
        work.push({ v: o[keys[i]] });
        work.push({ lit: JSON.stringify(keys[i]) + ":" });
        if (i > 0) work.push({ lit: "," });
      }
      work.push({ lit: "{" });
    } else hash.update(JSON.stringify(v) ?? "null");
  }
  return hash.digest("hex");
}
