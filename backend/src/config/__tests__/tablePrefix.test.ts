import fs from 'fs';
import path from 'path';

// ENG-1760: table-name prefixes are duplicated inline across backend/src, in two
// conflicting forms. Centralizing them is incremental; this ratchet stops the
// count from growing while the remaining sites are migrated to config/constants.
const INLINE_PREFIX =
  /NODE_ENV\s*(===|!==)\s*['"](development|production)['"]\s*\?\s*['"](Dev-)?['"]\s*:\s*['"](Dev-)?['"]/g;

// Lower this when sites move to `TABLE_PREFIX` / `tableName()`; never raise it.
const MAX_INLINE_PREFIX_DEFINITIONS = 125;

const SRC_ROOT = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('table prefix (ENG-1760)', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
    jest.resetModules();
  });

  it.each([
    ['production', 'AW-Users'],
    ['development', 'Dev-AW-Users'],
  ])('tableName() under NODE_ENV=%s yields %s', (env, expected) => {
    process.env.NODE_ENV = env;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { tableName, TABLE_PREFIX } = require('../constants');
      expect(tableName('AW-Users')).toBe(expected);
      expect(`${TABLE_PREFIX}AW-Users`).toBe(expected);
    });
  });

  it('does not add new inline NODE_ENV table-prefix definitions', () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const matches = fs.readFileSync(file, 'utf8').match(INLINE_PREFIX);
      if (matches) hits.push(...matches.map(() => path.relative(SRC_ROOT, file)));
    }
    expect(hits.length).toBeLessThanOrEqual(MAX_INLINE_PREFIX_DEFINITIONS);
  });

  it('routes/admin.ts uses the shared TABLE_PREFIX', () => {
    const admin = fs.readFileSync(path.join(SRC_ROOT, 'routes', 'admin.ts'), 'utf8');
    expect(admin.match(INLINE_PREFIX)).toBeNull();
    expect(admin).toMatch(/import \{ TABLE_PREFIX \} from "\.\.\/config\/constants"/);
  });
});
