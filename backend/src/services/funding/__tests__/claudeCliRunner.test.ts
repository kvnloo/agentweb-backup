import { EventEmitter } from 'events';
import { Readable } from 'stream';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  mkdtempSync: jest.fn((prefix: string) => `${prefix}fake`),
  existsSync: jest.fn(() => true),
  rmSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

import { spawn as mockSpawnFn } from 'child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { ClaudeCliRunner } from '../claudeCliRunner';

const mockSpawn = mockSpawnFn as jest.Mock;
const mockRmSync = rmSync as jest.Mock;
const mockWriteFileSync = writeFileSync as jest.Mock;

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
      '--include-hook-events',
      '--no-session-persistence',
      '--model',
      'haiku',
    ]);
  });

  it('spawns the pinned binary by absolute path, never a PATH lookup', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);

    const [command] = mockSpawn.mock.calls[0];
    expect(command).not.toBe('claude');
    expect(command.startsWith('/')).toBe(true);
    expect(command).toMatch(/claude/);
  });

  it('uses one private working directory for all of a runner\'s sessions, distinct from the per-session HOME, created once with mkdtemp', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    await runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const [, , a] = mockSpawn.mock.calls[0];
    const [, , b] = mockSpawn.mock.calls[1];
    expect(a.cwd).toBeTruthy();
    expect(a.cwd).toBe(b.cwd);
    expect(a.cwd).not.toBe(a.env.HOME);
    expect(a.cwd).not.toBe(process.cwd());
    const prefixes = (mkdtempSync as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(prefixes.filter((p) => p.includes('claude-cli-cwd-'))).toHaveLength(1); // unpredictable name, made once
    expect(prefixes.filter((p) => p.includes('claude-cli-home-'))).toHaveLength(2); // one HOME per session
  });

  it('recreates the working directory if the OS removed it while the backend was running', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    (existsSync as jest.Mock).mockImplementation((path: string) => !String(path).includes('claude-cli-cwd-'));
    await runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const prefixes = (mkdtempSync as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(prefixes.filter((p) => p.includes('claude-cli-cwd-'))).toHaveLength(2);
    (existsSync as jest.Mock).mockImplementation(() => true);
  });

  it('rejects a relative cwd (it would resolve against the backend\'s own working directory)', async () => {
    const runner = trackedRunner();
    await expect(runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { cwd: 'relative/dir' })).rejects.toThrow(/absolute/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('honours a caller-provided working directory', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { cwd: '/srv/logins/connection-7/work' });
    expect(mockSpawn.mock.calls[0][2].cwd).toBe('/srv/logins/connection-7/work');
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

  it('cancelling a queued spawn via close() does not corrupt the slot count and reopen the cap', async () => {
    // Regression: close()/closeAll() used to resolve a cancelled queued entry directly,
    // without going through releaseSlotToQueue() -- but doSpawn's own cleanup had no way
    // to tell that apart from a real slot handoff, so it released a slot that was never
    // granted, driving the internal slot count negative. The previous test's single
    // follow-up spawn couldn't reveal this (pool.size looks correct either way with only
    // one more spawn) -- it only shows up once a SECOND un-awaited spawn exploits the
    // corrupted count to bypass the cap again, exactly as found live against the real binary.
    const runner = trackedRunner({ maxConcurrentProcesses: 1 });
    const handleA = await runner.spawn('conv-a', CONFIG_DIR, SYSTEM_PROMPT_FILE);

    const spawnBPromise = runner.spawn('conv-b', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    await flush();
    runner.close({ conversationId: 'conv-b' }); // cancel while queued -- never held a slot
    runner.close(handleA); // free conv-a's slot
    await spawnBPromise;
    await flush();

    let eSpawned = false;
    const pD = runner.spawn('conv-d', CONFIG_DIR, SYSTEM_PROMPT_FILE); // not awaited
    const pE = runner.spawn('conv-e', CONFIG_DIR, SYSTEM_PROMPT_FILE).then((h) => { // not awaited either
      eSpawned = true;
      return h;
    });
    await flush();

    // With the cap genuinely still at 1, conv-e must queue behind conv-d, not spawn
    // concurrently with it.
    expect(mockSpawn).toHaveBeenCalledTimes(2); // conv-a and conv-d only; conv-e must still be queued
    expect(eSpawned).toBe(false);
    expect(runner.activeProcessCount).toBe(1);

    await pD; // conv-d already has its slot (fast path) -- resolves immediately.
    // conv-e stays queued by design (nothing closes conv-d here) -- afterEach's
    // closeAll() cleans it up; asserting eSpawned === false above is the real check.
    void pE;
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

  // ─── MCP server: the tool bridge (ENG-2109) ─────────────────────────────────

  const MCP = {
    name: 'emma',
    url: 'http://127.0.0.1:8080/internal/tool-bridge/run-1/mcp',
    bearerToken: 'run-token-secret',
  };

  it('gives the session its MCP server through a 0600 config file, never on the command line', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });

    const [, args] = mockSpawn.mock.calls[0];
    const flagIndex = args.indexOf('--mcp-config');
    expect(flagIndex).toBeGreaterThan(-1);
    const file = args[flagIndex + 1];
    expect(file).toMatch(/claude-cli-home-.*mcp\.json$/);
    expect(args.join(' ')).not.toContain('run-token-secret');
    expect(args).toContain('--strict-mcp-config');

    expect(mockWriteFileSync).toHaveBeenCalledWith(file, expect.any(String), { mode: 0o600 });
    expect(JSON.parse(mockWriteFileSync.mock.calls[0][1])).toEqual({
      mcpServers: { emma: { type: 'http', url: MCP.url, headers: { Authorization: 'Bearer run-token-secret' } } },
    });
  });

  it('passes no MCP config when the session has no MCP server', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);

    expect(mockSpawn.mock.calls[0][1]).not.toContain('--mcp-config');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('fails the turn and closes the session when the MCP server did not connect', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'hi');
    child.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [{ name: 'emma', status: 'failed' }] }) + '\n',
    );
    await expect(turn).rejects.toThrow(/MCP server "emma" is not connected \(failed\)/);
    expect(child.kill).toHaveBeenCalled();
    expect(runner.activeProcessCount).toBe(0);
  });

  it('fails the turn when the init event does not list the MCP server at all', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'hi');
    child.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [] }) + '\n');
    await expect(turn).rejects.toThrow(/not connected \(missing\)/);
  });

  it('lets the turn proceed and reports the status when the MCP server is connected', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'hi');
    child.stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [{ name: 'emma', status: 'connected' }] }) + '\n',
    );
    await flush();
    expect(runner.mcpServerStatusFor(handle)).toBe('connected');
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
  });

  it('does not check MCP status for a session that was given no MCP server', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const child = spawnedChildren[0];

    const turn = runner.send(handle, 'hi');
    child.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [] }) + '\n');
    await flush();
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
  });

  it('reports each tool call the model emits with the id of its model message', async () => {
    const runner = trackedRunner();
    const onToolUse = jest.fn();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { onToolUse });
    const child = spawnedChildren[0];
    const turn = runner.send(handle, 'hi');

    const assistant = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content } }) + '\n';
    child.stdout.push(assistant([{ type: 'text', text: 'working' }]));
    child.stdout.push(assistant([{ type: 'tool_use', id: 'toolu_a', name: 'mcp__emma__get_leads', input: {} }]));
    child.stdout.push(assistant([{ type: 'tool_use', id: 'toolu_b', name: 'mcp__emma__get_leads', input: {} }]));
    await flush();

    expect(onToolUse.mock.calls.map((c) => c[0])).toEqual([
      { messageId: 'msg_1', toolUseId: 'toolu_a', name: 'mcp__emma__get_leads' },
      { messageId: 'msg_1', toolUseId: 'toolu_b', name: 'mcp__emma__get_leads' },
    ]);
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await turn;
  });

  it('keeps the turn alive when the tool-use callback throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, {
      onToolUse: () => {
        throw new Error('boom');
      },
    });
    const child = spawnedChildren[0];
    const turn = runner.send(handle, 'hi');
    child.stdout.push(
      JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'x' }] } }) + '\n',
    );
    await flush();
    emitResult(child, { type: 'result', is_error: false, result: 'ok' });
    await expect(turn).resolves.toEqual(expect.objectContaining({ resultText: 'ok' }));
  });

  it('tells the caller when a session closes, whatever closed it', async () => {
    const runner = trackedRunner();
    const onClose = jest.fn();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP, onClose });
    const turn = runner.send(handle, 'hi');
    spawnedChildren[0].stdout.push(
      JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'emma', status: 'failed' }] }) + '\n',
    );
    await expect(turn).rejects.toThrow();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('mcp-not-connected');

    const onClose2 = jest.fn();
    const handle2 = await runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE, { onClose: onClose2 });
    runner.close(handle2);
    expect(onClose2).toHaveBeenCalledTimes(1);
  });

  it('refuses to hand back an open session when asked for a different MCP server', async () => {
    const runner = trackedRunner();
    await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    await expect(
      runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: { ...MCP, bearerToken: 'a-newer-token' } }),
    ).rejects.toThrow(/different MCP server/);
    await expect(runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP })).resolves.toEqual({ conversationId: 'conv-1' });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('removes the scratch dir, token file included, when the process cannot be started', async () => {
    const runner = trackedRunner();
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    await expect(runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP })).rejects.toThrow('spawn failed');
    expect(mockRmSync).toHaveBeenCalledWith(expect.stringMatching(/claude-cli-home-/), { recursive: true, force: true });
    expect(runner.activeProcessCount).toBe(0);
  });

  it('removes the scratch dir again once a killed process has really exited', async () => {
    const runner = trackedRunner();
    const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    const child = spawnedChildren[0] as any;
    child.exitCode = null;
    child.signalCode = null;

    runner.close(handle);
    expect(mockRmSync).toHaveBeenCalledTimes(1);
    child.emit('exit', null, 'SIGTERM');
    expect(mockRmSync).toHaveBeenCalledTimes(2);
  });

  it('refuses a spawn that joined an in-flight one started with a different MCP server', async () => {
    const runner = trackedRunner();
    // A prewarm with no tools and the real turn's spawn, issued before the first lands.
    const prewarm = runner.prewarm('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
    const real = runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    await expect(prewarm).resolves.toEqual({ conversationId: 'conv-1' });
    await expect(real).rejects.toThrow(/different MCP server/);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const a = runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    const b = runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: { ...MCP, bearerToken: 'other' } });
    const c = runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE, { mcpServer: MCP });
    await expect(a).resolves.toEqual({ conversationId: 'conv-2' });
    await expect(b).rejects.toThrow(/different MCP server/);
    await expect(c).resolves.toEqual({ conversationId: 'conv-2' });
  });

  void mkdtempSync; // referenced only via the module under test; keeps the fs mock import used

  // ─── PR 0 (ENG-2110): events, per-turn deadline, interrupt ───────────────────────

  describe('events, deadline and interrupt', () => {
    it('passes every parsed event to the session hook, in order, and keeps working if the hook throws', async () => {
      const seen: string[] = [];
      const runner = trackedRunner();
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, {
        onEvent: (e) => {
          seen.push(`${e.type}${e.subtype ? '/' + e.subtype : ''}`);
          throw new Error('sink bug');
        },
      });
      const child = spawnedChildren[0];
      const turn = runner.send({ conversationId: 'conv-1' }, 'hi');
      child.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none' }) + '\n');
      child.stdout.push(JSON.stringify({ type: 'system', subtype: 'hook_started', hook_name: 'x' }) + '\n');
      child.stdout.push(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) + '\n');
      emitResult(child, { type: 'result', is_error: false, result: 'ok' });
      await expect(turn).resolves.toMatchObject({ isError: false, resultText: 'ok' });
      expect(seen).toEqual(['system/init', 'system/hook_started', 'rate_limit_event', 'result']);
      expect(runner.apiKeySourceFor({ conversationId: 'conv-1' })).toBe('none');
      errSpy.mockRestore();
    });

    it('delivers per-turn events only while that turn is in flight', async () => {
      const first: string[] = [];
      const second: string[] = [];
      const runner = trackedRunner();
      await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
      const child = spawnedChildren[0];
      const h = { conversationId: 'conv-1' };
      const t1 = runner.send(h, 'one', { onEvent: (e) => first.push(String(e.type)) });
      child.stdout.push(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [] } }) + '\n');
      emitResult(child, { type: 'result', is_error: false, result: 'a' });
      await t1;
      child.stdout.push(JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\n'); // between turns: nobody listens
      await flush();
      const t2 = runner.send(h, 'two', { onEvent: (e) => second.push(String(e.type)) });
      emitResult(child, { type: 'result', is_error: false, result: 'b' });
      await t2;
      expect(first).toEqual(['assistant', 'result']);
      expect(second).toEqual(['result']);
    });

    describe('deadline', () => {
      // Only the clock is faked: stream parsing and the runner's promises need nextTick/microtasks/setImmediate.
      beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
      afterEach(() => jest.useRealTimers());

      it('rejects the turn with a deadline error, kills the process and frees the slot', async () => {
        const onClose = jest.fn();
        const runner = trackedRunner({ maxConcurrentProcesses: 1 });
        await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { onClose });
        const child = spawnedChildren[0];
        const turn = runner.send({ conversationId: 'conv-1' }, 'slow', { deadlineMs: 5_000 });
        const assertion = expect(turn).rejects.toMatchObject({ name: 'ClaudeCliTurnError', code: 'deadline' });
        jest.advanceTimersByTime(5_000);
        await assertion;
        expect(child.kill).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledWith('turn-deadline');
        expect(runner.activeProcessCount).toBe(0);
        // the single slot is free again: a new conversation can spawn immediately
        await expect(runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE)).resolves.toEqual({ conversationId: 'conv-2' });
      });

      it('does not fire after the turn finished, and a finished turn leaves no timer behind', async () => {
        const runner = trackedRunner();
        await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
        const child = spawnedChildren[0];
        const idleOnly = jest.getTimerCount(); // the session's idle-close timer
        const turn = runner.send({ conversationId: 'conv-1' }, 'fast', { deadlineMs: 5_000 });
        expect(jest.getTimerCount()).toBe(idleOnly + 1); // + the deadline timer
        emitResult(child, { type: 'result', is_error: false, result: 'ok' });
        await turn;
        expect(jest.getTimerCount()).toBe(idleOnly); // deadline timer cleared, not just neutralised
        jest.advanceTimersByTime(60_000);
        expect(child.kill).not.toHaveBeenCalled();
        expect(runner.activeProcessCount).toBe(1);
      });

      it('ignores a non-positive or missing deadline (no timer)', async () => {
        const runner = trackedRunner();
        await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
        const child = spawnedChildren[0];
        const idleOnly = jest.getTimerCount();
        const turn = runner.send({ conversationId: 'conv-1' }, 'x', { deadlineMs: 0 });
        expect(jest.getTimerCount()).toBe(idleOnly);
        emitResult(child, { type: 'result', is_error: false, result: 'ok' });
        await turn;
        expect(child.kill).not.toHaveBeenCalled();
      });
    });

    describe('interrupt', () => {
      it('rejects the turn in flight with an interrupted error and closes the session', async () => {
        const onClose = jest.fn();
        const runner = trackedRunner();
        const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { onClose });
        const child = spawnedChildren[0];
        const turn = runner.send(handle, 'long');
        expect(runner.interrupt(handle)).toBe(true);
        await expect(turn).rejects.toMatchObject({ name: 'ClaudeCliTurnError', code: 'interrupted' });
        expect(child.kill).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledWith('interrupted');
        expect(runner.activeProcessCount).toBe(0);
      });

      it('returns false and does nothing when no turn is in flight or the session is unknown', async () => {
        const runner = trackedRunner();
        const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
        expect(runner.interrupt(handle)).toBe(false);
        expect(spawnedChildren[0].kill).not.toHaveBeenCalled();
        expect(runner.interrupt({ conversationId: 'nope' })).toBe(false);
        expect(runner.activeProcessCount).toBe(1);
      });
    });
  });


  describe('review hardening (ENG-2110 PR 0)', () => {
    it('emits nothing for lines that arrive after the session was closed', async () => {
      const seen: string[] = [];
      const onToolUse = jest.fn();
      const runner = trackedRunner();
      const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, {
        onEvent: (e) => seen.push(String(e.type)),
        onToolUse,
      });
      const child = spawnedChildren[0];
      // three lines in ONE chunk: readline would deliver all of them even if close() happens on the first
      child.stdout.push(
        JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\n' +
        JSON.stringify({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'x' }] } }) + '\n' +
        JSON.stringify({ type: 'result', is_error: false, result: 'late' }) + '\n',
      );
      runner.close(handle); // before the chunk is read
      await flush();
      expect(seen).toEqual([]);
      expect(onToolUse).not.toHaveBeenCalled();
    });

    it('lets a session sink stop the process on the first alarm event, and nothing after it is delivered', async () => {
      const seen: string[] = [];
      const runner = trackedRunner();
      const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, {
        onEvent: (e) => {
          seen.push(`${e.type}/${e.subtype}`);
          if (e.subtype === 'hook_started') runner.terminate(handle);
        },
      });
      const child = spawnedChildren[0];
      child.stdout.push(
        JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\n' +
        JSON.stringify({ type: 'system', subtype: 'hook_response' }) + '\n',
      );
      await flush();
      expect(seen).toEqual(['system/hook_started']);
      expect(child.kill).toHaveBeenCalled();
      expect(runner.activeProcessCount).toBe(0);
    });

    it('terminate() closes a session between turns; returns false for an unknown or closed one', async () => {
      const onClose = jest.fn();
      const runner = trackedRunner();
      const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { onClose });
      expect(runner.terminate(handle)).toBe(true);
      expect(onClose).toHaveBeenCalledWith('terminated');
      expect(runner.terminate(handle)).toBe(false);
      expect(runner.terminate({ conversationId: 'nope' })).toBe(false);
    });

    it('terminate() during a turn rejects it with the generic closed error (not a deadline/interrupt)', async () => {
      const runner = trackedRunner();
      const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
      const turn = runner.send(handle, 'x');
      runner.terminate(handle);
      await expect(turn).rejects.toThrow(/session closed \(terminated\)/);
    });

    it('the runner acts on an event before sinks see it: a sink that closes on a failing init does not mask the MCP diagnosis', async () => {
      const runner = trackedRunner();
      const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, {
        mcpServer: { name: 'emma-tools', url: 'http://127.0.0.1:1/x', bearerToken: 'tok' },
        onEvent: () => runner.terminate(handle),
      });
      const child = spawnedChildren[0];
      const turn = runner.send(handle, 'x');
      const assertion = expect(turn).rejects.toThrow(/MCP server "emma-tools" is not connected/);
      child.stdout.push(JSON.stringify({ type: 'system', subtype: 'init', apiKeySource: 'none', mcp_servers: [{ name: 'emma-tools', status: 'failed' }] }) + '\n');
      await assertion;
    });

    it('hands sinks a frozen event: mutating it cannot change what the runner reads', async () => {
      const runner = trackedRunner();
      await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, {
        onEvent: (e) => {
          (e as Record<string, unknown>).result = 'tampered';
          (e as Record<string, unknown>).is_error = true;
        },
      });
      const child = spawnedChildren[0];
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const turn = runner.send({ conversationId: 'conv-1' }, 'x');
      emitResult(child, { type: 'result', is_error: false, result: 'genuine' });
      const result = await turn;
      expect(result).toMatchObject({ isError: false, resultText: 'genuine' });
      expect(result.raw).toMatchObject({ result: 'genuine', is_error: false }); // the same object the sink received
      expect(Object.isFrozen(result.raw)).toBe(true);
      errSpy.mockRestore();
    });

    it('a sink may interrupt() from inside the callback without breaking the runner', async () => {
      const runner = trackedRunner();
      const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
      const child = spawnedChildren[0];
      const turn = runner.send(handle, 'x', { onEvent: (e) => { if (e.type === 'assistant') runner.interrupt(handle); } });
      const assertion = expect(turn).rejects.toMatchObject({ code: 'interrupted' });
      child.stdout.push(JSON.stringify({ type: 'assistant', message: { id: 'm', content: [] } }) + '\n');
      await assertion;
      expect(runner.activeProcessCount).toBe(0);
    });

    describe('deadline validation and late results', () => {
      beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
      afterEach(() => jest.useRealTimers());

      it.each([['Infinity', Infinity], ['NaN', NaN], ['negative', -5], ['missing', undefined]])('%s deadline means no timer', async (_n, deadlineMs) => {
        const runner = trackedRunner();
        await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
        const child = spawnedChildren[0];
        const idleOnly = jest.getTimerCount();
        const turn = runner.send({ conversationId: 'conv-1' }, 'x', deadlineMs === undefined ? {} : { deadlineMs: deadlineMs as number });
        expect(jest.getTimerCount()).toBe(idleOnly);
        jest.advanceTimersByTime(1000);
        expect(child.kill).not.toHaveBeenCalled();
        emitResult(child, { type: 'result', is_error: false, result: 'ok' });
        await turn;
      });

      it('a huge deadline is clamped to the largest timer delay instead of firing almost at once', async () => {
        const runner = trackedRunner();
        await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
        const child = spawnedChildren[0];
        const turn = runner.send({ conversationId: 'conv-1' }, 'x', { deadlineMs: 10_000_000_000 });
        jest.advanceTimersByTime(60_000);
        expect(child.kill).not.toHaveBeenCalled();
        emitResult(child, { type: 'result', is_error: false, result: 'ok' });
        await turn;
      });

      it('a result that arrives after the deadline already closed the session is ignored', async () => {
        const runner = trackedRunner();
        await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
        const child = spawnedChildren[0];
        const turn = runner.send({ conversationId: 'conv-1' }, 'x', { deadlineMs: 1_000 });
        const assertion = expect(turn).rejects.toMatchObject({ code: 'deadline' });
        jest.advanceTimersByTime(1_000);
        await assertion;
        emitResult(child, { type: 'result', is_error: false, result: 'too late' });
        await flush();
        expect(runner.activeProcessCount).toBe(0);
      });
    });
  });


  describe('round-2 review hardening (ENG-2110 PR 0)', () => {
    it.each([['null', 'null'], ['a number', '123'], ['an array', '[1,2]'], ['a string', '"str"']])('ignores a stdout line that is valid JSON but not an event (%s) without crashing', async (_n, line) => {
      const seen: string[] = [];
      const runner = trackedRunner();
      await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE, { onEvent: (e) => seen.push(String(e.type)) });
      const child = spawnedChildren[0];
      const turn = runner.send({ conversationId: 'conv-1' }, 'x');
      child.stdout.push(line + '\n');
      emitResult(child, { type: 'result', is_error: false, result: 'ok' });
      await expect(turn).resolves.toMatchObject({ resultText: 'ok' });
      expect(seen).toEqual(['result']);
    });

    it('terminate() during a spawn that is still queued aborts it: no process is ever started for it', async () => {
      const runner = trackedRunner({ maxConcurrentProcesses: 1 });
      const first = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
      const queued = runner.spawn('conv-2', CONFIG_DIR, SYSTEM_PROMPT_FILE);
      expect(runner.terminate({ conversationId: 'conv-2' })).toBe(true);
      await queued;
      runner.close(first); // frees the slot the queued spawn was waiting for
      await flush();
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(runner.activeProcessCount).toBe(0);
    });

    it('a sink may start the next turn from the result event (the turn is already settled)', async () => {
      const runner = trackedRunner();
      const handle = await runner.spawn('conv-1', CONFIG_DIR, SYSTEM_PROMPT_FILE);
      const child = spawnedChildren[0];
      let next: Promise<unknown> | undefined;
      const first = runner.send(handle, 'one', {
        onEvent: (e) => {
          if (e.type === 'result' && !next) next = runner.send(handle, 'two');
        },
      });
      emitResult(child, { type: 'result', is_error: false, result: 'a' });
      await first;
      expect(next).toBeDefined();
      emitResult(child, { type: 'result', is_error: false, result: 'b' });
      await expect(next).resolves.toMatchObject({ resultText: 'b' });
    });
  });

});
