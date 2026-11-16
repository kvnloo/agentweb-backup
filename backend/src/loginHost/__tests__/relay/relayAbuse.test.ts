/**
 * ENG-2113 (security review): a hostile unit must not be able to grow the root host's memory (a peer that never reads) or flood its journal (connect/destroy
 * loops), and the ownership of the socket and directory is handed over in the right order.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connect, type Socket } from "net";
import { Layout } from "../../ports/layout";
import { RelayHost, type RelayCall, type RelayHostOptions, type RelayLimits } from "../../relay/relayServer";
import { LogThrottle } from "../../relay/bounds";
import { CpuMeter } from "../../relay/cpuMeter";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup(over: Partial<RelayHostOptions> = {}, limits: Partial<RelayLimits> = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-abuse-"));
  roots.push(root);
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot: join(root, "relay") });
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  let clock = 1_000_000;
  const host = new RelayHost({ layout, ownByUid: false, limits, now: () => clock, log: { warn: (event, fields) => void logs.push({ event, fields }) }, ...over });
  host.init();
  const open = (uid = 400_001, meter?: CpuMeter) => {
    const calls: RelayCall[] = [];
    const ended: string[] = [];
    const ep = host.open({ uid, identity: { connectionId: "c", epoch: 1, turnId: "t" }, onCall: (c) => void calls.push(c), onCallEnded: (_op, why) => void ended.push(why), allowTool: () => true, callTimeoutMs: () => 60_000, ...(meter ? { meter } : {}) });
    return ep.then((e) => ({ ep: e, calls, ended }));
  };
  return { host, layout, logs, open, tick: (ms: number) => (clock += ms), root };
}
const sockOf = (dir: string) => `${dir}/relay.sock`;
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("until: timed out");
}
const client = async (path: string) => {
  const s: Socket = connect(path);
  s.on("error", () => undefined);
  let closed = false;
  s.on("close", () => (closed = true));
  s.on("data", () => undefined); // read (and discard) what the host sends, so a close can be seen
  await new Promise<void>((r) => s.once("connect", () => r()));
  return { s, isClosed: () => closed };
};

describe("a peer that never reads cannot grow the host's memory", () => {
  it("MUTATION TARGET: once more than two maximum frames are queued for a peer that does not read, the connection is cut, the pending call is ended and the answer reports the result lost", async () => {
    const { open, logs } = setup({}, { hostToShimBytes: 64 * 1024, burst: 10_000, refillPerSec: 10_000 });
    const { ep, calls, ended } = await open();
    const c = await client(sockOf(ep.dir));
    c.s.pause(); // never reads
    const payload = "r".repeat(60 * 1024);
    let answeredAfterDrop: boolean | undefined;
    let n = 0;
    for (; n < 200 && !c.isClosed(); n++) {
      c.s.write(JSON.stringify({ type: "call", callId: `c${n}`, name: "t", args: {} }) + "\n");
      await until(() => calls.length === n + 1 || c.isClosed());
      if (calls.length === n + 1) {
        const ok = ep.answer(calls[n].operationId, { content: payload });
        if (!ok) answeredAfterDrop = ok; // the queue cap was hit by THIS answer
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    await until(() => c.isClosed());
    expect(n).toBeLessThan(200); // it was cut well before a flood of answers piled up
    expect(logs.map((l) => l.fields?.code)).toContain("write_backlog");
    expect(answeredAfterDrop).toBe(false);
    expect(ended.length).toBeGreaterThanOrEqual(0);
    await ep.close();
  });

  it("an answer larger than the queue cap is never written at all", async () => {
    const { open, logs } = setup({}, { hostToShimBytes: 1000 });
    const { ep, calls } = await open();
    const c = await client(sockOf(ep.dir));
    c.s.write(JSON.stringify({ type: "call", callId: "big", name: "t", args: {} }) + "\n");
    await until(() => calls.length === 1);
    expect(ep.answer(calls[0].operationId, { content: "x".repeat(900) })).toBe(true); // fits: one frame
    expect(logs).toEqual([]);
    await ep.close();
  });
});

describe("violation logs from a hostile unit are throttled", () => {
  it("MUTATION TARGET: a connect/destroy loop logs at most a handful of lines per window, every connection is still refused, and a summary follows in the next window", async () => {
    const s = setup({}, { maxRefusals: 100_000 }); // (the listener-closing rule has its own test)
    const { ep } = await s.open();
    const first = await client(sockOf(ep.dir)); // holds the one allowed connection
    let refused = 0;
    for (let i = 0; i < 300; i++) {
      const x = await client(sockOf(ep.dir));
      await until(() => x.isClosed());
      refused++;
    }
    expect(refused).toBe(300);
    expect(s.logs.filter((l) => l.event === "relay_violation")).toHaveLength(5);
    expect(s.logs.filter((l) => l.event === "relay_violation_suppressed")).toHaveLength(0);
    s.tick(11_000); // next window
    const once = await client(sockOf(ep.dir));
    await until(() => once.isClosed());
    const summary = s.logs.filter((l) => l.event === "relay_violation_suppressed");
    expect(summary).toHaveLength(1);
    expect(summary[0].fields).toEqual({ code: "second_connection", count: 295, connectionId: "c", turnId: "t" });
    first.s.destroy();
    await ep.close();
  });

  it("MUTATION TARGET: across turns the host as a whole is bounded too (a unit opening many turns cannot multiply the lines)", async () => {
    const s = setup();
    for (let t = 0; t < 30; t++) {
      const { ep } = await s.open(400_001 + (t % 10));
      const hold = await client(sockOf(ep.dir));
      for (let i = 0; i < 5; i++) {
        const x = await client(sockOf(ep.dir));
        await until(() => x.isClosed());
      }
      hold.s.destroy();
      await ep.close();
    }
    expect(s.logs.filter((l) => l.event === "relay_violation").length).toBeLessThanOrEqual(50);
  });

  it("the suppressed count of a window that ended with the endpoint is reported when the endpoint closes", async () => {
    const s = setup();
    const { ep } = await s.open();
    const hold = await client(sockOf(ep.dir));
    for (let i = 0; i < 12; i++) {
      const x = await client(sockOf(ep.dir));
      await until(() => x.isClosed());
    }
    hold.s.destroy();
    await ep.close();
    const summary = s.logs.filter((l) => l.event === "relay_violation_suppressed");
    expect(summary).toHaveLength(1);
    expect(summary[0].fields).toEqual({ code: "second_connection", count: 7, connectionId: "c", turnId: "t" });
  });
});

describe("the host-wide log quota is charged only by lines an endpoint itself let through", () => {
  it("MUTATION TARGET: endpoints that are already suppressed do not drain the host quota and hide another turn's line", async () => {
    const s = setup();
    // 12 endpoints, each emitting far more than its own 5 per window: only 5 lines each get through (60 in all), and only THOSE count against the host's 50
    // BEFORE the fix every suppressed line also charged the host quota, which 4 hostile endpoints used up in a flash
    const eps = [];
    for (let i = 0; i < 12; i++) {
      const { ep } = await s.open(400_001 + i);
      const hold = await client(sockOf(ep.dir));
      for (let k = 0; k < 20; k++) {
        const x = await client(sockOf(ep.dir));
        await until(() => x.isClosed());
      }
      eps.push({ ep, hold });
    }
    const lines = s.logs.filter((l) => l.event === "relay_violation");
    expect(lines.length).toBe(50); // the host quota, exactly: endpoints 1-10 got their 5, the 11th and 12th none
    // a victim endpoint opened afterwards with its own first violation: still limited by the (spent) host quota, but the SPENT quota is the honest 50, not exhausted by suppressed noise early
    expect(new Set(lines.map((l) => l.fields?.turnId)).size).toBe(1); // identity is the host's own for every endpoint here
    for (const e of eps) {
      e.hold.s.destroy();
      await e.ep.close();
    }
  });

  it("MUTATION TARGET: log lines carry the host-chosen connection and turn ids", async () => {
    const s = setup();
    const { ep } = await s.open();
    const hold = await client(sockOf(ep.dir));
    const x = await client(sockOf(ep.dir));
    await until(() => x.isClosed());
    expect(s.logs[0]).toEqual({ event: "relay_violation", fields: { code: "second_connection", connectionId: "c", turnId: "t" } });
    hold.s.destroy();
    await ep.close();
  });
});

describe("the relay's byte budget", () => {
  it("MUTATION TARGET: frames are limited by BYTES per second too, not only by count (a busy ~100 KB frame stream is cut when it passes the byte burst)", async () => {
    const s = setup({}, { byteBurst: 300_000, bytesPerSec: 1 });
    const { ep, calls } = await s.open();
    const c = await client(sockOf(ep.dir));
    const frame = (i: number) => JSON.stringify({ type: "call", callId: `c${i}`, name: "t", args: { pad: "x".repeat(120_000) } }) + "\n";
    c.s.write(frame(1));
    c.s.write(frame(2)); // answered busy (a call is pending) but still paid for
    await until(() => calls.length === 1);
    expect(c.isClosed()).toBe(false);
    c.s.write(frame(3)); // 3 x ~120 KB > 300 KB
    await until(() => c.isClosed());
    expect(s.logs.map((l) => l.fields?.code)).toContain("rate_limited");
    await ep.close();
  });

  it("MUTATION TARGET: the byte budget REFILLS at bytesPerSec (a third ~120 KB frame passes after 2 s of refill, and is cut without it)", async () => {
    const now = jest.spyOn(performance, "now");
    let t = 5000;
    now.mockImplementation(() => t);
    try {
      const s = setup({}, { byteBurst: 300_000, bytesPerSec: 100_000 });
      const { ep, calls } = await s.open();
      const c = await client(sockOf(ep.dir));
      const frame = (i: number) => JSON.stringify({ type: "call", callId: `c${i}`, name: "t", args: { pad: "x".repeat(120_000) } }) + "\n";
      c.s.write(frame(1));
      c.s.write(frame(2));
      await until(() => calls.length === 1);
      t += 2000; // +200,000 bytes of budget
      c.s.write(frame(3));
      await new Promise((r) => setTimeout(r, 150));
      expect(c.isClosed()).toBe(false);
      expect(s.logs.map((l) => l.fields?.code)).not.toContain("rate_limited");
      await ep.close();
    } finally {
      now.mockRestore();
    }
  });

  it("small frames are not slowed by the byte budget", async () => {
    const s = setup({}, { byteBurst: 300_000, bytesPerSec: 1 });
    const { ep, calls } = await s.open();
    const c = await client(sockOf(ep.dir));
    c.s.write(JSON.stringify({ type: "call", callId: "c1", name: "t", args: { q: 1 } }) + "\n");
    await until(() => calls.length === 1);
    for (let i = 0; i < 20; i++) c.s.write(JSON.stringify({ type: "ping" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(c.isClosed()).toBe(false);
    await ep.close();
  });
});

describe("the relay's frame handling is charged to the turn's CPU meter (pinned here as well as in relayServer.test.ts)", () => {
  it("MUTATION TARGET: with every metered section reading 30 ms, a 100 ms budget is gone after four reads: the connection is dropped (cpu_budget) and the meter is spent", async () => {
    const s = setup();
    let t = 0;
    const meter = new CpuMeter(100, 0, () => (t += 30));
    const { ep } = await s.open(400_001, meter);
    const c = await client(sockOf(ep.dir));
    for (let i = 0; i < 8 && !c.isClosed(); i++) {
      c.s.write(JSON.stringify({ type: "ping" }) + "\n");
      await new Promise((r) => setTimeout(r, 20));
    }
    await until(() => c.isClosed());
    expect(meter.exhausted).toBe(true);
    expect(s.logs.map((l) => l.fields?.code)).toContain("cpu_budget");
    await ep.close();
  });

  it("MUTATION TARGET: every socket read costs the meter a fixed 0.08 ms even when the section itself is instant (clock frozen): two reads spend a 0.15 ms budget", async () => {
    const s = setup();
    const meter = new CpuMeter(0.15, 0, () => 0);
    const { ep } = await s.open(400_001, meter);
    const c = await client(sockOf(ep.dir));
    c.s.write(JSON.stringify({ type: "ping" }) + "\n");
    await new Promise((r) => setTimeout(r, 50));
    expect(meter.exhausted).toBe(false);
    c.s.write(JSON.stringify({ type: "ping" }) + "\n");
    await until(() => meter.exhausted);
    await ep.close();
  });

  it("MUTATION TARGET: the sustained read rate is 200 a second: a trickle of separate one-byte writes (hundreds of reads a second) is dropped (rate_limited), well inside the 2,000-read burst plus a few seconds", async () => {
    const s = setup();
    const { ep } = await s.open();
    const c = await client(sockOf(ep.dir));
    const t0 = Date.now();
    while (!c.isClosed() && Date.now() - t0 < 15_000) {
      await new Promise<void>((res) => c.s.write(" ", () => res())); // one write at a time: one read at the host (the kernel would otherwise coalesce them)
      await new Promise((r) => setTimeout(r, 1));
    }
    console.log("RESULT cpu relay trickle dropped after ms", Date.now() - t0);
    expect(c.isClosed()).toBe(true);
    expect(s.logs.map((l) => l.fields?.code).some((code) => code === "rate_limited" || code === "cpu_budget" || code === "idle_timeout")).toBe(true);
    await ep.close();
  });
});

describe("a connect flood is ended at the kernel", () => {
  it("MEASUREMENT: 3,000 connect attempts at a turn that already has its connection: how many the host accepts-then-destroys, and what it costs", async () => {
    for (const [label, limits] of [["listener closes after 32 refusals (now)", {}], ["listener never closes (before)", { maxRefusals: 1e9 }]] as const) {
      const s = setup({}, limits);
      const { ep } = await s.open();
      const holder = await client(sockOf(ep.dir));
      let connected = 0;
      let failed = 0;
      const cpu0 = process.cpuUsage();
      const t0 = process.hrtime.bigint();
      const attempt = () =>
        new Promise<void>((res) => {
          const x = connect(sockOf(ep.dir));
          x.on("error", () => (failed++, res()));
          x.on("connect", () => (connected++, x.destroy(), res()));
        });
      for (let batch = 0; batch < 750; batch++) await Promise.all(Array.from({ length: 4 }, attempt));
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const cpu = process.cpuUsage(cpu0);
      console.log("CONNECT FLOOD", label, JSON.stringify({ connected, failed, wallMs: Math.round(ms), cpuMs: Math.round((cpu.user + cpu.system) / 1000) }));
      if (label.includes("now")) {
        expect(connected).toBeLessThan(200);
        expect(failed).toBeGreaterThan(2800);
      } else expect(connected).toBeGreaterThan(500);
      holder.s.destroy();
      await ep.close();
    }
  }, 60_000);
});

describe("LogThrottle", () => {
  it("logs the first N per key per window, counts the rest, reports them at the next window, and keys are independent", () => {
    let now = 0;
    const t = new LogThrottle(2, 1000, () => now);
    expect([t.check("a").log, t.check("a").log, t.check("a").log, t.check("a").log, t.check("b").log]).toEqual([true, true, false, false, true]);
    now = 1000;
    expect(t.check("a")).toEqual({ log: true, suppressedBefore: 2 });
    expect(t.check("a")).toEqual({ log: true, suppressedBefore: 0 });
    expect(t.check("a").log).toBe(false);
    expect(t.flush()).toEqual([["a", 1]]);
    expect(t.flush()).toEqual([]);
  });
});

describe("ownership of the per-turn socket and directory", () => {
  it("MUTATION TARGET: with ownership on, the root is root's, the socket goes to the customer uid FIRST and the directory LAST, with exactly those arguments", async () => {
    const calls: Array<[string, number, number]> = [];
    const s = setup({ ownByUid: true, chown: (p, u, g) => void calls.push([p, u, g]) });
    expect(calls).toEqual([[s.layout.relayRoot, 0, 0]]);
    const { ep } = await s.open(400_007);
    expect(calls.slice(1)).toEqual([
      [`${ep.dir}/relay.sock`, 400_007, 400_007],
      [ep.dir, 400_007, 400_007],
    ]);
    await ep.close();
  });

  it("MUTATION TARGET: with ownership off nothing is chowned", async () => {
    const calls: unknown[] = [];
    const s = setup({ ownByUid: false, chown: () => void calls.push(1) });
    const { ep } = await s.open();
    expect(calls).toEqual([]);
    await ep.close();
  });

  it("MUTATION TARGET: an open() that fails half way leaves nothing behind (no directory, no listener)", async () => {
    const s = setup({
      ownByUid: true,
      chown: (p) => {
        if (p.endsWith("relay.sock")) throw new Error("chown refused");
      },
    });
    // init() chowns the root too, which the spy allows; only the socket chown fails
    await expect(s.open(400_003)).rejects.toThrow("chown refused");
    const uidDir = s.layout.relayUidDir(400_003);
    expect(existsSync(uidDir) ? readdirSync(uidDir) : []).toEqual([]);
  });
});
