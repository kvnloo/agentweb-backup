/**
 * ENG-2113 tool relay, backend side, end to end: the REAL ClaudeCodeBackend, the REAL ToolBridge (through the MCP adapter), the REAL runHostTurn and the
 * REAL login host core + HTTP server (scripted provider, unix socket). Only the tools (executor) and the provider's script are fakes, so the wire usage
 * (`tools` instead of `bridgeToken`, `tool-call` events, `turn.toolResult`, "result lost") is the one production would use.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProviderEvent } from '../../../loginHost/adapter';
import { startHostServer, type HostServerHandle } from '../../../loginHost/server';
import { makeRig, type Rig } from '../../../loginHost/__tests__/helpers';
import { ClaudeCodeBackend, MAX_TOKEN_COUNT, chooseToolTransport, clampCount, legacyBridgeAllowed, refusedAsOldWorker, relayAvailable, type ClaudeBackendDeps, type ClaudeTurnParams } from '../claudeCodeBackend';
import { turnRanNoTools } from '../claudeRouteErrors';
import * as relayManifestModule from '../relayManifest';
import { ClaudeRunRegistry } from '../claudeRunRegistry';
import { LoginHostClient, LoginHostError, UnixSocketTransport } from '../loginHostClient';
import { runHostTurn } from '../loginHostTurn';
import { HALTED_MESSAGE, RESULT_LOST_NOTE, SOFT_DEADLINE_MESSAGE, STOPPED_MESSAGE, UNLOADABLE_NOTE } from '../relayToolDispatcher';
import { ToolBridge, type BridgeExecuteOutcome, type BridgeTool, type ToolBridgeDeps } from '../toolBridge';
import { ToolBridgeMcpAdapter } from '../toolBridgeMcp';

const LLM = 'openrouter/anthropic/claude-sonnet-5.5';
const DECISION = { route: 'claude_subscription' as const, connectionId: 'conn-1', epoch: 1, alias: 'fast' as any, modelId: LLM, ownerUserId: 'u1' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await sleep(5);
  }
}
const call = (op: string, name: string, input: Record<string, unknown> = {}, messageId = 'm1'): ProviderEvent => ({ type: 'tool-call', operationId: op, messageId, name, input });
const result = (text = 'All done.'): ProviderEvent => ({ type: 'result', ok: true, text });
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const CID = (n: number, runId = 'claude-relay-1') => `tc_${require('crypto').createHash('sha256').update(runId).digest('hex').slice(0, 12)}_${n}`;
describe('ClaudeCodeBackend on the tool relay (real host core)', () => {
  let rig: Rig;
  let dir: string;
  let handle: HostServerHandle;
  let client: LoginHostClient;
  let n = 0;

  beforeEach(async () => {
    n = 0;
    rig = makeRig({ adapter: { relay: true } });
    dir = mkdtempSync(join(tmpdir(), 'lh-relay-be-'));
    handle = await startHostServer(rig.mgr, { socketPath: join(dir, 'host.sock'), socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 });
    client = new LoginHostClient(new UnixSocketTransport(join(dir, 'host.sock')));
    const start = await client.loginStart({ connectionId: 'conn-1', provider: 'fake' });
    await client.loginComplete({ connectionId: 'conn-1', loginRef: start.loginRef, code: 'abcdefgh#12345678' });
    await client.loginPromote({ connectionId: 'conn-1', loginRef: start.loginRef, epoch: 1 });
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await handle?.close();
    rig?.cleanup();
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function setup(
    over: {
      protocol?: number | undefined;
      status?: 'match' | 'mismatch' | 'unknown';
      holdMs?: Record<string, Promise<void>>;
      images?: Record<string, Array<{ mimeType: string; data: string }>>;
      tools?: BridgeTool[];
      appearAfter?: Record<string, BridgeTool[]>;
      now?: () => number;
      softLead?: number;
      confirm?: string[];
      allowLegacy?: boolean;
      /** true (default in this rig) = batched confirmations on; 'default' = the production default (off). */
      admitSiblings?: boolean | 'default';
    } = {},
  ) {
    const executions: Array<{ name: string; args: Record<string, unknown> }> = [];
    const persisted: any[][] = [];
    const extra: BridgeTool[] = [];
    const live = { value: true };
    const base: BridgeTool[] = over.tools ?? [{ name: 'save_note', description: 'Save', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } }, { name: 'search' }, { name: 'slow_write' }, { name: 'install_skills' }, { name: 'send_email' }];
    const toolDeps = {
      resolveTools: async () => [...base, ...extra],
      isReadOnly: (name: string) => name === 'search',
      isLive: async () => live.value,
      execute: async (_run: unknown, c: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
        executions.push({ name: c.name, args: c.args });
        if (over.holdMs?.[c.name]) await over.holdMs[c.name];
        for (const x of (over.appearAfter ?? { install_skills: [{ name: 'late_tool', description: 'after install', inputSchema: { type: 'object', properties: {} } }] })[c.name] ?? []) extra.push(x);
        return { content: `${c.name} receipt`, isError: false, requiresConfirmation: over.confirm?.includes(c.name) === true, toolsChanged: (over.appearAfter ?? { install_skills: [] })[c.name] !== undefined, ...(over.images?.[c.name] ? { images: over.images[c.name] } : {}) };
      },
      registerRun: () => undefined,
      beginTurn: () => undefined,
      releaseRun: () => undefined,
    };
    const bridge = new ToolBridge(toolDeps as unknown as ToolBridgeDeps);
    const adapter = new ToolBridgeMcpAdapter(bridge);
    const registry = new ClaudeRunRegistry();
    const deps: ClaudeBackendDeps = {
      hostClient: () => client,
      prepareTurnContext: async () => ({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }] }),
      trimToolMessages: (m) => m,
      runHostTurn,
      bridge: adapter,
      relay: {
        workerProtocol: () => ('protocol' in over ? over.protocol : 4),
        protocolStatus: () => over.status ?? 'match',
        allowLegacyBridge: () => over.allowLegacy === true,
      },
      executor: toolDeps,
      registry,
      isCancelled: () => false,
      persistMessages: async (_s, m) => void persisted.push(m),
      markNeedsReconnect: async () => undefined,
      writeJournal: async () => undefined,
      emptyFallbackText: 'EMPTY',
      now: over.now ?? (() => Date.now()),
      newRunId: () => `claude-relay-${++n}`,
      drainTimeoutMs: 600,
      relayAnnounceWaitMs: 20,
      ...(over.admitSiblings === 'default' ? {} : { relayAdmitPostHaltSiblings: over.admitSiblings ?? true }),
      lateWatchPollMs: 15,
      lateWatchMaxMs: 800,
      ...(over.softLead !== undefined ? { softDeadlineLeadMs: over.softLead } : {}),
    };
    const params = (o: Partial<ClaudeTurnParams> = {}): ClaudeTurnParams => ({ decision: DECISION, sessionId: 's1', userId: 'u1', messageContent: 'go', sessionHistory: [], llmModel: LLM, ...o });
    return { bridge, adapter, registry, deps, executions, persisted, live, params, backend: () => new ClaudeCodeBackend(deps) };
  }

  const answers = () => rig.script.answers;

  it('chooses the transport fail-closed: relay for a matching 4+ worker, legacy only for a KNOWN older worker, refuse for everything else', () => {
    const base = setup().deps;
    const fns = { listTools: async () => [], callTool: async () => ({ content: '', isError: false }) };
    const d = (protocol: number | undefined, status: 'match' | 'mismatch' | 'unknown', bridge: Record<string, unknown> = fns) =>
      ({ relay: { workerProtocol: () => protocol, protocolStatus: () => status, allowLegacyBridge: () => legacyAllowed }, bridge: { ...bridge } }) as unknown as Pick<ClaudeBackendDeps, 'relay' | 'bridge'>;
    let legacyAllowed = false;
    expect(chooseToolTransport(d(4, 'match'))).toEqual({ kind: 'relay' });
    expect(chooseToolTransport(d(5, 'match'))).toEqual({ kind: 'relay' });
    // S2: an older worker (a rollback) is refused by default; the HTTP bridge only where it is explicitly allowed
    expect(chooseToolTransport(d(3, 'match'))).toEqual({ kind: 'refuse', cause: 'protocol_too_old' });
    expect(chooseToolTransport(d(2, 'match'))).toEqual({ kind: 'refuse', cause: 'protocol_too_old' });
    legacyAllowed = true;
    expect(chooseToolTransport(d(3, 'match'))).toEqual({ kind: 'legacy' });
    expect(chooseToolTransport(d(2, 'match'))).toEqual({ kind: 'legacy' });
    expect(chooseToolTransport(d(4, 'match'))).toEqual({ kind: 'relay' }); // the setting never downgrades a relay-capable worker
    expect(chooseToolTransport(d(3, 'unknown'))).toEqual({ kind: 'refuse', cause: 'protocol_unknown' });
    legacyAllowed = false;
    expect(chooseToolTransport(d(undefined, 'unknown'))).toEqual({ kind: 'refuse', cause: 'protocol_unknown' });
    expect(chooseToolTransport(d(4, 'unknown'))).toEqual({ kind: 'refuse', cause: 'protocol_unknown' });
    expect(chooseToolTransport(d(3, 'unknown'))).toEqual({ kind: 'refuse', cause: 'protocol_unknown' });
    expect(chooseToolTransport(d(4, 'mismatch'))).toEqual({ kind: 'refuse', cause: 'protocol_mismatch' });
    expect(chooseToolTransport(d(9, 'mismatch'))).toEqual({ kind: 'refuse', cause: 'protocol_mismatch' });
    expect(chooseToolTransport(d(undefined, 'match'))).toEqual({ kind: 'refuse', cause: 'protocol_unknown' });
    // a 4+ worker whose bridge cannot be called in process is refused, never sent to the HTTP bridge (each method checked on its own)
    expect(chooseToolTransport(d(4, 'match', { listTools: fns.listTools }))).toEqual({ kind: 'refuse', cause: 'bridge_not_in_process' });
    expect(chooseToolTransport(d(4, 'match', { callTool: fns.callTool }))).toEqual({ kind: 'refuse', cause: 'bridge_not_in_process' });
    // without the relay dependency (tests, tools; production always has it) the legacy path is kept
    expect(chooseToolTransport({ ...base, relay: undefined })).toEqual({ kind: 'legacy' });
    expect(relayAvailable(d(4, 'match'))).toBe(true);
    expect(relayAvailable(d(3, 'match'))).toBe(false);
  });

  it('a full relay turn: the manifest goes to the worker instead of a bridge token, a tool call runs through the bridge, the result goes back, and the chat gets the pair', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-a', 'save_note', { note: 'hello' }), { wait: g.wait }, result('Saved it.')];
    const spy = jest.spyOn(client, 'turnRun');
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    const r = await run;

    const req = spy.mock.calls[0][0] as any;
    expect(req.bridgeToken).toBeUndefined();
    expect(req.tools.map((x: any) => x.name)).toEqual(['save_note', 'search', 'slow_write', 'install_skills', 'send_email']);
    expect(req.turnId).toBe('claude-relay-1');
    expect(req.idempotencyKey).toBe('claude-relay-1-t1');
    const input = rig.script.turnInputs[0];
    expect(input.bridgeToken).toBeUndefined();
    expect(JSON.stringify(input)).not.toMatch(/token/i);

    expect(t.executions).toEqual([{ name: 'save_note', args: { note: 'hello' } }]);
    expect(answers()).toEqual([{ operationId: 'op-a', answer: { kind: 'tool-result', ok: true, content: 'save_note receipt' } }]);
    expect(r.responseMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(r.responseMessages[1]).toMatchObject({ tool_call_id: CID(1), content: 'save_note receipt' });
    expect(r.content).toBe('Saved it.');
    expect(t.registry.size).toBe(0);
  });

  it('every run gets a fresh turn id and idempotency key', async () => {
    const t = setup();
    rig.script.turnEvents = [result('one')];
    const spy = jest.spyOn(client, 'turnRun');
    await t.backend().run(t.params());
    await t.backend().run(t.params());
    const ids = spy.mock.calls.map((c) => [(c[0] as any).turnId, (c[0] as any).idempotencyKey]);
    expect(new Set(ids.map((i) => i[0])).size).toBe(2);
    expect(new Set(ids.map((i) => i[1])).size).toBe(2);
  });

  it('parallel calls of one message run at once and are each answered under their own operation id', async () => {
    const slow = gate();
    const t = setup({ holdMs: { slow_write: slow.wait } });
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'slow_write', { n: 1 }), call('op-2', 'search', { q: 'x' }), { wait: g.wait }, result('both')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().some((a) => a.operationId === 'op-2')); // the read-only call is answered while the slow write is still running
    expect(answers().map((a) => a.operationId)).toEqual(['op-2']);
    slow.open();
    await waitFor(() => answers().length === 2);
    g.open();
    const r = await run;
    expect(t.executions.map((e) => e.name).sort()).toEqual(['search', 'slow_write']);
    expect(r.responseMessages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort()).toEqual([CID(1), CID(2)]);
  });

  it('install_skills: the same answer carries the new tool definition to the real host, and the tool then runs in the same turn (Emma behaviour)', async () => {
    const t = setup();
    const g1 = gate();
    const g2 = gate();
    rig.script.turnEvents = [call('op-1', 'install_skills', { skills: ['x'] }), { wait: g1.wait }, call('op-2', 'late_tool'), { wait: g2.wait }, result('used it')];
    const spy = jest.spyOn(client, 'turnRun');
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    const open = (spy.mock.calls[0][0] as any).tools.map((x: any) => x.name);
    expect(open).toEqual(['save_note', 'search', 'slow_write', 'install_skills', 'send_email']); // the OPEN set only: no late_tool, no locked flag
    expect((spy.mock.calls[0][0] as any).tools.some((x: any) => 'locked' in x)).toBe(false);
    expect(answers()[0].answer).toMatchObject({ kind: 'tool-result', ok: true, tools: [{ name: 'late_tool', description: 'after install' }] });
    g1.open();
    await waitFor(() => answers().length === 2);
    g2.open();
    await run;
    expect(t.executions.map((e) => e.name)).toEqual(['install_skills', 'late_tool']);
  });

  it('definitions over the real host\'s cumulative cap (tools_limit): the answer is re-sent without them, the model is told, the tools stay unknown', async () => {
    const flood = Array.from({ length: 700 }, (_, i) => ({ name: `new_tool_${i}`, description: 'd', inputSchema: { type: 'object', properties: {} } }));
    const t = setup({ appearAfter: { install_skills: flood } });
    const g1 = gate();
    const g2 = gate();
    rig.script.turnEvents = [call('op-1', 'install_skills'), { wait: g1.wait }, call('op-2', 'new_tool_1'), { wait: g2.wait }, result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    expect(answers()[0].answer).toMatchObject({ kind: 'tool-result', ok: true });
    expect((answers()[0].answer as any).content).toContain(UNLOADABLE_NOTE);
    expect((answers()[0].answer as any).tools).toBeUndefined();
    g1.open();
    await waitFor(() => answers().length === 2);
    expect(answers()[1].answer).toMatchObject({ ok: false });
    expect(t.executions.map((e) => e.name)).toEqual(['install_skills']);
    g2.open();
    await run;
  });

  it('a tool the worker was never sent is refused even if the (compromised) worker emits a call for it', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'late_tool'), { wait: g.wait }, result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    await run;
    expect(t.executions).toEqual([]);
    expect(answers()[0].answer).toMatchObject({ ok: false });
  });

  it('an image from the executor is forwarded in the result', async () => {
    const t = setup({ images: { search: [{ mimeType: 'image/png', data: 'AAAAAAAA' }] } });
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'search'), { wait: g.wait }, result('seen')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    await run;
    expect(answers()[0].answer).toMatchObject({ kind: 'tool-result', images: [{ mimeType: 'image/png', data: 'AAAAAAAA' }] });
  });

  it('a late result (the provider no longer holds the operation): the tool ran once, the outcome is persisted from the ledger WITH the note, the connection is not touched', async () => {
    const t = setup();
    rig.script.staleOperations.add('op-1');
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'save_note', { note: 'a' }), { wait: g.wait }, result('Done anyway.')];
    const markNeedsReconnect = jest.spyOn(t.deps, 'markNeedsReconnect');
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    const r = await run;
    expect(t.executions).toHaveLength(1);
    expect(r.responseMessages[1]).toMatchObject({ role: 'tool', tool_call_id: CID(1) });
    expect(r.responseMessages[1].content).toBe(`save_note receipt\n${RESULT_LOST_NOTE}`);
    expect(markNeedsReconnect).not.toHaveBeenCalled();
    expect((await client.connectionStatus({ connectionId: 'conn-1' })).state).toBe('active'); // never treated as a wipe
  });

  it('the turn ends while a tool is still running: run() waits for it (up to the drain limit), persists its record, and the lost result carries the note', async () => {
    const slow = gate();
    const t = setup({ holdMs: { slow_write: slow.wait } });
    rig.script.turnEvents = [call('op-1', 'slow_write'), result('the model answered without waiting')];
    const run = t.backend().run(t.params());
    await sleep(80);
    slow.open(); // finishes inside the drain window
    const r = await run;
    expect(r.responseMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(r.responseMessages[1].content).toBe(`slow_write receipt\n${RESULT_LOST_NOTE}`);
    expect(t.executions).toHaveLength(1);
  });

  it('a Stop mid-tool: the host turn is interrupted, no further call runs, the finished tool is saved later with the note', async () => {
    const slow = gate();
    const t = setup({ holdMs: { slow_write: slow.wait } });
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'slow_write'), { wait: g.wait }, call('op-2', 'save_note'), result('never')];
    const backend = t.backend();
    const run = backend.run(t.params());
    await waitFor(() => t.executions.length === 1);
    t.registry.cancel('s1'); // what a Stop does
    await waitFor(() => rig.script.interruptedTurns.length === 1);
    const r = await run;
    expect(r.cancelled).toBe(true);
    expect(rig.script.interruptedTurns).toEqual(['claude-relay-1']);
    slow.open();
    await backend.idle();
    expect(t.executions.map((e) => e.name)).toEqual(['slow_write']); // op-2 never ran
    expect(t.persisted.flat().find((m) => m.role === 'tool')?.content).toContain(RESULT_LOST_NOTE);
  });

  it('a Stop pressed while the tool list is being built ends as a cancelled turn, not as the "connection turned off" stop (nothing ran, no credits offer)', async () => {
    const listing = gate();
    const t = setup();
    // the tool list lookup (resolveRunToolAccess: DB reads, per-user MCP discovery) is slow: it returns only after the Stop, when the run is already closed
    const realList = t.adapter.listTools.bind(t.adapter);
    jest.spyOn(t.adapter, 'listTools').mockImplementation(async (...a: Parameters<typeof realList>) => {
      await listing.wait;
      return realList(...a);
    });
    rig.script.turnEvents = [call('op-1', 'save_note'), result('never')];
    const backend = t.backend();
    const run = backend.run(t.params());
    await waitFor(() => t.registry.size === 1); // registered, and now waiting on the tool list
    t.registry.cancel('s1'); // what a Stop does: the bridge run is closed, so the list fails with the "run ended" error
    listing.open();
    const r: any = await run.catch((e) => ({ threw: e?.code ?? String(e) }));
    expect(r).toMatchObject({ cancelled: true }); // it was {"threw":"revoked_or_disabled"}
    expect(t.executions).toHaveLength(0);
    expect(rig.script.interruptedTurns).toEqual([]); // the host turn was never started
    expect(t.registry.size).toBe(0);
  });

  it('a tool list that fails for any OTHER reason (no Stop) is still the typed stop', async () => {
    const t = setup();
    jest.spyOn(t.adapter, 'listTools').mockRejectedValue(new Error('db down'));
    const err: any = await t.backend().run(t.params()).catch((e) => e);
    expect(err.code).toBe('lookup_failed');
  });

  it('revoke / kill switch / flag-off mid-turn (the registry hook) interrupts the host turn and nothing more runs', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'save_note', { n: 1 }), { wait: g.wait }, call('op-2', 'save_note', { n: 2 }), result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    // what hostedSubscriptionService does on a revoke or a disable
    expect(t.registry.cancelConnection('conn-1')).toBe(1);
    t.adapter.revokeConnection('conn-1');
    await waitFor(() => rig.script.interruptedTurns.length === 1);
    const r = await run;
    expect(r.cancelled).toBe(true);
    expect(rig.script.interruptedTurns).toEqual(['claude-relay-1']);
    expect(t.executions).toHaveLength(1);
  });

  it('a revoke of the bridge run alone (no abort yet) refuses the very next relayed call: it is answered, never executed', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'save_note', { n: 1 }), { wait: g.wait }, call('op-2', 'save_note', { n: 2 }), { wait: gate().wait }, result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    t.adapter.revokeConnection('conn-1');
    g.open();
    await waitFor(() => answers().length === 2);
    expect(t.executions).toHaveLength(1);
    expect(answers()[1].answer).toMatchObject({ kind: 'tool-result', ok: false, content: STOPPED_MESSAGE });
    t.registry.cancel('s1');
    await run;
  });

  it('a revoke that only closes the bridge run (another process handled it) refuses the next call, which is answered, not executed', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'save_note', { n: 1 }), { wait: g.wait }, call('op-2', 'save_note', { n: 2 }), { wait: gate().wait }, result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    t.live.value = false; // the per-call liveness check sees the revoke
    g.open();
    await waitFor(() => answers().length === 2);
    expect(t.executions).toHaveLength(1);
    expect(answers()[1].answer).toMatchObject({ kind: 'tool-result', ok: false });
    t.registry.cancel('s1');
    await run;
  });

  it('stream-derived tool-use / tool-result events are informational: they never execute, even with real tool names and arguments', async () => {
    const t = setup();
    rig.script.turnEvents = [
      { type: 'tool-use', operationId: 'toolu_1', name: 'mcp__relay__save_note', input: { note: 'x' } },
      { type: 'tool-use', operationId: 'toolu_2', name: 'save_note', input: { note: 'y' } },
      { type: 'tool-result', operationId: 'toolu_1', ok: true },
      result('text only'),
    ];
    const noteUse = jest.spyOn(t.adapter, 'noteToolUse');
    const noteResult = jest.spyOn(t.adapter, 'noteToolResult');
    const statuses: string[] = [];
    const r = await t.backend().run(t.params({ onProgress: (p) => void statuses.push(p.status) }));
    expect(t.executions).toEqual([]);
    expect(answers()).toEqual([]);
    expect(r.content).toBe('text only');
    // they feed no bridge state (the stream ids are not operation ids) and report no tool progress
    expect(noteUse).not.toHaveBeenCalled();
    expect(noteResult).not.toHaveBeenCalled();
    expect(statuses).toEqual(['thinking']);
  });

  it('double-execution conformance: a call that appears BOTH as a stream tool-use and as a relay tool-call executes exactly once', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [
      { type: 'tool-use', operationId: 'toolu_1', name: 'mcp__relay__save_note', input: { note: 'x' } },
      call('op-1', 'save_note', { note: 'x' }),
      { wait: g.wait },
      { type: 'tool-result', operationId: 'toolu_1', ok: true },
      result('ok'),
    ];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    await run;
    expect(t.executions).toHaveLength(1);
  });

  it('spoofing: identity fields on an event are ignored, and a replayed operation id executes once', async () => {
    const t = setup();
    const g = gate();
    const spoof = { ...call('op-1', 'save_note', { n: 1 }), connectionId: 'conn-evil', turnId: 'turn-evil', epoch: 77, bridgeToken: 'x' } as unknown as ProviderEvent;
    rig.script.turnEvents = [spoof, spoof, { wait: g.wait }, result('x')];
    const turnToolResult = jest.spyOn(client, 'turnToolResult');
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    await run;
    expect(t.executions).toHaveLength(1);
    expect(turnToolResult.mock.calls.map((c) => c[0])).toEqual([expect.objectContaining({ connectionId: 'conn-1', turnId: 'claude-relay-1', epoch: 1, operationId: 'op-1' })]);
    expect(JSON.stringify(turnToolResult.mock.calls)).not.toMatch(/evil|"epoch":77/);
  });

  it('a call for a tool the run does not have is refused and answered (never executed)', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'delete_everything'), { wait: g.wait }, result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    await run;
    expect(t.executions).toEqual([]);
    expect(answers()[0].answer).toMatchObject({ ok: false });
  });

  describe('never a degraded manifest: a turn that would offer fewer tools than the bridge lists is refused and the user told', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ name: `mcp_user_tool_${i}`, description: 'per-user MCP tool' }));
    it.each([
      ['a per-user MCP tool whose name the relay cannot carry', { tools: [{ name: 'save_note' }, { name: 'my.tool', description: 'SECRET-DESC' }, { name: 'install_skills' }] }, 'name'],
      ['a description over the per-tool limit', { tools: [{ name: 'save_note', description: 'SECRET-DESC' + 'd'.repeat(60_000) }, { name: 'install_skills' }] }, 'truncatedDescriptions'],
      ['more per-user MCP tools than the manifest can hold', { tools: [{ name: 'install_skills' }, ...many] }, 'manifest_full'],
      ['every tool the bridge lists is one the relay cannot carry (empty only BECAUSE tools were dropped: too large, not unavailable)', { tools: [{ name: 'my.tool' }] }, 'name'],
    ] as const)('%s: typed stop, not retryable, nothing run, logged by fixed code with counts only', async (_label, over, key) => {
      const t = setup(over as any);
      const spy = jest.spyOn(client, 'turnRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('tools_too_large_for_plan');
      expect(err.offerAgentWebCredits).toBe(true);
      expect(err.retryable).toBe(false);
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(t.registry.size).toBe(0);
      const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
      expect(logged).toContain('relay_manifest_cut');
      expect(logged).toContain(`"${key}":`);
      expect(logged).not.toContain('SECRET-DESC'); // never a description
      if (key === 'name') expect(logged).toContain('my.tool'); // the tool that did not fit is NAMED, so an operator can find it
    });

    it('the refusal line names the tools that did not fit with the sizes that mattered, and the run and session it belongs to; never a description or a schema', async () => {
      const t = setup({ tools: [{ name: 'save_note' }, { name: 'my.tool', description: 'SECRET-DESC', inputSchema: { type: 'object', properties: { secret_prop: { type: 'string' } } } }, { name: 'big_desc', description: 'SECRET-BIG' + 'd'.repeat(60_000) }, { name: 'install_skills' }] } as any);
      await t.backend().run(t.params()).catch(() => undefined);
      const call = (console.error as jest.Mock).mock.calls.find((c) => c[0] === '[claude-backend] relay_manifest_cut');
      expect(call).toBeDefined();
      const f = call![1];
      expect(f).toMatchObject({ session: 's1', run: 'claude-relay-1', name: 1, truncatedDescriptions: 1, offered: 3, listed: 4, open: 3 });
      expect(f.skippedTools.name).toEqual([{ name: 'my.tool', nameChars: 7, schemaBytes: expect.any(Number), descriptionBytes: 11 }]);
      expect(f.truncatedTools).toEqual([{ name: 'big_desc', nameChars: 8, schemaBytes: expect.any(Number), descriptionBytes: 60_010 }]);
      expect(f.bytes).toBeGreaterThan(0);
      const logged = JSON.stringify(call);
      expect(logged).not.toMatch(/SECRET|secret_prop/);
    });

    it('hostile tool names (a line break and a forged log prefix, an ANSI escape, a NUL, 10 kB) in the refusal line stay inside their field: no forged line, no bloat', async () => {
      const evil = ['evil\n[claude-backend] relay_manifest_cut forged', 'ansi\u001b[31mred', 'nul\u0000byte', 'x'.repeat(10_000)];
      const t = setup({ tools: [{ name: 'save_note' }, ...evil.map((name) => ({ name, description: 'd' })), { name: 'install_skills' }] } as any);
      await t.backend().run(t.params()).catch(() => undefined);
      const calls = (console.error as jest.Mock).mock.calls;
      const cut = calls.filter((c) => c[0] === '[claude-backend] relay_manifest_cut');
      expect(cut).toHaveLength(1); // the forged prefix did not make a second line
      const strings: string[] = [];
      const walk = (v: unknown) => (typeof v === 'string' ? strings.push(v) : Array.isArray(v) ? v.forEach(walk) : v && typeof v === 'object' ? Object.values(v).forEach(walk) : undefined);
      cut[0].slice(1).forEach(walk);
      for (const x of strings) {
        expect(x).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
        expect(x.length).toBeLessThanOrEqual(67);
      }
      expect(JSON.stringify(cut[0]).length).toBeLessThan(2_000);
    });

    it('a tool list that cannot be read, and a Stop-independent lookup failure, are logged with a fixed code and the run and session, nothing from the error text', async () => {
      const t = setup();
      jest.spyOn(t.adapter, 'listTools').mockRejectedValue(new Error('connection to db-prod-1.internal:5432 refused SECRET-DETAIL'));
      await t.backend().run(t.params()).catch(() => undefined);
      const line = (console.error as jest.Mock).mock.calls.find((c) => c[0] === '[claude-backend] relay_refused cause=lookup_failed');
      expect(line?.[1]).toMatchObject({ session: 's1', run: 'claude-relay-1', error: 'Error' });
      expect(JSON.stringify(line)).not.toMatch(/SECRET-DETAIL|db-prod/);
    });

    it('every relay turn that starts logs one INFO line with the manifest size and the host protocol (capacity trends before anything is cut)', async () => {
      const info = jest.spyOn(console, 'info').mockImplementation(() => {});
      const t = setup();
      rig.script.turnEvents = [result('fine')];
      await t.backend().run(t.params());
      const line = info.mock.calls.find((c) => c[0] === '[claude-backend] relay_turn_start');
      expect(line?.[1]).toMatchObject({ session: 's1', run: 'claude-relay-1', protocol: 4, truncatedDescriptions: 0, offered: 5, listed: 5, open: 5 });
      expect(line?.[1].bytes).toBeGreaterThan(0);
      expect(line?.[1].skippedTools).toBeUndefined();
    });

    it('names with capitals and hyphens (the widened pattern) are offered by identity and called back by the same name', async () => {
      const t = setup({ tools: [{ name: 'HubSpot-Contacts' }, { name: 'install_skills' }] });
      const g = gate();
      rig.script.turnEvents = [call('op-1', 'HubSpot-Contacts', { q: 1 }), { wait: g.wait }, result('x')];
      const spy = jest.spyOn(client, 'turnRun');
      const run = t.backend().run(t.params());
      await waitFor(() => answers().length === 1);
      g.open();
      await run;
      expect((spy.mock.calls[0][0] as any).tools.map((x: any) => x.name)).toEqual(['HubSpot-Contacts', 'install_skills']);
      expect(t.executions).toEqual([{ name: 'HubSpot-Contacts', args: { q: 1 } }]);
    });
  });

  it('near the soft deadline no further tool starts and the model is told to write its answer; deadlineMs sent to the worker is the hard one', async () => {
    let clock = 1_000_000;
    const t = setup({ now: () => clock, softLead: 15_000 });
    t.deps.turnHardCapMs = 90_000; // deadline = max(30 s, 90 - 20 - 40) = 30 s -> soft = 30 - min(15, 15) = 15 s
    const g1 = gate();
    const g2 = gate();
    rig.script.turnEvents = [call('op-1', 'save_note', { n: 1 }), { wait: g1.wait }, call('op-2', 'save_note', { n: 2 }), { wait: g2.wait }, result('final')];
    const spy = jest.spyOn(client, 'turnRun');
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    expect((spy.mock.calls[0][0] as any).deadlineMs).toBe(30_000);
    clock += 16_000;
    g1.open();
    await waitFor(() => answers().length === 2);
    g2.open();
    await run;
    expect(t.executions).toHaveLength(1);
    expect(answers()[1].answer).toMatchObject({ ok: false, content: SOFT_DEADLINE_MESSAGE });
  });

  describe('a compromised worker: what it can make the API server log, mark, persist or stall on (security review)', () => {
    const allLogs = () => (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');

    it('S4: errorKind and aborted from a forged result are logged only from fixed sets, never raw (no newline, no forged line)', async () => {
      const t = setup();
      rig.script.turnEvents = [{ type: 'result', ok: false, text: '', errorKind: 'x\n[ALARM] forged log line', aborted: 'deadline\n[ALARM] forged' } as any];
      await t.backend().run(t.params()).catch(() => undefined);
      const line = (console.error as jest.Mock).mock.calls.find((c) => c[0] === '[claude-backend] turn ended not ok');
      expect(line?.[1]).toMatchObject({ errorKind: 'other', aborted: 'other' });
      expect(allLogs()).not.toContain('forged');
    });

    it('S4: known values are logged as themselves', async () => {
      const t = setup();
      rig.script.turnEvents = [{ type: 'result', ok: false, text: '', errorKind: 'usage_limit', aborted: 'deadline' }];
      await t.backend().run(t.params()).catch(() => undefined);
      const line = (console.error as jest.Mock).mock.calls.find((c) => c[0] === '[claude-backend] turn ended not ok');
      expect(line?.[1]).toMatchObject({ errorKind: 'usage_limit', aborted: 'deadline' });
    });

    it('S4: an 8.5 MB errorKind line never reaches a log (the line cap ends the stream)', async () => {
      const t = setup();
      rig.script.turnEvents = [{ type: 'result', ok: false, text: '', errorKind: 'k'.repeat(8_500_000) } as any];
      await t.backend().run(t.params()).catch(() => undefined);
      expect(allLogs().length).toBeLessThan(20_000);
    });

    it('S4: an unexpected error message is logged without newlines or control characters, and cut', async () => {
      const t = setup();
      t.deps.runHostTurn = async () => {
        throw new Error(`boom\n[ALARM] forged line\u0007${'z'.repeat(5_000)}`);
      };
      await t.backend().run(t.params()).catch(() => undefined);
      const line = (console.error as jest.Mock).mock.calls.find((c) => c[0] === '[claude-backend] turn failed:');
      expect(String(line?.[1])).not.toMatch(/[\u0000-\u001f]/);
      expect(String(line?.[1]).length).toBeLessThan(260);
      expect(String(line?.[1])).toContain('boom [ALARM] forged line');
    });

    it('S5: a forged auth_dead result shows the stop but one signal does not mark the connection, whatever the status says', async () => {
      const t = setup();
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      jest.spyOn(client, 'connectionStatus').mockResolvedValue({ state: 'active', epoch: 1, runningTurns: 0 } as any);
      const backend = t.backend();
      rig.script.turnEvents = [{ type: 'result', ok: false, text: '', errorKind: 'auth_dead' }];
      const err: any = await backend.run(t.params()).catch((e) => e);
      expect(err.code).toBe('needs_reconnect'); // the user is told, as before
      expect(marked).not.toHaveBeenCalled();
    });

    it('S5: a forged admission ENOTFOUND is one signal: it does not mark; a second consecutive one does (once)', async () => {
      const t = setup();
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      jest.spyOn(client, 'turnRun').mockRejectedValue(new (require('../loginHostClient').LoginHostError)('ENOTFOUND'));
      const backend = t.backend();
      await backend.run(t.params()).catch(() => undefined);
      expect(marked).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i++) await backend.run(t.params()).catch(() => undefined);
      expect(marked).toHaveBeenCalledTimes(1); // the cool-down holds the rest
    });

    it('S5: a genuinely dead login is marked on the SECOND consecutive turn, once, and not again within the cool-down; a working turn in between resets the count', async () => {
      const t = setup();
      let clock = 1_000_000;
      t.deps.now = () => clock;
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      const guarded = new ClaudeCodeBackend({ ...t.deps, confirmDeadLogin: async () => true });
      let deadNext = false;
      const real = client.turnRun.bind(client);
      jest.spyOn(client, 'turnRun').mockImplementation(async (...a: Parameters<typeof real>) => {
        if (deadNext) throw new LoginHostError('ENOTFOUND'); // the worker "has no such login": the admission signal
        return real(...a);
      });
      const dead = async () => {
        deadNext = true;
        await guarded.run(t.params()).catch(() => undefined);
      };
      await dead();
      expect(marked).not.toHaveBeenCalled(); // one signal
      deadNext = false;
      rig.script.turnEvents = [result('fine')];
      await guarded.run(t.params());
      await dead();
      expect(marked).not.toHaveBeenCalled(); // not consecutive: a turn worked in between
      await dead();
      expect(marked).toHaveBeenCalledTimes(1);
      await dead();
      await dead();
      expect(marked).toHaveBeenCalledTimes(1); // cool-down
      clock += 6 * 60_000;
      await dead();
      await dead();
      expect(marked).toHaveBeenCalledTimes(2);
    });

    it('S5: signals spread over more than the window do not add up', async () => {
      const t = setup();
      let clock = 1_000_000;
      t.deps.now = () => clock;
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      const backend = new ClaudeCodeBackend({ ...t.deps, confirmDeadLogin: async () => true });
      const real = client.turnRun.bind(client);
      jest.spyOn(client, 'turnRun').mockImplementation(async () => {
        throw new LoginHostError('ENOTFOUND');
      });
      void real;
      await backend.run(t.params()).catch(() => undefined);
      clock += 11 * 60_000; // past the 10 minute window: the first signal is forgotten
      await backend.run(t.params()).catch(() => undefined);
      expect(marked).not.toHaveBeenCalled();
      await backend.run(t.params()).catch(() => undefined); // two within the window
      expect(marked).toHaveBeenCalledTimes(1);
    });

    it('S5: when the worker itself says the login needs reconnecting (connection.status), the FIRST signal marks it; the cool-down still applies', async () => {
      const t = setup();
      let clock = 1_000_000;
      t.deps.now = () => clock;
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      jest.spyOn(client, 'connectionStatus').mockResolvedValue({ state: 'needs_reconnect', epoch: 1, runningTurns: 0 } as any);
      const backend = t.backend();
      const dead = async () => {
        rig.script.turnEvents = [{ type: 'result', ok: false, text: '', errorKind: 'auth_dead' }];
        await backend.run(t.params()).catch(() => undefined);
      };
      await dead();
      expect(marked).toHaveBeenCalledTimes(1);
      await dead();
      expect(marked).toHaveBeenCalledTimes(1); // cool-down
      clock += 6 * 60_000;
      await dead();
      expect(marked).toHaveBeenCalledTimes(2);
    });

    it('S5: when the status disagrees, one dead-login claim does not mark; the SECOND consecutive turn does', async () => {
      const t = setup();
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      jest.spyOn(client, 'connectionStatus').mockResolvedValue({ state: 'connected', epoch: 1, runningTurns: 0 } as any);
      const backend = t.backend();
      const dead = async () => {
        rig.script.turnEvents = [{ type: 'result', ok: false, text: '', errorKind: 'auth_dead' }];
        await backend.run(t.params()).catch(() => undefined);
      };
      await dead();
      expect(marked).not.toHaveBeenCalled();
      await dead();
      expect(marked).toHaveBeenCalledTimes(1);
    });

    it('S5 breaker: signals about more than 5 DIFFERENT connections within 10 minutes mark only the first 5; one fixed alert line; the stop is still shown for every one', async () => {
      const t = setup();
      let clock = 1_000_000;
      t.deps.now = () => clock;
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      const backend = new ClaudeCodeBackend({ ...t.deps, confirmDeadLogin: async () => 'needs_reconnect' as const });
      const codes: string[] = [];
      for (let i = 0; i < 8; i++) {
        // a connection the worker does not know: its own "no such login" answer is the claim
        const err: any = await backend.run(t.params({ decision: { ...DECISION, connectionId: `conn-x${i}` } })).catch((e: any) => e);
        codes.push(err?.code);
        clock += 1_000;
      }
      expect(codes.every((c) => c === 'needs_reconnect')).toBe(true);
      expect(marked).toHaveBeenCalledTimes(5);
      expect((console.error as jest.Mock).mock.calls.filter((c) => c[0] === '[reconnect-guard] mark_breaker_open')).toHaveLength(1);
      clock += 11 * 60_000; // the window passes: marking resumes
      await backend.run(t.params({ decision: { ...DECISION, connectionId: 'conn-late' } })).catch(() => undefined);
      expect(marked).toHaveBeenCalledTimes(6);
    });

    it('S5 (M5b): the same 2 s bound holds on the ADMISSION path (the worker says "no such login" and then never answers the status call)', async () => {
      const t = setup();
      jest.spyOn(client, 'turnRun').mockRejectedValue(new (require('../loginHostClient').LoginHostError)('ENOTFOUND'));
      jest.spyOn(client, 'connectionStatus').mockImplementation(() => new Promise(() => undefined) as any);
      const backend = t.backend();
      const t0 = Date.now();
      const err: any = await backend.run(t.params()).catch((e: any) => e);
      expect(err.code).toBe('needs_reconnect');
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_800); // and it really did wait for the bound, not return before trying
    }, 10_000);

    it('S5: a status call that hangs does not hold back the stop (about 2 s at most), and the record is still marked when it answers', async () => {
      const t = setup();
      const marked = jest.spyOn(t.deps, 'markNeedsReconnect');
      let answer: (v: unknown) => void = () => undefined;
      jest.spyOn(client, 'connectionStatus').mockImplementation(() => new Promise((r) => (answer = r)) as any);
      const backend = t.backend();
      rig.script.turnEvents = [{ type: 'result', ok: false, text: '', errorKind: 'auth_dead' }];
      const t0 = Date.now();
      const err: any = await backend.run(t.params()).catch((e: any) => e);
      expect(err.code).toBe('needs_reconnect');
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(marked).not.toHaveBeenCalled();
      answer({ state: 'needs_reconnect', epoch: 1, runningTurns: 0 });
      await new Promise((r) => setTimeout(r, 20));
      expect(marked).toHaveBeenCalledTimes(1);
    }, 10_000);

    it('S6: usage counts of 1e308 are capped: the journal row and the persisted usage are finite', async () => {
      const t = setup();
      const rows: any[] = [];
      t.deps.writeJournal = async (r) => void rows.push(r);
      rig.script.turnEvents = [{ type: 'usage', inputTokens: 1e308, outputTokens: 1e308, cacheReadTokens: 1e308, cacheWriteTokens: 1e308 }, result('ok')];
      const r = await t.backend().run(t.params());
      expect(rows).toHaveLength(1);
      const u = rows[0].usage;
      for (const v of [u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens]) expect(v).toBe(MAX_TOKEN_COUNT);
      expect(Number.isFinite(JSON.parse(JSON.stringify(r.responseMessages.at(-1))).usage?.total_tokens ?? 0)).toBe(true);
      expect(clampCount(Infinity)).toBe(0);
      expect(clampCount(-5)).toBe(0);
      expect(clampCount(12.7)).toBe(12);
      expect(clampCount(undefined)).toBe(0);
    });

    it('S9 (production default): after the first confirmation the turn runs no more tools: every later call is refused, announced siblings and reads included', async () => {
      const t = setup({ confirm: ['send_email'], admitSiblings: 'default' });
      const use = (i: number, name: string, input: Record<string, unknown>): ProviderEvent => ({ type: 'tool-use', operationId: `toolu_${i}`, name: `mcp__emma__${name}`, input });
      const gates = Array.from({ length: 3 }, () => gate());
      rig.script.turnEvents = [
        use(0, 'send_email', { to: 'a' }), use(1, 'send_email', { to: 'b' }), use(2, 'search', { q: 'x' }),
        call('op-0', 'send_email', { to: 'a' }), { wait: gates[0].wait },
        call('op-1', 'send_email', { to: 'b' }), { wait: gates[1].wait },
        call('op-2', 'search', { q: 'x' }), { wait: gates[2].wait },
        result('Please confirm.'),
      ];
      const announced = jest.spyOn(t.adapter, 'noteToolUse');
      const run = t.backend().run(t.params());
      for (let i = 0; i < 3; i++) {
        await waitFor(() => answers().length === i + 1);
        gates[i].open();
      }
      await run;
      expect(t.executions.map((e) => e.name)).toEqual(['send_email']);
      expect(answers()[1].answer).toMatchObject({ ok: false, content: HALTED_MESSAGE });
      expect(answers()[2].answer).toMatchObject({ ok: false, content: HALTED_MESSAGE });
      expect(announced.mock.calls.map((c) => c[1])).toEqual([CID(1)]); // the refused calls never reached the bridge
    });
  });

  describe('worker ROLLBACK to protocol 3 while the cached protocol still says match/4', () => {
    const rejected = () => new LoginHostError('EINVALID', 'body:unrecognized_keys'); // what an old worker answers to a `tools` field

    it('the relay turn the old worker refuses fails as the retryable host_unavailable (nothing ran, AgentWeb offered), the cache is invalidated at once, and the next turn uses the fresh decision', async () => {
      const t = setup();
      let known = true;
      const invalidate = jest.fn(() => void (known = false));
      Object.assign(t.deps.relay!, { workerProtocol: () => (known ? 4 : undefined), protocolStatus: () => (known ? 'match' : 'unknown'), invalidateProtocol: invalidate });
      const spy = jest.spyOn(client, 'turnRun').mockRejectedValueOnce(rejected());
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('host_unavailable');
      expect(err.retryable).toBe(true);
      expect(err.offerAgentWebCredits).toBe(true);
      expect(turnRanNoTools(err)).toBe(true);
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(t.registry.size).toBe(0);
      // next turn: the cache is unknown now, so it is refused up front (no worker call) ...
      const err2: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err2.code).toBe('host_unavailable');
      expect(spy).toHaveBeenCalledTimes(1);
      // ... and once the fresh answer is in (here: protocol 3 again, i.e. refused as too old, or 4 again), the decision follows it
      Object.assign(t.deps.relay!, { workerProtocol: () => 3, protocolStatus: () => 'match' });
      const err3: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err3.code).toBe('host_unavailable');
      expect(spy).toHaveBeenCalledTimes(1);
      Object.assign(t.deps.relay!, { workerProtocol: () => 4, protocolStatus: () => 'match' });
      rig.script.turnEvents = [result('fine')];
      expect((await t.backend().run(t.params())).content).toBe('fine');
    });

    it.each([
      ['what a protocol 3 worker answers to a `tools` field', 'bridgeToken:invalid_type,body:unrecognized_keys'],
      ['unrecognized keys alone', 'body:unrecognized_keys'],
      ['the missing bridge token alone', 'bridgeToken:invalid_type'],
      ['a worker without a relay', 'relay_unsupported'],
    ])('EINVALID that means "old worker" (%s) invalidates the cache', async (_l, detail) => {
      expect(refusedAsOldWorker(detail)).toBe(true);
      const t = setup();
      const invalidate = jest.fn();
      Object.assign(t.deps.relay!, { invalidateProtocol: invalidate });
      jest.spyOn(client, 'turnRun').mockRejectedValueOnce(new LoginHostError('EINVALID', detail));
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('host_unavailable');
      expect(invalidate).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a manifest bug', 'tools:tool_duplicate'],
      ['a manifest over the cap', 'tools:too_big'],
      ['a body over the size cap', 'too_large'],
      ['a bad field', 'model:invalid_value'],
      ['no detail', undefined],
      ['both transports', 'tools:bridge_and_tools_mixed'],
    ])('other EINVALID (%s) is NOT an old worker: no invalidation (one bad manifest must not refuse every user), the generic failure', async (_l, detail) => {
      expect(refusedAsOldWorker(detail)).toBe(false);
      const t = setup();
      const invalidate = jest.fn();
      Object.assign(t.deps.relay!, { invalidateProtocol: invalidate });
      jest.spyOn(client, 'turnRun').mockRejectedValueOnce(new LoginHostError('EINVALID', detail));
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('turn_failed');
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('an EINVALID raised AFTER the host started producing events does not invalidate anything', async () => {
      const t = setup();
      const invalidate = jest.fn();
      Object.assign(t.deps.relay!, { invalidateProtocol: invalidate });
      t.deps.runHostTurn = async (_c, _req, opts) => {
        await opts.onEvent?.({ type: 'text', delta: 'hello' });
        throw new LoginHostError('EINVALID', 'body:unrecognized_keys');
      };
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('turn_failed');
      expect(invalidate).not.toHaveBeenCalled();
    });

    it.each([
      ['ENOTFOUND', 'needs_reconnect'],
      ['ESTATE', 'needs_reconnect'],
      ['ESTALE', 'connection_changed'],
      ['EHAZARD', 'policy_blocks'],
      ['EINTERNAL', 'turn_failed'],
    ] as const)('a %s refusal of a relay turn is classified as before and does not touch the cached protocol', async (code, stop) => {
      const t = setup();
      const invalidate = jest.fn();
      Object.assign(t.deps.relay!, { invalidateProtocol: invalidate });
      jest.spyOn(client, 'turnRun').mockRejectedValue(new LoginHostError(code));
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe(stop);
      expect(invalidate).not.toHaveBeenCalled();
    });

    it('a turn on the legacy path refused as invalid does not invalidate anything (the rule is for relay turns)', async () => {
      const t = setup({ protocol: 3, status: 'match', allowLegacy: true });
      const invalidate = jest.fn();
      Object.assign(t.deps.relay!, { invalidateProtocol: invalidate });
      jest.spyOn(client, 'turnRun').mockRejectedValueOnce(rejected());
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('turn_failed');
      expect(invalidate).not.toHaveBeenCalled();
    });
  });

  it('CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE: only the exact string "true" turns the legacy bridge on; unset, empty and every other value are off', () => {
    expect(legacyBridgeAllowed({})).toBe(false);
    expect(legacyBridgeAllowed({ CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE: 'true' })).toBe(true);
    expect(legacyBridgeAllowed({ CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(legacyBridgeAllowed({ CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE: 'true', NODE_ENV: 'production' })).toBe(false); // ignored on production, whatever the flag says
    for (const v of ['', 'false', '1', 'yes', 'TRUE', 'True', ' true', 'true ', '0', 'on']) expect(legacyBridgeAllowed({ CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE: v })).toBe(false);
    expect(legacyBridgeAllowed({ OTHER: 'true' })).toBe(false);
  });

  it('a call already waiting for its announcement when the turn is aborted by the call/flight limit (not a Stop) does not run', async () => {
    const t = setup();
    t.deps.relayAnnounceWaitMs = 500;
    // 20 unannounced calls: the 17th trips the in-flight limit and aborts the host turn (ac.abort(), no Stop); the 16 already past start() are waiting
    rig.script.turnEvents = [...Array.from({ length: 20 }, (_, i) => call(`op-${i}`, 'save_note', { i })), { wait: gate().wait }, result('x')];
    const err: any = await t.backend().run(t.params()).catch((e) => e);
    expect(err).toBeDefined();
    expect(t.executions).toEqual([]);
  });

  describe('dual mode: the HTTP bridge path is unchanged for a KNOWN older worker', () => {
    it.each([
      ['a protocol 3 worker', 3],
      ['a protocol 2 worker', 2],
    ] as const)('%s: legacy request (bridgeToken, no tools), stream tool events feed the bridge as before, nothing is relayed', async (_label, protocol) => {
      const t = setup({ protocol, status: 'match', allowLegacy: true });
      rig.script.turnEvents = [{ type: 'tool-use', operationId: 'tc-1', name: 'mcp__emma__save_note', input: { n: 1 } }, { type: 'tool-result', operationId: 'tc-1', ok: true }, result('fine')];
      const spy = jest.spyOn(client, 'turnRun');
      const noteUse = jest.spyOn(t.adapter, 'noteToolUse');
      const noteResult = jest.spyOn(t.adapter, 'noteToolResult');
      const listTools = jest.spyOn(t.adapter, 'listTools');
      const r = await t.backend().run(t.params());
      const req = spy.mock.calls[0][0] as any;
      expect(req.tools).toBeUndefined();
      expect(typeof req.bridgeToken).toBe('string');
      expect(req.bridgeToken.length).toBeGreaterThan(10);
      expect(rig.script.turnInputs[0].relay).toBeUndefined();
      expect(noteUse).toHaveBeenCalledWith('claude-relay-1', 'tc-1', 'save_note', { n: 1 });
      expect(noteResult).toHaveBeenCalled();
      expect(listTools).not.toHaveBeenCalled();
      expect(r.content).toBe('fine');
    });
  });

  describe('fail closed (B3): never the zero-tool HTTP bridge on a worker that is, or may be, relay-capable', () => {
    it.each([
      ['the version check has not answered yet (first turn after a start)', undefined, 'unknown'],
      ['a failed recheck reset the status', 4, 'unknown'],
      ['the version check says mismatch', 4, 'mismatch'],
    ] as const)('%s: typed retryable stop, nothing opened, known to have run no tool', async (_label, protocol, status) => {
      const t = setup({ protocol, status });
      const spy = jest.spyOn(client, 'turnRun');
      const open = jest.spyOn(t.adapter, 'openRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('host_unavailable');
      expect(err.retryable).toBe(true);
      expect(err.offerAgentWebCredits).toBe(true);
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(t.registry.size).toBe(0);
    });

    it('S2: an older worker (rollback) without the explicit legacy setting: typed retryable stop, nothing opened, no zero-tool turn', async () => {
      const t = setup({ protocol: 3, status: 'match' });
      const spy = jest.spyOn(client, 'turnRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('host_unavailable');
      expect(err.retryable).toBe(true);
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
      expect(logged).toContain('relay_refused cause=protocol_too_old');
    });

    it('a relay-capable worker whose tool list came back EMPTY: tools_unavailable_for_plan (retryable, AgentWeb offered), known to have run no tool, no HTTP-bridge turn', async () => {
      const t = setup({ tools: [] });
      rig.script.turnEvents = [result('fine')];
      const spy = jest.spyOn(client, 'turnRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('tools_unavailable_for_plan');
      expect(err.retryable).toBe(true);
      expect(err.offerAgentWebCredits).toBe(true);
      expect(turnRanNoTools(err)).toBe(true);
      const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
      expect(logged).toContain('relay_refused cause=manifest_empty');
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(t.registry.size).toBe(0);
    });

    it('a finished manifest the protocol schema would refuse is a typed stop before the worker is asked', async () => {
      const t = setup();
      jest.spyOn(relayManifestModule, 'buildRelayManifest').mockReturnValue({ tools: [{ name: 'Dup', description: '', inputSchema: { type: 'object' } }, { name: 'dup', description: '', inputSchema: { type: 'object' } }], open: new Set(['Dup', 'dup']), skipped: {}, truncated: 0 }); // case-insensitive duplicate: the host would refuse it
      const spy = jest.spyOn(client, 'turnRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('tools_unavailable_for_plan');
      expect(err.retryable).toBe(true);
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
      expect(logged).toContain('relay_refused cause=manifest_schema');
    });
  });

  it('S1: a tool that finishes after the settle window but before the drain ends is persisted WITH the result-lost note', async () => {
    const slow = gate();
    const t = setup({ holdMs: { slow_write: slow.wait } });
    rig.script.turnEvents = [call('op-1', 'slow_write'), result('answered early')];
    const run = t.backend().run(t.params());
    await sleep(700); // past the 600 ms settle, inside the 600 ms drain
    slow.open();
    const r = await run;
    const tool = r.responseMessages.find((m) => m.role === 'tool');
    expect(tool?.content).toBe(`slow_write receipt\n${RESULT_LOST_NOTE}`);
  });

  describe('B1: batched confirmations end to end (parity with the AgentWeb path: one deck with every preview of the message)', () => {
    const use = (i: number, name: string, input: Record<string, unknown>): ProviderEvent => ({ type: 'tool-use', operationId: `toolu_${i}`, name: `mcp__aw-relay__${name}`, input });
    it('"pause these 5 ad sets": five previews of one message all run, five halts, one confirmation', async () => {
      const t = setup({ confirm: ['send_email'] });
      const gates = Array.from({ length: 5 }, () => gate());
      rig.script.turnEvents = [
        ...Array.from({ length: 5 }, (_, i) => use(i, 'send_email', { to: `p${i}` })),
        ...gates.flatMap((g, i) => [call(`op-${i}`, 'send_email', { to: `p${i}` }), { wait: g.wait }]),
        result('Please confirm.'),
      ];
      const halts = jest.spyOn(t.adapter, 'takeHalts');
      const run = t.backend().run(t.params());
      for (let i = 0; i < 5; i++) {
        await waitFor(() => answers().length === i + 1);
        gates[i].open();
      }
      const r = await run;
      expect(t.executions.map((e) => e.args.to)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
      expect(halts.mock.results[halts.mock.results.length - 1].value).toHaveLength(5); // the last read: the dispatcher also reads the halts to learn which call halted
      expect(r.content).toContain('confirm');
    });

    it('the host\'s final behaviour: a preview whose stream input was truncated ({"_truncated":"depth"}) falls back to its own group; the rest of the batch still builds one confirmation', async () => {
      const t = setup({ confirm: ['send_email'] });
      const gates = Array.from({ length: 3 }, () => gate());
      rig.script.turnEvents = [
        use(0, 'send_email', { to: 'p0' }),
        use(1, 'send_email', { _truncated: 'depth' }), // what the host forwards for an absurdly nested or huge input
        use(2, 'send_email', { to: 'p2' }),
        call('op-0', 'send_email', { to: 'p0' }),
        { wait: gates[0].wait },
        call('op-1', 'send_email', { to: 'p1-huge' }),
        { wait: gates[1].wait },
        call('op-2', 'send_email', { to: 'p2' }),
        { wait: gates[2].wait },
        result('Please confirm.'),
      ];
      const run = t.backend().run(t.params());
      for (let i = 0; i < 3; i++) {
        await waitFor(() => answers().length === i + 1);
        gates[i].open();
      }
      await run;
      expect(t.executions.map((e) => e.args.to)).toEqual(['p0', 'p2']);
      expect(answers()[1].answer).toMatchObject({ kind: 'tool-result', ok: false });
    });

    it('a read of the same message after the halted preview runs', async () => {
      const t = setup({ confirm: ['send_email'] });
      const g1 = gate();
      const g2 = gate();
      rig.script.turnEvents = [use(1, 'send_email', { to: 'a' }), use(2, 'search', { q: 's' }), call('op-1', 'send_email', { to: 'a' }), { wait: g1.wait }, call('op-2', 'search', { q: 's' }), { wait: g2.wait }, result('x')];
      const run = t.backend().run(t.params());
      await waitFor(() => answers().length === 1);
      g1.open();
      await waitFor(() => answers().length === 2);
      g2.open();
      await run;
      expect(t.executions.map((e) => e.name)).toEqual(['send_email', 'search']);
    });

    it('a call of a LATER message (after the stream showed a result) is refused after a halt', async () => {
      const t = setup({ confirm: ['send_email'] });
      const g1 = gate();
      rig.script.turnEvents = [use(1, 'send_email', { to: 'a' }), call('op-1', 'send_email', { to: 'a' }), { wait: g1.wait }, { type: 'tool-result', operationId: 'toolu_1', ok: true }, use(2, 'save_note', { n: 1 }), call('op-2', 'save_note', { n: 1 }), { wait: gate().wait }, result('x')];
      const run = t.backend().run(t.params());
      await waitFor(() => answers().length === 1);
      g1.open();
      await waitFor(() => answers().length === 2);
      expect(t.executions.map((e) => e.name)).toEqual(['send_email']);
      t.registry.cancel('s1');
      await run;
    });
  });

  it('SF1 exploit: after a halted preview is answered, a later call reusing its message id is refused (end to end through the real host)', async () => {
    const t = setup({ confirm: ['send_email'] });
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'send_email', { to: 'x' }, 'msg-1'), { wait: g.wait }, call('op-2', 'save_note', { note: 'later' }, 'msg-1'), { wait: gate().wait }, result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    await waitFor(() => answers().length === 2);
    expect(t.executions.map((e) => e.name)).toEqual(['send_email']);
    expect(answers()[1].answer).toMatchObject({ ok: false });
    t.registry.cancel('s1');
    await run;
  });

  it('a delivered result is persisted WITHOUT the note', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'save_note'), { wait: g.wait }, result('ok')];
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    g.open();
    const r = await run;
    expect(r.responseMessages[1].content).toBe('save_note receipt');
  });

  it('the backend Stop check stops the next relayed call even when closing the bridge session failed', async () => {
    const t = setup();
    jest.spyOn(t.adapter, 'cancelSession').mockImplementation(() => {
      throw new Error('bridge cancel failed');
    });
    // A scripted stream (no host turn to interrupt): the Stop lands between two relayed calls.
    t.deps.runHostTurn = async (_c, _req, opts) => {
      t.registry.cancel('s1');
      await opts.onEvent?.(call('op-2', 'save_note', { n: 2 }));
      await sleep(30);
      return { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } };
    };
    const r = await t.backend().run(t.params());
    expect(r.cancelled).toBe(true);
    expect(t.executions).toEqual([]);
  });

  it('SF2: a worker flooding operations trips the limit, the turn is interrupted, nothing beyond the limit runs', async () => {
    const slow = gate();
    const t = setup({ holdMs: { slow_write: slow.wait } });
    rig.script.turnEvents = [...Array.from({ length: 40 }, (_, i) => call(`op-${i}`, 'slow_write', { i })), { wait: gate().wait }, result('x')];
    const run = t.backend().run(t.params());
    await waitFor(() => rig.script.interruptedTurns.length === 1);
    slow.open();
    const err: any = await run.catch((e) => e);
    expect(err.code).toBe('turn_failed'); // the interrupted turn is a typed stop; what ran is persisted
    expect(t.executions.length).toBeLessThanOrEqual(16);
  });

  it('a repeated operation id is counted once', async () => {
    const t = setup();
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'save_note'), call('op-1', 'save_note'), call('op-1', 'save_note'), { wait: g.wait }, result('x')];
    const iterations: number[] = [];
    const run = t.backend().run(t.params({ onProgress: (p) => void iterations.push(p.iteration) }));
    await waitFor(() => answers().length === 1);
    g.open();
    await run;
    expect(Math.max(...iterations)).toBe(1);
  });

  it('no progress callback fires after run() returned', async () => {
    const slow = gate();
    const t = setup({ holdMs: { slow_write: slow.wait } });
    t.deps.drainTimeoutMs = 30;
    rig.script.turnEvents = [call('op-1', 'slow_write'), result('early')];
    const statuses: string[] = [];
    await t.backend().run(t.params({ onProgress: (p) => void statuses.push(p.status) }));
    const n = statuses.length;
    slow.open();
    await sleep(50);
    expect(statuses.length).toBe(n);
  });

  it('logs no tool argument, result or image on the relay path (success, lost result and refusal)', async () => {
    const t = setup({ images: { search: [{ mimeType: 'image/png', data: 'IMAGEDATA' + 'A'.repeat(3) }] } });
    rig.script.staleOperations.add('op-2');
    const g = gate();
    rig.script.turnEvents = [call('op-1', 'save_note', { note: 'SECRET-ARG' }), call('op-2', 'search', { q: 'SECRET-Q' }), call('op-3', 'nope', { z: 'SECRET-Z' }), { wait: g.wait }, result('SECRET-FINAL')];
    const out: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) jest.spyOn(console, m).mockImplementation((...a: unknown[]) => void out.push(JSON.stringify(a)));
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 3);
    g.open();
    await run;
    const all = out.join('\n');
    expect(all).not.toMatch(/SECRET-|IMAGEDATA|receipt/);
    expect(STOPPED_MESSAGE.length).toBeGreaterThan(0);
  });
});
