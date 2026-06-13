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
      for (const { name, re } of FORBIDDEN_PATTERNS) {
        if (re.test(content) && !ALLOWLIST.has(rel)) {
          violations.push(`${rel} contains "${name}"`);
        }
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
