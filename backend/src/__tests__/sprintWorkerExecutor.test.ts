import { SprintWorkerExecutor, SprintWorkerConfig } from '../services/sprintWorkerExecutor';
import * as child_process from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process.spawn
jest.mock('child_process');
const mockSpawn = child_process.spawn as jest.MockedFunction<typeof child_process.spawn>;

// Helper: create a mock child process
function createMockProcess(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delay?: number;
  signal?: string;
}): child_process.ChildProcess {
  const proc = new EventEmitter() as child_process.ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  proc.kill = jest.fn().mockReturnValue(true);
  (proc as any).pid = 12345;

  const delay = opts.delay ?? 10;
  setTimeout(() => {
    if (opts.stdout) {
      stdoutEmitter.emit('data', Buffer.from(opts.stdout));
    }
    if (opts.stderr) {
      stderrEmitter.emit('data', Buffer.from(opts.stderr));
    }
    setTimeout(() => {
      proc.emit('close', opts.exitCode ?? 0, opts.signal ?? null);
    }, 5);
  }, delay);

  return proc;
}

describe('SprintWorkerExecutor', () => {
  let executor: SprintWorkerExecutor;
  const defaultConfig: SprintWorkerConfig = {
    claudePath: '/usr/local/bin/claude',
    repoPath: '/tmp/test-repo',
    timeoutMs: 5000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    executor = new SprintWorkerExecutor(defaultConfig);
  });

  // FAIL test 1: Throws if claude CLI not found (spawn error)
  it('should return failed status when claude CLI spawn fails', async () => {
    const proc = new EventEmitter() as child_process.ChildProcess;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    (proc as any).stdout = stdoutEmitter;
    (proc as any).stderr = stderrEmitter;
    proc.kill = jest.fn().mockReturnValue(true);
    (proc as any).pid = undefined;
    mockSpawn.mockReturnValue(proc);

    // Emit error after a tick
    setTimeout(() => {
      proc.emit('error', new Error('spawn ENOENT'));
    }, 10);

    const result = await executor.executeTick();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('ENOENT');
  });

  // FAIL test 2: Returns failed on timeout
  it('should return failed status with timeout error when execution exceeds timeoutMs', async () => {
    const config: SprintWorkerConfig = {
      ...defaultConfig,
      timeoutMs: 50, // very short timeout
    };
    const timeoutExecutor = new SprintWorkerExecutor(config);

    // Process that never exits
    const proc = new EventEmitter() as child_process.ChildProcess;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    (proc as any).stdout = stdoutEmitter;
    (proc as any).stderr = stderrEmitter;
    proc.kill = jest.fn().mockReturnValue(true);
    (proc as any).pid = 12345;
    mockSpawn.mockReturnValue(proc);

    // Emit close after kill is called (simulating SIGTERM)
    const origKill = proc.kill as jest.Mock;
    origKill.mockImplementation(() => {
      setTimeout(() => proc.emit('close', null, 'SIGTERM'), 5);
      return true;
    });

    const result = await timeoutExecutor.executeTick();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
    expect(proc.kill).toHaveBeenCalled();
  });

  // FAIL test 3: Returns failed on non-zero exit code
  it('should return failed status on non-zero exit code', async () => {
    const proc = createMockProcess({
      exitCode: 1,
      stderr: 'Error: something went wrong',
    });
    mockSpawn.mockReturnValue(proc);

    const result = await executor.executeTick();

    expect(result.status).toBe('failed');
    expect(result.error).toContain('something went wrong');
  });

  // SUCCESS test 4: Full tick completes successfully
  it('should return completed status with summary on successful execution', async () => {
    const proc = createMockProcess({
      exitCode: 0,
      stdout: 'Task completed: Fixed login validation bug. PR #123 opened.',
    });
    mockSpawn.mockReturnValue(proc);

    const result = await executor.executeTick();

    expect(result.status).toBe('completed');
    expect(result.summary).toContain('Fixed login validation bug');
    expect(mockSpawn).toHaveBeenCalledWith(
      defaultConfig.claudePath,
      expect.arrayContaining(['-p']),
      expect.objectContaining({
        cwd: defaultConfig.repoPath,
      }),
    );
  });

  // SUCCESS test 5: Spawn is called with correct arguments
  it('should pass the sprint worker prompt to claude CLI with correct flags', async () => {
    const proc = createMockProcess({ exitCode: 0, stdout: 'Done' });
    mockSpawn.mockReturnValue(proc);

    await executor.executeTick();

    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe(defaultConfig.claudePath);
    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    // The prompt should reference sprint worker
    const promptArg = args[args.indexOf('-p') + 1];
    expect(promptArg.toLowerCase()).toContain('sprint worker');
    expect(opts).toHaveProperty('cwd', defaultConfig.repoPath);
  });

  // Edge case: stdout truncation for very long output
  it('should truncate summary to 2000 chars max', async () => {
    const longOutput = 'x'.repeat(5000);
    const proc = createMockProcess({ exitCode: 0, stdout: longOutput });
    mockSpawn.mockReturnValue(proc);

    const result = await executor.executeTick();

    expect(result.status).toBe('completed');
    expect(result.summary!.length).toBeLessThanOrEqual(2000);
  });
});
