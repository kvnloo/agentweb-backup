/**
 * ENG-2107's own named requirement: "add an adapter contract test on every version
 * bump that asserts system/init.apiKeySource == 'none' with a subscription-mode
 * login." `--bare` is documented to become the `-p` default in some future release
 * with no announced opt-out — this is the test that catches that the moment it ships.
 *
 * This needs a real, already-authenticated CLAUDE_CONFIG_DIR, which only exists on a
 * machine someone has actually logged in on — never minted by this test, never
 * committed, never available in CI. It skips itself cleanly when that directory isn't
 * provided. Run it by hand on every @anthropic-ai/claude-code version bump:
 *
 *   CLAUDE_CLI_LIVE_TEST_CONFIG_DIR=/path/to/a/real/logged-in/CLAUDE_CONFIG_DIR \
 *     npm test -- --runTestsByPath src/services/funding/__tests__/claudeCliRunner.live.test.ts
 */

import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCliRunner } from '../claudeCliRunner';

const liveConfigDir = process.env.CLAUDE_CLI_LIVE_TEST_CONFIG_DIR;
const describeOrSkip = liveConfigDir ? describe : describe.skip;

if (!liveConfigDir) {
  // eslint-disable-next-line no-console
  console.warn(
    'claudeCliRunner.live.test.ts skipped — set CLAUDE_CLI_LIVE_TEST_CONFIG_DIR to a real, ' +
      'already-authenticated CLAUDE_CONFIG_DIR to run the apiKeySource contract test for real.',
  );
}

describeOrSkip('ClaudeCliRunner — live apiKeySource contract (ENG-2107)', () => {
  let scratchConfigDir: string;
  let systemPromptFile: string;
  let runner: ClaudeCliRunner;

  beforeAll(() => {
    // Copy credentials into a scratch config dir rather than pointing at the real one
    // directly — this test must never race or rotate the token of the live login it
    // borrowed, and the copy is deleted again in afterAll.
    scratchConfigDir = mkdtempSync(join(tmpdir(), 'claude-cli-live-test-config-'));
    copyFileSync(join(liveConfigDir!, '.credentials.json'), join(scratchConfigDir, '.credentials.json'));

    systemPromptFile = join(scratchConfigDir, 'system-prompt.txt');
    require('fs').writeFileSync(systemPromptFile, 'Reply with exactly one word: PONG');

    runner = new ClaudeCliRunner();
  });

  afterAll(() => {
    runner.closeAll();
    rmSync(scratchConfigDir, { recursive: true, force: true });
  });

  it('reports apiKeySource: "none" under a subscription-mode login, not a silent API-key fallback', async () => {
    const handle = await runner.spawn('live-contract-probe', scratchConfigDir, systemPromptFile, { model: 'haiku' });
    const result = await runner.send(handle, 'say PONG');

    // The ticket's exact named assertion — not a substitute for it.
    expect(runner.apiKeySourceFor(handle)).toBe('none');
    expect(result.isError).toBe(false);
    expect((result.raw as any).subtype).toBe('success');
  }, 30_000);
});
