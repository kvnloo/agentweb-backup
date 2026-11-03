/**
 * ENG-2113 (final security review): the CLI's stdout through the REAL RunnerChildAdapter -> readline -> JSON.parse pipeline (what the runner does with every line).
 * Each case prints a RESULT line with the measured numbers; the assertions are bounds that hold with a wide margin on a loaded machine.
 *
 * Measured BEFORE the fix (one case each): a 16 MB array of `0` = 488 ms of event-loop lag and +357 MB RSS per line; a 15 MB array of `{}` = 1.73 s and +1.3 GB per
 * line; 1 MiB string lines at the scanner's pace = event-loop utilization 0.98 and never any stdout_flood; `{` + 70 `[` lines = 131,040 deep lines, 131,040
 * JSON.parse exceptions in 3 s, no stdout_flood.
 */
import { createInterface } from "readline";
import { PassThrough } from "stream";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import type { ChildLike } from "../adapter";
import { RunnerChildAdapter } from "../adapters/claudeAdapter";

jest.setTimeout(120_000);

function rig(maxLine = 16 * 1024 * 1024) {
  const stdout = new PassThrough();
  const child: ChildLike = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => undefined, onExit: () => undefined };
  const deep: number[] = [];
  const adapter = new RunnerChildAdapter(child, maxLine, () => deep.push(1));
  const errors: string[] = [];
  adapter.on("error", (e: Error) => errors.push(e.message));
  let lines = 0;
  let parsed = 0;
  let thrown = 0;
  let parsedBytes = 0;
  createInterface({ input: adapter.stdout }).on("line", (l) => {
    lines++;
    if (!l.trim()) return;
    try {
      JSON.parse(l);
      parsed++;
      parsedBytes += l.length;
    } catch {
      thrown++;
    }
  });
  return { stdout, errors, deep, stats: () => ({ lines, parsed, thrown, parsedMB: Math.round(parsedBytes / 1e6) }) };
}

async function pump(r: ReturnType<typeof rig>, chunk: Buffer, opts: { maxWrites: number; maxMs: number; perTick?: number }) {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const rss0 = process.memoryUsage().rss;
  let maxRss = rss0;
  const t0 = performance.now();
  let writes = 0;
  while (writes < opts.maxWrites && performance.now() - t0 < opts.maxMs && !r.errors.length) {
    for (let i = 0; i < (opts.perTick ?? 1); i++) {
      r.stdout.write(chunk);
      writes++;
    }
    await new Promise((res) => setImmediate(res));
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }
  await new Promise((res) => setTimeout(res, 150));
  h.disable();
  return { writes, ms: Math.round(performance.now() - t0), maxLagMs: Math.round(h.max / 1e6), rssMB: Math.round((maxRss - rss0) / 1e6) };
}

describe("valid giant event lines", () => {
  it.each([
    ["array of 8M zeros (16 MB line)", () => '{"type":"x","a":[' + "0,".repeat(8_000_000 - 4) + "0]}\n", 4],
    ["array of 5M {} (15 MB line)", () => '{"type":"x","a":[' + "{},".repeat(5_000_000) + "{}]}\n", 2],
  ])("MUTATION TARGET: %s is dropped before the runner parses it (too many values), never forwarded", async (name, mk, count) => {
    const r = rig();
    const m = await pump(r, Buffer.from(mk()), { maxWrites: count, maxMs: 20_000 });
    console.log("RESULT giant", name, JSON.stringify({ ...m, ...r.stats(), errors: r.errors }));
    expect(r.stats().parsed).toBe(0);
    expect(r.stats().thrown).toBe(0);
    expect(m.maxLagMs).toBeLessThan(2500); // 488 ms (zeros) and 1,730 ms ({}) of lag per line before, on an idle box; a catastrophe bound (the box may be loaded): parsed === 0 and the memory below are the structural pins
    expect(m.rssMB).toBeLessThan(200); // +357 MB and +1.3 GB per line before
  });

  it("MUTATION TARGET: sustained 1 MiB string lines end the stream on the BYTE budget (stdout_flood) after the burst, not after thousands of lines", async () => {
    const r = rig();
    const line = Buffer.from('{"type":"user","s":"' + "a".repeat(1024 * 1024 - 30) + '"}\n');
    const m = await pump(r, line, { maxWrites: 400, maxMs: 30_000 });
    console.log("RESULT strings", JSON.stringify({ ...m, ...r.stats(), errors: r.errors }));
    expect(r.errors).toHaveLength(1);
    expect(["stdout_flood", "cpu_budget"]).toContain(r.errors[0]); // the byte bucket ends it; on a loaded machine the CPU meter (2 s of loop) may get there first
    // The byte bucket refills on the WALL clock (4 MiB/s), so the lines let through are the 64 MiB burst plus 4 per second the pump took (+2 for the line that was
    // in flight): a fixed 72 holds only if the pump finishes within 2 s, which a starved runner does not. 400 lines is what a missing bucket would let through.
    const allowed = Math.ceil(64 + (4 * m.ms) / 1000) + 2; // literals on purpose: a changed constant is noticed (burst 64 MiB, refill 4 MiB/s)
    expect(r.stats().parsed).toBeLessThanOrEqual(allowed);
  });

  it("an honest stream is untouched: a few big result lines and many small events in 3 s", async () => {
    const r = rig();
    const big = Buffer.from('{"type":"user","c":"' + "r".repeat(7 * 1024 * 1024) + '"}\n'); // a tool result near the 8 MiB cap
    const small = Buffer.from('{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"hello"}]}}\n');
    for (let i = 0; i < 3; i++) r.stdout.write(big);
    for (let i = 0; i < 400; i++) r.stdout.write(small);
    await new Promise((res) => setTimeout(res, 600));
    expect(r.errors).toEqual([]);
    expect(r.stats().parsed).toBe(403);
  });

  it("MUTATION TARGET: 30 whitespace-only lines of 8 MB are dropped and charged to the junk byte budget (they used to pass unthrottled)", async () => {
    const r = rig();
    const spaces = Buffer.from(" ".repeat(8 * 1024 * 1024) + "\n");
    const m = await pump(r, spaces, { maxWrites: 30, maxMs: 30_000 });
    console.log("RESULT whitespace", JSON.stringify({ ...m, ...r.stats(), errors: r.errors }));
    expect(r.errors).toEqual(["stdout_flood"]);
    expect(r.stats().lines).toBe(0); // not one of them reached readline
  });
});

describe("deep lines are charged to the junk budget", () => {
  it.each([
    ["deep lines ({ + 70 [ + LF)", "{" + "[".repeat(70) + "\n"],
    ["deep lines (CR)", "{" + "[".repeat(70) + "\r"],
  ])("MUTATION TARGET: %s end the stream (stdout_flood) within the junk burst; far fewer than the 131,040 parse exceptions in 3 s before", async (name, unit) => {
    const r = rig();
    const chunk = Buffer.from(unit.repeat(Math.floor(65536 / unit.length)));
    const m = await pump(r, chunk, { maxWrites: 400, maxMs: 3000, perTick: 4 });
    console.log("RESULT deepflood", name, JSON.stringify({ ...m, ...r.stats(), deepCb: r.deep.length, errors: r.errors }));
    expect(r.errors).toEqual(["stdout_flood"]);
    expect(r.stats().thrown).toBe(0); // the truncated heads are never forwarded
    expect(r.stats().lines).toBeLessThan(2000);
  });
});
