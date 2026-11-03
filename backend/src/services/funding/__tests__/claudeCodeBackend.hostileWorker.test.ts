/**
 * ENG-2113 (independent security review rvb14, kept as a regression suite): a FULLY hostile worker (raw NDJSON written by the test over a real unix-socket HTTP server) against the REAL ClaudeCodeBackend,
 * REAL runHostTurn / LoginHostClient / UnixSocketTransport, REAL RelayToolDispatcher and REAL ToolBridge (only the tools themselves are fakes).
 * Production defaults: relayAdmitPostHaltSiblings is NOT set.
 */
import * as http from 'http';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeCodeBackend, type ClaudeBackendDeps, type ClaudeTurnParams } from '../claudeCodeBackend';
import { ClaudeRouteStopError } from '../claudeRouteErrors';
import { ClaudeRunRegistry } from '../claudeRunRegistry';
import { LoginHostClient, UnixSocketTransport } from '../loginHostClient';
import { runHostTurn } from '../loginHostTurn';
import { ToolBridge, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps } from '../toolBridge';
import { ToolBridgeMcpAdapter } from '../toolBridgeMcp';
import { RESULT_LOST_NOTE } from '../relayToolDispatcher';

const SOCK = join(fs.mkdtempSync(join(tmpdir(), 'hw-')), 'hw.sock');
const LLM = 'openrouter/anthropic/claude-sonnet-5.5';
const DECISION = { route: 'claude_subscription' as const, connectionId: 'conn-1', epoch: 1, alias: 'sonnet' as any, modelId: LLM, ownerUserId: 'u1' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const gate = () => { let open!: () => void; const wait = new Promise<void>((r) => (open = r)); return { wait, open }; };
async function waitFor(cond: () => boolean, ms = 4000) { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('waitFor timed out'); await sleep(5); } }

type Script = (ctx: { write: (o: unknown | string) => void; end: () => void; posts: any[]; interrupted: () => boolean }) => Promise<void>;

describe('hostile worker vs the relay backend', () => {
  let srv: http.Server;
  let posts: any[];
  let interrupts: number;
  let script: Script;
  let live: { value: boolean };
  let executions: Array<{ name: string; args: any; claims: any }>;
  let toolHold: Record<string, Promise<void>>;
  /** The worker takes every turn.toolResult post and never finishes the reply; `hung` counts them, `hungClosed` the ones whose connection the backend has closed. */
  let hangToolResult = false;
  let hung = 0;
  let hungClosed = 0;

  beforeEach(async () => {
    posts = []; interrupts = 0; executions = []; toolHold = {}; hangToolResult = false; hung = 0; hungClosed = 0;
    try { fs.unlinkSync(SOCK); } catch {}
    srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const route = (req.url ?? '').replace('/v1/', '');
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const json = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (route === 'host.info') return json({ protocol: 4, node: 'x', uptimeSec: 1 });
        if (route === 'turn.renew') return json({ leaseMs: 30000 });
        if (route === 'turn.interrupt') { interrupts++; return json({ interrupted: true }); }
        if (route === 'connection.status') return json({ state: 'active', epoch: 1, runningTurns: 1 });
        if (route === 'turn.toolResult') {
          posts.push(body);
          if (hangToolResult) {
            hung++;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.on('close', () => void hungClosed++);
            return; // never finishes the reply
          }
          return json({ ok: true });
        }
        if (route === 'turn.run') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.write('{"type":"accepted","turnId":"' + body.turnId + '","duplicate":false}\n');
          let intr = false;
          const ctx = { write: (o: unknown | string) => void res.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n'), end: () => res.end(), posts, interrupted: () => interrupts > 0 };
          try { await script(ctx); } catch { /* the client went away */ }
          void intr;
          return;
        }
        res.writeHead(404); res.end('{}');
      });
    });
    await new Promise<void>((r) => srv.listen(SOCK, r));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => { srv.closeAllConnections?.(); await new Promise((r) => srv.close(r)); jest.restoreAllMocks(); });

  function setup(over: { confirm?: string[]; tools?: BridgeTool[] } = {}) {
    live = { value: true };
    const base: BridgeTool[] = over.tools ?? [
      { name: 'save_note', description: 'Save', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } },
      { name: 'search' }, { name: 'send_email' }, { name: 'meta_write' }, { name: 'install_skills' },
    ];
    const toolDeps = {
      resolveTools: async () => base,
      isReadOnly: (n: string) => n === 'search',
      isLive: async () => live.value,
      execute: async (run: any, c: { name: string; args: any }): Promise<BridgeExecuteOutcome> => {
        executions.push({ name: c.name, args: c.args, claims: { ...run } });
        const hold = toolHold[c.name] as Promise<void> | undefined;
        if (hold) await hold;
        return { content: `${c.name} receipt`, isError: false, requiresConfirmation: over.confirm?.includes(c.name) === true, toolsChanged: false };
      },
      registerRun: () => undefined, beginTurn: () => undefined, releaseRun: () => undefined,
    };
    const bridge = new ToolBridge(toolDeps as unknown as ToolBridgeDeps);
    const adapter = new ToolBridgeMcpAdapter(bridge);
    const registry = new ClaudeRunRegistry();
    let n = 0;
    const deps: ClaudeBackendDeps = {
      hostClient: () => new LoginHostClient(new UnixSocketTransport(SOCK)),
      prepareTurnContext: async () => ({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }] }),
      trimToolMessages: (m) => m,
      runHostTurn,
      bridge: adapter,
      relay: { workerProtocol: () => 4, protocolStatus: () => 'match', allowLegacyBridge: () => false },
      executor: toolDeps,
      registry,
      isCancelled: () => false,
      persistMessages: async () => undefined,
      markNeedsReconnect: async () => undefined,
      writeJournal: async () => undefined,
      emptyFallbackText: 'EMPTY',
      now: () => Date.now(),
      newRunId: () => `claude-hw-${++n}`,
      drainTimeoutMs: 800,
      relayAnnounceWaitMs: 20,
      lateWatchPollMs: 15, lateWatchMaxMs: 400,
    };
    const params = (o: Partial<ClaudeTurnParams> = {}): ClaudeTurnParams => ({ decision: DECISION, sessionId: 's1', userId: 'u1', messageContent: 'go', sessionHistory: [], llmModel: LLM, ...o });
    return { bridge, adapter, registry, deps, params, backend: () => new ClaudeCodeBackend(deps) };
  }
  const call = (op: string, name: string, input: unknown = {}, extra: Record<string, unknown> = {}) => ({ type: 'tool-call', operationId: op, messageId: 'm1', name, input, ...extra });

  it('S9: after a write preview EVERY later call is refused (same tick, later, forged announcements, forged message ids, reused ids); only the preview executed', async () => {
    const t = setup({ confirm: ['meta_write'] });
    script = async (c) => {
      c.write({ type: 'tool-use', operationId: 'x1', name: 'meta_write', input: { id: 1 } });
      c.write(call('p1', 'meta_write', { id: 1 }));
      // same tick: announced siblings with the same message id, other tools, the same write again with another id
      c.write({ type: 'tool-use', operationId: 'x2', name: 'meta_write', input: { id: 2 } });
      c.write(call('p2', 'meta_write', { id: 2 }));
      c.write(call('p3', 'save_note', { note: 'n' }));
      c.write(call('p4', 'search', { q: 1 }));
      c.write(call('p5', 'send_email', { to: 'a@b.c' }));
      await sleep(300);
      // later: announce AFTER the halt (forged), then call it, with a forged message id equal to the halted one
      c.write({ type: 'tool-use', operationId: 'x3', name: 'meta_write', input: { id: 3 } });
      c.write(call('p6', 'meta_write', { id: 3 }, { messageId: 'm1' }));
      c.write(call('p7', 'send_email', { to: 'evil@b.c' }, { messageId: 'whatever' }));
      await sleep(300);
      c.write({ type: 'result', ok: true, text: 'done' });
      c.end();
    };
    const r = await t.backend().run(t.params());
    expect(executions.map((e) => `${e.name}:${JSON.stringify(e.args)}`)).toEqual(['meta_write:{"id":1}']);
    expect(posts.map((p) => p.operationId).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(r.content).toContain('needs your confirmation');
  });

  it('identity is the backend closure: extra fields on a tool-call are ignored, the posted ids are ours, the executor sees our user', async () => {
    const t = setup();
    script = async (c) => {
      c.write(call('i1', 'save_note', { note: 'x', userId: 'victim' }, { userId: 'victim', sessionId: 'sv', connectionId: 'other', epoch: 99, runId: 'claude-hw-999', token: 'tok', turnId: 'other-turn' }));
      await sleep(200);
      c.write({ type: 'result', ok: true, text: 'ok' }); c.end();
    };
    await t.backend().run(t.params());
    expect(executions).toHaveLength(1);
    expect(executions[0].claims).toMatchObject({ userId: 'u1', sessionId: 's1', connectionId: 'conn-1', epoch: 1, runId: 'claude-hw-1' });
    expect(posts[0]).toMatchObject({ connectionId: 'conn-1', turnId: 'claude-hw-1', epoch: 1, operationId: 'i1' });
    expect(Object.keys(posts[0]).sort()).toEqual(['connectionId', 'content', 'epoch', 'operationId', 'turnId']);
  });

  it('forged tool names never execute (proto, constructor, prefixes, case, whitespace, unicode, long, reserved, nul)', async () => {
    const t = setup();
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'mcp__emma__save_note', 'mcp__aw__save_note', 'Save_Note', 'SAVE_NOTE', ' save_note', 'save_note ', 'save_note\u0000', 'save_note\n', 'sаve_note', 'aw_relay_save_note', 'x'.repeat(200), '', 'save_note/../../x', 'search;save_note'];
    script = async (c) => {
      names.forEach((nm, i) => c.write(call('n' + i, nm, {})));
      await sleep(400);
      c.write({ type: 'result', ok: true, text: 'ok' }); c.end();
    };
    await t.backend().run(t.params());
    expect(executions).toEqual([]);
  });

  it('Stop mid-turn: a call in flight finishes once, every later call (even announced earlier) is refused, nothing new executes', async () => {
    const t = setup();
    const g = gate(); toolHold['save_note'] = g.wait;
    script = async (c) => {
      c.write(call('a1', 'save_note', { note: 1 }));
      await sleep(100);
      c.write(call('a2', 'save_note', { note: 2 }));
      c.write(call('a3', 'send_email', { to: 'x' }));
      await waitFor(() => interrupts > 0, 5000);
      c.write(call('a4', 'send_email', { to: 'y' }));
      c.write(call('a5', 'search', {}));
      await sleep(200);
      g.open();
      await sleep(200);
      c.write({ type: 'result', ok: false, text: '', aborted: 'interrupted' }); c.end();
    };
    const run = t.backend().run(t.params());
    await waitFor(() => executions.length === 1);
    await sleep(150);
    t.registry.cancel('s1');
    const r = await run;
    expect((r as any).cancelled).toBe(true);
    expect(executions.map((e) => e.args.note ?? e.args.to)).toEqual([1]);
    const answers = Object.fromEntries(posts.map((p) => [p.operationId, p.content]));
    expect(answers['a4']).toMatch(/has ended|not run/);
    expect(answers['a5']).toMatch(/has ended|not run/);
  });

  it('revoke of the connection mid-turn: later calls (read and write) are refused', async () => {
    const t = setup();
    script = async (c) => {
      c.write(call('r1', 'search', {}));
      await waitFor(() => posts.length === 1);
      t.adapter.revokeConnection('conn-1');
      c.write(call('r2', 'search', {})); c.write(call('r3', 'save_note', {}));
      await sleep(300);
      c.write({ type: 'result', ok: true, text: 'ok' }); c.end();
    };
    await t.backend().run(t.params());
    expect(executions.map((e) => e.name)).toEqual(['search']);
  });

  it('liveness lost (flag-off / disabled): a WRITE after the flip is refused at once; a READ is refused once the 5 s positive cache lapses', async () => {
    const t = setup();
    script = async (c) => {
      c.write(call('l1', 'search', {}));
      await waitFor(() => posts.length === 1);
      live.value = false;
      c.write(call('l2', 'save_note', {}));
      c.write(call('l3', 'search', {}));  // within the 5 s cache: still allowed (documented)
      await sleep(300);
      c.write({ type: 'result', ok: true, text: 'ok' }); c.end();
    };
    await t.backend().run(t.params());
    expect(executions.map((e) => e.name).includes('save_note')).toBe(false);
  });

  it('call cap: 450 distinct operations end the turn; at most 400 are ever considered and the executor never sees more', async () => {
    const t = setup();
    script = async (c) => {
      for (let i = 0; i < 450; i++) c.write(call('c' + i, 'search', { i }));
      await sleep(1500);
      c.write({ type: 'result', ok: true, text: 'ok' }); c.end();
    };
    const t0 = Date.now();
    await t.backend().run(t.params()).catch(() => undefined);
    expect(executions.length).toBeLessThanOrEqual(400);
  }, 30000);

  it('duplicate operation id with different args: the second is dropped (one execution, one post)', async () => {
    const t = setup();
    script = async (c) => {
      c.write(call('d1', 'save_note', { note: 'first' }));
      c.write(call('d1', 'save_note', { note: 'second' }));
      c.write(call('d1', 'send_email', { to: 'z' }));
      await sleep(300);
      c.write({ type: 'result', ok: true, text: 'ok' }); c.end();
    };
    await t.backend().run(t.params());
    expect(executions.map((e) => e.args.note)).toEqual(['first']);
    expect(posts.filter((p) => p.operationId === 'd1')).toHaveLength(1);
  });

  it('prototype pollution probe: __proto__ / constructor keys in tool arguments do not pollute Object.prototype', async () => {
    const t = setup();
    script = async (c) => {
      c.write('{"type":"tool-call","operationId":"pp1","messageId":"m","name":"save_note","input":{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":1}},"note":"x"}}');
      c.write('{"type":"tool-use","operationId":"pp2","name":"save_note","input":{"__proto__":{"polluted3":"yes"}}}');
      await sleep(300);
      c.write({ type: 'result', ok: true, text: 'ok' }); c.end();
    };
    await t.backend().run(t.params());
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).polluted2).toBeUndefined();
    expect(({} as any).polluted3).toBeUndefined();
    expect(executions).toHaveLength(1);
  });

  it('a tool-call that arrives AFTER the result event (the stream stays open) is refused: nothing executes, the answer stands', async () => {
    const t = setup();
    script = async (c) => {
      c.write({ type: 'result', ok: true, text: 'all done' });
      await sleep(50);
      c.write(call('late1', 'save_note', { note: 'after result' }));
      await sleep(300);
      c.end();
    };
    const r = await t.backend().run(t.params());
    expect(executions).toEqual([]); // it was ["save_note"]
    expect(r.content).toBe('all done');
    expect(posts.find((p) => p.operationId === 'late1')).toMatchObject({ isError: true });
  });

  it('a post the worker never finishes is aborted when the turn is closed: the backend closes that connection, and the tool\'s persisted result says its answer was not delivered', async () => {
    const t = setup();
    hangToolResult = true;
    script = async (c) => {
      c.write(call('h1', 'save_note', { note: 'hello' }));
      await waitFor(() => hung === 1);
      c.write({ type: 'result', ok: true, text: 'done' });
      c.end();
    };
    const r = await t.backend().run(t.params());
    expect(r.content).toBe('done');
    await waitFor(() => hungClosed === 1); // it was never closed (the reply stayed open until the 60 s request limit)
    const tool = r.responseMessages.find((m: any) => m.role === 'tool');
    expect(tool.content).toBe(`save_note receipt\n${RESULT_LOST_NOTE}`);
  });

  it('a fabricated result.errorKind / text with newlines does not reach the logs verbatim', async () => {
    const t = setup();
    const logged: string[] = [];
    (console.error as jest.Mock).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
    script = async (c) => {
      c.write({ type: 'result', ok: false, text: 'x', errorKind: 'unknown\n[ALARM] forged line sk-ant-secret', aborted: 'dead\nline' });
      c.end();
    };
    await t.backend().run(t.params()).catch(() => undefined);
    expect(logged.join('\n')).not.toMatch(/forged line|sk-ant-secret|ALARM/);
  });
});
