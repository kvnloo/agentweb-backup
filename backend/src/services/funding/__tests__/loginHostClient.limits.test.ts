/**
 * ENG-2113 (security): what a hostile worker can cost the API server through the turn stream, against a real HTTP server.
 * Measured before the limits (the reviewer's shapes): an `entitlement` line of 8 MiB = about 5 s of event-loop stall PER EVENT (250 ms JSON.parse + 1.4 s zod, repeatable);
 * 640k tiny events = 100% CPU for 7.8 s; a first line that never arrives = a turn nobody can stop.
 */
import { createServer, type Server, type ServerResponse } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LINE_CAPS, LoginHostClient, MAX_STREAM_BYTES, MAX_STREAM_LINES, UnixSocketTransport } from '../loginHostClient';
import { runHostTurn } from '../loginHostTurn';

const accepted = JSON.stringify({ type: 'accepted', turnId: 't1', duplicate: false }) + '\n';
const turnReq = { connectionId: 'c1', epoch: 1, idempotencyKey: 'k1', turnId: 't1', prompt: 'p', model: 'm', bridgeToken: 'x'.repeat(16) } as never;
const ev = (o: unknown) => JSON.stringify(o) + '\n';

describe('the turn stream is bounded before anything is parsed', () => {
  let server: Server;
  let dir: string;
  let client: LoginHostClient;
  let handler: (res: ServerResponse) => void;
  let closedByClient: boolean;

  beforeEach(async () => {
    closedByClient = false;
    handler = (res) => res.end();
    dir = mkdtempSync(join(tmpdir(), 'lh-limits-'));
    server = createServer((req, res) => {
      req.resume();
      res.on('close', () => void (closedByClient = true));
      req.on('end', () => handler(res));
    });
    await new Promise<void>((r) => server.listen(join(dir, 'h.sock'), r));
    client = new LoginHostClient(new UnixSocketTransport(join(dir, 'h.sock'), { maxReplyBytes: 9 * 1024 * 1024 }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const serve = (body: string | Buffer) => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(accepted);
      res.end(body);
    };
  };
  const drain = async (): Promise<{ events: string[]; error?: any; ms: number; maxLag: number }> => {
    let maxLag = 0;
    let last = Date.now();
    const lag = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    const t0 = Date.now();
    const events: string[] = [];
    let error: unknown;
    try {
      const stream = await client.turnRun(turnReq);
      for await (const e of stream.events) events.push(e.type);
    } catch (e) {
      error = e;
    }
    clearInterval(lag);
    return { events, error, ms: Date.now() - t0, maxLag };
  };

  it('an `entitlement` line near 8 MiB (700k small objects) is cut at its type cap: no parse, no zod, no stall', async () => {
    serve('{"type":"entitlement","observation":{"windows":[' + '{"name":"a"},'.repeat(600_000) + '{"name":"a"}]}}\n');
    const parse = jest.spyOn(JSON, 'parse');
    const r = await drain();
    expect(r.error).toMatchObject({ code: 'BAD_RESPONSE', detail: 'line_too_long' });
    expect(r.ms).toBeLessThan(1_500);
    expect(r.maxLag).toBeLessThan(250);
    expect(parse.mock.calls.every((c) => String(c[0]).length < 1_000)).toBe(true);
  });

  it('a wide event of an UNKNOWN type (it would be dropped after parsing) is cut at the small cap too', async () => {
    serve('{"type":"zzz","a":[' + '1,'.repeat(2_500_000) + '1]}\n');
    const r = await drain();
    expect(r.error).toMatchObject({ detail: 'line_too_long' });
    expect(r.maxLag).toBeLessThan(250);
  });

  it('a line whose type does not come first is held to the small cap', async () => {
    serve('{"a":"' + 'x'.repeat(LINE_CAPS.other) + '","type":"text","delta":"x"}\n');
    expect((await drain()).error).toMatchObject({ detail: 'line_too_long' });
  });

  it('a flood of tiny events ends the stream at the per-turn event count', async () => {
    serve(ev({ type: 'tool-result', operationId: 'a', ok: true }).repeat(MAX_STREAM_LINES + 100));
    const r = await drain();
    expect(r.error).toMatchObject({ code: 'BAD_RESPONSE', detail: 'too_many_events' });
    expect(r.events.length).toBeLessThanOrEqual(MAX_STREAM_LINES);
    expect(r.ms).toBeLessThan(5_000);
  });

  it('the stream also ends at the per-turn byte total', async () => {
    const big = ev({ type: 'text', delta: 'y'.repeat(4 * 1024 * 1024) });
    serve(big.repeat(Math.ceil(MAX_STREAM_BYTES / big.length) + 1));
    expect((await drain()).error).toMatchObject({ detail: 'too_many_bytes' });
  }, 30_000);

  it('legitimate maxima pass: a 5 MiB text event, a 1.2 MiB tool call, 8 entitlement windows, a result', async () => {
    const windows = Array.from({ length: 8 }, (_, i) => ({ name: `w${i}`, utilization: 0.5, resetsAtMs: 1 }));
    serve(
      ev({ type: 'text', delta: 'z'.repeat(5 * 1024 * 1024) }) +
        ev({ type: 'tool-call', operationId: 'op1', messageId: 'm', name: 'search', input: { q: 'q'.repeat(1_200 * 1024) } }) +
        ev({ type: 'entitlement', observation: { windows } }) +
        ev({ type: 'result', ok: true, text: 'done' }),
    );
    const r = await drain();
    expect(r.error).toBeUndefined();
    expect(r.events).toEqual(['text', 'tool-call', 'entitlement', 'result']);
  });

  it.each([
    ['9 entitlement windows', { type: 'entitlement', observation: { windows: Array.from({ length: 9 }, () => ({ name: 'a' })) } }],
    ['an entitlement window name over 64 characters', { type: 'entitlement', observation: { windows: [{ name: 'n'.repeat(65) }] } }],
    ['a tool-use name of 257 characters', { type: 'tool-use', operationId: 'a', name: 'n'.repeat(257), input: {} }],
    ['a tool-use id of 257 characters', { type: 'tool-use', operationId: 'o'.repeat(257), name: 'n', input: {} }],
    ['a tool-result id of 257 characters', { type: 'tool-result', operationId: 'o'.repeat(257), ok: true }],
    ['a tool-call name of 201 characters', { type: 'tool-call', operationId: 'op1', messageId: 'm', name: 'n'.repeat(201), input: {} }],
    ['an errorKind over 64 characters', { type: 'result', ok: false, text: '', errorKind: 'e'.repeat(65) }],
    ['an aborted reason over 64 characters', { type: 'result', ok: false, text: '', aborted: 'a'.repeat(65) }],
  ])('an event with %s is a bad answer', async (_l, event) => {
    serve(ev(event));
    expect((await drain()).error).toMatchObject({ code: 'BAD_RESPONSE', detail: 'event' });
  });

  it.each([
    ['a tool-use name of exactly 256 characters', { type: 'tool-use', operationId: 'a', name: 'n'.repeat(256), input: {} }],
    ['a tool-call name of exactly 200 characters', { type: 'tool-call', operationId: 'op1', messageId: 'm', name: 'n'.repeat(200), input: {} }],
    ['an errorKind of exactly 64 characters', { type: 'result', ok: false, text: '', errorKind: 'e'.repeat(64) }],
  ])('%s passes', async (_l, event) => {
    serve(ev(event));
    expect((await drain()).error).toBeUndefined();
  });

  describe('the first line (accepted) can neither hang the turn nor the Stop', () => {
    beforeEach(() => {
      handler = (res) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.flushHeaders(); // headers on the wire, then silence
      };
    });

    it('a worker that sends headers and then nothing: the first read times out, the stream is closed', async () => {
      const t0 = Date.now();
      await expect(client.turnRun(turnReq, { startTimeoutMs: 200 })).rejects.toMatchObject({ code: 'TIMEOUT', detail: 'start' });
      expect(Date.now() - t0).toBeLessThan(1_500);
      await new Promise((r) => setTimeout(r, 100));
      expect(closedByClient).toBe(true);
    });

    it('a Stop while waiting for it ends the wait at once and closes the stream', async () => {
      const ac = new AbortController();
      const p = client.turnRun(turnReq, { signal: ac.signal, startTimeoutMs: 30_000 });
      setTimeout(() => ac.abort(), 100);
      const t0 = Date.now();
      await expect(p).rejects.toMatchObject({ code: 'EBUSY', detail: 'aborted_while_waiting' });
      expect(Date.now() - t0).toBeLessThan(1_000);
      await new Promise((r) => setTimeout(r, 100));
      expect(closedByClient).toBe(true);
    });

    it('a Stop while the worker has not even sent headers ends the wait at once', async () => {
      handler = () => undefined; // never answers
      const ac = new AbortController();
      const p = client.turnRun(turnReq, { signal: ac.signal });
      setTimeout(() => ac.abort(), 100);
      const t0 = Date.now();
      await expect(p).rejects.toMatchObject({ detail: 'aborted_while_waiting' });
      expect(Date.now() - t0).toBeLessThan(1_000);
    });

    it('an already-aborted signal never touches the worker', async () => {
      const ac = new AbortController();
      ac.abort();
      const stream = jest.spyOn(UnixSocketTransport.prototype, 'stream');
      await expect(client.turnRun(turnReq, { signal: ac.signal })).rejects.toMatchObject({ detail: 'aborted_while_waiting' });
      expect(stream).not.toHaveBeenCalled();
    });

    it('runHostTurn: a Stop frees the turn while the worker is silent (the session does not stay busy)', async () => {
      const ac = new AbortController();
      const run = runHostTurn(client, turnReq, { signal: ac.signal, busyWaitMs: 60_000 });
      setTimeout(() => ac.abort(), 150);
      const t0 = Date.now();
      await expect(run).rejects.toMatchObject({ detail: 'aborted_while_waiting' });
      expect(Date.now() - t0).toBeLessThan(2_000);
    });
  });
});
