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
import { ClaudeCodeBackend, chooseToolTransport, relayAvailable, type ClaudeBackendDeps, type ClaudeTurnParams } from '../claudeCodeBackend';
import { turnRanNoTools } from '../claudeRouteErrors';
import * as relayManifestModule from '../relayManifest';
import { ClaudeRunRegistry } from '../claudeRunRegistry';
import { LoginHostClient, UnixSocketTransport } from '../loginHostClient';
import { runHostTurn } from '../loginHostTurn';
import { RESULT_LOST_NOTE, SOFT_DEADLINE_MESSAGE, STOPPED_MESSAGE } from '../relayToolDispatcher';
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
      candidates?: BridgeTool[];
      now?: () => number;
      softLead?: number;
      confirm?: string[];
    } = {},
  ) {
    const executions: Array<{ name: string; args: Record<string, unknown> }> = [];
    const persisted: any[][] = [];
    let installed = false;
    const live = { value: true };
    const base: BridgeTool[] = over.tools ?? [{ name: 'save_note', description: 'Save', inputSchema: { type: 'object', properties: { note: { type: 'string' } } } }, { name: 'search' }, { name: 'slow_write' }, { name: 'install_skills' }, { name: 'send_email' }];
    const toolDeps = {
      resolveTools: async () => [...base, ...(installed ? [{ name: 'late_tool' }] : [])],
      isReadOnly: (name: string) => name === 'search',
      isLive: async () => live.value,
      execute: async (_run: unknown, c: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
        executions.push({ name: c.name, args: c.args });
        if (over.holdMs?.[c.name]) await over.holdMs[c.name];
        if (c.name === 'install_skills') installed = true;
        return { content: `${c.name} receipt`, isError: false, requiresConfirmation: over.confirm?.includes(c.name) === true, toolsChanged: c.name === 'install_skills', ...(over.images?.[c.name] ? { images: over.images[c.name] } : {}) };
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
        candidateTools: async () => over.candidates ?? [],
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
      ({ relay: { workerProtocol: () => protocol, protocolStatus: () => status }, bridge: { ...bridge } }) as unknown as Pick<ClaudeBackendDeps, 'relay' | 'bridge'>;
    expect(chooseToolTransport(d(4, 'match'))).toEqual({ kind: 'relay' });
    expect(chooseToolTransport(d(5, 'match'))).toEqual({ kind: 'relay' });
    expect(chooseToolTransport(d(3, 'match'))).toEqual({ kind: 'legacy' });
    expect(chooseToolTransport(d(2, 'match'))).toEqual({ kind: 'legacy' });
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
    expect(r.responseMessages[1]).toMatchObject({ tool_call_id: 'op-a', content: 'save_note receipt' });
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
    expect(r.responseMessages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort()).toEqual(['op-1', 'op-2']);
  });

  it('install_skills: the same result unlocks the late tool at the real host, and the late tool then runs in the same turn', async () => {
    const t = setup({ candidates: [{ name: 'late_tool', description: 'after install' }, { name: 'save_note' }] });
    const g1 = gate();
    const g2 = gate();
    rig.script.turnEvents = [call('op-1', 'install_skills', { skills: ['x'] }), { wait: g1.wait }, call('op-2', 'late_tool'), { wait: g2.wait }, result('used it')];
    const spy = jest.spyOn(client, 'turnRun');
    const run = t.backend().run(t.params());
    await waitFor(() => answers().length === 1);
    expect((spy.mock.calls[0][0] as any).tools.filter((x: any) => x.locked).map((x: any) => x.name)).toEqual(['late_tool']);
    expect(answers()[0].answer).toMatchObject({ kind: 'tool-result', ok: true, unlock: ['late_tool'] });
    g1.open();
    await waitFor(() => answers().length === 2);
    g2.open();
    await run;
    expect(t.executions.map((e) => e.name)).toEqual(['install_skills', 'late_tool']);
  });

  it('a tool that is locked and not unlocked is refused even if the (compromised) worker emits a call for it', async () => {
    const t = setup({ candidates: [{ name: 'late_tool' }] });
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
    expect(r.responseMessages[1]).toMatchObject({ role: 'tool', tool_call_id: 'op-1' });
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
      ['a locked candidate (after a skill install) that would be dropped', { candidates: [{ name: 'late.tool' }] }, 'name'],
    ] as const)('%s: typed stop, not retryable, nothing run, logged by fixed code with counts only', async (_label, over, key) => {
      const t = setup(over as any);
      const spy = jest.spyOn(client, 'turnRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('context_too_large');
      expect(err.retryable).toBe(false);
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(t.registry.size).toBe(0);
      const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
      expect(logged).toContain('relay_manifest_cut');
      expect(logged).toContain(`"${key}":`);
      expect(logged).not.toContain('SECRET-DESC');
      expect(logged).not.toContain('my.tool');
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

  describe('dual mode: the HTTP bridge path is unchanged for a KNOWN older worker', () => {
    it.each([
      ['a protocol 3 worker', 3],
      ['a protocol 2 worker', 2],
    ] as const)('%s: legacy request (bridgeToken, no tools), stream tool events feed the bridge as before, nothing is relayed', async (_label, protocol) => {
      const t = setup({ protocol, status: 'match' });
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

    it('a relay-capable worker with no tool the relay can carry: typed retryable stop, known to have run no tool, no HTTP-bridge turn', async () => {
      const t = setup({ tools: [] });
      rig.script.turnEvents = [result('fine')];
      const spy = jest.spyOn(client, 'turnRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('turn_failed');
      expect(err.retryable).toBe(true);
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      expect(t.registry.size).toBe(0);
    });

    it('a finished manifest the protocol schema would refuse is a typed stop before the worker is asked', async () => {
      const t = setup();
      jest.spyOn(relayManifestModule, 'buildRelayManifest').mockReturnValue({ tools: [{ name: 'only', description: '', inputSchema: { type: 'object' }, locked: true }], open: new Set(['only']), locked: new Set(['only']), skipped: {}, truncated: 0 }); // all locked: the host would refuse it
      const spy = jest.spyOn(client, 'turnRun');
      const err: any = await t.backend().run(t.params()).catch((e) => e);
      expect(err.code).toBe('turn_failed');
      expect(turnRanNoTools(err)).toBe(true);
      expect(spy).not.toHaveBeenCalled();
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
