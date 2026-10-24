/**
 * ENG-2113 PR B: regression tests for the independent security and correctness review of the bridge. Each test
 * reproduces a scenario the review found and fails on the code as first written.
 */
import { ToolBridge, ToolBridgeAuthError, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps, type ToolBridgeOptions } from '../toolBridge';
import { RunToolTokenStore } from '../runToolToken';

const RUN = { runId: 'run-1', userId: 'user-1', sessionId: 'session-1' };
const TOOLS: BridgeTool[] = [{ name: 'get_leads' }, { name: 'meta_preview' }, { name: 'meta_confirm' }, { name: 'save_note' }, { name: 'send_email' }];

const ok = (content: string, extra: Partial<BridgeExecuteOutcome> = {}): BridgeExecuteOutcome => ({
  content,
  isError: false,
  requiresConfirmation: false,
  toolsChanged: false,
  ...extra,
});
const preview = (content: string): BridgeExecuteOutcome => ok(content, { requiresConfirmation: true, result: { awaitingUserConfirmation: true } });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function make(over: Partial<ToolBridgeDeps> = {}, opts: ToolBridgeOptions = {}) {
  const deps = {
    resolveTools: jest.fn(async () => TOOLS),
    isReadOnly: jest.fn((name: string) => name.startsWith('get_')),
    execute: jest.fn(async (_run: unknown, call: { name: string }) => ok(`${call.name} done`)),
    releaseRun: jest.fn(),
    ...over,
  } as unknown as ToolBridgeDeps & { execute: jest.Mock; releaseRun: jest.Mock };
  return { bridge: new ToolBridge(deps, new RunToolTokenStore(), opts), deps };
}

describe('ToolBridge review fixes', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers a halt that lands after the turn ended with a constant, not the approval token', async () => {
    const gate = deferred<BridgeExecuteOutcome>();
    const { bridge, deps } = make({ execute: jest.fn(async () => gate.promise) as any });
    const token = bridge.openRun(RUN);
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    const pending = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
    await flush();
    bridge.beginTurn(RUN.userId, RUN.sessionId); // a new user message, with no stop in between
    gate.resolve(preview('TOKEN=abc123'));
    const answered = await pending;
    expect(answered.isError).toBe(true);
    expect(answered.content).not.toContain('abc123');
    expect(bridge.isHalted(RUN.sessionId)).toBe(false);
    const record = bridge.takeLedger(RUN.runId).records[0];
    expect(record.staleHalt).toBe(true);
    expect(record.toolMessageContent).toContain('abc123'); // the ledger (backend only) keeps what the tool returned
    deps.execute.mockResolvedValue(ok('confirmed'));
  });

  it('never re-runs the halting call when its id is replayed', async () => {
    let n = 0;
    const { bridge, deps } = make({ execute: jest.fn(async () => preview(`TOKEN=${++n}`)) as any, persistHalt: jest.fn(async () => {}) });
    const token = bridge.openRun(RUN);
    bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', { x: 1 }, 'm1');
    const first = await bridge.callTool(token, { name: 'meta_preview', args: { x: 1 }, callId: 'a' });
    expect(first.content).toBe('TOKEN=1');
    const replay = await bridge.callTool(token, { name: 'meta_preview', args: { x: 1 }, callId: 'a' });
    expect(replay.isError).toBe(true);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses further writes in the same turn once an outcome is unknown, until the next turn; reads still work', async () => {
    const hung = deferred<BridgeExecuteOutcome>();
    let n = 0;
    const { bridge, deps } = make({ execute: jest.fn(async () => (n++ === 0 ? hung.promise : ok('ran'))) as any }, { callHoldLimitMs: 30 });
    const token = bridge.openRun(RUN);
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    const stuck = bridge.callTool(token, { name: 'send_email', args: { n: 1 } });
    await sleep(80);
    const blocked = await bridge.callTool(token, { name: 'save_note', args: {} });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('outcome is not known');
    expect((await bridge.callTool(token, { name: 'get_leads', args: {} })).isError).toBe(false);
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    expect((await bridge.callTool(token, { name: 'save_note', args: {} })).content).toBe('ran');
    hung.resolve(ok('late'));
    await stuck;
    expect(deps.execute).toHaveBeenCalledTimes(3);
  });

  it('does not let a halted group id from an earlier run admit a call in the replacement run', async () => {
    const { bridge, deps } = make({ execute: jest.fn(async (_r: unknown, call: any) => (call.name === 'meta_preview' ? preview('p') : ok('confirmed'))) as any });
    const t1 = bridge.openRun(RUN);
    bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', {}, 'msgX');
    await bridge.callTool(t1, { name: 'meta_preview', args: {}, callId: 'a' });
    const t2 = bridge.openRun(RUN); // replaced; the session stays halted
    bridge.noteToolUse(RUN.runId, 'c', 'meta_confirm', { token: 't' }, 'msgX'); // same message id again
    deps.execute.mockClear();
    const result = await bridge.callTool(t2, { name: 'meta_confirm', args: { token: 't' }, callId: 'c' });
    expect(result.isError).toBe(true);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  describe('legacy clearHalt', () => {
    it('does nothing when the session id is shared by two users and no user id is given', async () => {
      const { bridge } = make({ execute: jest.fn(async () => preview('p')) as any });
      const a = bridge.openRun(RUN);
      const other = { runId: 'run-2', userId: 'user-2', sessionId: RUN.sessionId };
      const b = bridge.openRun(other);
      await bridge.callTool(a, { name: 'meta_preview', args: {} });
      await bridge.callTool(b, { name: 'meta_preview', args: {} });
      bridge.clearHalt(RUN.sessionId);
      expect(bridge.isHalted(RUN.sessionId, 'user-1')).toBe(true);
      expect(bridge.isHalted(RUN.sessionId, 'user-2')).toBe(true);
      bridge.clearHalt(RUN.sessionId, 'user-1');
      expect(bridge.isHalted(RUN.sessionId, 'user-1')).toBe(false);
      expect(bridge.isHalted(RUN.sessionId, 'user-2')).toBe(true);
    });

    it('is a whole new turn: the old halts are gone and a stop no longer refuses everything', async () => {
      const { bridge } = make({ execute: jest.fn(async () => preview('p')) as any });
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      await bridge.callTool(token, { name: 'meta_preview', args: {} });
      bridge.cancelSession(RUN.userId, RUN.sessionId);
      bridge.clearHalt(RUN.sessionId);
      expect(bridge.takeHalts(RUN.userId, RUN.sessionId)).toEqual([]);
      const status = bridge.sessionStatus(RUN.userId, RUN.sessionId)!;
      expect(status.cancelled).toBe(false);
      expect(status.halted).toBe(false);
    });
  });

  it('caps the text kept in a halt', async () => {
    const { bridge } = make({ execute: jest.fn(async () => preview('y'.repeat(300_000))) as any });
    const token = bridge.openRun(RUN);
    await bridge.callTool(token, { name: 'meta_preview', args: {} });
    expect(bridge.takeHalts(RUN.userId, RUN.sessionId)[0].toolMessageContent.length).toBeLessThan(70_000);
  });

  describe('a stale close must not touch the run that replaced it', () => {
    it('a slow "not live" answer for the old claims leaves the replacement open and its executor state in place', async () => {
      const verdict = deferred<boolean>();
      let calls = 0;
      const isLive = jest.fn(async () => (calls++ === 0 ? verdict.promise : true));
      const { bridge, deps } = make({ isLive });
      const t1 = bridge.openRun({ ...RUN, connectionId: 'c', epoch: 1 });
      const inFlight = bridge.callTool(t1, { name: 'save_note', args: {} });
      await flush();
      const t2 = bridge.openRun({ ...RUN, connectionId: 'c', epoch: 2 }); // reopened with the new host epoch
      verdict.resolve(false); // the old check finally answers: the epoch it was asked about is gone
      await inFlight;
      const after = await bridge.callTool(t2, { name: 'save_note', args: { fresh: true } });
      expect(after).toEqual({ content: 'save_note done', isError: false });
      expect(deps.releaseRun).not.toHaveBeenCalled();
    });

    it('closeRunAndDrain does not close a run reopened during its wait', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const { bridge, deps } = make({ execute: jest.fn(async () => (n++ === 0 ? gate.promise : ok('second'))) as any });
      const t1 = bridge.openRun(RUN);
      void bridge.callTool(t1, { name: 'send_email', args: {} });
      await flush();
      const draining = bridge.closeRunAndDrain(RUN.runId, 200);
      await flush();
      const t2 = bridge.openRun(RUN);
      await draining;
      // the replacement survives the drain's close (its token still verifies)
      expect(() => bridge.verify(t2, RUN.runId)).not.toThrow();
      expect(deps.releaseRun).not.toHaveBeenCalled();
      gate.resolve(ok('first'));
    });
  });

  it('recording never throws, so a joined caller still gets the answer even when the result cannot be serialized', async () => {
    const gate = deferred<BridgeExecuteOutcome>();
    const { bridge } = make({ execute: jest.fn(async () => gate.promise) as any });
    const token = bridge.openRun(RUN);
    const first = bridge.callTool(token, { name: 'send_email', args: { n: 1 }, callId: 't1' });
    await flush();
    const retry = bridge.callTool(token, { name: 'send_email', args: { n: 1 }, callId: 't2' });
    await flush();
    gate.resolve(ok('sent', { result: { big: BigInt(10) } })); // JSON.stringify of this throws
    expect((await first).content).toBe('sent');
    expect((await retry).content).toBe('sent');
    const drained = await bridge.closeRunAndDrain(RUN.runId, 100);
    expect(drained?.settled).toBe(true);
  });

  it('pendingInGroup counts announced calls that have not been answered, including ones not yet received', async () => {
    const { bridge } = make();
    const token = bridge.openRun(RUN);
    bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { n: 1 }, 'm1');
    bridge.noteToolUse(RUN.runId, 'b', 'get_leads', { n: 2 }, 'm1');
    const groupId = bridge.takeLedger(RUN.runId).records.length === 0 ? findGroup(bridge, RUN.runId) : '';
    expect(bridge.pendingInGroup(RUN.runId, groupId)).toBe(2);
    await bridge.callTool(token, { name: 'get_leads', args: { n: 1 }, callId: 'a' });
    expect(bridge.pendingInGroup(RUN.runId, groupId)).toBe(1);
    await bridge.callTool(token, { name: 'get_leads', args: { n: 2 }, callId: 'b' });
    expect(bridge.pendingInGroup(RUN.runId, groupId)).toBe(0);
  });

  it('answers "turn ended", not a failure, when the halt is lifted while a sibling waits for the stream', async () => {
    const { bridge } = make({ execute: jest.fn(async () => preview('p')) as any });
    const token = bridge.openRun(RUN, { callGroupWaitMs: 300 });
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', {}, 'm1');
    await bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
    const waiting = bridge.callTool(token, { name: 'send_email', args: {}, callId: 'late' });
    await flush();
    bridge.beginTurn(RUN.userId, RUN.sessionId);
    const answer = await waiting;
    expect(answer.content).toContain('turn has ended');
    const kinds = bridge.takeLedger(RUN.runId).records.map((r) => r.kind);
    expect(kinds).not.toContain('failed');
  });

  it('closing a run while only a read executes does not mark the session unknown', async () => {
    const gate = deferred<BridgeExecuteOutcome>();
    const { bridge } = make({ execute: jest.fn(async () => gate.promise) as any });
    const token = bridge.openRun(RUN);
    void bridge.callTool(token, { name: 'get_leads', args: {} });
    await flush();
    bridge.closeRun(RUN.runId);
    expect(bridge.sessionStatus(RUN.userId, RUN.sessionId)?.unknownOutcome).toBe(false);
    gate.resolve(ok('x'));
  });

  it('a call that never reached the executor does not mark the session unknown when it outlives the hold limit', async () => {
    const { bridge } = make({ resolveTools: jest.fn(() => new Promise<BridgeTool[]>(() => {})) as any }, { callHoldLimitMs: 20 });
    const token = bridge.openRun(RUN);
    void bridge.callTool(token, { name: 'save_note', args: {} });
    await sleep(60);
    expect(bridge.sessionStatus(RUN.userId, RUN.sessionId)?.unknownOutcome).toBe(false);
  });

  describe('executor release', () => {
    it('waits for a call that is still executing, and does not release a reopened run', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const { bridge, deps } = make({ execute: jest.fn(async () => gate.promise) as any });
      const token = bridge.openRun(RUN);
      void bridge.callTool(token, { name: 'send_email', args: {} });
      await flush();
      bridge.closeRun(RUN.runId);
      expect(deps.releaseRun).not.toHaveBeenCalled();
      gate.resolve(ok('done'));
      await flush();
      await flush();
      expect(deps.releaseRun).toHaveBeenCalledTimes(1);
      expect(deps.releaseRun).toHaveBeenCalledWith(RUN.runId);

      const gate2 = deferred<BridgeExecuteOutcome>();
      const second = make({ execute: jest.fn(async () => gate2.promise) as any });
      const t = second.bridge.openRun(RUN);
      void second.bridge.callTool(t, { name: 'send_email', args: {} });
      await flush();
      second.bridge.closeRun(RUN.runId);
      second.bridge.openRun(RUN); // reopened before the old call finished
      gate2.resolve(ok('done'));
      await flush();
      await flush();
      expect(second.deps.releaseRun).not.toHaveBeenCalled();
    });
  });

  describe('ledger across turns', () => {
    it('takeLedger with clear empties it so a long-lived run keeps recording', async () => {
      const { bridge } = make();
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'get_leads', args: { n: 1 }, callId: 'a' });
      expect(bridge.takeLedger(RUN.runId, { clear: true }).records).toHaveLength(1);
      expect(bridge.takeLedger(RUN.runId).records).toHaveLength(0);
      await bridge.callTool(token, { name: 'get_leads', args: { n: 2 }, callId: 'b' });
      expect(bridge.takeLedger(RUN.runId).records.map((r) => r.toolCallId)).toEqual(['b']);
    });

    it('takeLedgerByGeneration does not detach the ledger of a run that is still open', async () => {
      const { bridge } = make();
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'get_leads', args: {}, callId: 'a' });
      expect(bridge.takeLedgerByGeneration(bridge.generationOf(RUN.runId)!).records).toEqual([]);
      expect(bridge.takeLedger(RUN.runId).records).toHaveLength(1);
    });
  });

  it('refuses the 17th concurrent call on a run', async () => {
    const gate = deferred<BridgeExecuteOutcome>();
    const { bridge } = make({ execute: jest.fn(async () => gate.promise) as any });
    const token = bridge.openRun(RUN);
    const calls = Array.from({ length: 16 }, (_, i) => bridge.callTool(token, { name: 'get_leads', args: { i } }));
    await flush();
    const seventeenth = await bridge.callTool(token, { name: 'get_leads', args: { i: 99 } });
    expect(seventeenth.isError).toBe(true);
    expect(seventeenth.content).toContain('Too many');
    gate.resolve(ok('x'));
    await Promise.all(calls);
  });

  it('splits two tool-use events with different message ids even with no result between them', async () => {
    const { bridge, deps } = make();
    const token = bridge.openRun(RUN, { callGroupWaitMs: 50 });
    bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { q: 1 }, 'm1');
    bridge.noteToolUse(RUN.runId, 'b', 'get_leads', { q: 1 }, 'm2'); // identical call, a different message: not a same-message repeat
    await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'a' });
    const second = await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'b' });
    expect(second.content).toBe('get_leads done');
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });

  it('a duplicate tool-use event for a known call neither moves it nor starts a group', async () => {
    const { bridge, deps } = make();
    const token = bridge.openRun(RUN, { callGroupWaitMs: 50 });
    bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { q: 1 }, 'm1');
    bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { q: 1 }, 'm9'); // repeated event with another id
    bridge.noteToolUse(RUN.runId, 'b', 'get_leads', { q: 1 }, 'm1');
    await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'a' });
    const second = await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'b' });
    expect(second.content).toContain('was collapsed');
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps users apart when they share a session id', async () => {
    const { bridge } = make({ execute: jest.fn(async (_r: unknown, call: any) => (call.args.halt ? preview('p') : ok('fine'))) as any });
    const mine = bridge.openRun(RUN);
    await bridge.callTool(mine, { name: 'meta_preview', args: { halt: true } });
    const other = { runId: 'run-2', userId: 'user-2', sessionId: RUN.sessionId };
    const theirs = bridge.openRun(other);
    expect((await bridge.callTool(theirs, { name: 'save_note', args: {} })).isError).toBe(false);
    expect(() => bridge.openRun({ ...other, runId: RUN.runId })).toThrow();
    await expect(bridge.callTool('wrong', { name: 'save_note', args: {} })).rejects.toBeInstanceOf(ToolBridgeAuthError);
  });
});

function findGroup(bridge: ToolBridge, runId: string): string {
  // The group id is internal: read it through a halt-free path by announcing and inspecting pendingInGroup candidates.
  const state = (bridge as unknown as { runs: Map<string, { announced: Map<string, { groupId: string }> }> }).runs.get(runId);
  return [...(state?.announced.values() ?? [])][0].groupId;
}
