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
  stderr: Readable;
  stdin: { write: jest.Mock; on: jest.Mock };
  kill: jest.Mock;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = { write: jest.fn(), on: jest.fn() };
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
      MAX_THINKING_TOKENS: '0',
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

  it('serializes concurrent spawn() calls for the same conversationId onto one real process', async () => {
    const runner = trackedRunner();
    const [first, second] = await Promise.all([
      runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE),
      runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE),
    ]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('closeSessionInternal deletes by identity, not by key — a stale session cannot erase a different live one at the same key', async () => {
    // Regression for the fixed TOCTOU race: without the identity check, closing a
    // stale session object could delete a different, live session that has since
    // taken its old pool slot. spawn() itself now serializes concurrent calls so this
    // race can no longer arise through the public API — this exercises the guard directly.
    const runner = trackedRunner();
    const handleA = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const childA = spawnedChildren[0];
    const pool: Map<string, any> = (runner as any).pool;
    const sessionA = pool.get('conv-1');
    expect(sessionA).toBeDefined();

    const sessionB = { ...sessionA, closed: false };
    pool.set('conv-1', sessionB); // simulate B having since taken A's old slot

    childA.emit('exit', 0); // A's own process exiting late must not erase B
    expect(pool.get('conv-1')).toBe(sessionB);
    void handleA;
  });

  // ─── Pre-warm — spawn ahead of the first real turn, same pool, no double-spawn ──

  it('prewarm() opens a session with no turn in flight, reused by a later send()', async () => {
    const runner = trackedRunner();
    const handle = await runner.prewarm('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const turn = runner.send(handle, 'first real turn');
    const child = spawnedChildren[0];
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
    expect(mockSpawn).toHaveBeenCalledTimes(1); // still the pre-warmed process, not a second one
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

  it('enforces the cap across DIFFERENT conversationIds fired without awaiting between them', async () => {
    // Regression: the cap check used to read pool.size, which only grows after a spawn's
    // own async gap. Firing spawn() for several different conversationIds back-to-back,
    // with no await between them, let every one of them see the same stale pool.size (0)
    // before any had actually incremented it -- all bypassing the cap. Found live against
    // the real binary: cap=2, three real `claude -p` processes ended up running at once.
    // The existing cap test above never caught this because it awaits conv-a before
    // spawning conv-b, so pool.size was already correctly incremented by then.
    const runner = trackedRunner({ maxConcurrentProcesses: 2 });

    let cSpawned = false;
    const pA = runner.spawn('conv-a', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const pB = runner.spawn('conv-b', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const pC = runner.spawn('conv-c', CONFIG_DIR, SYSTEM_PROMPT_FILE).then((h) => {
      cSpawned = true;
      return h;
    });

    await flush();
    expect(mockSpawn).toHaveBeenCalledTimes(2); // only conv-a and conv-b may have actually spawned
    expect(cSpawned).toBe(false); // conv-c must be queued, not a third real process

    const handleA = await pA;
    runner.close(handleA);
    await pC;
    expect(cSpawned).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(runner.activeProcessCount).toBe(2);

    await pB;
  });

  it('releasing a slot abandoned by an aborted queued spawn does not leak capacity', async () => {
    // A queued spawn that gets cancelled via close() while still queued never creates a
    // session, so nothing but its own doSpawn's cleanup can release the slot it was handed.
    const runner = trackedRunner({ maxConcurrentProcesses: 1 });
    const handleA = await runner.spawn('conv-a', CONFIG_DIR, SYSTEM_PROMPT_FILE);

    const spawnBPromise = runner.spawn('conv-b', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    await flush();
    runner.close({ conversationId: 'conv-b' }); // cancel conv-b while still queued
    runner.close(handleA); // free conv-a's slot -- conv-b's doSpawn wakes, sees pendingCloseRequests, aborts
    await spawnBPromise;
    await flush();

    // The slot conv-b aborted with must still be usable -- not leaked.
    const handleD = await runner.spawn('conv-d', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    expect(mockSpawn).toHaveBeenCalledTimes(2); // conv-a and conv-d; conv-b never actually spawned
    expect(runner.activeProcessCount).toBe(1);
    void handleD;
  });

  it('close() on a conversationId still queued behind the cap cancels it — it never spawns a process', async () => {
    const runner = trackedRunner({ maxConcurrentProcesses: 1 });
    const handleA = await runner.spawn('conv-a', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const spawnBPromise = runner.spawn('conv-b', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    await flush();
    expect(mockSpawn).toHaveBeenCalledTimes(1); // conv-b is queued, not yet spawned

    runner.close({ conversationId: 'conv-b' }); // cancel it while still queued
    runner.close(handleA); // free the slot conv-b was waiting on
    await spawnBPromise;
    await flush();

    expect(mockSpawn).toHaveBeenCalledTimes(1); // conv-b must never have spawned a real process
    expect(runner.activeProcessCount).toBe(0);
  });

  it('closeAll() guarantees nothing still queued spawns afterward, even asynchronously', async () => {
    const runner = trackedRunner({ maxConcurrentProcesses: 1 });
    await runner.spawn('conv-a', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const spawnBPromise = runner.spawn('conv-b', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    await flush();
    expect(mockSpawn).toHaveBeenCalledTimes(1); // conv-b still queued

    runner.closeAll();
    await spawnBPromise;
    await flush();

    // conv-b's queued spawn must self-abort, not spawn a process "after shutdown".
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(runner.activeProcessCount).toBe(0);
  });

  it('closeAll() also prevents a fast-path spawn (never queued — a slot was free) from completing afterward', async () => {
    // Regression: closeAll() used to mark only spawnQueue entries as pending-close.
    // When the pool isn't at the cap, waitForFreeSlot never queues the call at all — it
    // still doesn't resume past its own `await` until the next microtask tick, so a
    // closeAll() running synchronously right after an un-awaited spawn() used to miss it
    // entirely, letting a real process spawn asynchronously right after "shutdown" returned.
    const runner = trackedRunner(); // default cap (8) — well above 1, so this is the fast path
    const spawnPromise = runner.spawn('conv-fast', CONFIG_DIR, SYSTEM_PROMPT_FILE); // not awaited
    runner.closeAll(); // synchronous, in the same tick — before doSpawn can resume past its await

    await spawnPromise;
    await flush();

    expect(mockSpawn).toHaveBeenCalledTimes(0); // must never have actually spawned a process
    expect(runner.activeProcessCount).toBe(0);
  });

  it('close() on a conversationId with nothing live or in flight is a no-op — it does not poison a later spawn()', async () => {
    // Regression: close() used to unconditionally plant a pendingCloseRequests marker
    // even when there was nothing live or queued to cancel. That marker then silently
    // consumed the NEXT unrelated spawn() call for the same id, which would resolve with
    // a fake-successful handle pointing at no real session.
    const runner = trackedRunner();
    runner.close({ conversationId: 'ghost' }); // nothing live, nothing in flight for 'ghost'

    const handle = await runner.spawn('ghost', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    expect(mockSpawn).toHaveBeenCalledTimes(1); // must have actually spawned, not silently no-op'd
    expect(runner.activeProcessCount).toBe(1);

    const child = spawnedChildren[0];
    const turn = runner.send(handle, 'hi');
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
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

  it('the idle timer firing mid-turn does not kill a session with a genuinely in-flight turn', async () => {
    jest.useFakeTimers();
    const runner = trackedRunner({ idleCloseMs: 1000 });
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'a turn that runs long');
    jest.advanceTimersByTime(1001); // the idle timer armed at send() fires while the turn is still pending
    expect(child.kill).not.toHaveBeenCalled();
    expect(runner.activeProcessCount).toBe(1); // must still be open, not closed as "idle"

    emitResult(child, { type: 'result', is_error: false, result: 'finally done' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'finally done' }));
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

  it('a synchronous stdin.write() throw rejects that turn and clears pending — the session is not permanently wedged', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];
    child.stdin.write.mockImplementationOnce(() => {
      throw new Error('EPIPE');
    });

    await expect(runner.send(handle, 'first, fails to even write')).rejects.toThrow('EPIPE');

    // A second send() must be accepted, not rejected by a stale "already in flight" guard.
    const secondTurn = runner.send(handle, 'second, should be able to proceed');
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(secondTurn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
  });

  it('drains stderr without crashing the session (prevents an OS pipe-buffer deadlock on this long-lived, --verbose child)', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    child.stderr.push('some diagnostic --verbose output\n'.repeat(500));
    await flush();

    const turn = runner.send(handle, 'hi');
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
  });

  void mkdtempSync; // referenced only via the module under test; keeps the fs mock import used
});
