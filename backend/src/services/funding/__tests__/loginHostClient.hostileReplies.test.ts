/**
 * ENG-2113 (independent security review F2): a hostile worker could answer any non-stream route (turn.renew every lease, host.info every minute) with a wide 8 MiB JSON
 * body: 0.5-0.7 s of JSON.parse and ~180 MB of heap in the main API process each time (a turn with a 1 s lease measured max lag 845-891 ms, 2.9-3.2 s in all over 6.5 s).
 * Ordinary JSON replies and error bodies are now capped at JSON_REPLY_BYTES (64 KiB); every honest reply is a few hundred bytes.
 */
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { JSON_REPLY_BYTES, LoginHostClient, LoginHostError, UnixSocketTransport } from '../loginHostClient';
import { runHostTurn } from '../loginHostTurn';

const accepted = JSON.stringify({ type: 'accepted', turnId: 't1', duplicate: false }) + '\n';
const turnReq = { connectionId: 'c1', epoch: 1, idempotencyKey: 'k1', turnId: 't1', prompt: 'p', model: 'm', bridgeToken: 'x'.repeat(16) } as never;

describe('hostile JSON replies on non-stream routes', () => {
  let server: Server;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lh-replies-'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
    server = undefined as never;
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });
  const serve = async (handler: (url: string, res: import('http').ServerResponse) => void) => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => handler(req.url ?? '', res));
    });
    await new Promise<void>((r) => server.listen(join(dir, 'h.sock'), r));
    return new LoginHostClient(new UnixSocketTransport(join(dir, 'h.sock')));
  };
  const info = (pad: number) => JSON.stringify({ protocol: 4, node: 'v22', uptimeSec: 1, pad: 'x'.repeat(pad) });

  it('the cap is 64 KiB', () => {
    expect(JSON_REPLY_BYTES).toBe(64 * 1024);
  });

  it('every turn.renew answered with a 7.9 MiB wide JSON body: refused unread, no event-loop stall; two failed renews in a row end the turn as an unknown outcome (the lease cannot be kept)', async () => {
    const hostile = Buffer.from('{"leaseMs":1,"p":[' + '{},'.repeat(2_600_000) + '{}]}');
    let renews = 0;
    const client = await serve((url, res) => {
      if (url === '/v1/turn.run') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(accepted);
        setTimeout(() => res.end(JSON.stringify({ type: 'result', ok: true, text: 'done' }) + '\n'), 3500);
      } else if (url === '/v1/turn.renew') {
        renews++;
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': hostile.length });
        res.end(hostile);
      } else {
        res.writeHead(200);
        res.end('{"interrupted":true}');
      }
    });
    let maxLag = 0;
    let last = Date.now();
    const lag = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    const out = await runHostTurn(client, turnReq, { renewEveryMs: 1000 });
    clearInterval(lag);
    expect(renews).toBeGreaterThanOrEqual(2);
    expect(out.kind).toBe('unknown_outcome'); // before the cap the worker could parse-bomb the API and the turn went on
    expect(maxLag).toBeLessThan(250); // it was 845-891 ms
  }, 30_000);

  it('host.info answered with 8 MiB is refused as too_large without being parsed', async () => {
    const client = await serve((_u, res) => {
      const body = Buffer.from('[' + '{},'.repeat(2_600_000) + '{}]');
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length });
      res.end(body);
    });
    const t0 = process.hrtime.bigint();
    await expect(client.hostInfo()).rejects.toMatchObject({ code: 'BAD_RESPONSE', detail: 'too_large' });
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(250);
  });

  it('an honest reply with room to spare (60 KiB) still parses; just over 64 KiB is refused', async () => {
    let size = 60 * 1024;
    const client = await serve((_u, res) => {
      const body = info(size);
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    await expect(client.hostInfo()).resolves.toMatchObject({ protocol: 4 });
    size = 65 * 1024;
    await expect(client.hostInfo()).rejects.toBeInstanceOf(LoginHostError);
  });

  it('an error body on the turn stream route over 64 KiB is dropped unread: its code is NOT trusted, the call fails as a plain host error, fast', async () => {
    const client = await serve((_u, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end('{"error":"EBUSY","detail":"turn_running","pad":[' + '{},'.repeat(1_000_000) + '{}]}');
    });
    const t0 = process.hrtime.bigint();
    const err: any = await client.turnRun(turnReq).catch((e) => e);
    expect(err).toBeInstanceOf(LoginHostError);
    expect(err.code).not.toBe('EBUSY'); // a body over the cap is never parsed, so what it says is never believed
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(400);
  });

  it('a normal error body (code and detail) still maps to the typed host error', async () => {
    const client = await serve((_u, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'EBUSY', detail: 'turn_running' }));
    });
    await expect(client.turnRun(turnReq)).rejects.toMatchObject({ code: 'EBUSY', detail: 'turn_running' });
  });
});
