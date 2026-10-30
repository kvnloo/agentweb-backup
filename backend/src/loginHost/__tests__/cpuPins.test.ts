/**
 * ENG-2113 (final correctness review): pins for the guards around the CPU meter that no other test failed without: the stderr guard's buckets, meter and exhausted
 * check, the stdout exhausted check, the cost units, the kill-code -> error-kind mapping and the meter's clamps. Each fails without its guard.
 */
import { PassThrough } from "stream";
import type { ChildLike } from "../adapter";
import { ClaudeAdapter, LineLimit, RunnerChildAdapter, StderrGuard } from "../adapters/claudeAdapter";
import { CpuMeter } from "../relay/cpuMeter";
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
