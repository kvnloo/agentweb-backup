/**
 * ENG-2113 (independent security review F1), end to end through the real transport: 64 MiB of newlines after `accepted` used to run 28-30 s (25 s of event-loop lag);
 * now the stream fails at the empty-line limit at once.
 */
import { createServer, type Server, type ServerResponse } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LoginHostClient, MAX_STREAM_BYTES, UnixSocketTransport } from '../loginHostClient';

const accepted = JSON.stringify({ type: 'accepted', turnId: 't1', duplicate: false }) + '\n';
const turnReq = { connectionId: 'c1', epoch: 1, idempotencyKey: 'k1', turnId: 't1', prompt: 'p', model: 'm', bridgeToken: 'x'.repeat(16) } as never;

describe('turn stream: an empty-line flood', () => {
  let server: Server;
  let dir: string;
  let client: LoginHostClient;
  let handler: (res: ServerResponse) => void;
  beforeEach(async () => {
    handler = (res) => res.end();
    dir = mkdtempSync(join(tmpdir(), 'lh-empty-'));
    server = createServer((req, res) => {
      req.resume();
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

  it('64 MiB of newlines ends with too_many_empty_lines in well under a second, with no event-loop stall', async () => {
    const chunk = Buffer.alloc(64 * 1024, 10);
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(accepted);
      let sent = 0;
      const pump = () => {
        while (sent < MAX_STREAM_BYTES + 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      pump();
    };
    let maxLag = 0;
    let last = Date.now();
    const lag = setInterval(() => {
      const now = Date.now();
      maxLag = Math.max(maxLag, now - last - 10);
      last = now;
    }, 10);
    const t0 = Date.now();
    let error: any;
    try {
      const stream = await client.turnRun(turnReq);
      for await (const _ of stream.events) void _;
    } catch (e) {
      error = e;
    }
    clearInterval(lag);
    const took = Date.now() - t0;
    expect(error).toMatchObject({ code: 'BAD_RESPONSE', detail: 'too_many_empty_lines' });
    expect(took).toBeLessThan(3_000);
    expect(maxLag).toBeLessThan(250);
  }, 60_000);

  it('a stream with a few blank lines between honest events still completes', async () => {
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(accepted + '\n\n');
      res.end(JSON.stringify({ type: 'text', delta: 'hi' }) + '\n\n' + JSON.stringify({ type: 'result', ok: true, text: 'done' }) + '\n');
    };
    const stream = await client.turnRun(turnReq);
    const types: string[] = [];
    for await (const ev of stream.events) types.push((ev as { type: string }).type);
    expect(types).toEqual(['text', 'result']);
  });
});
