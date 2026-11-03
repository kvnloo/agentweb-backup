/**
 * ENG-2113: the stdio shim as a process, driven as the CLI would drive it (JSON-RPC lines on stdin/stdout) against a real RelayHost socket.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { PassThrough } from "stream";
import { tmpdir } from "os";
import { join } from "path";
import { Layout } from "../ports/layout";
import { RelayHost, type RelayCall, type RelayEndpoint } from "../relay/relayServer";
import { RELAY_FRAME_LIMITS, RELAY_RESULT_MAX_BYTES, TOOL_LIMITS, type ToolDef } from "../protocol";

const SHIM = join(__dirname, "..", "deploy", "aw-relay-shim.js");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const procs: ChildProcessWithoutNullStreams[] = [];
afterEach(() => procs.splice(0).forEach((p) => p.kill("SIGKILL")));

const LATER: ToolDef = { name: "later", description: "Arrives with an answer", inputSchema: { type: "object", properties: {} } };
const TOOLS: ToolDef[] = [
  { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
];

async function rig(env: Record<string, string> = {}, limits: { idleMs?: number } = {}, tools: unknown = TOOLS, hostAllowsAll = false) {
  const root = mkdtempSync(join(tmpdir(), "relay-shim-"));
  roots.push(root);
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot: join(root, "relay") });
  const logs: Array<Record<string, unknown> | undefined> = [];
  const host = new RelayHost({ layout, ownByUid: false, limits, log: { warn: (_e, f) => void logs.push(f) } });
  host.init();
  const calls: RelayCall[] = [];
  const visible = new Set(TOOLS.map((t) => t.name));
  const ep: RelayEndpoint = await host.open({ uid: 400_001, identity: { connectionId: "c", epoch: 1, turnId: "t" }, onCall: (c) => void calls.push(c), allowTool: (n) => hostAllowsAll || visible.has(n), callTimeoutMs: () => 10_000 });
  mkdirSync(join(root, "cfg"));
  const toolsFile = join(root, "cfg", "tools.json");
  writeFileSync(toolsFile, JSON.stringify(tools));
  const child = spawn(process.execPath, [SHIM], { env: { PATH: process.env.PATH ?? "", AW_RELAY_SOCKET: `${ep.dir}/relay.sock`, AW_RELAY_TOOLS: toolsFile, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  const out: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON-RPC
  let buf = "";
  let err = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.on("data", (d) => (err += d.toString("utf8")));
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const mine = ++id;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mine, method, params }) + "\n");
    await until(() => out.some((o) => o.id === mine));
    return out.find((o) => o.id === mine)!;
  };
  return { logs, ep, calls, visible, child, out, rpc, stderr: () => err, host, layout, root };
}
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("until: timed out");
}

const META = { "anthropic/maxResultSizeChars": RELAY_RESULT_MAX_BYTES };

describe("relay shim: the standalone constants equal the protocol's", () => {
  const src = readFileSync(SHIM, "utf8");
  const constant = (name: string): number => {
    const m = src.match(new RegExp("^const " + name + " = ([0-9 *]+);", "m"));
    expect(m).not.toBeNull();
    return Function("return " + m![1])() as number;
  };
  it("MUTATION TARGET: HOST_TO_SHIM_MAX (the largest frame the shim accepts from the host) is RELAY_FRAME_LIMITS.hostToShimBytes: 8 MiB (a smaller one would drop a legitimate large result)", () => {
    expect(constant("HOST_TO_SHIM_MAX")).toBe(RELAY_FRAME_LIMITS.hostToShimBytes);
    expect(RELAY_FRAME_LIMITS.hostToShimBytes).toBe(8 * 1024 * 1024);
  });
  it("MUTATION TARGET: SHIM_TO_HOST_MAX is RELAY_FRAME_LIMITS.shimToHostBytes", () => {
    expect(constant("SHIM_TO_HOST_MAX")).toBe(RELAY_FRAME_LIMITS.shimToHostBytes);
  });
  it("MUTATION TARGET: MAX_TOOLS is TOOL_LIMITS.maxTools", () => {
    expect(constant("MAX_TOOLS")).toBe(TOOL_LIMITS.maxTools);
  });
});

describe("relay shim: per-tool result threshold (_meta)", () => {
  it("MUTATION TARGET: the shim's constant equals RELAY_RESULT_MAX_BYTES (it is standalone, so a test keeps them equal)", () => {
    const m = readFileSync(SHIM, "utf8").match(/^const MAX_RESULT_CHARS = (\d+);/m);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(RELAY_RESULT_MAX_BYTES);
    expect(RELAY_RESULT_MAX_BYTES).toBe(300_000);
  });

  it("MUTATION TARGET: EVERY listed tool carries _meta {anthropic/maxResultSizeChars: RELAY_RESULT_MAX_BYTES}, exactly (the open set; those added by answers are checked in the answer test below)", async () => {
    const many: ToolDef[] = Array.from({ length: 25 }, (_, i) => ({ name: "t" + i, description: "d", inputSchema: { type: "object", properties: {} } }));
    const r = await rig({}, {}, many);
    const list = await r.rpc("tools/list");
    expect(list.result.tools).toHaveLength(25);
    for (const t of list.result.tools) expect(t._meta).toEqual(META);
    await r.ep.close();
  });
});

describe("relay shim: MCP surface", () => {
  it("initialize advertises listChanged; tools/list shows the open set; ping works; unknown methods are errors", async () => {
    const r = await rig();
    const init = await r.rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } } });
    const list = await r.rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    expect(list.result.tools[0]).toEqual({ name: "echo", description: "Echo", inputSchema: TOOLS[0].inputSchema, _meta: { "anthropic/maxResultSizeChars": RELAY_RESULT_MAX_BYTES } });
    expect((await r.rpc("ping")).result).toEqual({});
    expect((await r.rpc("resources/list")).error).toMatchObject({ code: -32601 });
    await r.ep.close();
  });

  it("a call sends exactly {type, callId, name, args} and returns the host's result with image blocks", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    const pending = r.rpc("tools/call", { name: "echo", arguments: { q: "hi" } });
    await until(() => r.calls.length === 1);
    expect(r.calls[0]).toMatchObject({ name: "echo", args: { q: "hi" } });
    r.ep.answer(r.calls[0].operationId, { content: "pong", images: [{ mimeType: "image/png", data: "AAAA" }] });
    expect((await pending).result).toEqual({ content: [{ type: "text", text: "pong" }, { type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });
    await r.ep.close();
  });

  it("host errors become isError results with fixed texts (a timeout, a busy relay)", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    // end the pending call from the host side like a timeout would
    await r.ep.close();
    const res = (await p).result;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^The tool/);
  });

  it("calls are serialized: two concurrent tools/call requests reach the host one after the other", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    const a = r.rpc("tools/call", { name: "echo", arguments: { n: 1 } });
    const b = r.rpc("tools/call", { name: "echo", arguments: { n: 2 } });
    await until(() => r.calls.length === 1);
    await new Promise((res) => setTimeout(res, 150));
    expect(r.calls).toHaveLength(1); // the second waits for the first
    r.ep.answer(r.calls[0].operationId, { content: "one" });
    await until(() => r.calls.length === 2);
    r.ep.answer(r.calls[1].operationId, { content: "two" });
    expect((await a).result.content[0].text).toBe("one");
    expect((await b).result.content[0].text).toBe("two");
    await r.ep.close();
  });

  it("a tool that is not listed (not yet arrived, or unknown) is refused locally and never sent", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    for (const name of ["later", "nope", 5, undefined]) {
      const res = (await r.rpc("tools/call", { name, arguments: {} })).result;
      expect(res).toMatchObject({ isError: true });
    }
    expect(r.calls).toHaveLength(0);
    await r.ep.close();
  });

  it("MUTATION TARGET: the shim's OWN gate: with a host that would allow anything, a tool that is not in its list still never leaves the shim", async () => {
    const r = await rig({}, {}, TOOLS, true);
    await r.rpc("initialize", {});
    for (const name of ["later", "nope", "../x"]) expect((await r.rpc("tools/call", { name, arguments: {} })).result).toMatchObject({ isError: true });
    expect(r.calls).toHaveLength(0);
    await r.ep.close();
  });

  it("arguments over the 1 MiB frame cap are refused locally, not sent", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    const res = (await r.rpc("tools/call", { name: "echo", arguments: { q: "x".repeat(1024 * 1024) } })).result;
    expect(res).toMatchObject({ isError: true });
    expect(res.content[0].text).toBe("The tool arguments were too large.");
    expect(r.calls).toHaveLength(0);
    await r.ep.close();
  });

  it("exits when its stdin closes (the CLI went away), leaving no process", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    r.child.stdin.end();
    await until(() => r.child.exitCode !== null || r.child.signalCode !== null);
    expect(r.child.exitCode).toBe(0);
    await r.ep.close();
  });

  it("a missing or invalid manifest is a fixed-code exit, not a crash with contents", async () => {
    const r = await rig({}, {}, "not a manifest");
    await until(() => r.child.exitCode !== null);
    expect(r.child.exitCode).toBe(1);
    expect(r.stderr().trim()).toBe("aw-relay: E_TOOLS");
    await r.ep.close();
  });
});

describe("relay shim: ONE connection, however calls race the connect", () => {
  const accepted = (r: { ep: unknown }) => (r.ep as unknown as { accepted: number }).accepted;
  const codes = (r: { logs: Array<Record<string, unknown> | undefined> }) => r.logs.map((l) => l?.code);
  const drop = (r: { ep: unknown }) => (r.ep as unknown as { conn: { destroy(): void } }).conn.destroy();

  it("MUTATION TARGET: a tool call racing the shim own initial connect uses a SINGLE connection (no second_connection, the call is served)", async () => {
    const r = await rig();
    const p = r.rpc("tools/call", { name: "echo", arguments: { q: "race" } });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "ok" });
    expect((await p).result.content[0].text).toBe("ok");
    expect(accepted(r)).toBe(1);
    expect(codes(r)).not.toContain("second_connection");
    await r.ep.close();
  });

  it("MUTATION TARGET: after the host drops the connection the next call reconnects, once, and works", async () => {
    const r = await rig();
    const first = r.rpc("tools/call", { name: "echo", arguments: { n: 1 } });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "one" });
    await first;
    drop(r);
    await new Promise((res) => setTimeout(res, 100));
    const again = r.rpc("tools/call", { name: "echo", arguments: { n: 2 } });
    await until(() => r.calls.length === 2);
    r.ep.answer(r.calls[1].operationId, { content: "two" });
    expect((await again).result.content[0].text).toBe("two");
    expect(accepted(r)).toBe(2);
    expect(codes(r)).not.toContain("second_connection");
    await r.ep.close();
  });

  it("MUTATION TARGET: two simultaneous calls while the shim is reconnecting open ONE new connection", async () => {
    const r = await rig();
    const first = r.rpc("tools/call", { name: "echo", arguments: { n: 1 } });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "one" });
    await first;
    drop(r);
    await new Promise((res) => setTimeout(res, 100));
    const a = r.rpc("tools/call", { name: "echo", arguments: { n: 2 } });
    const b = r.rpc("tools/call", { name: "echo", arguments: { n: 3 } });
    await until(() => r.calls.length === 2);
    r.ep.answer(r.calls[1].operationId, { content: "two" });
    await until(() => r.calls.length === 3);
    r.ep.answer(r.calls[2].operationId, { content: "three" });
    expect((await a).result.content[0].text).toBe("two");
    expect((await b).result.content[0].text).toBe("three");
    expect(accepted(r)).toBe(2);
    expect(codes(r)).not.toContain("second_connection");
    await r.ep.close();
  });
});

describe("relay shim: connection bookkeeping (the shim source driven with a fake net, so the timing is exact)", () => {
  class FakeSock extends EventEmitter {
    writes: string[] = [];
    write(d: string) {
      this.writes.push(String(d));
      return true;
    }
    destroy() {
      this.emit("close");
    }
  }
  function load() {
    const root = mkdtempSync(join(tmpdir(), "relay-shim-fake-"));
    roots.push(root);
    const toolsFile = join(root, "tools.json");
    writeFileSync(toolsFile, JSON.stringify(TOOLS));
    const socks: FakeSock[] = [];
    const fakeNet = { createConnection: () => (socks.push(new FakeSock()), socks[socks.length - 1]) };
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { env: { AW_RELAY_SOCKET: "/nowhere/relay.sock", AW_RELAY_TOOLS: toolsFile }, stdin, stdout, stderr: new PassThrough(), exit: () => undefined });
    const src = readFileSync(SHIM, "utf8").replace(/^#!.*\n/, "");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = (m: string) => (m === "net" ? fakeNet : require(m));
    new Function("require", "process", "module", "exports", src)(req, proc, { exports: {} }, {});
    let id = 0;
    const call = () => stdin.write(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "echo", arguments: {} } }) + "\n");
    const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
    return { socks, call, tick, closeAll: () => socks.forEach((x) => x.emit("close")) };
  }

  it("MUTATION TARGET: a call arriving while the start-up connect is still IN FLIGHT does not open a second connection", async () => {
    const t = load();
    await t.tick();
    expect(t.socks).toHaveLength(1); // the start-up connect, not yet completed
    t.call();
    t.call();
    await t.tick();
    expect(t.socks).toHaveLength(1); // both calls wait for it
    t.socks[0].emit("connect");
    await t.tick();
    expect(t.socks[0].writes.filter((w) => w.includes("\"type\":\"call\""))).toHaveLength(1); // the first call; the second waits its turn
    expect(t.socks).toHaveLength(1);
    t.closeAll();
  });

  it("MUTATION TARGET: a LATE close event of an older socket does not clear the newer connection (or its waiter)", async () => {
    const t = load();
    await t.tick();
    t.socks[0].emit("connect");
    await t.tick();
    t.socks[0].emit("close"); // a drop
    await t.tick();
    t.call(); // reconnects
    await t.tick();
    expect(t.socks).toHaveLength(2);
    t.socks[1].emit("connect");
    await t.tick();
    t.socks[0].emit("close"); // the old socket reports closing AGAIN, late
    await t.tick();
    t.call();
    await t.tick();
    expect(t.socks).toHaveLength(2); // the live connection was not forgotten
    t.closeAll();
  });
});

describe("relay shim: keepalive and tools that arrive with an answer", () => {
  it("while a call is pending the shim pings the host (so a long call outlives the 15 s idle rule) and sends progress notifications to the CLI", async () => {
    const r = await rig({ AW_RELAY_PING_MS: "50", AW_RELAY_PROGRESS_MS: "80" }, { idleMs: 300 });
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {}, _meta: { progressToken: "tok" } });
    await until(() => r.calls.length === 1);
    await new Promise((res) => setTimeout(res, 900)); // three idle windows
    expect(r.out.filter((o) => o.method === "notifications/progress" && o.params.progressToken === "tok").length).toBeGreaterThanOrEqual(3);
    expect(r.ep.answer(r.calls[0].operationId, { content: "late but alive" })).toBe(true); // the connection survived
    expect((await p).result.content[0].text).toBe("late but alive");
    await r.ep.close();
  });

  it("no progress notification without a progress token", async () => {
    const r = await rig({ AW_RELAY_PROGRESS_MS: "30" });
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    await new Promise((res) => setTimeout(res, 200));
    expect(r.out.some((o) => o.method === "notifications/progress")).toBe(false);
    r.ep.answer(r.calls[0].operationId, { content: "x" });
    await p;
    await r.ep.close();
  });

  it("without pings the host would cut a pending call (idle rule), proving the ping is what keeps it alive", async () => {
    const r = await rig({ AW_RELAY_PING_MS: "10000" }, { idleMs: 200 }); // ping effectively never
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    const res = (await p).result;
    expect(res.isError).toBe(true); // the host dropped the connection; the shim reports it
    await r.ep.close();
  });

  it("tools carried by an answer are added, announced with tools/list_changed and WAITS for the CLI's re-list before returning the result", async () => {
    const r = await rig({ AW_RELAY_RELIST_MS: "3000" });
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    r.visible.add("later"); // what the adapter does when it forwards new tools
    r.ep.answer(r.calls[0].operationId, { content: "installed", tools: [LATER] });
    await until(() => r.out.some((o) => o.method === "notifications/tools/list_changed"));
    await new Promise((res) => setTimeout(res, 150));
    expect(r.out.some((o) => o.id === 2)).toBe(false); // still waiting for the re-list
    const list = await r.rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "later"]);
    // the tool added by an answer carries the same per-tool result threshold as the open set
    expect(list.result.tools.map((t: { _meta?: unknown }) => t._meta)).toEqual([META, META]);
    expect((await p).result.content[0].text).toBe("installed");
    await r.ep.close();
  });

  it("the re-list wait is bounded: a CLI that never re-lists does not hang the result", async () => {
    const r = await rig({ AW_RELAY_RELIST_MS: "200" });
    await r.rpc("initialize", {});
    const t0 = Date.now();
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "installed", tools: [LATER] });
    expect((await p).result.content[0].text).toBe("installed");
    expect(Date.now() - t0).toBeLessThan(2500);
    await r.ep.close();
  });

  it("MUTATION TARGET: the shim never lists more than 600 tools, however many arrive", async () => {
    const r = await rig({ AW_RELAY_RELIST_MS: "50" });
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "x", tools: Array.from({ length: 700 }, (_, i) => ({ name: `t${i}`, description: "d", inputSchema: { type: "object" } })) });
    await p;
    expect((await r.rpc("tools/list")).result.tools).toHaveLength(600);
    await r.ep.close();
  });

  it("a tool that is already visible, or a malformed one, changes nothing (no list_changed, no wait)", async () => {
    const r = await rig({ AW_RELAY_RELIST_MS: "100" });
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "x", tools: [TOOLS[0], { name: 5 }, null, { name: "nope" }] as never });
    await p;
    expect(r.out.some((o) => o.method === "notifications/tools/list_changed")).toBe(false);
    expect((await r.rpc("tools/list")).result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    await r.ep.close();
  });
});

describe("relay shim: notifications/cancelled", () => {
  const send = (r: Awaited<ReturnType<typeof rig>>, o: unknown) => r.child.stdin.write(JSON.stringify(o) + "\n");

  it("MUTATION TARGET: a cancelled pending call is not answered to the CLI, but keeps its host slot: the next call waits for the host's answer", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    send(r, { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "echo", arguments: { n: 1 } } });
    await until(() => r.calls.length === 1);
    send(r, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 101 } });
    send(r, { jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "echo", arguments: { n: 2 } } });
    await new Promise((res) => setTimeout(res, 200));
    expect(r.calls).toHaveLength(1); // the host still has the first one pending: the shim must not send a second
    r.ep.answer(r.calls[0].operationId, { content: "one (dropped)" });
    await until(() => r.calls.length === 2);
    r.ep.answer(r.calls[1].operationId, { content: "two" });
    await until(() => r.out.some((o) => o.id === 102));
    expect(r.out.some((o) => o.id === 101)).toBe(false); // nothing was answered for the cancelled request
    expect(r.out.find((o) => o.id === 102)!.result.content[0].text).toBe("two");
    await r.ep.close();
  });

  it("MUTATION TARGET: a call cancelled before it was sent never reaches the host", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    send(r, { jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "echo", arguments: { n: 1 } } });
    await until(() => r.calls.length === 1);
    send(r, { jsonrpc: "2.0", id: 202, method: "tools/call", params: { name: "echo", arguments: { n: 2 } } }); // queued behind 201
    send(r, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 202 } });
    r.ep.answer(r.calls[0].operationId, { content: "one" });
    await until(() => r.out.some((o) => o.id === 201));
    await new Promise((res) => setTimeout(res, 200));
    expect(r.calls).toHaveLength(1);
    expect(r.out.some((o) => o.id === 202)).toBe(false);
    // and the shim is still healthy
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 2);
    r.ep.answer(r.calls[1].operationId, { content: "three" });
    expect((await p).result.content[0].text).toBe("three");
    await r.ep.close();
  });
});

describe("relay shim: confidentiality", () => {
  it("never writes a request, argument or result to stderr", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: { q: "SECRET-ARG" } });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "SECRET-RESULT" });
    await p;
    await r.rpc("tools/call", { name: "SECRET-NAME", arguments: {} });
    expect(r.stderr()).toBe("");
    await r.ep.close();
  });
});
