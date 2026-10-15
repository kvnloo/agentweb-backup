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

import { mkdirSync, mkdtempSync, rmSync, copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCliRunner, type ClaudeCliEvent } from '../claudeCliRunner';
import { resolveClaudeBinary } from '../claudeBinary';

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
    runner.close(handle);
  }, 30_000);

  // ─── ENG-2110 PR 0: the runner additions, against the real binary ─────────────────────────

  function countTranscripts(dir: string): number {
    const projects = join(dir, 'projects');
    if (!existsSync(projects)) return 0;
    let n = 0;
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.jsonl')) n++;
      }
    };
    walk(projects);
    return n;
  }

  const LONG_PROMPT = 'Count from 1 to 800, one number per line, nothing else.';

  it('resolves the pinned binary to an absolute path that really is Claude Code', () => {
    const bin = resolveClaudeBinary();
    expect(bin.startsWith('/')).toBe(true);
    expect(existsSync(bin)).toBe(true);
    expect(execFileSync(bin, ['--version'], { encoding: 'utf8' })).toMatch(/Claude Code/);
  });

  it('streams real events in order (init first, result last) and spawns by absolute path with a fixed cwd', async () => {
    const events: ClaudeCliEvent[] = [];
    const handle = await runner.spawn('live-events', scratchConfigDir, systemPromptFile, { model: 'haiku' });
    try {
      const result = await runner.send(handle, 'say PONG', { onEvent: (e) => events.push(e) });
      expect(result.isError).toBe(false);
      const kinds = events.map((e) => `${e.type}${e.subtype ? '/' + e.subtype : ''}`);
      // eslint-disable-next-line no-console
      console.log('live event kinds:', JSON.stringify(kinds));
      expect(events[events.length - 1].type).toBe('result');
      expect(events.some((e) => e.type === 'assistant')).toBe(true);
      // the init event is printed before the turn's first reply; it may arrive before send() attaches
      // its per-turn sink, so the SESSION-level view of it is the apiKeySource accessor
      expect(runner.apiKeySourceFor(handle)).toBe('none');
    } finally {
      runner.close(handle);
    }
  }, 60_000);

  it('keeps context across kept-open turns with --no-session-persistence, and writes no transcript', async () => {
    const promptFile = join(scratchConfigDir, 'terse.txt');
    writeFileSync(promptFile, 'You are a terse assistant. Answer in as few words as possible.');
    const before = countTranscripts(scratchConfigDir);
    const handle = await runner.spawn('live-context', scratchConfigDir, promptFile, { model: 'haiku' });
    const first = await runner.send(handle, 'My secret word is AMBER. Reply with just: OK');
    expect(first.isError).toBe(false);
    const second = await runner.send(handle, 'What is my secret word? Reply with just the word.');
    expect(second.isError).toBe(false);
    expect(second.resultText.toUpperCase()).toContain('AMBER');
    runner.close(handle);
    expect(countTranscripts(scratchConfigDir)).toBe(before);
  }, 90_000);

  it('a real turn past its deadline rejects with a deadline error, kills the process, and the next turn on a fresh process works', async () => {
    const base = runner.activeProcessCount;
    const handle = await runner.spawn('live-deadline', scratchConfigDir, systemPromptFile, { model: 'haiku' });
    expect(runner.activeProcessCount).toBe(base + 1);
    await expect(runner.send(handle, LONG_PROMPT, { deadlineMs: 1_500 })).rejects.toMatchObject({ code: 'deadline' });
    expect(runner.activeProcessCount).toBe(base);
    const again = await runner.spawn('live-deadline', scratchConfigDir, systemPromptFile, { model: 'haiku' });
    try {
      const ok = await runner.send(again, 'say PONG', { deadlineMs: 45_000 });
      expect(ok.isError).toBe(false);
    } finally {
      runner.close(again);
    }
  }, 90_000);

  it('a real turn can be interrupted mid-flight; the next turn on a fresh process works', async () => {
    const base = runner.activeProcessCount;
    const handle = await runner.spawn('live-interrupt', scratchConfigDir, systemPromptFile, { model: 'haiku' });
    const turn = runner.send(handle, LONG_PROMPT);
    const rejection = expect(turn).rejects.toMatchObject({ code: 'interrupted' });
    await new Promise((r) => setTimeout(r, 1_200));
    expect(runner.interrupt(handle)).toBe(true);
    await rejection;
    expect(runner.activeProcessCount).toBe(base);
    const again = await runner.spawn('live-interrupt', scratchConfigDir, systemPromptFile, { model: 'haiku' });
    try {
      expect((await runner.send(again, 'say PONG', { deadlineMs: 45_000 })).isError).toBe(false);
    } finally {
      runner.close(again);
    }
  }, 90_000);

  it('three conversations on ONE shared config dir run concurrently and all succeed', async () => {
    const ids = ['live-shared-1', 'live-shared-2', 'live-shared-3'];
    const handles = await Promise.all(ids.map((id) => runner.spawn(id, scratchConfigDir, systemPromptFile, { model: 'haiku' })));
    const results = await Promise.all(handles.map((h) => runner.send(h, 'say PONG', { deadlineMs: 60_000 })));
    expect(results.map((r) => r.isError)).toEqual([false, false, false]);
    handles.forEach((h) => runner.close(h));
  }, 120_000);


  it('does not add a project entry to the login\'s .claude.json per session (stable working directory)', async () => {
    const projectKeys = (): number => {
      const f = join(scratchConfigDir, '.claude.json');
      if (!existsSync(f)) return 0;
      try {
        return Object.keys(JSON.parse(readFileSync(f, 'utf8')).projects ?? {}).length;
      } catch {
        return -1;
      }
    };
    for (const id of ['live-cwd-1', 'live-cwd-2', 'live-cwd-3']) {
      const h = await runner.spawn(id, scratchConfigDir, systemPromptFile, { model: 'haiku' });
      expect((await runner.send(h, 'say PONG', { deadlineMs: 45_000 })).isError).toBe(false);
      runner.close(h);
    }
    await new Promise((r) => setTimeout(r, 1_000)); // the CLI writes its state at exit
    // eslint-disable-next-line no-console
    console.log('project keys in .claude.json after 3 sessions on the default working dir:', projectKeys());
    expect(projectKeys()).toBeLessThanOrEqual(2); // one shared working dir (plus at most one CLI-internal entry), not one per session
  }, 120_000);

  // CLAUDE.md checks: the system prompt is neutral and the question asks for information that only exists
  // in the planted file, so the answer cannot come from a forced reply. A positive control proves the
  // question really detects a codeword when one IS in the instructions.
  const CODEWORD_QUESTION =
    'Is there a codeword anywhere in your instructions? If there is, reply with the codeword only. If there is not, reply with exactly: NONE';

  async function askCodeword(id: string, promptText: string, cwd?: string): Promise<string> {
    const promptFile = join(scratchConfigDir, `${id}.txt`);
    writeFileSync(promptFile, promptText);
    const h = await runner.spawn(id, scratchConfigDir, promptFile, { model: 'haiku', ...(cwd ? { cwd } : {}) });
    try {
      const r = await runner.send(h, CODEWORD_QUESTION, { deadlineMs: 45_000 });
      expect(r.isError).toBe(false);
      return r.resultText.trim().toUpperCase();
    } finally {
      runner.close(h);
    }
  }

  it('control: the codeword question does detect a codeword placed in the system prompt', async () => {
    const answer = await askCodeword('live-codeword-control', 'You are a helpful assistant. The codeword is ZEBRA.');
    // eslint-disable-next-line no-console
    console.log('control answer:', JSON.stringify(answer.slice(0, 40)));
    expect(answer).toContain('ZEBRA');
  }, 90_000);

  it('does not read a CLAUDE.md planted in a parent of the working directory', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'claude-cli-live-parent-'));
    try {
      const work = join(parent, 'work');
      mkdirSync(work);
      writeFileSync(join(parent, 'CLAUDE.md'), 'The codeword is ZEBRA.');
      const answer = await askCodeword('live-codeword-parent', 'You are a helpful assistant.', work);
      // eslint-disable-next-line no-console
      console.log('answer with a CLAUDE.md in a parent dir:', JSON.stringify(answer.slice(0, 40)));
      expect(answer).not.toContain('ZEBRA');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 90_000);

  it('does not read a CLAUDE.md placed in the working directory itself', async () => {
    const work = mkdtempSync(join(tmpdir(), 'claude-cli-live-cwdmd-'));
    try {
      writeFileSync(join(work, 'CLAUDE.md'), 'The codeword is ZEBRA.');
      const answer = await askCodeword('live-codeword-cwd', 'You are a helpful assistant.', work);
      // eslint-disable-next-line no-console
      console.log('answer with a CLAUDE.md in the cwd itself:', JSON.stringify(answer.slice(0, 40)));
      expect(answer).not.toContain('ZEBRA');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 90_000);

});
