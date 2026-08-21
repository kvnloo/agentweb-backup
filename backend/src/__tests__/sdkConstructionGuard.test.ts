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
      recordModule(node.moduleSpecifier);
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
 * - utils/llmService.ts — metered internally via usageRecorderService
 * - temporary migration inventory entries name their owning slice and are not
 *   capability exceptions. They must shrink, never grow, as ENG-1415/1416 land.
 */
const ALLOWLIST = new Set<string>([
  'utils/llmClients.ts',
  'utils/llmService.ts',
  // ── metered internally (constructions are justified, usage IS recorded) ──
  // agentModeService: every client funnels through callLLM, which has a
  // recordUsage hook — constructions here are metered without the factory.
  'services/agentModeService.ts',
  // liveVoiceService: Gemini Live WebSocket (ai.live.connect) — not wrapped by
  // the factory; usage recorded directly from usageMetadata in
  // handleIncomingMessage. Module-level singleton is intentional.
  'services/liveVoiceService.ts',
  // videoGeneration: Veo video generation via GoogleGenAI. Billed per-video,
  // not per-token — token metering does not apply. Video/image cost is tracked
  // separately (incrementUserTokenUsage cost-only path in agentModeService).
  'services/videoGeneration.ts',
  // Transitional, inventory-owned direct text routes; not permanent exceptions.
  'services/chatbotService.ts',
  'services/codingAgentService.ts',
  'loops/instances/ai-eval-funnel/rcaEnricher.ts',
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
  // Transitional text routes owned by ENG-1416. web_agent.py also contains
  // separately documented image-generation imports that remain out of scope.
  'task_monitor.py',
  'task_utils.py',
  'web_agent.py',
]);

const PYTHON_IMPORT_AST_SCRIPT = [
  'import ast, json, sys',
  'tree = ast.parse(sys.stdin.read())',
  'modules = []',
  'for node in ast.walk(tree):',
  '    if isinstance(node, ast.Import):',
  '        modules.extend(alias.name for alias in node.names)',
  '    elif isinstance(node, ast.ImportFrom) and node.module:',
  '        modules.append(node.module)',
  'print(json.dumps(modules))',
].join('\n');

function findDirectPythonProviderImports(content: string): string[] {
  const parsed = spawnSync('python3', ['-c', PYTHON_IMPORT_AST_SCRIPT], {
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
    expect(() => assertNoForbiddenProviderImports('services/videoGeneration.ts', "const sdk = require('@google/genai');")).not.toThrow();
  });
});

describe('agent-engine provider import guard (ENG-1414)', () => {
  it.each([
    ['from openai import OpenAI\nclient = OpenAI()'],
    ['import anthropic as provider\nclient = provider.Anthropic()'],
    ['from langchain_openai import (\n    ChatOpenAI as Client,\n)\nclient = Client()'],
  ])('detects a deliberately introduced Python provider import', (source) => {
    expect(findDirectPythonProviderImports(source)).not.toEqual([]);
  });

  it('ignores provider-looking text in Python comments and strings', () => {
    expect(findDirectPythonProviderImports([
      '# from openai import OpenAI',
      'example = "import anthropic"',
      'long_example = """from langchain_openai import ChatOpenAI"""',
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
