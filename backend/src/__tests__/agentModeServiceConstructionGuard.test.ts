/**
 * AgentModeService construction guard (ENG-1852 regression lock).
 *
 * ENG-1852: two live AgentModeService objects existed inside one worker process
 * — the worker's own (correctly initialized) and the module-level singleton
 * (never initialized). emma/tools.ts's install_skills handler and ~138 other
 * tool handlers import the singleton directly, so whichever object answered a
 * given getUnassociatedTools() call decided whether the __other_skills__ bundle
 * resolved or came back empty. It presented as a non-deterministic
 * "allToolsCount flip-flops between 0 and 264" and took five diagnostic PRs, one
 * refuted-and-closed fix, and several sessions to find. The fix was one line.
 *
 * This guard closes the structural half of that bug class: the server process
 * gets exactly one AgentModeService, constructed at services/agentModeService.ts's
 * own module scope.
 *
 * KNOWN LIMIT — read before relying on this. Backend CI does NOT run jest. The
 * `Build` workflow's backend job runs `npm ci` + `npm run build` only, and
 * tsconfig.build.json excludes the __tests__ directories, so this file is not even
 * typechecked there. It therefore protects a local/pre-push run, NOT the merge
 * gate. Wiring jest into backend CI is a repo-wide infrastructure decision with
 * a real time cost on every PR and is deliberately not made here. Until it is,
 * treat a green build as saying nothing about this guard.
 *
 * Why AST and not grep. All three were measured against real source, not assumed:
 *   - 184 occurrences of `new AgentModeService(` live in test files, which
 *     legitimately construct their own instances in beforeEach.
 *   - Two of the three non-test occurrences are COMMENTS — including
 *     generateMarketingResponseWorker.ts's note recording the ENG-1852 fix
 *     itself, so a grep guard reports the fix as the violation.
 *   - An aliased `import { AgentModeService as X }` then `new X()` is invisible
 *     to a literal-name grep.
 * Parsing sidesteps all three, the same reasoning sdkConstructionGuard.test.ts
 * (whose structure this file follows) applies to provider SDK imports.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const SRC_ROOT = path.join(__dirname, '..');

/** Module specifiers that resolve to services/agentModeService.ts. */
const AGENT_MODE_SERVICE_MODULE = /(^|\/)agentModeService$/;

const CLASS_NAME = 'AgentModeService';

/**
 * Files permitted to construct, mapped to how many constructions are allowed.
 *
 * services/agentModeService.ts holds the single module-level singleton
 * (`export const agentModeService = new AgentModeService();`) that every
 * consumer — emma/tools.ts, mcp/server/apiTools.ts, emmaApi.ts,
 * generateMarketingResponseWorker.ts and ~15 other services — resolves. One,
 * and only one.
 *
 * This list must shrink, never grow. A new entry means a second live instance,
 * which is the exact condition ENG-1852 was.
 */
const ALLOWED_CONSTRUCTIONS = new Map<string, number>([
  ['services/agentModeService.ts', 1],
]);

/**
 * Local binding names that refer to the AgentModeService class in this file.
 *
 * Covers the aliased-import case, and also the class's own declaring file —
 * without the declaration branch the guard would silently ignore
 * agentModeService.ts, which is precisely where an accidental second
 * construction would be most damaging.
 *
 * Type-only imports are excluded: TypeScript erases them, so they cannot
 * construct anything at runtime. Same narrowing ENG-1937 applied to the sibling
 * SDK guard after a type-only reference failed the build.
 */
function moduleSpecifierMatches(node: ts.Expression | undefined): boolean {
  return !!node && ts.isStringLiteralLike(node) && AGENT_MODE_SERVICE_MODULE.test(node.text);
}

/** `require('./agentModeService')` or `await import('./agentModeService')` / `import(...)`. */
function isModuleLoadCall(node: ts.Node): boolean {
  const call = ts.isAwaitExpression(node) ? node.expression : node;
  if (!ts.isCallExpression(call) || call.arguments.length !== 1) return false;
  const isRequire = ts.isIdentifier(call.expression) && call.expression.text === 'require';
  const isDynamicImport = call.expression.kind === ts.SyntaxKind.ImportKeyword;
  if (!isRequire && !isDynamicImport) return false;
  return moduleSpecifierMatches(call.arguments[0]);
}

/**
 * Local names that can construct the class in this file.
 *
 * `direct` always contains the bare class name. Anything spelled
 * `new AgentModeService()` is flagged regardless of how the binding arrived —
 * which is what closes the require/dynamic-import hole, since both idioms
 * destructure to that same name. `namespaces` holds bindings for the whole
 * module, so `new mod.AgentModeService()` is caught too.
 *
 * Aliases are resolved from all four load forms: static import, namespace
 * import, `require()`, and dynamic `import()`.
 *
 * Type-only imports are excluded — TypeScript erases them, so they cannot
 * construct anything at runtime. Same narrowing ENG-1937 applied to the sibling
 * SDK guard after a type-only reference failed the build.
 */
function collectClassBindings(sourceFile: ts.SourceFile): {
  direct: Set<string>;
  namespaces: Set<string>;
} {
  const direct = new Set<string>([CLASS_NAME]);
  const namespaces = new Set<string>();

  const addFromBindingPattern = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      namespaces.add(name.text); // const mod = require('./agentModeService')
      return;
    }
    if (!ts.isObjectBindingPattern(name)) return;
    for (const el of name.elements) {
      const imported = (el.propertyName ?? el.name);
      if (ts.isIdentifier(imported) && imported.text === CLASS_NAME && ts.isIdentifier(el.name)) {
        direct.add(el.name.text); // const { AgentModeService: Alias } = require(...)
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === CLASS_NAME) {
      direct.add(CLASS_NAME);
    }

    if (ts.isImportDeclaration(node) && moduleSpecifierMatches(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        const named = clause.namedBindings;
        if (named && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if (el.isTypeOnly) continue;
            if ((el.propertyName ?? el.name).text === CLASS_NAME) direct.add(el.name.text);
          }
        } else if (named && ts.isNamespaceImport(named)) {
          namespaces.add(named.name.text);
        }
      }
    }

    // const { AgentModeService } = await import('./agentModeService')
    // const { AgentModeService } = require('./agentModeService')
    // const mod = require('./agentModeService')
    if (ts.isVariableDeclaration(node) && node.initializer && isModuleLoadCall(node.initializer)) {
      addFromBindingPattern(node.name);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { direct, namespaces };
}

export function countConstructions(content: string, fileName = 'source.ts'): number {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const { direct, namespaces } = collectClassBindings(sourceFile);
  if (direct.size === 0 && namespaces.size === 0) return 0;

  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const target = node.expression;
      // `new AgentModeService()` / `new Aliased()`
      if (ts.isIdentifier(target) && direct.has(target.text)) count++;
      // `new mod.AgentModeService()` — namespace import of the module. Gated on
      // the namespace binding rather than matching any `.AgentModeService`, so an
      // unrelated module exposing a same-named class is not falsely flagged.
      if (ts.isPropertyAccessExpression(target) && target.name.text === CLASS_NAME) {
        // `new mod.AgentModeService()` where mod is a tracked module binding, or
        // the inline `new (await import('./agentModeService')).AgentModeService()`.
        const base = target.expression;
        const viaBinding = ts.isIdentifier(base) && namespaces.has(base.text);
        const viaInlineLoad = isModuleLoadCall(base) ||
          (ts.isParenthesizedExpression(base) && isModuleLoadCall(base.expression));
        if (viaBinding || viaInlineLoad) count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return count;
}

function assertConstructionAllowed(rel: string, content: string): void {
  const found = countConstructions(content, rel);
  const allowed = ALLOWED_CONSTRUCTIONS.get(rel) ?? 0;
  if (found > allowed) {
    throw new Error(
      `${rel} constructs AgentModeService ${found} time(s); ${allowed} allowed. ` +
      'Import the module SINGLETON (lowercase `agentModeService`, the exported instance) ' +
      'rather than the class — note the guard flags the class name in every load form, ' +
      'static import, require() and dynamic import() alike. ' +
      'A second live instance is ENG-1852: one object ends up uninitialized, ' +
      'and whichever one answers a given call decides whether tools resolve.',
    );
  }
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests construct their own instances in beforeEach — 184 occurrences,
      // all legitimate and all isolated to a single suite.
      // __tests__/__mocks__ construct their own instances freely and legitimately.
      // scripts/ are one-shot CLI entry points in their own short-lived process,
      // where a second instance costs nothing and shares no state with the server.
      if (
        entry.name === '__tests__' ||
        entry.name === '__mocks__' ||
        entry.name === 'node_modules' ||
        (dir === SRC_ROOT && entry.name === 'scripts')
      ) continue;
      listSourceFiles(full, acc);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe('AgentModeService construction guard (ENG-1852)', () => {
  it('no production file constructs AgentModeService outside the single allowed singleton', () => {
    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      assertConstructionAllowed(rel, fs.readFileSync(file, 'utf8'));
    }
  });

  it('allowlist entries still exist and still construct (prunes stale entries)', () => {
    const stale: string[] = [];
    for (const [rel, allowed] of ALLOWED_CONSTRUCTIONS) {
      const full = path.join(SRC_ROOT, rel);
      if (!fs.existsSync(full)) {
        stale.push(`${rel} (file deleted — remove from allowlist)`);
        continue;
      }
      const found = countConstructions(fs.readFileSync(full, 'utf8'), rel);
      if (found < allowed) {
        stale.push(`${rel} (constructs ${found}, allowlist says ${allowed} — lower it)`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe('AgentModeService construction guard — detection behaviour', () => {
  it('flags a plain construction in a non-allowlisted file', () => {
    const src = [
      "import { AgentModeService } from './agentModeService';",
      'const svc = new AgentModeService();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('sees through an aliased import that a literal-name grep would miss', () => {
    const src = [
      "import { AgentModeService as Engine } from './agentModeService';",
      'const svc = new Engine();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('ignores the construction spelling inside comments and strings', () => {
    // This is the real regression: generateMarketingResponseWorker.ts documents
    // the ENG-1852 fix in a comment that contains the forbidden spelling, and
    // chatbotService.ts now does too. A grep guard fails both.
    const src = [
      "import { agentModeService } from './agentModeService';",
      '// ENG-1852: use the exported singleton, not a separate `new AgentModeService()`.',
      "const note = 'do not call new AgentModeService() here';",
      'void agentModeService;',
      'void note;',
    ].join('\n');
    expect(() => assertConstructionAllowed('workers/someWorker.ts', src)).not.toThrow();
  });

  it('ignores a type-only import, which cannot construct at runtime', () => {
    const src = [
      "import type { AgentModeService } from './agentModeService';",
      'export function take(svc: AgentModeService): void { void svc; }',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).not.toThrow();
  });

  it('allows exactly one construction in the declaring file and flags a second', () => {
    const one = [
      `export class ${CLASS_NAME} { }`,
      `export const agentModeService = new ${CLASS_NAME}();`,
    ].join('\n');
    expect(() => assertConstructionAllowed('services/agentModeService.ts', one)).not.toThrow();

    const two = [one, `const stray = new ${CLASS_NAME}();`, 'void stray;'].join('\n');
    expect(() => assertConstructionAllowed('services/agentModeService.ts', two)).toThrow(/constructs AgentModeService 2 time/);
  });

  // The three forms below were live bypasses in the first version of this guard —
  // an adversarial review defeated it by appending each to a real production file
  // and watching the suite stay green. `require` and dynamic `import` are dominant
  // idioms in this repo (20+ dynamic sites, 48 non-test files using require), and
  // the original remediation message actively recommended the dynamic-import
  // spelling, so a one-token slip reintroduced ENG-1852 with the guard green.
  it('flags a dynamic-import destructure (was a live bypass)', () => {
    const src = [
      'async function f() {',
      "  const { AgentModeService } = await import('./agentModeService');",
      '  return new AgentModeService();',
      '}',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a require() destructure (was a live bypass)', () => {
    const src = [
      "const { AgentModeService } = require('./agentModeService');",
      'const svc = new AgentModeService();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags an aliased require() destructure', () => {
    const src = [
      "const { AgentModeService: Engine } = require('./agentModeService');",
      'const svc = new Engine();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags construction off a require()d module object', () => {
    const src = [
      "const mod = require('./agentModeService');",
      'const svc = new mod.AgentModeService();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags the inline dynamic-import construction', () => {
    const src = [
      'async function f() {',
      "  return new (await import('./agentModeService')).AgentModeService();",
      '}',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a namespace-style construction', () => {
    const src = [
      "import * as mod from './agentModeService';",
      'const svc = new mod.AgentModeService();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });
});
