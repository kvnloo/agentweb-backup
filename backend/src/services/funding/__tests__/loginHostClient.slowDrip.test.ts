/**
 * ENG-2113 (independent security review, finding 2): `req.setTimeout` is an IDLE timer. A reply dripped one byte every 100 ms (a 64 KiB reply can last weeks that way)
 * never tripped it, and whatever waited for the reply (a tool-call answer and the parsed input it pinned) waited with it. The request now has an ABSOLUTE limit, and the
 * answer posts can be aborted with the turn.
 */
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LoginHostClient, LoginHostError, UnixSocketTransport } from '../loginHostClient';

const turnReq = { connectionId: 'c1', epoch: 1, idempotencyKey: 'k1', turnId: 't1', prompt: 'p', model: 'm', bridgeToken: 'x'.repeat(16) } as never;
const answer = { connectionId: 'c1', turnId: 't1', epoch: 1, operationId: 'op1', content: 'x' } as never;

describe('a worker that drips its reply cannot hold a request', () => {
  let server: Server;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lh-drip-'));
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
  const serve = async (handler: (url: string, res: import('http').ServerResponse) => void, opts: ConstructorParameters<typeof UnixSocketTransport>[1] = {}) => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => handler(req.url ?? '', res));
    });
    await new Promise<void>((r) => server.listen(join(dir, 'h.sock'), r));
    return new LoginHostClient(new UnixSocketTransport(join(dir, 'h.sock'), opts));
  };
  const drip = (res: import('http').ServerResponse, first: string) => {
    let n = 0;
    const iv = setInterval(() => {
      if (res.destroyed) return clearInterval(iv);
      res.write(n++ === 0 ? first : ' ');
    }, 100);
    res.on('close', () => clearInterval(iv));
  };

  it('a JSON reply dripped 1 byte / 100 ms ends at the ABSOLUTE request timeout (it was still pending after 4 s with requestTimeoutMs 400)', async () => {
    const client = await serve((_u, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      drip(res, '{');
    }, { requestTimeoutMs: 400 });
    const t0 = Date.now();
    const err: any = await client.turnRenew({ connectionId: 'c1', turnId: 't1', epoch: 1 } as never).catch((e) => e);
    const took = Date.now() - t0;
    expect(err).toBeInstanceOf(LoginHostError);
    expect(took).toBeGreaterThanOrEqual(350);
    expect(took).toBeLessThan(1_500);
  });

  it('an error body on the turn stream route that is dripped is cut at the same limit', async () => {
    const client = await serve((_u, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      drip(res, '{');
    }, { requestTimeoutMs: 400 });
    const t0 = Date.now();
    const err: any = await client.turnRun(turnReq).catch((e) => e);
    expect(err).toBeInstanceOf(LoginHostError);
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it('a reply that arrives in time is unaffected by the absolute timer', async () => {
    const client = await serve((_u, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      setTimeout(() => res.end(JSON.stringify({ protocol: 4, node: 'v22', uptimeSec: 1 })), 150);
    }, { requestTimeoutMs: 1_000 });
    await expect(client.hostInfo()).resolves.toMatchObject({ protocol: 4 });
  });

  it('an answer post can be aborted from outside: it rejects at once and the worker sees the connection close', async () => {
    let closed = false;
    const client = await serve((_u, res) => {
      res.on('close', () => void (closed = true));
      res.writeHead(200, { 'content-type': 'application/json' }); // and then never finishes
    }, { requestTimeoutMs: 30_000 });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = client.turnToolResult(answer, { signal: ac.signal }).catch((e) => e);
    setTimeout(() => ac.abort(), 100);
    const err: any = await p;
    expect(err).toBeInstanceOf(LoginHostError);
    expect(Date.now() - t0).toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(true);
  });

  it('an already-aborted signal never sends the request', async () => {
    let requests = 0;
    const client = await serve(() => void requests++);
    const ac = new AbortController();
    ac.abort();
    await expect(client.turnToolResult(answer, { signal: ac.signal })).rejects.toBeInstanceOf(LoginHostError);
    expect(requests).toBe(0);
  });
});
