/**
 * ENG-2113 PR C: the backend against the REAL ToolBridge (only the host and the tools are fakes). The unit tests use a fake bridge; this file exists because a
 * fake bridge hid a real defect: a Stop ends the bridge run before the backend drains it, and the drain of a closed run answers null, so the settled tool
 * work of a stopped turn used to be dropped from the chat.
 */
import { ClaudeCodeBackend, type ClaudeBackendDeps, type ClaudeTurnParams } from '../claudeCodeBackend';
import { ClaudeRunRegistry } from '../claudeRunRegistry';
import { ToolBridge, type BridgeExecuteOutcome, type ToolBridgeDeps } from '../toolBridge';
import { ToolBridgeMcpAdapter } from '../toolBridgeMcp';

const LLM = 'openrouter/anthropic/claude-sonnet-5.5';
const DECISION = { route: 'claude_subscription' as const, connectionId: 'conn-1', epoch: 1, alias: 'sonnet' as const, modelId: LLM, ownerUserId: 'u1' };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function setup(over: { holdMs?: number } = {}) {
  const executions: string[] = [];
  const persisted: any[][] = [];
  const toolDeps = {
    resolveTools: async () => [{ name: 'save_note' }, { name: 'slow_write' }],
    isReadOnly: () => false,
    isLive: async () => true,
    execute: async (_run: unknown, call: { name: string; args: Record<string, unknown> }): Promise<BridgeExecuteOutcome> => {
      executions.push(call.name);
      if (call.name === 'slow_write') await sleep(over.holdMs ?? 120);
      return { content: `${call.name} receipt`, isError: false, requiresConfirmation: false, toolsChanged: false };
    },
    registerRun: () => undefined,
    beginTurn: () => undefined,
    releaseRun: () => undefined,
  };
  const bridge = new ToolBridge(toolDeps as unknown as ToolBridgeDeps);
  const adapter = new ToolBridgeMcpAdapter(bridge);
  const registry = new ClaudeRunRegistry();
  let n = 0;
  const hostScript: { run: (req: any, opts: any) => Promise<any> } = { run: async () => ({ kind: 'completed', result: { type: 'result', ok: true, text: 'done' } }) };
  const deps: ClaudeBackendDeps = {
    hostClient: () => ({}) as any,
    prepareTurnContext: async () => ({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'go' }] }),
    trimToolMessages: (m) => m,
    runHostTurn: (_c, req, opts) => hostScript.run(req, opts),
    bridge: adapter,
    executor: toolDeps,
    registry,
    isCancelled: () => false,
    persistMessages: async (_s, m) => void persisted.push(m),
    markNeedsReconnect: async () => undefined,
    writeJournal: async () => undefined,
    emptyFallbackText: 'EMPTY',
    now: () => Date.now(),
    newRunId: () => `claude-real-${++n}`,
    drainTimeoutMs: 40,
    lateWatchPollMs: 15,
    lateWatchMaxMs: 600,
  };
  const params = (over2: Partial<ClaudeTurnParams> = {}): ClaudeTurnParams => ({ decision: DECISION, sessionId: 's1', userId: 'u1', messageContent: 'go', sessionHistory: [], llmModel: LLM, ...over2 });
  return { bridge, adapter, registry, deps, hostScript, executions, persisted, params, backend: () => new ClaudeCodeBackend(deps) };
}

describe('ClaudeCodeBackend with the real ToolBridge', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('a normal turn: the calls made through the bridge are mapped to adjacent messages with the real ids', async () => {
    const t = setup();
    t.hostScript.run = async (req) => {
      await t.bridge.callTool(req.bridgeToken, { name: 'save_note', args: { note: 'a' }, callId: 'tc-a' });
      return { kind: 'completed', result: { type: 'result', ok: true, text: 'All saved.' } };
    };
    const r = await t.backend().run(t.params());
    expect(r.responseMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(r.responseMessages[1]).toMatchObject({ tool_call_id: 'tc-a', content: 'save_note receipt' });
    expect(r.content).toBe('All saved.');
  });

  it('a Stop after a call settled keeps that call in the chat (the bridge run is already closed when the backend drains)', async () => {
    const t = setup();
    t.hostScript.run = async (req, opts) => {
      await t.bridge.callTool(req.bridgeToken, { name: 'save_note', args: { note: 'a' }, callId: 'tc-a' });
      t.registry.cancel('s1'); // what a Stop / a generation timeout does
      expect(opts.signal.aborted).toBe(true);
      return { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } };
    };
    const r = await t.backend().run(t.params());
    expect(r.cancelled).toBe(true);
    expect(t.executions).toEqual(['save_note']);
    expect(t.persisted).toHaveLength(1);
    expect(t.persisted[0].map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(t.persisted[0][1]).toMatchObject({ tool_call_id: 'tc-a', content: 'save_note receipt' });
  });

  it('a call still executing at Stop finishes later and is saved then, once, with a note', async () => {
    const t = setup({ holdMs: 150 });
    const backend = t.backend();
    t.hostScript.run = async (req) => {
      t.bridge.noteToolUse('claude-real-1', 'tc-slow', 'slow_write', {}, 'm1'); // the stream announces the call before it arrives, as it does for real
      const pending = t.bridge.callTool(req.bridgeToken, { name: 'slow_write', args: {}, callId: 'tc-slow' });
      await sleep(30);
      t.registry.cancel('s1');
      void pending.catch(() => undefined);
      return { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } };
    };
    const r = await backend.run(t.params());
    expect(r.cancelled).toBe(true);
    expect(t.persisted).toEqual([]); // nothing had settled when the turn returned
    await backend.idle();
    expect(t.executions).toEqual(['slow_write']);
    expect(t.persisted).toHaveLength(1);
    expect(t.persisted[0].map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(t.persisted[0][1]).toMatchObject({ tool_call_id: 'tc-slow', content: 'slow_write receipt' });
    expect(t.persisted[0][2].metadata.kind).toBe('claude-late-result');
  });

  it('a refused second turn does not disturb the running one: its later call is still admitted', async () => {
    const t = setup();
    t.hostScript.run = async (req) => {
      const second = await t.backend().run(t.params()).catch((e) => e);
      expect((second as any).code).toBe('host_busy');
      const res = await t.bridge.callTool(req.bridgeToken, { name: 'save_note', args: { note: 'still ok' }, callId: 'tc-b' });
      expect(res.isError).toBe(false);
      return { kind: 'completed', result: { type: 'result', ok: true, text: 'fine' } };
    };
    const r = await t.backend().run(t.params());
    expect(r.responseMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(t.executions).toEqual(['save_note']);
  });

  it('an unexpected host error keeps the settled call, becomes a typed stop and leaves nothing open', async () => {
    const t = setup();
    t.hostScript.run = async (req) => {
      await t.bridge.callTool(req.bridgeToken, { name: 'save_note', args: {}, callId: 'tc-a' });
      throw new Error('socket exploded');
    };
    const err: any = await t.backend().run(t.params()).catch((e) => e);
    expect(err.code).toBe('turn_failed');
    expect(t.persisted).toHaveLength(1);
    expect(t.persisted[0].map((m) => m.role)).toEqual(['assistant', 'tool']);
    expect(t.registry.size).toBe(0);
  });
});
