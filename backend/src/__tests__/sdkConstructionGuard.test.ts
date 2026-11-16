/**
 * SDK-construction guard (the lint substitute for shadow metering).
 *
 * Direct LLM SDK client construction bypasses the metered factory in
 * src/utils/llmClients.ts, which means those calls are invisible to usage
 * metering. This test parses backend/src and fails when a provider import
 * appears outside the allowlist, regardless of construction spelling.
 *
 * The allowlist is seeded with the files that already construct clients today
 * (pre-migration). As the migration moves call sites onto llmClients.ts,
 * REMOVE entries from the allowlist — never add new ones without a very good
 * reason (e.g. a non-inference use of the SDK).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { spawnSync } from 'child_process';

const SRC_ROOT = path.join(__dirname, '..');
const AGENT_ENGINE_ROOT = path.join(SRC_ROOT, '..', '..', 'agent-engine');

/**
 * Importing a text/chat provider SDK is the architectural boundary. AST
 * traversal (rather than regex or `new Foo`) closes alias, factory, require,
 * dynamic-import, TSX, and comment/string false-positive gaps.
 */
const DIRECT_TEXT_PROVIDER_SDKS = [
  'openai',
  '@google/genai',
  '@google/generative-ai',
  '@aws-sdk/client-bedrock-runtime',
  '@azure/openai',
  '@anthropic-ai/sdk',
  '@langchain/openai',
  '@langchain/aws',
  '@langchain/google-genai',
  '@langchain/anthropic',
] as const;

/**
 * True when a declaration can only ever bring TYPES from a provider SDK
 * (ENG-1937).
 *
 * TypeScript erases these at compile time, so they cannot construct a client
 * or call the SDK at runtime — the thing this guard exists to stop. Flagging
 * them made a module that merely names `OpenAI` in an interface
 * (agentMode/llmModelRegistry.ts) fail the build as if it constructed one.
 *
 * Deliberately narrow: a declaration is type-only only when NOTHING in it is a
 * value. `import { type A, B }` still imports `B` and is still flagged, as is a
 * bare side-effect `import 'openai'`.
 */
function isTypeOnlyDeclaration(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false; // side-effect import: runs the module
    if (clause.isTypeOnly) return true; // import type X / import type { X }
    if (clause.name) return false; // a default import is a value
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return false; // import * as X
    return bindings.elements.length > 0 && bindings.elements.every((el) => el.isTypeOnly);
  }
  if (node.isTypeOnly) return true; // export type { X } from '…'
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false; // export * from '…'
  return clause.elements.length > 0 && clause.elements.every((el) => el.isTypeOnly);
}

function findDirectProviderSdkImports(content: string, fileName = 'source.ts'): string[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const recordModule = (moduleSpecifier: ts.Expression | undefined): void => {
    if (!moduleSpecifier || !ts.isStringLiteralLike(moduleSpecifier)) return;
    if ((DIRECT_TEXT_PROVIDER_SDKS as readonly string[]).includes(moduleSpecifier.text)) {
      found.add(moduleSpecifier.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (!isTypeOnlyDeclaration(node)) recordModule(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) recordModule(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return DIRECT_TEXT_PROVIDER_SDKS.filter((packageName) => found.has(packageName));
}

/**
 * Files allowed to construct SDK clients directly, relative to src/.
 *
 * - utils/llmClients.ts — the metered factory itself (the ONLY long-term home)
 * - capability exceptions are documented below and must remain non-text or
 *   independently metered. The list must shrink, never grow, as migrations land.
 */
const ALLOWLIST = new Set<string>([
  'utils/llmClients.ts',
  // ── metered internally (constructions are justified, usage IS recorded) ──
  // agentModeService: every client funnels through callLLM, which has a
  // recordUsage hook — constructions here are metered without the factory.
  'services/agentModeService.ts',
  // emma/impl/searchResearch.ts (ENG-2103 F2 extraction, pre-existing capability
  // unchanged by the move): performDataAnalysis's Gemini code-execution client
  // is not a text/chat call routable through the OpenRouter gateway — it needs
  // Gemini's own sandboxed code-execution tool to analyze uploaded CSV/data
  // files. Independently metered via meterUsageFromResponse (utils/llmClients.ts),
  // same non-factory-but-still-metered shape as the other documented exceptions below. This
  // call site used to be covered by the broad agentModeService.ts entry above
  // before the extraction; scoping it to this file is narrower, not new.
  'emma/impl/searchResearch.ts',
  // liveVoiceService: Gemini Live WebSocket (ai.live.connect) — not wrapped by
  // the factory; usage recorded directly from usageMetadata in
  // handleIncomingMessage. Module-level singleton is intentional.
  'services/liveVoiceService.ts',
  // chatbotService constructs Azure's embeddings client for semantic search;
  // its chat/text generation path routes through AgentModeService.callLLM.
  'services/chatbotService.ts',
  'services/codingAgentService.ts',
]);

const DIRECT_PYTHON_TEXT_PROVIDER_MODULES = [
  'openai',
  'anthropic',
  'langchain_openai',
  'langchain_aws',
  'langchain_google_genai',
  'langchain_anthropic',
  'google.genai',
] as const;

const AGENT_ENGINE_ALLOWLIST = new Set<string>([
  // The only text/tool client construction seam after ENG-1450.
  'openrouter_gateway.py',
  // Bounded non-text capability exceptions: image generation/editing and
  // Gemini file/video analysis. These remain tracked for ENG-1452 review.
  'web_agent.py',
]);

const PYTHON_IMPORT_AST_SCRIPT = [
  'import ast, json, sys',
  'tree = ast.parse(sys.stdin.read())',
  'modules = []',
  'for node in ast.walk(tree):',
  '    if isinstance(node, ast.Import):',
  '        modules.extend(alias.name for alias in node.names)',
  '    elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:',
  '        modules.append(node.module)',
  '        modules.extend(f"{node.module}.{alias.name}" for alias in node.names)',
  'print(json.dumps(modules))',
].join('\n');

// The repo's production f-strings (e.g. agent-engine/app/services/mcp_client.py)
// use syntax Python 3.10 cannot parse (ENG-1433: a backslash inside an f-string
// expression, valid since 3.12). CI runs a modern interpreter, but a headless
// post-merge-verifier host's `python3` can resolve to whatever the OS shipped
// (3.10.12 on Ubuntu 22.04) regardless of what's actually installed alongside it.
// Probe for a compatible interpreter instead of trusting bare `python3` on PATH.
let cachedPython3: string | null = null;
function resolvePython3(): string {
  if (cachedPython3) return cachedPython3;
  const candidates = [
    'python3.13',
    'python3.12',
    'python3.11',
    // uv-managed installs (common on dev/agent boxes) aren't always on PATH.
    `${process.env.HOME || ''}/.local/bin/python3.12`,
    `${process.env.HOME || ''}/.local/bin/python3.11`,
    '/usr/bin/python3.12',
    '/usr/bin/python3.11',
    'python3',
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-c', 'import sys; assert sys.version_info >= (3, 11)'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) {
      cachedPython3 = candidate;
      return candidate;
    }
  }
  // Nothing satisfies >=3.11 — fall back to plain python3 so the original
  // error (a real parse failure, now correctly attributable to the source
  // file rather than the host) still surfaces instead of silently no-op'ing.
  cachedPython3 = 'python3';
  return 'python3';
}

function findDirectPythonProviderImports(content: string): string[] {
  const parsed = spawnSync(resolvePython3(), ['-c', PYTHON_IMPORT_AST_SCRIPT], {
    input: content,
    encoding: 'utf8',
  });
  if (parsed.status !== 0) {
    throw new Error(`Unable to parse agent-engine Python source: ${parsed.stderr || 'unknown error'}`);
  }
  const importedModules = JSON.parse(parsed.stdout) as string[];
  return DIRECT_PYTHON_TEXT_PROVIDER_MODULES.filter((providerModule) =>
    importedModules.some((importedModule) =>
      importedModule === providerModule || importedModule.startsWith(`${providerModule}.`),
    ),
  );
}

function assertNoForbiddenProviderImports(file: string, content: string): void {
  const imports = findDirectProviderSdkImports(content, file);
  if (imports.length > 0 && !ALLOWLIST.has(file)) {
    throw new Error(
      `Direct provider SDK import in ${file}: ${imports.join(', ')}. ` +
      'Route text/chat/tool calls through the approved OpenRouter gateway, or add a documented capability exception with owner, evidence, review date, removal condition, and affected call sites.',
    );
  }
}

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests construct mocks freely; node_modules never appears under src.
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
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

function listPythonSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['tests', '__pycache__', '.venv', 'venv'].includes(entry.name)) continue;
      listPythonSourceFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('SDK construction guard', () => {
  it('no direct text/chat provider SDK import exists outside the gateway, approved exceptions, or inventory-owned migration entries', () => {
    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const content = fs.readFileSync(file, 'utf8');
      assertNoForbiddenProviderImports(rel, content);
    }
  });

  it('allowlist entries still exist and still import a direct provider SDK (prunes stale entries)', () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST) {
      const full = path.join(SRC_ROOT, rel);
      if (!fs.existsSync(full)) {
        stale.push(`${rel} (file deleted — remove from allowlist)`);
        continue;
      }
      const content = fs.readFileSync(full, 'utf8');
      if (findDirectProviderSdkImports(content).length === 0) {
        stale.push(`${rel} (no longer imports a direct provider SDK — remove from allowlist)`);
      }
    }
    expect(stale).toEqual([]);
  });

  it('does not retain unreachable AgentMode text-provider adapter remnants after gateway cutover', () => {
    const agentModeSource = fs.readFileSync(path.join(SRC_ROOT, 'services/agentModeService.ts'), 'utf8');

    // These only supported the deleted Vertex Claude text adapter. Keeping them
    // makes a future direct-provider revival look supported even though every
    // text/tool request now crosses the OpenRouter gateway.
    expect(agentModeSource).not.toContain('vertex_client');
    expect(agentModeSource).not.toContain('vertex_client_promise');
    expect(agentModeSource).not.toContain('convertContentToAnthropicBlocks');
  });
});

describe('SDK construction guard ignores type-only imports (ENG-1937)', () => {
  it.each([
    ["import type OpenAI from 'openai';\nlet c: OpenAI | null = null;"],
    ["import type { ChatCompletion } from 'openai/resources';\nimport type { OpenAI } from 'openai';"],
    ["import { type OpenAI, type ClientOptions } from 'openai';"],
    ["export type { OpenAI } from 'openai';"],
    ["export { type OpenAI } from '@azure/openai';"],
  ])('allows a declaration that can only bring types: %s', (source) => {
    expect(() => assertNoForbiddenProviderImports('services/newConsumer.ts', source)).not.toThrow();
  });

  it.each([
    // One value binding is enough to reach the SDK at runtime.
    ["import { type ClientOptions, OpenAI } from 'openai';"],
    // A default import beside type-only named imports is a value.
    ["import OpenAI, { type ClientOptions } from 'openai';"],
    // A side-effect import runs the module.
    ["import 'openai';"],
    // Re-exporting everything includes values.
    ["export * from 'openai';"],
    ["import * as sdk from 'openai';"],
  ])('still rejects a declaration with any runtime value: %s', (source) => {
    expect(() => assertNoForbiddenProviderImports('services/newConsumer.ts', source)).toThrow(/Direct provider SDK import/);
  });
});

describe('SDK construction guard alias resistance (ENG-1414)', () => {
  it.each([
    ["import Client from 'openai';\nmakeClient(Client);"],
    ["import/* comment */ Client from 'openai';\nnew Client();"],
    ["import * as Google from '@google/genai';\nGoogle.makeClient();"],
    ["export { OpenAI } from '@azure/openai';"],
    ["const sdk = require('@aws-sdk/client-bedrock-runtime');\nmakeClient(sdk);"],
    ["const sdk = await import(\n  '@azure/openai'\n);\nmakeClient(sdk);"],
  ])('rejects a deliberately introduced forbidden provider import regardless of construction spelling', (source) => {
    expect(() => assertNoForbiddenProviderImports('services/newConsumer.ts', source)).toThrow(/Direct provider SDK import/);
  });

  it('parses TSX imports instead of skipping backend TSX source', () => {
    expect(() => assertNoForbiddenProviderImports(
      'services/newConsumer.tsx',
      "import Client from 'openai';\nexport const view = <div>{Client.name}</div>;",
    )).toThrow(/Direct provider SDK import/);
  });

  it('ignores provider-looking text inside comments and strings', () => {
    expect(() => assertNoForbiddenProviderImports(
      'services/commentOnly.ts',
      "// import Client from 'openai';\nconst example = \"require('@google/genai')\";",
    )).not.toThrow();
  });

  it('passes the approved gateway and documented non-text exceptions', () => {
    expect(() => assertNoForbiddenProviderImports('utils/llmClients.ts', "import OpenAI from 'openai';")).not.toThrow();
    expect(() => assertNoForbiddenProviderImports('services/liveVoiceService.ts', "import { GoogleGenAI } from '@google/genai';")).not.toThrow();
  });
});

describe('agent-engine provider import guard (ENG-1414)', () => {
  it.each([
    ['from openai import OpenAI\nclient = OpenAI()'],
    ['import anthropic as provider\nclient = provider.Anthropic()'],
    ['from langchain_openai import (\n    ChatOpenAI as Client,\n)\nclient = Client()'],
    ['from google import genai\nclient = genai.Client()'],
  ])('detects a deliberately introduced Python provider import', (source) => {
    expect(findDirectPythonProviderImports(source)).not.toEqual([]);
  });

  it('ignores provider-looking text in Python comments and strings', () => {
    expect(findDirectPythonProviderImports([
      '# from openai import OpenAI',
      'example = "import anthropic"',
      'long_example = """from langchain_openai import ChatOpenAI"""',
      'from .openai import OpenAI',
    ].join('\n'))).toEqual([]);
  });

  it('has no new direct provider import outside the ENG-1416 migration inventory', () => {
    for (const file of listPythonSourceFiles(AGENT_ENGINE_ROOT)) {
      const rel = path.relative(AGENT_ENGINE_ROOT, file).split(path.sep).join('/');
      const imports = findDirectPythonProviderImports(fs.readFileSync(file, 'utf8'));
      if (imports.length > 0 && !AGENT_ENGINE_ALLOWLIST.has(rel)) {
        throw new Error(
          `Direct provider SDK import in agent-engine/${rel}: ${imports.join(', ')}. ` +
          'Route text/chat/tool calls through the approved OpenRouter gateway or document a bounded capability exception.',
        );
      }
    }
  });

  it('prunes agent-engine allowlist entries after their direct imports move', () => {
    const stale: string[] = [];
    for (const rel of AGENT_ENGINE_ALLOWLIST) {
      const full = path.join(AGENT_ENGINE_ROOT, rel);
      if (!fs.existsSync(full)) {
        stale.push(`${rel} (file deleted — remove from allowlist)`);
        continue;
      }
      if (findDirectPythonProviderImports(fs.readFileSync(full, 'utf8')).length === 0) {
        stale.push(`${rel} (no longer imports a direct provider SDK — remove from allowlist)`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/**
 * ENG-683 — Bedrock inference-profile drift guard.
 *
 * The model-id -> inference-profile mapping used to live in FOUR hand-synced
 * copies (agentModeService, codingAgentService, llmService, rcaEnricher). It
 * drifted: two copies were missing `anthropic.claude-opus-4-8`. Same failure
 * shape as the guard above — a duplicated fact silently going stale — so it
 * gets the same treatment: grep the source, fail if a second copy appears.
 */
const PROFILE_SOURCE_OF_TRUTH = 'utils/bedrockInferenceProfiles.ts';

/** Literals that only ever belong in the source-of-truth module. */
const PROFILE_LITERAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Full cross-region inference-profile ARN, e.g.
  // arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6
  { name: 'inference-profile ARN literal', re: /arn:aws:bedrock:[^'"`\s]*inference-profile/ },
  // Bare cross-region profile id for the bearer-token account, e.g.
  // us.anthropic.claude-opus-4-8
  { name: 'us.anthropic.* profile id literal', re: /['"`]us\.anthropic\.[^'"`]+['"`]/ },
];

describe('Bedrock inference-profile drift guard (ENG-683)', () => {
  it('inference-profile literals appear in exactly one non-test file', () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (rel === PROFILE_SOURCE_OF_TRUTH) continue;
      const content = fs.readFileSync(file, 'utf8');
      for (const { name, re } of PROFILE_LITERAL_PATTERNS) {
        if (re.test(content)) {
          offenders.push(`${rel} contains ${name}`);
        }
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        'A second copy of the Bedrock inference-profile mapping was reintroduced.\n' +
          `Import BEDROCK_INFERENCE_PROFILE_MAP / resolveBedrockModelId from ` +
          `src/${PROFILE_SOURCE_OF_TRUTH} instead of restating the ARN.\n\nOffenders:\n` +
          offenders.map((o) => `  - ${o}`).join('\n')
      );
    }
  });

  it('the source-of-truth module actually exists and holds the literals', () => {
    const full = path.join(SRC_ROOT, PROFILE_SOURCE_OF_TRUTH);
    expect(fs.existsSync(full)).toBe(true);
    const content = fs.readFileSync(full, 'utf8');
    for (const { re } of PROFILE_LITERAL_PATTERNS) {
      expect(re.test(content)).toBe(true);
    }
  });
});
