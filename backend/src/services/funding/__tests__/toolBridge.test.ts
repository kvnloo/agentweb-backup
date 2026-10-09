import {
  ToolBridge,
  ToolBridgeAuthError,
  ToolBridgeUnavailableError,
  type BridgeExecuteOutcome,
  type BridgeTool,
  type ToolBridgeDeps,
} from '../toolBridge';
import { RunToolTokenStore } from '../runToolToken';

const RUN = { runId: 'run-1', userId: 'user-1', sessionId: 'session-1' };

const READ_TOOL: BridgeTool = { name: 'get_leads', description: 'Reads leads.' };
const WRITE_TOOL: BridgeTool = { name: 'launch_campaign', description: 'Launches a campaign.' };
const OTHER_WRITE_TOOL: BridgeTool = { name: 'send_email', description: 'Sends an email.' };
const OTHER_READ_TOOL: BridgeTool = { name: 'get_stats', description: 'Reads stats.' };
const INSTALL_TOOL: BridgeTool = { name: 'install_skills' };

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
    expect(bridge.isHalted('session-1')).toBe(true);

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

    bridge.clearHalt('session-1');
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
    expect(bridge.isHalted('session-2')).toBe(false);
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

  // ─── The halt belongs to the session and survives anything short of clearHalt ──

  it('keeps the halt when the run is reopened while the previewing call is still in flight', async () => {
    const deps = makeDeps();
    const preview = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementationOnce(() => preview.promise);
    const bridge = new ToolBridge(deps);
    const oldToken = bridge.openRun(RUN);

    const previewCall = bridge.callTool(oldToken, { name: 'launch_campaign', args: {} });
    await flush();
    const newToken = bridge.openRun(RUN); // retry / reconnect with the same run id, no human turn
    preview.resolve(ok('{"previewToken":"abc123"}', { requiresConfirmation: true }));
    await previewCall;
    await flush();

    expect(bridge.isHalted('session-1')).toBe(true);
    const replay = await bridge.callTool(newToken, { name: 'launch_campaign', args: { confirm: true, preview_token: 'abc123' } });
    expect(replay.isError).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the halt across a new run in the same session', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce(ok('preview', { requiresConfirmation: true }));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);
    await bridge.callTool(token, { name: 'launch_campaign', args: {} });
    bridge.closeRun('run-1');

    const nextToken = bridge.openRun({ runId: 'run-9', userId: 'user-1', sessionId: 'session-1' });
    expect((await bridge.callTool(nextToken, { name: 'launch_campaign', args: { confirm: true } })).isError).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('opens already halted when told the session was waiting on a confirmation', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN, { halted: true });

    expect((await bridge.callTool(token, { name: 'get_leads', args: {} })).isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('reports the halt to the caller so it can be persisted', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce(ok('preview', { requiresConfirmation: true }));
    const onHalted = jest.fn();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN, { onHalted });

    await bridge.callTool(token, { name: 'launch_campaign', args: {} });
    expect(onHalted).toHaveBeenCalledTimes(1);
  });

  it('clearing one session\'s halt leaves another session halted', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValue(ok('preview', { requiresConfirmation: true }));
    const bridge = new ToolBridge(deps);
    const tokenA = bridge.openRun(RUN);
    const tokenB = bridge.openRun({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });
    await bridge.callTool(tokenA, { name: 'launch_campaign', args: {} });
    await bridge.callTool(tokenB, { name: 'launch_campaign', args: {} });

    bridge.clearHalt('session-1');
    expect(bridge.isHalted('session-1')).toBe(false);
    expect(bridge.isHalted('session-2')).toBe(true);
  });

  it('halts on a confirmation-required result even when that result is an error', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce({ content: 'needs confirmation', isError: true, requiresConfirmation: true, toolsChanged: false });
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    await bridge.callTool(token, { name: 'launch_campaign', args: {} });
    expect(bridge.isHalted('session-1')).toBe(true);
  });

  it('a result that both changes the tools and requires confirmation halts and refreshes the list', async () => {
    const deps = makeDeps([READ_TOOL, INSTALL_TOOL]);
    deps.execute.mockResolvedValueOnce(ok('installed, confirm next', { toolsChanged: true, requiresConfirmation: true }));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    await bridge.callTool(token, { name: 'install_skills', args: {} });
    expect(bridge.isHalted('session-1')).toBe(true);
    deps.resolveTools.mockResolvedValue([READ_TOOL, INSTALL_TOOL, WRITE_TOOL]);
    expect((await bridge.listTools(token)).map((t) => t.name)).toContain('launch_campaign');
  });

  it('lets a read-only call already in flight finish, and refuses one that arrives after the halt', async () => {
    const deps = makeDeps();
    const slowRead = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementation((_run, call) => {
      if (call.name === 'get_leads') return slowRead.promise;
      return Promise.resolve(ok('preview', { requiresConfirmation: true }));
    });
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const inFlightRead = bridge.callTool(token, { name: 'get_leads', args: {} });
    await flush();
    await bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const lateRead = await bridge.callTool(token, { name: 'get_leads', args: {} });
    expect(lateRead.isError).toBe(true);

    slowRead.resolve(ok('leads'));
    expect(await inFlightRead).toEqual({ content: 'leads', isError: false });
  });

  // ─── Ordering around awaits, stale lists, hung calls ────────────────────────

  it('refuses a call if the run closes while it is still waiting for the tool list', async () => {
    const deps = makeDeps();
    const slowList = deferred<BridgeTool[]>();
    deps.resolveTools.mockImplementationOnce(() => slowList.promise);
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const call = bridge.callTool(token, { name: 'get_leads', args: {} });
    await flush();
    bridge.closeRun('run-1');
    slowList.resolve([READ_TOOL]);

    expect(await call).toEqual({ content: 'This run has ended.', isError: true });
    await flush();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('refuses a call if the session halts while it is still waiting for the tool list', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);
    await bridge.listTools(token);

    // A second run in the same session, whose list is slow, has a call waiting when the first run halts.
    const slowList = deferred<BridgeTool[]>();
    deps.resolveTools.mockImplementationOnce(() => slowList.promise);
    const otherToken = bridge.openRun({ runId: 'run-2', userId: 'user-1', sessionId: 'session-1' });
    const waiting = bridge.callTool(otherToken, { name: 'get_leads', args: {} });
    await flush();

    deps.execute.mockResolvedValueOnce(ok('preview', { requiresConfirmation: true }));
    await bridge.callTool(token, { name: 'launch_campaign', args: {} });
    slowList.resolve([READ_TOOL]);

    expect((await waiting).isError).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('does not trust a tool list that was invalidated while a call was waiting for it', async () => {
    const tools = [READ_TOOL, OTHER_READ_TOOL, INSTALL_TOOL, OTHER_WRITE_TOOL];
    const deps = makeDeps(tools);
    const slowStats = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementation((_run, call) => {
      if (call.name === 'get_stats') return slowStats.promise;
      if (call.name === 'install_skills') return Promise.resolve(ok('installed', { toolsChanged: true }));
      return Promise.resolve(ok(`${call.name} done`));
    });
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const statsCall = bridge.callTool(token, { name: 'get_stats', args: {} }); // in flight throughout
    await flush();
    await bridge.callTool(token, { name: 'install_skills', args: {} }); // invalidates the list

    const staleList = deferred<BridgeTool[]>();
    deps.resolveTools.mockImplementationOnce(() => staleList.promise);
    const sendCall = bridge.callTool(token, { name: 'send_email', args: {} }); // now waiting on staleList
    await flush();

    slowStats.resolve(ok('stats', { toolsChanged: true })); // invalidates again while sendCall waits
    await statsCall;
    deps.resolveTools.mockResolvedValue([READ_TOOL, OTHER_READ_TOOL, INSTALL_TOOL]); // send_email no longer offered
    staleList.resolve(tools); // the stale answer still lists send_email

    expect(await sendCall).toEqual({ content: 'send_email is not available in this run.', isError: true });
    expect(deps.execute.mock.calls.map(([, call]) => call.name)).not.toContain('send_email');
  });

  it('keeps arrival order for queued tools even when the tool list is slow to resolve', async () => {
    const deps = makeDeps();
    const slowList = deferred<BridgeTool[]>();
    deps.resolveTools.mockImplementationOnce(() => slowList.promise);
    const started: string[] = [];
    deps.execute.mockImplementation(async (_run, call) => {
      started.push(call.name);
      return ok('done');
    });
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const a = bridge.callTool(token, { name: 'send_email', args: {} });
    const b = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    slowList.resolve([READ_TOOL, WRITE_TOOL, OTHER_WRITE_TOOL]);
    await Promise.all([a, b]);
    expect(started).toEqual(['send_email', 'launch_campaign']);
  });

  it('closing the run releases callers stuck behind a tool that never returns', async () => {
    const deps = makeDeps();
    deps.execute.mockImplementationOnce(() => new Promise<BridgeExecuteOutcome>(() => {}));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const hung = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const queued = bridge.callTool(token, { name: 'send_email', args: {} });
    await flush();
    bridge.closeRun('run-1');

    expect(await hung).toEqual({ content: 'This run has ended.', isError: true });
    expect(await queued).toEqual({ content: 'This run has ended.', isError: true });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses queued calls from the old run after a reopen, and the old token is dead', async () => {
    const deps = makeDeps();
    const first = deferred<BridgeExecuteOutcome>();
    deps.execute.mockImplementationOnce(() => first.promise);
    const bridge = new ToolBridge(deps);
    const oldToken = bridge.openRun(RUN);

    const inFlight = bridge.callTool(oldToken, { name: 'launch_campaign', args: {} });
    const queued = bridge.callTool(oldToken, { name: 'send_email', args: {} });
    await flush();
    bridge.openRun(RUN);
    first.resolve(ok('launched'));

    expect((await inFlight).content).toBe('This run has ended.');
    expect((await queued).content).toBe('This run has ended.');
    await flush();
    expect(deps.execute).toHaveBeenCalledTimes(1);
    await expect(bridge.listTools(oldToken)).rejects.toBeInstanceOf(ToolBridgeAuthError);
  });

  // ─── Nothing internal leaks, malformed input fails closed ───────────────────

  it('rejects one run\'s token on listTools when it is presented for another run', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const tokenA = bridge.openRun(RUN);
    bridge.openRun({ runId: 'run-2', userId: 'user-2', sessionId: 'session-2' });

    await expect(bridge.listTools(tokenA, 'run-2')).rejects.toEqual(new ToolBridgeAuthError('wrong_run'));
  });

  it('does not pass the underlying error through when the tool list cannot be produced', async () => {
    const deps = makeDeps();
    deps.resolveTools.mockRejectedValueOnce(new Error('connect ECONNREFUSED db-internal:5432'));
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const failure = await bridge.listTools(token).catch((err) => err);
    expect(failure).toBeInstanceOf(ToolBridgeUnavailableError);
    expect(String(failure.message)).not.toContain('db-internal');
  });

  it('turns an executor that returns nothing into an error result without blocking the queue', async () => {
    const deps = makeDeps();
    deps.execute.mockResolvedValueOnce(undefined as any);
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    const broken = bridge.callTool(token, { name: 'launch_campaign', args: {} });
    const next = bridge.callTool(token, { name: 'send_email', args: {} });
    expect(await broken).toEqual({ content: 'launch_campaign failed to run.', isError: true });
    expect(await next).toEqual({ content: 'send_email done', isError: false });
  });

  it('refuses a missing or malformed call instead of throwing', async () => {
    const deps = makeDeps();
    const bridge = new ToolBridge(deps);
    const token = bridge.openRun(RUN);

    expect((await bridge.callTool(token, null as any)).isError).toBe(true);
    expect((await bridge.callTool(token, { name: 42, args: {} } as any)).isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('stops honoring a token that has been idle past its TTL', async () => {
    let now = 1_000;
    const deps = makeDeps();
    const bridge = new ToolBridge(deps, new RunToolTokenStore({ ttlMs: 500, now: () => now }));
    const token = bridge.openRun(RUN);

    now = 1_400;
    expect((await bridge.callTool(token, { name: 'get_leads', args: {} })).isError).toBe(false);
    now = 1_900;
    await expect(bridge.callTool(token, { name: 'get_leads', args: {} })).rejects.toEqual(new ToolBridgeAuthError('expired'));
  });
});
