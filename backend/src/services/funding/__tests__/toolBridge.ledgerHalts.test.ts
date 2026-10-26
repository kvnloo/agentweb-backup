import {
  ToolBridge,
  ToolBridgeAuthError,
  ToolBridgeUnavailableError,
  type BridgeExecuteOutcome,
  type BridgeHalt,
  type BridgeTool,
  type ToolBridgeDeps,
  type ToolBridgeOptions,
} from '../toolBridge';
import { RunToolTokenStore } from '../runToolToken';

const RUN = { runId: 'run-1', userId: 'user-1', sessionId: 'session-1' };
const TOOLS: BridgeTool[] = [
  { name: 'get_leads' },
  { name: 'meta_preview' },
  { name: 'send_email' },
  { name: 'save_note' },
];

const ok = (content: string, extra: Partial<BridgeExecuteOutcome> = {}): BridgeExecuteOutcome => ({
  content,
  isError: false,
  requiresConfirmation: false,
  toolsChanged: false,
  ...extra,
});
const preview = (content = 'preview'): BridgeExecuteOutcome => ok(content, { requiresConfirmation: true, result: { awaitingUserConfirmation: true, digest: 'd1' } });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeDeps(overrides: Partial<ToolBridgeDeps> = {}) {
  const deps = {
    resolveTools: jest.fn(async () => TOOLS),
    isReadOnly: jest.fn((name: string) => name.startsWith('get_')),
    execute: jest.fn(async (_run: unknown, call: { name: string }) => ok(`${call.name} done`)),
    releaseRun: jest.fn(),
    ...overrides,
  };
  return deps as unknown as ToolBridgeDeps & { execute: jest.Mock; releaseRun: jest.Mock };
}

function make(deps = makeDeps(), opts: ToolBridgeOptions = {}) {
  const bridge = new ToolBridge(deps, new RunToolTokenStore(), opts);
  return { bridge, deps };
}

describe('ToolBridge ledger, halts, stop and repeat guard', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── Halts are durable before the call returns ──────────────────────────────

  describe('halt persistence', () => {
    it('persists the halt before the halting call is answered and before the next write starts', async () => {
      const order: string[] = [];
      const persist = deferred<void>();
      const deps = makeDeps({
        execute: jest.fn(async (_run, call) => {
          order.push(`exec:${call.name}`);
          return call.name === 'meta_preview' ? preview() : ok('sent');
        }) as any,
        persistHalt: jest.fn(async () => {
          order.push('persist:start');
          await persist.promise;
          order.push('persist:end');
        }),
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', {}, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'send_email', {}, 'm1');

      const first = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await flush();
      await flush();
      expect(order).toEqual(['exec:meta_preview', 'persist:start']);
      let firstAnswered = false;
      void first.then(() => {
        firstAnswered = true;
      });
      await flush();
      expect(firstAnswered).toBe(false); // not answered until the halt is durable

      persist.resolve();
      await first;
      // a conforming client sends its next call only after this answer
      expect((await bridge.callTool(token, { name: 'send_email', args: {}, callId: 'b' })).isError).toBe(false);
      expect(order.indexOf('persist:end')).toBeLessThan(order.indexOf('exec:send_email'));
    });

    it('answers a fixed error, stays latched and asks for the fallback when persisting fails', async () => {
      const onHalted = jest.fn();
      const deps = makeDeps({
        execute: jest.fn(async () => preview('secret preview text')) as any,
        persistHalt: jest.fn(async () => {
          throw new Error('dynamo exploded with secret detail');
        }),
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN, { onHalted });
      const result = await bridge.callTool(token, { name: 'meta_preview', args: {} });
      expect(result.isError).toBe(true);
      expect(result.content).not.toContain('secret');
      expect(bridge.isHalted(RUN.sessionId)).toBe(true);
      expect(onHalted).toHaveBeenCalledTimes(1);
      expect(onHalted).toHaveBeenCalledWith({ fallbackNeeded: true });
      expect(bridge.takeHalts(RUN.userId, RUN.sessionId)[0].persisted).toBe(false);
    });

    it('treats a persist that hangs as a failure after the timeout', async () => {
      const deps = makeDeps({
        execute: jest.fn(async () => preview()) as any,
        persistHalt: jest.fn(() => new Promise<void>(() => {})),
      });
      const { bridge } = make(deps, { persistTimeoutMs: 30 });
      const onHalted = jest.fn();
      const token = bridge.openRun(RUN, { onHalted });
      const result = await bridge.callTool(token, { name: 'meta_preview', args: {} });
      expect(result.isError).toBe(true);
      expect(onHalted).toHaveBeenCalledWith({ fallbackNeeded: true });
    });

    it('reports a persisted halt without the fallback flag and keeps a copy for takeHalts', async () => {
      const persisted: BridgeHalt[] = [];
      const deps = makeDeps({
        execute: jest.fn(async () => preview()) as any,
        persistHalt: jest.fn(async (halt) => {
          persisted.push(halt);
        }),
      });
      const { bridge } = make(deps);
      const onHalted = jest.fn();
      const token = bridge.openRun(RUN, { onHalted });
      const result = await bridge.callTool(token, { name: 'meta_preview', args: { x: 1 }, callId: 'a' });
      expect(result).toEqual({ content: 'preview', isError: false });
      expect(onHalted).toHaveBeenCalledWith({ fallbackNeeded: false });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({ callId: 'a', name: 'meta_preview', args: { x: 1 }, result: { digest: 'd1' }, epoch: 0 });
      const taken = bridge.takeHalts(RUN.userId, RUN.sessionId);
      expect(taken[0].persisted).toBe(true);
      taken[0].args.x = 99; // a copy: mutating it changes nothing in the bridge
      expect(bridge.takeHalts(RUN.userId, RUN.sessionId)[0].args.x).toBe(1);
    });
  });

  // ─── Admission after a halt ─────────────────────────────────────────────────

  describe('same-message siblings after a halt', () => {
    function setup(extra: Partial<ToolBridgeDeps> = {}, opts: ToolBridgeOptions = {}, runOpts = {}) {
      const deps = makeDeps({
        execute: jest.fn(async (_run, call: any) => (call.name === 'meta_preview' ? preview(`preview ${call.callId}`) : ok(`${call.name} ran`))) as any,
        ...extra,
      });
      const { bridge } = make(deps, opts);
      const token = bridge.openRun(RUN, runOpts);
      return { bridge, deps, token };
    }

    it('admits every announced sibling of the first halt, one batched confirmation', async () => {
      const { bridge, deps, token } = setup();
      bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', { n: 1 }, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'meta_preview', { n: 2 }, 'm1');
      bridge.noteToolUse(RUN.runId, 'c', 'meta_preview', { n: 3 }, 'm1');
      const ra = await bridge.callTool(token, { name: 'meta_preview', args: { n: 1 }, callId: 'a' });
      const rb = await bridge.callTool(token, { name: 'meta_preview', args: { n: 2 }, callId: 'b' });
      const rc = await bridge.callTool(token, { name: 'meta_preview', args: { n: 3 }, callId: 'c' });
      expect([ra.isError, rb.isError, rc.isError]).toEqual([false, false, false]);
      expect(deps.execute).toHaveBeenCalledTimes(3);
      expect(bridge.takeHalts(RUN.userId, RUN.sessionId).map((h) => h.callId)).toEqual(['a', 'b', 'c']);
    });

    it('refuses a call from another model message, a repeat, a forged id, or a mismatch', async () => {
      const { bridge, deps, token } = setup();
      bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', {}, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'send_email', { to: 'x' }, 'm1');
      await bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      deps.execute.mockClear();

      // next model message
      bridge.noteToolResult(RUN.runId, 'a');
      bridge.noteToolUse(RUN.runId, 'z', 'send_email', { to: 'x' }, 'm2');
      const otherMessage = await bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 'z' });
      // forged id the stream never announced
      const forged = await bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 'nope' });
      // no id at all
      const noId = await bridge.callTool(token, { name: 'send_email', args: { to: 'x' } });
      // right id, different args than announced
      const argsMismatch = await bridge.callTool(token, { name: 'send_email', args: { to: 'attacker' }, callId: 'b' });
      // right id, different tool than announced
      const nameMismatch = await bridge.callTool(token, { name: 'save_note', args: { to: 'x' }, callId: 'b' });
      for (const refused of [otherMessage, forged, noId, argsMismatch, nameMismatch]) {
        expect(refused.isError).toBe(true);
        expect(refused.content).toContain('waiting for the user to confirm');
      }
      expect(deps.execute).not.toHaveBeenCalled();

      // the genuine sibling still goes through, once
      const genuine = await bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 'b' });
      expect(genuine.isError).toBe(false);
      const replay = await bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 'b' });
      expect(replay.isError).toBe(true);
      expect(deps.execute).toHaveBeenCalledTimes(1);
      expect(bridge.sessionStatus(RUN.userId, RUN.sessionId)?.refusedWhileHalted).toBe(6);
    });

    it('admits a sibling whose announcement arrives after the call, within the group wait', async () => {
      const { bridge, deps, token } = setup({}, {}, { callGroupWaitMs: 500 });
      bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', {}, 'm1');
      await bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      const pending = bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 'late' });
      await flush();
      // announced in the same message as the first halt (cursor still on m1, no result between)
      bridge.noteToolUse(RUN.runId, 'late', 'send_email', { to: 'x' }, 'm1');
      expect((await pending).isError).toBe(false);
      expect(deps.execute).toHaveBeenCalledTimes(2);
    });

    it('closes admission after the window', async () => {
      const { bridge, deps, token } = setup({}, { haltAdmissionWindowMs: 20 });
      bridge.noteToolUse(RUN.runId, 'a', 'meta_preview', {}, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'send_email', {}, 'm1');
      await bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await sleep(40);
      deps.execute.mockClear();
      const late = await bridge.callTool(token, { name: 'send_email', args: {}, callId: 'b' });
      expect(late.isError).toBe(true);
      expect(deps.execute).not.toHaveBeenCalled();
    });

    it('refuses every sibling when the stream never announced the first halt (fail closed)', async () => {
      const { bridge, deps, token } = setup();
      await bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      bridge.noteToolUse(RUN.runId, 'b', 'send_email', {}, 'm1');
      deps.execute.mockClear();
      expect((await bridge.callTool(token, { name: 'send_email', args: {}, callId: 'b' })).isError).toBe(true);
      expect(deps.execute).not.toHaveBeenCalled();
    });
  });

  // ─── Turns and stop ─────────────────────────────────────────────────────────

  describe('turns and stop', () => {
    it('beginTurn lifts the halt and refuses a call that arrived in the previous epoch', async () => {
      const execStarted = deferred<void>();
      const release = deferred<BridgeExecuteOutcome>();
      const persistHalt = jest.fn(async () => {});
      const deps = makeDeps({
        execute: jest.fn(async () => {
          execStarted.resolve();
          return release.promise;
        }) as any,
        persistHalt,
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const inFlight = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await execStarted.promise;
      // a new user message arrives while the old turn's call is still executing
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      release.resolve(preview());
      await inFlight;
      expect(persistHalt).not.toHaveBeenCalled(); // a stale halt is never persisted as awaiting
      expect(bridge.isHalted(RUN.sessionId)).toBe(false);
      const ledger = bridge.takeLedger(RUN.runId).records;
      expect(ledger[0].staleHalt).toBe(true);
    });

    it('records what the model was actually handed when it differs from what the tool returned', async () => {
      const execStarted = deferred<void>();
      const release = deferred<BridgeExecuteOutcome>();
      const deps = makeDeps({
        execute: jest.fn(async () => {
          execStarted.resolve();
          return release.promise;
        }) as any,
        persistHalt: jest.fn(async () => {}),
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const inFlight = bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await execStarted.promise;
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      release.resolve(preview('APPROVAL-TOKEN-abc'));
      const answered = await inFlight;
      const [rec] = bridge.takeLedger(RUN.runId).records;
      expect(rec.toolMessageContent).toBe('APPROVAL-TOKEN-abc'); // the ledger keeps the real text
      expect(answered.content).not.toContain('APPROVAL-TOKEN');
      expect(rec.answeredContent).toBe(answered.content); // chat history must use this one
      expect(rec.answeredContent).not.toContain('APPROVAL-TOKEN');
    });

    it('records answeredContent when persisting the halt failed, and omits it for an ordinary call', async () => {
      const deps = makeDeps({
        execute: jest.fn(async (_run, call) => (call.name === 'meta_preview' ? preview('secret preview text') : ok('plain'))) as any,
        persistHalt: jest.fn(async () => {
          throw new Error('boom');
        }),
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const failed = await bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      const [rec] = bridge.takeLedger(RUN.runId).records;
      expect(rec.toolMessageContent).toBe('secret preview text');
      expect(rec.answeredContent).toBe(failed.content);

      const { bridge: b2 } = make();
      const t2 = b2.openRun({ ...RUN, runId: 'run-2' });
      b2.beginTurn(RUN.userId, RUN.sessionId);
      await b2.callTool(t2, { name: 'get_leads', args: {}, callId: 'x' });
      const [plain] = b2.takeLedger('run-2').records;
      expect(plain.toolMessageContent).toBe('get_leads done');
      expect(plain.answeredContent).toBeUndefined();
    });

    it('refuses a call that was queued in an earlier epoch once the turn ended', async () => {
      const first = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const deps = makeDeps({ execute: jest.fn(async () => (n++ === 0 ? first.promise : ok('second'))) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const a = bridge.callTool(token, { name: 'save_note', args: { n: 1 } });
      const b = bridge.callTool(token, { name: 'save_note', args: { n: 2 } });
      await flush();
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      first.resolve(ok('first'));
      await a;
      const refused = await b;
      expect(refused.isError).toBe(true);
      expect(refused.content).toContain('turn has ended');
      expect(deps.execute).toHaveBeenCalledTimes(1);
    });

    it('cancelSession is a no-op when no turn is active', async () => {
      const { bridge } = make();
      const token = bridge.openRun(RUN);
      expect(bridge.cancelSession(RUN.userId, RUN.sessionId)).toEqual({ cancelled: false, runIds: [] });
      expect((await bridge.callTool(token, { name: 'save_note', args: {} })).isError).toBe(false);
    });

    it('cancelSession refuses queued and new calls, lets the executing call finish and flags it', async () => {
      const running = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const deps = makeDeps({ execute: jest.fn(async () => (n++ === 0 ? running.promise : ok('should not run'))) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const executing = bridge.callTool(token, { name: 'save_note', args: { n: 1 } });
      const queued = bridge.callTool(token, { name: 'save_note', args: { n: 2 } });
      await flush();
      const cancel = bridge.cancelSession(RUN.userId, RUN.sessionId);
      expect(cancel).toEqual({ cancelled: true, runIds: [RUN.runId] });
      // the run is closed and its token dead
      await expect(bridge.callTool(token, { name: 'save_note', args: {} })).rejects.toBeInstanceOf(ToolBridgeAuthError);
      running.resolve(ok('finished anyway'));
      await executing;
      void queued;
      await flush();
      expect(deps.execute).toHaveBeenCalledTimes(1);
      const generation = bridge.generationOf(RUN.runId)!;
      const records = bridge.takeLedgerByGeneration(generation).records;
      const finished = records.find((r) => r.name === 'save_note' && r.kind === 'executed');
      expect(finished?.cancelledDuringCall).toBe(true);
      expect(finished?.late).toBe(true);
      const refused = records.filter((r) => r.kind === 'refused');
      expect(refused.some((r) => r.toolMessageContent.includes('user stopped'))).toBe(true);
    });

    it('a stop never touches a halt that is already pending', async () => {
      const persistHalt = jest.fn(async () => {});
      const deps = makeDeps({ execute: jest.fn(async () => preview()) as any, persistHalt });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      await bridge.callTool(token, { name: 'meta_preview', args: {} });
      bridge.cancelSession(RUN.userId, RUN.sessionId);
      expect(bridge.isHalted(RUN.sessionId)).toBe(true);
      expect(bridge.takeHalts(RUN.userId, RUN.sessionId)).toHaveLength(1);
    });

    it('the next turn works after a stop', async () => {
      const { bridge, deps } = make();
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      bridge.cancelSession(RUN.userId, RUN.sessionId);
      void token;
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const token2 = bridge.openRun(RUN);
      expect((await bridge.callTool(token2, { name: 'save_note', args: {} })).isError).toBe(false);
      expect(deps.execute).toHaveBeenCalledTimes(1);
    });

    it('a stop for one user does not touch another user with the same session id', async () => {
      const { bridge } = make();
      const mine = bridge.openRun(RUN);
      const other = { runId: 'run-2', userId: 'user-2', sessionId: RUN.sessionId };
      const theirs = bridge.openRun(other);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      bridge.beginTurn(other.userId, other.sessionId);
      bridge.cancelSession(other.userId, other.sessionId);
      expect((await bridge.callTool(mine, { name: 'save_note', args: {} })).isError).toBe(false);
      await expect(bridge.callTool(theirs, { name: 'save_note', args: {} })).rejects.toBeInstanceOf(ToolBridgeAuthError);
    });
  });

  // ─── A write never runs twice ───────────────────────────────────────────────

  describe('repeat guard', () => {
    it('an identical call that arrives while the first is still executing joins it and never executes', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const deps = makeDeps({ execute: jest.fn(async () => gate.promise) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      const first = bridge.callTool(token, { name: 'send_email', args: { to: 'a@b.c', body: 'hi' }, callId: 't1' });
      await flush();
      // the CLI cut the call at 60 s and the model re-proposed it with a new tool-use id
      const retry = bridge.callTool(token, { name: 'send_email', args: { body: 'hi', to: 'a@b.c' }, callId: 't2' });
      await flush();
      gate.resolve(ok('sent once'));
      const [r1, r2] = await Promise.all([first, retry]);
      expect(r1.content).toBe('sent once');
      expect(r2.content).toBe('sent once');
      expect(deps.execute).toHaveBeenCalledTimes(1);
      const kinds = bridge.takeLedger(RUN.runId).records.map((r) => r.kind).sort();
      expect(kinds).toEqual(['executed', 'joined']);
    });

    it('does not share a failure, a refusal or a confirmation with the joiner', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const deps = makeDeps({ execute: jest.fn(async () => gate.promise) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      const first = bridge.callTool(token, { name: 'send_email', args: { n: 1 }, callId: 't1' });
      await flush();
      const retry = bridge.callTool(token, { name: 'send_email', args: { n: 1 }, callId: 't2' });
      await flush();
      gate.resolve(preview('approval token abc123'));
      await first;
      const joined = await retry;
      expect(joined.isError).toBe(true);
      expect(joined.content).not.toContain('abc123');
      expect(deps.execute).toHaveBeenCalledTimes(1);
    });

    it('different arguments are a different action and run', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const deps = makeDeps({ execute: jest.fn(async () => (n++ === 0 ? gate.promise : ok('second'))) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      const first = bridge.callTool(token, { name: 'send_email', args: { n: 1 } });
      const second = bridge.callTool(token, { name: 'send_email', args: { n: 2 } });
      await flush();
      gate.resolve(ok('first'));
      await first;
      expect((await second).content).toBe('second');
      expect(deps.execute).toHaveBeenCalledTimes(2);
    });

    it('returns the original outcome for an identical strict-effect call after completion, without running it', async () => {
      const deps = makeDeps({
        execute: jest.fn(async () => ok('email sent id=1')) as any,
        isStrictEffect: jest.fn((name: string) => name === 'send_email'),
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 't1' });
      const again = await bridge.callTool(token, { name: 'send_email', args: { to: 'x' }, callId: 't2' });
      expect(again.isError).toBe(false);
      expect(again.content).toContain('email sent id=1');
      expect(again.content).toContain('was not run again');
      expect(deps.execute).toHaveBeenCalledTimes(1);
    });

    it('lets a non-strict repeat run again (a legitimate repeat such as a browser click)', async () => {
      const deps = makeDeps({ isStrictEffect: jest.fn(() => false) });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'save_note', args: {}, callId: 't1' });
      await bridge.callTool(token, { name: 'save_note', args: {}, callId: 't2' });
      expect(deps.execute).toHaveBeenCalledTimes(2);
    });

    it('forgets completed strict calls once another write ran, and at the next turn', async () => {
      const deps = makeDeps({ isStrictEffect: jest.fn((name: string) => name === 'send_email') });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'send_email', args: { to: 'x' } });
      await bridge.callTool(token, { name: 'save_note', args: {} });
      await bridge.callTool(token, { name: 'send_email', args: { to: 'x' } });
      expect(deps.execute).toHaveBeenCalledTimes(3);
      await bridge.callTool(token, { name: 'send_email', args: { to: 'x' } }); // collapsed to the previous one
      expect(deps.execute).toHaveBeenCalledTimes(3);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      await bridge.callTool(token, { name: 'send_email', args: { to: 'x' } });
      expect(deps.execute).toHaveBeenCalledTimes(4);
    });

    it('does not join read-only calls', async () => {
      const deps = makeDeps();
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await Promise.all([
        bridge.callTool(token, { name: 'get_leads', args: { q: 1 } }),
        bridge.callTool(token, { name: 'get_leads', args: { q: 1 } }),
      ]);
      expect(deps.execute).toHaveBeenCalledTimes(2);
    });

    it('releases the write slot when a call outlives its hold limit, marks the outcome unknown and blocks writes until the next turn', async () => {
      const hung = deferred<BridgeExecuteOutcome>();
      let n = 0;
      const deps = makeDeps({ execute: jest.fn(async () => (n++ === 0 ? hung.promise : ok('next'))) as any });
      const { bridge } = make(deps, { callHoldLimitMs: 40 });
      const token = bridge.openRun(RUN);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const stuck = bridge.callTool(token, { name: 'send_email', args: { n: 1 }, callId: 't1' });
      const retry = bridge.callTool(token, { name: 'send_email', args: { n: 1 }, callId: 't2' });
      const queued = bridge.callTool(token, { name: 'save_note', args: {} }); // already queued behind the hung write
      const joined = await retry;
      expect(joined.isError).toBe(true);
      expect(joined.content).toContain('outcome is not known');
      // the slot is free, but the queued write may not run past the unknown outcome
      expect((await queued).content).toContain('outcome is not known');
      expect(bridge.sessionStatus(RUN.userId, RUN.sessionId)?.unknownOutcome).toBe(true);
      hung.resolve(ok('finally'));
      await stuck;
      const rec = bridge.takeLedger(RUN.runId).records.find((r) => r.toolCallId === 't1');
      expect(rec?.heldPastLimit).toBe(true);
      expect(bridge.beginTurn(RUN.userId, RUN.sessionId).previousUnknownOutcome).toBe(true);
      expect((await bridge.callTool(token, { name: 'save_note', args: {} })).content).toBe('next');
    });
  });

  // ─── Grouping ───────────────────────────────────────────────────────────────

  describe('grouping from the stream', () => {
    it('collapses an identical call repeated in one model message', async () => {
      const deps = makeDeps();
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN, { callGroupWaitMs: 50 });
      bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { q: 1 }, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'get_leads', { q: 1 }, 'm1');
      const a = await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'a' });
      const b = await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'b' });
      expect(a.content).toBe('get_leads done');
      expect(b.content).toContain('was collapsed');
      expect(deps.execute).toHaveBeenCalledTimes(1);
    });

    it('a tool result starts a new group, so the same call in the next message runs', async () => {
      const deps = makeDeps();
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN, { callGroupWaitMs: 50 });
      bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { q: 1 });
      await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'a' });
      bridge.noteToolResult(RUN.runId, 'a');
      bridge.noteToolUse(RUN.runId, 'b', 'get_leads', { q: 1 });
      const b = await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'b' });
      expect(b.content).toBe('get_leads done');
      expect(deps.execute).toHaveBeenCalledTimes(2);
    });

    it('splits on a message-id disagreement even without a result between them (the safe direction)', async () => {
      const { bridge } = make();
      bridge.openRun(RUN);
      bridge.noteToolUse(RUN.runId, 'a', 'get_leads', {}, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'get_leads', {}, 'm2');
      bridge.noteToolUse(RUN.runId, 'c', 'get_leads', {}, 'm2');
      const token = bridge.openRun(RUN);
      void token;
      // a duplicate event for a known call neither moves it nor starts a group
      bridge.noteToolUse(RUN.runId, 'a', 'get_leads', {}, 'm9');
      expect(bridge.pendingInGroup(RUN.runId, 'unknown')).toBe(0);
    });

    it('orders the ledger by stream position, not arrival order', async () => {
      const { bridge } = make();
      const token = bridge.openRun(RUN);
      bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { n: 1 }, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'get_leads', { n: 2 }, 'm1');
      bridge.noteToolResult(RUN.runId);
      bridge.noteToolUse(RUN.runId, 'c', 'get_leads', { n: 3 }, 'm2');
      await bridge.callTool(token, { name: 'get_leads', args: { n: 3 }, callId: 'c' });
      await bridge.callTool(token, { name: 'get_leads', args: { n: 2 }, callId: 'b' });
      await bridge.callTool(token, { name: 'get_leads', args: { n: 1 }, callId: 'a' });
      expect(bridge.takeLedger(RUN.runId).records.map((r) => r.toolCallId)).toEqual(['a', 'b', 'c']);
    });
  });

  // ─── Ledger ─────────────────────────────────────────────────────────────────

  describe('ledger', () => {
    it('records executed, collapsed, refused and failed calls with the minimal result and model text', async () => {
      const deps = makeDeps({
        execute: jest.fn(async (_run, call: any) => {
          if (call.name === 'save_note') throw new Error('boom with private detail');
          return ok('listed', { result: { rows: 2 } });
        }) as any,
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'a' });
      await bridge.callTool(token, { name: 'save_note', args: {}, callId: 'b' });
      await bridge.callTool(token, { name: 'not_a_tool', args: {}, callId: 'c' });
      const records = bridge.takeLedger(RUN.runId).records;
      const byId = Object.fromEntries(records.map((r) => [r.toolCallId, r]));
      expect(byId.a).toMatchObject({ kind: 'executed', result: { rows: 2 }, toolMessageContent: 'listed', isError: false });
      expect(byId.b).toMatchObject({ kind: 'failed', isError: true });
      expect(byId.b.toolMessageContent).not.toContain('private detail');
      expect(byId.c).toMatchObject({ kind: 'refused', isError: true });
      expect(records.every((r) => typeof r.durationMs === 'number' && r.endedAt >= r.startedAt)).toBe(true);
    });

    it('names the call a collapsed duplicate repeats', async () => {
      const { bridge } = make();
      const token = bridge.openRun(RUN);
      bridge.noteToolUse(RUN.runId, 'a', 'get_leads', { q: 1 }, 'm1');
      bridge.noteToolUse(RUN.runId, 'b', 'get_leads', { q: 1 }, 'm1');
      await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'a' });
      await bridge.callTool(token, { name: 'get_leads', args: { q: 1 }, callId: 'b' });
      const records = bridge.takeLedger(RUN.runId).records;
      const dup = records.find((r) => r.toolCallId === 'b')!;
      expect(dup).toMatchObject({ kind: 'collapsed', duplicateOfId: 'a' });
      expect(records.find((r) => r.toolCallId === 'a')!.duplicateOfId).toBeUndefined();
    });

    it('keeps a call that finishes after the run closed, under the same generation', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const deps = makeDeps({ execute: jest.fn(async () => gate.promise) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      void bridge.callTool(token, { name: 'send_email', args: {}, callId: 'a' });
      await flush();
      const generation = bridge.generationOf(RUN.runId)!;
      bridge.closeRun(RUN.runId);
      gate.resolve(ok('sent late'));
      await flush();
      const late = bridge.takeLedgerByGeneration(generation).records;
      expect(late).toHaveLength(1);
      expect(late[0]).toMatchObject({ toolCallId: 'a', kind: 'executed', late: true, revokedDuringCall: true });
      expect(bridge.sessionStatus(RUN.userId, RUN.sessionId)?.unknownOutcome).toBe(true);
    });

    it('persists a halt that lands after the run closed', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const persistHalt = jest.fn(async () => {});
      const deps = makeDeps({ execute: jest.fn(async () => gate.promise) as any, persistHalt });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      void bridge.callTool(token, { name: 'meta_preview', args: {}, callId: 'a' });
      await flush();
      bridge.closeRun(RUN.runId);
      gate.resolve(preview());
      await flush();
      await flush();
      expect(persistHalt).toHaveBeenCalledTimes(1);
      expect(bridge.isHalted(RUN.sessionId)).toBe(true);
    });

    it('bounds the ledger but never drops a halt', async () => {
      const deps = makeDeps({
        execute: jest.fn(async (_run, call: any) => (call.args.halt ? preview() : ok('x'.repeat(10)))) as any,
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'meta_preview', args: { halt: true }, callId: 'h' });
      for (let i = 0; i < 520; i++) await bridge.callTool(token, { name: 'get_leads', args: { i }, callId: `r${i}` });
      const taken = bridge.takeLedger(RUN.runId);
      expect(taken.records.length).toBeLessThanOrEqual(512);
      expect(taken.truncated).toBeGreaterThan(0);
      expect(bridge.takeHalts(RUN.userId, RUN.sessionId).map((h) => h.callId)).toEqual(['h']);
    });

    it('returns deep copies', async () => {
      const deps = makeDeps({ execute: jest.fn(async () => ok('fine', { result: { a: { b: 1 } } })) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'get_leads', args: {}, callId: 'a' });
      const first = bridge.takeLedger(RUN.runId).records;
      (first[0].result as any).a.b = 2;
      expect((bridge.takeLedger(RUN.runId).records[0].result as any).a.b).toBe(1);
    });

    it('flags a request the harness dropped', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const deps = makeDeps({ execute: jest.fn(async () => gate.promise) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      const ac = new AbortController();
      const p = bridge.callTool(token, { name: 'send_email', args: {}, callId: 'a' }, undefined, { signal: ac.signal });
      await flush();
      ac.abort();
      gate.resolve(ok('done'));
      await p;
      expect(bridge.takeLedger(RUN.runId).records[0].abortedByClient).toBe(true);
    });

    it('never writes tool arguments, results or halt payloads to the console', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const deps = makeDeps({
        execute: jest.fn(async (_run, call: any) => {
          if (call.args.fail) throw new Error('db said: password=hunter2');
          return preview('token=SECRET-APPROVAL');
        }) as any,
        persistHalt: jest.fn(async () => {
          throw new Error('persist secret=XYZ');
        }),
      });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      await bridge.callTool(token, { name: 'send_email', args: { fail: true, to: 'victim@x.y' } });
      await bridge.callTool(token, { name: 'meta_preview', args: { to: 'victim@x.y' } });
      const output = JSON.stringify([...spy.mock.calls, ...log.mock.calls]);
      expect(output).not.toContain('victim@x.y');
      expect(output).not.toContain('SECRET-APPROVAL');
      expect(output).not.toContain('XYZ');
    });
  });

  // ─── Drain ──────────────────────────────────────────────────────────────────

  describe('drain', () => {
    it('waits for in-flight calls, refuses new ones, and returns the ledger and halts', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const deps = makeDeps({ execute: jest.fn(async () => gate.promise) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      const call = bridge.callTool(token, { name: 'send_email', args: {}, callId: 'a' });
      await flush();
      const draining = bridge.closeRunAndDrain(RUN.runId, 1000);
      await flush();
      expect((await bridge.callTool(token, { name: 'get_leads', args: {} })).content).toBe('This run has ended.');
      gate.resolve(preview('p'));
      const drained = (await draining)!;
      await call;
      expect(drained.settled).toBe(true);
      expect(drained.ledger.map((r) => r.toolCallId)).toContain('a');
      expect(drained.halts.map((h) => h.callId)).toEqual(['a']);
      expect(deps.releaseRun).toHaveBeenCalledWith(RUN.runId);
    });

    it('times out on a call that does not finish and reports it', async () => {
      const deps = makeDeps({ execute: jest.fn(() => new Promise<BridgeExecuteOutcome>(() => {})) as any });
      const { bridge } = make(deps);
      const token = bridge.openRun(RUN);
      void bridge.callTool(token, { name: 'send_email', args: {} });
      await flush();
      const drained = (await bridge.closeRunAndDrain(RUN.runId, 30))!;
      expect(drained.settled).toBe(false);
      expect(drained.stillRunning).toBe(1);
    });
  });

  // ─── Runs ───────────────────────────────────────────────────────────────────

  describe('runs and sessions', () => {
    it('replacing a run frees the slot of the write it abandons, and that write blocks further writes in the same turn', async () => {
      const first = deferred<BridgeExecuteOutcome>();
      const order: string[] = [];
      let n = 0;
      const deps = makeDeps({
        execute: jest.fn(async (_run, call: any) => {
          order.push(call.args.id);
          return n++ === 0 ? first.promise : ok('second');
        }) as any,
      });
      const { bridge } = make(deps);
      bridge.beginTurn(RUN.userId, RUN.sessionId);
      const t1 = bridge.openRun(RUN);
      void bridge.callTool(t1, { name: 'save_note', args: { id: 'one' } });
      await flush();
      const t2 = bridge.openRun(RUN); // reconnect: same run id, new token; the first write's answer can no longer reach the model
      const sameTurn = await bridge.callTool(t2, { name: 'save_note', args: { id: 'two' } });
      expect(sameTurn.content).toContain('outcome is not known');
      expect(order).toEqual(['one']);
      bridge.beginTurn(RUN.userId, RUN.sessionId); // the user answers: a new turn runs without waiting for the abandoned write
      expect((await bridge.callTool(t2, { name: 'save_note', args: { id: 'three' } })).content).toBe('second');
      expect(order).toEqual(['one', 'three']);
      first.resolve(ok('first'));
    });

    it('refuses to open a run id that is open for another user or session', () => {
      const { bridge } = make();
      bridge.openRun(RUN);
      expect(() => bridge.openRun({ ...RUN, userId: 'user-2' })).toThrow();
      expect(() => bridge.openRun({ ...RUN, sessionId: 'other' })).toThrow();
    });

    it('keeps the halt of one user from affecting another user with the same session id', async () => {
      const deps = makeDeps({ execute: jest.fn(async () => preview()) as any });
      const { bridge } = make(deps);
      const t1 = bridge.openRun(RUN);
      await bridge.callTool(t1, { name: 'meta_preview', args: {} });
      const other = { runId: 'run-2', userId: 'user-2', sessionId: RUN.sessionId };
      const t2 = bridge.openRun(other);
      bridge.beginTurn(other.userId, other.sessionId);
      deps.execute.mockResolvedValueOnce(ok('fine'));
      expect((await bridge.callTool(t2, { name: 'save_note', args: {} })).isError).toBe(false);
      expect(bridge.isHalted(RUN.sessionId, RUN.userId)).toBe(true);
      expect(bridge.isHalted(RUN.sessionId, other.userId)).toBe(false);
    });
  });

  // ─── Liveness ───────────────────────────────────────────────────────────────

  describe('liveness', () => {
    const claims = { ...RUN, connectionId: 'conn-1', epoch: 4 };

    it('closes the run and refuses when the connection is definitely gone', async () => {
      const isLive = jest.fn(async () => false);
      const deps = makeDeps({ isLive });
      const { bridge } = make(deps);
      const token = bridge.openRun(claims);
      const result = await bridge.callTool(token, { name: 'save_note', args: {} });
      expect(result.isError).toBe(true);
      expect(deps.execute).not.toHaveBeenCalled();
      await expect(bridge.callTool(token, { name: 'save_note', args: {} })).rejects.toBeInstanceOf(ToolBridgeAuthError);
    });

    it('refuses only that call, retryably, when liveness cannot be determined', async () => {
      let fail = true;
      const isLive = jest.fn(async () => {
        if (fail) throw new Error('db down');
        return true;
      });
      const deps = makeDeps({ isLive });
      const { bridge } = make(deps);
      const token = bridge.openRun(claims);
      const blip = await bridge.callTool(token, { name: 'save_note', args: {} });
      expect(blip.isError).toBe(true);
      expect(deps.execute).not.toHaveBeenCalled();
      fail = false;
      expect((await bridge.callTool(token, { name: 'save_note', args: {} })).isError).toBe(false);
    });

    it('treats a liveness check that hangs as unknown', async () => {
      const deps = makeDeps({ isLive: jest.fn(() => new Promise<boolean>(() => {})) });
      const { bridge } = make(deps, { liveTimeoutMs: 30 });
      const token = bridge.openRun(claims);
      expect((await bridge.callTool(token, { name: 'save_note', args: {} })).isError).toBe(true);
      expect(deps.execute).not.toHaveBeenCalled();
    });

    it('never caches a positive answer for a write, and caches it briefly for reads', async () => {
      const isLive = jest.fn(async () => true);
      const deps = makeDeps({ isLive });
      const { bridge } = make(deps);
      const token = bridge.openRun(claims);
      await bridge.callTool(token, { name: 'save_note', args: { n: 1 } });
      await bridge.callTool(token, { name: 'save_note', args: { n: 2 } });
      const writeChecks = isLive.mock.calls.filter((call: any[]) => call[1].write === true).length;
      expect(writeChecks).toBe(2);
      isLive.mockClear();
      await bridge.callTool(token, { name: 'get_leads', args: { n: 1 } });
      await bridge.callTool(token, { name: 'get_leads', args: { n: 2 } });
      expect(isLive).toHaveBeenCalledTimes(1);
    });

    it('is checked before the tool list is served', async () => {
      const deps = makeDeps({ isLive: jest.fn(async () => false) });
      const { bridge } = make(deps);
      const token = bridge.openRun(claims);
      await expect(bridge.listTools(token)).rejects.toBeInstanceOf(ToolBridgeAuthError);
      const deps2 = makeDeps({ isLive: jest.fn(async () => { throw new Error('x'); }) });
      const { bridge: bridge2 } = make(deps2);
      const token2 = bridge2.openRun(claims);
      await expect(bridge2.listTools(token2)).rejects.toBeInstanceOf(ToolBridgeUnavailableError);
    });

    it('revokeConnection closes every run funded by that connection and returns their ids', async () => {
      const { bridge } = make(makeDeps({ isLive: jest.fn(async () => true) }));
      const t1 = bridge.openRun(claims);
      const t2 = bridge.openRun({ runId: 'run-2', userId: 'user-2', sessionId: 's2' });
      const t3 = bridge.openRun({ runId: 'run-3', userId: 'user-1', sessionId: 's3', connectionId: 'conn-other', epoch: 1 });
      expect(bridge.revokeConnection('conn-1')).toEqual(['run-1']);
      await expect(bridge.callTool(t1, { name: 'save_note', args: {} })).rejects.toBeInstanceOf(ToolBridgeAuthError);
      expect((await bridge.callTool(t2, { name: 'save_note', args: {} })).isError).toBe(false);
      expect((await bridge.callTool(t3, { name: 'save_note', args: {} })).isError).toBe(false);
    });

    it('a write that was revoked while it executed is flagged', async () => {
      const gate = deferred<BridgeExecuteOutcome>();
      const deps = makeDeps({ execute: jest.fn(async () => gate.promise) as any, isLive: jest.fn(async () => true) });
      const { bridge } = make(deps);
      const token = bridge.openRun(claims);
      const p = bridge.callTool(token, { name: 'send_email', args: {}, callId: 'a' });
      await flush();
      bridge.revokeConnection('conn-1');
      gate.resolve(ok('sent'));
      await flush();
      void p;
      const records = bridge.takeLedgerByGeneration(bridgeGeneration(bridge));
      expect(records.records[0].revokedDuringCall).toBe(true);
    });
  });
});

function bridgeGeneration(bridge: ToolBridge): string {
  return bridge.generationOf(RUN.runId)!;
}
