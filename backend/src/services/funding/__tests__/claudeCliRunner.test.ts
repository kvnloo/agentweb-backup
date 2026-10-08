import { EventEmitter } from 'events';
import { Readable } from 'stream';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdtempSync: jest.fn((prefix: string) => `${prefix}fake`),
  rmSync: jest.fn(),
}));

import { spawn as mockSpawnFn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { ClaudeCliRunner } from '../claudeCliRunner';

const mockSpawn = mockSpawnFn as jest.Mock;
const mockRmSync = rmSync as jest.Mock;

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stdin: { write: jest.Mock };
  kill: jest.Mock;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stdin = { write: jest.fn() };
  child.kill = jest.fn();
  return child;
}

function emitResult(child: FakeChild, result: Record<string, unknown>): void {
  child.stdout.push(JSON.stringify(result) + '\n');
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const CONFIG_DIR = '/scratch/login-dir';
const SYSTEM_PROMPT_FILE = '/scratch/system-prompt.txt';

describe('ClaudeCliRunner', () => {
  const spawnedChildren: FakeChild[] = [];
  const activeRunners: ClaudeCliRunner[] = [];
  const originalEnv = process.env;

  // Every ClaudeCliRunner created in a test must be tracked here so afterEach can
  // close it — an un-closed session leaves a real 10-minute idle-close setTimeout
  // running, which leaks past the test and forces jest to hard-exit the worker.
  function trackedRunner(opts?: ConstructorParameters<typeof ClaudeCliRunner>[0]): ClaudeCliRunner {
    const runner = new ClaudeCliRunner(opts);
    activeRunners.push(runner);
    return runner;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    spawnedChildren.length = 0;
    activeRunners.length = 0;
    mockSpawn.mockImplementation(() => {
      const child = createFakeChild();
      spawnedChildren.push(child);
      return child;
    });
    process.env = { ...originalEnv, PATH: '/usr/bin:/bin' };
  });

  afterEach(() => {
    activeRunners.forEach((runner) => runner.closeAll());
    process.env = originalEnv;
  });

  // ─── Env lockdown — the ticket's own named risk: a stray ANTHROPIC_* var in the
  // backend's real env must never reach the child, or a subscription run silently
  // bills as API usage. ──────────────────────────────────────────────────────────

  it('never passes the backend process env through — only the explicit allowlist', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-leaked-if-this-test-fails';
    process.env.ANTHROPIC_AUTH_TOKEN = 'also-leaked-if-this-test-fails';
    process.env.AWS_SECRET_ACCESS_KEY = 'also-leaked-if-this-test-fails';

    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);

    const [, , options] = mockSpawn.mock.calls[0];
    expect(options.env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: expect.stringContaining('claude-cli-home-'),
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_THINKING: '1',
      CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    });
  });

  it('builds every lockdown flag the ticket requires', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { model: 'haiku' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--system-prompt-file',
      SYSTEM_PROMPT_FILE,
      '--tools',
      '',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--model',
      'haiku',
    ]);
  });

  // ─── Turn round trip ────────────────────────────────────────────────────────

  it('resolves send() from the matching result event', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'say PONG');
    await flush();
    expect(child.stdin.write).toHaveBeenCalledWith(
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'say PONG' } }) + '\n',
    );

    emitResult(child, { type: 'result', subtype: 'success', is_error: false, result: 'PONG' });
    const outcome = await turn;
    expect(outcome).toEqual({ isError: false, resultText: 'PONG', raw: expect.objectContaining({ result: 'PONG' }) });
  });

  it('surfaces is_error: true from a real failure result', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'go');
    await flush();
    emitResult(child, { type: 'result', subtype: 'error', is_error: true, result: 'Not logged in' });
    const outcome = await turn;
    expect(outcome.isError).toBe(true);
  });

  it('rejects send() for a conversation with no open session', async () => {
    const runner = trackedRunner();
    await expect(runner.send({ conversationId: 'never-spawned' }, 'hi')).rejects.toThrow(/no open session/);
  });

  it('rejects a second send() while a turn is already in flight on the same session', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const firstTurn = runner.send(handle, 'first');
    await expect(runner.send(handle, 'second')).rejects.toThrow(/already in flight/);

    const child = spawnedChildren[0];
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await firstTurn;
  });

  // ─── apiKeySource capture — ENG-2107's own named contract assertion ─────────

  it('captures apiKeySource from the system/init event, ahead of any result', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    expect(runner.apiKeySourceFor(handle)).toBeUndefined();
    child.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }) + '\n');
    await flush();
    expect(runner.apiKeySourceFor(handle)).toBe('none');
  });

  // ─── Pool reuse ─────────────────────────────────────────────────────────────

  it('reuses the pooled session for a conversationId instead of spawning twice', async () => {
    const runner = trackedRunner();
    const first = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const second = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  // ─── Concurrency cap + queue ────────────────────────────────────────────────

  it('queues a spawn for a new conversation once the concurrency cap is full, releasing a slot on close', async () => {
    const runner = trackedRunner({ maxConcurrentProcesses: 1 });
    const handleA = await runner.spawn('conv-a', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    let spawnedB = false;
    const spawnBPromise = runner.spawn('conv-b', CONFIG_DIR, SYSTEM_PROMPT_FILE).then((handle) => {
      spawnedB = true;
      return handle;
    });
    await flush();
    expect(spawnedB).toBe(false);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    runner.close(handleA);
    await spawnBPromise;
    expect(spawnedB).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  // ─── Idle close ─────────────────────────────────────────────────────────────

  it('closes an idle session after the idle timeout and cleans up its scratch HOME dir', async () => {
    jest.useFakeTimers();
    const runner = trackedRunner({ idleCloseMs: 1000 });
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    jest.advanceTimersByTime(1001);
    expect(child.kill).toHaveBeenCalled();
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringContaining('claude-cli-home-'), { recursive: true, force: true });
    expect(runner.activeProcessCount).toBe(0);

    jest.useRealTimers();
    void handle;
  });

  it('a send() resets the idle timer so an active conversation is not closed mid-use', async () => {
    jest.useFakeTimers();
    const runner = trackedRunner({ idleCloseMs: 1000 });
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    jest.advanceTimersByTime(800);
    const turn = runner.send(handle, 'hi');
    jest.advanceTimersByTime(800);
    expect(child.kill).not.toHaveBeenCalled();

    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await turn;
    jest.useRealTimers();
  });

  // ─── Failure containment ────────────────────────────────────────────────────

  it('rejects an in-flight turn if the process exits before producing a result', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'hi');
    child.emit('exit', 1);
    await expect(turn).rejects.toThrow(/session closed/);
    expect(runner.activeProcessCount).toBe(0);
  });

  it('rejects an in-flight turn on a process error event', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'hi');
    child.emit('error', new Error('ENOENT'));
    await expect(turn).rejects.toThrow('ENOENT');
  });

  it('ignores non-JSON noise on stdout instead of crashing the session', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'hi');
    child.stdout.push('not json at all\n');
    await flush();
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
  });

  void mkdtempSync; // referenced only via the module under test; keeps the fs mock import used
});
