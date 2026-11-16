/**
 * ENG-2113: a hostile worker's deeply nested JSON must be dropped BEFORE JSON.parse (8 MB of "[" stalls the API server's event loop for seconds).
 * The guard is unit-tested here; the client's use of it (stream lines, replies, error bodies) is tested against a real HTTP server below.
 */
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MAX_FORWARDED_DEPTH, MAX_FORWARDED_BYTES, boundedValue } from '../../../loginHost/relay/bounds';
import { MAX_JSON_DEPTH, jsonDepth, jsonTooDeep } from '../jsonDepthGuard';
import { LoginHostClient, UnixSocketTransport } from '../loginHostClient';

const nest = (n: number, open = '[', close = ']') => open.repeat(n) + close.repeat(n);

describe('jsonTooDeep', () => {
  it('the limit is 64: depth 64 passes, depth 65 does not (arrays, objects and mixes)', () => {
    expect(MAX_JSON_DEPTH).toBe(64);
    expect(jsonTooDeep(nest(64))).toBe(false);
    expect(jsonTooDeep(nest(65))).toBe(true);
    expect(jsonTooDeep('{"a":'.repeat(64) + '1' + '}'.repeat(64))).toBe(false);
    expect(jsonTooDeep('{"a":'.repeat(65) + '1' + '}'.repeat(65))).toBe(true);
    expect(jsonTooDeep('[{"a":'.repeat(33) + '1' + '}]'.repeat(33))).toBe(true); // 66
  });
  it('Buffer path: an escaped quote does not end a string, brackets inside strings never count', () => {
    expect(jsonTooDeep(Buffer.from('{"s":"a\\"' + '['.repeat(100) + '"}'))).toBe(false);
    expect(jsonTooDeep(Buffer.from(JSON.stringify({ s: '\\"' + '['.repeat(100) })))).toBe(false);
    expect(jsonTooDeep(Buffer.from('{"s":"a\\\\"' + ',"t":' + '['.repeat(70) + '}'))).toBe(true); // an escaped backslash does end at the next quote
  });
  it('depth is nesting, not count: many siblings are fine', () => {
    expect(jsonTooDeep('[' + '[1],'.repeat(100_000) + '[2]]')).toBe(false);
    expect(jsonTooDeep(JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ i, a: [1, 2, { b: [] }] }))))).toBe(false);
  });
  it('brackets inside strings never count, and an escaped quote does not end a string', () => {
    expect(jsonTooDeep(JSON.stringify({ s: '['.repeat(500) }))).toBe(false);
    expect(jsonTooDeep(JSON.stringify({ s: '\\"' + '['.repeat(500) + '"{{{' }))).toBe(false);
    expect(jsonTooDeep('{"s":"a\\\\"' + ',"t":' + '['.repeat(70) + '}')).toBe(true); // an escaped backslash DOES end at the quote: the nesting after it counts
    expect(jsonTooDeep(Buffer.from(JSON.stringify({ s: '['.repeat(500) })))).toBe(false);
  });
  it('works on a Buffer, and on UTF-8 text', () => {
    expect(jsonTooDeep(Buffer.from(nest(65)))).toBe(true);
    expect(jsonTooDeep(Buffer.from(nest(64)))).toBe(false);
    expect(jsonTooDeep(JSON.stringify({ 'é[': ['日本語[[[', { 'ü': [1] }] }))).toBe(false);
  });
  it('a 1M-deep and an 8M-deep line are rejected in well under 100 ms (no recursion, no parse)', () => {
    for (const n of [1_000_000, 8 * 1024 * 1024]) {
      const line = '['.repeat(n);
      const t0 = process.hrtime.bigint();
      expect(jsonTooDeep(line)).toBe(true);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      expect(ms).toBeLessThan(100);
    }
  });
  it('a long legitimate line is scanned in linear time', () => {
    const big = JSON.stringify({ a: 'x'.repeat(8 * 1024 * 1024 - 100) });
    const t0 = process.hrtime.bigint();
    expect(jsonTooDeep(big)).toBe(false);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(200);
  });
  it('jsonDepth reports the real nesting', () => {
    expect(jsonDepth('1')).toBe(0);
    expect(jsonDepth('{"a":[1,{"b":2}]}')).toBe(3);
    expect(jsonDepth(nest(10))).toBe(10);
  });
});

describe('the login host client drops deeply nested worker data unparsed', () => {
  let server: Server;
  let dir: string;
  let client: LoginHostClient;
  let routes: Record<string, (res: import('http').ServerResponse) => void>;

  beforeEach(async () => {
    routes = {};
    dir = mkdtempSync(join(tmpdir(), 'lh-depth-'));
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => (routes[req.url ?? ''] ?? ((r) => r.end('{}')))(res));
    });
    await new Promise<void>((r) => server.listen(join(dir, 'h.sock'), r));
    client = new LoginHostClient(new UnixSocketTransport(join(dir, 'h.sock'), { maxReplyBytes: 9 * 1024 * 1024 }));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const turnReq = { connectionId: 'c1', epoch: 1, idempotencyKey: 'k1', turnId: 't1', prompt: 'p', model: 'm', bridgeToken: 'x'.repeat(16) } as never;
  const accepted = JSON.stringify({ type: 'accepted', turnId: 't1', duplicate: false }) + '\n';

  it('a 1,000,000-deep tool event (it fits the tool line cap) is dropped without JSON.parse: the stream ends as BAD_RESPONSE too_deep, fast, logging the length only', async () => {
    const line = '{"type":"tool-use","operationId":"a","name":"n","input":' + '['.repeat(1_000_000);
    routes['/v1/turn.run'] = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(accepted);
      res.end(`${line}\n`);
    };
    const parse = jest.spyOn(JSON, 'parse');
    const t0 = Date.now();
    const stream = await client.turnRun(turnReq);
    const err: any = await (async () => { for await (const _e of stream.events) void _e; })().catch((e) => e);
    expect(err).toMatchObject({ name: 'LoginHostError', code: 'BAD_RESPONSE', detail: 'too_deep' });
    expect(err.ambiguous).toBe(true); // the caller treats it as "outcome unknown": conservative, a tool may have run
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(parse.mock.calls.every((c) => String(c[0]).length < 1_000)).toBe(true); // nothing near the deep line was ever parsed
    const logged = (console.error as jest.Mock).mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(logged).toContain('json_too_deep');
    expect(logged).not.toContain('[[[[');
  });

  it('an 8 MiB-deep line is cut by the line cap before it is even read to the end (the depth guard is the second wall)', async () => {
    routes['/v1/turn.run'] = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(accepted);
      res.end(`${'['.repeat(8 * 1024 * 1024 - 10)}\n`);
    };
    const parse = jest.spyOn(JSON, 'parse');
    const stream = await client.turnRun(turnReq);
    const err: any = await (async () => { for await (const _e of stream.events) void _e; })().catch((e) => e);
    expect(err).toMatchObject({ code: 'BAD_RESPONSE' });
    expect(['too_deep', 'line_too_long']).toContain(err.detail);
    expect(parse.mock.calls.every((c) => String(c[0]).length < 1_000)).toBe(true);
  });

  it('a legitimate event nested exactly at the limit still gets through', async () => {
    let input: unknown = 1;
    for (let i = 0; i < 60; i++) input = [input];
    const ev = JSON.stringify({ type: 'tool-call', operationId: 'op1', messageId: 'm1', name: 'search', input: { q: input } });
    routes['/v1/turn.run'] = (res) => {
      res.writeHead(200);
      res.write(accepted);
      res.end(`${ev}\n${JSON.stringify({ type: 'result', ok: true, text: 'x' })}\n`);
    };
    const stream = await client.turnRun(turnReq);
    const got: string[] = [];
    for await (const e of stream.events) got.push(e.type);
    expect(got).toEqual(['tool-call', 'result']);
  });

  it('the host\'s legitimate MAXIMUM events pass the guard: a tool-call input at the forwarded depth limit, a stream tool-use at the limit, and a truncation marker', async () => {
    const atLimit = (depth: number) => {
      let v: unknown = 1;
      for (let i = 0; i < depth; i++) v = { k: v };
      return v;
    };
    expect(jsonDepth(JSON.stringify(atLimit(MAX_FORWARDED_DEPTH)))).toBe(MAX_FORWARDED_DEPTH);
    const maxCall = { type: 'tool-call', operationId: 'op1', messageId: 'm1', name: 'search', input: atLimit(MAX_FORWARDED_DEPTH) };
    const maxUse = { type: 'tool-use', operationId: 'toolu_1', name: 'mcp__emma__search', input: boundedValue(atLimit(MAX_FORWARDED_DEPTH)) };
    const marker = { type: 'tool-use', operationId: 'toolu_2', name: 'mcp__emma__search', input: boundedValue(atLimit(MAX_FORWARDED_DEPTH + 1)) };
    const bigMarker = { type: 'tool-use', operationId: 'toolu_3', name: 'mcp__emma__search', input: boundedValue({ s: 'x'.repeat(MAX_FORWARDED_BYTES + 10) }) };
    expect(marker.input).toEqual({ _truncated: 'depth' });
    expect(bigMarker.input).toEqual({ _truncated: 'size' });
    for (const ev of [maxCall, maxUse, marker, bigMarker]) {
      expect(jsonDepth(JSON.stringify(ev))).toBeLessThanOrEqual(MAX_FORWARDED_DEPTH + 2); // the event envelope adds a level or two
      expect(jsonTooDeep(JSON.stringify(ev))).toBe(false);
    }
    expect(MAX_JSON_DEPTH).toBeGreaterThan(MAX_FORWARDED_DEPTH + 2); // headroom between the host\'s limit and ours
    routes['/v1/turn.run'] = (res) => {
      res.writeHead(200);
      res.write(accepted);
      res.end([maxCall, maxUse, marker, bigMarker, { type: 'result', ok: true, text: 'x' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    };
    const stream = await client.turnRun(turnReq);
    const got: string[] = [];
    for await (const e of stream.events) got.push(`${e.type}`);
    expect(got).toEqual(['tool-call', 'tool-use', 'tool-use', 'tool-use', 'result']);
  });

  it('a deep reply to an ordinary call (within the 64 KiB reply cap) is a bad answer, not parsed', async () => {
    routes['/v1/connection.status'] = (res) => {
      res.writeHead(200);
      res.end('{"state":' + '['.repeat(60_000));
    };
    const parse = jest.spyOn(JSON, 'parse');
    const t0 = Date.now();
    await expect(client.connectionStatus({ connectionId: 'c1' })).rejects.toMatchObject({ code: 'BAD_RESPONSE', detail: 'too_deep' });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(parse.mock.calls.every((c) => String(c[0]).length < 1_000)).toBe(true);
  });

  it('a 2,000,000-deep reply to an ordinary call is cut by the reply cap first (the depth guard is the second wall)', async () => {
    routes['/v1/connection.status'] = (res) => {
      res.writeHead(200);
      res.end('{"state":' + '['.repeat(2_000_000));
    };
    const parse = jest.spyOn(JSON, 'parse');
    await expect(client.connectionStatus({ connectionId: 'c1' })).rejects.toMatchObject({ code: 'BAD_RESPONSE', detail: 'too_large' });
    expect(parse.mock.calls.every((c) => String(c[0]).length < 1_000)).toBe(true);
  });

  it('a deep error body on a refused turn.run is not parsed: BAD_RESPONSE', async () => {
    routes['/v1/turn.run'] = (res) => {
      res.writeHead(500);
      res.end('['.repeat(2_000_000));
    };
    const parse = jest.spyOn(JSON, 'parse');
    await expect(client.turnRun(turnReq)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    expect(parse.mock.calls.every((c) => String(c[0]).length < 1_000)).toBe(true);
  });
});
