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
 *   - 317 occurrences of `new AgentModeService(` live in test files, which
 *     legitimately construct their own instances in beforeEach.
 *   - Most non-test occurrences of the spelling are COMMENTS, not code — including
 *     generateMarketingResponseWorker.ts's note recording the ENG-1852 fix itself, and
 *     two in chatbotService.ts. A grep guard reports the fix as the violation. (Counts
 *     here are scoped to src/__tests__ and drift as tests are added — they are context
 *     for WHY this is AST-based, not an invariant. Do not treat them as pinned.)
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
const AGENT_MODE_SERVICE_MODULE = /(^|\/)agentModeService(\.js)?$/;

const CLASS_NAME = 'AgentModeService';

/** True for the string literal 'AgentModeService' in a computed member access. */
function isClassNameLiteral(node: ts.Expression | undefined): boolean {
  return !!node && ts.isStringLiteralLike(node) && node.text === CLASS_NAME;
}

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

/**
 * Strip parentheses, `as` casts and `!` so a construction cannot hide behind syntax:
 * `new (AgentModeService)()`, `class E extends (X as any) {}`.
 */
function unwrap(node: ts.Expression): ts.Expression {
  let n: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) { n = n.expression; continue; }
    if (ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) { n = n.expression; continue; }
    if (ts.isNonNullExpression(n)) { n = n.expression; continue; }
    return n;
  }
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
        // `import mod from './agentModeService'` — with esModuleInterop the default
        // binding is the module object, so `new mod.AgentModeService()` works.
        if (clause.name) namespaces.add(clause.name.text);
      }
    }

    // const { AgentModeService } = await import('./agentModeService')
    // const { AgentModeService } = require('./agentModeService')
    // const mod = require('./agentModeService')
    if (ts.isVariableDeclaration(node) && node.initializer && isModuleLoadCall(node.initializer)) {
      addFromBindingPattern(node.name);
    }

    // mod = require('./agentModeService')  — assignment, not declaration
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      if (isModuleLoadCall(node.right)) namespaces.add(node.left.text);
      // C = AgentModeService — the assignment twin of `const C = AgentModeService`,
      // which was closed last round while this one-token variant was left open.
      const r = unwrap(node.right);
      if (ts.isIdentifier(r) && direct.has(r.text)) direct.add(node.left.text);
      if (
        ts.isPropertyAccessExpression(r) && r.name.text === CLASS_NAME &&
        ts.isIdentifier(r.expression) && namespaces.has(r.expression.text)
      ) direct.add(node.left.text);
    }

    // import('./agentModeService').then(m => new m.AgentModeService())
    // A live idiom in this repo — server.ts loads ensureCriticalTables and
    // mcpOAuthRefreshService exactly this way — and the callback parameter is a module
    // object that a declaration-only walk never sees.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      isModuleLoadCall(node.expression.expression) &&
      node.arguments.length > 0
    ) {
      const cb = node.arguments[0];
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) {
        const param = cb.parameters[0];
        if (param) {
          if (ts.isIdentifier(param.name)) namespaces.add(param.name.text);
          else addFromBindingPattern(param.name);
        }
      }
    }

    // const Alias = AgentModeService  — a plain rebind of an already-tracked name.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      direct.has(node.initializer.text)
    ) {
      direct.add(node.name.text);
    }

    // const Alias = mod.AgentModeService  — namespace member pulled into a local.
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === CLASS_NAME &&
      ts.isIdentifier(node.initializer.expression) &&
      namespaces.has(node.initializer.expression.text)
    ) {
      direct.add(node.name.text);
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
    // class Ext extends AgentModeService {}  — a subclass gets its OWN toolRegistry, which
    // is the same two-live-objects shape ENG-1852 was. Counted as a construction site.
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const t of clause.types) {
          const e = unwrap(t.expression);
          if (ts.isIdentifier(e) && direct.has(e.text) && node.name?.text !== CLASS_NAME) count++;
          if (ts.isPropertyAccessExpression(e) && e.name.text === CLASS_NAME) {
            const b = unwrap(e.expression);
            if (ts.isIdentifier(b) && namespaces.has(b.text)) count++;
            else if (isModuleLoadCall(b)) count++;
          }
          // `class E extends mod['AgentModeService'] {}` — the extends clause had no
          // computed-member case at all, though `new` gained one.
          if (ts.isElementAccessExpression(e) && isClassNameLiteral(e.argumentExpression)) {
            const b = unwrap(e.expression);
            if ((ts.isIdentifier(b) && namespaces.has(b.text)) || isModuleLoadCall(b)) count++;
          }
        }
      }
    }

    // Reflect.construct(AgentModeService, []) — a construction that is not a NewExpression.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'construct' &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Reflect' &&
      node.arguments.length > 0
    ) {
      const a = unwrap(node.arguments[0] as ts.Expression);
      if (ts.isIdentifier(a) && direct.has(a.text)) count++;
      // Gated on the base resolving to THIS module, matching the NewExpression branch —
      // ungated, an unrelated module exporting a same-named class was falsely flagged.
      if (ts.isPropertyAccessExpression(a) && a.name.text === CLASS_NAME) {
        const b = unwrap(a.expression);
        if ((ts.isIdentifier(b) && namespaces.has(b.text)) || isModuleLoadCall(b)) count++;
      }
      if (ts.isElementAccessExpression(a) && isClassNameLiteral(a.argumentExpression)) count++;
    }

    if (ts.isNewExpression(node)) {
      const target = unwrap(node.expression);
      // `new AgentModeService()` / `new Aliased()`
      if (ts.isIdentifier(target) && direct.has(target.text)) count++;
      // `new mod.AgentModeService()` — namespace import of the module. Gated on
      // the namespace binding rather than matching any `.AgentModeService`, so an
      // unrelated module exposing a same-named class is not falsely flagged.
      // new mod['AgentModeService']() — ElementAccessExpression, not a dot-property.
      if (ts.isElementAccessExpression(target) && isClassNameLiteral(target.argumentExpression)) {
        const base = unwrap(target.expression);
        const viaBinding = ts.isIdentifier(base) && namespaces.has(base.text);
        const viaInlineLoad = isModuleLoadCall(base);
        if (viaBinding || viaInlineLoad) count++;
      }

      if (ts.isPropertyAccessExpression(target) && target.name.text === CLASS_NAME) {
        // `new mod.AgentModeService()` where mod is a tracked module binding, or
        // the inline `new (await import('./agentModeService')).AgentModeService()`.
        // unwrap() here too: `new (mod).X()` and `new (mod as any).X()` were slipping
        // through because only the callee and the ElementAccess base were unwrapped.
        const base = unwrap(target.expression);
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
      // Tests construct their own instances in beforeEach — 317 occurrences,
      // all legitimate and all isolated to a single suite.
      // __tests__/__mocks__ construct their own instances freely and legitimately.
      //
      // src/scripts is deliberately NOT excluded. An earlier version excluded it on the
      // premise that scripts are one-shot CLI entry points in their own short-lived
      // process — which is false for at least one of them:
      // services/agentMode/outreachScheduleAutoCreateWiring.ts does
      // `import('../../scripts/seed-eng1609-linkedin-outreach-template')`, loading a
      // require.main-guarded script as a library INTO the long-lived server process.
      // Excluding 87 files on a premise that is wrong for any of them is not worth the
      // hole; nothing under src/scripts constructs the class today, so including them
      // costs nothing.
      if (
        entry.name === '__tests__' ||
        entry.name === '__mocks__' ||
        entry.name === 'node_modules'
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

  // Every form below walked straight past an earlier version of this guard. A second
  // review defeated it by extracting countConstructions and running these standalone.
  it('flags construction inside a dynamic-import .then() callback', () => {
    // server.ts uses exactly this idiom for ensureCriticalTables and
    // mcpOAuthRefreshService, so the callback parameter is a live module-object binding.
    const src = [
      "import('./agentModeService').then(m => { const s = new m.AgentModeService(); void s; });",
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a subclass, which gets its own registry', () => {
    const src = [
      "import { AgentModeService } from './agentModeService';",
      'class Extended extends AgentModeService {}',
      'const svc = new Extended();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a plain rebind of the class', () => {
    const src = [
      "import { AgentModeService } from './agentModeService';",
      'const Cls = AgentModeService;',
      'const svc = new Cls();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a namespace member pulled into a local', () => {
    const src = [
      "import * as mod from './agentModeService';",
      'const Cls = mod.AgentModeService;',
      'const svc = new Cls();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags the assignment form of require', () => {
    const src = [
      'let mod: any;',
      "mod = require('./agentModeService');",
      'const svc = new mod.AgentModeService();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('does not flag the class declaring itself', () => {
    // agentModeService.ts declares `export class AgentModeService` and then constructs it
    // once. The declaration must not be mistaken for a subclass of itself.
    const src = [
      `export class ${CLASS_NAME} { }`,
      `export const agentModeService = new ${CLASS_NAME}();`,
    ].join('\n');
    expect(() => assertConstructionAllowed('services/agentModeService.ts', src)).not.toThrow();
  });

  // Six more forms an independent review defeated the previous version with, by
  // extracting countConstructions and running a battery of idioms against it. Two are
  // one-token variants of forms the previous round claimed to have closed.
  it('flags computed member access', () => {
    const src = [
      "import * as mod from './agentModeService';",
      "const svc = new mod['AgentModeService']();",
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a parenthesized callee', () => {
    const src = [
      "import { AgentModeService } from './agentModeService';",
      'const svc = new (AgentModeService)();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags Reflect.construct', () => {
    const src = [
      "import { AgentModeService } from './agentModeService';",
      'const svc = Reflect.construct(AgentModeService, []);',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a subclass hidden behind an as-cast', () => {
    const src = [
      "import { AgentModeService } from './agentModeService';",
      'class Extended extends (AgentModeService as any) {}',
      'const svc = new Extended();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags the assignment-form rebind', () => {
    const src = [
      "import { AgentModeService } from './agentModeService';",
      'let C: any;',
      'C = AgentModeService;',
      'const svc = new C();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags construction via a default import of the module', () => {
    const src = [
      "import mod from './agentModeService';",
      'const svc = new mod.AgentModeService();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags a specifier carrying a .js extension', () => {
    const src = [
      "const { AgentModeService } = require('./agentModeService.js');",
      'const svc = new AgentModeService();',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('flags construction off a parenthesized or cast module object', () => {
    const src = [
      "import * as mod from './agentModeService';",
      'const a = new (mod).AgentModeService();',
      'const b = new (mod as any).AgentModeService();',
      'void a; void b;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService 2 time/);
  });

  it('flags a subclass off a parenthesized or computed module member', () => {
    const src = [
      "import * as mod from './agentModeService';",
      'class A extends (mod).AgentModeService {}',
      "class B extends mod['AgentModeService'] {}",
      'void new A(); void new B();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });

  it('does not flag a same-named class from an unrelated module via Reflect', () => {
    const src = [
      "import * as other from './someOtherLib';",
      'const svc = Reflect.construct(other.AgentModeService, []);',
      'void svc;',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).not.toThrow();
  });

  it('flags a namespace-style construction', () => {
    const src = [
      "import * as mod from './agentModeService';",
      'const svc = new mod.AgentModeService();',
    ].join('\n');
    expect(() => assertConstructionAllowed('services/someService.ts', src)).toThrow(/constructs AgentModeService/);
  });
});
