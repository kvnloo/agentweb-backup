/**
 * ENG-2110 PR 1b-i: the Claude adapter against a scripted `claude` (fakeClaude.js) running as a REAL local
 * process through the real turn wrapper. No root, no systemd: the host's hardening is the port's job (1b-ii).
 */
import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AdapterContext, ChildLike, ProviderEvent, ProviderSession } from "../adapter";
import { ClaudeAdapter, RunnerChildAdapter } from "../adapters/claudeAdapter";
import { PassThrough } from "stream";
import { describeAdapterConformance } from "./adapterConformance";

const FAKE = join(__dirname, "fakeClaude.js");
const WRAPPER = join(__dirname, "..", "deploy", "claude-turn.sh");
const NODE_DIR = dirname(process.execPath);
const roots: string[] = [];

interface Env {
  ctx: AdapterContext;
  root: string;
  unitTmp: string;
  scenario(s: Record<string, unknown>): void;
  last(mode: string): { args: string[]; env: Record<string, string>; pid: number; mcpFile?: string; mcpMode?: string; mcpServers?: string[]; homeDir?: string; cwd: string; firstUser?: unknown; codeLength?: number };
}

function localSpawn(spec: { file: string; args: string[]; env: Record<string, string>; cwd: string }): ChildLike {
  const c = spawn(spec.file, spec.args, { env: spec.env, cwd: spec.cwd, stdio: ["pipe", "pipe", "pipe"] });
  return {
    stdin: c.stdin,
    stdout: c.stdout,
    stderr: c.stderr,
    kill: () => void c.kill("SIGKILL"),
    onExit: (cb) => void c.on("exit", (code, sig) => cb(code, sig)),
    // The contract: onError means the process could NOT BE STARTED. A node 'error' after a successful spawn (kill failed, etc.) is not that.
    onError: (cb) => void c.on("error", (err) => (c.pid === undefined ? cb(err) : undefined)),
  };
}

function makeEnv(connectionId = "conn1"): Env {
  const root = mkdtempSync(join(tmpdir(), "claude-adapter-test-"));
  roots.push(root);
  const homeDir = join(root, "home");
  const workDir = join(root, "work");
  const tmpDir = join(root, "tmp");
  const unitTmp = join(root, "unit-tmp");
  for (const d of [homeDir, workDir, tmpDir, unitTmp]) mkdirSync(d, { recursive: true });
  const ctx: AdapterContext = { connectionId, uid: 400_001, homeDir, workDir, tmpDir, spawnAs: (spec) => localSpawn(spec) };
  return {
    ctx,
    root,
    unitTmp,
    scenario: (s) => writeFileSync(join(homeDir, ".fake-scenario"), JSON.stringify(s)),
    last: (mode) => JSON.parse(readFileSync(join(homeDir, `.fake-last-${mode}.json`), "utf8")),
  };
}

function makeAdapter(unitTmp: string, extra: Partial<ConstructorParameters<typeof ClaudeAdapter>[0]> = {}): ClaudeAdapter {
  return new ClaudeAdapter({
    binary: { path: FAKE, version: "2.1.294", digest: "sha256:fake" },
    systemPromptFile: "/opt/aw/prompt.txt",
    turnWrapperPath: WRAPPER,
    bridgeUrl: "http://127.0.0.1:3001/internal/tool-bridge/run/mcp",
    basePath: `${NODE_DIR}:/usr/bin:/bin`,
    unitTmp,
    startTimeoutMs: 3000,
    completeTimeoutMs: 3000,
    shortCommandTimeoutMs: 3000,
    killWaitMs: 2000,
    ...extra,
  });
}

afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

// The shared suite: shape and behavioural promises every adapter must keep. The conformance context cannot spawn, so a real context is supplied.
let conformanceEnv: Env;
beforeEach(() => {
  conformanceEnv = makeEnv("conf1");
});
describeAdapterConformance(
  "claude (scripted CLI)",
  () => makeAdapter(conformanceEnv.unitTmp),
  () => conformanceEnv.ctx,
);

async function collect(session: ProviderSession, input: Partial<{ turnId: string; prompt: string; model: string; bridgeToken: string }> = {}): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of session.turn({ turnId: "t1", prompt: "hi", model: "sonnet", bridgeToken: "TOKEN-0123456789-abcdef", ...input })) out.push(ev);
  return out;
}
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
}

describe("claude adapter: identity", () => {
  it("declares the recorded Claude shape", () => {
    const a = makeAdapter("/tmp");
    expect([a.id, a.flagKey, a.homeEnvVar, a.ceremony, a.toolTransport]).toEqual(["claude", "claudeSubscription", "CLAUDE_CONFIG_DIR", "paste_code", "mcp_direct"]);
    expect([a.maxProcessesPerHome, a.maxTurnsPerProcess, a.singleUse]).toEqual([3, 1, true]);
    expect(a.expiryModel(1000)).toEqual({ refreshExpiresAtMs: 1000 + 30 * 24 * 3600 * 1000 });
  });
});

describe("claude adapter: mapError", () => {
  it("never reports auth_dead: host faults and spawn errors must not park a healthy login", () => {
    const a = makeAdapter("/tmp");
    for (const raw of ["Not logged in", "401 authentication_error", new Error("OAuth session expired"), new Error("spawn ENOENT"), { code: "open_failed" }, undefined, null, 42]) {
      expect(a.mapError(raw)).not.toBe("auth_dead");
    }
    expect(a.mapError(new Error("claudeCliRunner: MCP server \"emma\" is not connected (failed)"))).toBe("transient");
    expect(a.mapError({ code: "open_failed" })).toBe("transient");
    expect(a.mapError(new Error("You've hit your session limit"))).toBe("usage_limit");
  });
});

describe("claude adapter: sign-in", () => {
  it("start gives the URL; a good code is accepted and goes ONLY to stdin (never argv or env); then the process is gone", async () => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp);
    const proc = await a.loginStart(e.ctx);
    expect(proc.data.url).toBe("https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=abc");
    const login = e.last("login");
    expect(login.args).toEqual(["auth", "login"]);
    expect(login.env.CLAUDE_CONFIG_DIR).toBe(e.ctx.homeDir);
    expect(login.env.HOME).toBe(e.ctx.tmpDir);
    expect(login.cwd).toBe(e.ctx.workDir);
    const code = "AbCdEfGh1234#WxYzQrSt5678";
    await a.loginComplete(proc, code);
    expect(e.last("login-code").codeLength).toBe(code.length);
    expect(JSON.stringify(login)).not.toContain("AbCdEfGh1234");
    await until(() => isGone(login.pid));
    expect(isGone(login.pid)).toBe(true);
  });

  it("a wrong code (the CLI exits 1) is code_rejected and leaves no process; the attempt is single use", async () => {
    const e = makeEnv();
    e.scenario({ rejectCode: true });
    const a = makeAdapter(e.unitTmp);
    const proc = await a.loginStart(e.ctx);
    await expect(a.loginComplete(proc, "AbCdEfGh1234#WxYzQrSt5678")).rejects.toMatchObject({ code: "code_rejected" });
    await expect(a.loginComplete(proc, "AbCdEfGh1234#WxYzQrSt5678")).rejects.toMatchObject({ code: "login_gone" });
    await until(() => isGone(e.last("login").pid));
    expect(isGone(e.last("login").pid)).toBe(true);
  });

  it.each([["short"], ["no-hash-here-12345678"], ["AbCdEfGh1234#x"], ["AbCdEfGh1234#WxYz QrSt5678"], ["--help#--help-12345"], [""]])("a malformed code %j never reaches the CLI", async (bad) => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp);
    const proc = await a.loginStart(e.ctx);
    await expect(a.loginComplete(proc, bad)).rejects.toMatchObject({ code: "bad_code_format" });
    expect(existsSync(join(e.ctx.homeDir, ".fake-last-login-code.json"))).toBe(false);
    await until(() => isGone(e.last("login").pid));
    expect(isGone(e.last("login").pid)).toBe(true);
  });

  it("cancel kills the login process and is idempotent", async () => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp);
    const proc = await a.loginStart(e.ctx);
    await a.loginCancel(proc);
    await a.loginCancel(proc);
    expect(isGone(e.last("login").pid)).toBe(true);
  });

  it("a CLI that never prints a URL fails the start (and is killed)", async () => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp, { binary: { path: "/bin/sleep", version: "x", digest: "x" }, startTimeoutMs: 300 });
    await expect(a.loginStart({ ...e.ctx, spawnAs: (s) => localSpawn({ ...s, args: ["30"] }) })).rejects.toMatchObject({ code: "start_timeout" });
  });
});

describe("claude adapter: status, hazards, logout", () => {
  it("authStatus: signed in (Max), logged out (exit 1 + JSON), and unparseable output", async () => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp);
    await expect(a.authStatus(e.ctx)).resolves.toEqual({ loggedIn: true, planLabel: "max", orgPresent: false });
    e.scenario({ status: { loggedIn: false, authMethod: "none" } });
    await expect(a.authStatus(e.ctx)).resolves.toMatchObject({ loggedIn: false });
    e.scenario({ statusRaw: "something went wrong\n" });
    await expect(a.authStatus(e.ctx)).rejects.toThrow("status_unparseable");
  });

  it("hazards: clean Pro/Max, managed settings, silence and a hang all fail closed", async () => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp, { shortCommandTimeoutMs: 400 });
    await expect(a.hazards(e.ctx)).resolves.toEqual([]);
    e.scenario({ doctor: "Managed settings (remote): applied\nOrganization policy: not applicable to Pro and Max accounts\n" });
    await expect(a.hazards(e.ctx)).resolves.toEqual([{ kind: "managed_settings_present" }]);
    e.scenario({ doctor: "" });
    await expect(a.hazards(e.ctx)).resolves.toEqual([{ kind: "other", detail: "doctor_failed" }]);
    e.scenario({ doctorHang: true });
    await expect(a.hazards(e.ctx)).resolves.toEqual([{ kind: "other", detail: "doctor_failed" }]);
  });

  it("short commands run with the connection's own HOME/config dir and no inherited environment", async () => {
    const e = makeEnv();
    process.env.ANTHROPIC_API_KEY = "must-not-leak";
    try {
      const a = makeAdapter(e.unitTmp);
      await a.logout(e.ctx);
      const env = e.last("logout").env;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CODE_DISABLE_THINKING", "CLAUDE_CODE_PROMPT_CACHE_TTL", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "HOME", "MAX_THINKING_TOKENS", "PATH", "TMPDIR"]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("claude adapter: a turn", () => {
  it("runs ONE process through the wrapper: events normalized in order, usage before the result, token only in the unit-private config", async () => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp);
    const session = await a.openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    const events = await collect(session, { bridgeToken: "TOKEN-0123456789-abcdef", model: "sonnet" });
    expect(events.map((x) => x.type)).toEqual(["text", "tool-use", "tool-result", "entitlement", "usage", "result"]);
    expect(events[events.length - 1]).toEqual({ type: "result", ok: true, text: "done" });
    expect(events[4]).toEqual({ type: "usage", inputTokens: 10, outputTokens: 5 });
    const turn = e.last("turn");
    expect(turn.args).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--include-hook-events", "--strict-mcp-config", "--model", "sonnet", "--system-prompt-file", "/opt/aw/prompt.txt"]));
    expect(turn.args[turn.args.indexOf("--mcp-config") + 1]).toBe(join(e.unitTmp, "aw-cfg", "mcp.json"));
    expect(JSON.stringify(turn.args)).not.toContain("TOKEN-0123456789");
    expect(JSON.stringify(turn.env)).not.toContain("TOKEN-0123456789");
    expect(turn.env.CLAUDE_CONFIG_DIR).toBe(e.ctx.homeDir);
    expect(turn.env.HOME).toBe(join(e.unitTmp, "aw-home"));
    expect(turn.env.TMPDIR).toBe(e.unitTmp);
    expect(turn.cwd).toBe(e.ctx.workDir);
    const mcp = e.last("turn-input");
    expect(mcp.mcpMode).toBe("600");
    expect(turn.mcpServers).toEqual(["emma"]);
    expect(JSON.parse(readFileSync(join(e.unitTmp, "aw-cfg", "mcp.json"), "utf8")).mcpServers.emma.headers.Authorization).toBe("Bearer TOKEN-0123456789-abcdef");
    expect(mcp.firstUser).toMatchObject({ type: "user", message: { content: "hi" } }); // the config line was consumed by the wrapper, the conversation starts after it
    await session.closed;
    expect(isGone(turn.pid)).toBe(true);
    expect(readdirSync(e.ctx.homeDir).filter((n) => !n.startsWith(".fake"))).toEqual([]); // nothing but the test's own files in the credential home
    expect(existsSync(join(e.ctx.workDir, "aw-cfg"))).toBe(false);
  });

  it("a session serves exactly one turn", async () => {
    const e = makeEnv();
    const a = makeAdapter(e.unitTmp);
    const session = await a.openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    await collect(session);
    await expect(collect(session, { turnId: "t2" })).rejects.toThrow("claude_session_single_use");
  });

  it("usage_limit, plain failures and transient failures are classified; text of failures is never returned", async () => {
    const cases: Array<[string, string]> = [
      ["You've hit your session limit · resets 3:45pm", "usage_limit"],
      ["API Error: 529 overloaded_error", "transient"],
      ["something odd happened", "unknown"],
    ];
    for (const [text, kind] of cases) {
      const e = makeEnv();
      e.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: text }] });
      const session = await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
      const events = await collect(session);
      expect(events[events.length - 1]).toEqual({ type: "result", ok: false, text: "", errorKind: kind });
    }
  });

  it("an auth-looking failure is confirmed with `auth status`: logged out => auth_dead, still signed in => transient (never park a healthy login)", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }], status: { loggedIn: false } });
    let events = await collect(await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 }));
    expect(events[events.length - 1]).toMatchObject({ ok: false, errorKind: "auth_dead" });
    const e2 = makeEnv();
    e2.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: "OAuth session expired" }], status: { loggedIn: true, subscriptionType: "max" } });
    events = await collect(await makeAdapter(e2.unitTmp).openSession(e2.ctx, { connectionId: "conn1", epoch: 1 }));
    expect(events[events.length - 1]).toMatchObject({ ok: false, errorKind: "transient" });
    const e3 = makeEnv();
    e3.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: "401 authentication_error" }], statusRaw: "garbage" });
    events = await collect(await makeAdapter(e3.unitTmp).openSession(e3.ctx, { connectionId: "conn1", epoch: 1 }));
    expect(events[events.length - 1]).toMatchObject({ ok: false, errorKind: "transient" }); // an unreadable status is uncertainty, not death
  });

  it("hook events and a non-subscription apiKeySource are surfaced as alarms", async () => {
    const e = makeEnv();
    e.scenario({ apiKeySource: "env", turn: [{ type: "system", subtype: "hook_started" }, { type: "result", subtype: "success", is_error: false, result: "x" }] });
    const events = await collect(await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 }));
    const alarms = events.filter((x) => x.type === "alarm");
    expect(alarms).toEqual([
      { type: "alarm", hazard: { kind: "api_key_source", source: "env" } },
      { type: "alarm", hazard: { kind: "hook_event" } },
    ]);
  });

  it("a consumer that stops reading cannot make the host buffer without bound: the turn ends transient and the process is killed", async () => {
    const e = makeEnv();
    const big = "x".repeat(200_000);
    e.scenario({ turn: Array.from({ length: 40 }, () => ({ type: "assistant", message: { content: [{ type: "text", text: big }] } })).concat([{ type: "result", subtype: "success", is_error: false, result: "done" } as never]) });
    const session = await makeAdapter(e.unitTmp, { maxQueuedBytes: 1_000_000 }).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    const out: ProviderEvent[] = [];
    for await (const ev of session.turn({ turnId: "t1", prompt: "hi", model: "sonnet", bridgeToken: "TOKEN-0123456789-abcdef" })) {
      out.push(ev);
      await new Promise((r) => setTimeout(r, 300)); // a slow consumer
    }
    expect(out[out.length - 1]).toEqual({ type: "result", ok: false, text: "", errorKind: "transient" });
    expect(out.length).toBeLessThan(40);
    await session.closed;
    expect(isGone(e.last("turn").pid)).toBe(true);
  });

  it("an MCP server that does not connect ends the turn as a transient failure (no toolless success)", async () => {
    const e = makeEnv();
    e.scenario({ mcpStatus: "failed" });
    const events = await collect(await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 }));
    expect(events[events.length - 1]).toEqual({ type: "result", ok: false, text: "", errorKind: "transient" });
  });

  it("junk on stdout (non-JSON lines, null, arrays) is ignored and the turn still completes", async () => {
    const e = makeEnv();
    e.scenario({ noise: true });
    const events = await collect(await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 }));
    expect(events[events.length - 1]).toEqual({ type: "result", ok: true, text: "done" });
  });

  it("one enormous stdout line (no newline) kills the process and ends the turn transient instead of growing host memory", async () => {
    const e = makeEnv();
    e.scenario({ bigline: 3_000_000 });
    const session = await makeAdapter(e.unitTmp, { maxLineBytes: 1_000_000 }).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    const events = await collect(session);
    expect(events[events.length - 1]).toEqual({ type: "result", ok: false, text: "", errorKind: "transient" });
    await session.closed;
    expect(isGone(e.last("turn").pid)).toBe(true);
  });

  it("a process that cannot be started ends the turn with a failure and `closed` still resolves (it never existed)", async () => {
    const e = makeEnv();
    const session = await makeAdapter(e.unitTmp, { turnWrapperPath: "/nonexistent/claude-turn.sh" }).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    const events = await collect(session);
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: false });
    await Promise.race([session.closed, new Promise((_, rej) => setTimeout(() => rej(new Error("closed did not resolve")), 3000))]);
  });

  it("a kill that throws does not reject close() and does not claim the process is gone: `closed` waits for the real exit", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ hang: true }] });
    let allowKill = false;
    let realKill: (() => void) | undefined;
    const ctx: AdapterContext = {
      ...e.ctx,
      spawnAs: (spec) => {
        const child = localSpawn(spec);
        realKill = () => child.kill();
        return {
          ...child,
          kill: () => {
            if (!allowKill) throw new Error("EPERM: cannot signal");
            child.kill();
          },
        };
      },
    };
    const session = await makeAdapter(e.unitTmp).openSession(ctx, { connectionId: "conn1", epoch: 1 });
    const done = collect(session);
    await until(() => existsSync(join(e.ctx.homeDir, ".fake-last-turn-input.json")));
    const closing = session.close();
    await expect(Promise.race([closing.then(() => "closed"), new Promise((r) => setTimeout(() => r("pending"), 300))])).resolves.toBe("pending"); // not gone => not closed, and no rejection
    allowKill = true;
    realKill?.();
    await closing;
    await done;
    expect(isGone(e.last("turn").pid)).toBe(true);
  });

  it("an auth-looking failure is confirmed only AFTER the turn's process is gone (one process per cap slot)", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }], status: { loggedIn: false } });
    const events = await collect(await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 }));
    expect(events[events.length - 1]).toMatchObject({ errorKind: "auth_dead" });
    expect(readFileSync(join(e.ctx.homeDir, ".fake-status-saw-turn-alive"), "utf8")).toBe("false");
  });

  it("a status check that hangs is bounded: the turn ends transient (never parks) well before the host's abort grace", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }], statusHang: true });
    const t0 = Date.now();
    const events = await collect(await makeAdapter(e.unitTmp, { authConfirmTimeoutMs: 300 }).openSession(e.ctx, { connectionId: "conn1", epoch: 1 }));
    expect(events[events.length - 1]).toMatchObject({ ok: false, errorKind: "transient" });
    expect(Date.now() - t0).toBeLessThan(10_000); // the 300 ms timeout bounded it; catastrophe bound only (the gate fails closed: a slow runner must not block a deploy); the structural assertions are the pins
  });

  it("the session (and so its cap slot) stays alive until the auth confirmation has finished, and the turn's process is already gone while it runs", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }, { type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }], status: { loggedIn: false }, statusDelayMs: 900 });
    const session = await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    let closed = false;
    void session.closed.then(() => (closed = true));
    const it = session.turn({ turnId: "t1", prompt: "hi", model: "sonnet", bridgeToken: "TOKEN-0123456789-abcdef" })[Symbol.asyncIterator]();
    const first = await it.next(); // the text event: the CLI's turn is still running here
    expect(first.value).toMatchObject({ type: "text" });
    const resultP = it.next(); // drives the generator through the failure, the stop and the (delayed) confirmation
    await new Promise((r) => setTimeout(r, 500)); // inside the confirmation window
    expect(closed).toBe(false); // the slot is NOT released while the second process runs
    expect(isGone(e.last("turn").pid)).toBe(true); // ...but the turn's own process is already gone
    void session.interrupt("t1"); // the host aborts the turn DURING the confirmation: that must not release the slot early either
    await new Promise((r) => setTimeout(r, 150));
    expect(closed).toBe(false);
    const res = await resultP;
    expect(res.value).toMatchObject({ type: "result", ok: false, errorKind: "auth_dead" });
    await it.next();
    await session.closed;
    expect(closed).toBe(true);
  });

  it("a close() that arrives while the turn's process is being stopped still waits for the auth check, which then does not run at all", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }], status: { loggedIn: false } });
    const holder: { session?: ProviderSession } = {};
    let closeFromKill: Promise<void> | undefined;
    let statusRuns = 0;
    const ctx: AdapterContext = {
      ...e.ctx,
      spawnAs: (spec) => {
        if (spec.args.includes("status")) statusRuns++;
        const child = localSpawn(spec);
        return {
          ...child,
          kill: () => {
            if (spec.file === WRAPPER) closeFromKill ??= holder.session?.close(); // the host closes the session exactly while the turn's process is being stopped
            child.kill();
          },
        };
      },
    };
    const session = await makeAdapter(e.unitTmp).openSession(ctx, { connectionId: "conn1", epoch: 1 });
    holder.session = session;
    const events = await collect(session);
    await session.closed;
    expect(statusRuns).toBe(0); // a close had begun while the process was being stopped: no check process was spawned after it (it would have run beside the next turn)
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: false, errorKind: "transient" }); // uncertainty never parks a login
  });

  it("a status check whose kill keeps failing does not hang the caller beyond the kill wait", async () => {
    const e = makeEnv();
    e.scenario({ statusHang: true });
    const ctx: AdapterContext = { ...e.ctx, spawnAs: (spec) => ({ ...localSpawn(spec), kill: () => { throw new Error("EPERM"); } }) };
    const t0 = Date.now();
    const a = makeAdapter(e.unitTmp, { authConfirmTimeoutMs: 300, killWaitMs: 400 });
    await expect(a.confirmLoggedOut(ctx)).resolves.toBe("transient");
    expect(Date.now() - t0).toBeLessThan(10_000); // catastrophe bound only (the gate fails closed: a slow runner must not block a deploy); the structural assertions are the pins
    expect(Date.now() - t0).toBeGreaterThanOrEqual(600); // 300 ms timeout + the 400 ms kill wait: it waited for the exit before giving up
  });

  it("a kill that keeps failing cannot hang the turn: the result still arrives (bounded stop) as TRANSIENT (no auth check runs beside a process that is not gone), and `closed` honestly stays pending", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ type: "result", subtype: "error", is_error: true, result: "Not logged in · Please run /login" }], status: { loggedIn: false } });
    let allowKill = false;
    let realKill: (() => void) | undefined;
    const ctx: AdapterContext = {
      ...e.ctx,
      spawnAs: (spec) => {
        const child = localSpawn(spec);
        if (spec.file === WRAPPER) realKill = () => child.kill(); // the turn's process (not the status check's)
        return { ...child, kill: () => (allowKill || spec.file !== WRAPPER ? child.kill() : (() => { throw new Error("EPERM"); })()) };
      },
    };
    const session = await makeAdapter(e.unitTmp, { killWaitMs: 300 }).openSession(ctx, { connectionId: "conn1", epoch: 1 });
    let closed = false;
    void session.closed.then(() => (closed = true));
    const t0 = Date.now();
    const events = await collect(session);
    // The process was not gone in time (it may still be inside its stop grace, writing a refreshed login): `auth status` must not run
    // beside it, so the failure is reported as transient instead of risking a half-written read or a second refresher.
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: false, errorKind: "transient" });
    expect(Date.now() - t0).toBeLessThan(10_000); // catastrophe bound only (the gate fails closed: a slow runner must not block a deploy); the structural assertions are the pins
    expect(closed).toBe(false); // the process could not be killed: not "gone"
    allowKill = true;
    realKill?.();
    await session.closed;
  });

  it("a process that dies mid-turn ends the turn with a failure result (never silence), and `closed` resolves", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }, { exit: 3 }] });
    const session = await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    const events = await collect(session);
    expect(events[events.length - 1]).toMatchObject({ type: "result", ok: false });
    await session.closed;
  });

  it("interrupt() ends a hung turn and the process is really gone when `closed` resolves", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ hang: true }] });
    const session = await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    const done = collect(session);
    await until(() => existsSync(join(e.ctx.homeDir, ".fake-last-turn-input.json")));
    const pid = e.last("turn").pid;
    expect(isGone(pid)).toBe(false);
    await session.interrupt("t1");
    await done;
    await session.closed;
    expect(isGone(pid)).toBe(true);
  });

  it("close() before the turn starts means no process is ever started; close() is idempotent", async () => {
    const e = makeEnv();
    const session = await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    await session.close();
    await session.close();
    await session.closed;
    expect(await collect(session)).toEqual([]);
    await new Promise((r) => setTimeout(r, 500)); // a process started late would have recorded itself by now
    expect(existsSync(join(e.ctx.homeDir, ".fake-last-turn.json"))).toBe(false);
  });

  it("interrupt() before the turn starts means no process is ever started", async () => {
    const e = makeEnv();
    const session = await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    await session.interrupt("t1");
    expect(await collect(session)).toEqual([]);
    await session.closed;
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(join(e.ctx.homeDir, ".fake-last-turn.json"))).toBe(false);
  });

  it("close() DURING the spawn leaves no orphan: the process is gone when `closed` resolves", async () => {
    const e = makeEnv();
    e.scenario({ turn: [{ hang: true }] });
    const session = await makeAdapter(e.unitTmp).openSession(e.ctx, { connectionId: "conn1", epoch: 1 });
    const done = collect(session);
    const closing = session.close(); // races the spawn
    await Promise.all([done, closing, session.closed]);
    if (existsSync(join(e.ctx.homeDir, ".fake-last-turn.json"))) expect(isGone(e.last("turn").pid)).toBe(true);
  });
});

describe("RunnerChildAdapter", () => {
  function child() {
    let exit: ((code: number | null, signal: string | null) => void) | undefined;
    let err: ((e: Error) => void) | undefined;
    const c: ChildLike = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => undefined, onExit: (cb) => void (exit = cb), onError: (cb) => void (err = cb) };
    return { c, exit: (code: number | null, sig: string | null) => exit?.(code, sig), fail: (e: Error) => err?.(e) };
  }
  it("a finished process never reports both exitCode and signalCode as null (the runner reads that as still running)", async () => {
    const h = child();
    const a = new RunnerChildAdapter(h.c, 1000);
    expect([a.exitCode, a.signalCode]).toEqual([null, null]); // running
    h.exit(null, null);
    await a.exited;
    expect(a.exitCode === null && a.signalCode === null).toBe(false);
  });
  it("exit codes and signals are passed through; a start failure resolves `exited` and emits error", async () => {
    const h = child();
    const a = new RunnerChildAdapter(h.c, 1000);
    h.exit(3, null);
    expect([a.exitCode, a.signalCode]).toEqual([3, null]);
    const h2 = child();
    const b = new RunnerChildAdapter(h2.c, 1000);
    const errors: Error[] = [];
    b.on("error", (e: Error) => errors.push(e));
    h2.fail(new Error("spawn ENOENT"));
    await b.exited;
    expect(errors).toHaveLength(1);
  });
  it("the line limit applies across chunks, counts bytes since the last newline, and stops forwarding after tripping", async () => {
    const h = child();
    const a = new RunnerChildAdapter(h.c, 10);
    const errors: Error[] = [];
    a.on("error", (e: Error) => errors.push(e));
    const seen: string[] = [];
    a.stdout.on("data", (b: Buffer) => seen.push(b.toString()));
    (h.c.stdout as PassThrough).write("123456\n1234"); // 4 since the last newline
    (h.c.stdout as PassThrough).write("56789"); // 9: ok
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(0);
    (h.c.stdout as PassThrough).write("0123"); // 13 > 10: trips
    (h.c.stdout as PassThrough).write("after\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
    expect(seen.join("")).not.toContain("after");
  });
});

describe("claude adapter: credential-handling rules", () => {
  const src = readFileSync(join(__dirname, "..", "adapters", "claudeAdapter.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("the adapter source never opens a file or names a credential file", () => {
    expect(src).not.toMatch(/readFile|createReadStream|openSync|writeFile|readdir|\.credentials|\bfrom "fs"|\bfrom "fs\/promises"/);
  });
  it("neither the code nor the bridge token is ever passed in argv or env by construction (stdin only)", () => {
    expect(src).not.toMatch(/args:\s*\[[^\]]*(code|bearerToken|bridgeToken)/);
    expect(src).not.toMatch(/env:\s*\{[^}]*(code|bearerToken|bridgeToken)/);
  });
});

describe("claude-turn.sh wrapper", () => {
  it("consumes exactly the first line, writes it 0600 into TMPDIR, creates HOME, and passes the rest of stdin to the exec'd program", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wrapper-test-"));
    roots.push(dir);
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const c = spawn(WRAPPER, ["/bin/cat"], { env: { PATH: "/usr/bin:/bin", TMPDIR: dir }, stdio: ["pipe", "pipe", "ignore"] });
      let stdout = "";
      c.stdout.on("data", (b: Buffer) => (stdout += b.toString()));
      c.on("exit", (code) => resolve({ code, stdout }));
      c.stdin.on("error", () => undefined);
      c.stdin.write('{"mcpServers":{"emma":{"headers":{"Authorization":"Bearer SECRET"}}}}\nline two\nline three\n');
      c.stdin.end();
    });
    expect(result.stdout).toBe("line two\nline three\n");
    expect(readFileSync(join(dir, "aw-cfg", "mcp.json"), "utf8")).toContain("Bearer SECRET");
    expect((statSync(join(dir, "aw-cfg", "mcp.json")).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(join(dir, "aw-cfg")).mode & 0o777).toString(8)).toBe("700");
    expect(existsSync(join(dir, "aw-home"))).toBe(true);
    expect(result.code).toBe(0);
  });
  it("creates its directories exclusively: ANYTHING planted at aw-cfg or aw-home (dir, file, symlink, FIFO) makes it refuse, and nothing is written through it", async () => {
    const run = (dir: string) =>
      new Promise<number | null>((resolve) => {
        const c = spawn(WRAPPER, ["/bin/echo", "STARTED"], { env: { PATH: "/usr/bin:/bin", TMPDIR: dir }, stdio: ["pipe", "ignore", "ignore"] });
        c.stdin.on("error", () => undefined);
        c.on("exit", (code) => resolve(code));
        c.stdin.end('{"mcpServers":{"emma":{"headers":{"Authorization":"Bearer PLANT-SECRET"}}}}\n');
      });
    const fresh = () => {
      const d = mkdtempSync(join(tmpdir(), "wrapper-test-"));
      roots.push(d);
      return d;
    };
    for (const planted of ["aw-cfg", "aw-home"]) {
      const asDir = fresh();
      mkdirSync(join(asDir, planted));
      expect(await run(asDir)).not.toBe(0);
      const asFile = fresh();
      writeFileSync(join(asFile, planted), "planted");
      expect(await run(asFile)).not.toBe(0);
      expect(readFileSync(join(asFile, planted), "utf8")).toBe("planted");
      const asFifo = fresh();
      execFileSync("mkfifo", [join(asFifo, planted)]);
      expect(await run(asFifo)).not.toBe(0);
      const asLink = fresh();
      const victim = fresh();
      symlinkSync(victim, join(asLink, planted));
      expect(await run(asLink)).not.toBe(0);
      expect(readdirSync(victim)).toEqual([]); // nothing was written through the symlink
    }
  });

  it("refuses to run without TMPDIR or with empty stdin (never starts the CLI without its config)", async () => {
    const run = (env: Record<string, string>, input: string) =>
      new Promise<number | null>((resolve) => {
        const c = spawn(WRAPPER, ["/bin/echo", "STARTED"], { env: { PATH: "/usr/bin:/bin", ...env }, stdio: ["pipe", "ignore", "ignore"] });
        c.on("exit", (code) => resolve(code));
        c.stdin.on("error", () => {});
        c.stdin.end(input);
      });
    expect(await run({}, "{}\n")).not.toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "wrapper-test-"));
    roots.push(dir);
    expect(await run({ TMPDIR: dir }, "")).toBe(64);
  });
});
