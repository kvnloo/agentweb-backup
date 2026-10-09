import { ToolBridge, ToolBridgeAuthError, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps } from '../toolBridge';

const RUN = { runId: 'run-1', userId: 'user-1', sessionId: 'session-1' };

const READ_TOOL: BridgeTool = { name: 'get_leads', description: 'Reads leads.' };
const WRITE_TOOL: BridgeTool = { name: 'launch_campaign', description: 'Launches a campaign.' };
const OTHER_WRITE_TOOL: BridgeTool = { name: 'send_email', description: 'Sends an email.' };

const ok = (content: string, extra: Partial<BridgeExecuteOutcome> = {}): BridgeExecuteOutcome => ({
  content,
  isError: false,
  requiresConfirmation: false,
  toolsChanged: false,
  ...extra,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function makeDeps(tools: BridgeTool[] = [READ_TOOL, WRITE_TOOL, OTHER_WRITE_TOOL]) {
  const deps = {
    resolveTools: jest.fn(async () => tools),
    isReadOnly: jest.fn((name: string) => name.startsWith('get_')),
    execute: jest.fn(async (_run, call) => ok(`${call.name} done`)),
    releaseRun: jest.fn(),
  };
  return deps as typeof deps & ToolBridgeDeps;
}

describe('ToolBridge', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  // ─── Token gate ─────────────────────────────────────────────────────────────

  it('lists exactly the run\'s resolved tools, marking which are read-only', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    expect(await bridge.listTools(token)).toEqual([
      { ...READ_TOOL, readOnly: true },
      { ...WRITE_TOOL, readOnly: false },
      { ...OTHER_WRITE_TOOL, readOnly: false },
    ]);
    expect(deps.resolveTools).toHaveBeenCalledWith(RUN);
  });

  it('rejects a forged token on both list and call, without touching the executor', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    bridge.openRun(RUN);

    await expect(bridge.listTools('forged')).rejects.toEqual(new ToolBridgeAuthError('unknown'));
    await expect(bridge.callTool('forged', { name: 'get_leads', args: {} })).rejects.toBeInstanceOf(ToolBridgeAuthError);
    await expect(bridge.callTool(undefined, { name: 'get_leads', args: {} })).rejects.toEqual(new ToolBridgeAuthError('missing'));
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.resolveTools).not.toHaveBeenCalled();
  });

  it('rejects one run\'s token when it is presented for another run', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const tokenA = bridge.openRun(RUN);
    bridge.openRun({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });

    await expect(bridge.callTool(tokenA, { name: 'get_leads', args: {} }, 'run-2')).rejects.toEqual(
      new ToolBridgeAuthError('wrong_run'),
    );
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('stops honoring the token once the run is closed', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);
    bridge.closeRun('run-1');

    await expect(bridge.callTool(token, { name: 'get_leads', args: {} })).rejects.toBeInstanceOf(ToolBridgeAuthError);
    expect(deps.releaseRun).toHaveBeenCalledWith('run-1');
    expect(deps.execute).not.toHaveBeenCalled();
  });

  // ─── Filtered list is enforced at call time ─────────────────────────────────

  it('refuses a tool that is not in the run\'s list even when the caller names it directly', async () => {
    const deps = makeDeps([READ_TOOL]);
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const result = await bridge.callTool(token, { name: 'launch_campaign', args: {} });
    expect(result).toEqual({ content: 'launch_campaign is not available in this run.', isError: true });
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('re-checks the list when a queued call reaches the front, not only when it was queued', async () => {
    const deps = makeDeps();
    const first = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementationOnce(() => first.promise);
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const firstCall = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const queuedCall = bridge.callTool(token, { name: 'send_email', args: {} });
    await flush();

    // While send_email waits, the first call changes the run's tools and send_email is no longer offered.
    deps.resolveTools.mockResolvedValue([READ_TOOL, WRITE_TOOL]);
    first.resolve(ok('launched', { toolsChanged: true }));

    await firstCall;
    expect(await queuedCall).toEqual({ content: 'send_email is not available in this run.', isError: true });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses arguments that are not an object', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const result = await bridge.callTool(token, { name: 'get_leads', args: ['x'] as any });
    expect(result.isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  // ─── Confirmation halt — the model must not be able to confirm its own preview ──

  it('halts the run on a confirmation-required result and refuses the replay with confirm=true', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce(
      ok('{"awaitingUserConfirmation":true,"previewToken":"abc123"}', { requiresConfirmation: true }),
    );
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const preview = await bridge.callTool(token, { name: 'launch_campaign', args: { budget: 50 } });
    expect(preview.isError).toBe(false);
    expect(bridge.isHalted('run-1')).toBe(true);

    const replay = await bridge.callTool(token, {
      name: 'launch_campaign',
      args: { budget: 50, confirm: true, preview_token: 'abc123' },
    });
    expect(replay.isError).toBe(true);
    expect(replay.content).toMatch(/waiting for the user to confirm/);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses every other tool while halted, read-only ones included', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce(ok('preview', { requiresConfirmation: true }));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);
    await bridge.callTool(token, { name: 'launch_campaign', args: {} });

    expect((await bridge.callTool(token, { name: 'get_leads', args: {} })).isError).toBe(true);
    expect((await bridge.callTool(token, { name: 'send_email', args: {} })).isError).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses a call that was already queued behind the one that halted the run', async () => {
    const deps = makeDeps();
    const first = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementationOnce(() => first.promise);
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const previewCall = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const queuedCall = bridge.callTool(token, { name: 'send_email', args: {} });
    await flush();
    first.resolve(ok('preview', { requiresConfirmation: true }));

    await previewCall;
    expect((await queuedCall).isError).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('runs tools again only after the halt is cleared', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce(ok('preview', { requiresConfirmation: true }));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);
    await bridge.callTool(token, { name: 'launch_campaign', args: {} });

    bridge.clearHalt('run-1');
    const confirmed = await bridge.callTool(token, { name: 'launch_campaign', args: { confirm: true } });
    expect(confirmed).toEqual({ content: 'launch_campaign done', isError: false });
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('a halt in one run does not affect another run', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce(ok('preview', { requiresConfirmation: true }));
    const bridge = new ToolBridge(deps);
    const tokenA = bridge.openRun(RUN);
    const tokenB = bridge.openRun({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });

    await bridge.callTool(tokenA, { name: 'launch_campaign', args: {} });
    const other = await bridge.callTool(tokenB, { name: 'send_email', args: {} });
    expect(other.isError).toBe(false);
    expect(bridge.isHalted('run-2')).toBe(false);
  });

  // ─── Concurrency ────────────────────────────────────────────────────────────

  it('runs tools not known to be read-only one at a time, in the order they arrived', async () => {
    const deps = makeDeps();
    const first = deferred<BridgeExecuteOutcome>();
    const started: string[] = [];
    deps.execute.mockImplementation((_run, call) => {
      started.push(call.name);
      return call.name === 'launch_campaign' ? first.promise : Promise.resolve(ok(`${call.name} done`));
    });
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const a = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const b = bridge.callTool(token, { name: 'send_email', args: {} });
    await flush();
    expect(started).toEqual(['launch_campaign']);

    first.resolve(ok('launched'));
    await Promise.all([a, b]);
    expect(started).toEqual(['launch_campaign', 'send_email']);
  });

  it('runs read-only tools without waiting behind a slow write', async () => {
    const deps = makeDeps();
    const slowWrite = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementation((_run, call) =>
      call.name === 'launch_campaign' ? slowWrite.promise : Promise.resolve(ok(`${call.name} done`)),
    );
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const write = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const read = await bridge.callTool(token, { name: 'get_leads', args: {} });
    expect(read).toEqual({ content: 'get_leads done', isError: false });

    slowWrite.resolve(ok('launched'));
    await write;
  });

  it('a failing tool returns an error result and does not block the calls queued behind it', async () => {
    const deps = makeDeps();
    deps.execute.mockRejectedValueOnce(new Error('provider exploded: secret-detail'));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const failed = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const next = bridge.callTool(token, { name: 'send_email', args: {} });

    expect(await failed).toEqual({ content: 'launch_campaign failed to run.', isError: true });
    expect(await next).toEqual({ content: 'send_email done', isError: false });
  });

  // ─── Tool list changes and failures ─────────────────────────────────────────

  it('re-reads the tool list and notifies the harness after a call that changes it', async () => {
    const deps = makeDeps([READ_TOOL, { name: 'install_skills' }]);
    deps.execute.mockResolvedValueOnce(ok('installed', { toolsChanged: true }));
    const onToolsChanged = jest.fn();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN, { onToolsChanged });

    expect((await bridge.listTools(token)).map((t) => t.name)).toEqual(['get_leads', 'install_skills']);
    deps.resolveTools.mockResolvedValue([READ_TOOL, { name: 'install_skills' }, WRITE_TOOL]);
    await bridge.callTool(token, { name: 'install_skills', args: {} });

    expect(onToolsChanged).toHaveBeenCalledTimes(1);
    expect((await bridge.listTools(token)).map((t) => t.name)).toEqual(['get_leads', 'install_skills', 'launch_campaign']);
  });

  it('fails closed when the tool list cannot be resolved, and recovers on the next call', async () => {
    const deps = makeDeps();
    deps.resolveTools.mockRejectedValueOnce(new Error('db down'));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const refused = await bridge.callTool(token, { name: 'get_leads', args: {} });
    expect(refused.isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();

    const recovered = await bridge.callTool(token, { name: 'get_leads', args: {} });
    expect(recovered).toEqual({ content: 'get_leads done', isError: false });
  });

  it('refuses a queued call when the run closes before it reaches the front', async () => {
    const deps = makeDeps();
    const first = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementationOnce(() => first.promise);
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const inFlight = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const queued = bridge.callTool(token, { name: 'send_email', args: {} });
    await flush();
    bridge.closeRun('run-1');
    first.resolve(ok('launched'));

    await inFlight;
    expect(await queued).toEqual({ content: 'This run has ended.', isError: true });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });
});
