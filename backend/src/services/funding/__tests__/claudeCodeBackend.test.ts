import { ClaudeCodeBackend, CONFIRMATION_NOTE, OUTCOME_UNKNOWN_NOTE, PREVIOUS_UNKNOWN_DIRECTIVE, type ClaudeBackendDeps, type ClaudeTurnParams } from '../claudeCodeBackend';
import { ClaudeRouteStopError, turnRanNoTools } from '../claudeRouteErrors';
import { ClaudeRunRegistry } from '../claudeRunRegistry';
import { LoginHostError } from '../loginHostClient';
import type { BridgeCallRecord, BridgeHalt } from '../toolBridge';
import type { HostTurnOutcome } from '../loginHostTurn';
import type { ProviderEvent } from '../../../loginHost/adapter';
import type { AttemptUsage } from '../attemptUsageJournal';

const LLM = 'openrouter/anthropic/claude-sonnet-5.5';
const FALLBACK = 'EMPTY_FALLBACK';
const DECISION = { route: 'claude_subscription' as const, connectionId: 'conn-1', epoch: 3, alias: 'sonnet' as const, modelId: LLM, ownerUserId: 'u1' };

let seq = 0;
const rec = (over: Partial<BridgeCallRecord> & Pick<BridgeCallRecord, 'toolCallId' | 'name'>): BridgeCallRecord => ({
  args: {}, kind: 'executed', isError: false, toolMessageContent: `${over.name} ok`, arrivalSeq: ++seq, startedAt: 1, endedAt: 2, durationMs: 1, ...over,
});

const done = (text: string, extra: Record<string, unknown> = {}): HostTurnOutcome => ({ kind: 'completed', result: { type: 'result', ok: true, text, ...extra } as any });

interface Harness {
  deps: ClaudeBackendDeps;
  calls: string[];
  persisted: any[][];
  journal: AttemptUsage[];
  reconnect: Array<[string, number, string]>;
  registry: ClaudeRunRegistry;
  setHost(fn: (req: any, opts: any) => Promise<HostTurnOutcome>): void;
  setLedger(ledger: BridgeCallRecord[], halts?: BridgeHalt[]): void;
  state: { cancelled: boolean; client: boolean; messages: any[]; hostReq?: any };
  late: BridgeCallRecord[];
  /** What the fakes were handed / what they answer, for the arguments the backend passes on. */
  x: {
    stillRunning: number;
    drainTimeoutMs?: number;
    openClaims?: any;
    openOpts?: any;
    execCtx?: any;
    prepInput?: any;
    began?: { previousUnknownOutcome: boolean };
    lateReads: number;
    socketEmitted: Array<[string, string]>;
    rearmed: Array<[string, string]>;
    /** Records the bridge's ledger had to cut or drop (its caps). */
    ledgerTruncated?: number;
  };
}

function harness(): Harness {
  const calls: string[] = [];
  const persisted: any[][] = [];
  const journal: AttemptUsage[] = [];
  const reconnect: Array<[string, number, string]> = [];
  const registry = new ClaudeRunRegistry();
  const state: Harness['state'] = { cancelled: false, client: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] };
  let host: (req: any, opts: any) => Promise<HostTurnOutcome> = async () => done('answer');
  let ledger: BridgeCallRecord[] = [];
  let halts: BridgeHalt[] = [];
  let runClosedByCancel = false; // the real bridge ends the run on cancelSession: the drain of a closed run answers null
  const lateRecords: BridgeCallRecord[] = [];
  let n = 0;
  const x: Harness['x'] = { stillRunning: 0, lateReads: 0, socketEmitted: [], rearmed: [] };
  const deps: ClaudeBackendDeps = {
    hostClient: () => (state.client ? ({} as any) : undefined),
    prepareTurnContext: async (input) => (calls.push('prepare'), (x.prepInput = input), { messages: state.messages }),
    trimToolMessages: (m) => m,
    runHostTurn: async (_c, req, opts) => {
      calls.push('host');
      state.hostReq = req;
      return host(req, opts);
    },
    bridge: {
      openRun: (claims, opts) => (calls.push(`open:${claims.runId}`), (x.openClaims = claims), (x.openOpts = opts), 'token-abc'),
      beginTurn: () => (calls.push('beginTurn'), x.began),
      rearmUnknownOutcome: (u, s) => void x.rearmed.push([u, s]),
      noteToolUse: (_r, id, name) => void calls.push(`use:${id}:${name}`),
      noteToolResult: (_r, id) => void calls.push(`result:${id}`),
      // Like the real bridge: closing a run (drain, close, Stop) hands the executor's per-run state back, after any call still executing has finished.
      closeRunAndDrain: async (_r, timeoutMs) => (calls.push('drain'), (x.drainTimeoutMs = timeoutMs), deps.executor.releaseRun('x'), runClosedByCancel ? null : { settled: x.stillRunning === 0, stillRunning: x.stillRunning, ledger, ledgerTruncated: x.ledgerTruncated ?? 0, halts, generation: 'g' }),
      closeRun: () => (calls.push('closeRun'), void deps.executor.releaseRun('x')),
      cancelSession: () => ((runClosedByCancel = true), void calls.push('bridgeCancel')),
      takeHalts: () => halts,
      isHalted: () => false,
      takeLedger: () => ({ records: ledger, truncated: 0 }),
      generationOf: () => 'g',
      takeLedgerByGeneration: () => (x.lateReads++, { records: [...ledger, ...lateRecords], truncated: 0 }),
    },
    executor: {
      registerRun: (_id, ctx) => (calls.push('exec:register'), void (x.execCtx = ctx)),
      beginTurn: () => void calls.push('exec:begin'),
      releaseRun: () => void calls.push('exec:release'),
    },
    registry,
    isCancelled: () => state.cancelled,
    persistMessages: async (_s, m) => void persisted.push(m),
    markNeedsReconnect: async (c, e, r) => void reconnect.push([c, e, r]),
    reconnectSignalsRequired: 1, // the one-signal behaviour is what these tests pin; the consecutive-turns rule has its own tests (claudeCodeBackend.relay.test.ts)
    confirmDeadLogin: async () => true,
    writeJournal: async (row) => void journal.push(row),
    emptyFallbackText: FALLBACK,
    now: () => 1_000_000,
    newRunId: () => `claude-run-${++n}`,
    lateWatchPollMs: 5,
    lateWatchMaxMs: 60,
    socketEmit: (room, event) => void x.socketEmitted.push([room, event]),
  };
  return { deps, calls, persisted, journal, reconnect, registry, state, x, late: lateRecords, setHost: (f) => (host = f), setLedger: (l, h = []) => ((ledger = l), (halts = h)) };
}

const params = (over: Partial<ClaudeTurnParams> = {}): ClaudeTurnParams => ({
  decision: DECISION, sessionId: 's1', userId: 'u1', messageContent: 'hi', sessionHistory: [], llmModel: LLM, ...over,
});

const stopCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no-throw';
  } catch (e) {
    return e instanceof ClaudeRouteStopError ? e.code : `other:${String(e)}`;
  }
};

describe('ClaudeCodeBackend', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  describe('before anything is opened', () => {
    it('stops with host_unavailable when there is no host client, opening nothing', async () => {
      const h = harness();
      h.state.client = false;
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('host_unavailable');
      expect(h.calls).toEqual([]);
    });

    it('stops with context_too_large when the prompt does not fit, opening nothing', async () => {
      const h = harness();
      h.state.messages = [{ role: 'user', content: 'a'.repeat(2_100_000) }];
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('context_too_large');
      expect(h.calls).toEqual(['prepare']);
      expect(h.registry.size).toBe(0);
    });
  });

  describe('a normal turn', () => {
    it('runs the lifecycle in order, with the alias to the host and the registry id in the messages', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'get_leads', groupId: 'g', groupIndex: 0, groupOrder: 0, result: { n: 1 } })]);
      h.setHost(async (_req, opts) => {
        await opts.onEvent({ type: 'tool-use', operationId: 'tc1', name: 'mcp__emma__get_leads', input: {} } as ProviderEvent);
        await opts.onEvent({ type: 'tool-result', operationId: 'tc1', ok: true } as ProviderEvent);
        await opts.onEvent({ type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 } as ProviderEvent);
        return done('Here you go.');
      });
      const progress: string[] = [];
      const r = await new ClaudeCodeBackend(h.deps).run(params({ onProgress: (x) => progress.push(x.status) }));

      expect(h.calls).toEqual(['prepare', 'exec:register', 'open:claude-run-1', 'beginTurn', 'exec:begin', 'host', 'use:tc1:get_leads', 'result:tc1', 'drain', 'exec:release']);
      expect(progress).toEqual(['thinking', 'executing_tools', 'tool_executed']);
      expect(h.state.hostReq).toMatchObject({
        connectionId: 'conn-1', epoch: 3, model: 'sonnet', bridgeToken: 'token-abc', turnId: 'claude-run-1', idempotencyKey: 'claude-run-1-t1', priority: 'interactive',
      });
      expect(h.state.hostReq.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(h.state.hostReq.prompt).toContain('<<AW:USER');
      expect(r.content).toBe('Here you go.');
      expect(r.persistedResponseCount).toBe(0);
      expect(r.responseMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
      const last = r.responseMessages[2];
      expect(last).toMatchObject({ llm: LLM, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cache_read_input_tokens: 5, estimated_cost: 0 } });
      expect(r.toolCalls).toHaveLength(1);
      expect(h.journal).toHaveLength(1);
      expect(h.journal[0]).toMatchObject({
        attemptId: 'claude-run-1', runId: 's1', userId: 'u1', fundingSource: 'claude_subscription', fundingPrincipalId: 'u1', connectionId: 'conn-1', credentialEpoch: 3,
        requestedModel: LLM, outcome: 'succeeded', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0 }, settlementState: 'settled',
      });
      expect(h.registry.size).toBe(0);
    });

    it('writes no journal row when the plan reported no usage (unknown is not zero)', async () => {
      const h = harness();
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.journal).toEqual([]);
    });

    it('a failing journal write never fails the turn', async () => {
      const h = harness();
      h.deps.writeJournal = async () => {
        throw new Error('dynamo down');
      };
      h.setHost(async (_r, opts) => (await opts.onEvent({ type: 'usage', inputTokens: 1, outputTokens: 1 }), done('ok')));
      await expect(new ClaudeCodeBackend(h.deps).run(params())).resolves.toMatchObject({ content: 'ok' });
    });

    it('a blank answer becomes the empty-response fallback', async () => {
      const h = harness();
      h.setHost(async () => done('   '));
      expect((await new ClaudeCodeBackend(h.deps).run(params())).content).toBe(FALLBACK);
    });

    it('a tool that asked for confirmation ends the turn with the plain note, keeping the model\'s own text', async () => {
      const h = harness();
      const halt = { callId: 'tc1', name: 'meta_preview' } as BridgeHalt;
      h.setLedger([rec({ toolCallId: 'tc1', name: 'meta_preview' })], [halt]);
      h.setHost(async () => done('I prepared it.'));
      const r = await new ClaudeCodeBackend(h.deps).run(params());
      expect(r.content).toBe(`I prepared it.\n\n${CONFIRMATION_NOTE}`);
      h.setHost(async () => done(''));
      expect((await new ClaudeCodeBackend(h.deps).run(params())).content).toBe(CONFIRMATION_NOTE);
    });

    it('the host deadline is what is left of the turn cap', async () => {
      const h = harness();
      await new ClaudeCodeBackend(h.deps).run(params({ turnStartMs: 1_000_000 - 100_000 }));
      // cap - elapsed - grace - the 40 s the host may wait for a free slot before the turn starts
      expect(h.state.hostReq.deadlineMs).toBe(600_000 - 100_000 - 20_000 - 40_000);
      await new ClaudeCodeBackend(h.deps).run(params({ turnStartMs: 1_000_000 - 590_000 }));
      expect(h.state.hostReq.deadlineMs).toBe(30_000); // never below the floor
      h.deps.turnHardCapMs = 10_000_000;
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.state.hostReq.deadlineMs).toBe(3_600_000); // never above the host's own ceiling
    });

    it('registers the cancel handle while the turn runs and releases it after', async () => {
      const h = harness();
      let during = -1;
      h.setHost(async () => ((during = h.registry.size), done('ok')));
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(during).toBe(1);
      expect(h.registry.size).toBe(0);
    });
  });

  describe('what the bridge ledger holds after a Stop closed the run', () => {
    it('reads the ledger from where the bridge keeps it when the drain of the closed run answers null', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note', groupId: 'g', groupIndex: 0, groupOrder: 0 }), rec({ toolCallId: 'tc2', name: 'save_note', groupId: 'g2', groupIndex: 0, groupOrder: 1 })]);
      h.setHost(async () => (h.registry.cancel('s1'), { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } as any }));
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.persisted).toHaveLength(1);
      expect(h.persisted[0].filter((m) => m.role === 'tool')).toHaveLength(2);
    });

    it('a call that was still executing is saved when it finishes, once, with a note', async () => {
      const h = harness();
      const backend = new ClaudeCodeBackend(h.deps);
      h.setHost(async () => (h.registry.cancel('s1'), { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } as any }));
      await backend.run(params());
      expect(h.persisted).toEqual([]); // nothing had settled
      h.late.push(rec({ toolCallId: 'late1', name: 'live_hold', late: true, cancelledDuringCall: true, groupId: 'g', groupIndex: 0, groupOrder: 0 }));
      await backend.idle();
      expect(h.persisted).toHaveLength(1);
      expect(h.persisted[0].map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
      expect(h.persisted[0][2]).toMatchObject({ content: expect.stringMatching(/finished after this turn was stopped/), metadata: { kind: 'claude-late-result' } });
      expect(h.persisted[0][2].metadata.toolCalls).toBeUndefined();
    });

    it('a call that settled before the Stop is not saved a second time as a late result', async () => {
      const h = harness();
      const backend = new ClaudeCodeBackend(h.deps);
      const settled = rec({ toolCallId: 'tc1', name: 'save_note', late: true });
      h.setLedger([settled]);
      h.setHost(async () => (h.registry.cancel('s1'), { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } as any }));
      await backend.run(params());
      await backend.idle();
      expect(h.persisted).toHaveLength(1); // only the settled batch
    });

    it('does not look for late results when the drain finished cleanly', async () => {
      const h = harness();
      const backend = new ClaudeCodeBackend(h.deps);
      await backend.run(params());
      h.late.push(rec({ toolCallId: 'x', name: 'save_note', late: true }));
      await backend.idle();
      expect(h.persisted).toEqual([]);
    });
  });

  describe('journal and tool budgets', () => {
    it('attributes the journal row to the billing subject the context resolved (the org root for a member)', async () => {
      const h = harness();
      h.deps.prepareTurnContext = async () => ({ messages: h.state.messages, billingUserId: 'org-root' });
      h.setHost(async (_r, opts) => (await opts.onEvent({ type: 'usage', inputTokens: 1, outputTokens: 1 }), done('ok')));
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.journal[0]).toMatchObject({ userId: 'u1', billingUserId: 'org-root' });
    });

    it('seeds the per-session web-search count into the executor for this turn', async () => {
      const h = harness();
      const begin = jest.fn();
      h.deps.executor.beginTurn = begin;
      h.deps.seedSearchCount = () => 7;
      await new ClaudeCodeBackend(h.deps).run(params({ sessionHistory: [{ role: 'user', content: 'x' }] }));
      expect(begin).toHaveBeenCalledWith('claude-run-1', { agentRuntimeRunId: 'claude-run-1', priorSearchCallCount: 7 });
    });
  });

  describe('Stop', () => {
    it('a Stop that landed before the turn started runs nothing on the host', async () => {
      const h = harness();
      h.state.cancelled = true;
      const r = await new ClaudeCodeBackend(h.deps).run(params());
      expect(r.cancelled).toBe(true);
      expect(h.calls).not.toContain('host');
      expect(h.registry.size).toBe(0);
    });

    it('a Stop during the turn refuses new bridge calls, aborts the host turn, keeps the settled tool work and drops the answer', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note', groupId: 'g', groupIndex: 0, groupOrder: 0 })]);
      h.setHost(async (_req, opts) => {
        h.registry.cancel('s1');
        expect(opts.signal.aborted).toBe(true);
        return { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } as any };
      });
      const r = await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.calls).toContain('bridgeCancel');
      expect(r).toMatchObject({ cancelled: true, responseMessages: [], persistedResponseCount: 0 });
      expect(h.persisted).toHaveLength(1);
      expect(h.persisted[0].map((m) => m.role)).toEqual(['assistant', 'tool']); // the pair, no final answer
      expect(h.registry.size).toBe(0);
    });

    it('a Stop with no tool work persists nothing', async () => {
      const h = harness();
      h.setHost(async () => (h.registry.cancel('s1'), { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } as any }));
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.persisted).toEqual([]);
    });
  });

  describe('failures are typed stops, never AgentWeb', () => {
    it.each([
      [new LoginHostError('EBUSY'), 'host_busy'],
      [new LoginHostError('UNREACHABLE', 'ECONNREFUSED'), 'host_unavailable'],
      [new LoginHostError('ESTALE'), 'connection_changed'],
    ])('a host failure %# maps to its stop, after the settled tool work is persisted', async (err, code) => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note' })]);
      h.setHost(async () => {
        throw err;
      });
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe(code);
      expect(h.persisted).toHaveLength(1);
      expect(h.registry.size).toBe(0);
      expect(h.calls).toContain('exec:release');
    });

    it('S8: a turn whose ledger had to cut or drop records says so in the persisted messages (metadata only), on every way out', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'a', name: 'save_note' })]);
      h.x.ledgerTruncated = 3;
      h.setHost(async () => done('ok'));
      const r = await new ClaudeCodeBackend(h.deps).run(params());
      expect(r.responseMessages.at(-1).metadata.ledgerTruncated).toBe(3);

      const u = harness();
      u.setLedger([rec({ toolCallId: 'a', name: 'save_note' })]);
      u.x.ledgerTruncated = 2;
      u.setHost(async () => ({ kind: 'unknown_outcome', reason: 'stream_dropped' }) as HostTurnOutcome);
      expect((await new ClaudeCodeBackend(u.deps).run(params())).responseMessages.at(-1).metadata.ledgerTruncated).toBe(2);

      const f = harness();
      f.setLedger([rec({ toolCallId: 'a', name: 'save_note' })]);
      f.x.ledgerTruncated = 5;
      f.setHost(async () => done('', { ok: false, errorKind: 'usage_limit' }));
      await new ClaudeCodeBackend(f.deps).run(params()).catch(() => undefined);
      expect(f.persisted[0].at(-1).metadata.ledgerTruncated).toBe(5);

      const clean = harness();
      clean.setLedger([rec({ toolCallId: 'a', name: 'save_note' })]);
      clean.setHost(async () => done('ok'));
      expect((await new ClaudeCodeBackend(clean.deps).run(params())).responseMessages.at(-1).metadata?.ledgerTruncated).toBeUndefined();
    });

    it('a host that no longer knows the connection flags it for reconnect', async () => {
      const h = harness();
      h.setHost(async () => {
        throw new LoginHostError('ENOTFOUND');
      });
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('needs_reconnect');
      expect(h.reconnect).toEqual([['conn-1', 3, 'host_denied']]);
    });

    it('a dead login reported by the turn flags the connection and stops', async () => {
      const h = harness();
      h.setHost(async () => done('', { ok: false, errorKind: 'auth_dead' }));
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('needs_reconnect');
      expect(h.reconnect).toEqual([['conn-1', 3, 'turn_auth_dead']]);
    });

    it('production defaults (no bypass flags): one dead-login claim shows the stop but does not flag; the second consecutive turn does', async () => {
      const h = harness();
      delete (h.deps as any).reconnectSignalsRequired;
      delete (h.deps as any).confirmDeadLogin;
      h.setHost(async () => done('', { ok: false, errorKind: 'auth_dead' }));
      const backend = new ClaudeCodeBackend(h.deps);
      expect(await stopCode(backend.run(params()))).toBe('needs_reconnect');
      expect(h.reconnect).toEqual([]); // one signal, the status does not say needs_reconnect
      expect(await stopCode(backend.run(params()))).toBe('needs_reconnect');
      expect(h.reconnect).toEqual([['conn-1', 3, 'turn_auth_dead']]); // the second consecutive turn
    });

    it('the plan\'s own usage limit stops with usage_limit and does not flag the connection', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note' })]);
      h.setHost(async () => done('', { ok: false, errorKind: 'usage_limit' }));
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('usage_limit');
      expect(h.reconnect).toEqual([]);
      expect(h.persisted).toHaveLength(1);
    });

    it('an unexpected error becomes a typed stop (detail only in the log), after the settled work is kept and everything is released', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note' })]);
      h.setHost(async () => {
        throw new Error('boom with a secret-ish detail');
      });
      const err = await new ClaudeCodeBackend(h.deps).run(params()).catch((e) => e);
      expect(err).toBeInstanceOf(ClaudeRouteStopError);
      expect((err as ClaudeRouteStopError).code).toBe('turn_failed');
      expect(JSON.stringify((err as ClaudeRouteStopError).userMessage)).not.toContain('secret-ish');
      expect(h.persisted).toHaveLength(1); // the write that ran is not lost
      expect(h.calls).toEqual(expect.arrayContaining(['drain', 'exec:release']));
      expect(h.registry.size).toBe(0);
      expect(h.journal).toEqual([]);
    });

    describe('whether the failed turn is KNOWN to have run no tool (the "continue on AgentWeb credits" offer)', () => {
      const failWith = async (h: ReturnType<typeof harness>) => (await new ClaudeCodeBackend(h.deps).run(params()).catch((e) => e)) as ClaudeRouteStopError;

      it('a stop with no ledger record and no tool event is known to have run none', async () => {
        const h = harness();
        h.setHost(async () => done('', { ok: false, errorKind: 'usage_limit' }));
        expect(turnRanNoTools(await failWith(h))).toBe(true);
      });

      it('a ledger record means a tool may have run, even one that was refused', async () => {
        const h = harness();
        h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note' })]);
        h.setHost(async () => done('', { ok: false, errorKind: 'usage_limit' }));
        expect(turnRanNoTools(await failWith(h))).toBe(false);
      });

      it('a call still running when the turn ended means a tool may have run', async () => {
        const h = harness();
        h.x.stillRunning = 1;
        h.setHost(async () => done('', { ok: false, errorKind: 'usage_limit' }));
        expect(turnRanNoTools(await failWith(h))).toBe(false);
      });

      it('a tool call the model made counts as "may have run" even when the bridge holds no record of it', async () => {
        const h = harness();
        h.setHost(async (_req, opts) => {
          await opts.onEvent({ type: 'tool-use', operationId: 'tc1', name: 'mcp__emma__get_leads', input: {} } as ProviderEvent);
          return done('', { ok: false, errorKind: 'usage_limit' });
        });
        expect(turnRanNoTools(await failWith(h))).toBe(false);
      });

      it('a closed run whose drain answered null is never treated as having run nothing', async () => {
        const h = harness();
        h.setHost(async () => done('', { ok: false, errorKind: 'usage_limit' }));
        h.deps.bridge.closeRunAndDrain = async () => null;
        expect(turnRanNoTools(await failWith(h))).toBe(false);
      });

      it('an unexpected error keeps what the run knew: none ran, or one did', async () => {
        const quiet = harness();
        quiet.setHost(async () => {
          throw new Error('boom');
        });
        expect(turnRanNoTools(await failWith(quiet))).toBe(true);
        const busy = harness();
        busy.setLedger([rec({ toolCallId: 'tc1', name: 'save_note' })]);
        busy.setHost(async () => {
          throw new Error('boom');
        });
        expect(turnRanNoTools(await failWith(busy))).toBe(false);
      });

      it('a stop raised before the run opened ran nothing (no host client, prompt too large)', async () => {
        const gone = harness();
        gone.state.client = false;
        expect(turnRanNoTools(await failWith(gone))).toBe(true);
        const big = harness();
        big.state.messages = [{ role: 'user', content: 'a'.repeat(2_100_000) }];
        expect(turnRanNoTools(await failWith(big))).toBe(true);
      });

      it('an error nobody marked is unknown, which is not "none ran"', async () => {
        const h = harness();
        h.deps.prepareTurnContext = async () => {
          throw new Error('dynamo down');
        };
        expect(turnRanNoTools(await failWith(h))).toBe(false);
      });
    });

    it('an error before anything is opened (the context cannot be built) is also a typed stop, and opens nothing', async () => {
      const h = harness();
      h.deps.prepareTurnContext = async () => {
        throw new Error('dynamo down');
      };
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('turn_failed');
      expect(h.calls).toEqual([]);
    });

    it('a refused second turn never starts a new bridge epoch (it must not stale the running turn\'s halts or calls)', async () => {
      const h = harness();
      h.setHost(async () => {
        await stopCode(new ClaudeCodeBackend({ ...h.deps, newRunId: () => 'claude-run-2' }).run(params()));
        return done('ok');
      });
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.calls.filter((c) => c === 'beginTurn')).toHaveLength(1);
      expect(h.calls.filter((c) => c === 'exec:begin')).toHaveLength(1);
    });

    it('a second turn for the same session is refused without touching the first', async () => {
      const h = harness();
      let inner: Promise<unknown> | undefined;
      h.setHost(async (_req, opts) => {
        inner = new ClaudeCodeBackend({ ...h.deps, newRunId: () => 'claude-run-2' }).run(params());
        expect(await stopCode(inner)).toBe('host_busy');
        expect(opts.signal.aborted).toBe(false);
        return done('first ok');
      });
      expect((await new ClaudeCodeBackend(h.deps).run(params())).content).toBe('first ok');
      expect(h.registry.size).toBe(0);
    });

    it('a lost stream is reported plainly, never retried, with the tool work that was seen', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note', groupId: 'g', groupIndex: 0, groupOrder: 0 })]);
      h.setHost(async () => ({ kind: 'unknown_outcome', reason: 'stream_dropped' }));
      const r = await new ClaudeCodeBackend(h.deps).run(params());
      expect(r.content).toBe(OUTCOME_UNKNOWN_NOTE);
      expect(r.cancelled).toBeUndefined();
      expect(r.responseMessages.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant']);
      expect(h.calls.filter((c) => c === 'host')).toHaveLength(1);
    });
  });

  describe('review fixes (ENG-2113 PR C)', () => {
    const cancelledResult = { kind: 'completed', result: { type: 'result', ok: false, text: '', aborted: 'interrupted' } } as any;

    it('a host that ended the turn at its deadline is the timeout stop, not a generic failure', async () => {
      const h = harness();
      h.setHost(async () => done('', { ok: false, aborted: 'deadline' }));
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('turn_timeout');
    });

    it('reports no tool progress once the turn was stopped', async () => {
      const h = harness();
      const statuses: string[] = [];
      h.setHost(async (_req, opts) => {
        h.registry.cancel('s1');
        await opts.onEvent({ type: 'tool-use', operationId: 'tc9', name: 'mcp__emma__save_note', input: {} } as ProviderEvent);
        return cancelledResult;
      });
      await new ClaudeCodeBackend(h.deps).run(params({ onProgress: (p) => statuses.push(p.status) }));
      expect(statuses).toEqual(['thinking']);
    });

    it('hands the executor back exactly once: through the bridge when the run was opened, directly only when it never opened', async () => {
      const h = harness();
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.calls.filter((c) => c === 'exec:release')).toHaveLength(1);

      const never = harness();
      never.deps.bridge.openRun = () => {
        throw new Error('open failed');
      };
      expect(await stopCode(new ClaudeCodeBackend(never.deps).run(params()))).toBe('turn_failed');
      expect(never.calls.filter((c) => c === 'exec:release')).toHaveLength(1);
      expect(never.calls).not.toContain('drain');
    });

    it('tells the model when the last turn may have left an action unfinished, as the last block it reads', async () => {
      const h = harness();
      h.x.began = { previousUnknownOutcome: true };
      await new ClaudeCodeBackend(h.deps).run(params());
      const prompt: string = h.state.hostReq.prompt;
      expect(prompt).toContain(PREVIOUS_UNKNOWN_DIRECTIVE);
      expect(prompt.lastIndexOf('<<AW:DIRECTIVE')).toBeGreaterThan(prompt.lastIndexOf('<<AW:USER'));
      expect(prompt.trimEnd().endsWith('<</AW>>')).toBe(true);

      for (const began of [{ previousUnknownOutcome: false }, undefined]) {
        const clean = harness();
        clean.x.began = began;
        await new ClaudeCodeBackend(clean.deps).run(params());
        expect(clean.state.hostReq.prompt).not.toContain(PREVIOUS_UNKNOWN_DIRECTIVE);
      }
    });

    describe('the "an earlier action may not have finished" warning', () => {
      const unknownBefore = () => {
        const h = harness();
        h.x.began = { previousUnknownOutcome: true };
        return h;
      };

      it('is put back when the turn ends before the model could read it: a Stop before the host ran', async () => {
        const h = unknownBefore();
        h.state.cancelled = true;
        const r = await new ClaudeCodeBackend(h.deps).run(params());
        expect(r.cancelled).toBe(true);
        expect(h.x.rearmed).toEqual([['u1', 's1']]);
      });

      it('is put back when the host refuses the turn at admission', async () => {
        for (const err of [new LoginHostError('EBUSY'), new LoginHostError('UNREACHABLE', 'x'), new LoginHostError('ESTALE'), new LoginHostError('ENOTFOUND')]) {
          const h = unknownBefore();
          h.setHost(async () => {
            throw err;
          });
          await stopCode(new ClaudeCodeBackend(h.deps).run(params()));
          expect(h.x.rearmed).toEqual([['u1', 's1']]);
        }
      });

      it('is spent once the host produced an event: the model read it', async () => {
        const h = unknownBefore();
        h.setHost(async (_req, opts) => {
          await opts.onEvent({ type: 'tool-use', operationId: 'a', name: 'mcp__emma__x', input: {} } as ProviderEvent);
          return done('ok');
        });
        await new ClaudeCodeBackend(h.deps).run(params());
        expect(h.x.rearmed).toEqual([]);
      });

      it('is spent when the host produced an event and then failed: the model read it', async () => {
        const h = unknownBefore();
        h.setHost(async (_req, opts) => {
          await opts.onEvent({ type: 'text', delta: 'working' } as ProviderEvent);
          throw new LoginHostError('UNREACHABLE', 'dropped');
        });
        await stopCode(new ClaudeCodeBackend(h.deps).run(params()));
        expect(h.x.rearmed).toEqual([]);
      });

      it('is spent when the host gave an outcome, even a lost stream', async () => {
        const h = unknownBefore();
        h.setHost(async () => ({ kind: 'unknown_outcome', reason: 'stream_dropped' }));
        await new ClaudeCodeBackend(h.deps).run(params());
        expect(h.x.rearmed).toEqual([]);
      });

      it('is never re-armed when there was nothing to warn about', async () => {
        const h = harness();
        h.state.cancelled = true;
        await new ClaudeCodeBackend(h.deps).run(params());
        h.setHost(async () => {
          throw new LoginHostError('EBUSY');
        });
        h.state.cancelled = false;
        await stopCode(new ClaudeCodeBackend(h.deps).run(params()));
        expect(h.x.rearmed).toEqual([]);
      });
    });

    it('a refused second turn closes the bridge run it opened', async () => {
      const h = harness();
      const first = h.registry.register('s1', 'u1', 'conn-1', { refuseNewCalls() {}, abort() {} });
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('host_busy');
      expect(h.calls).toContain('closeRun');
      first.release();
    });

    it('a halt the bridge could not preview ends the turn with the confirmation note', async () => {
      const h = harness();
      h.setHost(async () => {
        h.x.openOpts.onHalted({ fallbackNeeded: true });
        return done('Done.');
      });
      const r = await new ClaudeCodeBackend(h.deps).run(params());
      expect(r.content).toContain(CONFIRMATION_NOTE);
      expect(r.content).toContain('Done.');
    });

    it('a Stop flag set while the turn ran, with nothing in the registry, still ends as cancelled', async () => {
      const h = harness();
      h.setHost(async () => ((h.state.cancelled = true), done('late answer')));
      const r = await new ClaudeCodeBackend(h.deps).run(params());
      expect(r.cancelled).toBe(true);
      expect(r.content).not.toContain('late answer');
    });

    it('an unexpected error aborts the host turn before it is reported', async () => {
      const h = harness();
      let signal: AbortSignal | undefined;
      h.setHost(async (_req, opts) => {
        signal = opts.signal;
        throw new Error('boom');
      });
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('turn_failed');
      expect(signal?.aborted).toBe(true);
    });

    it('a reconnect flag that cannot be written never hides the typed stop', async () => {
      const h = harness();
      h.deps.markNeedsReconnect = async () => {
        throw new Error('db down');
      };
      h.setHost(async () => {
        throw new LoginHostError('ENOTFOUND');
      });
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('needs_reconnect');
      const dead = harness();
      dead.deps.markNeedsReconnect = async () => {
        throw new Error('db down');
      };
      dead.setHost(async () => done('', { ok: false, errorKind: 'auth_dead' }));
      expect(await stopCode(new ClaudeCodeBackend(dead.deps).run(params()))).toBe('needs_reconnect');
    });

    it('settled tool work that cannot be saved never hides the typed stop', async () => {
      const h = harness();
      h.setLedger([rec({ toolCallId: 'tc1', name: 'save_note' })]);
      h.deps.persistMessages = async () => {
        throw new Error('write failed');
      };
      h.setHost(async () => {
        throw new LoginHostError('EBUSY');
      });
      expect(await stopCode(new ClaudeCodeBackend(h.deps).run(params()))).toBe('host_busy');
    });

    it('strips the MCP server prefix from a tool name, and only that prefix', async () => {
      const h = harness();
      h.setHost(async (_req, opts) => {
        await opts.onEvent({ type: 'tool-use', operationId: 'a', name: 'mcp__emma__get__leads', input: {} } as ProviderEvent);
        await opts.onEvent({ type: 'tool-use', operationId: 'b', name: 'notmcp__x__y', input: {} } as ProviderEvent);
        return done('ok');
      });
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.calls).toContain('use:a:get__leads');
      expect(h.calls).toContain('use:b:notmcp__x__y');
    });

    it('waits 10 s for in-flight calls by default, and the configured time when set', async () => {
      const h = harness();
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.x.drainTimeoutMs).toBe(10_000);
      h.deps.drainTimeoutMs = 123;
      await new ClaudeCodeBackend(h.deps).run(params());
      expect(h.x.drainTimeoutMs).toBe(123);
    });

    it('hands the bridge, the executor and the context builder exactly the facts of this turn', async () => {
      const h = harness();
      await new ClaudeCodeBackend(h.deps).run(params({ isDelegatedAccess: true, excludeTools: ['x'], screenshotUrl: 'https://s/1.png', billingUserId: 'org-root' }));
      expect(h.x.openClaims).toEqual({ runId: 'claude-run-1', userId: 'u1', sessionId: 's1', connectionId: 'conn-1', epoch: 3 });
      expect(h.x.prepInput).toMatchObject({ userId: 'u1', sessionId: 's1', llmModel: LLM, isInteractiveShare: false, isUnattendedRun: false, isDelegatedAccess: true, screenshotUrl: 'https://s/1.png' });
      expect(h.x.execCtx).toMatchObject({
        llmModel: LLM,
        isDelegatedAccess: true,
        excludeTools: ['x'],
        screenshotUrl: 'https://s/1.png',
        // the tools' own paid / LLM calls: an explicit AgentWeb scope attributed to this run, never the plan's
        fundingScope: { route: 'agentweb', fallback: 'agentweb', ownerUserId: 'u1', billingUserId: 'org-root', runLabel: 'claude_plan:claude-run-1' },
      });
      h.x.execCtx.socketEmit('user:u1', 'crm-data-changed', {});
      expect(h.x.socketEmitted).toEqual([['user:u1', 'crm-data-changed']]);
    });

    describe('late results', () => {
      it('saves only the late calls that really ran', async () => {
        const h = harness();
        const backend = new ClaudeCodeBackend(h.deps);
        h.setHost(async () => (h.registry.cancel('s1'), cancelledResult));
        await backend.run(params());
        h.late.push(
          rec({ toolCallId: 'r1', name: 'a', late: true, kind: 'refused' }),
          rec({ toolCallId: 'n1', name: 'b', late: false }),
          rec({ toolCallId: 'ok1', name: 'c', late: true }),
          rec({ toolCallId: 'f1', name: 'd', late: true, kind: 'failed', isError: true }),
        );
        await backend.idle();
        expect(h.persisted).toHaveLength(1);
        const tools = h.persisted[0].filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
        expect(tools.sort()).toEqual(['f1', 'ok1']);
      });

      it('stops looking once every call that was still running has been shown', async () => {
        const h = harness();
        const backend = new ClaudeCodeBackend(h.deps);
        h.x.stillRunning = 1;
        h.late.push(rec({ toolCallId: 'ok1', name: 'c', late: true }));
        await backend.run(params());
        await backend.idle();
        expect(h.persisted).toHaveLength(1);
        expect(h.x.lateReads).toBe(1); // not the whole window
      });

      it('shutdown looks one last time and saves what finished, without waiting out the poll interval', async () => {
        const h = harness();
        h.deps.lateWatchPollMs = 60_000;
        h.deps.lateWatchMaxMs = 600_000;
        const backend = new ClaudeCodeBackend(h.deps);
        h.setHost(async () => (h.registry.cancel('s1'), cancelledResult));
        await backend.run(params());
        h.late.push(rec({ toolCallId: 'late1', name: 'live_hold', late: true }));
        const started = Date.now();
        await backend.flush();
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(h.persisted).toHaveLength(1);
      });
    });
  });
});
