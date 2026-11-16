/**
 * ENG-2113 PR B, second independent review round (state machine, security, mutation testing): one test per finding, plus the
 * "killer" tests for mutants of the safety-critical code that survived every earlier test.
 */
import { ToolBridge, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps, type ToolBridgeOptions } from '../toolBridge';
import { RunToolTokenStore } from '../runToolToken';
import { isStrictRepeatEffect } from '../bridgeToolClassification';

const RUN = { runId: 'run-1', userId: 'user-1', sessionId: 'session-1' };
const TOOLS: BridgeTool[] = [{ name: 'get_leads' }, { name: 'meta_preview' }, { name: 'meta_confirm' }, { name: 'save_note' }, { name: 'send_email' }];
const ok = (content: string, extra: Partial<BridgeExecuteOutcome> = {}): BridgeExecuteOutcome => ({ content, isError: false, requiresConfirmation: false, toolsChanged: false, ...extra });
const preview = (content = 'preview'): BridgeExecuteOutcome => ok(content, { requiresConfirmation: true, result: { awaitingUserConfirmation: true } });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(over: Partial<ToolBridgeDeps> = {}, opts: ToolBridgeOptions = {}) {
  const deps = {
    resolveTools: jest.fn(async () => TOOLS),
    isReadOnly: jest.fn((n: string) => n.startsWith('get_')),
    execute: jest.fn(async (_r: unknown, c: { name: string }) => ok(`${c.name} done`)),
    releaseRun: jest.fn(),
    ...over,
  } as unknown as ToolBridgeDeps & { execute: jest.Mock; releaseRun: jest.Mock };
  return { bridge: new ToolBridge(deps, new RunToolTokenStore(), opts), deps };
}

describe('ToolBridge review round 2', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  // ─── killers for surviving mutants ──────────────────────────────────────────

  it('the session is latched while the halt is being saved: a read arriving then is refused', async () => {
    const persist = deferred<void>();
    const { bridge, deps } = make({
      execute: jest.fn(async (_r: unknown, c: any) => (c.name === 'meta_preview' ? preview() : ok('read'))) as any,
      persistHalt: jest.fn(() => persist.promise),
    });
    const token = bridge.openRun(RUN);
    const first = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
    await flush();
    await flush();
    const read = await bridge.callTool(token, { name: 'get_leads', args: {}, callId: 'r' });
    expect(read.isError).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
    persist.resolve();
    await first;
  });

  it('liveness is the last await: a revoke while the tool list resolves stops the write', async () => {
    const list = deferred<BridgeTool[]>();
    let live = true;
    const { bridge, deps } = make({ resolveTools: jest.fn(() => list.promise) as any, isLive: jest.fn(async () => live) });
    const token = bridge.openRun({ ...RUN, connectionId: 'c', epoch: 1 });
    const p = bridge.callTool(token, { name: 'save_note', args: {} });
    await flush();
    live = false;
    list.resolve(TOOLS);
    expect((await p).isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it('a halt that arrives after the ledger is full is still kept', async () => {
    const { bridge } = make({ execute: jest.fn(async (_r: unknown, c: any) => (c.args.halt ? preview() : ok('x'))) as any });
    const token = bridge.openRun(RUN);
    for (let i = 0; i < 520; i++) await bridge.callTool(token, { name: 'get_leads', args: { i } });
    expect(bridge.takeLedger(RUN.runId).truncated).toBeGreaterThan(0);
    await bridge.callTool(token, { name: 'meta_preview', args: { halt: true }, callId: 'h' });
    expect(bridge.takeHalts(RUN.userId, RUN.sessionId).map((h) => h.callId)).toEqual(['h']);
  });

  it('at most 4 calls wait on one unannounced call id; the 5th proceeds without a group', async () => {
    const { bridge, deps } = make();
    const token = bridge.openRun(RUN, { callGroupWaitMs: 10_000 });
    const calls = [0, 1, 2, 3, 4].map((i) => bridge.callTool(token, { name: 'get_leads', args: { i }, callId: 'x' }));
    await flush();
    await flush();
    await flush();
    expect(deps.execute).toHaveBeenCalledTimes(1);
    bridge.noteCallGroup(RUN.runId, 'x', 'g');
    await Promise.all(calls);
  });

  it('a strict repeat after the TTL runs again', async () => {
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const { bridge, deps } = make({ isStrictEffect: () => true }, { completedRepeatTtlMs: 1000 });
    const token = bridge.openRun(RUN);
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    await bridge.callTool(token, { name: 'send_email', args: { to: 'a' } });
    now += 2000;
    const again = await bridge.callTool(token, { name: 'send_email', args: { to: 'a' } });
    expect(again.content).toBe('send_email done');
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it("an identical write in a new turn does not join the previous turn's in-flight call", async () => {
    const gate = deferred<BridgeExecuteOutcome>();
    let n = 0;
    const { bridge, deps } = make({ execute: jest.fn(async () => (n++ === 0 ? gate.promise : ok('second'))) as any });
    const token = bridge.openRun(RUN);
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    const first = bridge.callTool(token, { name: 'send_email', args: { n: 1 } });
    await flush();
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    const second = bridge.callTool(token, { name: 'send_email', args: { n: 1 } });
    await flush();
    gate.resolve(ok('first'));
    await first;
    expect((await second).content).toBe('second');
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  // ─── state machine ──────────────────────────────────────────────────────────

  describe('unknown outcome', () => {
    it('a write already queued behind a hung write does not run past the block when the hold limit frees the slot', async () => {
      const hung = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const { bridge, deps } = make({ execute: jest.fn(async () => (n++ === 0 ? hung.promise : ok('should not run'))) as any }, { callHoldLimitMs: 30 });
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      void bridge.callTool(token, { name: 'send_email', args: { n: 1 } });
      const queued = bridge.callTool(token, { name: 'save_note', args: {} });
      const answer = await queued;
      expect(answer.isError).toBe(true);
      expect(answer.content).toContain('outcome is not known');
      expect(deps.execute).toHaveBeenCalledTimes(1);
    });

    it('a write queued in another run of the session does not run once the first run closes under a write', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const { bridge, deps } = make({ execute: jest.fn(async () => (n++ === 0 ? gate.promise : ok('should not run'))) as any });
      const t1 = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      void bridge.callTool(t1, { name: 'send_email', args: { n: 1 } });
      await flush();
      const t2 = bridge.openRun({ ...RUN, runId: 'run-2' });
      const second = bridge.callTool(t2, { name: 'save_note', args: {} });
      await flush();
      bridge.closeRun(RUN.runId);
      expect((await second).isError).toBe(true);
      expect(deps.execute).toHaveBeenCalledTimes(1);
      gate.resolve(ok('first'));
    });

    it('a warning re-armed after a turn that never reached the model is reported by the next beginTurn, once', () => {
      const { bridge } = make({}, {});
      expect(bridge.beginTurn(RUN.userId, RUN.sessionId).previousUnknownOutcome).toBe(false);
      bridge.rearmUnknownOutcome(RUN.userId, RUN.sessionId);
      expect(bridge.beginTurn(RUN.userId, RUN.sessionId).previousUnknownOutcome).toBe(true);
      expect(bridge.beginTurn(RUN.userId, RUN.sessionId).previousUnknownOutcome).toBe(false); // heard once, then spent
      // a different session is untouched
      bridge.rearmUnknownOutcome(RUN.userId, 'other-session');
      expect(bridge.beginTurn(RUN.userId, RUN.sessionId).previousUnknownOutcome).toBe(false);
      expect(bridge.beginTurn(RUN.userId, 'other-session').previousUnknownOutcome).toBe(true);
    });

    it('a late event from an earlier turn does not block the new turn, and is reported by the next beginTurn', async () => {
      const hung = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const { bridge } = make({ execute: jest.fn(async () => (n++ === 0 ? hung.promise : ok('ran'))) as any }, { callHoldLimitMs: 60 });
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      void bridge.callTool(token, { name: 'send_email', args: { n: 1 } });
      await flush();
      bridge.beginTurn(RUN.userId, RUN.sessionId); // the old turn's timer is still running
      const fresh = await bridge.callTool(token, { name: 'save_note', args: {} }); // waits for the slot, then runs
      expect(fresh.content).toBe('ran');
      expect(bridge.beginTurn(RUN.userId, RUN.sessionId).previousUnknownOutcome).toBe(true);
      hung.resolve(ok('late'));
    });

    it('the hold limit counts the time a halt is being saved', async () => {
      const { bridge } = make({ execute: jest.fn(async () => preview()) as any, persistHalt: jest.fn(async () => { await sleep(150); }) }, { callHoldLimitMs: 40 });
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const halting = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await sleep(90);
      expect(bridge.sessionStatus(RUN.userId, RUN.sessionId)?.unknownOutcome).toBe(true);
      await halting;
    });
  });

  it('a call stuck before the executor is abandoned at the hold limit and never runs late', async () => {
    const list = deferred<BridgeTool[]>();
    const { bridge, deps } = make({ resolveTools: jest.fn(() => list.promise) as any }, { callHoldLimitMs: 100 });
    const token = bridge.openRun(RUN);
    const stuck = bridge.callTool(token, { name: 'save_note', args: { id: 'a' } });
    const next = bridge.callTool(token, { name: 'save_note', args: { id: 'b' } });
    await sleep(150); // the first call is abandoned at 100 ms; the second is still inside its own window
    list.resolve(TOOLS);
    expect((await stuck).isError).toBe(true);
    expect((await next).content).toBe('save_note done');
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect((deps.execute.mock.calls[0][1] as any).args.id).toBe('b');
    expect(bridge.sessionStatus(RUN.userId, RUN.sessionId)?.unknownOutcome).toBe(false);
  });

  describe('executor release', () => {
    it('a releaseRun that throws does not stop the other runs of a revoked connection from closing', async () => {
      const { bridge, deps } = make({ isLive: jest.fn(async () => true), releaseRun: jest.fn(() => { throw new Error('x'); }) });
      const t1 = bridge.openRun({ ...RUN, connectionId: 'c', epoch: 1 });
      const t2 = bridge.openRun({ runId: 'run-2', userId: 'user-1', sessionId: 's2', connectionId: 'c', epoch: 1 });
      expect(bridge.revokeConnection('c').sort()).toEqual(['run-1', 'run-2']);
      expect(deps.releaseRun).toHaveBeenCalledTimes(2);
      void t1;
      void t2;
    });

    it('a releaseRun that throws after the executor returns does not lose a halt', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const { bridge } = make({ execute: jest.fn(async () => gate.promise) as any, releaseRun: jest.fn(() => { throw new Error('x'); }) });
      const token = bridge.openRun(RUN);
      const p = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await flush();
      bridge.closeRun(RUN.runId); // release deferred until the call finishes, then throws
      gate.resolve(preview());
      await p;
      await flush();
      expect(bridge.isHalted(RUN.sessionId)).toBe(true);
      expect(bridge.takeLedgerByGeneration(bridge.generationOf(RUN.runId)!).records[0].kind).toBe('executed');
    });

    it('is released exactly once when a run is closed, reopened and closed again while an old call still executes', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const { bridge, deps } = make({ execute: jest.fn(async () => gate.promise) as any });
      const t1 = bridge.openRun(RUN);
      void bridge.callTool(t1, { name: 'send_email', args: {} });
      await flush();
      bridge.closeRun(RUN.runId); // deferred: a call still executes
      bridge.openRun(RUN);
      bridge.closeRun(RUN.runId); // the old call still uses the executor's state: still deferred
      expect(deps.releaseRun).not.toHaveBeenCalled();
      gate.resolve(ok('done'));
      await flush();
      await flush();
      expect(deps.releaseRun).toHaveBeenCalledTimes(1);
    });
  });

  it('a stop frees the write slot of the call it abandons, so the next turn does not wait out the hold limit', async () => {
    const gate = deferred<BridgeExecuteOutcome>();
    let n = 0;
    const { bridge } = make({ execute: jest.fn(async () => (n++ === 0 ? gate.promise : ok('next turn'))) as any }, { callHoldLimitMs: 60_000 });
    const token = bridge.openRun(RUN);
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    void bridge.callTool(token, { name: 'send_email', args: { n: 1 } });
    await flush();
    bridge.cancelSession(RUN.userId, RUN.sessionId);
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    const t2 = bridge.openRun(RUN);
    const started = Date.now();
    expect((await bridge.callTool(t2, { name: 'save_note', args: {} })).content).toBe('next turn');
    expect(Date.now() - started).toBeLessThan(2000);
    gate.resolve(ok('abandoned'));
  });

  describe('late records', () => {
    it('are kept past the retention time while a call is still pending, and a take while pending leaves the ledger for the late record', async () => {
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      const gate = deferred<BridgeExecuteOutcome>();
      const { bridge } = make({ execute: jest.fn(async () => gate.promise) as any });
      const token = bridge.openRun(RUN);
      void bridge.callTool(token, { name: 'send_email', args: {}, callId: 'a' });
      await flush();
      const generation = bridge.generationOf(RUN.runId)!;
      bridge.closeRun(RUN.runId);
      now += 20 * 60 * 1000; // past the 5 minute retention
      bridge.openRun({ ...RUN, runId: 'run-9', sessionId: 's9' });
      bridge.closeRun('run-9'); // triggers a prune
      expect(bridge.takeLedgerByGeneration(generation).records).toEqual([]); // taken while pending: kept
      gate.resolve(ok('sent late'));
      await flush();
      await flush();
      const late = bridge.takeLedgerByGeneration(generation).records;
      expect(late).toHaveLength(1);
      expect(late[0]).toMatchObject({ toolCallId: 'a', late: true });
      expect(bridge.takeLedgerByGeneration(generation).records).toEqual([]); // and gone once nothing is pending
    });
  });

  it('admits a same-message sibling that was already queued when the halt landed', async () => {
    const gate = deferred<BridgeExecuteOutcome>();
    const { bridge, deps } = make({ execute: jest.fn(async (_r: unknown, c: any) => (c.callId === 'a' ? gate.promise : ok('sibling ran'))) as any, persistHalt: jest.fn(async () => {}) });
    const token = bridge.openRun(RUN);
    bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', {}, 'm1');
    bridge.noteToolUse(RUN.runId, 'b', 'send_email', { to: 'x' }, 'm1');
    const first = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
    const sibling = bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 'b' }); // parallel client
    await flush();
    gate.resolve(preview());
    await first;
    expect((await sibling).content).toBe('sibling ran');
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  // ─── security ───────────────────────────────────────────────────────────────

  describe('a new turn that begins while the halt is being finished', () => {
    it('while the halt is being saved: the model gets a constant, not the approval token', async () => {
      const persist = deferred<void>();
      const { bridge } = make({ execute: jest.fn(async () => preview('TOKEN=secret123')) as any, persistHalt: jest.fn(() => persist.promise) as any });
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const p = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await flush();
      await flush();
      bridge.beginTurn(RUN.userId, RUN.sessionId); // the user typed something new
      persist.resolve();
      const answered = await p;
      expect(answered.isError).toBe(true);
      expect(answered.content).not.toContain('secret123');
      expect(bridge.takeLedger(RUN.runId).records[0].toolMessageContent).toContain('secret123');
    });

    it('while the tool list is refreshed after the call', async () => {
      const relist = deferred<void>();
      const { bridge } = make({ execute: jest.fn(async () => preview('TOKEN=secret123') && ok('TOKEN=secret123', { requiresConfirmation: true, toolsChanged: true, result: {} })) as any });
      const token = bridge.openRun(RUN, { onToolsChanged: () => relist.promise });
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const p = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await flush();
      await flush();
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      relist.resolve();
      const answered = await p;
      expect(answered.content).not.toContain('secret123');
    });
  });

  it('refuses to open a connection-funded run when no liveness check is configured (fails closed)', () => {
    const { bridge } = make();
    expect(() => bridge.openRun({ ...RUN, connectionId: 'c', epoch: 1 })).toThrow(/liveness/);
    expect(() => bridge.openRun(RUN)).not.toThrow();
  });

  it('treats a HubSpot/Attio call whose action cannot be read from the arguments as strict', () => {
    expect(isStrictRepeatEffect('call_hubspot_api', { params: { action: 'DELETE' } })).toBe(true);
    expect(isStrictRepeatEffect('call_attio_api', { query: 'x' })).toBe(true);
    expect(isStrictRepeatEffect('call_hubspot_api', { action: 'LIST' })).toBe(false);
  });
});
