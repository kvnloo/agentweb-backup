/**
 * ENG-2110: the deploy's idle gate (drainGate.ts) and its CLI (deployCtl.ts). The logic runs against a REAL ConnectionManager (fake clock, so a
 * 30-minute wait takes no time); the CLI is bundled with esbuild exactly like the build does and run against a REAL host server on a unix socket.
 */
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildSync } from "esbuild";
import { acquireIdle, waitHealthy, type GateDeps, type GateOptions } from "../../deploy/prod/drainGate";
import { PROTOCOL_VERSION } from "../../protocol";
import { startHostServer, type HostServerHandle } from "../../server";
import { drain as drainEvents, makeRig, signIn, turnReq, type Rig } from "../helpers";

const OPTS: GateOptions = { pollSec: 3, totalSec: 1800, strictTtlSec: 120 };

describe("acquireIdle", () => {
  let rig: Rig;
  let lines: string[];
  afterEach(() => rig?.cleanup());

  /** Gate deps over the real manager; `sleep` advances the manager's clock and may run a hook (a turn finishing, say). */
  function deps(onSleep: (sleptMs: number) => void = () => undefined): GateDeps & { drains: string[]; slept: () => number } {
    lines = [];
    const drains: string[] = [];
    let slept = 0;
    return {
      drains,
      slept: () => slept,
      drain: async (mode, ttlSec) => {
        drains.push(mode);
        return rig.mgr.setDrain({ mode, ttlSec });
      },
      sleep: async (ms) => {
        slept += ms;
        rig.clock.advance(ms);
        onSleep(slept);
      },
      now: () => rig.clock.nowMs(),
      log: (l) => void lines.push(l),
    };
  }

  it("an idle host is acquired at once, and from then on refuses new work", async () => {
    rig = makeRig();
    await signIn(rig);
    const d = deps();
    expect(await acquireIdle(OPTS, d)).toEqual({ result: "acquired", waitedSec: 0 });
    expect(d.drains).toEqual(["strict"]);
    await expect(rig.mgr.runTurn(turnReq("conn1", 1))).rejects.toMatchObject({ code: "EBUSY", detail: "draining" });
  });

  it("waits for a running turn to finish on its own, never touching it, then acquires", async () => {
    rig = makeRig();
    await signIn(rig);
    let release!: () => void;
    rig.script.turnEvents = [{ wait: new Promise<void>((r) => (release = r)) }, { type: "result", ok: true, text: "done" }];
    const started = await rig.mgr.runTurn(turnReq("conn1", 1));
    const events = drainEvents(started.events!);
    const d = deps((ms) => {
      if (ms >= 60_000) release(); // the customer's turn ends after a minute
    });
    const r = await acquireIdle(OPTS, d);
    expect(r.result).toBe("acquired");
    expect(r).toMatchObject({ waitedSec: expect.any(Number) });
    expect((await events).some((e) => e.type === "result" && e.ok)).toBe(true); // it ran to completion
    expect(rig.script.interrupts).toBe(0);
    expect(rig.script.interruptedTurns).toEqual([]);
  });

  it("a turn that never ends: gives up at the limit, lifts the drain, kills nothing, says 'not idle'", async () => {
    rig = makeRig();
    await signIn(rig);
    rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
    await rig.mgr.runTurn(turnReq("conn1", 1));
    const d = deps();
    const r = await acquireIdle({ ...OPTS, totalSec: 600 }, d);
    expect(r).toMatchObject({ result: "not_idle", running: 1 });
    expect(rig.mgr.hostStatus()).toMatchObject({ drain: "off", running: 1 }); // drain lifted, the turn still running
    expect(rig.script.interrupts).toBe(0);
    expect(rig.fs.killed ?? []).toEqual([]); // nothing was killed
    expect(lines.some((l) => l.includes("Nothing was changed or restarted"))).toBe(true);
  });

  it("a host that is still starting up (not listening yet) is 'not yet', and the gate succeeds once it is up", async () => {
    rig = makeRig();
    let calls = 0;
    const d = deps();
    const real = d.drain;
    d.drain = async (mode, ttl) => {
      if (++calls <= 3) throw Object.assign(new Error("connect ECONNREFUSED"), { notReady: true });
      return real(mode, ttl);
    };
    expect(await acquireIdle(OPTS, d)).toMatchObject({ result: "acquired" });
    expect(lines.some((l) => l.includes("not listening yet"))).toBe(true);
  });

  it("a host that never starts listening is 'not idle' at the limit (nothing restarted), not an error", async () => {
    rig = makeRig();
    const d = deps();
    d.drain = async (mode) => {
      if (mode === "off") return { mode: "off", running: 0, signIns: 0, ok: true };
      throw Object.assign(new Error("connect ENOENT"), { notReady: true });
    };
    expect(await acquireIdle({ ...OPTS, totalSec: 60 }, d)).toMatchObject({ result: "not_idle" });
  });

  it("a host that cannot be reached is an error, not 'not idle' (the caller restarts nothing either way)", async () => {
    rig = makeRig();
    const d = deps();
    d.drain = async () => {
      throw new Error("connect ENOENT");
    };
    await expect(acquireIdle(OPTS, d)).rejects.toThrow("ENOENT");
  });
});

describe("waitHealthy", () => {
  const mk = (answers: Array<() => Promise<{ protocol: number; drain?: string }>>) => {
    let t = 0;
    const lines: string[] = [];
    return {
      lines,
      deps: {
        info: async () => (answers.length > 1 ? answers.shift()! : answers[0])(),
        sleep: async (ms: number) => void (t += ms),
        now: () => t,
        log: (l: string) => void lines.push(l),
      },
    };
  };
  const ok = (protocol: number, drain = "off") => async () => ({ protocol, drain });
  const down = async () => {
    throw new Error("connect ECONNREFUSED");
  };

  it("waits through the restart (refused, refused, then up) and succeeds", async () => {
    const m = mk([down, down, ok(PROTOCOL_VERSION)]);
    expect(await waitHealthy(PROTOCOL_VERSION, 60, m.deps)).toBe(true);
  });
  it("an OLD build still answering (wrong protocol) is not healthy", async () => {
    const m = mk([ok(PROTOCOL_VERSION - 1)]);
    expect(await waitHealthy(PROTOCOL_VERSION, 5, m.deps)).toBe(false);
    expect(m.lines.join()).toContain("expected protocol");
  });
  it("a host still drained (it did not restart) is not healthy", async () => {
    expect(await waitHealthy(PROTOCOL_VERSION, 5, mk([ok(PROTOCOL_VERSION, "strict")]).deps)).toBe(false);
  });
  it("never answering is not healthy, within the timeout", async () => {
    expect(await waitHealthy(PROTOCOL_VERSION, 5, mk([down]).deps)).toBe(false);
  });
  it("after a rollback any protocol is fine, as long as it is up and undrained", async () => {
    expect(await waitHealthy("any", 5, mk([ok(PROTOCOL_VERSION - 1)]).deps)).toBe(true);
    expect(await waitHealthy("any", 5, mk([ok(1, "strict")]).deps)).toBe(false);
  });
});

describe("deployctl (the bundled CLI against a real host socket)", () => {
  let dir: string;
  let rig: Rig;
  let handle: HostServerHandle;
  let bundle: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "deployctl-"));
    bundle = join(dir, "deployctl.js");
    buildSync({ entryPoints: [join(__dirname, "../../deploy/prod/deployCtl.ts")], bundle: true, platform: "node", target: "node22", outfile: bundle, logLevel: "error" });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(async () => {
    rig = makeRig();
    handle = await startHostServer(rig.mgr, { socketPath: join(dir, "host.sock"), socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 });
  });
  afterEach(async () => {
    await handle.close();
    rig.cleanup();
  });

  const ctl = (...args: string[]) =>
    new Promise<{ rc: number | null; out: string }>((resolve) => {
      const p = spawn(process.execPath, [bundle, join(dir, "host.sock"), ...args]);
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (rc) => resolve({ rc, out }));
    });

  it("info prints the host's state; health succeeds against this build", async () => {
    const info = await ctl("info");
    expect(info.rc).toBe(0);
    expect(JSON.parse(info.out)).toMatchObject({ protocol: PROTOCOL_VERSION, drain: "off", running: 0 });
    expect((await ctl("health", "--timeout", "5")).rc).toBe(0);
  });

  it("acquire on an idle host exits 0 and the host then refuses new sign-ins; release lets it work again", async () => {
    expect((await ctl("acquire", "--total", "10")).rc).toBe(0);
    expect(rig.mgr.hostStatus().drain).toBe("strict");
    expect((await ctl("health", "--timeout", "2")).rc).toBe(1); // drained means 'not serving yet'
    expect((await ctl("release")).rc).toBe(0);
    expect(rig.mgr.hostStatus().drain).toBe("off");
  });

  it("acquire on a busy host exits 75, leaves the turn running and the host undrained", async () => {
    await signIn(rig);
    rig.script.turnEvents = [{ wait: new Promise<void>(() => undefined) }];
    await rig.mgr.runTurn(turnReq("conn1", 1));
    const r = await ctl("acquire", "--total", "2", "--poll", "1");
    expect(r.rc).toBe(75);
    expect(r.out).toContain("1 turn(s) running");
    expect(rig.mgr.hostStatus()).toMatchObject({ drain: "off", running: 1 });
  }, 20_000);

  it("a missing socket is exit 1 with a readable reason, never a hang", async () => {
    await handle.close();
    const r = await ctl("info");
    expect(r.rc).toBe(1);
    expect(r.out).toContain("deploy:");
    handle = await startHostServer(rig.mgr, { socketPath: join(dir, "host.sock"), socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 });
  });

  it("a host that predates host.drain (unknown route) is exit 76, not a failure and not a restart", async () => {
    // an old host answers an unknown route exactly like this
    await handle.close();
    const { createServer } = await import("http");
    const old = createServer((_req, res) => res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "EINVALID", detail: "route" })));
    await new Promise<void>((r) => old.listen(join(dir, "host.sock"), r));
    const r = await ctl("acquire", "--total", "5");
    await new Promise((res) => old.close(res));
    expect(r.rc).toBe(76);
    expect(r.out).toContain("predates");
    handle = await startHostServer(rig.mgr, { socketPath: join(dir, "host.sock"), socketMode: 0o660, tickMs: 3_600_000, sweepMs: 3_600_000 });
  });

  it("--strict-ttl is honoured (the drain must outlive the install)", async () => {
    expect((await ctl("acquire", "--total", "5", "--strict-ttl", "300")).rc).toBe(0);
    rig.clock.advance(250_000);
    expect(rig.mgr.hostStatus().drain).toBe("strict");
    rig.clock.advance(60_000);
    expect(rig.mgr.hostStatus().drain).toBe("off");
  });

  it("an unknown or misspelt option is refused, never silently replaced by a default (the drain would quietly be shorter than deploy.sh asked)", async () => {
    for (const args of [["acquire", "--strict-tll", "900"], ["acquire", "--soft-after", "5"], ["health", "--timeuot", "5"], ["release", "--force"], ["info", "x"]]) {
      const r = await ctl(...args);
      expect({ args, rc: r.rc }).toEqual({ args, rc: 1 });
      expect(r.out).toContain("unknown option");
    }
    expect(rig.mgr.hostStatus().drain).toBe("off");
  });

  it("bad usage is exit 2", async () => {
    expect((await ctl("nonsense")).rc).toBe(2);
  });
});
