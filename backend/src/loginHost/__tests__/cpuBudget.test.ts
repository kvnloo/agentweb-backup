/**
 * ENG-2113 (final security review): the unified per-turn CPU meter. A hostile unit is killed within a bounded time, and the event-loop time it can cost the host is
 * bounded by the meter's burst (2 s) plus its 5% refill, whatever vector it uses. The vectors are driven through the REAL RunnerChildAdapter (and readline +
 * JSON.parse, the runner's own path) with a REAL child process; loop utilisation is measured with perf_hooks. Honest traffic is never killed (mocked clock).
 *
 * Every RESULT line prints the measured numbers (kill time, loop active ms, utilisation over the whole observation window and over the unit's lifetime).
 */
import { spawn } from "child_process";
import { createInterface } from "readline";
import { PassThrough } from "stream";
import { performance } from "perf_hooks";
import type { ChildLike } from "../adapter";
import { LineLimit, RunnerChildAdapter } from "../adapters/claudeAdapter";
import { CPU_BURST_MS, CPU_REFILL_MS_PER_SEC, CpuMeter, TokenBucket } from "../relay/cpuMeter";

jest.setTimeout(120_000);

describe("CpuMeter", () => {
  const clock = () => {
    let t = 1000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  };

  it("MUTATION TARGET: charges the elapsed time of a section; running out fires the listener ONCE; it stays exhausted", () => {
    const c = clock();
    const m = new CpuMeter(100, 10, c.now);
    let fired = 0;
    m.onExhausted(() => fired++);
    m.time(() => c.advance(60));
    expect(m.exhausted).toBe(false);
    m.time(() => c.advance(60)); // 120 > 100 (+ a little refill)
    expect(m.exhausted).toBe(true);
    m.time(() => c.advance(10));
    m.charge(500);
    expect(fired).toBe(1);
    expect(m.exhausted).toBe(true);
  });

  it("MUTATION TARGET: only the OUTERMOST section charges (a section nested inside another is not charged twice)", () => {
    const c = clock();
    const m = new CpuMeter(100, 0, c.now);
    m.time(() => {
      c.advance(30);
      m.time(() => c.advance(30));
      m.time(() => c.advance(30));
    }); // 90 in all, not 150
    expect(m.exhausted).toBe(false);
    m.time(() => c.advance(11));
    expect(m.exhausted).toBe(true);
  });

  it("MUTATION TARGET: refills at refillMsPerSec and never above the burst (an idle turn banks nothing beyond it)", () => {
    const c = clock();
    const m = new CpuMeter(100, 50, c.now);
    m.charge(90); // 10 left
    c.advance(1000); // +50
    m.charge(55); // 60 - 55 = 5 left: only possible with the refill
    expect(m.exhausted).toBe(false);
    c.advance(3_600_000); // an idle hour: clamped to the 100 burst
    m.charge(101);
    expect(m.exhausted).toBe(true);
  });

  it("a section that throws is still charged, and the exception passes through", () => {
    const c = clock();
    const m = new CpuMeter(100, 0, c.now);
    expect(() =>
      m.time(() => {
        c.advance(150);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(m.exhausted).toBe(true);
  });

  it("the defaults are the documented numbers", () => {
    expect(CPU_BURST_MS).toBe(2000);
    expect(CPU_REFILL_MS_PER_SEC).toBe(50);
  });

  it("TokenBucket: pays or refuses without partial payment, refills with the clock, clamps at the burst", () => {
    const c = clock();
    const b = new TokenBucket(10, 5, c.now);
    expect(b.take(10)).toBe(true);
    expect(b.take(1)).toBe(false);
    c.advance(1000);
    expect(b.take(5)).toBe(true);
    expect(b.take(1)).toBe(false);
    c.advance(3_600_000);
    expect(b.take(11)).toBe(false);
    expect(b.take(10)).toBe(true);
  });
});

function realChild(script: string): { child: ChildLike; pid: () => number | undefined } {
  const proc = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  proc.stdin.on("error", () => undefined);
  return {
    child: { stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr, kill: () => void proc.kill("SIGKILL"), onExit: (cb) => void proc.on("exit", cb), onError: (cb) => void proc.on("error", cb) },
    pid: () => proc.pid,
  };
}

interface Vector {
  killedMs: number | undefined;
  error: string | undefined;
  activeMs: number;
  lifetimeUtil: number;
  windowUtil: number;
  lines: number;
}
const WINDOW_MS = 10_000;

/** Runs a hostile child to its kill (or the window's end) and reports the loop time it cost. */
async function drive(script: string, opts: { windowMs?: number } = {}): Promise<Vector> {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const { child } = realChild(script);
  const adapter = new RunnerChildAdapter(child, 16 * 1024 * 1024, undefined, new CpuMeter());
  let error: string | undefined;
  let killedAt: number | undefined;
  let lines = 0;
  adapter.on("error", (e: Error) => {
    error ??= e.message;
    killedAt ??= performance.now();
  });
  createInterface({ input: adapter.stdout }).on("line", (l) => {
    lines++;
    if (!l.trim()) return;
    try {
      JSON.parse(l);
    } catch {
      /* the runner ignores it */
    }
  });
  adapter.stderr.on("data", () => undefined);
  const elu0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  let eluAtKill: ReturnType<typeof performance.eventLoopUtilization> | undefined;
  while (performance.now() - t0 < windowMs) {
    await new Promise((r) => setTimeout(r, 25));
    if (killedAt !== undefined && !eluAtKill) eluAtKill = performance.eventLoopUtilization(elu0);
  }
  const whole = performance.eventLoopUtilization(elu0);
  adapter.kill();
  const life = eluAtKill ?? whole;
  return { killedMs: killedAt === undefined ? undefined : Math.round(killedAt - t0), error, activeMs: Math.round(whole.active), lifetimeUtil: Math.round(life.utilization * 100) / 100, windowUtil: Math.round(whole.utilization * 100) / 100, lines };
}
const report = (name: string, v: Vector) => console.log("RESULT cpu", name, JSON.stringify(v));

// Generous: a flat-out unit may take the 2 s burst (plus the section that crosses it) once; a quarter of the 10 s window is 2.5 s.
const expectBounded = (v: Vector) => {
  expect(v.error).toBeDefined();
  expect(v.killedMs).toBeLessThan(WINDOW_MS);
  expect(v.activeMs).toBeLessThan(3500);
  expect(v.windowUtil).toBeLessThan(0.35);
};

describe("hostile child processes are killed within a bounded time and a bounded cost", () => {
  it.each([
    ["one-byte writes of junk (no newline)", 'const fs=require("fs");const w=(fd,b)=>{for(;;){try{fs.writeSync(fd,b);return}catch(e){if(e.code!=="EAGAIN")process.exit(0)}}};for(;;){w(1,"x")}'],
    ["one-byte writes of junk lines", 'const fs=require("fs");const w=(fd,b)=>{for(;;){try{fs.writeSync(fd,b);return}catch(e){if(e.code!=="EAGAIN")process.exit(0)}}};for(;;){w(1,"x\\n")}'],
    ["one-byte writes of whitespace before a line", 'const fs=require("fs");const w=(fd,b)=>{for(;;){try{fs.writeSync(fd,b);return}catch(e){if(e.code!=="EAGAIN")process.exit(0)}}};for(;;){w(1," ")}'],
    ["one-byte writes inside a valid event string", 'const fs=require("fs");const w=(fd,b)=>{for(;;){try{fs.writeSync(fd,b);return}catch(e){if(e.code!=="EAGAIN")process.exit(0)}}};w(1,\'{"a":"\');for(;;){w(1,"x")}'],
    ["tiny valid events", 'const fs=require("fs");const w=(fd,b)=>{for(;;){try{fs.writeSync(fd,b);return}catch(e){if(e.code!=="EAGAIN")process.exit(0)}}};const l=Buffer.from("{}\\n".repeat(20000));for(;;){w(1,l)}'],
  ])("MUTATION TARGET (stdout): %s", async (name, script) => {
    const v = await drive(script);
    report(name, v);
    expectBounded(v);
  });

  it("MUTATION TARGET (stderr): a 64 KiB-write flood on stderr is killed (stderr_flood) and the runner never sees more than a few KiB", async () => {
    const { child } = realChild('const fs=require("fs");const w=(fd,b)=>{for(;;){try{fs.writeSync(fd,b);return}catch(e){if(e.code!=="EAGAIN")process.exit(0)}}};const b=Buffer.alloc(65536,121);for(;;){w(2,b)}');
    const adapter = new RunnerChildAdapter(child, 16 * 1024 * 1024, undefined, new CpuMeter());
    let error: string | undefined;
    let seen = 0;
    adapter.on("error", (e: Error) => (error ??= e.message));
    adapter.stderr.on("data", (d: Buffer) => (seen += d.length));
    adapter.stdout.resume();
    const elu0 = performance.eventLoopUtilization();
    const t0 = performance.now();
    while (performance.now() - t0 < WINDOW_MS && !error) await new Promise((r) => setTimeout(r, 25));
    const ms = Math.round(performance.now() - t0);
    const elu = performance.eventLoopUtilization(elu0);
    adapter.kill();
    console.log("RESULT cpu stderr flood", JSON.stringify({ killedMs: ms, error, activeMs: Math.round(elu.active), seenByRunner: seen }));
    expect(error).toBe("stderr_flood");
    expect(seen).toBeLessThanOrEqual(8192);
    expect(Math.round(elu.active)).toBeLessThan(3500);
  });

  it("MUTATION TARGET (stderr): ordinary stderr passes through (diagnostics keep working)", async () => {
    const { child } = realChild('process.stderr.write("warning: something\\n");process.exit(0)');
    const adapter = new RunnerChildAdapter(child, 16 * 1024 * 1024, undefined, new CpuMeter());
    let seen = "";
    adapter.stderr.on("data", (d: Buffer) => (seen += d.toString()));
    adapter.stdout.resume();
    await new Promise((r) => setTimeout(r, 800));
    expect(seen).toBe("warning: something\n");
  });

  it("MUTATION TARGET (d): compact objects of 150,000 unique keys, paced at about 3.9 MiB/s (under every byte bucket), are killed by the meter", async () => {
    // {"k0":0,"k1":1,...}: 150,000 values per line, ~1.4 MB; one line is written, then the child sleeps to hold the pace
    const script = `
      let s='{';
      for(let i=0;i<149990;i++) s+=(i?',':'')+'"k'+i+'":'+(i%10);
      s+='}\\n';
      const b=Buffer.from(s);
      const perSec=3.9*1024*1024/b.length;
      setInterval(()=>process.stdout.write(b),Math.max(1,Math.floor(1000/perSec)));
    `;
    const v = await drive(script, { windowMs: 20_000 });
    report("150k unique keys at 3.9 MiB/s", v);
    expect(v.error).toBeDefined();
    expect(v.activeMs).toBeLessThan(5000);
  });
});

describe("an HONEST long turn is never killed (mocked clock)", () => {
  it("MUTATION TARGET: thousands of tiny events over 10 minutes plus a few 8-12 MB echoed results: never a flood, never cpu_budget", async () => {
    const real = performance.now.bind(performance);
    let t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const errors: string[] = [];
      const meter = new CpuMeter();
      meter.onExhausted(() => errors.push("cpu_budget"));
      const ll = new LineLimit(16 * 1024 * 1024, () => errors.push("overflow"), undefined, () => errors.push("flood"), meter);
      const rl = createInterface({ input: ll });
      let events = 0;
      rl.on("line", (l) => {
        if (!l.trim()) return;
        events++;
        JSON.parse(l);
        t += l.length > 1_000_000 ? 250 : 0.2; // what handling the line cost: a big echoed result 250 ms, a small event 0.2 ms
      });
      const small = Buffer.from('{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"hello"}]}}\n');
      const big = (mb: number) => Buffer.from('{"type":"user","c":"' + "r".repeat(mb * 1024 * 1024) + '"}\n');
      let smalls = 0;
      for (let sec = 0; sec < 600; sec++) {
        for (let i = 0; i < 40; i++) {
          ll.write(small); // 24,000 events over the 10 minutes
          smalls++;
        }
        if (sec === 100 || sec === 101) ll.write(big(12)); // two 12 MB echoes back to back
        if (sec === 300) ll.write(big(8));
        if (sec === 450) ll.write(big(10));
        await new Promise((r) => setImmediate(r));
        t += 1000;
      }
      ll.end();
      await new Promise((r) => rl.once("close", r));
      expect(errors).toEqual([]);
      expect(meter.exhausted).toBe(false);
      expect(events).toBe(smalls + 4);
    } finally {
      spy.mockRestore();
      void real;
    }
  });

  it("MUTATION TARGET: ...and the same stream with every event costing 100 ms of loop time IS killed (the meter is really charged by the downstream work)", async () => {
    let t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const errors: string[] = [];
      const meter = new CpuMeter();
      meter.onExhausted(() => errors.push("cpu_budget"));
      const ll = new LineLimit(16 * 1024 * 1024, () => errors.push("overflow"), undefined, () => errors.push("flood"), meter);
      const rl = createInterface({ input: ll });
      rl.on("line", () => void (t += 100));
      for (let i = 0; i < 100; i++) ll.write(Buffer.from("{}\n"));
      await new Promise((r) => setImmediate(r));
      expect(errors).toEqual(["cpu_budget"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the per-read bucket (a tiny read costs ~8 us end to end)", () => {
  it("MUTATION TARGET: 2,500 one-byte reads at once end the stream (stdout_flood) before the meter notices; a slow trickle does not", async () => {
    let t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const flood: string[] = [];
      const ll = new LineLimit(1 << 20, () => undefined, undefined, () => flood.push("flood"));
      ll.resume();
      for (let i = 0; i < 2500; i++) ll.write(Buffer.from(" "));
      await new Promise((r) => setImmediate(r));
      expect(flood).toEqual(["flood"]);
      const calm: string[] = [];
      const ll2 = new LineLimit(1 << 20, () => undefined, undefined, () => calm.push("flood"));
      ll2.resume();
      for (let sec = 0; sec < 20; sec++) {
        for (let i = 0; i < 500; i++) ll2.write(Buffer.from(" ")); // 500 reads a second for 20 s: under 1,000/s
        await new Promise((r) => setImmediate(r));
        t += 1000;
      }
      expect(calm).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

void PassThrough;
