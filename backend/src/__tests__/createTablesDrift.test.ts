import fs from 'fs';
import path from 'path';
import vm from 'vm';
import ts from 'typescript';
import type AWS from 'aws-sdk';

const srcRoot = path.resolve(__dirname, '..');
const creationScript = path.join(srcRoot, 'scripts/create-tables.ts');
const normalize = (name: string): string => name.replace(/^Dev-(?=AW-)/, '');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['__tests__', '__mocks__', '__fixtures__', 'fixtures'].includes(entry.name)) return [];
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec|d)\.[jt]sx?$/.test(file)
      && file !== creationScript ? [file] : [];
  });
}

/**
 * Conservative inventory of table literals in executable syntax, including
 * constants passed through imports, wrapper arguments and batch RequestItems.
 * Comments, prose strings and numeric AW-* Google Ads conversion IDs do not
 * count. Never import application modules: several start clients/crons on load.
 * Env overrides use their source default, not the runner's environment or the
 * env variable's spelling. An env-only table fails closed for explicit review.
 */
function referencedTables(sources: Map<string, string>): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  // Resolve imported constants and lexical shadowing without loading any module
  // or dependency. The compiler host can see only the source inventory.
  const files = new Map([...sources].map(([file, source]) => {
    const absolute = path.resolve(srcRoot, file);
    return [absolute, ts.createSourceFile(absolute, source, ts.ScriptTarget.Latest, true)] as const;
  }));
  const options: ts.CompilerOptions = { noLib: true, allowJs: true, moduleResolution: ts.ModuleResolutionKind.Node10 };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => files.get(file);
  host.fileExists = file => files.has(file);
  host.readFile = file => files.get(file)?.text;
  host.directoryExists = () => true;
  const checker = ts.createProgram([...files.keys()], options, host).getTypeChecker();
  for (const [absolute, ast] of files) {
    const file = path.relative(srcRoot, absolute);
    function strings(node: ts.Node, seen = new Set<ts.Node>()): string[] {
      if (seen.has(node)) return [];
      const next = new Set(seen).add(node);
      if (ts.isStringLiteralLike(node)) return [node.text];
      if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        const declaration = symbol?.valueDeclaration;
        return declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && declaration.initializer
          ? strings(declaration.initializer, next) : [];
      }
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return strings(node.expression, next);
      if (ts.isConditionalExpression(node)) return [...strings(node.whenTrue, next), ...strings(node.whenFalse, next)];
      if (ts.isBinaryExpression(node)) {
        const left = strings(node.left, next), right = strings(node.right, next);
        if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left.flatMap(a => right.map(b => a + b));
        if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return [...left, ...right];
      }
      if (ts.isTemplateExpression(node)) {
        return node.templateSpans.reduce((values, span) =>
          values.flatMap(prefix => strings(span.expression, next).map(value => prefix + value + span.literal.text)), [node.head.text]);
      }
      return [];
    }
    function add(name: string): void {
      const normalized = normalize(name);
      if (!tables.has(normalized)) tables.set(normalized, new Set());
      tables.get(normalized)!.add(file);
    }
    function visit(node: ts.Node): void {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node) || ts.isBinaryExpression(node)) {
        for (const value of strings(node)) {
          if (/^(?:Dev-)?AW-[A-Za-z][\w-]*$/.test(value)) add(value);
        }
      }
      // Also handle a literal/default outside the AW-* naming convention.
      if (ts.isPropertyAssignment(node) && /^(TableName|tableName)$/.test(node.name.getText(ast).replace(/['"]/g, ''))) {
        strings(node.initializer).forEach(add);
      }
      const envAccess = (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
        && node.expression.getText(ast) === 'process.env';
      if (envAccess) {
        const envName = ts.isPropertyAccessExpression(node) ? node.name.text
          : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : '';
        let fallback: ts.Node = node;
        while (ts.isParenthesizedExpression(fallback.parent) || ts.isBinaryExpression(fallback.parent)) fallback = fallback.parent;
        const isTableValue = ts.isPropertyAssignment(fallback.parent) && /^(TableName|tableName)$/.test(fallback.parent.name.getText(ast));
        if (/(?:^|_)TABLE(?:_NAME)?$/.test(envName) || isTableValue) {
          const defaults = strings(fallback).filter(Boolean);
          if (!defaults.length) throw new Error(`${file}: ${envName} has no statically resolvable table default`);
          defaults.forEach(add);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return tables;
}

/** Execute only the provisioning script with a closed require allowlist. Every
 * AWS operation is a local stub; config/aws and dotenv never load or read creds.
 * Capturing main() also catches a defined function omitted from the create list.
 */
async function definedTables(environment: string, source = fs.readFileSync(creationScript, 'utf8')): Promise<AWS.DynamoDB.CreateTableInput[]> {
  const definitions: AWS.DynamoDB.CreateTableInput[] = [];
  const aws = {
    config: { update: () => {} },
    DynamoDB: class {
      createTable(input: AWS.DynamoDB.CreateTableInput) {
        definitions.push(input);
        return { promise: async () => ({}) };
      }
      updateTimeToLive() { return { promise: async () => ({}) }; }
      waitFor() { return { promise: async () => ({}) }; }
    },
  };
  const sandbox = {
    require: (id: string) => {
      if (id === 'aws-sdk') return aws;
      if (id === 'dotenv') return { config: () => {} };
      if (id === 'path') return path;
      if (id === '../config/aws') return {};
      throw new Error(`Unexpected provisioning import: ${id}`);
    },
    module: { exports: {} }, exports: {}, __dirname: path.dirname(creationScript),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    process: { env: { NODE_ENV: environment }, exit: (code: number) => { throw new Error(`create-tables exited ${code}`); } },
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  await vm.runInNewContext(`${compiled}\nmain();`, sandbox, { timeout: 5000 });
  return definitions;
}

function missingTables(references: Map<string, Set<string>>, definitions: AWS.DynamoDB.CreateTableInput[]): string[] {
  const defined = new Set(definitions.map(table => normalize(table.TableName)));
  return [...references].filter(([name]) => !defined.has(name))
    .map(([name, files]) => `${name}: ${[...files].join(', ')}`).sort();
}

describe('create-tables schema drift (ENG-1758 AC3)', () => {
  const references = referencedTables(new Map(sourceFiles(srcRoot).map(file => [path.relative(srcRoot, file), fs.readFileSync(file, 'utf8')])));

  it.each(['production', 'development'])('defines every referenced table in %s', async environment => {
    expect(references.size).toBeGreaterThan(0);
    expect(missingTables(references, await definedTables(environment))).toEqual([]);
  });

  // Schemas traced from real Get/Delete keys, Query conditions and written
  // values, rather than inferred from table names. ts is an ISO string.
  it.each([
    ['AW-ContactEvents', ['contactId', 'eventTimestamp'], { 'sourceRecordId-index': ['sourceRecordId'] }],
    ['AW-CustomDomains', ['id'], { 'userId-index': ['userId'] }],
    ['AW-LeadMagnetConfigs', ['configId'], {}],
    ['AW-OnboardingLoopRuns', ['runId'], {}],
    ['AW-PromptSignals', ['signalId'], { PromptVersionIndex: ['promptVersion', 'ts'] }],
  ] as [string, string[], Record<string, string[]>][])('provisions the key/index contract used by %s callers', async (name, keys, indexes) => {
    const definition = (await definedTables('production')).find(table => table.TableName === name)!;
    expect(definition).toBeDefined();
    const keySchema = (names: string[]) => names.map((AttributeName, i) => ({ AttributeName, KeyType: i === 0 ? 'HASH' : 'RANGE' }));
    expect(definition.KeySchema).toEqual(keySchema(keys));
    expect(definition.GlobalSecondaryIndexes || []).toEqual(Object.entries(indexes).map(([IndexName, names]) => ({
      IndexName, KeySchema: keySchema(names), Projection: { ProjectionType: 'ALL' },
    })));
    const attributes = [...new Set([...keys, ...Object.values(indexes).flat()])].sort();
    expect([...definition.AttributeDefinitions!].sort((a, b) => a.AttributeName.localeCompare(b.AttributeName)))
      .toEqual(attributes.map(AttributeName => ({ AttributeName, AttributeType: 'S' })));
    expect(definition.BillingMode).toBe('PAY_PER_REQUEST');
    expect(definition.ProvisionedThroughput).toBeUndefined();
  });

  it('collects constants, env defaults, wrapper calls, templates and batch keys without counting comments or Ads IDs', () => {
    const found = referencedTables(new Map([['service.ts', [
      "// TableName: 'AW-CommentOnly'",
      "const googleAdsId = 'AW-123456789';",
      "const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';",
      "const DEFAULT = `${TABLE_PREFIX}AW-RealDefault`;",
      "const alias = process.env.DIFFERENT_NAME_TABLE || DEFAULT;",
      "client.get({ TableName: alias });",
      "client.get({ TableName: process.env['SECOND_TABLE'] ?? 'AW-Second' });",
      "adapter.putItem('AW-Wrapper', item);",
      "client.batchGet({ RequestItems: { 'AW-Batch': { Keys: [] } } });",
      "client.get({ TableName: process.env.THIRD_TABLE || 'nonstandard-table' });",
      "const concatenated = TABLE_PREFIX + 'AW-Concatenated';",
    ].join('\n')]]));
    expect([...found.keys()].sort()).toEqual(['AW-Batch', 'AW-Concatenated', 'AW-RealDefault', 'AW-Second', 'AW-Wrapper', 'nonstandard-table']);
  });

  it('fails closed on an env-only table rather than guessing its name', () => {
    expect(() => referencedTables(new Map([['service.ts', 'client.get({ TableName: process.env.NEW_TABLE });']]))).toThrow('NEW_TABLE has no statically resolvable table default');
  });

  it('resolves imported prefixes and aliases without confusing shadowed bindings', () => {
    const found = referencedTables(new Map([
      ['config.ts', "export const PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : ''; export const NAME = 'imported-table';"],
      ['service.ts', [
        "import { PREFIX, NAME as DEFAULT } from './config';",
        "const table = 'outer-table';",
        "function inner() { const table = 'inner-table'; client.get({ TableName: table }); }",
        "client.get({ TableName: table });",
        "client.get({ TableName: `${PREFIX}AW-ImportedPrefix` });",
        "client.get({ TableName: process.env.CUSTOM_TABLE || DEFAULT });",
      ].join('\n')],
    ]));
    expect([...found.keys()].sort()).toEqual(['AW-ImportedPrefix', 'imported-table', 'inner-table', 'outer-table']);
  });

  it('detects a newly referenced but undefined table', async () => {
    const drift = referencedTables(new Map([['newService.ts', "client.get({ TableName: 'AW-NewUnprovisioned' });"]]));
    expect(missingTables(drift, await definedTables('production'))).toEqual(['AW-NewUnprovisioned: newService.ts']);
  });

  it('detects removal from main even when the table definition still exists', async () => {
    const broken = fs.readFileSync(creationScript, 'utf8').replace('await createUsersTable();', '');
    expect(missingTables(references, await definedTables('production', broken))).toEqual([expect.stringMatching(/^AW-Users:/)]);
  });
});
