/**
 * ENG-2113 (independent security review, finding 1): ONE hostile line used to stall the shared API process for 0.3-0.7 s (a 1.5 MiB tool event of nested arrays, an 8 MiB
 * escape-heavy `text`), and 20,000 tiny events were one 128 ms block. The worker here is a SEPARATE process (fixtures/hostileStream.js) talking over a real unix socket, so
 * this test's event loop is the only one measured. Per-event-type caps, a structure budget and a yield every YIELD_EVERY_LINES lines bound it; honest events still pass.
 *
 * To print the before/after table: LAG_REPORT=1 ATTACKS=wideNested,wideObj,... LAG_OUT=/path/rows.jsonl npx jest ...transportLag
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { LoginHostClient, LoginHostError, UnixSocketTransport, YIELD_EVERY_LINES } from '../loginHostClient';

const SERVER = join(__dirname, 'fixtures', 'hostileStream.js');
const RELAY_REQ: any = { connectionId: 'c1', epoch: 1, idempotencyKey: 'k1', turnId: 't1', prompt: 'p', model: 'haiku', tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] };
const LEGACY_REQ: any = { connectionId: 'c1', epoch: 1, idempotencyKey: 'k1', turnId: 't1', prompt: 'p', model: 'haiku', bridgeToken: 'x'.repeat(16) };

interface Row {
  attack: string;
  events: number;
  byType: Record<string, number>;
  all: any[];
  err: string;
  wallMs: number;
  cpuMs: number;
  maxGapMs: number;
  rssMB: number;
}

async function runAttack(attack: string, req: any = RELAY_REQ, env: Record<string, string> = {}): Promise<Row> {
  const dir = mkdtempSync(join(tmpdir(), 'lag-'));
  const sock = join(dir, 'w.sock');
  const srv: ChildProcess = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER, sock, attack], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
    p.stdout!.once('data', () => resolve(p));
    p.once('error', reject);
    p.once('exit', (c) => c && reject(new Error('server exit ' + c)));
  });
  try {
    const client = new LoginHostClient(new UnixSocketTransport(sock, {}));
    const stream = await client.turnRun(req);
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
    }, 1);
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    const byType: Record<string, number> = {};
    const all: any[] = [];
    let err = '';
    try {
      for await (const ev of stream.events) {
        byType[(ev as any).type] = (byType[(ev as any).type] || 0) + 1;
        if (all.length < 50) all.push(ev);
      }
    } catch (e) {
      err = e instanceof LoginHostError ? `${e.code}/${e.detail}` : String(e);
    }
    const wall = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    clearInterval(timer);
    stream.close();
    return {
      attack,
      events: Object.values(byType).reduce((a, b) => a + b, 0),
      byType,
      all,
      err,
      wallMs: Math.round(wall),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      maxGapMs: Math.round(maxGap),
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    };
  } finally {
    srv.kill('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('turn stream: hostile lines are bounded, honest ones pass', () => {
  jest.setTimeout(120_000);
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  const report = process.env.LAG_REPORT ? it : it.skip;
  report('REPORT: prints one row per attack in ATTACKS to LAG_OUT', async () => {
    for (const attack of (process.env.ATTACKS || '').split(',').filter(Boolean)) {
      const { all: _all, ...row } = await runAttack(attack, process.env.LEGACY ? LEGACY_REQ : RELAY_REQ);
      appendFileSync(process.env.LAG_OUT || join(tmpdir(), 'lag.jsonl'), JSON.stringify(row) + '\n');
    }
  });

  it('honest maxima on a relay turn all pass: a 50 KB tool-use input and a 200 KB tool-call input intact, a 300 KB result; a 100 KB text block is dropped', async () => {
    const r = await runAttack('honest');
    expect(r.err).toBe('');
    expect(r.all.map((e) => e.type)).toEqual(['usage', 'tool-use', 'tool-call', 'tool-result', 'result']); // `text` was not asked for by anyone
    expect(r.all[1].input.q).toHaveLength(50 * 1024);
    expect(r.all[2].input.q).toHaveLength(200 * 1024);
    expect(r.all[2].inputTooLarge).toBeUndefined();
    expect(r.all[4].text).toHaveLength(300 * 1024);
  });

  it('64 MiB of 1.5 MiB tool-use lines of nested arrays on a relay turn: each becomes a short "input too large" announcement of the same tool, no stall, no failure', async () => {
    const r = await runAttack('wideNested');
    expect(r.err).toBe('');
    const uses = r.all.filter((e) => e.type === 'tool-use');
    expect(uses.length).toBeGreaterThan(10);
    for (const u of uses) expect(u).toEqual({ type: 'tool-use', operationId: 'a', name: 'x', input: { _truncated: 'size' } });
    expect(r.cpuMs).toBeLessThan(3_000); // was 15 s of CPU and ~800 MB RSS
  });

  it('a 300 KB tool-use input on a relay turn is announced by name only (over the 128 KiB cap)', async () => {
    const r = await runAttack('bigToolUseRelay');
    expect(r.all[0]).toEqual({ type: 'tool-use', operationId: 'u2', name: 'search', input: { _truncated: 'size' } });
  });

  it('a 600 KB tool-call input arrives as a call flagged inputTooLarge, with its own id, message and name, and no input', async () => {
    const r = await runAttack('bigToolCallRelay');
    expect(r.err).toBe('');
    expect(r.all[0]).toEqual({ type: 'tool-call', operationId: 'op2', messageId: 'm1', name: 'save_note', input: null, inputTooLarge: true });
  });

  it('40 tool-calls of 1.5 MiB wide inputs and 40 of nested arrays: all become flagged calls (the dispatcher refuses them), the stream goes on', async () => {
    for (const attack of ['toolCallWide', 'toolCallNested']) {
      const r = await runAttack(attack);
      expect(r.err).toBe('');
      const calls = r.all.filter((e) => e.type === 'tool-call');
      expect(calls).toHaveLength(40);
      expect(calls.every((c) => c.inputTooLarge === true && c.input === null)).toBe(true);
    }
  });

  it('a nested tool input UNDER the line cap but with far more structure than an honest input is also replaced (the structure budget)', async () => {
    // 300 KB of "[[[0]]]," is over 20,000 brackets and under the 320 KiB cap
    const r = await runAttack('toolCallNestedUnderCap');
    expect(r.all[0]).toMatchObject({ type: 'tool-call', operationId: 'op9', inputTooLarge: true, input: null });
  });

  it('an 8 MiB `text` line of escaped quotes (450-560 ms of parse) is dropped unread: no event, no failure', async () => {
    const r = await runAttack('textQuotes8');
    expect(r.err).toBe('');
    expect(r.byType.text).toBeUndefined();
    expect(r.byType.result).toBe(1);
    expect(r.cpuMs).toBeLessThan(2_500);
  });

  it('an 8 MiB `result` fails the stream as line_too_long (outcome unknown, nothing truncated); only one result per stream is read', async () => {
    const big = await runAttack('resultBig');
    expect(big.err).toBe('BAD_RESPONSE/line_too_long');
    const two = await runAttack('twoResults');
    expect(two.err).toBe('');
    expect(two.all.filter((e) => e.type === 'result').map((e) => e.text)).toEqual(['first']); // the 900 KB second and the third are never read
  });

  it('LEGACY turn (bridgeToken): a 1 MiB tool-use input still passes whole, exactly as before', async () => {
    const r = await runAttack('legacyToolUse1M', LEGACY_REQ);
    expect(r.err).toBe('');
    expect(r.all[0].type).toBe('tool-use');
    expect(r.all[0].input.q).toHaveLength(1024 * 1024);
  });

  it(`the stream yields to the event loop every ${YIELD_EVERY_LINES} lines: a setImmediate scheduled at the first event runs long before the 200th`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lag-'));
    const sock = join(dir, 'w.sock');
    const srv: ChildProcess = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [SERVER, sock, 'usage200'], { stdio: ['ignore', 'pipe', 'inherit'] });
      p.stdout!.once('data', () => resolve(p));
      p.once('error', reject);
    });
    try {
      const stream = await new LoginHostClient(new UnixSocketTransport(sock, {})).turnRun(RELAY_REQ);
      let ran = -1;
      let n = 0;
      for await (const ev of stream.events) {
        if ((ev as any).type !== 'usage') continue;
        n++;
        if (n === 1) setImmediate(() => void (ran = n));
      }
      expect(ran).toBeGreaterThan(0);
      expect(ran).toBeLessThanOrEqual(YIELD_EVERY_LINES + 2);
    } finally {
      srv.kill('SIGTERM');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
