/**
 * AST import-boundary ratchet for loops/core (A-002).
 *
 * loops/core is the Hermes registry.py analog: ports and types only, no host
 * services. This is a sibling of sdkConstructionGuard.test.ts — do not append
 * to that file (#2563). Copy of visit() for import / export / require /
 * dynamic import() string literals.
 *
 * Oracle (2026-09-11): 20 prod files under loops/core. Escapes from core/
 * are only orchestrator.ts and instanceRunner.ts → ../index (deliberate).
 * loops/index.ts may only import ./core/types.
 *
 * Do not walk loops/instances/ (those may import services/db and
 * agentModeService). Do not walk mcp/server.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC_ROOT = path.join(__dirname, '..');
const LOOPS_ROOT = path.join(SRC_ROOT, 'loops');
const CORE_ROOT = path.join(LOOPS_ROOT, 'core');
const INDEX_FILE = path.join(LOOPS_ROOT, 'index.ts');

const ALLOWED_CORE_ESCAPES = new Set([
  'loops/core/orchestrator.ts::../index',
  'loops/core/instanceRunner.ts::../index',
]);

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out.sort();
}

function collectSpecifiers(content: string, fileName: string): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const recordModule = (moduleSpecifier: ts.Expression | undefined): void => {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) return;
    found.push(moduleSpecifier.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      recordModule(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) recordModule(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function relFromSrc(abs: string): string {
  return path.relative(SRC_ROOT, abs).split(path.sep).join('/');
}

function resolvedImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.dirname(fromFile);
  const raw = path.resolve(base, specifier);
  if (fs.existsSync(raw) && fs.statSync(raw).isFile()) return raw;
  if (fs.existsSync(raw + '.ts')) return raw + '.ts';
  if (fs.existsSync(path.join(raw, 'index.ts'))) return path.join(raw, 'index.ts');
  return raw;
}

function isForbiddenHost(resolved: string | null, specifier: string): string | null {
  const hay = `${specifier} ${resolved ?? ''}`.replace(/\\/g, '/');
  if (hay.includes('/services/')) return `host import of services/ (${specifier})`;
  if (hay.includes('/emma/')) return `host import of emma/ (${specifier})`;
  if (resolved) {
    const rel = relFromSrc(resolved);
    if (rel === 'services/db.ts' || rel === 'services/db') {
      return `host import of services/db (${specifier})`;
    }
    if (rel.startsWith('loops/adapters/')) {
      return `core must not import adapters (${specifier})`;
    }
  }
  if (/\/db(\.ts)?$/.test(specifier.replace(/\\/g, '/')) && specifier.includes('services')) {
    return `host import of db (${specifier})`;
  }
  return null;
}

describe('loops/core import boundary (A-002)', () => {
  const coreFiles = walkTsFiles(CORE_ROOT);

  it('walks the live core tree (oracle: 20 prod files)', () => {
    expect(coreFiles.length).toBeGreaterThanOrEqual(20);
    expect(coreFiles.map(relFromSrc)).toEqual(
      expect.arrayContaining([
        'loops/core/orchestrator.ts',
        'loops/core/instanceRunner.ts',
        'loops/core/ports.ts',
        'loops/core/types.ts',
      ]),
    );
  });

  it('forbids services/, emma/, db, and adapters from loops/core', () => {
    const violations: string[] = [];
    for (const file of coreFiles) {
      const specifiers = collectSpecifiers(fs.readFileSync(file, 'utf8'), file);
      for (const specifier of specifiers) {
        const resolved = resolvedImport(file, specifier);
        const forbidden = isForbiddenHost(resolved, specifier);
        if (forbidden) {
          violations.push(`${relFromSrc(file)}: ${forbidden}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('allows only orchestrator and instanceRunner to import ../index', () => {
    const escapes: string[] = [];
    for (const file of coreFiles) {
      const specifiers = collectSpecifiers(fs.readFileSync(file, 'utf8'), file);
      for (const specifier of specifiers) {
        if (!specifier.startsWith('.')) continue;
        const resolved = resolvedImport(file, specifier);
        if (!resolved) continue;
        const relResolved = relFromSrc(resolved);
        if (relResolved.startsWith('loops/core/')) continue;
        const posixKey = `${relFromSrc(file)}::${specifier}`;
        if (!ALLOWED_CORE_ESCAPES.has(posixKey)) {
          escapes.push(`${relFromSrc(file)} → ${specifier} (${relResolved})`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });

  it('loops/index.ts imports only ./core/types (Hermes registry analog)', () => {
    expect(fs.existsSync(INDEX_FILE)).toBe(true);
    const specifiers = collectSpecifiers(fs.readFileSync(INDEX_FILE, 'utf8'), INDEX_FILE);
    expect(specifiers).toEqual(['./core/types']);
  });
});
