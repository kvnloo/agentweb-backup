/**
 * ENG-2113 (security review): hostile shim frames and hostile CLI output must never reach a place that throws out of a timer or an event handler, because an
 * uncaught exception ends the whole host process for every customer. Real adapter, real relay socket; the test plays the shim itself over a raw socket
 * (scenario `noShim`) or calls the relay callbacks directly.
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { connect, type Socket } from "net";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AdapterContext, ChildLike, ProviderEvent, SpawnSpec } from "../adapter";
import { ClaudeAdapter } from "../adapters/claudeAdapter";
import { Layout } from "../ports/layout";
import { RelayHost, type RelayCall, type RelayEndpoint, type RelayOpenOptions } from "../relay/relayServer";
import type { ToolDef } from "../protocol";

const FAKE = join(__dirname, "fakeClaude.js");
const WRAPPER = join(__dirname, "..", "deploy", "claude-turn.sh");
const SHIM = join(__dirname, "..", "deploy", "aw-relay-shim.js");
const NODE_DIR = dirname(process.execPath);
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
const TOOLS: ToolDef[] = [{ name: "search", description: "Search", inputSchema: { type: "object", properties: {} } }];
const RESULT_STEP = { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 } };

let uncaught: unknown[];
const onU = (e: unknown) => void uncaught.push(e);
beforeEach(() => {
  uncaught = [];
  process.on("uncaughtException", onU);
});
afterEach(() => void process.off("uncaughtException", onU));

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 15));
  if (!cond()) throw new Error("until: timed out");
}

function makeRig(messageIdWaitMs = 200) {
  const root = mkdtempSync(join(tmpdir(), "claude-hostile-"));
  roots.push(root);
  const [homeDir, workDir, tmpDir, unitTmp] = ["home", "work", "tmp", "unit-tmp"].map((d) => join(root, d));
  for (const d of [homeDir, workDir, tmpDir, unitTmp]) mkdirSync(d, { recursive: true });
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot: join(root, "relay") });
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const log = { warn: (event: string, fields?: Record<string, unknown>) => void logs.push({ event, fields }) };
  const host = new RelayHost({ layout, ownByUid: false, log });
  host.init();
  const spawns: SpawnSpec[] = [];
  const spawnAs = (spec: SpawnSpec): ChildLike => {
    spawns.push(spec);
    const c = spawn(spec.file, spec.args, { env: { ...spec.env, ...(spec.relayDir ? { AW_FAKE_RELAY_MOUNT: spec.relayDir } : {}) }, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
    return { stdin: c.stdin, stdout: c.stdout, stderr: c.stderr, kill: () => void c.kill("SIGKILL"), onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)), onError: (cb) => void c.on("error", (err) => (c.pid === undefined ? cb(err) : undefined)) };
  };
  const ctx: AdapterContext = { connectionId: "conn1", uid: 400_001, homeDir, workDir, tmpDir, spawnAs };
  const adapter = new ClaudeAdapter({
    binary: { path: FAKE, version: "2.1.294", digest: "sha256:fake" },
    systemPromptFile: "/opt/aw/prompt.txt",
    turnWrapperPath: WRAPPER,
    bridgeUrl: "http://127.0.0.1:3001/mcp",
    basePath: `${NODE_DIR}:/usr/bin:/bin`,
    unitTmp,
    killWaitMs: 3000,
    messageIdWaitMs,
    relay: { host, shimPath: SHIM, nodePath: process.execPath },
    log,
  });
  return { adapter, ctx, host, spawns, logs, scenario: (s: Record<string, unknown>) => writeFileSync(join(homeDir, ".fake-scenario"), JSON.stringify(s)) };
}

const deepFrame = (k: number, callId = "x1") => `{"type":"call","callId":"${callId}","name":"search","args":{"a":${"[".repeat(k)}${"]".repeat(k)}}}\n`;
const rawClient = async (path: string) => {
  const s: Socket = connect(path);
  s.on("error", () => undefined);
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
  await new Promise<void>((r) => s.once("connect", () => r()));
  return { s, lines, isClosed: () => closed };
};

describe("hostile shim over the real relay socket (the reviewer's reproduction)", () => {
  it("MUTATION TARGET: a frame nested 300,000 deep does not crash the host through the message-id timer; the turn goes on and a normal call still works", async () => {
    const rig = makeRig(250);
    rig.scenario({ noShim: true, turn: [{ wait: 3000 }, RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    const run = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 20_000 } })) events.push(ev);
    })();
    await until(() => rig.spawns.some((s) => s.relayDir));
    const dir = rig.spawns.find((s) => s.relayDir)!.relayDir!;
    await until(() => existsSync(`${dir}/relay.sock`));
    const frame = deepFrame(300_000);
    expect(Buffer.byteLength(frame)).toBeLessThan(1024 * 1024);
    const hostile = await rawClient(`${dir}/relay.sock`);
    hostile.s.write(frame);
    await until(() => hostile.isClosed());
    await new Promise((r) => setTimeout(r, 600)); // longer than the message-id wait: the timer that used to throw has run
    expect(uncaught).toEqual([]);
    expect(rig.logs.map((l) => l.fields?.code).filter(Boolean)).toEqual(["frame_too_deep"]);
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    // the same endpoint serves an ordinary call afterwards
    const good = await rawClient(`${dir}/relay.sock`);
    good.s.write(JSON.stringify({ type: "call", callId: "g1", name: "search", args: { q: "x" } }) + "\n");
    await until(() => events.some((e) => e.type === "tool-call"));
    const call = events.find((e) => e.type === "tool-call") as Extract<ProviderEvent, { type: "tool-call" }>;
    expect(call.input).toEqual({ q: "x" });
    expect(session.answer(call.operationId, { kind: "tool-result", ok: true, content: "fine" })).toBe(true);
    await until(() => good.lines.length === 1);
    expect(JSON.parse(good.lines[0])).toMatchObject({ type: "result", callId: "g1", content: "fine" });
    good.s.destroy();
    await session.close();
    await run.catch(() => undefined);
    expect(uncaught).toEqual([]);
  });
});

describe("a hostile CLI printing a deeply nested line", () => {
  it.each([5_000, 100_000, 1_000_000])("MUTATION TARGET: a stdout line nested %i deep is dropped before anything parses it; the turn completes normally and one fixed-code line is logged", async (k) => {
    const rig = makeRig();
    rig.scenario({ deepline: k, turn: [{ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hello" }] } }, RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    const t0 = Date.now();
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) events.push(ev);
    await session.close();
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(events.map((e) => e.type)).toEqual(["text", "usage", "result"]);
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: true });
    expect(rig.logs.filter((l) => l.event === "cli_line_too_deep")).toEqual([{ event: "cli_line_too_deep", fields: undefined }]);
    expect(uncaught).toEqual([]);
  });
});

/** The relay replaced by a stub that hands the test its callbacks, so a call can be injected exactly as a bug in the relay would deliver it. */
function stubbed() {
  const rig = makeRig(100);
  rig.scenario({ turn: [{ wait: 1500 }, RESULT_STEP] });
  let opened!: RelayOpenOptions;
  const rejected: string[] = [];
  let closed = 0;
  rig.host.open = async (o: RelayOpenOptions): Promise<RelayEndpoint> => {
    opened = o;
    return { dir: join(tmpdir(), "stub-relay-dir"), closed: false, answer: () => true, reject: (op) => (rejected.push(op), true), close: async () => void closed++ };
  };
  return { rig, opts: () => opened, rejected, closes: () => closed };
}
const call = (over: Partial<RelayCall> = {}): RelayCall => ({ identity: { connectionId: "conn1", epoch: 3, turnId: "t1" }, operationId: "a".repeat(32), name: "search", args: { q: 1 }, bytes: 80, ...over });

describe("a failure while handling a call is contained: the call is answered with an internal error, the endpoint is closed, nothing is thrown", () => {
  async function run(inject: (o: RelayOpenOptions) => void) {
    const s = stubbed();
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) events.push(ev);
    })();
    await until(() => !!s.opts());
    inject(s.opts());
    await new Promise((r) => setTimeout(r, 400)); // past the message-id wait: the TIMER path has run
    await session.close();
    await turn.catch(() => undefined);
    return { ...s, events };
  }

  it("MUTATION TARGET: args nested too deeply for a call that reached the adapter (a relay bug): refused, never forwarded with a marker or executed", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const r = await run((o) => o.onCall(call({ args: { a: deep } as never })));
    expect(uncaught).toEqual([]);
    expect(r.events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    expect(r.rejected).toEqual(["a".repeat(32)]);
    expect(r.closes()).toBeGreaterThan(0);
  });

  it("MUTATION TARGET: args whose very access throws (the timer path): contained the same way", async () => {
    const args = {} as Record<string, unknown>;
    Object.defineProperty(args, "q", { enumerable: true, get: () => { throw new Error("boom: SECRET-TEXT"); } });
    const r = await run((o) => o.onCall(call({ args })));
    expect(uncaught).toEqual([]);
    expect(r.events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    expect(r.rejected).toEqual(["a".repeat(32)]);
    expect(JSON.stringify(r.rig.logs)).not.toContain("SECRET");
  });

  it("MUTATION TARGET: the event's size is accounted from the frame the relay measured, never by stringifying the input", async () => {
    let stringified = false;
    const args = { q: "x", toJSON() { stringified = true; return {}; } };
    const r = await run((o) => o.onCall(call({ args: args as never })));
    expect(r.events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    expect(stringified).toBe(false);
    expect(uncaught).toEqual([]);
  });

  it("MUTATION TARGET: a call that arrives after the turn was closed is dropped (no waiting timer, no event)", async () => {
    const s = stubbed();
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) void ev;
    })();
    await until(() => !!s.opts());
    await session.close();
    await turn.catch(() => undefined);
    s.opts().onCall(call());
    expect((session as unknown as { waiting: unknown }).waiting).toBeUndefined();
    expect(uncaught).toEqual([]);
  });

  it("MUTATION TARGET: answer() with a non-result answer is refused even when a relay exists", async () => {
    const s = stubbed();
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) void ev;
    })();
    await until(() => !!s.opts());
    expect(session.answer("a".repeat(32), { kind: "decline" })).toBe(false);
    expect(session.answer("a".repeat(32), { kind: "tool-result", ok: true, content: "x" })).toBe(true); // the stub endpoint accepts: proves the decline was refused by the kind check
    await session.close();
    await turn.catch(() => undefined);
  });
});
