/**
 * ENG-2113: kill() stops reading the child's pipes for good (unpipe AND destroy, both streams, idempotent), BEFORE the child is signalled: in production the signal is
 * SIGTERM with up to 10 s of grace, and a writer that survives it must not keep costing a read each. (The end-to-end version, with a real SIGTERM-ignoring writer, is in
 * cpuBudget.test.ts; these pin each part on its own.)
 */
import { PassThrough } from "stream";
import type { ChildLike } from "../adapter";
import { RunnerChildAdapter } from "../adapters/claudeAdapter";

function make() {
  const order: string[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: ChildLike = { stdin: new PassThrough(), stdout, stderr, kill: () => void order.push(stdout.destroyed && stderr.destroyed ? "kill-after-destroy" : "kill-before-destroy"), onExit: () => undefined };
  const adapter = new RunnerChildAdapter(child, 1 << 20);
  adapter.stdout.resume();
  adapter.stderr.resume();
  return { adapter, stdout, stderr, order };
}

it("MUTATION TARGET: kill() destroys the raw stdout, so nothing more is read from it", () => {
  const { adapter, stdout } = make();
  adapter.kill();
  expect(stdout.destroyed).toBe(true);
});

it("MUTATION TARGET: kill() destroys the raw stderr, so nothing more is read from it", () => {
  const { adapter, stderr } = make();
  adapter.kill();
  expect(stderr.destroyed).toBe(true);
});

it("MUTATION TARGET: kill() unpipes both raw streams from the adapter's own streams (no data listener is left on them)", () => {
  const { adapter, stdout, stderr } = make();
  expect(stdout.listenerCount("data")).toBeGreaterThan(0);
  adapter.kill();
  expect(stdout.listenerCount("data")).toBe(0);
  expect(stderr.listenerCount("data")).toBe(0);
});

it("MUTATION TARGET: the pipes are closed BEFORE the child is signalled, and a second kill is harmless", () => {
  const { adapter, order } = make();
  adapter.kill();
  adapter.kill();
  expect(order).toEqual(["kill-after-destroy", "kill-after-destroy"]);
});
