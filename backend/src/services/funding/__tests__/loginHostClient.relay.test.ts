/**
 * ENG-2113 tool relay: the backend's client against the REAL host (ConnectionManager + HTTP server + the scripted relay-capable provider) over a unix socket.
 * Protects the wire usage: `tools` instead of `bridgeToken`, the `tool-call` event, the new turn.toolResult body and the three "result lost" answers.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProviderEvent } from '../../../loginHost/adapter';
import { startHostServer, type HostServerHandle } from '../../../loginHost/server';
import { makeRig, turnReq, type Rig } from '../../../loginHost/__tests__/helpers';
import { TOOL_LIMITS } from '../../../loginHost/protocol';
import { LoginHostClient, LoginHostError, ToolResultLostError, UnixSocketTransport, type HostTransport } from '../loginHostClient';

const TOOLS = [
  { name: 'search', description: 'Search', inputSchema: { type: 'object', properties: {} } },
];
const LATE = { name: 'late_tool', description: 'after install', inputSchema: { type: 'object', properties: {} } };
const callEvent = (op: string): ProviderEvent => ({ type: 'tool-call', operationId: op, messageId: 'm1', name: 'search', input: { q: 'x' } });

describe('login host client: the tool relay wire', () => {
  let rig: Rig;
  let dir: string;
  let handle: HostServerHandle;
  let client: LoginHostClient;
  let gate: () => void;

  beforeEach(async () => {
    rig = makeRig({ adapter: { relay: true } });
    dir = mkdtempSync(join(tmpdir(), 'lh-relay-'));
    handle = await startHostServer(rig.mgr, { socketPath: join(dir, 'host.sock'), socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 });
    client = new LoginHostClient(new UnixSocketTransport(join(dir, 'host.sock')));
    const start = await client.loginStart({ connectionId: 'c1', provider: 'fake' });
    await client.loginComplete({ connectionId: 'c1', loginRef: start.loginRef, code: 'abcdefgh#12345678' });
    await client.loginPromote({ connectionId: 'c1', loginRef: start.loginRef, epoch: 1 });
    const held = new Promise<void>((r) => (gate = r));
    rig.script.turnEvents = [callEvent('op1'), { wait: held }, { type: 'result', ok: true, text: 'done' }];
  });
  afterEach(async () => {
    gate?.();
    await handle?.close();
    rig?.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  const relayReq = (extra: Record<string, unknown> = {}) => {
    const { bridgeToken: _drop, ...rest } = turnReq('c1', 1, { turnId: 'tr1' });
    return { ...rest, tools: TOOLS, ...extra };
  };
  const ids = { connectionId: 'c1', turnId: 'tr1', epoch: 1 };

  async function firstCall(req = relayReq()) {
    const stream = await client.turnRun(req as never);
    const it = stream.events[Symbol.asyncIterator]();
    const first = await it.next();
    return { stream, it, first };
  }

  it('sends `tools` and no bridge token; the `tool-call` event is delivered (it used to be dropped as an unknown type)', async () => {
    const { stream, first } = await firstCall();
    expect(first.value).toEqual(callEvent('op1'));
    expect(rig.script.turnInputs[0].bridgeToken).toBeUndefined();
    expect(rig.script.turnInputs[0].relay?.tools).toEqual(TOOLS);
    stream.close();
  });

  it('the legacy request shape (bridgeToken only) is still sent unchanged', async () => {
    rig.script.turnEvents = [{ type: 'result', ok: true, text: 'x' }];
    const stream = await client.turnRun(turnReq('c1', 1, { turnId: 'tr9' }) as never);
    for await (const _e of stream.events) void _e;
    expect(rig.script.turnInputs[0].bridgeToken).toBe('bridge-token-0123456789');
    expect(rig.script.turnInputs[0].relay).toBeUndefined();
  });

  it('refuses both transports, or neither, before any round trip', async () => {
    await expect(client.turnRun(relayReq({ bridgeToken: 'bridge-token-0123456789' }) as never)).rejects.toThrow();
    const { tools: _t, ...none } = relayReq();
    await expect(client.turnRun(none as never)).rejects.toThrow();
    expect(rig.script.turnInputs).toHaveLength(0);
  });

  it('turnToolResult carries content, isError, images and new tool definitions to the provider and resolves {ok:true}', async () => {
    const { stream, it } = await firstCall();
    const images = [{ mimeType: 'image/png' as const, data: 'AAAAAAAA' }];
    expect(await client.turnToolResult({ ...ids, operationId: 'op1', content: 'found it', isError: true, images, tools: [LATE] })).toEqual({ ok: true });
    expect(rig.script.answers).toEqual([{ operationId: 'op1', answer: { kind: 'tool-result', ok: false, content: 'found it', images, tools: [LATE] } }]);
    gate();
    expect((await it.next()).value).toMatchObject({ type: 'result', ok: true });
    stream.close();
  });

  it('an operation the host does not know is ToolResultLostError(operation_unknown) and NOT a LoginHostError ENOTFOUND (which would read as "no such connection")', async () => {
    const { stream } = await firstCall();
    const err = await client.turnToolResult({ ...ids, operationId: 'never-issued', content: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolResultLostError);
    expect(err).not.toBeInstanceOf(LoginHostError);
    expect(err.reason).toBe('operation_unknown');
    // a turn that does not exist at all gives the same answer: never a bare ENOTFOUND
    const gone = await client.turnToolResult({ ...ids, turnId: 'no-such-turn', operationId: 'op1', content: 'x' }).catch((e) => e);
    expect(gone).toBeInstanceOf(ToolResultLostError);
    stream.close();
  });

  it('an operation answered twice: the second is operation_unknown', async () => {
    const { stream } = await firstCall();
    await client.turnToolResult({ ...ids, operationId: 'op1', content: 'x' });
    await expect(client.turnToolResult({ ...ids, operationId: 'op1', content: 'x' })).rejects.toMatchObject({ name: 'ToolResultLostError', reason: 'operation_unknown' });
    stream.close();
  });

  it('a turn the host ended is a ToolResultLostError (the host says ESTALE turn_aborted, or operation_unknown once it has cleaned the turn up)', async () => {
    const { stream } = await firstCall();
    await client.turnInterrupt(ids);
    const err = await client.turnToolResult({ ...ids, operationId: 'op1', content: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolResultLostError);
    expect(['turn_aborted', 'operation_unknown']).toContain(err.reason);
    stream.close();
  });

  it.each([
    [409, 'ESTALE', 'turn_aborted', 'turn_aborted'],
    [409, 'ESTALE', 'result_lost', 'result_lost'],
    [409, 'ESTALE', 'something_new', 'turn_aborted'],
    [404, 'ENOTFOUND', 'operation_unknown', 'operation_unknown'],
    [404, 'ENOTFOUND', undefined, 'operation_unknown'],
  ])('HTTP %s %s/%s from turn.toolResult is a ToolResultLostError(%s)', async (status, error, detail, reason) => {
    const transport: HostTransport = { json: async () => ({ status, json: { error, ...(detail ? { detail } : {}) } }), stream: async () => { throw new Error('n/a'); } };
    const err = await new LoginHostClient(transport).turnToolResult({ ...ids, operationId: 'op1', content: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolResultLostError);
    expect(err.reason).toBe(reason);
  });

  it('other host errors on turn.toolResult stay LoginHostErrors (EBUSY, EINTERNAL, a garbled body)', async () => {
    for (const body of [{ error: 'EBUSY' }, { error: 'EINTERNAL' }, { nonsense: true }]) {
      const transport: HostTransport = { json: async () => ({ status: 500, json: body }), stream: async () => { throw new Error('n/a'); } };
      await expect(new LoginHostClient(transport).turnToolResult({ ...ids, operationId: 'op1', content: 'x' })).rejects.toBeInstanceOf(LoginHostError);
    }
  });

  it("an operation the provider's own timer already ended is ToolResultLostError(result_lost)", async () => {
    rig.script.staleOperations.add('op1');
    const { stream } = await firstCall();
    await expect(client.turnToolResult({ ...ids, operationId: 'op1', content: 'x' })).rejects.toMatchObject({ name: 'ToolResultLostError', reason: 'result_lost' });
    stream.close();
  });

  it('definitions the host refuses are EINVALID tools_invalid / tools_limit and leave the operation pending, so the answer can be re-sent without them', async () => {
    const { stream } = await firstCall();
    const dup = await client.turnToolResult({ ...ids, operationId: 'op1', content: 'x', tools: [{ ...LATE, name: 'SEARCH' }] }).catch((e) => e); // differs from a sent name only in case
    expect(dup).toBeInstanceOf(LoginHostError);
    expect(dup).toMatchObject({ code: 'EINVALID', detail: 'tools_invalid' });
    const many = Array.from({ length: TOOL_LIMITS.maxTools }, (_, i) => ({ ...LATE, name: `t_${i}` }));
    const over = await client.turnToolResult({ ...ids, operationId: 'op1', content: 'x', tools: many }).catch((e) => e);
    expect(over).toMatchObject({ code: 'EINVALID', detail: 'tools_limit' });
    expect(await client.turnToolResult({ ...ids, operationId: 'op1', content: 'x' })).toEqual({ ok: true });
    stream.close();
  });

  it('a name already sent is a no-op: the same definition twice is accepted', async () => {
    const { stream, it } = await firstCall();
    expect(await client.turnToolResult({ ...ids, operationId: 'op1', content: 'x', tools: [LATE, LATE] })).toEqual({ ok: true });
    gate();
    await it.next();
    stream.close();
  });

  it('the turn.run manifest has no `locked` and a leftover `locked` is refused', async () => {
    await expect(client.turnRun({ ...(relayReq() as object), tools: [{ ...TOOLS[0], locked: true }] } as never)).rejects.toThrow();
  });

  it('our own schema refuses an oversized image set before a round trip', async () => {
    await expect(client.turnToolResult({ ...ids, operationId: 'op1', content: 'x', images: Array.from({ length: 5 }, () => ({ mimeType: 'image/png' as const, data: 'AAAAAAAA' })) })).rejects.toThrow();
  });

  it('a `tool-call` with a malformed envelope is a bad answer from the host, never something to execute', async () => {
    const lines = [{ type: 'accepted', turnId: 't', duplicate: false }, { type: 'tool-call', operationId: 'has space', messageId: 'm', name: 'search', input: {} }];
    const transport: HostTransport = {
      json: async () => ({ status: 200, json: {} }),
      stream: async () => ({ lines: (async function* () { yield* lines; })(), close: () => undefined }),
    };
    const stream = await new LoginHostClient(transport).turnRun(relayReq() as never);
    await expect((async () => { for await (const _e of stream.events) void _e; })()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('a bare ENOTFOUND from some OTHER route is still a LoginHostError (only turn.toolResult is reclassified)', async () => {
    await expect(client.connectionStatus({ connectionId: 'nope' })).rejects.toBeInstanceOf(LoginHostError);
  });
});
