/**
 * SDK-construction guard (the lint substitute for shadow metering).
 *
 * Direct LLM SDK client construction bypasses the metered factory in
 * src/utils/llmClients.ts, which means those calls are invisible to usage
 * metering. This test greps backend/src for direct constructions and fails if
 * one appears OUTSIDE the allowlist.
 *
 * The allowlist is seeded with the files that already construct clients today
 * (pre-migration). As the migration moves call sites onto llmClients.ts,
 * REMOVE entries from the allowlist — never add new ones without a very good
 * reason (e.g. a non-inference use of the SDK).
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.join(__dirname, '..');

/** Patterns that indicate a direct (unmetered) inference SDK construction. */
const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'new OpenAI(', re: /new\s+OpenAI\s*\(/ },
  { name: 'new AzureOpenAI(', re: /new\s+AzureOpenAI\s*\(/ },
  { name: 'new BedrockRuntimeClient(', re: /new\s+BedrockRuntimeClient\s*\(/ },
  { name: 'new GoogleGenAI(', re: /new\s+GoogleGenAI\s*\(/ },
];

/**
 * Finds both literal SDK construction and the common import-alias bypass.
 * This is intentionally source-level rather than a lint rule: it runs in the
 * existing Jest gate and covers TypeScript's default and named import forms.
 */
function findForbiddenSdkConstruction(content: string): string[] {
  const found = FORBIDDEN_PATTERNS
    .filter(({ re }) => re.test(content))
    .map(({ name }) => name);

  const aliases: Array<{ packageName: string; exportName?: string }> = [
    { packageName: 'openai' },
    { packageName: '@google/genai', exportName: 'GoogleGenAI' },
    { packageName: '@aws-sdk/client-bedrock-runtime', exportName: 'BedrockRuntimeClient' },
    { packageName: '@azure/openai', exportName: 'AzureOpenAI' },
  ];

  for (const { packageName, exportName } of aliases) {
    const escapedPackage = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aliasMatch = exportName
      ? new RegExp(`import\\s+\\{[^}]*\\b${exportName}\\s+as\\s+([A-Za-z_$][\\w$]*)[^}]*\\}\\s+from\\s+['\"]${escapedPackage}['\"]`).exec(content)
      : new RegExp(`import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s+['\"]${escapedPackage}['\"]`).exec(content);
    const alias = aliasMatch?.[1];
    if (alias && new RegExp(`new\\s+${alias}\\s*\\(`).test(content)) {
      found.push(`aliased ${exportName || packageName} construction (${alias})`);
    }
  }

  return found;
}

/**
 * Files allowed to construct SDK clients directly, relative to src/.
 *
 * - utils/llmClients.ts — the metered factory itself (the ONLY long-term home)
 * - utils/llmService.ts — metered internally via usageRecorderService
 * - everything else — legacy call sites seeded at guard creation (2026-06-12);
 *   the migration phase removes them one by one.
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
]);

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests construct mocks freely; node_modules never appears under src.
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      listSourceFiles(full, acc);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe('SDK construction guard', () => {
  it('no direct LLM SDK construction outside llmClients.ts + the seeded allowlist', () => {
    const violations: string[] = [];

    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const content = fs.readFileSync(file, 'utf8');
      const constructions = findForbiddenSdkConstruction(content);
      if (constructions.length > 0 && !ALLOWLIST.has(rel)) {
        violations.push(`${rel} contains ${constructions.map((name) => `"${name}"`).join(', ')}`);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        'Direct LLM SDK construction found outside the metered factory.\n' +
          'Use getOpenAIClient/getAzureClient/getBedrockClient/getGeminiClient ' +
          'from src/utils/llmClients.ts instead (so usage is metered), or — only if this is ' +
          'genuinely not an inference client — add the file to the allowlist in ' +
          'src/__tests__/sdkConstructionGuard.test.ts with a justification.\n\nViolations:\n' +
          violations.map((v) => `  - ${v}`).join('\n')
      );
    }
  });

  it('allowlist entries still exist and still construct clients (prunes stale entries)', () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST) {
      const full = path.join(SRC_ROOT, rel);
      if (!fs.existsSync(full)) {
        stale.push(`${rel} (file deleted — remove from allowlist)`);
        continue;
      }
      const content = fs.readFileSync(full, 'utf8');
      const stillConstructs = FORBIDDEN_PATTERNS.some(({ re }) => re.test(content));
      if (!stillConstructs) {
        stale.push(`${rel} (no longer constructs an SDK client — remove from allowlist)`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe('SDK construction guard alias resistance (ENG-1414)', () => {
  it.each([
    ["import Client from 'openai';\nnew Client({ apiKey: 'x' });"],
    ["import { GoogleGenAI as Client } from '@google/genai';\nnew Client({ apiKey: 'x' });"],
    ["import { BedrockRuntimeClient as Client } from '@aws-sdk/client-bedrock-runtime';\nnew Client({});"],
  ])('detects a forbidden SDK import alias', (source) => {
    expect(findForbiddenSdkConstruction(source)).not.toEqual([]);
  });

  it('does not flag a type-only SDK import without construction', () => {
    expect(findForbiddenSdkConstruction("import type OpenAI from 'openai';")).toEqual([]);
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
