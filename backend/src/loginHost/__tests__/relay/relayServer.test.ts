/**
 * ENG-2113: the per-turn relay socket (security boundary between customer code and the host). Real unix sockets in a temp dir; ownership
 * changes are skipped (unprivileged). The unit-level isolation (a unit sees only its own bind) is systemd's; here we test what the HOST controls:
 * paths, modes, one connection, frame limits, identity, timeouts and the lifetime of the socket.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, existsSync, readdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connect, type Socket } from "net";
import { Layout } from "../../ports/layout";
import { RelayHost, resultFrameBytes, type RelayCall, type RelayEndpoint, type RelayLimits, type RelayOpenOptions } from "../../relay/relayServer";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function mkLayout(): { layout: Layout; root: string } {
  const root = mkdtempSync(join(tmpdir(), "relay-"));
  roots.push(root);
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot: join(root, "relay") });
  return { layout, root };
}

interface Rig {
  host: RelayHost;
  layout: Layout;
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  open(over?: Partial<RelayOpenOptions> & { uid?: number }): Promise<{ ep: RelayEndpoint; calls: RelayCall[]; ended: Array<[string, string]> }>;
}
function rig(limits: Partial<RelayLimits> = {}): Rig {
  const { layout } = mkLayout();
  const logs: Rig["logs"] = [];
  const host = new RelayHost({ layout, ownByUid: false, limits, log: { warn: (event, fields) => void logs.push({ event, fields }) } });
  host.init();
  return {
    host,
    layout,
    logs,
    async open(over = {}) {
      const calls: RelayCall[] = [];
      const ended: Array<[string, string]> = [];
      const ep = await host.open({
        uid: over.uid ?? 400_001,
        identity: over.identity ?? { connectionId: "conn1", epoch: 7, turnId: "turn1" },
        onCall: (c) => void calls.push(c),
        onCallEnded: (op, why) => void ended.push([op, why]),
        allowTool: over.allowTool ?? ((n) => n === "echo" || n === "slow"),
        callTimeoutMs: over.callTimeoutMs ?? (() => 5_000),
      });
      return { ep, calls, ended };
    },
  };
}

class Client {
  sock: Socket;
  lines: string[] = [];
  closed = false;
  private buf = "";
  constructor(path: string) {
    this.sock = connect(path);
    this.sock.on("data", (d) => {
      this.buf += d.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        this.lines.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
      }
    });
    this.sock.on("close", () => (this.closed = true));
    this.sock.on("error", () => undefined);
  }
  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.sock.once("connect", () => res());
      this.sock.once("error", rej);
    });
  }
  send(o: unknown): void {
    this.sock.write(JSON.stringify(o) + "\n");
  }
  raw(s: string | Buffer): void {
    this.sock.write(s);
  }
}
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("until: timed out");
}
const LATE = { name: "late", description: "d", inputSchema: { type: "object", properties: {} } };
const sockOf = (ep: RelayEndpoint) => `${ep.dir}/relay.sock`;
const call = (id = "c1", name = "echo", args: unknown = { a: 1 }) => ({ type: "call", callId: id, name, args });

describe("relay: layout and modes", () => {
  it("creates <relayRoot>/<uid>/<32 hex>/relay.sock with dir 0700 and socket 0600, and removes it on close", async () => {
    const r = rig();
    const { ep } = await r.open();
    expect(ep.dir).toMatch(new RegExp(`^${r.layout.relayRoot}/400001/[a-f0-9]{32}$`));
    expect(r.layout.isRelayDirOf(400_001, ep.dir)).toBe(true);
    expect(statSync(ep.dir).mode & 0o777).toBe(0o700);
    expect(statSync(sockOf(ep)).mode & 0o777).toBe(0o600);
    expect(statSync(`${r.layout.relayRoot}/400001`).mode & 0o777).toBe(0o711);
    await ep.close();
    expect(existsSync(ep.dir)).toBe(false);
    await ep.close(); // idempotent
  });

  it("every turn gets its own random directory (128-bit): two turns of the same uid never share a path", async () => {
    const r = rig();
    const a = await r.open();
    const b = await r.open();
    expect(a.ep.dir).not.toBe(b.ep.dir);
    expect(readdirSync(`${r.layout.relayRoot}/400001`)).toHaveLength(2);
    await a.ep.close();
    await b.ep.close();
  });

  it("init() empties a previous run's sockets", async () => {
    const r = rig();
    const { ep } = await r.open();
    r.host.init();
    expect(existsSync(ep.dir)).toBe(false);
    await ep.close();
  });

  it("the layout refuses a relay directory that is not exactly one turn directory of THIS uid (the unit would otherwise bind something else)", () => {
    const { layout } = mkLayout();
    const ok = layout.relayTurnDir(400_001, "a".repeat(32));
    expect(layout.isRelayDirOf(400_001, ok)).toBe(true);
    expect(layout.isRelayDirOf(400_002, ok)).toBe(false); // another uid's directory
    expect(layout.isRelayDirOf(400_001, layout.relayRoot)).toBe(false);
    expect(layout.isRelayDirOf(400_001, layout.relayUidDir(400_001))).toBe(false);
    expect(layout.isRelayDirOf(400_001, ok + "/relay.sock")).toBe(false);
    expect(layout.isRelayDirOf(400_001, `${layout.relayUidDir(400_001)}/../400002/${"a".repeat(32)}`)).toBe(false);
    expect(() => layout.relayTurnDir(400_001, "../x")).toThrow();
  });
});

describe("relay: path construction guards", () => {
  it("MUTATION TARGET: relayTurnDir refuses, by itself, anything that is not exactly 32 lowercase hex characters", () => {
    const { layout } = mkLayout();
    const ok = "0123456789abcdef0123456789abcdef";
    expect(layout.relayTurnDir(400_001, ok)).toBe(`${layout.relayRoot}/400001/${ok}`);
    for (const bad of ["", "../x", "..", ".", "a/b", `${ok}/..`, `../${ok.slice(3)}`, ok.toUpperCase(), ok.slice(1), ok + "0", "g".repeat(32), "0123456789abcdef0123456789abcde-", `${ok}\n`, " " + ok.slice(1), "%2e%2e/x".padEnd(32, "0"), 5 as unknown as string]) {
      expect(() => layout.relayTurnDir(400_001, bad)).toThrow();
    }
  });

  it("MUTATION TARGET: the turn directory is created exclusively: a planted colliding directory (or file, or link) is refused, never reused", async () => {
    const { layout } = mkLayout();
    const fixed = "feedfacefeedfacefeedfacefeedface";
    const host = new RelayHost({ layout, ownByUid: false, randomHex: () => fixed });
    host.init();
    const planted = layout.relayTurnDir(400_001, fixed);
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "relay.sock"), "planted");
    const opts = { uid: 400_001, identity: { connectionId: "c", epoch: 1, turnId: "t" }, onCall: () => undefined, allowTool: () => true, callTimeoutMs: () => 1000 };
    await expect(host.open(opts)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(join(planted, "relay.sock"), "utf8")).toBe("planted"); // untouched
    // a second open with the same id while the first is live also fails and leaves the first working
    rmSync(planted, { recursive: true });
    const first = await host.open(opts);
    await expect(host.open(opts)).rejects.toMatchObject({ code: "EEXIST" });
    expect(existsSync(`${first.dir}/relay.sock`)).toBe(true);
    await first.close();
  });
});

describe("relay: calls and identity", () => {
  it("a call becomes onCall with the identity given at open(), a host-generated 128-bit operationId and the args; the answer reaches the shim", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call("shim-1", "echo", { q: "x" }));
    await until(() => calls.length === 1);
    expect(calls[0].identity).toEqual({ connectionId: "conn1", epoch: 7, turnId: "turn1" });
    expect(calls[0].operationId).toMatch(/^[a-f0-9]{32}$/);
    expect(calls[0].operationId).not.toContain("shim-1");
    expect(calls[0].name).toBe("echo");
    expect(calls[0].args).toEqual({ q: "x" });
    expect(ep.answer(calls[0].operationId, { content: "hi", images: [{ mimeType: "image/png", data: "AAAA" }], tools: [LATE] })).toBe(true);
    await until(() => c.lines.length === 1);
    expect(JSON.parse(c.lines[0])).toEqual({ type: "result", callId: "shim-1", content: "hi", isError: false, images: [{ mimeType: "image/png", data: "AAAA" }], tools: [LATE] });
    await ep.close();
  });

  it("operation ids are unique across many calls and across turns", async () => {
    const r = rig();
    const ids = new Set<string>();
    for (let t = 0; t < 2; t++) {
      const { ep, calls } = await r.open();
      const c = new Client(sockOf(ep));
      await c.ready();
      for (let i = 0; i < 10; i++) {
        c.send(call(`c${i}`));
        await until(() => calls.length === i + 1);
        ids.add(calls[i].operationId);
        ep.answer(calls[i].operationId, { content: "ok" });
        await until(() => c.lines.length === i + 1);
      }
      await ep.close();
    }
    expect(ids.size).toBe(20);
  });

  it("identity is never taken from a frame: a frame that carries identity fields is a violation, and the connection is dropped", async () => {
    for (const extra of [{ connectionId: "other" }, { epoch: 9 }, { turnId: "x" }, { uid: 0 }, { operationId: "a".repeat(32) }]) {
      const r = rig();
      const { ep, calls } = await r.open();
      const c = new Client(sockOf(ep));
      await c.ready();
      c.send({ ...call(), ...extra });
      await until(() => c.closed);
      expect(calls).toHaveLength(0);
      expect(r.logs.map((l) => l.fields?.code)).toContain("bad_frame");
      await ep.close();
    }
  });

  it("a tool the turn does not offer (not in the visible set) is answered with an error frame and never reaches onCall", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call("c1", "secret_tool"));
    await until(() => c.lines.length === 1);
    expect(JSON.parse(c.lines[0])).toEqual({ type: "error", callId: "c1", code: "unknown_tool" });
    expect(calls).toHaveLength(0);
    await ep.close();
  });

  it("one pending operation per turn: a second call while one is pending is answered busy and not forwarded", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call("c1"));
    await until(() => calls.length === 1);
    c.send(call("c2"));
    await until(() => c.lines.length === 1);
    expect(JSON.parse(c.lines[0])).toMatchObject({ type: "error", callId: "c2", code: "busy" });
    expect(calls).toHaveLength(1);
    await ep.close();
  });

  it("answering an unknown, already answered or foreign operation returns false", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const other = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call());
    await until(() => calls.length === 1);
    expect(ep.answer("0".repeat(32), { content: "x" })).toBe(false);
    expect(other.ep.answer(calls[0].operationId, { content: "x" })).toBe(false); // another turn's endpoint
    expect(ep.answer(calls[0].operationId, { content: "x" })).toBe(true);
    expect(ep.answer(calls[0].operationId, { content: "x" })).toBe(false);
    await ep.close();
    await other.ep.close();
  });
});

describe("relay: limits and abuse", () => {
  it("a second concurrent connection is refused before a byte is read; the first keeps working", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const a = new Client(sockOf(ep));
    await a.ready();
    const b = new Client(sockOf(ep));
    await b.ready().catch(() => undefined);
    await until(() => b.closed);
    expect(r.logs.map((l) => l.fields?.code)).toContain("second_connection");
    a.send(call());
    await until(() => calls.length === 1);
    await ep.close();
  });

  it("after the shim disconnects a new connection is accepted (a restarted shim), up to a per-turn total", async () => {
    const r = rig({ maxConnectionsPerTurn: 2 });
    const { ep } = await r.open();
    const a = new Client(sockOf(ep));
    await a.ready();
    a.sock.destroy();
    await new Promise((res) => setTimeout(res, 50));
    const b = new Client(sockOf(ep));
    await b.ready();
    b.sock.destroy();
    await new Promise((res) => setTimeout(res, 50));
    const c = new Client(sockOf(ep));
    await c.ready().catch(() => undefined);
    await until(() => c.closed);
    expect(r.logs.map((l) => l.fields?.code)).toContain("connection_refused");
    await ep.close();
  });

  it("an oversize frame (shim -> host cap) drops the connection, with or without a newline", async () => {
    for (const withNewline of [true, false]) {
      const r = rig({ shimToHostBytes: 1024 });
      const { ep, calls } = await r.open();
      const c = new Client(sockOf(ep));
      await c.ready();
      c.raw(JSON.stringify(call("c1", "echo", { pad: "x".repeat(2000) })) + (withNewline ? "\n" : ""));
      await until(() => c.closed);
      expect(calls).toHaveLength(0);
      expect(r.logs.map((l) => l.fields?.code)).toContain("frame_too_large");
      await ep.close();
    }
  });

  it("a frame exactly at the cap is accepted", async () => {
    const r = rig({ shimToHostBytes: 4096 });
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    const base = JSON.stringify(call("c1", "echo", { p: "" })).length;
    c.send(call("c1", "echo", { p: "x".repeat(4096 - base) }));
    await until(() => calls.length === 1);
    await ep.close();
  });

  it("unknown frame types, non-objects, bad JSON and bad fields drop the connection", async () => {
    const cases: Array<[string, string]> = [
      [JSON.stringify({ type: "hello" }) + "\n", "unknown_frame_type"],
      [JSON.stringify({ type: "result", callId: "c1", content: "x" }) + "\n", "unknown_frame_type"], // the shim cannot answer itself
      [JSON.stringify({ callId: "c1", name: "echo", args: {} }) + "\n", "unknown_frame_type"],
      ["[1,2]\n", "bad_frame"],
      ["null\n", "bad_frame"],
      ["{not json\n", "bad_json"],
      [JSON.stringify(call("c 1")) + "\n", "bad_frame"],
      [JSON.stringify(call("c1", "../x")) + "\n", "bad_frame"],
      [JSON.stringify(call("c1", "echo", [])) + "\n", "bad_frame"],
      [JSON.stringify(call("c1", "echo", null)) + "\n", "bad_frame"],
      [JSON.stringify({ type: "ping", extra: 1 }) + "\n", "bad_frame"],
    ];
    for (const [payload, code] of cases) {
      const r = rig();
      const { ep, calls } = await r.open();
      const c = new Client(sockOf(ep));
      await c.ready();
      c.raw(payload);
      await until(() => c.closed);
      expect({ payload, calls: calls.length, codes: r.logs.map((l) => l.fields?.code) }).toEqual({ payload, calls: 0, codes: [code] });
      await ep.close();
    }
  });

  it("slow-loris: bytes that never complete a frame are cut after the idle timeout, however slowly they trickle", async () => {
    const r = rig({ idleMs: 150 });
    const { ep } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    const t = setInterval(() => c.raw("{"), 30);
    await until(() => c.closed, 3000);
    clearInterval(t);
    expect(r.logs.map((l) => l.fields?.code)).toContain("idle_timeout");
    await ep.close();
  });

  it("a silent connection is cut after the idle timeout; pings keep it alive", async () => {
    const r = rig({ idleMs: 200 });
    const { ep } = await r.open();
    const quiet = new Client(sockOf(ep));
    await quiet.ready();
    await until(() => quiet.closed, 3000);
    const live = new Client(sockOf(ep));
    await live.ready();
    const t = setInterval(() => live.send({ type: "ping" }), 60);
    await new Promise((res) => setTimeout(res, 500));
    clearInterval(t);
    expect(live.closed).toBe(false);
    await ep.close();
  });

  it("flood: frames beyond the token bucket drop the connection; nothing past the burst reaches onCall", async () => {
    const r = rig({ burst: 5, refillPerSec: 1 });
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.raw(Array.from({ length: 200 }, () => JSON.stringify({ type: "ping" })).join("\n") + "\n");
    await until(() => c.closed);
    expect(r.logs.map((l) => l.fields?.code)).toContain("rate_limited");
    expect(calls).toHaveLength(0);
    await ep.close();
  });

  it("flood of calls: only the first becomes an operation (one pending), the rest are busy or dropped", async () => {
    const r = rig({ burst: 10, refillPerSec: 1 });
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.raw(Array.from({ length: 100 }, (_, i) => JSON.stringify(call(`c${i}`))).join("\n") + "\n");
    await until(() => c.closed);
    expect(calls).toHaveLength(1);
    await ep.close();
  });

  it("logging redaction: nothing from a frame (name, args, call id) ever reaches the log", async () => {
    const r = rig();
    const { ep } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.raw(JSON.stringify({ type: "call", callId: "SECRET-CALL-ID", name: "echo", args: { password: "hunter2-SECRET" }, connectionId: "SECRET-CONN" }) + "\n");
    await until(() => c.closed);
    const c2 = new Client(sockOf(ep));
    await c2.ready();
    c2.raw("{\"password\":\"hunter2-SECRET\" garbage\n");
    await until(() => c2.closed);
    expect(JSON.stringify(r.logs)).not.toMatch(/SECRET|hunter2|echo/);
    for (const l of r.logs) expect(Object.keys(l.fields ?? {})).toEqual(["code"]);
    await ep.close();
  });
});

describe("relay: hostile frames cannot take the host down", () => {
  const deepFrame = (k: number, callId = "d1") => `{"type":"call","callId":"${callId}","name":"echo","args":{"a":${"[".repeat(k)}${"]".repeat(k)}}}\n`;
  let uncaught: unknown[];
  const onU = (e: unknown) => void uncaught.push(e);
  beforeEach(() => {
    uncaught = [];
    process.on("uncaughtException", onU);
  });
  afterEach(() => void process.off("uncaughtException", onU));

  it("MUTATION TARGET: a frame nested hundreds of thousands deep (it fits in 1 MiB and JSON.parse accepts it) drops the connection; nothing is thrown, nothing reaches onCall", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const other = await r.open({ uid: 400_002 });
    const c = new Client(sockOf(ep));
    await c.ready();
    const frame = deepFrame(300_000);
    expect(Buffer.byteLength(frame)).toBeLessThan(1024 * 1024);
    expect(() => JSON.stringify(JSON.parse(frame))).toThrow(RangeError); // the crash the unbounded path had: stringify of what parse accepted
    c.raw(frame);
    await until(() => c.closed);
    await new Promise((res) => setTimeout(res, 100));
    expect(calls).toHaveLength(0);
    expect(r.logs.map((l) => l.fields?.code)).toEqual(["frame_too_deep"]);
    expect(uncaught).toEqual([]);
    // the endpoint still works for a well-formed call on a new connection, and another turn's endpoint was never affected
    const c2 = new Client(sockOf(ep));
    await c2.ready();
    c2.send(call("ok1"));
    await until(() => calls.length === 1);
    expect(ep.answer(calls[0].operationId, { content: "fine" })).toBe(true);
    const o = new Client(sockOf(other.ep));
    await o.ready();
    o.send(call("ok2"));
    await until(() => other.calls.length === 1);
    await ep.close();
    await other.ep.close();
  });

  it("MUTATION TARGET: the depth boundary is exact (33 levels including the frame and args), for calls and pings alike", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const ok = new Client(sockOf(ep));
    await ok.ready();
    ok.raw(deepFrame(31));
    await until(() => calls.length === 1);
    expect(ok.closed).toBe(false);
    expect(ep.answer(calls[0].operationId, { content: "x" })).toBe(true);
    ok.raw(deepFrame(32, "d2"));
    await until(() => ok.closed);
    expect(r.logs.map((l) => l.fields?.code)).toEqual(["frame_too_deep"]);
    expect(calls).toHaveLength(1);
    await ep.close();
  });

  it("MUTATION TARGET: a handler that throws (here: allowTool) is contained: the connection is dropped with a fixed code, the process is not", async () => {
    const r = rig();
    const { ep, calls } = await r.open({
      allowTool: () => {
        throw new Error("boom: SECRET-FRAME-TEXT");
      },
    });
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call());
    await until(() => c.closed);
    expect(calls).toHaveLength(0);
    expect(r.logs.map((l) => l.fields?.code)).toEqual(["internal_error"]);
    expect(JSON.stringify(r.logs)).not.toContain("SECRET");
    expect(uncaught).toEqual([]);
    await ep.close();
  });

  it("MUTATION TARGET: a logger that throws cannot turn a violation into an uncaught exception", async () => {
    const { layout } = mkLayout();
    const host = new RelayHost({ layout, ownByUid: false, log: { warn: () => { throw new Error("logger down"); } } });
    host.init();
    const ep = await host.open({ uid: 400_001, identity: { connectionId: "c", epoch: 1, turnId: "t" }, onCall: () => undefined, allowTool: () => true, callTimeoutMs: () => 1000 });
    const c = new Client(sockOf(ep));
    await c.ready();
    c.raw("not json\n");
    await until(() => c.closed);
    await new Promise((res) => setTimeout(res, 100));
    expect(uncaught).toEqual([]);
    await ep.close();
  });

  it("MUTATION TARGET: an onCall that throws answers the shim with a fixed internal error, ends the call, and the endpoint takes the next call", async () => {
    const r = rig();
    let first = true;
    const calls: RelayCall[] = [];
    const ep = await r.host.open({
      uid: 400_001,
      identity: { connectionId: "c", epoch: 1, turnId: "t" },
      onCall: (c) => {
        if (first) {
          first = false;
          throw new Error("onCall boom: SECRET");
        }
        calls.push(c);
      },
      allowTool: () => true,
      callTimeoutMs: () => 5000,
    });
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call("b1"));
    await until(() => c.lines.length === 1);
    expect(JSON.parse(c.lines[0])).toEqual({ type: "error", callId: "b1", code: "internal" });
    c.send(call("b2")); // the pending slot was freed
    await until(() => calls.length === 1);
    expect(uncaught).toEqual([]);
    expect(JSON.stringify(r.logs)).not.toContain("SECRET");
    await ep.close();
  });

  it("MUTATION TARGET: the per-call timer is guarded: a callback that throws when the call times out cannot become an uncaught exception", async () => {
    const r = rig();
    const ep = await r.host.open({
      uid: 400_001,
      identity: { connectionId: "c", epoch: 1, turnId: "t" },
      onCall: () => undefined,
      onCallEnded: () => {
        throw new Error("ended boom: SECRET");
      },
      allowTool: () => true,
      callTimeoutMs: () => 40,
    });
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call("tm"));
    await until(() => c.closed); // the guard dropped the connection after the callback threw
    await new Promise((res) => setTimeout(res, 100));
    expect(uncaught).toEqual([]);
    expect(r.logs.map((l) => l.fields?.code)).toContain("internal_error");
    expect(JSON.stringify(r.logs)).not.toContain("SECRET");
    await ep.close();
  });

  it("MUTATION TARGET: the token bucket runs on a MONOTONIC clock: the wall clock stepping back an hour (NTP, a VM resume) does not drop a healthy connection", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send({ type: "ping" });
    await new Promise((res) => setTimeout(res, 30));
    const real = Date.now;
    const spy = jest.spyOn(Date, "now").mockImplementation(() => real() - 3_600_000);
    try {
      for (let i = 0; i < 5; i++) c.send({ type: "ping" });
      c.send(call("after-step"));
      await until(() => calls.length === 1);
      expect(c.closed).toBe(false);
      expect(r.logs.map((l) => l.fields?.code)).not.toContain("rate_limited");
    } finally {
      spy.mockRestore();
    }
    await ep.close();
  });

  it("MUTATION TARGET: reject() answers the pending call with a fixed internal error frame (once)", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call("rj"));
    await until(() => calls.length === 1);
    expect(ep.reject("0".repeat(32), "internal")).toBe(false);
    expect(ep.reject(calls[0].operationId, "internal")).toBe(true);
    await until(() => c.lines.length === 1);
    expect(JSON.parse(c.lines[0])).toEqual({ type: "error", callId: "rj", code: "internal" });
    expect(ep.reject(calls[0].operationId, "internal")).toBe(false);
    expect(ep.answer(calls[0].operationId, { content: "late" })).toBe(false);
    await ep.close();
  });

  it("MUTATION TARGET: a frame trickled in tiny writes (3 bytes at a time) is assembled and answered exactly like a whole one; a frame split exactly at the newline too", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    const wire = Buffer.from(JSON.stringify(call("tr1", "echo", { q: "trickle" })) + "\n");
    for (let i = 0; i < wire.length; i += 3) {
      c.raw(wire.subarray(i, i + 3));
      await new Promise((res) => setTimeout(res, 2));
    }
    await until(() => calls.length === 1);
    expect(calls[0].args).toEqual({ q: "trickle" });
    ep.answer(calls[0].operationId, { content: "ok" });
    await until(() => c.lines.length === 1);
    const wire2 = Buffer.from(JSON.stringify(call("tr2")) + "\n");
    c.raw(wire2.subarray(0, wire2.length - 1));
    await new Promise((res) => setTimeout(res, 30));
    c.raw(wire2.subarray(wire2.length - 1)); // just the newline
    await until(() => calls.length === 2);
    await ep.close();
  });

  it("each call reports the size of the frame the host measured (memory accounting never needs a stringify of args)", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    const line = JSON.stringify(call("sz", "echo", { q: "x".repeat(500) }));
    c.raw(line + "\n");
    await until(() => calls.length === 1);
    expect(calls[0].bytes).toBe(Buffer.byteLength(line));
    await ep.close();
  });
});

describe("relay: timeouts and lifetime", () => {
  it("a call that outlives its per-turn timeout gets an error frame; the late answer is refused (result lost) and the adapter is told", async () => {
    const r = rig();
    let ms = 120;
    const { ep, calls, ended } = await r.open({ callTimeoutMs: () => ms });
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call("c1"));
    await until(() => calls.length === 1);
    await until(() => c.lines.length === 1);
    expect(JSON.parse(c.lines[0])).toEqual({ type: "error", callId: "c1", code: "timeout" });
    expect(ended).toEqual([[calls[0].operationId, "timeout"]]);
    expect(ep.answer(calls[0].operationId, { content: "late" })).toBe(false);
    // the next call is accepted and gets its OWN clock (read at arrival)
    ms = 5_000;
    c.send(call("c2"));
    await until(() => calls.length === 2);
    expect(ep.answer(calls[1].operationId, { content: "ok" })).toBe(true);
    await ep.close();
  });

  it("the per-turn timeout is read when the call ARRIVES (a long-deadline turn is not cut at 120 s)", async () => {
    const r = rig();
    const reads: number[] = [];
    const { ep, calls } = await r.open({ callTimeoutMs: () => (reads.push(1), 590_000) });
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call());
    await until(() => calls.length === 1);
    expect(reads).toHaveLength(1);
    await ep.close();
  });

  it("the shim disconnecting mid-call ends the operation (the answer is then refused)", async () => {
    const r = rig();
    const { ep, calls, ended } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call());
    await until(() => calls.length === 1);
    c.sock.destroy();
    await until(() => ended.length === 1);
    expect(ended[0][1]).toBe("disconnected");
    expect(ep.answer(calls[0].operationId, { content: "x" })).toBe(false);
    await ep.close();
  });

  it("closing the endpoint (turn abort) tears down the connection and the pending operation, and the socket is gone", async () => {
    const r = rig();
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call());
    await until(() => calls.length === 1);
    await ep.close();
    await until(() => c.closed);
    expect(ep.answer(calls[0].operationId, { content: "x" })).toBe(false);
    expect(existsSync(sockOf(ep))).toBe(false);
    await expect(new Client(sockOf(ep)).ready()).rejects.toMatchObject({ code: "ENOENT" }); // no relay for a turn that has ended
  });

  it("a result whose frame would exceed the host -> shim cap is replaced by an error frame, not sent", async () => {
    const r = rig({ hostToShimBytes: 1000 });
    const { ep, calls } = await r.open();
    const c = new Client(sockOf(ep));
    await c.ready();
    c.send(call());
    await until(() => calls.length === 1);
    expect(resultFrameBytes("c1", { content: "x".repeat(2000) })).toBeGreaterThan(1000);
    ep.answer(calls[0].operationId, { content: "x".repeat(2000) });
    await until(() => c.lines.length === 1);
    expect(JSON.parse(c.lines[0])).toEqual({ type: "error", callId: "c1", code: "result_too_large" });
    await ep.close();
  });
});

describe("relay: unit isolation (what the host controls)", () => {
  it("same uid, two turns: each unit is bound ONLY its own directory (path construction; same-uid /proc reachability is a documented residual, see deploy/README.md)", async () => {
    const r = rig();
    const a = await r.open();
    const b = await r.open();
    // What systemd binds is `${dir}:/run/aw-relay` for ONE dir (unitArgs.test.ts asserts the property text). A unit that is handed a's dir sees a's relay.sock at
    // /run/aw-relay/relay.sock and nothing named after b: the host path of b's directory is not inside a's.
    expect(b.ep.dir.startsWith(a.ep.dir)).toBe(false);
    expect(a.ep.dir.startsWith(b.ep.dir)).toBe(false);
    expect(readdirSync(a.ep.dir)).toEqual(["relay.sock"]);
    expect(readdirSync(b.ep.dir)).toEqual(["relay.sock"]);
    // Different uid: its directory lives under a different uid directory, and the layout refuses to hand a uid another uid's directory.
    const c = await r.open({ uid: 400_002 });
    expect(r.layout.isRelayDirOf(400_001, c.ep.dir)).toBe(false);
    expect(r.layout.isRelayDirOf(400_002, a.ep.dir)).toBe(false);
    await a.ep.close();
    await b.ep.close();
    await c.ep.close();
  });
});
