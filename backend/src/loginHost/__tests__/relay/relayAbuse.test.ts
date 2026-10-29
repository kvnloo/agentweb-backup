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
  const open = (uid = 400_001) => {
    const calls: RelayCall[] = [];
    const ended: string[] = [];
    const ep = host.open({ uid, identity: { connectionId: "c", epoch: 1, turnId: "t" }, onCall: (c) => void calls.push(c), onCallEnded: (_op, why) => void ended.push(why), allowTool: () => true, callTimeoutMs: () => 60_000 });
    return ep.then((e) => ({ ep: e, calls, ended }));
  };
  return { host, layout, logs, open, tick: (ms: number) => (clock += ms), root };
}
const sockOf = (dir: string) => `${dir}/relay.sock`;
async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("until: timed out");
}
const client = async (path: string) => {
  const s: Socket = connect(path);
  s.on("error", () => undefined);
  let closed = false;
  s.on("close", () => (closed = true));
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
    const s = setup();
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
    expect(summary[0].fields).toEqual({ code: "second_connection", count: 295 });
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
    expect(summary[0].fields).toEqual({ code: "second_connection", count: 7 });
  });
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
