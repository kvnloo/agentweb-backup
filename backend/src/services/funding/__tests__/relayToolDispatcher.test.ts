/**
 * ENG-2113 tool relay, backend side: the out-of-band dispatcher against the REAL ToolBridge (only the executor and the worker client are fakes).
 * Each guard here has a mutation check recorded in dev/pending/eng-2113-relay-backend.md.
 */
import { IMAGE_LIMITS } from '../../../loginHost/protocol';
import { LoginHostError, ToolResultLostError } from '../loginHostClient';
import { ALREADY_RAN_MESSAGE, RAN_NOT_PREPARED_MESSAGE, RESULT_LOST_NOTE, ARGS_TOO_LARGE_MESSAGE, BAD_ARGS_MESSAGE, DELIVERY_FAILED_MESSAGE, NOT_IN_RUN_MESSAGE, REPLAY_NOTE, UNLOADABLE_NOTE, RelayToolDispatcher, SOFT_DEADLINE_MESSAGE, STOPPED_MESSAGE, type RelayCallEvent } from '../relayToolDispatcher';
import { annotateLostResults } from '../claudeCodeBackend';
import { ToolBridge, type BridgeExecuteOutcome, type ToolBridgeDeps } from '../toolBridge';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const IDS = { connectionId: 'conn-1', turnId: 'claude-run-1', epoch: 3 };
const big = (kb: number) => ({ s: 'x'.repeat(kb * 1024) });
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
  /** Makes the bridge wait on this before a halt is recorded durably (the halting call is answered only after it). */
  persistGate?: Promise<void>;
  /** Makes the dispatcher's own bookkeeping throw AFTER the bridge returned (an unforeseen failure). */
  throwAfterRun?: boolean;
  /** Runs after every bridge.listTools the dispatcher makes (with the call count). */
  onList?: (n: number) => void;
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
    persistHalt: async () => { await o.persistGate; },
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
  let listCalls = 0;
  const tripped = { count: 0 };
  const d = new RelayToolDispatcher({
    client,
    ids: IDS,
    runId: 'r1',
    token,
    bridge: {
      callTool: (t, c, r, op) => bridge.callTool(t, c, r, op),
      listTools: async (t, r) => {
        const v = await bridge.listTools(t, r);
        o.onList?.(++listCalls);
        return v;
      },
      noteToolUse: (r, c, n, i, m) => bridge.noteToolUse(r, c, n, i, m),
      takeLedger: (r) => bridge.takeLedger(r),
    },
    manifest: { open: new Set(['search', 'save_note', 'install_skills', 'send_email']) },
    isStopped: o.stopped ?? (() => false),
    softDeadlineAt: o.softDeadlineAt,
    now: o.now,
    maxCalls: o.maxCalls,
    onLimitTripped: () => void tripped.count++,
    isHalted: () => bridge.isHalted('s1', 'u1'),
    isHaltingCall: (op) => {
      if (o.throwAfterRun) throw new Error('boom after the tool ran');
      return bridge.takeHalts('u1', 's1').some((h) => h.callId === op);
    },
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
      for (const detail of ['tools_invalid', 'tools_limit', 'tools:name']) {
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

    it('our own client-side schema check failing on `tools` (the same rules) is handled like a worker refusal; a failure elsewhere in the body is not', async () => {
      const zodOnTools = Object.assign(new Error('zod'), { name: 'ZodError', issues: [{ path: ['tools'] }] });
      const t = rig();
      t.behaviour.next = [zodOnTools];
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(t.posts).toHaveLength(2);
      expect(t.posts[1].tools).toBeUndefined();
      expect(t.posts[1].content).toContain(UNLOADABLE_NOTE);
      const zodElsewhere = Object.assign(new Error('zod'), { name: 'ZodError', issues: [{ path: ['content'] }] });
      const u = rig();
      u.behaviour.next = [zodElsewhere];
      u.d.start(u.ev('op-1', 'install_skills'));
      await u.d.settle(1_000);
      expect(u.posts[1]).toMatchObject({ content: DELIVERY_FAILED_MESSAGE });
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
      expect(logged).toContain('new_tool_unloadable');
      expect(logged).toContain('"count":3');
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

    it('an answer that can never be delivered is replaced by a plain one WITHOUT the definitions: the tool stays unknown to the worker and is refused', async () => {
      const t = rig();
      t.behaviour.next = [new LoginHostError('EINVALID', 'content:too_big')];
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(t.posts[1]).toMatchObject({ content: DELIVERY_FAILED_MESSAGE });
      expect(t.posts[1].tools).toBeUndefined();
      t.d.start(t.ev('op-2', 'late_tool'));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['install_skills']);
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

  describe('G19: the first halt fixes the sibling window', () => {
    it('a second halting sibling does not widen the window: a call announced after the FIRST halted answer stays refused', async () => {
      const t = rig({ confirm: ['send_email'] });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'b' });
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      t.d.noteStreamUse('mcp__aw__save_note', { n: 1 }); // same message, announced after the first answer went back
      t.d.start(t.ev('op-2', 'send_email', { to: 'b' })); // a sibling announced before it: runs and halts too
      await t.d.settle(1_000);
      t.d.start(t.ev('op-3', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email', 'send_email']);
    });
  });

  describe('the host\'s truncation marker for stream inputs ({"_truncated":"depth"|"size"})', () => {
    const marker = (kind: 'depth' | 'size' = 'depth') => ({ _truncated: kind });

    it('a real call whose arguments look exactly like the marker is never matched to a marker announcement (it does not collapse into it)', async () => {
      const t = rig();
      t.d.noteStreamUse('mcp__aw__save_note', marker());
      t.d.noteStreamUse('mcp__aw__save_note', marker());
      t.d.start(t.ev('op-1', 'save_note', marker()));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', marker()));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(2); // matched by content they would have been one message and collapsed
    });

    it('a marker-announced call does not wait for an announcement that will never match', async () => {
      const t = rig({ announceWaitMs: 5_000 });
      t.d.noteStreamUse('mcp__aw__save_note', marker('size'));
      const t0 = Date.now();
      t.d.start(t.ev('op-1', 'save_note', { note: 'x'.repeat(100) }));
      await t.d.settle(4_000);
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(t.executed).toHaveLength(1);
    });

    it('a halted batch with a truncated member stays usable: real siblings are admitted, the truncated one falls back to its own group and is refused', async () => {
      const t = rig({ confirm: ['send_email'] });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' });
      t.d.noteStreamUse('mcp__aw__send_email', marker('depth')); // the 2nd preview had a huge or absurdly nested input
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'c' });
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'send_email', { to: 'b-huge' })); // its stream input was truncated
      await t.d.settle(1_000);
      t.d.start(t.ev('op-3', 'send_email', { to: 'c' }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.args.to)).toEqual(['a', 'c']);
      expect(t.posts[1]).toMatchObject({ operationId: 'op-2', isError: true });
      expect(t.bridge.takeHalts('u1', 's1')).toHaveLength(2);
    });

    it('a marker is consumed once: two calls, one marker', async () => {
      const t = rig({ confirm: ['send_email'], announceWaitMs: 0 });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' });
      t.d.noteStreamUse('mcp__aw__send_email', marker());
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'send_email', { to: 'big-1' }));
      t.d.start(t.ev('op-3', 'send_email', { to: 'big-2' }));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1);
    });

    it('a marker is consumed ONCE: the second unmatched call waits for its own announcement like any other', async () => {
      const t = rig({ confirm: ['send_email'], announceWaitMs: 400 });
      t.d.noteStreamUse('mcp__aw__send_email', marker());
      t.d.start(t.ev('op-1', 'send_email', { to: 'big-1' })); // takes the marker, no wait
      await t.d.settle(1_000);
      const t0 = Date.now();
      t.d.start(t.ev('op-2', 'send_email', { to: 'big-2' })); // no marker left: waits out the announcement window
      await t.d.settle(2_000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    });

    it('a stand-in with another value is not a marker', async () => {
      const t = rig();
      t.d.noteStreamUse('mcp__aw__search', { _truncated: 'other' });
      t.d.noteStreamUse('mcp__aw__search', { _truncated: 'other' });
      t.d.start(t.ev('op-1', 'search', { _truncated: 'other' }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'search', { _truncated: 'other' }));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1); // matched by content, one message, collapsed
    });

    it('lookalikes are not markers: extra keys, other values, arrays and non-objects are recorded by content as usual', async () => {
      const t = rig();
      const lookalikes: unknown[] = [{ _truncated: 'depth', extra: 1 }, { _truncated: 'other' }, { _truncated: 1 }, ['_truncated'], null, 'depth'];
      for (const l of lookalikes) t.d.noteStreamUse('mcp__aw__search', l);
      t.d.noteStreamUse('mcp__aw__search', { _truncated: 'depth', extra: 1 }); // announced twice: one message, two identical calls
      expect(() => t.d.noteStreamUse('mcp__aw__search', undefined)).not.toThrow();
      t.d.start(t.ev('op-1', 'search', { _truncated: 'depth', extra: 1 }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'search', { _truncated: 'depth', extra: 1 }));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1); // matched by content to the same message and collapsed
    });

    it('an unserializable or absurdly deep announcement never throws', () => {
      const t = rig();
      let deep: unknown = {};
      for (let i = 0; i < 20000; i++) deep = { a: deep };
      expect(() => t.d.noteStreamUse('mcp__aw__search', deep)).not.toThrow();
      const cyc: Record<string, unknown> = {};
      cyc.self = cyc;
      expect(() => t.d.noteStreamUse('mcp__aw__search', cyc)).not.toThrow();
    });
  });

  describe('work bounds on worker-controlled data (DoS)', () => {
    it('5,000 stream tool-use events with 700 KB inputs cost almost nothing (they used to be hashed one by one)', () => {
      const t = rig();
      const input = { items: Array.from({ length: 700 }, (_, i) => ({ i, s: 'y'.repeat(1000) })) };
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 5000; i++) t.d.noteStreamUse('mcp__aw__save_note', input);
      expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(1500); // the old cost was minutes (95 ms each); this is bounded by the 1,024-announcement cap
    });

    it('an announcement with an input over 64 KB is recorded by name only: it never matches a call by content (like the host marker)', async () => {
      const t = rig();
      t.d.noteStreamUse('mcp__aw__save_note', big(70));
      t.d.noteStreamUse('mcp__aw__save_note', big(70));
      t.d.start(t.ev('op-1', 'save_note', big(70)));
      await t.d.settle(2_000);
      t.d.start(t.ev('op-2', 'save_note', big(70)));
      await t.d.settle(2_000);
      expect(t.executed).toHaveLength(2); // matched by content they would be one message and collapse
    });

    it('at most 1,024 announcements are recorded per turn; later ones are ignored (the call then runs unannounced)', async () => {
      const t = rig();
      for (let i = 0; i < 1024; i++) t.d.noteStreamUse('mcp__aw__search', { i });
      t.d.noteStreamUse('mcp__aw__save_note', { n: 1 });
      t.d.noteStreamUse('mcp__aw__save_note', { n: 1 });
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(2);
    });

    it('the hashed bytes of a turn add up to at most 8 MB; after that stream events are ignored', async () => {
      const t = rig();
      for (let i = 0; i < 160; i++) t.d.noteStreamUse('mcp__aw__search', { i, s: 'z'.repeat(60 * 1024) }); // 160 x 60 KB = 9.6 MB
      const input = { n: 1, s: 'q'.repeat(30 * 1024) }; // does not fit in what is left of the budget
      t.d.noteStreamUse('mcp__aw__save_note', input);
      t.d.noteStreamUse('mcp__aw__save_note', input);
      t.d.start(t.ev('op-1', 'save_note', input));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', input));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(2);
    });

    it('a tool call whose arguments exceed 256 KiB is refused unread, fast, and nothing runs', async () => {
      const t = rig();
      const t0 = Date.now();
      t.d.start(t.ev('op-1', 'save_note', big(700)));
      await t.d.settle(2_000);
      expect(Date.now() - t0).toBeLessThan(200);
      expect(t.executed).toEqual([]);
      expect(t.posts[0]).toMatchObject({ isError: true, content: ARGS_TOO_LARGE_MESSAGE });
    });

    it('numeric arrays are estimated by their digits (host estimator): 100,000 two-digit numbers (300 KB of JSON) are refused fast, 10,000 run', async () => {
      const t = rig();
      const t0 = Date.now();
      t.d.start(t.ev('op-1', 'save_note', { ids: Array.from({ length: 100_000 }, (_, i) => 10 + (i % 90)) }));
      await t.d.settle(2_000);
      expect(Date.now() - t0).toBeLessThan(200);
      expect(t.executed).toEqual([]);
      expect(t.posts[0]).toMatchObject({ content: ARGS_TOO_LARGE_MESSAGE });
      t.d.start(t.ev('op-2', 'save_note', { ids: Array.from({ length: 10_000 }, (_, i) => 10 + (i % 90)) }));
      await t.d.settle(2_000);
      expect(t.executed).toHaveLength(1);
    });

    it('a numeric stream input over the announce threshold (64 KB estimated) is recorded by name only; one under it is matched by content', async () => {
      const t = rig();
      const ids = Array.from({ length: 30_000 }, (_, i) => 10 + (i % 90)); // about 90 KB of JSON: over the announce threshold (64 KB), under the call cap (256 KiB)
      t.d.noteStreamUse('mcp__aw__save_note', { ids });
      t.d.noteStreamUse('mcp__aw__save_note', { ids });
      t.d.start(t.ev('op-1', 'save_note', { ids }));
      await t.d.settle(2_000);
      t.d.start(t.ev('op-2', 'save_note', { ids }));
      await t.d.settle(2_000);
      expect(t.executed).toHaveLength(2); // both ran: never matched by content, so never collapsed
      const small = Array.from({ length: 10_000 }, (_, i) => 10 + (i % 90)); // about 30 KB: under the threshold, so matched by content as usual
      t.d.noteStreamUse('mcp__aw__search', { small });
      t.d.noteStreamUse('mcp__aw__search', { small });
      t.d.start(t.ev('op-3', 'search', { small }));
      await t.d.settle(2_000);
      t.d.start(t.ev('op-4', 'search', { small }));
      await t.d.settle(2_000);
      expect(t.executed).toHaveLength(3); // the two identical small ones collapsed into one execution
    });

    it('arguments just under the cap run', async () => {
      const t = rig();
      t.d.start(t.ev('op-1', 'save_note', big(200)));
      await t.d.settle(2_000);
      expect(t.executed).toHaveLength(1);
    });

    it('the larger inputs of a turn add up to 2 MiB; after that only small ones (16 KiB) run', async () => {
      const t = rig();
      for (let i = 0; i < 14; i++) {
        t.d.start(t.ev(`op-${i}`, 'save_note', { i, ...big(200) }));
        await t.d.settle(2_000);
      }
      expect(t.executed.length).toBeGreaterThanOrEqual(9);
      expect(t.executed.length).toBeLessThanOrEqual(11); // about 2 MiB / 200 KiB
      const before = t.executed.length;
      t.d.start(t.ev('op-late-big', 'save_note', { late: 1, ...big(100) }));
      t.d.start(t.ev('op-late-small', 'save_note', { late: 2, s: 'small' }));
      await t.d.settle(2_000);
      expect(t.executed.length).toBe(before + 1);
      expect(t.posts.find((p) => p.operationId === 'op-late-big')).toMatchObject({ content: ARGS_TOO_LARGE_MESSAGE });
    });

    it('inputs of 16 KiB or less are exempt from the budget even when the budget is spent', async () => {
      const t = rig();
      for (let i = 0; i < 8; i++) {
        t.d.start(t.ev(`op-b${i}`, 'save_note', { i, ...big(250) }));
        await t.d.settle(2_000);
      }
      t.d.start(t.ev('op-mid', 'save_note', { mid: 1, ...big(40) })); // leaves under 16 KiB of budget
      await t.d.settle(2_000);
      const before = t.executed.length;
      t.d.start(t.ev('op-small', 'save_note', { small: 1, ...big(10) }));
      await t.d.settle(2_000);
      expect(t.executed.length).toBe(before + 1);
    });

    it('100,000 duplicate operation events log a handful of lines, not 100,000 (and the count is reported)', async () => {
      const t = rig();
      t.d.start(t.ev('op-1', 'search', { q: 'x' }));
      errors.length = 0;
      for (let i = 0; i < 100_000; i++) t.d.start(t.ev('op-1', 'search', { q: 'x' }));
      await t.d.settle(1_000);
      expect(errors.filter((e) => e.includes('duplicate_operation')).length).toBeLessThanOrEqual(6);
      expect(t.executed).toHaveLength(1);
    });
  });

  describe('a write is never run twice, however many answers were lost', () => {
    it('after the replay table is full (8), the 9th and 10th lost writes are refused as "already ran" when retried, never executed again', async () => {
      const t = rig();
      t.behaviour.next = Array.from({ length: 10 }, () => new ToolResultLostError('result_lost'));
      for (let i = 1; i <= 10; i++) {
        t.d.start(t.ev(`op-${i}`, 'save_note', { i }, `m${i}`));
        await t.d.settle(1_000);
      }
      expect(t.executed).toHaveLength(10);
      t.d.start(t.ev('retry-1', 'save_note', { i: 1 }, 'r1')); // in the table: replayed with its result
      t.d.start(t.ev('retry-9', 'save_note', { i: 9 }, 'r9')); // not in the table
      t.d.start(t.ev('retry-10', 'save_note', { i: 10 }, 'r10'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(10);
      expect(t.posts.find((p) => p.operationId === 'retry-1')?.content).toContain(REPLAY_NOTE);
      for (const op of ['retry-9', 'retry-10']) expect(t.posts.find((p) => p.operationId === op)).toMatchObject({ isError: true, content: ALREADY_RAN_MESSAGE });
    });

    it('the memory kept per lost write is a digest: the key does not contain the input', async () => {
      const t = rig();
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'save_note', big(100)));
      await t.d.settle(2_000);
      const keys = [...((t.d as any).lostWrites as Set<string>)];
      expect(keys).toHaveLength(1);
      expect(keys[0].length).toBeLessThan(100);
    });
  });

  describe('an unforeseen failure AFTER the tool ran is never reported as "not run"', () => {
    it('answers that the tool ran, marks the call lost (persisted note), and never runs an identical retry again', async () => {
      const t = rig({ throwAfterRun: true });
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1);
      expect(t.posts[0]).toMatchObject({ operationId: 'op-1', isError: true, content: RAN_NOT_PREPARED_MESSAGE });
      expect(t.posts[0].content).not.toBe(STOPPED_MESSAGE);
      expect(t.d.lostCallIds().has('op-1')).toBe(true);
      expect(t.d.deliveredCallIds().has('op-1')).toBe(false); // so the persisted tool result carries the lost note
      expect(errors.join('\n')).toContain('decide_failed_after_run');
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }, 'later'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1); // never run again
      expect(t.posts[1].content).toContain(REPLAY_NOTE); // answered from what the first run returned
    });

    it('the persisted tool result of that call carries the result-lost note', async () => {
      const t = rig({ throwAfterRun: true });
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      const delivered = t.d.deliveredCallIds();
      const ledger = annotateLostResults(t.bridge.takeLedger('r1').records, (id) => !delivered.has(id));
      expect(ledger[0].toolMessageContent).toContain(RESULT_LOST_NOTE);
    });

    it('a retry is refused (not run) once the replay table is full', async () => {
      const t = rig({ throwAfterRun: true });
      for (let i = 1; i <= 10; i++) {
        t.d.start(t.ev(`op-${i}`, 'save_note', { i }, `m${i}`));
        await t.d.settle(1_000);
      }
      t.d.start(t.ev('retry-10', 'save_note', { i: 10 }, 'r'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(10);
      expect(t.posts.find((p) => p.operationId === 'retry-10')).toMatchObject({ isError: true, content: ALREADY_RAN_MESSAGE });
    });

    it('a throw BEFORE the bridge call still says the call was not run, and does not mark it lost', async () => {
      const t = rig({ stopped: () => { throw new Error('boom before the bridge'); } });
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed).toEqual([]);
      expect(t.posts[0]).toMatchObject({ isError: true, content: STOPPED_MESSAGE });
      expect(t.d.lostCallIds().size).toBe(0);
    });
  });

  describe('the halt is taken from the call that halted', () => {
    it('a read-only call that returns first after the latch does not set the sibling window', async () => {
      let release!: () => void;
      const t = rig({ confirm: ['send_email'], persistGate: new Promise<void>((r) => (release = r)) });
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'a' }); // batch 1
      t.d.noteStreamUse('mcp__aw__send_email', { to: 'b' }); // batch 1: a sibling of the halted preview
      t.d.noteStreamResult();
      t.d.noteStreamUse('mcp__aw__search', { q: 'later' }); // batch 2
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' })); // halts; its answer waits for the durable halt record
      await sleep(30);
      t.d.start(t.ev('op-2', 'search', { q: 'later' })); // returns first, refused by the latch
      await sleep(30);
      expect(t.posts.map((p) => p.operationId)).toEqual(['op-2']);
      release();
      await t.d.settle(1_000);
      t.d.start(t.ev('op-3', 'send_email', { to: 'b' }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.args.to ?? e.name)).toEqual(['a', 'b']); // the sibling of the HALTED call is admitted
    });

    it('a halt from a call with no announcement fixes batch -1: no later announced call is admitted as a sibling', async () => {
      const t = rig({ confirm: ['send_email'], announceWaitMs: 0 });
      t.d.noteStreamUse('mcp__aw__save_note', { n: 1 });
      t.d.start(t.ev('op-1', 'send_email', { to: 'a' })); // unannounced: halts
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email']);
    });
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
      const announced = jest.spyOn(t.bridge, 'noteToolUse');
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['send_email']);
      expect(announced).not.toHaveBeenCalled(); // not announced to the bridge at all: it refuses it, and the halted group is left untouched
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

    it('S1: a lost READ-ONLY answer is never replayed: an identical retry runs again and sees current data', async () => {
      const t = rig();
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'search', { q: 'x' }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'search', { q: 'x' }, 'later-1'));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-3', 'search', { q: 'x' }, 'later-2'));
      await t.d.settle(1_000);
      expect(t.executed.map((e) => e.name)).toEqual(['search', 'search', 'search']);
      expect(t.posts.some((p) => p.content.includes(REPLAY_NOTE))).toBe(false);
    });

    it('S1: a lost WRITE answer is still never run twice (the guarantee stays)', async () => {
      const t = rig();
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }, 'later-1'));
      t.d.start(t.ev('op-3', 'save_note', { n: 1 }, 'later-2'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1);
    });

    it('a tool whose kind is unknown (the listing failed) is treated as a write: replayed, never re-run', async () => {
      let fail = false;
      const t = rig({ onList: () => { if (fail) throw new Error('list failed'); } });
      fail = true;
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'search', { q: 'x' }));
      await t.d.settle(1_000);
      fail = false;
      t.d.start(t.ev('op-2', 'search', { q: 'x' }, 'later'));
      await t.d.settle(1_000);
      expect(t.executed).toHaveLength(1);
    });

    it('S3: only a call that really ran is replayed: a bridge refusal whose answer was lost is never cached, and an honest retry runs', async () => {
      const calls: string[] = [];
      let first = true;
      const posts: any[] = [];
      let lose = true;
      const d = new RelayToolDispatcher({
        client: { turnToolResult: async (i: any) => { posts.push(i); if (lose) { lose = false; throw new ToolResultLostError('turn_aborted'); } return { ok: true as const }; } },
        ids: IDS,
        runId: 'r1',
        token: 't',
        bridge: {
          callTool: async (_t, c) => { calls.push(c.name); if (first) { first = false; return { content: 'Too busy, try again.', isError: true }; } return { content: 'saved', isError: false }; },
          listTools: async () => [{ name: 'save_note', readOnly: false }],
          noteToolUse: () => undefined,
          takeLedger: () => ({ records: [{ toolCallId: 'op-1', kind: 'refused' }], truncated: 0 }), // what the real bridge records for a refusal
        },
        manifest: { open: new Set(['save_note']) },
        isStopped: () => false,
        isHalted: () => false,
        isHaltingCall: () => false,
        announceWaitMs: 0,
      });
      d.start({ operationId: 'op-1', messageId: 'm', name: 'save_note', input: { n: 1 } });
      await d.settle(1_000);
      d.start({ operationId: 'op-2', messageId: 'm2', name: 'save_note', input: { n: 1 } });
      await d.settle(1_000);
      expect(calls).toEqual(['save_note', 'save_note']); // the retry ran
      expect(posts[1].content).toBe('saved');
    });

    it('a replay is refused if a Stop lands while its liveness check is in flight', async () => {
      let stopped = false;
      const t = rig({ stopped: () => stopped, onList: (n) => { if (n === 2) stopped = true; } });
      t.behaviour.next = [new ToolResultLostError('result_lost')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      t.d.start(t.ev('op-2', 'save_note', { n: 1 }, 'later'));
      await t.d.settle(1_000);
      expect(t.posts[1]).toMatchObject({ isError: true, content: STOPPED_MESSAGE });
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

    it('S2: the shrink retries are bounded: a worker that keeps saying result_too_large gets at most 4 smaller answers and then the plain failure answer', async () => {
      const t = rig({ content: { search: 'x'.repeat(200_000) } });
      t.behaviour.next = Array.from({ length: 12 }, () => new LoginHostError('EINVALID', 'result_too_large'));
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts).toHaveLength(6); // first + 4 shrinks + the plain failure answer
      expect(t.posts[5].content).toBe(DELIVERY_FAILED_MESSAGE);
      expect([...t.d.lostCallIds()]).toEqual(['op-1']);
    });

    it('S2: ambiguous failures are retried at most twice per answer (3 tries), then the plain failure answer gets its own 3 tries', async () => {
      const t = rig();
      t.behaviour.next = Array.from({ length: 20 }, () => new LoginHostError('UNREACHABLE', 'ECONNRESET'));
      t.d.start(t.ev('op-1', 'search'));
      await t.d.settle(1_000);
      expect(t.posts).toHaveLength(6); // 3 tries of the real answer + 3 of the plain one
      expect(t.posts[3].content).toBe(DELIVERY_FAILED_MESSAGE);
      expect([...t.d.lostCallIds()]).toEqual(['op-1']);
    });

    it('N2: an answer reported lost and then replaced by the plain failure text is NOT counted as delivered (the persisted result keeps the note)', async () => {
      const t = rig();
      t.behaviour.next = [new LoginHostError('EINVALID', 'content:too_big')];
      t.d.start(t.ev('op-1', 'save_note', { n: 1 }));
      await t.d.settle(1_000);
      expect(t.posts[1].content).toBe(DELIVERY_FAILED_MESSAGE); // accepted by the worker
      expect(t.d.lostCallIds().has('op-1')).toBe(true);
      expect(t.d.deliveredCallIds().has('op-1')).toBe(false);
    });

    it('N1: input that cannot be canonicalized is refused with its own message and nothing runs', async () => {
      const t = rig();
      let deep: unknown = {};
      for (let i = 0; i < 20000; i++) deep = { a: deep };
      t.d.start(t.ev('op-1', 'save_note', deep));
      await t.d.settle(1_000);
      expect(t.executed).toEqual([]);
      expect(t.posts[0]).toMatchObject({ isError: true, content: BAD_ARGS_MESSAGE });
    });

    it('N3: two calls finishing together that both make the same tool available: exactly one answer carries the definition', async () => {
      let release!: () => void;
      const t = rig({ gate: { search: new Promise<void>((r) => (release = r)) }, appearAfter: { search: [{ name: 'shared_new', description: 'S' }] } });
      t.d.start(t.ev('op-1', 'search', { q: 'a' }));
      t.d.start(t.ev('op-2', 'search', { q: 'b' }));
      await sleep(20);
      release();
      await t.d.settle(1_000);
      expect(t.posts.filter((p) => p.tools?.some((x: any) => x.name === 'shared_new'))).toHaveLength(1);
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
      bridge: { callTool: async () => ({ content: 'x', isError: false }), listTools: async () => [], noteToolUse: () => undefined, takeLedger: () => ({ records: [], truncated: 0 }) },
      manifest: { open: new Set(['search']) },
      isStopped: () => false,
      isHalted: () => false,
      isHaltingCall: () => false,
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
