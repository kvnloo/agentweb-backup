/**
 * ENG-893 — the installed Bedrock SDK must actually be able to put `ttl` on a
 * cachePoint.
 *
 * This is a silent-failure guard, not a style check. `@aws-sdk/client-bedrock-runtime`
 * serialises Converse requests from its own schema and DROPS fields the schema
 * does not model. Before 3.972.0 `CachePointBlock` had a `type` member only, so
 * `ttl: '1h'` was accepted by TypeScript, sent by us, and quietly discarded on
 * the wire — the whole fix would have shipped dead with every test still green.
 *
 * A dedupe, a lockfile regeneration, or a well-meaning downgrade could reinstate
 * exactly that. Nothing else in the suite would notice: we would simply go back
 * to 5-minute caching and lose the saving, with no error anywhere.
 */

import * as path from 'path';
import * as fs from 'fs';

/** First release whose CachePointBlock models `ttl` (binary-searched, ENG-893). */
const MIN_TTL_CAPABLE_VERSION = [3, 972, 0] as const;

function parseVersion(v: string): number[] {
  return v.split('.').map((p) => parseInt(p, 10));
}

function gte(actual: number[], required: readonly number[]): boolean {
  for (let i = 0; i < required.length; i++) {
    const a = actual[i] ?? 0;
    const r = required[i];
    if (a > r) return true;
    if (a < r) return false;
  }
  return true;
}

describe('ENG-893 — installed Bedrock SDK supports cachePoint.ttl', () => {
  const pkgPath = require.resolve('@aws-sdk/client-bedrock-runtime/package.json');
  const version: string = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

  it(`resolves to >= ${MIN_TTL_CAPABLE_VERSION.join('.')}`, () => {
    expect(gte(parseVersion(version), MIN_TTL_CAPABLE_VERSION)).toBe(true);
  });

  it('models `ttl` on CachePointBlock, so the field reaches the wire', () => {
    // The type declaration is the SDK's own record of what its serialiser will
    // emit. If `ttl` is absent here, the field is dropped silently.
    const typesPath = path.join(
      path.dirname(pkgPath),
      'dist-types',
      'models',
      'models_0.d.ts'
    );
    const declarations = fs.readFileSync(typesPath, 'utf8');
    const cachePointBlock = declarations.slice(
      declarations.indexOf('interface CachePointBlock')
    );
    const body = cachePointBlock.slice(0, cachePointBlock.indexOf('}'));

    expect(body).toContain('ttl');
  });

  it('models the cacheDetails breakdown the ledger bills from', () => {
    // Cost is charged at the TTL Bedrock APPLIED, read out of usage.cacheDetails.
    // Without it every write would silently fall back to the declared rate.
    const typesPath = path.join(
      path.dirname(pkgPath),
      'dist-types',
      'models',
      'models_0.d.ts'
    );
    const declarations = fs.readFileSync(typesPath, 'utf8');
    expect(declarations).toContain('cacheDetails');
  });
});
