/**
 * ENG-2113 (final correctness review): pins for the guards around the CPU meter that no other test failed without: the stderr guard's buckets, meter and exhausted
 * check, the stdout exhausted check, the cost units, the kill-code -> error-kind mapping and the meter's clamps. Each fails without its guard.
 */
import { PassThrough } from "stream";
import type { ChildLike } from "../adapter";
import { ClaudeAdapter, LineLimit, RunnerChildAdapter, StderrGuard } from "../adapters/claudeAdapter";
import { createInterface } from "readline";
import { CPU_BURST_MS, CPU_REFILL_MS_PER_SEC, CpuMeter } from "../relay/cpuMeter";
import { MAX_LINE_VALUES } from "../adapters/claudeAdapter";
import { performance } from "perf_hooks";

function guard(meter: CpuMeter) {
  const floods: string[] = [];
  const g = new StderrGuard(meter, () => floods.push("flood"));
  let out = "";
  g.on("data", (d: Buffer) => (out += d.toString("utf8")));
  return { g, floods, out: () => out };
}
const clockFrozen = () => jest.spyOn(performance, "now").mockImplementation(() => 5000);

describe("the stderr guard", () => {
  it("MUTATION TARGET: the read bucket: 2,500 one-byte reads at one instant are a flood", () => {
    const spy = clockFrozen();
    try {
      const { g, floods } = guard(new CpuMeter(1e9, 1e9));
      for (let i = 0; i < 2500; i++) g.write("y");
      expect(floods).toEqual(["flood"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: the byte bucket: 20 reads of 64 KiB (far under the read bucket) are a flood; 15 are not", () => {
    const spy = clockFrozen();
    try {
      const a = guard(new CpuMeter(1e9, 1e9));
      for (let i = 0; i < 15; i++) a.g.write(Buffer.alloc(64 * 1024, 121));
      expect(a.floods).toEqual([]);
      const b = guard(new CpuMeter(1e9, 1e9));
      for (let i = 0; i < 20; i++) b.g.write(Buffer.alloc(64 * 1024, 121));
      expect(b.floods).toEqual(["flood"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: the guard is METERED: its sections are charged, and the fixed per-read cost too", () => {
    let t = 0;
    const m1 = new CpuMeter(100, 0, () => (t += 30)); // every metered section reads as 30 ms
    const a = guard(m1);
    for (let i = 0; i < 6; i++) a.g.write("y");
    expect(m1.exhausted).toBe(true);
    const spy = clockFrozen();
    try {
      const m2 = new CpuMeter(0.15, 0, () => 0); // the clock never moves: only the fixed 0.08 ms per read can drain it
      const b = guard(m2);
      b.g.write("y");
      expect(m2.exhausted).toBe(false);
      b.g.write("y");
      expect(m2.exhausted).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: once the meter is exhausted nothing more is accepted (the exhausted check)", () => {
    const m = new CpuMeter(10, 0);
    const { g, out } = guard(m);
    g.write("before");
    m.charge(1e9);
    g.write("LATE");
    g.end();
    expect(out()).toBe("before");
  });

  it("MUTATION TARGET: a flood on stderr KILLS the child (the adapter calls kill) and reports stderr_flood", () => {
    const spy = clockFrozen();
    try {
      const stderr = new PassThrough();
      let kills = 0;
      const child: ChildLike = { stdin: new PassThrough(), stdout: new PassThrough(), stderr, kill: () => void kills++, onExit: () => undefined };
      const adapter = new RunnerChildAdapter(child, 1 << 20, undefined, new CpuMeter(1e9, 1e9));
      const errors: string[] = [];
      adapter.on("error", (e: Error) => errors.push(e.message));
      adapter.stderr.resume();
      for (let i = 0; i < 2500; i++) stderr.write("y");
      expect(errors).toEqual(["stderr_flood"]);
      expect(kills).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: the runner is given the TAIL (the last 8 KiB), when the stream ends", () => {
    const { g, out } = guard(new CpuMeter(1e9, 1e9));
    g.write(Buffer.from("HEAD".padEnd(6000, "a")));
    g.write(Buffer.from("b".repeat(6000) + "TAIL"));
    g.end();
    expect(out().length).toBe(8192);
    expect(out().endsWith("TAIL")).toBe(true);
    expect(out().startsWith("HEAD")).toBe(false);
  });
});

describe("LineLimit", () => {
  it("MUTATION TARGET: once the meter is exhausted nothing more is accepted or forwarded (the exhausted check)", () => {
    const m = new CpuMeter(10, 0);
    const ll = new LineLimit(1 << 20, () => undefined, undefined, () => undefined, m);
    let out = "";
    ll.on("data", (d: Buffer) => (out += d.toString("utf8")));
    ll.write('{"a":1}\n');
    m.charge(1e9);
    ll.write('{"late":1}\n');
    expect(out).toBe('{"a":1}\n');
  });

  it("MUTATION TARGET: cost units: events of 100,000 values (about 200 KB, a tiny share of the byte bucket by bytes alone) exhaust the 64 MiB event bucket after about ten lines", async () => {
    const spy = clockFrozen();
    try {
      const line = Buffer.from('{"a":[' + "0,".repeat(99_000) + "0]}\n"); // under MAX_LINE_VALUES, ~200 KB
      expect(99_002).toBeLessThan(MAX_LINE_VALUES);
      const floods: string[] = [];
      const ll = new LineLimit(16 * 1024 * 1024, () => undefined, undefined, () => floods.push("flood"), new CpuMeter(1e9, 1e9));
      ll.resume();
      for (let i = 0; i < 20; i++) ll.write(line); // 20 x 200 KB = 4 MB by bytes alone; 20 x (200 KB + 64 x 99,000) = 129 MB by cost units
      await new Promise((r) => setTimeout(r, 50)); // (large writes are queued and handled a tick later)
      expect(floods).toEqual(["flood"]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the kill codes map to the retryable kind (mapError)", () => {
  const adapter = Object.create(ClaudeAdapter.prototype) as ClaudeAdapter;
  it.each(["cpu_budget", "event_flood", "stderr_flood", "stdout_flood", "stdout_line_too_long"])("MUTATION TARGET: %s is transient", (code) => {
    expect(adapter.mapError(new Error(code))).toBe("transient");
  });
  it("an unrelated message is not blanket-transient", () => {
    expect(adapter.mapError(new Error("Not logged in"))).not.toBe("transient");
  });
});

describe("CpuMeter clamps and listeners", () => {
  it("MUTATION TARGET: a clock that steps BACKWARDS neither refills nor drains", () => {
    let t = 1_000_000;
    const m = new CpuMeter(100, 50, () => t);
    t -= 3_600_000; // an hour back
    m.charge(10);
    expect(m.exhausted).toBe(false);
    expect(m.remaining).toBeCloseTo(90, 5);
  });

  it("MUTATION TARGET: a negative charge gives no credit", () => {
    const m = new CpuMeter(100, 0, () => 0);
    m.charge(-1000);
    expect(m.remaining).toBeLessThanOrEqual(100); // never above the burst
    m.charge(150);
    expect(m.exhausted).toBe(true);
  });

  it("MUTATION TARGET: a listener that throws does not stop the others, and does not throw out of charge()", () => {
    const m = new CpuMeter(10, 0, () => 0);
    const called: string[] = [];
    m.onExhausted(() => {
      throw new Error("boom");
    });
    m.onExhausted(() => called.push("second"));
    expect(() => m.charge(100)).not.toThrow();
    expect(called).toEqual(["second"]);
  });
});

// ── the meter's exhaustion kills the child (the trip raised from ANYWHERE: the stream, stderr, the relay socket all charge the one meter) ──
describe("an exhausted meter kills the child", () => {
  function childOf(meter: CpuMeter) {
    const order: string[] = [];
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child: ChildLike = { stdin: new PassThrough(), stdout, stderr, kill: () => void order.push(stdout.destroyed && stderr.destroyed ? "kill-after-destroy" : "kill-with-pipes-open"), onExit: () => undefined, onError: () => undefined } as unknown as ChildLike;
    const adapter = new RunnerChildAdapter(child, 1 << 20, undefined, meter);
    const errors: string[] = [];
    adapter.on("error", (e: Error) => errors.push(e.message));
    return { adapter, order, errors, stdout, stderr };
  }

  it("MUTATION TARGET: charging the shared meter past its burst, from outside the stream (as the relay does), signals the child ONCE with the pipes already closed and reports cpu_budget", () => {
    const meter = new CpuMeter(50, 0);
    const { order, errors, stdout, stderr } = childOf(meter);
    meter.charge(40);
    expect(order).toEqual([]); // within the burst: nothing happens
    expect(errors).toEqual([]);
    meter.charge(20); // 60 > 50
    expect(order).toEqual(["kill-after-destroy"]); // killed, and the raw pipes were closed BEFORE the signal
    expect(errors).toEqual(["cpu_budget"]);
    expect(stdout.destroyed && stderr.destroyed).toBe(true);
    meter.charge(500); // already exhausted: the listener does not fire again
    expect(order).toEqual(["kill-after-destroy"]);
    expect(errors).toEqual(["cpu_budget"]);
  });

  it("MUTATION TARGET: the same through the stream: a CLI whose events cost more than the budget is signalled (not merely reported)", async () => {
    const spy = jest.spyOn(performance, "now").mockImplementation(() => 5000);
    try {
      const meter = new CpuMeter(5, 0);
      const { order, errors, stdout } = childOf(meter);
      for (let i = 0; i < 200; i++) stdout.write('{"a":1}\n'); // the fixed per-read cost (0.08 ms) alone is more than 5 ms
      await new Promise((r) => setImmediate(r));
      expect(errors).toContain("cpu_budget");
      expect(order[0]).toBe("kill-after-destroy");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── the meter in the stream path, with a mocked clock (FAST: these sit inside the signed-deploy gate; the slow real-clock suite is cpuBudget.test.ts) ──
describe("the CPU meter in the CLI's stdout path (mocked clock)", () => {
  /** A meter whose clock AND cpu reading are the mocked performance.now (wall = CPU): the modelled cost of handling a line is what is charged. */
  const mockedMeter = (errors: string[]) => {
    const m = new CpuMeter(undefined, undefined, undefined, () => performance.now());
    m.onExhausted(() => errors.push("cpu_budget"));
    return m;
  };

  it("MUTATION TARGET: the burst and the refill are the documented numbers, so an honest turn has room and a hostile one does not", () => {
    expect(CPU_BURST_MS).toBe(1000);
    expect(CPU_REFILL_MS_PER_SEC).toBe(50);
    const m = new CpuMeter();
    expect(m.remaining).toBe(1000);
  });

  it("MUTATION TARGET: an HONEST long turn is never killed: 24,000 tiny events over ten minutes plus four 8-12 MB echoed results", async () => {
    let t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const errors: string[] = [];
      const meter = mockedMeter(errors);
      const ll = new LineLimit(16 * 1024 * 1024, () => errors.push("overflow"), undefined, () => errors.push("flood"), meter);
      const rl = createInterface({ input: ll });
      let events = 0;
      rl.on("line", (l) => {
        if (!l.trim()) return;
        events++;
        JSON.parse(l);
        t += l.length > 1_000_000 ? 250 : 0.2; // what handling the line costs: a big echo 250 ms (measured 50-110 ms of CPU, 250 is a loaded-machine allowance), a small event 0.2 ms
      });
      const small = Buffer.from('{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"hello"}]}}\n');
      const big = (mb: number) => Buffer.from('{"type":"user","c":"' + "r".repeat(mb * 1024 * 1024) + '"}\n');
      let smalls = 0;
      for (let sec = 0; sec < 600; sec++) {
        for (let i = 0; i < 40; i++) {
          ll.write(small);
          smalls++;
        }
        if (sec === 100 || sec === 101) ll.write(big(12)); // two 12 MB echoes back to back: 500 ms of the 1000 ms burst
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
    }
  });

  it("MUTATION TARGET: ...and five echoes in a row at 150 ms each (750 of the 1000 ms) are survived, a sixth is not (the burst is real)", async () => {
    let t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const run = async (n: number) => {
        const errors: string[] = [];
        const meter = mockedMeter(errors);
        const ll = new LineLimit(16 * 1024 * 1024, () => errors.push("overflow"), undefined, () => errors.push("flood"), meter);
        const rl = createInterface({ input: ll });
        rl.on("line", () => void (t += 150));
        for (let i = 0; i < n; i++) ll.write(Buffer.from('{"c":"' + "r".repeat(2 * 1024 * 1024) + '"}\n'));
        await new Promise((r) => setTimeout(r, 30));
        return errors;
      };
      expect(await run(5)).toEqual([]);
      expect(await run(8)).toEqual(["cpu_budget"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: the stdout scan IS metered: a stream whose every event costs 100 ms of loop time is killed (cpu_budget)", async () => {
    let t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const errors: string[] = [];
      const meter = mockedMeter(errors);
      const ll = new LineLimit(16 * 1024 * 1024, () => errors.push("overflow"), undefined, () => errors.push("flood"), meter);
      const rl = createInterface({ input: ll });
      rl.on("line", () => void (t += 100)); // the work downstream of the push, inside the metered section
      for (let i = 0; i < 100; i++) ll.write(Buffer.from("{}\n"));
      await new Promise((r) => setImmediate(r));
      expect(errors).toEqual(["cpu_budget"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: ten 8 MB echoes spread over 60 s (each costs 40 ms) are never killed", async () => {
    let t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const errors: string[] = [];
      const meter = mockedMeter(errors);
      const ll = new LineLimit(16 * 1024 * 1024, () => errors.push("overflow"), undefined, () => errors.push("flood"), meter);
      const rl = createInterface({ input: ll });
      let parsed = 0;
      rl.on("line", () => {
        parsed++;
        t += 40;
      });
      const line = Buffer.from('{"type":"user","c":"' + "A".repeat(8 * 1024 * 1024) + '"}\n');
      for (let i = 0; i < 10; i++) {
        ll.write(line);
        await new Promise((r) => setImmediate(r));
        t += 6000;
      }
      expect(errors).toEqual([]);
      expect(parsed).toBe(10);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: the per-read bucket: 2,500 one-byte reads at once end the stream (stdout_flood); 150 reads a second for 20 s do not", async () => {
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
        for (let i = 0; i < 150; i++) ll2.write(Buffer.from(" "));
        await new Promise((r) => setImmediate(r));
        t += 1000;
      }
      expect(calm).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: the fixed per-read cost (0.08 ms) is charged even when the section is instant: 1,900 reads fit a 2000 ms budget, 1,500 do not fit a 100 ms one", async () => {
    const t = 5000;
    const spy = jest.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const errors: string[] = [];
      const meter = new CpuMeter(2000, 0);
      meter.onExhausted(() => errors.push("cpu_budget"));
      const ll = new LineLimit(1 << 20, () => undefined, undefined, () => errors.push("flood"), meter);
      ll.resume();
      for (let i = 0; i < 1900; i++) ll.write(Buffer.from("{}\n"));
      await new Promise((r) => setImmediate(r));
      expect(errors).toEqual([]);
      const meter2 = new CpuMeter(100, 0);
      meter2.onExhausted(() => errors.push("cpu_budget"));
      const ll2 = new LineLimit(1 << 20, () => undefined, undefined, () => errors.push("flood"), meter2);
      ll2.resume();
      for (let i = 0; i < 1500; i++) ll2.write(Buffer.from("{}\n"));
      await new Promise((r) => setImmediate(r));
      expect(errors).toEqual(["cpu_budget"]);
    } finally {
      spy.mockRestore();
    }
  });
});
