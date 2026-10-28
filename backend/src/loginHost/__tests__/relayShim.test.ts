/**
 * ENG-2113: the stdio shim as a process, driven as the CLI would drive it (JSON-RPC lines on stdin/stdout) against a real RelayHost socket.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Layout } from "../ports/layout";
import { RelayHost, type RelayCall, type RelayEndpoint } from "../relay/relayServer";
import type { ToolDef } from "../protocol";

const SHIM = join(__dirname, "..", "deploy", "aw-relay-shim.js");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const procs: ChildProcessWithoutNullStreams[] = [];
afterEach(() => procs.splice(0).forEach((p) => p.kill("SIGKILL")));

const TOOLS: ToolDef[] = [
  { name: "echo", description: "Echo", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "later", description: "Locked", inputSchema: { type: "object", properties: {} }, locked: true },
];

async function rig(env: Record<string, string> = {}, limits: { idleMs?: number } = {}, tools: unknown = TOOLS) {
  const root = mkdtempSync(join(tmpdir(), "relay-shim-"));
  roots.push(root);
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot: join(root, "relay") });
  const host = new RelayHost({ layout, ownByUid: false, limits });
  host.init();
  const calls: RelayCall[] = [];
  const visible = new Set(TOOLS.filter((t) => !t.locked).map((t) => t.name));
  const ep: RelayEndpoint = await host.open({ uid: 400_001, identity: { connectionId: "c", epoch: 1, turnId: "t" }, onCall: (c) => void calls.push(c), allowTool: (n) => visible.has(n), callTimeoutMs: () => 10_000 });
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
  return { ep, calls, visible, child, out, rpc, stderr: () => err, host, layout, root };
}
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("until: timed out");
}

describe("relay shim: MCP surface", () => {
  it("initialize advertises listChanged; tools/list shows only unlocked tools; ping works; unknown methods are errors", async () => {
    const r = await rig();
    const init = await r.rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(init.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } } });
    const list = await r.rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);
    expect(list.result.tools[0]).toEqual({ name: "echo", description: "Echo", inputSchema: TOOLS[0].inputSchema });
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

  it("a tool that is not listed (locked, or unknown) is refused locally and never sent", async () => {
    const r = await rig();
    await r.rpc("initialize", {});
    for (const name of ["later", "nope", 5, undefined]) {
      const res = (await r.rpc("tools/call", { name, arguments: {} })).result;
      expect(res).toMatchObject({ isError: true });
    }
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

describe("relay shim: keepalive and unlock", () => {
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

  it("an unlock adds the tool, sends tools/list_changed and WAITS for the CLI's re-list before returning the result", async () => {
    const r = await rig({ AW_RELAY_RELIST_MS: "3000" });
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    r.visible.add("later"); // what the adapter does when it forwards an unlock
    r.ep.answer(r.calls[0].operationId, { content: "installed", unlock: ["later"] });
    await until(() => r.out.some((o) => o.method === "notifications/tools/list_changed"));
    await new Promise((res) => setTimeout(res, 150));
    expect(r.out.some((o) => o.id === 2)).toBe(false); // still waiting for the re-list
    const list = await r.rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "later"]);
    expect((await p).result.content[0].text).toBe("installed");
    await r.ep.close();
  });

  it("the re-list wait is bounded: a CLI that never re-lists does not hang the result", async () => {
    const r = await rig({ AW_RELAY_RELIST_MS: "200" });
    await r.rpc("initialize", {});
    const t0 = Date.now();
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "installed", unlock: ["later"] });
    expect((await p).result.content[0].text).toBe("installed");
    expect(Date.now() - t0).toBeLessThan(2500);
    await r.ep.close();
  });

  it("an unlock naming a tool outside the manifest, or one already visible, changes nothing", async () => {
    const r = await rig({ AW_RELAY_RELIST_MS: "100" });
    await r.rpc("initialize", {});
    const p = r.rpc("tools/call", { name: "echo", arguments: {} });
    await until(() => r.calls.length === 1);
    r.ep.answer(r.calls[0].operationId, { content: "x", unlock: ["ghost", "echo"] });
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
