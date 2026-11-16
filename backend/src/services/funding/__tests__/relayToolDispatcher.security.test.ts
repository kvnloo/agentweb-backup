import { RelayToolDispatcher, NOT_IN_RUN_MESSAGE, RAN_NOT_PREPARED_MESSAGE, HALTED_MESSAGE, type RelayCallEvent } from '../relayToolDispatcher';
import { ToolBridge, type BridgeExecuteOutcome, type ToolBridgeDeps } from '../toolBridge';

function rig(o: { confirm?: string[]; tools?: Array<Record<string, unknown>>; appear?: Record<string, Array<Record<string, unknown>>>; post?: (i: any) => void } = {}) {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const extra: Array<Record<string, unknown>> = [];
  const appear = o.appear ?? {};
  const base = o.tools ?? [{ name: 'search' }, { name: 'save_note' }, { name: 'install_skills' }, { name: 'send_email' }];
  const toolDeps = {
    resolveTools: async () => [...base, ...extra],
    isReadOnly: (n: string) => n === 'search',
    isLive: async () => true,
    execute: async (_run: unknown, call: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
      executed.push({ name: call.name, args: call.args });
      for (const t of appear[call.name] ?? []) extra.push(t);
      return { content: `${call.name} done`, isError: false, requiresConfirmation: o.confirm?.includes(call.name) === true, toolsChanged: appear[call.name] !== undefined };
    },
  };
  const bridge = new ToolBridge(toolDeps as unknown as ToolBridgeDeps);
  const token = bridge.openRun({ runId: 'r1', userId: 'u1', sessionId: 's1', connectionId: 'conn-1', epoch: 3 });
  bridge.beginTurn('u1', 's1');
  const posts: any[] = [];
  const client = { turnToolResult: jest.fn(async (input: any) => { posts.push(input); o.post?.(input); return { ok: true as const }; }) };
  const logs: string[] = [];
  const d = new RelayToolDispatcher({
    client,
    ids: { connectionId: 'conn-1', turnId: 'claude-run-1', epoch: 3 },
    runId: 'r1',
    token,
    bridge: {
      callTool: (t, c, r, op) => bridge.callTool(t, c, r, op),
      listTools: (t, r) => bridge.listTools(t, r),
      noteToolUse: (r, c, n, i, m) => bridge.noteToolUse(r, c, n, i, m),
      takeLedger: (r) => bridge.takeLedger(r),
      ranCall: (r, c) => bridge.ranCall(r, c),
    },
    manifest: { open: new Set(base.map((t) => String(t.name))) },
    isStopped: () => false,
    isHalted: () => bridge.isHalted('s1', 'u1'),
    isHaltingCall: (op) => bridge.takeHalts('u1', 's1').some((h) => h.callId === op),
    announceWaitMs: 0,
    admitPostHaltSiblings: false, // production
    sleep: async () => undefined,
  });
  const ev = (op: string, name: string, input: unknown = {}): RelayCallEvent => ({ operationId: op, messageId: 'm1', name, input });
  return { d, bridge, posts, executed, ev, logs };
}

describe('SEC dispatcher exploits (production mode)', () => {
  let errs: string[];
  beforeEach(() => {
    errs = [];
    jest.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errs.push(a.map(String).join(' ')));
  });
  afterEach(() => jest.restoreAllMocks());

  it('forged names never execute and never reach the log', async () => {
    const t = rig();
    const evil = ['Search', 'SEARCH', 'search ', ' search', 'search\u0000', 'search\n[relay-dispatch] ALARM root compromised', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'mcp__emma__search', 'ｓearch', 'search‮'];
    evil.forEach((n, i) => t.d.start(t.ev(`op-${i}`, n)));
    await t.d.settle(2000);
    expect(t.executed).toEqual([]);
    expect(t.posts.every((p) => p.content === NOT_IN_RUN_MESSAGE)).toBe(true);
    expect(t.posts.length).toBe(evil.length);
    expect(errs.join('\n')).not.toMatch(/ALARM|root compromised/);
  });

  it('adversarial operation ids that look like backend call ids do not collide with them', async () => {
    const t = rig({ confirm: [] });
    const crypto = require('crypto');
    const pre = `tc_${crypto.createHash('sha256').update('r1').digest('hex').slice(0, 12)}_`;
    t.d.start(t.ev(`${pre}2`, 'save_note', { a: 1 })); // worker picks the id the 2nd backend call would get
    t.d.start(t.ev(`${pre}1`, 'save_note', { a: 2 }));
    t.d.start(t.ev('op-3', 'save_note', { a: 3 }));
    await t.d.settle(2000);
    const ids = t.bridge.takeLedger('r1').records.map((r) => r.toolCallId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(3);
    expect(t.posts.map((p) => p.operationId).sort()).toEqual([`${pre}1`, `${pre}2`, 'op-3'].sort());
  });

  it('mixed burst around a confirmation: only calls queued BEFORE the halting one run; none after', async () => {
    const t = rig({ confirm: ['send_email'] });
    t.d.start(t.ev('a', 'search', { q: 1 }));
    t.d.start(t.ev('b', 'send_email', { to: 'x' }));
    t.d.start(t.ev('c', 'search', { q: 2 }));
    t.d.start(t.ev('d', 'save_note', { n: 1 }));
    t.d.start(t.ev('e', 'send_email', { to: 'y' }));
    await t.d.settle(3000);
    expect(t.executed.map((e) => e.name)).toEqual(['search', 'send_email']);
    const byOp = Object.fromEntries(t.posts.map((p) => [p.operationId, p.content]));
    expect(byOp.c).toBe(HALTED_MESSAGE);
    expect(byOp.d).toBe(HALTED_MESSAGE);
    expect(byOp.e).toBe(HALTED_MESSAGE);
  });

  it('a late tool that cannot be loaded (oversize schema) stays uncallable even though the bridge lists it', async () => {
    const huge = { type: 'object', properties: { x: { description: 'y'.repeat(40_000) } } };
    const t = rig({ appear: { install_skills: [{ name: 'fat_tool', description: 'd', inputSchema: huge }] } });
    t.d.start(t.ev('i', 'install_skills', {}));
    await t.d.settle(2000);
    t.d.start(t.ev('f', 'fat_tool', {}));
    await t.d.settle(2000);
    expect(t.executed.map((e) => e.name)).toEqual(['install_skills']);
    expect(t.posts[1].content).toBe(NOT_IN_RUN_MESSAGE);
  });

  it('B1: a late tool whose schema is nested too deep to serialize', async () => {
    let deep: any = { type: 'object' };
    for (let i = 0; i < 20000; i++) deep = { type: 'object', properties: { a: deep } };
    const t = rig({ appear: { install_skills: [{ name: 'deep_tool', description: 'd', inputSchema: deep }] } });
    t.d.start(t.ev('i', 'install_skills', {}));
    await t.d.settle(2000);
    console.log('B1 posts:', JSON.stringify(t.posts.map((p) => ({ c: String(p.content).slice(0, 120), tools: p.tools?.length }))));
    t.d.start(t.ev('n', 'save_note', { a: 1 }));
    await t.d.settle(2000);
    console.log('B1 next call posts:', JSON.stringify(t.posts.slice(1).map((p) => String(p.content).slice(0, 120))), 'executed', JSON.stringify(t.executed.map((e) => e.name)));
    console.log('B1 errs:', errs.slice(0, 5).join(' | ').slice(0, 400));
  });

  it('prototype-ish tool names offered mid-turn work as plain names', async () => {
    const t = rig({ appear: { install_skills: [{ name: '__proto__', description: 'd', inputSchema: { type: 'object' } }, { name: 'constructor', description: 'd', inputSchema: { type: 'object' } }] } });
    t.d.start(t.ev('i', 'install_skills', {}));
    await t.d.settle(2000);
    console.log('proto tools sent:', JSON.stringify(t.posts[0]?.tools?.map((x: any) => x.name)));
    t.d.start(t.ev('p', '__proto__', {}));
    t.d.start(t.ev('c', 'constructor', {}));
    await t.d.settle(2000);
    console.log('proto executed:', JSON.stringify(t.executed.map((e) => e.name)));
  });
});
