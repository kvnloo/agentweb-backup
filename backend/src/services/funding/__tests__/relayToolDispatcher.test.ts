/**
 * ENG-2113 tool relay, backend side: the out-of-band dispatcher against the REAL ToolBridge (only the executor and the worker client are fakes).
 * Each guard here has a mutation check recorded in dev/pending/eng-2113-relay-backend.md.
 */
import { IMAGE_LIMITS } from '../../../loginHost/protocol';
import { LoginHostError, ToolResultLostError } from '../loginHostClient';
import { DELIVERY_FAILED_MESSAGE, NOT_IN_RUN_MESSAGE, REPLAY_NOTE, UNLOADABLE_NOTE, RelayToolDispatcher, SOFT_DEADLINE_MESSAGE, STOPPED_MESSAGE, type RelayCallEvent } from '../relayToolDispatcher';
import { ToolBridge, type BridgeExecuteOutcome, type ToolBridgeDeps } from '../toolBridge';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const IDS = { connectionId: 'conn-1', turnId: 'claude-run-1', epoch: 3 };
const img = (chars: number, mimeType = 'image/png') => ({ mimeType, data: 'A'.repeat(chars) });

interface Opts {
  stopped?: () => boolean;
  softDeadlineAt?: number;
  now?: () => number;
  maxCalls?: number;
  gate?: Record<string, Promise<void>>;
  images?: Record<string, Array<{ mimeType: string; data: string }>>;
  content?: Record<string, string>;
  /** Tools whose result asks for the user's confirmation (latches a halt). */
  confirm?: string[];
  /** Tools whose result is an error. */
  errors?: string[];
  /** Runs inside client.turnToolResult before it answers (a post that is still in flight). */
  onPost?: (input: any) => Promise<void> | void;
  announceWaitMs?: number;
  /** Tools that appear in the run's list after the named tool executes (default: install_skills adds late_tool). */
  appearAfter?: Record<string, Array<Record<string, unknown>>>;
}

function rig(o: Opts = {}) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const extra: Array<Record<string, unknown>> = []; // tools the run gains while executing
  const appear: Record<string, Array<Record<string, unknown>>> = o.appearAfter ?? { install_skills: [{ name: 'late_tool', description: 'Late', inputSchema: { type: 'object', properties: {} } }] };
  const live = { value: true };
  const toolDeps = {
    resolveTools: async () => [{ name: 'search' }, { name: 'save_note' }, { name: 'install_skills' }, { name: 'send_email' }, ...extra],
    isReadOnly: (n: string) => n === 'search',
    isLive: async () => live.value,
    execute: async (_run: unknown, call: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
      executed.push({ name: call.name, args: call.args });
      if (o.gate?.[call.name]) await o.gate[call.name];
      for (const t of appear[call.name] ?? []) extra.push(t);
      return {
        content: o.content?.[call.name] ?? `${call.name} done`,
        isError: o.errors?.includes(call.name) === true,
        requiresConfirmation: o.confirm?.includes(call.name) === true,
        toolsChanged: appear[call.name] !== undefined,
        ...(o.images?.[call.name] ? { images: o.images[call.name] } : {}),
      };
    },
  };
  const bridge = new ToolBridge(toolDeps as unknown as ToolBridgeDeps);
  const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'conn-1', epoch: 3 });
  bridge.beginTurn('u1', 's1');
  const posts: any[] = [];
  const behaviour: { next: Array<unknown | undefined> } = { next: [] };
  const client = {
    turnToolResult: jest.fn(async (input: any) => {
      posts.push(input);
      await o.onPost?.(input);
      const b = behaviour.next.shift();
      if (b) throw b;
      return { ok: true as const };
    }),
  };
  const phases: string[] = [];
  const tripped = { count: 0 };
  const d = new RelayToolDispatcher({
    client,
    ids: IDS,
    runId: 'r1',
    token,
    bridge: {
      callTool: (t, c, r, op) => bridge.callTool(t, c, r, op),
      listTools: (t, r) => bridge.listTools(t, r),
      noteToolUse: (r, c, n, i, m) => bridge.noteToolUse(r, c, n, i, m),
      noteToolResult: (r) => bridge.noteToolResult(r),
      takeLedger: (r) => bridge.takeLedger(r),
    },
    manifest: { open: new Set(['search', 'save_note', 'install_skills', 'send_email']) },
    isStopped: o.stopped ?? (() => false),
    softDeadlineAt: o.softDeadlineAt,
    now: o.now,
    maxCalls: o.maxCalls,
    onLimitTripped: () => void tripped.count++,
    isHalted: () => bridge.isHalted('s1', 'u1'),
    announceWaitMs: o.announceWaitMs ?? 0,
    sleep: async () => undefined,
    onCall: (phase, name) => void phases.push(`${phase}:${name}`),
  });
  const ev = (op: string, name: string, input: unknown = {}, messageId = 'm1'): RelayCallEvent => ({ operationId: op, messageId, name, input });
  return { d, bridge, token, posts, client, behaviour, executed, ev, live, phases, tripped };
}

describe('RelayToolDispatcher', () => {
  let errors: string[];
  beforeEach(() => {
    errors = [];
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(JSON.stringify(a)));
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs a call through ToolBridge.callTool and posts the result under the backend closure identity', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'search', { q: 'x' }));
    await t.d.settle(1_000);
    expect(t.executed).toEqual([{ name: 'search', args: { q: 'x' } }]);
    expect(t.posts).toEqual([{ connectionId: 'conn-1', turnId: 'claude-run-1', epoch: 3, operationId: 'op-1', content: 'search done' }]);
    expect(t.bridge.takeLedger('r1').records.map((r) => [r.toolCallId, r.kind])).toEqual([['op-1', 'executed']]);
  });

  it('IDENTITY: an event that carries connection, turn and epoch fields changes nothing; the posted ids are the closure ids', async () => {
    const t = rig();
    const evil = { ...t.ev('op-1', 'search'), connectionId: 'someone-else', turnId: 'other-turn', epoch: 99, token: 'x' } as unknown as RelayCallEvent;
    t.d.start(evil);
    await t.d.settle(1_000);
    expect(t.posts[0]).toMatchObject({ connectionId: 'conn-1', turnId: 'claude-run-1', epoch: 3 });
    expect(JSON.stringify(t.posts)).not.toContain('someone-else');
  });

  it('a second event with the same operationId never executes twice', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
    t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
    t.d.start({ ...t.ev('op-1', 'save_note', { n: 2 }) });
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });

  it('start() returns at once even when the tool is slow, and settle() is bounded', async () => {
    let release!: () => void;
    const t = rig({ gate: { save_note: new Promise<void>((r) => (release = r)) } });
    const before = Date.now();
    t.d.start(t.ev('op-1', 'save_note'));
    expect(Date.now() - before).toBeLessThan(50);
    expect(t.d.pending).toBe(1);
    const s = await t.d.settle(40);
    expect(s).toEqual({ settled: false, pending: 1 });
    release();
    expect(await t.d.settle(1_000)).toEqual({ settled: true, pending: 0 });
    expect(t.posts).toHaveLength(1);
  });

  it('parallel calls overlap (read-only tools) and every one is answered with its own operation id', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = rig({ gate: { search: gate } });
    t.d.start(t.ev('op-1', 'search', { q: 'a' }));
    t.d.start(t.ev('op-2', 'search', { q: 'b' }));
    await sleep(30);
    expect(t.executed).toHaveLength(2); // both are inside the executor at once
    release();
    await t.d.settle(1_000);
    expect(t.posts.map((p) => p.operationId).sort()).toEqual(['op-1', 'op-2']);
  });

  it('refuses a name outside the manifest and a tool the worker was never sent, without touching the bridge', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'drop_tables'));
    t.d.start(t.ev('op-2', 'late_tool'));
    t.d.start(t.ev('op-3', 'mcp__emma__search'));
    await t.d.settle(1_000);
    expect(t.executed).toEqual([]);
    expect(t.posts.map((p) => [p.operationId, p.isError, p.content])).toEqual([
      ['op-1', true, NOT_IN_RUN_MESSAGE],
      ['op-2', true, NOT_IN_RUN_MESSAGE],
      ['op-3', true, NOT_IN_RUN_MESSAGE],
    ]);
  });

  it('refuses arguments that are not an object', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'search', ['a']));
    t.d.start(t.ev('op-2', 'search', null));
    t.d.start(t.ev('op-3', 'search', 'x'));
    await t.d.settle(1_000);
    expect(t.executed).toEqual([]);
    expect(t.posts.every((p) => p.isError === true)).toBe(true);
  });

  describe('tools that become available mid-turn travel as definitions in the answer', () => {
    it('install_skills: the SAME answer carries the new tool\'s definition, and only then is the tool callable (same-turn use)', async () => {
      const t = rig();
      t.d.start(t.ev('op-1', 'install_skills', { skills: ['x'] }));
      await t.d.settle(1_000);
      expect(t.posts[0]).toMatchObject({ operationId: 'op-1', content: 'install_skills done', tools: [{ name: 'late_tool', description: 'Late', inputSchema: { type: 'object', properties: {} } }] });
      expect(t.posts[0].unlock).toBeUndefined();
      t.d.start(t.ev('op-2', 'late_tool'));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['install_skills', 'late_tool']);
      expect(t.posts[1].tools).toBeUndefined(); // already sent: nothing to add
    });

    it('a call that is not install_skills can make a tool available too (the diff runs after EVERY executed call)', async () => {
      const t = rig({ appearAfter: { save_note: [{ name: 'followup', description: 'F' }] } });
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.posts[0].tools?.map((x: any) => x.name)).toEqual(['followup']);
      expect(t.posts[0].tools[0].inputSchema).toEqual({ type: 'object', properties: {} });
    });

    it('a tool the bridge does not list (its skill is not installed or not entitled) never appears and cannot be called', async () => {
      const t = rig({ appearAfter: {} });
      t.d.start(t.ev('op-1', 'save_note'));
      t.d.start(t.ev('op-2', 'search'));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-3', 'late_tool'));
      await t.d.settle(1_000);
      expect(t.posts.slice(0, 2).every((p) => p.tools === undefined)).toBe(true);
      expect(t.executed.map((e) => e.name).sort()).toEqual(['save_note', 'search']);
      expect(t.posts[2]).toMatchObject({ isError: true, content: NOT_IN_RUN_MESSAGE });
    });

    it('a definition is sent once: the next call does not repeat it', async () => {
      const t = rig();
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note'));
      await t.d.settle(1_000);
      expect(t.posts[0].tools).toHaveLength(1);
      expect(t.posts[1].tools).toBeUndefined();
    });

    it('a retry after the post failed ambiguously re-sends the same definitions (idempotent; they count as sent only once accepted)', async () => {
      const t = rig();
      t.behaviour.next = [new LoginHostError('TIMEOUT', 'request')];
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(t.posts).toHaveLength(2);
      expect(t.posts[1].tools).toEqual(t.posts[0].tools);
    });

    it('definitions the worker refuses (tools_invalid / tools_limit): the answer is re-sent WITHOUT them, they are not marked sent, the model is told, and the tool cannot be called', async () => {
      for (const detail of ['tools_invalid', 'tools_limit']) {
        const t = rig();
        t.behaviour.next = [new LoginHostError('EINVALID', detail)];
        t.d.start(t.ev('op-1', 'install_skills'));
        await t.d.settle(1_000);
        expect(t.posts).toHaveLength(2);
        expect(t.posts[0].tools).toHaveLength(1);
        expect(t.posts[1].tools).toBeUndefined();
        expect(t.posts[1].content).toContain(UNLOADABLE_NOTE);
        expect(t.d.lostCallIds().size).toBe(0);
        t.d.start(t.ev('op-2', 'late_tool'));
        await t.d.settle(1_000);
        expect(t.executed.map((e) => e.name)).toEqual(['install_skills']);
        expect(t.posts[2]).toMatchObject({ isError: true, content: NOT_IN_RUN_MESSAGE });
        t.d.start(t.ev('op-3', 'save_note'));
        await t.d.settle(1_000);
        expect(t.posts[3].tools).toBeUndefined(); // not retried on every later call
      }
    });

    it('a definition that cannot be built (oversized schema, bad name, cut description) is never sent: invisible this turn, the model is told, a fixed code is logged', async () => {
      const t = rig({
        appearAfter: {
          install_skills: [
            { name: 'ok_tool', description: 'fine', inputSchema: { type: 'object' } },
            { name: 'huge', inputSchema: { type: 'object', properties: { p: { description: 'x'.repeat(40_000) } } } },
            { name: 'bad.name' },
            { name: 'long_desc', description: 'é'.repeat(30_000), inputSchema: { type: 'object' } },
          ],
        },
      });
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(t.posts[0].tools.map((x: any) => x.name)).toEqual(['ok_tool']);
      expect(t.posts[0].content).toContain(UNLOADABLE_NOTE);
      const logged = errors.join('\n');
      expect(logged).toContain('new_tool_unloadable count=3');
      expect(logged).not.toMatch(/huge|bad\.name|long_desc/);
      t.d.start(t.ev('op-2', 'huge'));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['install_skills']);
    });

    it('a new tool whose name differs from an already sent one only in case is not sent (the host folds case)', async () => {
      const t = rig({ appearAfter: { install_skills: [{ name: 'Save_Note', description: 'dup' }] } });
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(t.posts[0].tools).toBeUndefined();
      expect(t.posts[0].content).toContain(UNLOADABLE_NOTE);
    });

    it('a body the worker finds too large drops the definitions after the images, and the model is told', async () => {
      const t = rig({ images: { install_skills: [img(8)] } });
      t.behaviour.next = [new LoginHostError('EINVALID', 'result_too_large'), new LoginHostError('EINVALID', 'result_too_large')];
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(t.posts[1].images).toBeUndefined();
      expect(t.posts[1].tools).toHaveLength(1);
      expect(t.posts[2].tools).toBeUndefined();
      expect(t.posts[2].content).toContain(UNLOADABLE_NOTE);
    });
  });

  it('after the soft deadline no tool runs: the model is told to write its answer', async () => {
    let now = 1_000;
    const t = rig({ softDeadlineAt: 2_000, now: () => now });
    t.d.start(t.ev('op-1', 'search'));
    await t.d.settle(1_000);
    now = 2_000;
    t.d.start(t.ev('op-2', 'save_note'));
    await t.d.settle(1_000);
    expect(t.executed.map((e) => e.name)).toEqual(['search']);
    expect(t.posts[1]).toMatchObject({ operationId: 'op-2', isError: true, content: SOFT_DEADLINE_MESSAGE });
  });

  it('after a Stop / revoke / flag-off no tool runs, but the operation is still answered', async () => {
    let stopped = false;
    const t = rig({ stopped: () => stopped });
    t.d.start(t.ev('op-1', 'search'));
    await t.d.settle(1_000);
    stopped = true;
    t.d.start(t.ev('op-2', 'save_note'));
    await t.d.settle(1_000);
    expect(t.executed.map((e) => e.name)).toEqual(['search']);
    expect(t.posts[1]).toMatchObject({ operationId: 'op-2', isError: true, content: STOPPED_MESSAGE });
  });

  it('a closed bridge run (revoke) refuses the next call: nothing executes and the operation is answered', async () => {
    const t = rig();
    t.bridge.revokeConnection('conn-1');
    t.d.start(t.ev('op-1', 'save_note'));
    await t.d.settle(1_000);
    expect(t.executed).toEqual([]);
    expect(t.posts[0]).toMatchObject({ operationId: 'op-1', isError: true, content: STOPPED_MESSAGE });
  });

  it('liveness is checked by the bridge before EVERY execution on the relay path (a connection that went away after the first call)', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
    await t.d.settle(1_000);
    t.live.value = false;
    t.d.start(t.ev('op-2', 'save_note', { n: 2 }));
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(1);
    expect(t.posts[1].isError).toBe(true);
  });

  it('SF2: past the call cap the worker is misbehaving: further calls are neither run nor answered, and the turn is interrupted once', async () => {
    const t = rig({ maxCalls: 2 });
    const started = [1, 2, 3, 4, 5].map((i) => t.d.start(t.ev(`op-${i}`, 'search', { i })));
    await t.d.settle(1_000);
    expect(started).toEqual([true, true, false, false, false]);
    expect(t.executed).toHaveLength(2);
    expect(t.posts).toHaveLength(2);
    expect(t.tripped.count).toBe(1);
  });

  it('SF2: a flood of concurrent operations trips the in-flight limit: at most 16 pending, the rest dropped unanswered, the turn interrupted', async () => {
    let release!: () => void;
    const t = rig({ gate: { search: new Promise<void>((r) => (release = r)) } });
    const started = Array.from({ length: 5000 }, (_, i) => t.d.start(t.ev(`op-${i}`, i % 2 ? 'search' : 'no_such_tool', { i })));
    expect(started.filter(Boolean)).toHaveLength(16);
    expect(t.d.pending).toBe(16);
    expect(t.tripped.count).toBe(1);
    release();
    await t.d.settle(1_000);
    expect(t.posts).toHaveLength(16);
  });

  it('SF2: progress is reported only for names of the manifest', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'search'));
    t.d.start(t.ev('op-2', '<script>evil</script>'));
    await t.d.settle(1_000);
    expect(t.phases).toEqual(['start:search', 'end:search']);
  });

  it('progress callbacks never fire after close()', async () => {
    let release!: () => void;
    const t = rig({ gate: { search: new Promise<void>((r) => (release = r)) } });
    t.d.start(t.ev('op-1', 'search'));
    t.d.close();
    release();
    await t.d.settle(1_000);
    expect(t.phases).toEqual(['start:search']);
  });

  it('SF1: after a halted preview is answered, a later call reusing the SAME message id is refused (the group was closed)', async () => {
    const t = rig({ confirm: ['send_email'] });
    t.d.start(t.ev('op-1', 'send_email', { to: 'a' }, 'msg-1'));
    await t.d.settle(1_000);
    expect(t.bridge.isHalted('s1', 'u1')).toBe(true);
    t.d.start(t.ev('op-2', 'save_note', { n: 1 }, 'msg-1'));
    await t.d.settle(1_000);
    expect(t.executed.map((e) => e.name)).toEqual(['send_email']);
    expect(t.posts[1]).toMatchObject({ operationId: 'op-2', isError: true });
  });

  it('without a halt, identical calls of one ANNOUNCED message still collapse (the group is not closed by every answer)', async () => {
    const t = rig();
    t.d.noteStreamUse('mcp__aw__save_note', { n: 1 });
    t.d.noteStreamUse('mcp__aw__save_note', { n: 1 });
    t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
    await t.d.settle(1_000);
    t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(1);
  });

  it('identical calls of ONE announced message collapse in the bridge; the same call in the next message runs', async () => {
    const t = rig();
    t.d.noteStreamUse('mcp__aw__search', { q: 'x' });
    t.d.noteStreamUse('mcp__aw__search', { q: 'x' });
    t.d.start(t.ev('op-1', 'search', { q: 'x' }));
    await t.d.settle(1_000);
    t.d.start(t.ev('op-2', 'search', { q: 'x' }));
    await t.d.settle(1_000);
    t.d.noteStreamResult();
    t.d.noteStreamUse('mcp__aw__search', { q: 'x' });
    t.d.start(t.ev('op-3', 'search', { q: 'x' }));
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(2);
    expect(t.posts[1].content).toMatch(/collapsed/);
  });

  it('the worker\'s message id is never trusted: unannounced calls never group, whatever id they carry', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'search', { q: 'x' }, 'same-id'));
    await t.d.settle(1_000);
    t.d.start(t.ev('op-2', 'search', { q: 'x' }, 'same-id'));
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(2);
  });

  it('a call that arrives just before its stream line waits for it (bounded) and is grouped with its message', async () => {
    const t = rig({ announceWaitMs: 500 });
    t.d.noteStreamUse('mcp__aw__search', { q: 'x' });
    t.d.start(t.ev('op-1', 'search', { q: 'x' }));
    await t.d.settle(1_000);
    t.d.start(t.ev('op-2', 'search', { q: 'x' }));
    setTimeout(() => t.d.noteStreamUse('mcp__aw__search', { q: 'x' }), 30); // the announcement lands after the call
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(1); // collapsed: it found its message
  });

  describe('B1: batched confirmations (parity with AgentWeb: one deck for every preview of one model message)', () => {
    it('five previews announced in one message: all five run and all five halts are recorded', async () => {
      const t = rig({ confirm: ['send_email'] });
      for (let i = 1; i <= 5; i++) t.d.noteStreamUse('mcp__aw__send_email', { to: `p${i}` });
      for (let i = 1; i <= 5; i++) {
        t.d.start(t.ev(`op-${i}`, 'send_email', { to: `p${i}` }));
        await t.d.settle(1_000);
      }
      expect(t.executed.map((e) => e.args.to)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
      expect(t.bridge.takeHalts('u1', 's1')).toHaveLength(5);
    });

    it('a read-only call announced in the same message as the halted preview still runs', async () => {
      const t = rig({ confirm: ['send_email'] });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' });
      t.d.noteStreamUse('mcp__aw__search', { q: 'status' });
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'search', { q: 'status' }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email', 'search']);
    });

    it('a call announced AFTER the halted answer went back is refused, even with no tool-result between (the cutoff)', async () => {
      const t = rig({ confirm: ['send_email'] });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' });
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      t.d.noteStreamUse('mcp__aw__save_note', { n: 1 }); // same batch (no tool-result yet), but after the answer
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email']);
    });

    it('a call that matches an announcement of an EARLIER batch is refused after a halt (batch check, even though it was announced before the answer)', async () => {
      const t = rig({ confirm: ['send_email'] });
      t.d.noteStreamUse('mcp__aw__save_note', { n: 1 }); // batch 1, never run yet
      t.d.noteStreamResult();
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' }); // batch 2
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      const closed = jest.spyOn(t.bridge, 'noteToolResult');
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email']);
      expect(closed).toHaveBeenCalled(); // the halted group was closed before it was refused
    });

    it('a call announced in an EARLIER message is not a sibling of the halt', async () => {
      const t = rig({ confirm: ['send_email'] });
      t.d.noteStreamUse('mcp__aw__save_note', { n: 1 });
      t.d.noteStreamResult();
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' });
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email']);
    });

    it('an announcement for a name outside the manifest is ignored', async () => {
      const t = rig({ confirm: ['send_email'] });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' });
      t.d.noteStreamUse('mcp__aw__drop_tables', {});
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'drop_tables', {}));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email']);
    });
  });

  describe('images', () => {
    it('forwards an executor image in turn.toolResult.images', async () => {
      const t = rig({ images: { search: [img(8)] } });
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts[0].images).toEqual([{ mimeType: 'image/png', data: 'AAAAAAAA' }]);
      expect(t.posts[0].content).toBe('search done');
    });

    it('keeps at most 4 images and 6M characters in all, drops the rest and says so in the text', async () => {
      const t = rig({ images: { search: [img(2_500_000), img(2_500_000), img(2_500_000), img(8), img(8), img(8)] } });
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      const sent = t.posts[0].images as Array<{ data: string }>;
      expect(sent.length).toBeLessThanOrEqual(IMAGE_LIMITS.maxImages);
      expect(sent.reduce((n, i) => n + i.data.length, 0)).toBeLessThanOrEqual(IMAGE_LIMITS.maxBase64Total);
      expect(sent.every((i) => i.data.length <= IMAGE_LIMITS.maxBase64Each)).toBe(true);
      expect(t.posts[0].content).toMatch(/could not be attached/);
    });

    it('keeps at most 4 images even when they are small', async () => {
      const t = rig({ images: { search: Array.from({ length: 6 }, () => img(8)) } });
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts[0].images).toHaveLength(IMAGE_LIMITS.maxImages);
      expect(t.posts[0].content).toMatch(/2 images could not be attached/);
    });

    it('keeps the total under 6M characters even when the body would still fit', async () => {
      const t = rig({ images: { search: [img(2_200_000), img(2_200_000), img(2_200_000)] } });
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts[0].images).toHaveLength(2);
      expect(t.posts[0].content).toMatch(/1 image could not be attached/);
    });

    it('drops an unsupported type or a malformed payload', async () => {
      const t = rig({ images: { search: [img(8, 'image/svg+xml'), { mimeType: 'image/png', data: 'not base64!' }, img(8, 'image/webp')] } });
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts[0].images).toEqual([{ mimeType: 'image/webp', data: 'AAAAAAAA' }]);
      expect(t.posts[0].content).toMatch(/2 images could not be attached/);
    });

    it('an image the worker refuses as too large is dropped and the text is still delivered', async () => {
      const t = rig({ images: { search: [img(8)] } });
      t.behaviour.next = [new LoginHostError('EINVALID', 'result_too_large')];
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts).toHaveLength(2);
      expect(t.posts[1].images).toBeUndefined();
      expect(t.posts[1].content).toMatch(/search done/);
      expect(t.d.lostCallIds().size).toBe(0);
    });
  });

  describe('result lost', () => {
    it.each(['turn_aborted', 'operation_unknown', 'result_lost'] as const)('%s: the call is remembered as lost, not retried, and not treated as a wipe', async (reason) => {
      const t = rig();
      t.behaviour.next = [new ToolResultLostError(reason)];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect([...t.d.lostCallIds()]).toEqual(['op-1']);
      expect(t.posts).toHaveLength(1); // no retry of the post
      expect(t.executed).toHaveLength(1); // and no second execution
      expect(errors.join('\n')).toContain(`result_lost_${reason}`);
    });

    it('an identical retry of a call whose result was lost gets the original result back and does NOT run again', async () => {
      const t = rig();
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }, 'msg-later'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1);
      expect(t.posts[1].operationId).toBe('op-2');
      expect(t.posts[1].isError).toBeUndefined();
      expect(t.posts[1].content).toBe(`${REPLAY_NOTE}save_note done`);
    });

    it('a replay keeps the original isError', async () => {
      const t = rig({ errors: ['save_note'] });
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }, 'msg-later'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1);
      expect(t.posts[1]).toMatchObject({ isError: true });
      expect(t.posts[1].content).toContain(REPLAY_NOTE);
    });

    it('a replay is not served once the run was revoked', async () => {
      const t = rig();
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.bridge.revokeConnection('conn-1');
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }, 'msg-later'));
      await t.d.settle(1_000);
      expect(t.posts[1]).toMatchObject({ isError: true, content: STOPPED_MESSAGE });
    });

    it('at most 8 lost results are kept for replay; a 9th identical retry runs again', async () => {
      const t = rig();
      t.behaviour.next = Array.from({ length: 9 }, () => new ToolResultLostError('result_lost'));
      for (let i = 1; i <= 9; i++) {
        t.d.start(t.ev(`op-${i}`, 'search', { i }, `m${i}`));
        await t.d.settle(1_000);
      }
      t.d.start(t.ev('op-a', 'search', { i: 1 }, 'mx'));
      t.d.start(t.ev('op-b', 'search', { i: 9 }, 'my'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(10); // i:1 replayed, i:9 ran again
    });

    it('a DIFFERENT call after a lost one runs normally', async () => {
      const t = rig();
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 2 }));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(2);
    });

    it('a REFUSED call whose answer was lost is not replayed (it executed nothing)', async () => {
      const t = rig();
      t.live.value = false;
      t.behaviour.next = [new ToolResultLostError('turn_aborted')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.live.value = true;
      t.bridge.closeRun('r1'); // (a fresh run would be opened by the caller; here only the replay map matters)
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.posts[1].content).not.toContain(REPLAY_NOTE);
    });
  });

  describe('delivery', () => {
    it('retries an ambiguous failure and then succeeds', async () => {
      const t = rig();
      t.behaviour.next = [new LoginHostError('UNREACHABLE', 'ECONNRESET'), new LoginHostError('TIMEOUT', 'request')];
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts).toHaveLength(3);
      expect(t.d.lostCallIds().size).toBe(0);
    });

    it('an answer the worker will never accept is replaced by a plain one, so the operation is never left hanging', async () => {
      const t = rig();
      t.behaviour.next = [new LoginHostError('EINVALID', 'content:too_big')];
      t.d.start(t.ev('op-1', 'save_note'));
      await t.d.settle(1_000);
      expect(t.posts).toHaveLength(2);
      expect(t.posts[1]).toMatchObject({ operationId: 'op-1', isError: true, content: DELIVERY_FAILED_MESSAGE });
      expect([...t.d.lostCallIds()]).toEqual(['op-1']);
    });

    it('S2: a call to a newly available tool that arrives while the install answer is still being posted is accepted', async () => {
      let t!: ReturnType<typeof rig>;
      let lateStarted = false;
      t = rig({
        onPost: async (input) => {
          if (input.operationId === 'op-1') {
            t.d.start(t.ev('op-2', 'late_tool')); // the worker already handed the definition to the shim and the CLI called the tool
            lateStarted = true;
            await sleep(20);
          }
        },
      });
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(lateStarted).toBe(true);
      expect(t.executed.map((e) => e.name)).toEqual(['install_skills', 'late_tool']);
    });

    it('limits are in BYTES: a multi-byte text is cut so the body never exceeds the worker cap', async () => {
      const t = rig({ content: { search: 'é'.repeat(900_000) } }); // 900k characters, 1.8 MB
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(Buffer.byteLength(t.posts[0].content)).toBeLessThan(1_000_200);
      expect(t.posts[0].content).not.toContain('\ufffd');
      const u = rig({ content: { search: '\u0001'.repeat(1_000_000) } }, ); // escapes to 6 bytes each in JSON
      u.d.start(u.ev('op-1', 'search'));
      await u.d.settle(1_000);
      expect(Buffer.byteLength(JSON.stringify(u.posts[0]))).toBeLessThanOrEqual(7.5 * 1024 * 1024);
    });

    it('a very long result is truncated with a note; one the worker still finds too large is halved until it fits', async () => {
      const t = rig({ content: { search: 'x'.repeat(1_500_000) } });
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts[0].content.length).toBeLessThan(1_000_200);
      expect(t.posts[0].content).toMatch(/truncated/);
      const u = rig({ content: { search: 'y'.repeat(100_000) } });
      u.behaviour.next = [new LoginHostError('EINVALID', 'result_too_large')];
      u.d.start(u.ev('op-1', 'search'));
      await u.d.settle(1_000);
      expect(u.posts).toHaveLength(2);
      expect(u.posts[1].content.length).toBeLessThan(u.posts[0].content.length);
    });
  });

  it('logs fixed codes only: never an argument, a result or an image', async () => {
    const t = rig({ images: { search: [img(8)] } });
    t.behaviour.next = [new ToolResultLostError('result_lost'), new LoginHostError('EINVALID', 'x')];
    t.d.start(t.ev('op-1', 'save_note', { secret: 'SECRET-ARG-VALUE' }));
    t.d.start(t.ev('op-2', 'search', { secret: 'SECRET-ARG-VALUE-2' }));
    t.d.start(t.ev('op-1', 'save_note', { secret: 'SECRET-ARG-VALUE' }));
    await t.d.settle(1_000);
    const all = errors.join('\n');
    expect(all).not.toMatch(/SECRET-ARG|done|AAAAAAAA/);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('RelayToolDispatcher: an unforeseen failure still answers the operation', () => {
  it('input that cannot be serialized is refused and answered', async () => {
    const posts: any[] = [];
    const d = new RelayToolDispatcher({
      client: { turnToolResult: async (i: any) => (posts.push(i), { ok: true as const }) },
      ids: IDS,
      runId: 'r1',
      token: 't',
      bridge: { callTool: async () => ({ content: 'x', isError: false }), listTools: async () => [], noteToolUse: () => undefined, noteToolResult: () => undefined, takeLedger: () => ({ records: [], truncated: 0 }) },
      manifest: { open: new Set(['search']) },
      isStopped: () => false,
      isHalted: () => false,
    });
    let deep: unknown = {};
    for (let i = 0; i < 20000; i++) deep = { a: deep };
    jest.spyOn(console, 'error').mockImplementation(() => {});
    d.start({ operationId: 'op-1', messageId: 'm', name: 'search', input: deep });
    await d.settle(1_000);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ operationId: 'op-1', isError: true });
    jest.restoreAllMocks();
  });
});
