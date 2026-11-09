/** Opt-in measurement (AW_MEASURE_ECHOES=1): the per-section overhead of the CPU meter on the hot path (a tiny event, a one-byte read). Printed, not asserted. */
import { CpuMeter } from "../../relay/cpuMeter";

(process.env.AW_MEASURE_ECHOES ? it : it.skip)("overhead of meter.time() for an empty section, real clock and thread CPU time", () => {
  const N = 200_000;
  const bare = (): number => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) performance.now();
    return Number(process.hrtime.bigint() - t) / N;
  };
  const m = new CpuMeter(1e12, 0);
  const wallOnly = new CpuMeter(1e12, 0, () => performance.now()); // custom clock: cpu = clock, so no thread-CPU reads
  const timed = (meter: CpuMeter): number => {
    const t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) meter.time(() => undefined);
    return Number(process.hrtime.bigint() - t) / N;
  };
  const a = timed(wallOnly);
  const b = timed(m);
  console.log("RESULT OVERHEAD ns per empty section: wall clock only", Math.round(a), "| with the thread CPU reading", Math.round(b), "| bare performance.now()", Math.round(bare()));
  expect(m.exhausted).toBe(false);
});
