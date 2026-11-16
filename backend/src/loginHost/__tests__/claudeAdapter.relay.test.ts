/**
 * ENG-2113: the Claude adapter's tool relay end to end, with REAL processes: the scripted CLI (fakeClaude.js, which speaks stdio MCP like the real one) starts the
 * REAL shim (deploy/aw-relay-shim.js) through the REAL turn wrapper, and the shim talks to the REAL per-turn relay socket of a RelayHost. Only the systemd bind
 * mount is replaced by an environment variable (AW_FAKE_RELAY_MOUNT = the host directory the unit would see at /run/aw-relay).
 */
import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AdapterContext, ChildLike, ProviderEvent, ProviderSession, SpawnSpec } from "../adapter";
import { ClaudeAdapter } from "../adapters/claudeAdapter";
import * as canonicalModule from "../relay/canonical";
import { Layout } from "../ports/layout";
import { RelayHost } from "../relay/relayServer";
import { IMAGE_LIMITS, RELAY_RESULT_MAX_BYTES, TOOL_LIMITS, relayCliEnv, type ToolDef } from "../protocol";
import { assertEnvName, assertEnvValue } from "../ports/layout";

const FAKE = join(__dirname, "fakeClaude.js");
const WRAPPER = join(__dirname, "..", "deploy", "claude-turn.sh");
const SHIM = join(__dirname, "..", "deploy", "aw-relay-shim.js");
const NODE_DIR = dirname(process.execPath);
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const TOOLS: ToolDef[] = [
  { name: "search", description: "Search the knowledge base", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  { name: "write_note", description: "Write a note", inputSchema: { type: "object", properties: {} } },
];
/** Arrives with an answer (a skill install), not in the open set. */
const LATE: ToolDef = { name: "late", description: "Appears after an install", inputSchema: { type: "object", properties: {} } };

interface Rig {
  adapter: ClaudeAdapter;
  ctx: AdapterContext;
  host: RelayHost;
  layout: Layout;
  spawns: SpawnSpec[];
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  unitTmp: string;
  scenario(s: Record<string, unknown>): void;
  mcpLog(): { lists: string[][]; calls: Array<{ name: string; ms: number; isError: boolean; text: string; images: number }>; stderr: string; shimPid?: number; exited?: boolean };
  opened: Array<{ uid: number; identity: unknown }>;
}

function makeRig(over: { relay?: boolean; messageIdWaitMs?: number } = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "claude-relay-test-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const workDir = join(root, "work");
  const tmpDir = join(root, "tmp");
  const unitTmp = join(root, "unit-tmp");
  for (const d of [homeDir, workDir, tmpDir, unitTmp]) mkdirSync(d, { recursive: true });
  const layout = new Layout({ env: "t1", stateRoot: "/var/lib/aw-login-host/t1", sharedParent: "/var/lib/aw-login-host", uidMin: 400_000, uidMax: 400_100, relayRoot: join(root, "relay") });
  const logs: Rig["logs"] = [];
  const host = new RelayHost({ layout, ownByUid: false, log: { warn: (event, fields) => void logs.push({ event, fields }) } });
  host.init();
  const opened: Rig["opened"] = [];
  const realOpen = host.open.bind(host);
  host.open = (o) => {
    opened.push({ uid: o.uid, identity: o.identity });
    return realOpen(o);
  };
  const spawns: SpawnSpec[] = [];
  const spawnAs = (spec: SpawnSpec): ChildLike => {
    spawns.push(spec);
    // The stand-in for `BindReadOnlyPaths=<relayDir>:/run/aw-relay`.
    const env = { ...spec.env, ...(spec.relayDir ? { AW_FAKE_RELAY_MOUNT: spec.relayDir } : {}) };
    const c = spawn(spec.file, spec.args, { env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
    return {
      stdin: c.stdin,
      stdout: c.stdout,
      stderr: c.stderr,
      kill: () => void c.kill("SIGKILL"),
      onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)),
      onError: (cb) => void c.on("error", (err) => (c.pid === undefined ? cb(err) : undefined)),
    };
  };
  const ctx: AdapterContext = { connectionId: "conn1", uid: 400_001, homeDir, workDir, tmpDir, spawnAs };
  const adapter = new ClaudeAdapter({
    binary: { path: FAKE, version: "2.1.294", digest: "sha256:fake" },
    systemPromptFile: "/opt/aw/prompt.txt",
    turnWrapperPath: WRAPPER,
    bridgeUrl: "http://127.0.0.1:3001/internal/tool-bridge/run/mcp",
    basePath: `${NODE_DIR}:/usr/bin:/bin`,
    unitTmp,
    killWaitMs: 3000,
    ...(over.relay === false ? {} : { relay: { host, shimPath: SHIM, nodePath: process.execPath } }),
    ...(over.messageIdWaitMs !== undefined ? { messageIdWaitMs: over.messageIdWaitMs } : {}),
  });
  return {
    adapter,
    ctx,
    host,
    layout,
    spawns,
    logs,
    unitTmp,
    opened,
    scenario: (s) => writeFileSync(join(homeDir, ".fake-scenario"), JSON.stringify(s)),
    mcpLog: () => JSON.parse(readFileSync(join(homeDir, ".fake-mcp-log.json"), "utf8")),
  };
}

const RESULT_STEP = { type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 } };
const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  if (!cond()) throw new Error("until: timed out");
}

type Handler = (ev: Extract<ProviderEvent, { type: "tool-call" }>, session: ProviderSession) => void | Promise<void>;
/** Runs a relay turn; `onCall` answers (or not) each tool-call event as the backend would. */
async function runTurn(rig: Rig, onCall: Handler, input: { callTimeoutMs?: () => number; tools?: ToolDef[]; turnId?: string } = {}): Promise<{ events: ProviderEvent[]; session: ProviderSession }> {
  const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 3 });
  const events: ProviderEvent[] = [];
  for await (const ev of session.turn({ turnId: input.turnId ?? "t1", prompt: "go", model: "sonnet", relay: { tools: input.tools ?? TOOLS, callTimeoutMs: input.callTimeoutMs ?? (() => 20_000) } })) {
    events.push(ev);
    if (ev.type === "tool-call") await onCall(ev, session);
  }
  await session.close();
  return { events, session };
}

describe("claude adapter: tool relay end to end", () => {
  it("a stdio tool call completes: the CLI calls the shim, the host emits tool-call, the answer comes back to the CLI", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: { q: "x" } } }, RESULT_STEP] });
    const { events } = await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "RESULT-TEXT" }));
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ type: "tool-call", messageId: "msg1", name: "search", input: { q: "x" } });
    expect((calls[0] as { operationId: string }).operationId).toMatch(/^[a-f0-9]{32}$/);
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: true });
    const log = rig.mcpLog();
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0]).toMatchObject({ name: "search", isError: false, text: "RESULT-TEXT" });
    expect(log.lists[0]).toEqual(["search", "write_note"]); // a tool that has not arrived yet is not listed
  });

  it("DOUBLE EXECUTION: the stream's tool_use/tool_result are informational events with their own ids; exactly one tool-call per shim call", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: {} } }, { mcpCall: { name: "write_note", args: {} } }, RESULT_STEP] });
    const { events } = await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "ok" }));
    const toolCalls = events.filter((e) => e.type === "tool-call") as Array<{ operationId: string; name: string }>;
    const toolUses = events.filter((e) => e.type === "tool-use") as Array<{ operationId: string; name: string }>;
    expect(toolCalls.map((e) => e.name)).toEqual(["search", "write_note"]);
    expect(toolUses).toHaveLength(2); // the model's view of the same calls
    const ids = new Set([...toolCalls, ...toolUses].map((e) => e.operationId));
    expect(ids.size).toBe(4); // no stream id doubles as an operation id and vice versa
    expect(rig.mcpLog().calls).toHaveLength(2);
  });

  it("the answer is also refused for a stream tool_use id (no such pending operation)", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: {} } }, RESULT_STEP] });
    let streamRefused: boolean | void = true;
    await runTurn(rig, (ev, s) => {
      streamRefused = s.answer("tumsg1-1", { kind: "tool-result", ok: true, content: "nope" });
      s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "real" });
    });
    expect(streamRefused).toBe(false);
    expect(rig.mcpLog().calls[0].text).toBe("real");
  });

  it("identity is fixed at open() from the session and the turn, with the uid of the context; the unit gets this turn's directory", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    await runTurn(rig, () => undefined, { turnId: "turn-xyz" });
    expect(rig.opened).toEqual([{ uid: 400_001, identity: { connectionId: "conn1", epoch: 3, turnId: "turn-xyz" } }]);
    const turnSpawn = rig.spawns.find((s) => s.relayDir);
    expect(turnSpawn?.relayDir).toMatch(new RegExp(`^${rig.layout.relayRoot}/400001/[a-f0-9]{32}$`));
    expect(rig.layout.isRelayDirOf(400_001, turnSpawn!.relayDir!)).toBe(true);
  });

  it("images and the error flag reach the CLI", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: {} } }, RESULT_STEP] });
    await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: false, content: "shot", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }] }));
    expect(rig.mcpLog().calls[0]).toMatchObject({ isError: true, text: "shot", images: 1 });
  });

  it("tools that arrive with an answer: the shim announces them, the CLI re-lists, and the new tool can be called in the SAME run", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: {} } }, { mcpCall: { name: "late", args: {} } }, RESULT_STEP] });
    await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: ev.name === "search" ? "installed" : "late-ok", ...(ev.name === "search" ? { tools: [LATE] } : {}) }));
    const log = rig.mcpLog();
    expect(log.lists).toEqual([["search", "write_note"], ["search", "write_note", "late"]]);
    expect(log.calls.map((c) => [c.name, c.text, c.isError])).toEqual([["search", "installed", false], ["late", "late-ok", false]]);
  });

  it("a tool that never arrived is refused by the shim and never reaches the host", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "late", args: {} } }, RESULT_STEP] });
    const { events } = await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "should not run" }));
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(0);
    expect(rig.mcpLog().calls[0]).toMatchObject({ name: "late", isError: true });
  });

  it("a call that outlives the per-turn clock gets an error in the CLI; the late answer is refused (result lost)", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: {} } }, RESULT_STEP] });
    let late: boolean | void = true;
    await runTurn(
      rig,
      async (ev, s) => {
        await until(() => rig.mcpLog().calls.length === 1);
        late = s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "too late" });
      },
      { callTimeoutMs: () => 300 },
    );
    expect(rig.mcpLog().calls[0]).toMatchObject({ isError: true, text: "The tool call timed out." });
    expect(late).toBe(false);
  });

  it("the call clock is read per call (a long deadline is not cut at the host default)", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: {} } }, RESULT_STEP] });
    const reads: number[] = [];
    await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "ok" }), { callTimeoutMs: () => (reads.push(1), 590_000) });
    expect(reads).toHaveLength(2); // once when the unit starts (the CLI's own tool timeout is set from it), once for the call
  });

  it("abort mid-tool: interrupt tears down the socket, the pending operation and the CLI; no shim process and no relay directory remain", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: {} } }, RESULT_STEP] });
    let opId = "";
    const { session } = await runTurn(rig, async (ev, s) => {
      opId = ev.operationId;
      await s.interrupt("t1"); // the host aborted the turn while the tool was running
    });
    const dir = rig.spawns.find((s) => s.relayDir)!.relayDir!;
    expect(existsSync(dir)).toBe(false);
    expect(session.answer(opId, { kind: "tool-result", ok: true, content: "late" })).toBe(false);
    const pid = rig.mcpLog().shimPid!;
    await until(() => isGone(pid));
  });

  it("no relay for a turn that has already ended: the socket is gone and a late connection fails", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    await runTurn(rig, () => undefined);
    const dir = rig.spawns.find((s) => s.relayDir)!.relayDir!;
    expect(existsSync(`${dir}/relay.sock`)).toBe(false);
  });

  it("messageId: a call is tied to the model message that carried it; without a matching stream block it gets a unique id after the wait", async () => {
    const rig = makeRig({ messageIdWaitMs: 150 });
    rig.scenario({
      turn: [
        { mcpCall: { name: "search", args: { q: "a" }, messageId: "mA" } },
        { mcpCall: { name: "search", args: { q: "b" }, messageId: "mB" } },
        { mcpCall: { name: "write_note", args: {}, noStream: true } },
        RESULT_STEP,
      ],
    });
    const { events } = await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "ok" }));
    const calls = events.filter((e) => e.type === "tool-call") as Array<{ messageId: string; name: string; operationId: string }>;
    expect(calls.map((c) => c.messageId.slice(0, 10))).toEqual(["mA", "mB", "unmatched-"]);
    expect(calls[2].messageId).toBe(`unmatched-${calls[2].operationId.slice(0, 16)}`);
  });

  it("the wrapper consumes the manifest line: tools.json is 0600, the variable is gone from the CLI's environment, and the config names the shim with fixed paths only", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    await runTurn(rig, () => undefined);
    const tools = JSON.parse(readFileSync(join(rig.unitTmp, "aw-cfg", "tools.json"), "utf8"));
    expect(tools).toEqual(TOOLS); // exactly the open set, nothing else (no flags)
    const cfg = JSON.parse(readFileSync(join(rig.unitTmp, "aw-cfg", "mcp.json"), "utf8"));
    expect(cfg.mcpServers.emma).toEqual({ type: "stdio", command: process.execPath, args: [SHIM], env: { AW_RELAY_SOCKET: "/run/aw-relay/relay.sock", AW_RELAY_TOOLS: `${rig.unitTmp}/aw-cfg/tools.json` } });
    const last = JSON.parse(readFileSync(join(rig.ctx.homeDir, ".fake-last-turn.json"), "utf8"));
    expect(last.env.AW_TURN_TOOLS).toBeUndefined();
    expect(JSON.stringify(last.args)).not.toContain("tools.json");
  });

  it("logging: nothing from a call (name, arguments, results) reaches the host log or the shim's stderr", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: { q: "SECRET-ARG-hunter2" } } }, RESULT_STEP] });
    await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "SECRET-RESULT-hunter2" }));
    expect(JSON.stringify(rig.logs)).not.toMatch(/hunter2|SECRET/);
    const err = rig.mcpLog().stderr;
    expect(err).not.toMatch(/hunter2|SECRET/);
    for (const line of err.split("\n").filter(Boolean)) expect(line).toMatch(/^aw-relay: E_[A-Z]+$/);
  });

  it("a relay request to an adapter with no relay configured fails the turn as transient, and nothing is spawned", async () => {
    const rig = makeRig({ relay: false });
    rig.scenario({ turn: [RESULT_STEP] });
    const { events } = await runTurn(rig, () => undefined);
    expect(events).toEqual([{ type: "result", ok: false, text: "", errorKind: "transient" }]);
    expect(rig.spawns).toHaveLength(0);
    expect(rig.adapter.relay).toBe(false);
  });
});

describe("claude adapter: relay wiring (stubbed socket)", () => {
  function stubbed() {
    const rig = makeRig();
    let captured: Parameters<RelayHost["open"]>[0] | undefined;
    const refuse = { on: false };
    const answers: string[] = [];
    const dir = join(tmpdir(), `stub-relay-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    roots.push(dir);
    rig.host.open = async (o) => {
      captured = o;
      return { dir, closed: false, answer: (op) => (answers.push(op), !refuse.on), reject: () => false, close: async () => undefined };
    };
    return { rig, opts: () => captured!, answers, refuse };
  }

  it("allowTool follows the visible set: a tool that has not arrived is not callable until an accepted answer carries it", async () => {
    const { rig, opts } = stubbed();
    rig.scenario({ turn: [RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 1000 } })) void ev;
    const o = opts();
    expect([o.allowTool("search"), o.allowTool("write_note"), o.allowTool("late"), o.allowTool("nope")]).toEqual([true, true, false, false]);
    await session.close();
  });

  it("an accepted answer carrying tools makes them callable; a refused answer (operation gone) does not", async () => {
    const { rig, opts, refuse } = stubbed();
    rig.scenario({ turn: [{ wait: 3000 }, RESULT_STEP] }); // the turn is still in flight while the answers arrive (after it ends, every answer is a lost result)
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 1000 } })) void ev;
    })();
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = () => (opts() ? resolve() : Date.now() - t0 > 4000 ? reject(new Error("relay never opened")) : setTimeout(poll, 10));
      poll();
    });
    refuse.on = true;
    expect(session.answer("op", { kind: "tool-result", ok: true, content: "x", tools: [LATE] })).toBe(false);
    expect(opts().allowTool("late")).toBe(false); // the shim never received them
    refuse.on = false;
    expect(session.answer("op", { kind: "tool-result", ok: true, content: "x", tools: [LATE] })).toBe(true);
    expect(opts().allowTool("late")).toBe(true);
    await session.close();
    await turn.catch(() => undefined);
  });

  it("answer() before any relay exists, and a non-result answer, are refused", async () => {
    const rig = makeRig();
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    expect(session.answer("op", { kind: "tool-result", ok: true, content: "x" })).toBe(false);
    expect(session.answer("op", { kind: "decline" })).toBe(false);
    await session.close();
  });
});

describe("claude adapter: lifecycle and memory bounds of the relay", () => {
  it("MUTATION TARGET: a close() that arrives while relay.open() is pending leaves no listener and no directory behind", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    const wrapped = rig.host.open.bind(rig.host);
    rig.host.open = async (o) => {
      await new Promise((r) => setTimeout(r, 300)); // the window
      return wrapped(o);
    };
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    const events: ProviderEvent[] = [];
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 1000 } })) events.push(ev);
    })();
    await new Promise((r) => setTimeout(r, 100));
    await session.close(); // while open() is still pending
    await turn;
    const uidDir = join(rig.layout.relayRoot, "400001");
    expect(existsSync(uidDir) ? readdirSync(uidDir) : []).toEqual([]);
    expect(rig.spawns).toHaveLength(0); // and no unit was started for a closed turn
  });

  it("the same for interrupt() during open()", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    const wrapped = rig.host.open.bind(rig.host);
    rig.host.open = async (o) => {
      await new Promise((r) => setTimeout(r, 300));
      return wrapped(o);
    };
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    const turn = (async () => {
      for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 1000 } })) void ev;
    })();
    await new Promise((r) => setTimeout(r, 100));
    await session.interrupt("t1");
    await turn;
    await session.close();
    const uidDir = join(rig.layout.relayRoot, "400001");
    expect(existsSync(uidDir) ? readdirSync(uidDir) : []).toEqual([]);
  });

  it("MUTATION TARGET: stream tool_use blocks are bounded: 300 lines of 100 KB inputs retain a few dozen fixed-size digests, not megabytes", async () => {
    const rig = makeRig();
    const big = "x".repeat(100_000);
    const lines: Array<Record<string, unknown>> = Array.from({ length: 300 }, (_, i) => ({ type: "assistant", message: { id: `m${i}`, content: [{ type: "tool_use", id: `tu${i}`, name: "mcp__emma__search", input: { pad: big, i } }] } }));
    lines.push({ type: "assistant", message: { id: "mEvil", content: [{ type: "tool_use", id: "tuE", name: "mcp__emma__not_offered", input: { pad: big } }] } });
    rig.scenario({ turn: [...lines, RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", relay: { tools: TOOLS, callTimeoutMs: () => 1000 } })) void ev;
    const kept = (session as unknown as { streamUses: Array<{ name: string; messageId: string; key: string }> }).streamUses;
    expect(kept.length).toBeLessThanOrEqual(64);
    expect(kept.every((u) => u.name === "search")).toBe(true); // a tool the turn does not offer is never remembered
    expect(JSON.stringify(kept).length).toBeLessThan(20_000);
    expect(kept.length).toBeGreaterThan(0); // the turn hashing budget (8 MiB) ends recording before the 300th line: later announcements are simply not remembered
    await session.close();
  });

  it("MUTATION TARGET: over-long message ids are not recorded at all (a V8 slice would pin each whole id); deterministic: asserts the adapter's own structure, not process heap", async () => {
    const rig = makeRig();
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    const s = session as unknown as { visibleTools: Set<string>; streamUses: Array<{ messageId: string }>; noteStreamUse(raw: Record<string, unknown>): void };
    s.visibleTools.add("search");
    const feed = (idChars: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const id = "x".repeat(idChars) + String(i);
        s.noteStreamUse({ type: "assistant", message: { id, content: [{ type: "tool_use", id: `tu${i}`, name: "mcp__emma__search", input: { i } }] } });
      }
    };
    feed(128, 5); // 129 characters with the counter: just over the cap
    expect(s.streamUses).toHaveLength(0);
    feed(4 * 1024 * 1024, 64); // and enormous ones
    expect(s.streamUses).toHaveLength(0);
    feed(100, 3); // within the cap: kept, whole (never a slice of something longer)
    expect(s.streamUses.map((u) => u.messageId.length)).toEqual([101, 101, 101]);
    expect(s.streamUses.every((u) => u.messageId.length <= 128)).toBe(true);
    await session.close();
  });

  it("MUTATION TARGET: a stream announcement with a big input (over 64 KiB) is recorded by NAME only and NEVER canonicalised or hashed (116k keys cost ~0.6 s of loop; eight turns doing it pinned the host for 26 s)", async () => {
    const rig = makeRig();
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    const s = session as unknown as { visibleTools: Set<string>; streamUses: Array<{ messageId: string; name: string; key: string | undefined }>; noteStreamUse(raw: Record<string, unknown>): void };
    s.visibleTools.add("search");
    const huge = new Array(6_000_000).fill(1);
    const canonical = jest.spyOn(canonicalModule, "canonicalJson"); // deterministic: the point is that the hostile input is never hashed, not how fast the machine is
    const t0 = Date.now();
    s.noteStreamUse({ type: "assistant", message: { id: "mBig", content: [{ type: "tool_use", id: "tu", name: "mcp__emma__search", input: { ids: huge } }] } });
    expect(canonical).not.toHaveBeenCalled();
    expect(Date.now() - t0).toBeLessThan(20_000); // sanity only (the unguarded path took 1.7-3.1 s on an idle machine)
    expect(s.streamUses).toEqual([{ messageId: "mBig", name: "search", key: undefined }]);
    // an ordinary one is recorded AND hashed
    s.noteStreamUse({ type: "assistant", message: { id: "mSmall", content: [{ type: "tool_use", id: "tu2", name: "mcp__emma__search", input: { q: 1 } }] } });
    expect(canonical).toHaveBeenCalledTimes(1);
    canonical.mockClear();
    expect(s.streamUses).toHaveLength(2);
    expect(s.streamUses[1].key!.length).toBeGreaterThan(20);
    // the threshold is 64 KiB of estimated JSON: 100 KB is name-only, 50 KB is hashed (not a tenfold-larger limit, not a tenfold-smaller one)
    s.noteStreamUse({ type: "assistant", message: { id: "mOver", content: [{ type: "tool_use", id: "tu3", name: "mcp__emma__search", input: { blob: "x".repeat(100 * 1024) } }] } });
    expect(canonical).not.toHaveBeenCalled();
    expect(s.streamUses[2]).toEqual({ messageId: "mOver", name: "search", key: undefined });
    s.noteStreamUse({ type: "assistant", message: { id: "mUnder", content: [{ type: "tool_use", id: "tu4", name: "mcp__emma__search", input: { blob: "x".repeat(50 * 1024) } }] } });
    expect(canonical).toHaveBeenCalledTimes(1);
    expect(s.streamUses[3].key).toBeDefined();
    canonical.mockRestore();
    await session.close();
  });

  it("a claimed stream block is forgotten (each message is matched once), so repeated identical calls still pair with their own messages", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [{ mcpCall: { name: "search", args: { q: "same" }, messageId: "mA" } }, { mcpCall: { name: "search", args: { q: "same" }, messageId: "mB" } }, RESULT_STEP] });
    const { events } = await runTurn(rig, (ev, s) => void s.answer(ev.operationId, { kind: "tool-result", ok: true, content: "ok" }));
    expect((events.filter((e) => e.type === "tool-call") as Array<{ messageId: string }>).map((c) => c.messageId)).toEqual(["mA", "mB"]);
  });
});

describe("claude adapter: MCP server name vs the tool-name cap", () => {
  const mk = (mcpServerName?: string) => () => new ClaudeAdapter({ binary: { path: FAKE, version: "2.1.294", digest: "sha256:fake" }, systemPromptFile: "/p", turnWrapperPath: WRAPPER, bridgeUrl: "http://127.0.0.1:1/mcp", ...(mcpServerName ? { mcpServerName } : {}) });
  it("MUTATION TARGET: a server name whose qualified prefix is longer than the protocol's default is refused (the host's name cap would let through names the model API rejects)", () => {
    expect(mk()).not.toThrow();
    expect(mk("emma")).not.toThrow();
    expect(mk("em")).not.toThrow(); // shorter: the cap only gets safer
    expect(mk("emma2")).toThrow(/mcpServerName longer/);
  });
});

describe("claude adapter: the CLI is told not to cut what the relay allows (relay turns only)", () => {
  const CLI_VARS = ["CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", "MAX_MCP_OUTPUT_TOKENS", "MCP_TOOL_TIMEOUT"];

  it("MUTATION TARGET: a relay turn's environment carries exactly these three, with values derived from the protocol constants and the turn's remaining clock", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    await runTurn(rig, () => undefined, { callTimeoutMs: () => 123_456.9 });
    const turn = rig.spawns.find((s) => s.relayDir)!;
    expect(CLI_VARS.map((k) => turn.env[k])).toEqual([String(TOOL_LIMITS.maxDescriptionBytes), String(Math.ceil(RELAY_RESULT_MAX_BYTES / 2) + IMAGE_LIMITS.maxImages * 1600), "123456"]);
    for (const k of CLI_VARS) {
      assertEnvName(k);
      assertEnvValue(turn.env[k]);
    }
  });

  it("MUTATION TARGET: the result cap is the prod one (300,000) and the CLI output limit is far below the 8 MiB frame cap (the CLI keeps protecting the model context)", () => {
    expect(RELAY_RESULT_MAX_BYTES).toBe(300_000);
    expect(Number(relayCliEnv(5000).MAX_MCP_OUTPUT_TOKENS)).toBe(156_400);
  });

  it("MUTATION TARGET: the call clock is clamped to the CLI's own range (at least 1000 ms, at most 2^31-1)", () => {
    expect(relayCliEnv(5).MCP_TOOL_TIMEOUT).toBe("1000");
    expect(relayCliEnv(Number.NaN).MCP_TOOL_TIMEOUT).toBe("1000");
    expect(relayCliEnv(1e12).MCP_TOOL_TIMEOUT).toBe("2147483647");
  });

  it("MUTATION TARGET: a legacy turn's environment has none of them (byte-identical to before)", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", bridgeToken: "TOKEN-0123456789-abcdef" })) void ev;
    await session.close();
    for (const sp of rig.spawns) for (const k of [...CLI_VARS, "AW_TURN_TOOLS"]) expect(Object.keys(sp.env)).not.toContain(k);
  });
});

describe("claude adapter: legacy bridge shape is untouched", () => {
  it("a bridgeToken turn writes the HTTP config, no manifest, no relay socket, no variable", async () => {
    const rig = makeRig();
    rig.scenario({ turn: [RESULT_STEP] });
    const session = await rig.adapter.openSession(rig.ctx, { connectionId: "conn1", epoch: 1 });
    const events: ProviderEvent[] = [];
    for await (const ev of session.turn({ turnId: "t1", prompt: "go", model: "sonnet", bridgeToken: "TOKEN-0123456789-abcdef" })) events.push(ev);
    await session.close();
    const cfg = JSON.parse(readFileSync(join(rig.unitTmp, "aw-cfg", "mcp.json"), "utf8"));
    expect(cfg.mcpServers.emma).toEqual({ type: "http", url: "http://127.0.0.1:3001/internal/tool-bridge/run/mcp", headers: { Authorization: "Bearer TOKEN-0123456789-abcdef" } });
    expect(existsSync(join(rig.unitTmp, "aw-cfg", "tools.json"))).toBe(false);
    expect(rig.spawns.every((s) => s.relayDir === undefined)).toBe(true);
    expect(rig.opened).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: true });
  });
});
