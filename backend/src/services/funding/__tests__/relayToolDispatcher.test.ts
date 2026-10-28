/**
 * ENG-2113 tool relay, backend side: the out-of-band dispatcher against the REAL ToolBridge (only the executor and the worker client are fakes).
 * Each guard here has a mutation check recorded in dev/pending/eng-2113-relay-backend.md.
 */
import { IMAGE_LIMITS } from '../../../loginHost/protocol';
import { LoginHostError, ToolResultLostError } from '../loginHostClient';
import { CALL_CAP_MESSAGE, DELIVERY_FAILED_MESSAGE, NOT_IN_RUN_MESSAGE, REPLAY_NOTE, RelayToolDispatcher, SOFT_DEADLINE_MESSAGE, STOPPED_MESSAGE, type RelayCallEvent } from '../relayToolDispatcher';
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
}

function rig(o: Opts = {}) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  let installed = false;
  const live = { value: true };
  const toolDeps = {
    resolveTools: async () => [{ name: 'search' }, { name: 'save_note' }, { name: 'install_skills' }, ...(installed ? [{ name: 'late_tool' }] : [])],
    isReadOnly: (n: string) => n === 'search',
    isLive: async () => live.value,
    execute: async (_run: unknown, call: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
      executed.push({ name: call.name, args: call.args });
      if (o.gate?.[call.name]) await o.gate[call.name];
      if (call.name === 'install_skills') installed = true;
      return {
        content: o.content?.[call.name] ?? `${call.name} done`,
        isError: false,
        requiresConfirmation: false,
        toolsChanged: call.name === 'install_skills',
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
      const b = behaviour.next.shift();
      if (b) throw b;
      return { ok: true as const };
    }),
  };
  const phases: string[] = [];
  const d = new RelayToolDispatcher({
    client,
    ids: IDS,
    runId: 'r1',
    token,
    bridge: {
      callTool: (t, c, r, op) => bridge.callTool(t, c, r, op),
      listTools: (t, r) => bridge.listTools(t, r),
      noteToolUse: (r, c, n, i, m) => bridge.noteToolUse(r, c, n, i, m),
      takeLedger: (r) => bridge.takeLedger(r),
    },
    manifest: { open: new Set(['search', 'save_note', 'install_skills']), locked: new Set(['late_tool']) },
    isStopped: o.stopped ?? (() => false),
    softDeadlineAt: o.softDeadlineAt,
    now: o.now,
    maxCalls: o.maxCalls,
    sleep: async () => undefined,
    onCall: (phase, name) => void phases.push(`${phase}:${name}`),
  });
  const ev = (op: string, name: string, input: unknown = {}, messageId = 'm1'): RelayCallEvent => ({ operationId: op, messageId, name, input });
  return { d, bridge, token, posts, client, behaviour, executed, ev, live, phases };
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

  it('refuses a name outside the manifest and a locked name that was not unlocked, without touching the bridge', async () => {
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

  it('install_skills unlocks a locked tool: the SAME result carries `unlock`, and only then is the tool callable', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'install_skills', { skills: ['x'] }));
    await t.d.settle(1_000);
    expect(t.posts[0]).toMatchObject({ operationId: 'op-1', content: 'install_skills done', unlock: ['late_tool'] });
    t.d.start(t.ev('op-2', 'late_tool'));
    await t.d.settle(1_000);
    expect(t.executed.map((e) => e.name)).toEqual(['install_skills', 'late_tool']);
    expect(t.posts[1].unlock).toBeUndefined();
  });

  it('a locked tool that the bridge does not list is never unlocked (the bridge list is the authority)', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'search'));
    await t.d.settle(1_000);
    expect(t.posts[0].unlock).toBeUndefined();
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

  it('caps the total number of calls of a turn', async () => {
    const t = rig({ maxCalls: 2 });
    for (let i = 1; i <= 4; i++) t.d.start(t.ev(`op-${i}`, 'search', { i }));
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(2);
    expect(t.posts.filter((p) => p.content === CALL_CAP_MESSAGE)).toHaveLength(2);
  });

  it('identical calls of ONE model message collapse in the bridge; the same call in another message runs', async () => {
    const t = rig();
    t.d.start(t.ev('op-1', 'search', { q: 'x' }, 'msg-a'));
    await t.d.settle(1_000);
    t.d.start(t.ev('op-2', 'search', { q: 'x' }, 'msg-a'));
    await t.d.settle(1_000);
    t.d.start(t.ev('op-3', 'search', { q: 'x' }, 'msg-b'));
    await t.d.settle(1_000);
    expect(t.executed).toHaveLength(2);
    expect(t.posts[1].content).toMatch(/collapsed/);
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

    it('an unlock the worker does not know is dropped and the result is still delivered', async () => {
      const t = rig();
      t.behaviour.next = [new LoginHostError('EINVALID', 'unlock_unknown_tool')];
      t.d.start(t.ev('op-1', 'install_skills'));
      await t.d.settle(1_000);
      expect(t.posts[0].unlock).toEqual(['late_tool']);
      expect(t.posts[1].unlock).toBeUndefined();
      t.d.start(t.ev('op-2', 'late_tool'));
      await t.d.settle(1_000);
      expect(t.posts[2]).toMatchObject({ isError: true, content: NOT_IN_RUN_MESSAGE }); // the worker never revealed it, so it stays locked here
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
      manifest: { open: new Set(['search']), locked: new Set() },
      isStopped: () => false,
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
