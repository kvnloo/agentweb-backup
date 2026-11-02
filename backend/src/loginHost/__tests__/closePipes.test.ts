/**
 * ENG-2113: the pipes are closed ONLY when a guard trips. A trip (cpu_budget, stdout_flood, stderr_flood, stdout_line_too_long, event_flood) unpipes and destroys both raw
 * streams BEFORE the child is signalled: in production the signal is SIGTERM with up to 10 s of grace, and a writer that survives it must not keep costing a read each.
 * A PLAIN kill (normal close, idle retirement, a graceful shutdown) leaves the pipes open, so a CLI winding down never gets EPIPE on its last writes; its output is
 * still read and discarded without parsing or charging. (The end-to-end versions with a real SIGTERM-ignoring writer are in cpuBudget.test.ts.)
 */
import { PassThrough } from "stream";
import { performance } from "perf_hooks";
import type { ChildLike } from "../adapter";
import { RunnerChildAdapter } from "../adapters/claudeAdapter";
import { CpuMeter } from "../relay/cpuMeter";

function make(meter?: CpuMeter) {
  const order: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: ChildLike = { stdin: new PassThrough(), stdout, stderr, kill: () => void order.push(stdout.destroyed && stderr.destroyed ? "kill-after-destroy" : "kill-with-pipes-open"), onExit: () => undefined };
  const adapter = new RunnerChildAdapter(child, 1 << 20, undefined, meter);
  const seen = { out: "", err: "" };
  adapter.stdout.on("data", (d: Buffer) => (seen.out += d.toString("utf8")));
  adapter.stderr.on("data", (d: Buffer) => (seen.err += d.toString("utf8")));
  const errors: string[] = [];
  adapter.on("error", (e: Error) => errors.push(e.message));
  return { adapter, stdout, stderr, order, seen, errors };
}

describe("a TRIP closes the pipes", () => {
  it("MUTATION TARGET: kill(true) destroys the raw stdout", () => {
    const { adapter, stdout } = make();
    adapter.kill(true);
    expect(stdout.destroyed).toBe(true);
  });

  it("MUTATION TARGET: kill(true) destroys the raw stderr", () => {
    const { adapter, stderr } = make();
    adapter.kill(true);
    expect(stderr.destroyed).toBe(true);
  });

  it("MUTATION TARGET: kill(true) unpipes both raw streams (no data listener is left on them)", () => {
    const { adapter, stdout, stderr } = make();
    expect(stdout.listenerCount("data")).toBeGreaterThan(0);
    adapter.kill(true);
    expect(stdout.listenerCount("data")).toBe(0);
    expect(stderr.listenerCount("data")).toBe(0);
  });

  it("MUTATION TARGET: the pipes are closed BEFORE the child is signalled, and a second trip is harmless", () => {
    const { adapter, order } = make();
    adapter.kill(true);
    adapter.kill(true);
    expect(order).toEqual(["kill-after-destroy", "kill-after-destroy"]);
  });

  it("MUTATION TARGET: each guard trip (stdout flood, stderr flood, line cap, cpu budget) closes the pipes", async () => {
    const spy = jest.spyOn(performance, "now").mockImplementation(() => 5000);
    try {
      const flood = make(new CpuMeter(1e9, 1e9));
      for (let i = 0; i < 2500; i++) flood.stdout.write(" ");
      await new Promise((r) => setImmediate(r));
      expect(flood.errors).toEqual(["stdout_flood"]);
      expect(flood.stdout.destroyed).toBe(true);

      const err = make(new CpuMeter(1e9, 1e9));
      for (let i = 0; i < 2500; i++) err.stderr.write("y");
      expect(err.errors).toEqual(["stderr_flood"]);
      expect(err.stderr.destroyed && err.stdout.destroyed).toBe(true);

      const cap = make(new CpuMeter(1e9, 1e9));
      cap.stdout.write('{"a":"' + "x".repeat(2 * (1 << 20)));
      await new Promise((r) => setImmediate(r));
      expect(cap.errors).toEqual(["stdout_line_too_long"]);
      expect(cap.stdout.destroyed).toBe(true);

      const budget = make(new CpuMeter(10, 0));
      budget.stdout.write('{"a":1}\n'); // the 0.08 ms per read, over and over, is more than 10 ms
      for (let i = 0; i < 200; i++) budget.stdout.write('{"a":1}\n');
      await new Promise((r) => setImmediate(r));
      expect(budget.errors).toContain("cpu_budget");
      expect(budget.stdout.destroyed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a PLAIN kill leaves the pipes open and drains", () => {
  it("MUTATION TARGET: kill() does not destroy or unpipe the raw streams, and the child is signalled with them open", () => {
    const { adapter, stdout, stderr, order } = make();
    adapter.kill();
    expect(stdout.destroyed).toBe(false);
    expect(stderr.destroyed).toBe(false);
    expect(stdout.listenerCount("data")).toBeGreaterThan(0);
    expect(stderr.listenerCount("data")).toBeGreaterThan(0);
    expect(order).toEqual(["kill-with-pipes-open"]);
  });

  it("MUTATION TARGET: a child that writes during its grace period is read without error, and what it writes is discarded: not parsed, not forwarded, not charged", async () => {
    const meter = new CpuMeter(2000, 0);
    const { adapter, stdout, stderr, seen } = make(meter);
    adapter.kill();
    const before = meter.remaining;
    let writeErrors = 0;
    stdout.on("error", () => writeErrors++);
    stderr.on("error", () => writeErrors++);
    for (let i = 0; i < 50; i++) {
      stdout.write('{"type":"assistant"}\n');
      stderr.write("goodbye\n");
    }
    await new Promise((r) => setImmediate(r));
    expect(writeErrors).toBe(0);
    expect(seen).toEqual({ out: "", err: "" });
    expect(meter.remaining).toBe(before); // nothing was charged (the meter has no refill here)
  });

  it("MUTATION TARGET: a trip after a plain kill still closes the pipes", () => {
    const { adapter, stdout } = make();
    adapter.kill();
    adapter.kill(true);
    expect(stdout.destroyed).toBe(true);
  });
});
