/**
 * ENG-2113 (independent security review, finding 2): 16 tool-call events with 1.5 MB parsed inputs, fed to the real dispatcher with a worker that never finishes the
 * `turn.toolResult` reply, kept ~500 MB of heap alive after `settle()` returned: `run(op, ev)` held the parsed input until the post completed, and the post (an idle
 * timeout only, no abort) could last for weeks. The dispatcher now drops the input as soon as `decide` has used it and aborts the posts when the turn ends.
 */
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as v8 from 'v8';
import * as vm from 'vm';
import { LoginHostClient, UnixSocketTransport } from '../loginHostClient';
import { RelayToolDispatcher } from '../relayToolDispatcher';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const MB = (n: number) => Math.round(n / 1048576);
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a hung answer post does not pin the call it answers', () => {
  let server: Server;
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lh-pin-'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    // a worker that accepts every answer post and never finishes the reply
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const iv = setInterval(() => (res.destroyed ? clearInterval(iv) : res.write(' ')), 200);
        res.on('close', () => clearInterval(iv));
      });
    });
    await new Promise<void>((r) => server.listen(join(dir, 'h.sock'), r));
  });
  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function rig() {
    const client = new LoginHostClient(new UnixSocketTransport(join(dir, 'h.sock'), { requestTimeoutMs: 60_000 }));
    const bridge = { callTool: async () => ({ content: 'x', isError: false }), listTools: async () => [{ name: 'save_note' }], noteToolUse: () => undefined, takeLedger: () => ({ records: [], truncated: 0 }) };
    const d = new RelayToolDispatcher({
      client: client as never,
      ids: { connectionId: 'c', turnId: 't', epoch: 1 },
      runId: 'r',
      token: 'tok',
      bridge: bridge as never,
      manifest: { open: new Set(['save_note']) },
      isStopped: () => false,
      isHalted: () => false,
      isHaltingCall: () => false,
      announceWaitMs: 0,
    });
    return d;
  }
  const unit = '[[[0]]],';
  const raw = '{"a":[' + unit.repeat(Math.floor(1_500_000 / unit.length)) + '0]}';

  it('16 oversized inputs, posts that never finish: the parsed inputs are NOT held while the posts hang, and everything is released when the turn is closed', async () => {
    const d = rig();
    gc();
    gc();
    const base = process.memoryUsage().heapUsed;
    for (let i = 0; i < 16; i++) d.start({ operationId: 'op' + i, messageId: 'm', name: 'save_note', input: JSON.parse(raw) });
    await tick(1_500);
    gc();
    gc();
    const whileHanging = process.memoryUsage().heapUsed - base;
    expect(d.pending).toBe(16); // the 16 posts really are hanging
    expect(MB(whileHanging)).toBeLessThan(60); // it was ~500 MB: the inputs were pinned by the pending calls
    const settled = await d.settle(500);
    expect(settled).toEqual({ settled: false, pending: 16 });
    d.close();
    await d.settle(2_000);
    expect(d.pending).toBe(0); // the aborted posts ended their calls
    gc();
    gc();
    const afterClose = process.memoryUsage().heapUsed - base;
    expect(MB(afterClose)).toBeLessThan(40);
    expect(d.lostCallIds().size).toBe(16); // every call's answer is recorded as not delivered
  }, 60_000);
});
