/**
 * ENG-2113: the per-turn CPU meter (relay/cpuMeter.ts). FAST and deterministic (injected clocks; one real-thread test that blocks without using CPU), so it can sit inside
 * the signed-deploy gate: the constants it pins (burst, refill, nesting, min(wall, CPU)) are what protect the host from a hostile turn AND what keep honest turns alive.
 */
import { CPU_BURST_MS, CPU_REFILL_MS_PER_SEC, CpuMeter, FAST_SECTION_MS, TokenBucket } from "../../relay/cpuMeter";

const clock = () => {
  let t = 1000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

describe("CpuMeter: the numbers", () => {
  it("MUTATION TARGET: burst 1000 ms, refill 50 ms per second, sections up to 1 ms are charged without a CPU reading", () => {
    expect(CPU_BURST_MS).toBe(1000);
    expect(CPU_REFILL_MS_PER_SEC).toBe(50);
    expect(FAST_SECTION_MS).toBe(1);
  });
  it("MUTATION TARGET: a fresh meter holds exactly the burst; one ms more than that exhausts it", () => {
    const c = clock();
    const m = new CpuMeter(undefined, undefined, c.now);
    expect(m.remaining).toBe(CPU_BURST_MS);
    m.charge(CPU_BURST_MS);
    expect(m.exhausted).toBe(false);
    m.charge(1);
    expect(m.exhausted).toBe(true);
  });
});

describe("CpuMeter: charging", () => {
  it("MUTATION TARGET: runs out ONCE, fires the listener once, and stays exhausted", () => {
    const c = clock();
    const m = new CpuMeter(100, 10, c.now);
    let fired = 0;
    m.onExhausted(() => fired++);
    m.time(() => c.advance(60));
    expect(m.exhausted).toBe(false);
    m.time(() => c.advance(60));
    expect(m.exhausted).toBe(true);
    m.charge(500);
    expect(fired).toBe(1);
  });

  it("MUTATION TARGET: only the OUTERMOST section charges (a nested one is not charged twice)", () => {
    const c = clock();
    const m = new CpuMeter(100, 0, c.now);
    m.time(() => {
      c.advance(30);
      m.time(() => c.advance(30));
      m.time(() => c.advance(30));
    }); // 90, not 150
    expect(m.exhausted).toBe(false);
    expect(m.remaining).toBeCloseTo(10, 5);
  });

  it("MUTATION TARGET: refills at refillMsPerSec and never above the burst", () => {
    const c = clock();
    const m = new CpuMeter(100, 50, c.now);
    m.charge(90);
    c.advance(1000); // +50
    m.charge(55); // 10 + 50 - 55 = 5: possible only with the refill
    expect(m.exhausted).toBe(false);
    c.advance(3_600_000);
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

  it("MUTATION TARGET: a listener that throws does not stop the others", () => {
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

describe("CpuMeter: min(wall, CPU)", () => {
  function split() {
    let wall = 0;
    let cpu = 0;
    return { now: () => wall, cpu: () => cpu, run: (w: number, c: number) => ((wall += w), (cpu += c)) };
  }

  it("MUTATION TARGET: a section is charged the CPU it used when that is LESS than its wall time (a descheduled loop is not charged for the wait)", () => {
    const k = split();
    const m = new CpuMeter(1000, 0, k.now, k.cpu);
    m.time(() => k.run(100, 30));
    expect(m.remaining).toBeCloseTo(970, 5);
  });

  it("MUTATION TARGET: never MORE than the wall time, even if the CPU reading is larger (other threads of the process, a coarse counter)", () => {
    const k = split();
    const m = new CpuMeter(1000, 0, k.now, k.cpu);
    m.time(() => k.run(20, 80));
    expect(m.remaining).toBeCloseTo(980, 5);
  });

  it("MUTATION TARGET: a CPU counter that steps backwards charges nothing, not a credit", () => {
    const k = split();
    const m = new CpuMeter(1000, 0, k.now, k.cpu);
    m.time(() => k.run(50, -30));
    expect(m.remaining).toBeLessThanOrEqual(1000);
    expect(m.remaining).toBeGreaterThanOrEqual(1000 - 1e-9);
  });

  it("MUTATION TARGET: a short section (up to FAST_SECTION_MS) is charged its wall time and the CPU is read only at its start (the hot path of tiny events and one-byte reads)", () => {
    const k = split();
    let reads = 0;
    const m = new CpuMeter(1000, 0, k.now, () => (reads++, k.cpu()));
    m.time(() => k.run(0.5, 0.1));
    expect(reads).toBe(1);
    expect(m.remaining).toBeCloseTo(999.5, 5); // wall, not the 0.1 of CPU
    m.time(() => k.run(5, 1));
    expect(reads).toBe(3); // a long one reads the CPU again at its end
  });

  it("MUTATION TARGET: with the real clock and the real thread CPU time, a section that BLOCKS without using the CPU is charged almost nothing", () => {
    const m = new CpuMeter();
    m.time(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80)); // 80 ms of wall time, ~0 of CPU
    expect(CPU_BURST_MS - m.remaining).toBeLessThan(25);
  });

  it("with the real clock, a section that BURNS the CPU is charged about what it burnt", () => {
    const m = new CpuMeter();
    const t0 = performance.now();
    m.time(() => {
      while (performance.now() - t0 < 60) Math.sqrt(Math.random());
    });
    const charged = CPU_BURST_MS - m.remaining;
    // (on a heavily loaded machine the thread is descheduled part of the 60 ms and its CPU time is lower: the bounds are loose on purpose)
    expect(charged).toBeGreaterThan(5);
    expect(charged).toBeLessThan(150);
  });
});

describe("TokenBucket", () => {
  it("pays or refuses without partial payment, refills with the clock, clamps at the burst", () => {
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
