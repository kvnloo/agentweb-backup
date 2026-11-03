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
import * as canonicalModule from "../relay/canonical";
import { TokenBucket } from "../relay/cpuMeter";
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

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
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
  it.each([5_000, 100_000, 500_000])("MUTATION TARGET: a stdout line nested %i deep is dropped before anything parses it; the turn completes normally and one fixed-code line is logged", async (k) => {
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

describe("one line cannot fan out into a flood of events", () => {
  const manyBlocks = (n: number, id: string) => ({ type: "assistant", message: { id, content: Array.from({ length: n }, (_, i) => ({ type: "text", text: "b" + i })) } });
  let refill: jest.SpyInstance | undefined;
  afterEach(() => refill?.mockRestore());

  it("MUTATION TARGET: a 5,000-block line yields at most the first 32 blocks as events (not 5,000)", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [manyBlocks(5000, "m1"), RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) events.push(ev);
    await session.close();
    expect(events.filter((e) => e.type === "text")).toHaveLength(32);
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: true });
    expect(rig.logs.filter((l) => l.event === "event_blocks_dropped")).toHaveLength(1); // said once, with a fixed code
  });

  it("MUTATION TARGET: a flood of 32-block lines (3,200 events in a burst, over the 2,000 normalized-events bucket) ends the turn: event_flood is logged once and the events stop", async () => {
    // The bucket REFILLS on the wall clock (200 events/s): with a real clock the flood lets through 2,000 + 200 x (seconds it took to handle) events, 2,016 after 80 ms on a
    // loaded runner, and a runner starved for 6 s would honestly absorb all 3,200 with no trip at all. So the refill is switched off for this test (the same bucket, the
    // same burst, nothing else changes) and the burst is then the exact bound whatever the load: 62 lines of 32 events fit 2,000, the 63rd does not.
    refill = jest.spyOn(TokenBucket.prototype as unknown as { refill(): void }, "refill").mockImplementation(() => undefined);
    const rig = makeRig();
    rig.scenario({ turn: [...Array.from({ length: 100 }, (_, i) => manyBlocks(32, "m" + i)), RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    const t0 = Date.now();
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) events.push(ev);
    await session.close();
    console.log("RESULT cpu events flood", JSON.stringify({ ms: Date.now() - t0, events: events.length }));
    expect(events.filter((e) => e.type === "text").length).toBe(Math.floor(2000 / 32) * 32); // 1,984: the burst, not 3,200
    expect(rig.logs.filter((l) => l.event === "event_flood")).toHaveLength(1);
    // the numbers of the bucket itself: burst 2,000, refill 200 per second (a mutant that raises either, or removes the bucket, fails)
    const bucket = (session as unknown as { eventBucket: { burst: number; perSec: number } }).eventBucket;
    expect({ burst: bucket.burst, perSec: bucket.perSec }).toEqual({ burst: 2000, perSec: 200 });
    // event_flood is a guard trip: the raw pipes of the child were closed before the signal
    expect((session as unknown as { childAdapter?: { pipesClosed: boolean } }).childAdapter?.pipesClosed).toBe(true); // (the raw stream is destroyed by node itself once the process is gone, so the adapter's own flag is what shows the trip)
    expect(events.some((e) => e.type === "result" && e.ok === true)).toBe(false);
  });
});

/** The relay replaced by a stub that hands the test its callbacks, so a call can be injected exactly as a bug in the relay would deliver it. */
function stubbed(messageIdWaitMs = 100, answerThrows = false) {
  const rig = makeRig(messageIdWaitMs);
  rig.scenario({ turn: [{ wait: 1500 }, RESULT_STEP] });
  let opened!: RelayOpenOptions;
  const rejected: string[] = [];
  let closed = 0;
  rig.host.open = async (o: RelayOpenOptions): Promise<RelayEndpoint> => {
    opened = o;
    return { dir: join(tmpdir(), "stub-relay-dir"), closed: false, answer: () => {
        if (answerThrows) throw new Error("boom: SECRET");
        return true;
      }, reject: (op) => (rejected.push(op), true), close: async () => void closed++ };
  };
  return { rig, opts: () => opened, rejected, closes: () => closed };
}
const call = (over: Partial<RelayCall> = {}): RelayCall => ({ identity: { connectionId: "conn1", epoch: 3, turnId: "t1" }, operationId: "a".repeat(32), name: "search", args: { q: 1 }, bytes: 80, ...over });

describe("relay session edges", () => {
  it("MUTATION TARGET: relay.open() failing (ENOSPC, EACCES...) is a retryable host-side failure (transient), not a failed turn (unknown), and nothing of the error is logged or kept", async () => {
    const rig = makeRig();
    rig.host.open = async () => {
      throw Object.assign(new Error("ENOSPC: no space left on /secret/relay/dir"), { code: "ENOSPC" });
    };
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) events.push(ev);
    await session.close();
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: false, errorKind: "transient" });
    expect(JSON.stringify(rig.logs)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("MUTATION TARGET: an answer after interrupt() is a LOST result (false), not delivered, even though the process may still be exiting; before it, the same answer is accepted", async () => {
    const s = stubbed(2000);
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 10_000 } })) void ev;
    })();
    await until(() => !!s.opts());
    const ans = { kind: "tool-result" as const, ok: true, content: "r" };
    expect(session.answer("a".repeat(32), ans)).toBe(true);
    await session.interrupt("t1");
    expect(session.answer("a".repeat(32), ans)).toBe(false);
    await session.close();
    await turn.catch(() => undefined);
  });
});

describe("a hostile unit and a hostile CLI together cannot stall the loop by making the host re-hash a call (loop-lag regression)", () => {
  type Priv = { noteStreamUse(raw: Record<string, unknown>): void; flushWaiting(force: boolean): void };
  async function withWaitingCall(args: Record<string, unknown>, bytes: number, preSpent = 0) {
    const s = stubbed(2000);
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 10_000 } })) void ev;
    })();
    await until(() => !!s.opts());
    const flush = jest.spyOn(session as unknown as Priv, "flushWaiting");
    const canonical = jest.spyOn(canonicalModule, "canonicalJson");
    (session as unknown as { hashedBytes: number }).hashedBytes = preSpent;
    s.opts().onCall(call({ args, bytes }));
    return { session: session as unknown as Priv & { close(): Promise<void> }, turn, flush, canonical, rejected: s.rejected, stop: async () => (canonical.mockRestore(), flush.mockRestore(), await (session as { close(): Promise<void> }).close(), await turn.catch(() => undefined)) };
  }
  const tiny = (i: number) => ({ type: "assistant", message: { id: `a${i}`, content: [] } });

  it("MUTATION TARGET: 759 KB of args and 1,500 tiny stream lines: the call is never canonicalized (too big to hash), and the lines do not re-check it", async () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 40_000; i++) args["k" + i] = "v".repeat(10);
    const bytes = Buffer.byteLength(JSON.stringify(args));
    expect(bytes).toBeGreaterThan(700_000);
    const w = await withWaitingCall(args, bytes);
    const t0 = Date.now();
    for (let i = 0; i < 1500; i++) w.session.noteStreamUse(tiny(i));
    expect(Date.now() - t0).toBeLessThan(10_000); // 22.8 s idle / 92 s loaded before the fix; catastrophe bound only (the gate fails closed: a slow runner must not block a deploy); the structural assertions are the pins
    expect(w.canonical).not.toHaveBeenCalled(); // above 64 KiB: matched by name only
    expect(w.flush).toHaveBeenCalledTimes(1); // only the check when the call arrived: tiny lines record nothing new, so they never re-check
    await w.stop();
  });

  it("MUTATION TARGET: a small call is hashed exactly ONCE however many lines follow", async () => {
    const w = await withWaitingCall({ q: "small" }, 40);
    for (let i = 0; i < 1500; i++) w.session.noteStreamUse(tiny(i));
    expect(w.canonical).toHaveBeenCalledTimes(1);
    expect(w.flush).toHaveBeenCalledTimes(1);
    await w.stop();
  });

  it("MUTATION TARGET: a call over 64 KiB is still tied to its message by NAME when exactly one announcement of that tool exists", async () => {
    const args: Record<string, unknown> = { pad: "x".repeat(100_000) };
    const w = await withWaitingCall(args, 100_050);
    w.session.noteStreamUse({ type: "assistant", message: { id: "mBigCall", content: [{ type: "tool_use", id: "t", name: "mcp__emma__search", input: { pad: "different" } }] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(w.flush.mock.calls.length).toBe(2); // the arrival and the new announcement
    await w.stop();
  });

  it("MUTATION TARGET: the budget covers the CALL too: once the turn has spent it, even a small call is not hashed (matched by name only)", async () => {
    const w = await withWaitingCall({ q: "small" }, 40, 8 * 1024 * 1024);
    expect(w.canonical).not.toHaveBeenCalled();
    await w.stop();
  });

  it("MUTATION TARGET: a new turn starts with a fresh hashing budget", async () => {
    const s = stubbed(2000);
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    (session as unknown as { hashedBytes: number }).hashedBytes = 8 * 1024 * 1024;
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t9", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 10_000 } })) void ev;
    })();
    await until(() => !!s.opts());
    expect((session as unknown as { hashedBytes: number }).hashedBytes).toBe(0);
    await session.close();
    await turn.catch(() => undefined);
  });

  it("MUTATION TARGET: a hard per-turn budget on bytes hashed: 400 announcements of ~50 KB (each under the 64 KiB limit) cost at most 8 MiB of hashing, then nothing is hashed or recorded", async () => {
    const w = await withWaitingCall({ q: "x" }, 20);
    w.canonical.mockClear();
    (w.session as unknown as { visibleTools: Set<string> }).visibleTools.add("search");
    for (let i = 0; i < 400; i++) {
      w.session.noteStreamUse({ type: "assistant", message: { id: "m" + i, content: [{ type: "tool_use", id: "t", name: "mcp__emma__search", input: { pad: "x".repeat(50_000) + i } }] } });
    }
    expect(w.canonical.mock.calls.length).toBeLessThanOrEqual(170); // 8 MiB / ~50 KB
    expect(w.canonical.mock.calls.length).toBeGreaterThan(100);
    await w.stop();
  });

  it("MUTATION TARGET: the relay endpoint is opened with the turn's OWN meter (one budget for stdout, stderr, events and relay frames, not two)", async () => {
    const s = stubbed(2000);
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 10_000 } })) void ev;
    })();
    await until(() => !!s.opts());
    const turnMeter = (session as unknown as { meter: unknown }).meter;
    expect(turnMeter).toBeDefined();
    expect(s.opts().meter).toBe(turnMeter);
    await session.close();
    await turn.catch(() => undefined);
  });

  it("MUTATION TARGET: an announcement of a tool the turn does NOT offer is not recorded and consumes none of the hashing budget", async () => {
    const w = await withWaitingCall({ q: "x" }, 20);
    const before = (w.session as unknown as { hashedBytes: number }).hashedBytes;
    w.canonical.mockClear();
    for (let i = 0; i < 50; i++) w.session.noteStreamUse({ type: "assistant", message: { id: "m" + i, content: [{ type: "tool_use", id: "t", name: "mcp__emma__not_offered", input: { pad: "x".repeat(100_000) } }] } });
    expect((w.session as unknown as { streamUses: unknown[] }).streamUses).toHaveLength(0);
    expect((w.session as unknown as { hashedBytes: number }).hashedBytes).toBe(before);
    expect(w.canonical).not.toHaveBeenCalled();
    await w.stop();
  });

  it("MUTATION TARGET: MAX_BLOCKS_PER_EVENT: of a 300-block event only the first 32 blocks are considered (a tool_use in block 31 is recorded, one in block 32+ is not)", async () => {
    const w = await withWaitingCall({ q: "x" }, 20);
    (w.session as unknown as { visibleTools: Set<string> }).visibleTools.add("other"); // (not the waiting call's tool, so an announcement is kept rather than claimed by it)
    const uses = () => (w.session as unknown as { streamUses: Array<{ messageId: string }> }).streamUses;
    const filler = (n: number) => Array.from({ length: n }, () => ({ type: "text", text: "t" }));
    const use = (id: string) => ({ type: "tool_use", id, name: "mcp__emma__other", input: { id } });
    w.session.noteStreamUse({ type: "assistant", message: { id: "mIn", content: [...filler(31), use("in")] } }); // index 31: the 32nd block
    w.session.noteStreamUse({ type: "assistant", message: { id: "mOut", content: [...filler(32), use("out")] } }); // index 32: the 33rd
    const ids = uses().map((u) => u.messageId);
    expect(ids).toContain("mIn");
    expect(ids).not.toContain("mOut");
    await w.stop();
  });

  it("MUTATION TARGET: one 16 MB-style event of a quarter million tiny tool_use blocks examines a bounded number of them", async () => {
    const w = await withWaitingCall({ q: "x" }, 20);
    w.canonical.mockClear();
    (w.session as unknown as { visibleTools: Set<string> }).visibleTools.add("search");
    const blocks = Array.from({ length: 250_000 }, (_, i) => ({ type: "tool_use", id: "t" + i, name: "mcp__emma__search", input: { i } }));
    const t0 = Date.now();
    w.session.noteStreamUse({ type: "assistant", message: { id: "mHuge", content: blocks } });
    expect(Date.now() - t0).toBeLessThan(10_000); // catastrophe bound only (the gate fails closed: a slow runner must not block a deploy); the structural assertions are the pins
    expect(w.canonical.mock.calls.length).toBeLessThanOrEqual(64); // at most MAX_STREAM_USES announcements are recorded, the rest are never looked at
    await w.stop();
  });
});

describe("which model message a relayed call is tied to (the stream announcements are only a hint)", () => {
  async function tie(announce: Array<{ id: string; name?: string; input: unknown }>, args: Record<string, unknown>): Promise<string> {
    const s = stubbed(150);
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: [...TOOLS, { name: "other", description: "o", inputSchema: { type: "object", properties: {} } }], callTimeoutMs: () => 5000 } })) events.push(ev);
    })();
    await until(() => !!s.opts());
    for (const an of announce) {
      (session as unknown as { noteStreamUse(raw: Record<string, unknown>): void }).noteStreamUse({ type: "assistant", message: { id: an.id, content: [{ type: "tool_use", id: "tu-" + an.id, name: `mcp__emma__${an.name ?? "search"}`, input: an.input }] } });
    }
    s.opts().onCall(call({ args }));
    await until(() => events.some((e) => e.type === "tool-call"));
    const id = (events.find((e) => e.type === "tool-call") as Extract<ProviderEvent, { type: "tool-call" }>).messageId;
    await session.close();
    await turn.catch(() => undefined);
    return id;
  }

  it("MUTATION TARGET: the announcement with the SAME input wins over another of the same tool", async () => {
    expect(await tie([{ id: "mA", input: { q: 1 } }, { id: "mB", input: { q: 2 } }], { q: 2 })).toBe("mB");
    expect(await tie([{ id: "mA", input: { q: 1 } }, { id: "mB", input: { q: 2 } }], { q: 1 })).toBe("mA");
  });

  it("MUTATION TARGET: when the inputs differ but exactly ONE announcement of that tool exists, it is used; with two or more it is NOT guessed (a unique id, so the backend never collapses two different calls)", async () => {
    expect(await tie([{ id: "mOnly", input: { q: 1 } }], { q: "different" })).toBe("mOnly");
    expect(await tie([{ id: "mA", input: { q: 1 } }, { id: "mB", input: { q: 2 } }], { q: 3 })).toMatch(/^unmatched-/);
  });

  it("MUTATION TARGET: an announcement of ANOTHER tool never matches; a big announcement (name only, never hashed) ties a call only when it is the ONLY announcement of that tool", async () => {
    expect(await tie([{ id: "mX", name: "other", input: { q: 1 } }], { q: 1 })).toMatch(/^unmatched-/);
    expect(await tie([{ id: "mBig", input: { blob: "x".repeat(2 * 1024 * 1024) } }], { blob: "x" })).toBe("mBig");
    expect(await tie([{ id: "mBig1", input: { blob: "x".repeat(200 * 1024) } }, { id: "mBig2", input: { blob: "y".repeat(200 * 1024) } }], { blob: "x" })).toMatch(/^unmatched-/);
  });
});

describe("a failure while handling a call is contained: the call is answered with an internal error, the endpoint is closed, nothing is thrown", () => {
  async function run(inject: (o: RelayOpenOptions) => void, withSession?: (session: unknown) => void) {
    const s = stubbed();
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const events: ProviderEvent[] = [];
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) events.push(ev);
    })();
    await until(() => !!s.opts());
    withSession?.(session);
    inject(s.opts());
    await new Promise((r) => setTimeout(r, 400)); // past the message-id wait: the TIMER path has run
    const closesBeforeCleanup = s.closes(); // what the guard itself did, before the test's own session.close() closes the endpoint too
    await session.close();
    await turn.catch(() => undefined);
    return { ...s, events, closesBeforeCleanup };
  }

  it("MUTATION TARGET: args nested too deeply for a call that reached the adapter (a relay bug): refused, never forwarded with a marker or executed", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    const r = await run((o) => o.onCall(call({ args: { a: deep } as never })));
    expect(uncaught).toEqual([]);
    expect(r.events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    expect(r.rejected).toEqual(["a".repeat(32)]);
    expect(r.closesBeforeCleanup).toBeGreaterThan(0);
  });

  it("MUTATION TARGET: a failure that happens only LATER, in the message-id TIMER (the first look at the call was fine), is contained the same way", async () => {
    let sessionRef: { events: unknown } | undefined;
    const r = await run((o) => {
      o.onCall(call()); // fine: it waits for its message id
      // the queue the timer will push to breaks before the timer fires
      (sessionRef as { events: unknown }).events = { push: () => { throw new Error("late boom: SECRET"); } };
    }, (session) => (sessionRef = session as never));
    expect(uncaught).toEqual([]);
    expect(r.events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    expect(r.rejected).toEqual(["a".repeat(32)]);
    expect(r.closesBeforeCleanup).toBeGreaterThan(0);
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

  it("MUTATION TARGET: stream bookkeeping that fails while a call waits for its message id rejects that call and closes the endpoint (guarded in onEvent; the runner would otherwise swallow it silently)", async () => {
    const s = stubbed(1500);
    s.rig.scenario({ turn: [{ wait: 300 }, { type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "tu1", name: "mcp__emma__search", input: { q: 1 } }] } }, RESULT_STEP] });
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    (session as unknown as { noteStreamUse(): void }).noteStreamUse = () => {
      throw new Error("stream boom: SECRET");
    };
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) void ev;
    })();
    await until(() => !!s.opts());
    s.opts().onCall(call()); // waiting for its message id (1.5 s)
    await until(() => s.rejected.length === 1);
    expect(s.rejected).toEqual(["a".repeat(32)]);
    expect(s.closes()).toBeGreaterThan(0);
    expect(uncaught).toEqual([]);
    await session.close();
    await turn.catch(() => undefined);
  });

  it("MUTATION TARGET: an endpoint whose answer() throws makes the session's answer() report the result lost, not throw", async () => {
    const s = stubbed(100, true);
    const session = await s.rig.adapter.openSession(s.rig.ctx, { connectionId: "conn1", epoch: 3 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 5000 } })) void ev;
    })();
    await until(() => !!s.opts());
    expect(session.answer("a".repeat(32), { kind: "tool-result", ok: true, content: "x" })).toBe(false);
    await session.close();
    await turn.catch(() => undefined);
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
