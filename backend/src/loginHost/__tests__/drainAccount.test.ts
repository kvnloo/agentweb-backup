/**
 * ENG-2113 (review F1): after a PLAIN kill (normal close, idle retirement) the child's output is still read and dropped unparsed, so a CLI winding down never gets
 * EPIPE, but the accounting stays on: a writer that ignores SIGTERM for the whole grace period (up to 10 s) must not be free. Real child processes; the plain kill
 * sends SIGTERM and the forced SIGKILL lands 4 s later, as systemd does. Utilisation is measured from the kill itself (the accounting's burst is inside the window).
 */
import { spawn, type ChildProcess } from "child_process";
import { PassThrough } from "stream";
import { createInterface } from "readline";
import { performance } from "perf_hooks";
import type { ChildLike } from "../adapter";
import { DRAIN_READ_BURST, RunnerChildAdapter } from "../adapters/claudeAdapter";
import { CpuMeter } from "../relay/cpuMeter";

jest.setTimeout(60_000);

// Every process this file spawns is SIGKILLed when the file ends, whatever the tests did (a failed assertion used to leave a SIGTERM-ignoring writer spinning for hours).
const spawned: ChildProcess[] = [];
afterAll(() => {
  for (const p of spawned) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

// A SIGTERM-ignoring writer that starts flooding only once it is signalled (the plain kill sends SIGTERM here; SIGKILL lands 4 s later, as systemd does after its grace).
function drainChild(flood: string): { child: ChildLike; alive: () => boolean } {
  const script = 'const fs=require("fs");const w=(fd,b)=>{try{fs.writeSync(fd,b)}catch(e){}};process.on("SIGTERM",()=>{' + flood + '});setInterval(()=>{},1000);';
  const proc = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  spawned.push(proc);
  proc.stdin.on("error", () => undefined);
  return {
    child: {
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      kill: () => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 4000);
      },
      onExit: (cb) => void proc.on("exit", cb),
      onError: (cb) => void proc.on("error", cb),
    },
    alive: () => proc.exitCode === null && proc.signalCode === null,
  };
}
const DRAINERS: Array<[string, string]> = [
  ["stdout one byte at a time", 'for(;;){w(1,"x")}'],
  ["stdout 64 KiB junk lines", 'const b=Buffer.from(("x".repeat(80)+"\\n").repeat(800));for(;;){w(1,b)}'],
  ["stdout 64 KiB with no newline", 'const b=Buffer.alloc(65536,120);for(;;){w(1,b)}'],
  ["stderr one byte at a time", 'for(;;){w(2,"y")}'],
  ["stderr 64 KiB writes", 'const b=Buffer.alloc(65536,121);for(;;){w(2,b)}'],
  ["valid events", 'const b=Buffer.from(\'{"type":"x","a":[1,2,3]}\\n\'.repeat(2));for(;;){w(1,b)}'],
];

describe("a hostile writer that ignores SIGTERM after a PLAIN kill is still bounded (drain-mode accounting)", () => {
  it.each(DRAINERS)("MUTATION TARGET: %s", async (name, flood) => {
    const { child, alive } = drainChild(flood);
    const adapter = new RunnerChildAdapter(child, 16 * 1024 * 1024, undefined, new CpuMeter());
    adapter.on("error", () => undefined);
    createInterface({ input: adapter.stdout }).on("line", () => undefined);
    adapter.stderr.on("data", () => undefined);
    await new Promise((r) => setTimeout(r, 400)); // the child is up and idle
    const elu0 = performance.eventLoopUtilization(); // from the plain kill itself: the drain accounting's burst is inside the window
    adapter.kill(); // the plain kill: SIGTERM now, SIGKILL in 4 s
    await new Promise((r) => setTimeout(r, 3200));
    const after = performance.eventLoopUtilization(elu0);
    const closed = (adapter as unknown as { pipesClosed: boolean }).pipesClosed;
    console.log("RESULT cpu drain", name, JSON.stringify({ utilFirst3s: Math.round(after.utilization * 1000) / 1000, pipesClosed: closed, writerStillAlive: alive() }));
    expect(alive()).toBe(true); // still running (ignoring SIGTERM) while we measure
    expect(closed).toBe(true); // the accounting tripped and closed the pipes
    expect(after.utilization).toBeLessThan(0.7); // 0.96-0.99 without the accounting; the bound is loose because a starved runner counts descheduling as busy. `closed` above is the pin
    await new Promise((r) => setTimeout(r, 1000));
    expect(alive()).toBe(false); // and the forced kill still lands
  });
});


describe("the drain accounting's limits (in-process, exact)", () => {
  function plain() {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child: ChildLike = { stdin: new PassThrough(), stdout, stderr, kill: () => undefined, onExit: () => undefined };
    const adapter = new RunnerChildAdapter(child, 1 << 20, undefined, new CpuMeter());
    adapter.on("error", () => undefined);
    adapter.stdout.resume();
    adapter.stderr.resume();
    adapter.kill(); // plain
    return { adapter, stdout, stderr, closed: () => (adapter as unknown as { pipesClosed: boolean }).pipesClosed };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  it("MUTATION TARGET: a child that writes a normal goodbye (a few KiB in a handful of reads) never has its pipes closed: no EPIPE for an honest CLI", async () => {
    const t = plain();
    for (let i = 0; i < 20; i++) {
      t.stdout.write('{"type":"result"}\n');
      t.stderr.write("shutting down\n");
    }
    await tick();
    expect(t.closed()).toBe(false);
    expect(t.stdout.destroyed).toBe(false);
  });

  it("MUTATION TARGET: the READ limit: just inside the burst the pipes stay open, a few hundred reads past it they are closed", async () => {
    const spy = jest.spyOn(performance, "now").mockImplementation(() => 5000);
    try {
      const inside = plain();
      for (let i = 0; i < DRAIN_READ_BURST - 20; i++) inside.stdout.write("x");
      await tick();
      expect(inside.closed()).toBe(false);
      const past = plain();
      for (let i = 0; i < DRAIN_READ_BURST + 50; i++) past.stdout.write("x");
      await tick();
      expect(past.closed()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("MUTATION TARGET: the BYTE limit: far fewer reads than the read limit, but past the byte burst, closes the pipes", async () => {
    const spy = jest.spyOn(performance, "now").mockImplementation(() => 5000);
    try {
      const inside = plain();
      for (let i = 0; i < 8; i++) inside.stderr.write(Buffer.alloc(256 * 1024));
      await tick();
      expect(inside.closed()).toBe(false);
      const past = plain();
      for (let i = 0; i < 40; i++) past.stderr.write(Buffer.alloc(256 * 1024)); // 10 MiB in 40 reads: 2.5 x the 4 MiB burst (a literal, so a changed constant is noticed)
      await tick();
      expect(past.closed()).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
