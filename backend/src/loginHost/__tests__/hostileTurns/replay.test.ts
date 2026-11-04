/** ENG-2113 (security review): late/duplicate/replayed answers and dead calls, at relay level and end-to-end through the adapter with a hostile CLI that talks to the socket itself. */
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { connect, type Socket } from "net";
import { Layout } from "../../ports/layout";
import { RelayHost, type RelayCall } from "../../relay/relayServer";
import { cleanup, makeRig } from "./rig";
import { runTurn } from "./harness";

const roots: string[] = [];
afterAll(() => {
  cleanup();
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (c: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!c() && Date.now() - t0 < ms) await sleep(5);
  return c();
};
function mk(timeoutMs = 5000) {
  const root = mkdtempSync(join(tmpdir(), "sec14r-"));
  roots.push(root);
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot: join(root, "relay") });
  const host = new RelayHost({ layout, ownByUid: false });
  host.init();
  const calls: RelayCall[] = [];
  const ended: Array<[string, string]> = [];
  return {
    open: () => host.open({ uid: 400_001, identity: { connectionId: "c", epoch: 1, turnId: "t" }, onCall: (c) => void calls.push(c), onCallEnded: (o, w) => void ended.push([o, w]), allowTool: (n) => n === "echo", callTimeoutMs: () => timeoutMs }),
    calls,
    ended,
  };
}
function client(path: string) {
  const s: Socket = connect(path);
  const lines: string[] = [];
  let buf = "";
  let closed = false;
  s.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  s.on("close", () => (closed = true));
  s.on("error", () => undefined);
  return { s, lines, isClosed: () => closed, ready: () => new Promise<void>((r) => s.once("connect", () => r())) };
}
const call = (id: string) => JSON.stringify({ type: "call", callId: id, name: "echo", args: {} }) + "\n";

describe("sec14 replay: relay endpoint", () => {
  it("an answer for an op whose connection died is NOT delivered to the next connection; a second answer is refused", async () => {
    const m = mk();
    const ep = await m.open();
    const a = client(`${ep.dir}/relay.sock`);
    await a.ready();
    a.s.write(call("c1"));
    expect(await until(() => m.calls.length === 1)).toBe(true);
    const op = m.calls[0].operationId;
    a.s.destroy();
    expect(await until(() => m.ended.length === 1)).toBe(true);
    const b = client(`${ep.dir}/relay.sock`);
    await b.ready();
    expect(ep.answer(op, { content: "late" })).toBe(false);
    await sleep(100);
    expect(b.lines).toEqual([]);
    // same callId "c1" from the new connection gets a NEW operation id; the old op can not answer it
    b.s.write(call("c1"));
    expect(await until(() => m.calls.length === 2)).toBe(true);
    expect(m.calls[1].operationId).not.toBe(op);
    expect(ep.answer(op, { content: "replay-old-op" })).toBe(false);
    expect(ep.answer(m.calls[1].operationId, { content: "ok" })).toBe(true);
    expect(ep.answer(m.calls[1].operationId, { content: "twice" })).toBe(false);
    await until(() => b.lines.length === 1);
    expect(JSON.parse(b.lines[0])).toMatchObject({ type: "result", callId: "c1", content: "ok" });
    await ep.close();
  });
  it("an answer after the call's own timeout is refused and the shim got the timeout error exactly once", async () => {
    const m = mk(150);
    const ep = await m.open();
    const a = client(`${ep.dir}/relay.sock`);
    await a.ready();
    a.s.write(call("c1"));
    await until(() => m.calls.length === 1);
    await sleep(300);
    expect(ep.answer(m.calls[0].operationId, { content: "late" })).toBe(false);
    expect(a.lines.map((l) => JSON.parse(l).code)).toEqual(["timeout"]);
    await ep.close();
  });
  it("ONE pending call: a second call while pending gets busy, never a second onCall; answers still go to the first", async () => {
    const m = mk();
    const ep = await m.open();
    const a = client(`${ep.dir}/relay.sock`);
    await a.ready();
    a.s.write(call("c1") + call("c2") + call("c3"));
    await until(() => a.lines.length === 2);
    expect(m.calls.length).toBe(1);
    expect(a.lines.map((l) => JSON.parse(l))).toEqual([{ type: "error", callId: "c2", code: "busy" }, { type: "error", callId: "c3", code: "busy" }]);
    expect(ep.answer(m.calls[0].operationId, { content: "r" })).toBe(true);
    await ep.close();
  });
  it("a result is addressed with the shim's callId of the PENDING call, never a callId taken from a later frame", async () => {
    const m = mk();
    const ep = await m.open();
    const a = client(`${ep.dir}/relay.sock`);
    await a.ready();
    a.s.write(call("first"));
    await until(() => m.calls.length === 1);
    a.s.write(call("second")); // busy
    await until(() => a.lines.length === 1);
    ep.answer(m.calls[0].operationId, { content: "r" });
    await until(() => a.lines.length === 2);
    expect(JSON.parse(a.lines[1]).callId).toBe("first");
    await ep.close();
  });
});

describe("sec14 replay: end to end with a hostile CLI that opens the relay socket itself", () => {
  it("a call whose connection is dropped inside the message-id wait is NEVER emitted as a tool-call event (no execution of a dead call)", async () => {
    const rig = makeRig({ messageIdWaitMs: 1200 });
    const r = await runTurn(
      rig,
      `module.exports = async (h) => {
        const s = h.net.createConnection(process.env.AW_FAKE_RELAY_MOUNT + "/relay.sock");
        s.on("error", () => {});
        await new Promise((r) => s.once("connect", r));
        s.write(JSON.stringify({type:"call",callId:"c1",name:"search",args:{q:"x"}})+"\\n");
        await h.sleep(100);
        s.destroy();
        await h.sleep(2500);
        h.out({type:"result",is_error:false,result:"done"});
      };`,
    );
    expect(r.events.filter((e) => e.type === "tool-call")).toEqual([]);
    expect(r.result).toMatchObject({ ok: true });
  }, 30_000);
  it("a hostile CLI that calls an unlisted tool / a tool named like an Object.prototype member is refused (unknown_tool) and nothing is emitted", async () => {
    const rig = makeRig();
    const r = await runTurn(
      rig,
      `module.exports = async (h) => {
        const s = h.net.createConnection(process.env.AW_FAKE_RELAY_MOUNT + "/relay.sock");
        s.on("error", () => {});
        await new Promise((r) => s.once("connect", r));
        let got = "";
        s.on("data", (d) => got += d);
        for (const n of ["constructor","__proto__","toString","hasOwnProperty","valueOf","install_skills","aw_relay_x","mcp__emma__search"]) { s.write(JSON.stringify({type:"call",callId:"c"+n.length,name:n,args:{}})+"\\n"); await h.sleep(120); }
        await h.sleep(300);
        h.note("responses", got);
        h.out({type:"result",is_error:false,result:"done"});
      };`,
    );
    expect(r.events.filter((e) => e.type === "tool-call")).toEqual([]);
    const notes = readFileSync(join(rig.homeDir, ".hostile-notes"), "utf8");
    expect(notes).toContain("unknown_tool");
    expect(notes).not.toContain('"type\\":\\"result\\"');
  }, 30_000);
});
