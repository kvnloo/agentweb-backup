/**
 * Drift guard for the Gemini schema allowlist (ENG-845).
 *
 * `sanitizeGeminiSchema` is an ALLOWLIST, which buys immunity to unknown JSON-Schema
 * keywords (the recurring 400-the-whole-request class) at the cost of one maintenance
 * obligation: if Google ADDS a field to `Schema`, we silently strip it until someone
 * updates the set. That failure is quiet — no error, no 400, just a capability we
 * never pass to the model. This test makes the upgrade loud instead.
 *
 * It reads the field names straight off the installed `@google/genai` typings, so it
 * fails the moment a version bump changes the surface. It SKIPS rather than fails when
 * the typings can't be located or parsed — a packaging change in a dependency must not
 * turn into a red build on an unrelated PR.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GEMINI_SCHEMA_KEYWORDS } from '../geminiNativeClient';

/** Locate `genai.d.ts` by walking up from the resolved entry point to the package root. */
function findTypings(): string | null {
  let dir: string;
  try {
    dir = path.dirname(require.resolve('@google/genai'));
  } catch {
    return null;
  }
  // dist/node/index.cjs -> dist/node -> dist -> <pkg root>
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'genai.d.ts');
    if (fs.existsSync(candidate)) return candidate;
    const nested = path.join(dir, 'dist', 'genai.d.ts');
    if (fs.existsSync(nested)) return nested;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Extract the optional-property names declared on the `Schema` interface. */
function readSchemaFields(source: string): string[] | null {
  const header = /^export declare interface Schema \{$/m.exec(source);
  if (!header) return null;
  const start = header.index + header[0].length;
  const end = source.indexOf('\n}', start);
  if (end === -1) return null;
  const body = source.slice(start, end);
  const fields = [...body.matchAll(/^\s{4}(\w+)\?:/gm)].map((m) => m[1]);
  return fields.length ? [...new Set(fields)] : null;
}

describe('GEMINI_SCHEMA_KEYWORDS tracks the @google/genai Schema type', () => {
  const typingsPath = findTypings();
  const fields = typingsPath ? readSchemaFields(fs.readFileSync(typingsPath, 'utf8')) : null;

  // Skip, never fail, when the dependency's packaging moves out from under us.
  const maybeIt = fields ? it : it.skip;

  maybeIt('allows exactly the fields Schema models — no more, no less', () => {
    const declared = [...(fields as string[])].sort();
    const allowed = [...GEMINI_SCHEMA_KEYWORDS].sort();

    // Fields Gemini accepts that we would silently strip. If this fires after a
    // dependency bump, add the new field(s) to GEMINI_SCHEMA_KEYWORDS — and check
    // whether they hold sub-schemas (recurse) or literal instance data (pass through).
    const missing = declared.filter((f) => !GEMINI_SCHEMA_KEYWORDS.has(f));
    expect(missing).toEqual([]);

    // Entries we allow that Schema no longer models. Harmless today (Gemini would
    // reject them, which is how they'd be noticed) but it means the set has gone stale.
    const stale = allowed.filter((f) => !(fields as string[]).includes(f));
    expect(stale).toEqual([]);
  });

  maybeIt('parses a plausible field set (guards against a silently-empty match)', () => {
    // A regex that matched nothing would make the assertion above vacuously pass, so
    // pin the order of magnitude rather than an exact count that churns on every bump.
    expect((fields as string[]).length).toBeGreaterThanOrEqual(15);
    expect(fields).toEqual(expect.arrayContaining(['type', 'properties', 'items', 'anyOf']));
  });
});
