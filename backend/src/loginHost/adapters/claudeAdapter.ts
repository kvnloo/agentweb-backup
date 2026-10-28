/**
 * ENG-2110 PR 1b-i: the Claude provider adapter for the login host.
 *
 * Contract highlights (see adapter.ts): every process is started through `ctx.spawnAs` (the host's
 * hardening, the customer's uid); the sign-in code goes to the CLI's stdin only; no method reads a
 * credential file (sign-in success is confirmed with `claude auth status`); CLI output is parsed for
 * specific fields and never logged or returned; a turn is ONE process (`singleUse`), because the bridge
 * token and the model are fixed when the CLI starts, and its MCP config reaches it through the host's
 * `claude-turn.sh` wrapper on stdin (never argv, env or a persistent file).
 */
import { EventEmitter } from "events";
import { Transform } from "stream";
import { join } from "path";
import {
  allowlistedEnv,
  ClaudeCliRunner,
  ClaudeCliTurnError,
  type ClaudeCliSessionHandle,
  type ClaudeCliSpawnSpec,
  type RunnerChild,
} from "../../services/funding/claudeCliRunner";
import { CODE_PATTERN, extractAuthorizeUrl, MAX_LOGIN_OUTPUT_CHARS } from "../../services/funding/claudeLoginParse";
import type {
  ServerRequestAnswer,
  TurnInput,
  AdapterContext,
  AuthStatus,
  ChildLike,
  ErrorKind,
  Hazard,
  LoginProcess,
  ProviderEvent,
  ProviderSession,
  SessionSpec,
  SpawnSpec,
  SubscriptionProviderAdapter,
} from "../adapter";
import { RELAY_SOCKET_IN_UNIT } from "../ports/unitArgs";
import type { RelayCall, RelayEndpoint, RelayHost } from "../relay/relayServer";
import { classifyFailureText, failureClassToKind, normalizeClaudeEvent, parseAuthStatus, parseDoctorHazards, usageFromResult } from "./claudeParse";

export interface ClaudeAdapterConfig {
  /** Pinned binary: absolute path, `--version` output and content digest, verified by the host at startup (never recomputed per call). */
  binary: { path: string; version: string; digest: string };
  /** Host-owned, read-only system prompt file (readable by every customer uid, writable by none). */
  systemPromptFile: string;
  /** Host-owned `deploy/claude-turn.sh`. */
  turnWrapperPath: string;
  /** The Emma tool bridge's MCP endpoint, as seen from a customer process. */
  bridgeUrl: string;
  /**
   * ENG-2113 tool relay. Absent = a turn that asks for the relay is refused (the legacy HTTP bridge path is unaffected). `shimPath` and `nodePath` are
   * host-owned, root-controlled files (trusted-path checked at start-up); they are run INSIDE the customer's unit by the CLI.
   */
  relay?: { host: RelayHost; shimPath: string; nodePath: string };
  /** How long a relayed call waits for the stream to show its model message id before it is emitted without one (default 2 s). */
  messageIdWaitMs?: number;
  models?: Iterable<string>;
  /** PATH inside customer processes (default a fixed system path; the host's own PATH is never used). */
  basePath?: string;
  /** The unit-private tmp the wrapper uses (default /tmp). */
  unitTmp?: string;
  mcpServerName?: string;
  startTimeoutMs?: number;
  completeTimeoutMs?: number;
  shortCommandTimeoutMs?: number;
  /** After SIGTERM-style kill requests the wait for a process to be gone. */
  killWaitMs?: number;
  /** Approximate cap on events buffered between the CLI and the consumer of a turn (default 8 MB). */
  maxQueuedBytes?: number;
  /** Longest stdout line (one stream-json event) accepted from the CLI before the process is killed (default 16 MB): the runner's line reader buffers a whole line. */
  maxLineBytes?: number;
  /** Bound on the `auth status` check that confirms an auth-looking failure (must stay below the host's abort grace; default 4 s). */
  authConfirmTimeoutMs?: number;
}

const DEFAULTS = {
  messageIdWaitMs: 2_000,
  maxQueuedBytes: 8 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  authConfirmTimeoutMs: 4_000,
  basePath: "/usr/local/bin:/usr/bin:/bin",
  unitTmp: "/tmp",
  mcpServerName: "emma",
  startTimeoutMs: 30_000,
  completeTimeoutMs: 30_000,
  shortCommandTimeoutMs: 30_000,
  killWaitMs: 5_000,
  models: ["haiku", "sonnet", "opus"],
};

/** The host's ChildLike as the structural child the runner expects, plus an `exited` promise that resolves when the process is really gone. */
/** Exported for tests only. */
export class RunnerChildAdapter extends EventEmitter implements RunnerChild {
  readonly stdin: ChildLike["stdin"];
  readonly stdout: Transform;
  readonly stderr: ChildLike["stderr"];
  exitCode: number | null = null;
  signalCode: string | null = null;
  /** Resolves only when the process is really gone (`onExit`), or never existed (`onError`: it could not be started). */
  readonly exited: Promise<void>;

  constructor(
    private readonly child: ChildLike,
    maxLineBytes: number,
  ) {
    super();
    this.stdin = child.stdin;
    this.stderr = child.stderr;
    let done!: () => void;
    this.exited = new Promise<void>((r) => (done = r));
    // The runner's line reader buffers a whole line: a CLI that never prints a newline must not grow the host's memory without bound.
    this.stdout = new LineLimit(maxLineBytes, () => {
      this.kill();
      this.emit("error", new Error("stdout_line_too_long"));
    });
    child.stdout.on("error", () => undefined);
    child.stdout.pipe(this.stdout);
    child.onExit((code, signal) => {
      this.exitCode = code;
      this.signalCode = signal ?? (code === null ? "UNKNOWN" : null); // a finished process never reports both as null (the runner reads that as "still running")
      done();
      this.emit("exit", code, signal);
    });
    child.onError?.((err) => {
      this.exitCode = -1; // it never ran: not "still running" for the runner
      done();
      this.emit("error", err);
    });
  }
  /** A kill that throws (or fails) is not "gone": `exited` waits for `onExit` regardless. */
  kill(): boolean {
    try {
      this.child.kill();
      return true;
    } catch {
      return false;
    }
  }
}

/** Passes bytes through and calls `onOverflow` once if a single line (bytes since the last newline) exceeds `max`; nothing after that is forwarded. */
class LineLimit extends Transform {
  private run = 0;
  private tripped = false;
  constructor(
    private readonly max: number,
    private readonly onOverflow: () => void,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    if (this.tripped) return cb();
    const first = chunk.indexOf(10);
    const last = chunk.lastIndexOf(10);
    const headRun = this.run + (first === -1 ? chunk.length : first);
    this.run = last === -1 ? this.run + chunk.length : chunk.length - last - 1;
    if (headRun > this.max || this.run > this.max) {
      this.tripped = true;
      this.onOverflow();
      return cb();
    }
    cb(null, chunk);
  }
}

/**
 * An async queue between the runner's event sink (pushes as the CLI prints) and the turn generator (pulled at
 * the pace of the host's consumer). Bounded by an approximate byte budget: a consumer that stops reading must
 * not let a chatty CLI grow the host's memory without limit.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: Array<{ v: T; size: number }> = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private bytes = 0;
  overflowed = false;
  constructor(private readonly maxBytes: number) {}
  push(v: T, size: number): void {
    if (this.ended) return;
    if (this.bytes + size > this.maxBytes) {
      this.overflowed = true;
      this.end();
      return;
    }
    this.items.push({ v, size });
    this.bytes += size;
    this.waiter?.();
  }
  end(): void {
    this.ended = true;
    this.waiter?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) {
        const it = this.items.shift() as { v: T; size: number };
        this.bytes -= it.size;
        yield it.v;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
  }
}

interface ShortResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}

export class ClaudeAdapter implements SubscriptionProviderAdapter {
  readonly id = "claude";
  readonly flagKey = "claudeSubscription";
  readonly homeEnvVar = "CLAUDE_CONFIG_DIR";
  readonly ceremony = "paste_code" as const;
  readonly toolTransport = "mcp_direct" as const;
  /** Shared-dir concurrent refresh was verified up to 8 refreshers and crash-safe; the recorded cap is 3. */
  readonly maxProcessesPerHome = 3;
  readonly maxTurnsPerProcess = 1;
  readonly singleUse = true;
  /** Serves a turn's tools through the host relay when configured (turn.run `tools`). */
  readonly relay: boolean;
  readonly loginTtlMs = 10 * 60 * 1000;
  readonly models: ReadonlySet<string>;

  private readonly logins = new WeakMap<LoginProcess, LoginState>();
  private readonly cfg: Required<Omit<ClaudeAdapterConfig, "binary" | "models" | "relay">> & Pick<ClaudeAdapterConfig, "binary" | "relay">;

  constructor(config: ClaudeAdapterConfig) {
    this.cfg = { ...DEFAULTS, ...stripUndefined(config) } as ClaudeAdapter["cfg"];
    this.models = new Set(config.models ?? DEFAULTS.models);
    this.relay = !!config.relay;
  }

  binary(): { path: string; version: string; digest: string } {
    return this.cfg.binary;
  }

  /** Claude needs nothing written into a fresh home: the port created home/work/tmp, and no settings may exist (managed or user). */
  async prepareHome(): Promise<void> {
    /* intentionally empty */
  }

  /** The environment of the short commands (login/status/doctor/logout): HOME is the connection's own tmp dir. */
  private shortEnv(ctx: AdapterContext): NodeJS.ProcessEnv {
    return allowlistedEnv(this.cfg.basePath, ctx.homeDir, ctx.tmpDir, { TMPDIR: ctx.tmpDir });
  }

  private spawnCli(ctx: AdapterContext, args: string[]): ChildLike {
    const spec: SpawnSpec = { file: this.cfg.binary.path, args, env: this.shortEnv(ctx) as Record<string, string>, cwd: ctx.workDir };
    return ctx.spawnAs(spec);
  }

  /** Runs a non-interactive CLI command to completion (stdin closed, output collected and capped, killed on timeout). */
  private runShort(ctx: AdapterContext, args: string[], timeoutMs = this.cfg.shortCommandTimeoutMs): Promise<ShortResult> {
    return new Promise<ShortResult>((resolve) => {
      let child: ChildLike;
      try {
        child = this.spawnCli(ctx, args);
      } catch {
        return resolve({ code: null, timedOut: false, output: "" });
      }
      let output = "";
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, timedOut, output });
      };
      const onData = (chunk: Buffer) => {
        if (output.length < MAX_LOGIN_OUTPUT_CHARS) output += chunk.toString("utf8");
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.stdin.on("error", () => undefined);
      child.stdin.end();
      child.onExit((code) => finish(code));
      child.onError?.(() => finish(null));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        // Resolve when the process is really gone; give up after the kill wait if it is not (a failing kill must not hang the caller).
        killTimer = setTimeout(() => finish(null), this.cfg.killWaitMs);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
    });
  }

  // ───────────────────────────── sign-in (paste code) ─────────────────────────────

  async loginStart(ctx: AdapterContext): Promise<LoginProcess> {
    const child = this.spawnCli(ctx, ["auth", "login"]);
    const st: LoginState = { child, output: "", exited: false, exitCode: null, used: false, exitWaiters: [] };
    const onData = (chunk: Buffer) => {
      if (st.output.length < MAX_LOGIN_OUTPUT_CHARS) st.output += chunk.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => undefined);
    const markExit = (code: number | null) => {
      st.exited = true;
      st.exitCode = code;
      st.exitWaiters.splice(0).forEach((f) => f());
    };
    child.onExit((code) => markExit(code));
    child.onError?.(() => markExit(-1));

    const url = await new Promise<string | undefined>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const found = extractAuthorizeUrl(st.output);
        if (found) {
          clearInterval(poll);
          resolve(found);
        } else if (st.exited || Date.now() - started > this.cfg.startTimeoutMs) {
          clearInterval(poll);
          resolve(undefined);
        }
      }, 25);
    });
    if (!url) {
      const timedOut = !st.exited;
      await this.killLogin(st);
      throw Object.assign(new Error(timedOut ? "start_timeout" : "start_failed"), { code: timedOut ? "start_timeout" : "start_failed" });
    }
    const proc: LoginProcess = { data: { url } };
    this.logins.set(proc, st);
    return proc;
  }

  async loginComplete(proc: LoginProcess, code: string): Promise<void> {
    const st = this.logins.get(proc);
    if (!st || st.used) throw Object.assign(new Error("login_gone"), { code: "login_gone" });
    st.used = true;
    try {
      if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw Object.assign(new Error("bad_code_format"), { code: "bad_code_format" });
      if (st.exited) throw Object.assign(new Error("login_gone"), { code: "login_gone" });
      st.child.stdin.write(`${code}\n`); // the one place the code goes: the CLI's stdin
      if (!(await this.waitExit(st, this.cfg.completeTimeoutMs))) throw Object.assign(new Error("complete_timeout"), { code: "complete_timeout" });
      if (st.exitCode !== 0) throw Object.assign(new Error("code_rejected"), { code: "code_rejected" });
    } catch (err) {
      await this.killLogin(st);
      throw err;
    }
  }

  async loginCancel(proc: LoginProcess): Promise<void> {
    const st = this.logins.get(proc);
    if (st) await this.killLogin(st);
  }

  private waitExit(st: LoginState, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (st.exited) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      st.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async killLogin(st: LoginState): Promise<void> {
    if (st.exited) return;
    try {
      st.child.kill();
    } catch {
      /* already gone */
    }
    await this.waitExit(st, this.cfg.killWaitMs);
  }

  // ───────────────────────────── status, hazards, logout ─────────────────────────────

  async authStatus(ctx: AdapterContext): Promise<AuthStatus> {
    const r = await this.runShort(ctx, ["auth", "status"]);
    const parsed = parseAuthStatus(r.output); // a logged-out CLI prints JSON and exits 1: the exit code is not the signal
    if (!parsed) throw new Error("status_unparseable");
    return parsed;
  }

  async hazards(ctx: AdapterContext): Promise<Hazard[]> {
    const r = await this.runShort(ctx, ["doctor"]);
    if (r.timedOut || r.output.trim() === "") return [{ kind: "other", detail: "doctor_failed" }];
    return parseDoctorHazards(r.output);
  }

  async logout(ctx: AdapterContext): Promise<void> {
    await this.runShort(ctx, ["auth", "logout"]); // best effort: the host wipes the home next
  }

  expiryModel(signedInAtMs: number): { refreshExpiresAtMs?: number } {
    return { refreshExpiresAtMs: signedInAtMs + 30 * 24 * 60 * 60 * 1000 };
  }

  mapError(raw: unknown): ErrorKind {
    if (raw instanceof ClaudeCliTurnError) return "transient";
    const message = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
    if (/mcp server .* is not connected|stdout_line_too_long/i.test(message)) return "transient";
    if ((raw as { code?: string } | null)?.code === "open_failed") return "transient";
    return failureClassToKind(classifyFailureText(message)); // never auth_dead: host faults must not park a healthy login
  }

  // ───────────────────────────── sessions (one process per turn) ─────────────────────────────

  async openSession(ctx: AdapterContext, spec: SessionSpec): Promise<ProviderSession> {
    return new ClaudeSession(this, this.cfg, ctx, spec);
  }

  /** Used by sessions: runs `auth status` to confirm that an auth-looking failure really means the login is dead. */
  async confirmLoggedOut(ctx: AdapterContext): Promise<ErrorKind> {
    try {
      const r = await this.runShort(ctx, ["auth", "status"], this.cfg.authConfirmTimeoutMs);
      const st = parseAuthStatus(r.output);
      if (!st) return "transient"; // unreadable or timed out: uncertainty is never death
      return st.loggedIn ? "transient" : "auth_dead"; // a login the CLI itself reports as signed in is NOT dead: a failed refresh on the network prints similar words
    } catch {
      return "transient"; // uncertain => never park a possibly healthy login
    }
  }
}

interface LoginState {
  child: ChildLike;
  output: string;
  exited: boolean;
  exitCode: number | null;
  used: boolean;
  exitWaiters: Array<() => void>;
}

/** Cheap size estimate of one normalized event (the text it carries plus a fixed overhead); exactness is not needed for a memory bound. */
function approxSize(ev: ProviderEvent): number {
  if (ev.type === "text") return 64 + ev.delta.length;
  if (ev.type === "tool-use" || ev.type === "tool-call") return 128 + JSON.stringify(ev.input ?? null).length;
  return 256;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

class ClaudeSession implements ProviderSession {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly runner: ClaudeCliRunner;
  private readonly exits: Array<Promise<void>> = [];
  private key: string | undefined;
  private handle: ClaudeCliSessionHandle | undefined;
  private used = false;
  private interrupted = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private spawning: Promise<unknown> | undefined;
  /** An in-flight `auth status` confirmation: the session (and so its cap slot) stays alive until it settles. */
  private confirming: Promise<unknown> | undefined;

  constructor(
    private readonly adapter: ClaudeAdapter,
    private readonly cfg: ClaudeAdapter["cfg"],
    private readonly ctx: AdapterContext,
    private readonly spec: SessionSpec,
  ) {
    this.closed = new Promise<void>((r) => (this.resolveClosed = r));
    this.runner = new ClaudeCliRunner({
      maxConcurrentProcesses: 1,
      ports: {
        spawnProcess: (s: ClaudeCliSpawnSpec) => {
          const child = new RunnerChildAdapter(
            ctx.spawnAs({ file: cfg.turnWrapperPath, args: [s.file, ...s.args], env: s.env as Record<string, string>, cwd: s.cwd, ...(this.relayEp ? { relayDir: this.relayEp.dir } : {}) }),
            cfg.maxLineBytes,
          );
          this.exits.push(child.exited);
          return child;
        },
        scratch: { create: () => join(cfg.unitTmp, "aw-home"), remove: () => undefined }, // created by the wrapper inside the unit's private tmp; it vanishes with the unit
        binaryPath: cfg.binary.path,
        buildEnv: (configDir, home) => allowlistedEnv(cfg.basePath, configDir, home, { TMPDIR: cfg.unitTmp, ...(this.relayEp ? { AW_TURN_TOOLS: "1" } : {}) }), // the wrapper reads the tool manifest line and removes the variable
      },
    });
  }

  /** Lazy: the process starts with the turn (it needs that turn's token and model), so there is nothing to check yet. */
  async preflight(): Promise<{ ok: true }> {
    return { ok: true };
  }

  /**
   * Legacy turns (mcp_direct): the CLI calls the HTTP bridge itself, nothing is relayed. Relay turns: the answer to a `tool-call` goes to the shim's socket.
   * Returns false when that operation is no longer pending (the relay's own timer fired, the shim is gone, the turn ended): "result lost".
   */
  answer(operationId: string, answer: ServerRequestAnswer): boolean {
    if (!this.relayEp || answer.kind !== "tool-result") return false;
    const sent = this.relayEp.answer(operationId, { content: answer.content, isError: !answer.ok, ...(answer.images ? { images: answer.images } : {}), ...(answer.unlock ? { unlock: answer.unlock } : {}) });
    if (sent) for (const n of answer.unlock ?? []) this.visibleTools.add(n);
    return sent;
  }

  // ── tool relay (ENG-2113) ──

  /** Model message ids of tool_use blocks seen in the stream and not yet claimed by a relayed call: (bare name, canonical input) -> message id. */
  private readonly streamUses: Array<{ messageId: string; name: string; key: string; claimed: boolean }> = [];
  private waiting: { call: RelayCall; timer: NodeJS.Timeout } | undefined;
  private events: AsyncQueue<ProviderEvent> | undefined;
  private relayEp: RelayEndpoint | undefined;
  private readonly visibleTools = new Set<string>();

  /** A tool_use block from the stream (informational ONLY: it is never executed or registered, it just tells us which model message a relayed call belongs to). */
  private noteStreamUse(raw: Record<string, unknown>): void {
    if (raw.type !== "assistant") return;
    const msg = raw.message as { id?: unknown; content?: unknown } | undefined;
    if (!msg || typeof msg.id !== "string" || !Array.isArray(msg.content)) return;
    const prefix = `mcp__${this.cfg.mcpServerName}__`;
    for (const b of msg.content as Array<Record<string, unknown>>) {
      if (b?.type === "tool_use" && typeof b.name === "string" && b.name.startsWith(prefix)) this.streamUses.push({ messageId: msg.id, name: b.name.slice(prefix.length), key: canonicalJson(b.input ?? {}), claimed: false });
    }
    this.flushWaiting(false);
  }

  /** Emits the waiting call once the stream has shown its model message (or, with `force`, without one after the wait). */
  private flushWaiting(force: boolean): void {
    const w = this.waiting;
    if (!w || !this.events) return;
    const key = canonicalJson(w.call.args);
    const exact = this.streamUses.find((u) => !u.claimed && u.name === w.call.name && u.key === key);
    const byName = this.streamUses.filter((u) => !u.claimed && u.name === w.call.name);
    const hit = exact ?? (byName.length === 1 ? byName[0] : undefined);
    if (!hit && !force) return;
    if (hit) hit.claimed = true;
    clearTimeout(w.timer);
    this.waiting = undefined;
    // Without a match the id is unique to this call, so the backend never collapses it with another one (a duplicate EXECUTION is worse than a missed collapse).
    const messageId = hit?.messageId ?? `unmatched-${w.call.operationId.slice(0, 16)}`;
    const ev: ProviderEvent = { type: "tool-call", operationId: w.call.operationId, messageId, name: w.call.name, input: w.call.args };
    this.events.push(ev, approxSize(ev));
    if (this.events.overflowed) void this.close();
  }

  private onRelayCall(call: RelayCall): void {
    if (this.closing || this.interrupted || !this.events) return;
    const timer = setTimeout(() => this.flushWaiting(true), this.cfg.messageIdWaitMs);
    timer.unref?.();
    this.waiting = { call, timer };
    this.flushWaiting(false);
  }

  private onRelayCallEnded(operationId: string): void {
    if (this.waiting?.call.operationId !== operationId) return; // already emitted: the manager's bookkeeping expires it
    clearTimeout(this.waiting.timer);
    this.waiting = undefined;
  }

  async *turn(input: TurnInput): AsyncGenerator<ProviderEvent> {
    if (this.used) throw new Error("claude_session_single_use");
    this.used = true;
    if (this.closing || this.interrupted) return;
    const events = new AsyncQueue<ProviderEvent>(this.cfg.maxQueuedBytes);
    this.events = events;
    const key = `${this.spec.connectionId}/${input.turnId}`;
    this.key = key;
    let result: Awaited<ReturnType<ClaudeCliRunner["send"]>> | undefined;
    let failure: unknown;
    try {
      let mcpServer: { name: string; url: string; bearerToken: string; stdio?: { command: string; args: string[]; env?: Record<string, string> } };
      let extraLines: string[] | undefined;
      if (input.relay) {
        const relay = this.cfg.relay;
        if (!relay) throw Object.assign(new Error("relay_unavailable"), { code: "open_failed" });
        for (const t of input.relay.tools) if (t.locked !== true) this.visibleTools.add(t.name);
        // The per-turn socket exists (and accepts) BEFORE the unit starts. Identity is fixed here, from the session, never from a frame.
        this.relayEp = await relay.host.open({
          uid: this.ctx.uid,
          identity: { connectionId: this.spec.connectionId, epoch: this.spec.epoch, turnId: input.turnId },
          onCall: (c) => this.onRelayCall(c),
          onCallEnded: (op) => this.onRelayCallEnded(op),
          allowTool: (n) => this.visibleTools.has(n),
          callTimeoutMs: input.relay.callTimeoutMs,
        });
        if (this.closing || this.interrupted) return;
        mcpServer = {
          name: this.cfg.mcpServerName,
          url: "",
          bearerToken: "",
          stdio: { command: relay.nodePath, args: [relay.shimPath], env: { AW_RELAY_SOCKET: RELAY_SOCKET_IN_UNIT, AW_RELAY_TOOLS: join(this.cfg.unitTmp, "aw-cfg", "tools.json") } },
        };
        extraLines = [JSON.stringify(input.relay.tools)];
      } else {
        if (input.bridgeToken === undefined) throw Object.assign(new Error("no_tool_transport"), { code: "open_failed" });
        mcpServer = { name: this.cfg.mcpServerName, url: this.cfg.bridgeUrl, bearerToken: input.bridgeToken };
      }
      this.spawning = this.runner.spawn(key, this.ctx.homeDir, this.cfg.systemPromptFile, {
        model: input.model,
        cwd: this.ctx.workDir,
        mcpServer,
        mcpDelivery: { via: "stdin", path: join(this.cfg.unitTmp, "aw-cfg", "mcp.json"), ...(extraLines ? { extraLines } : {}) },
      });
      await this.spawning;
      if (this.closing || this.interrupted) return;
      this.handle = { conversationId: key };
      this.runner
        .send(this.handle, input.prompt, {
          onEvent: (raw) => {
            this.noteStreamUse(raw);
            for (const ev of normalizeClaudeEvent(raw)) events.push(ev, approxSize(ev));
            if (events.overflowed) void this.close(); // the consumer is not keeping up: end the process rather than buffer without bound
          },
        })
        .then(
          (r) => {
            result = r;
            events.end();
          },
          (e: unknown) => {
            failure = e;
            events.end();
          },
        );
      for await (const ev of events) yield ev;
      if (events.overflowed) {
        yield { type: "result", ok: false, text: "", errorKind: "transient" };
        return;
      }
      if (failure !== undefined) {
        yield { type: "result", ok: false, text: "", errorKind: this.adapter.mapError(failure) };
        return;
      }
      if (!result) return;
      const usage = usageFromResult(result.raw as Record<string, unknown>);
      if (usage) yield usage;
      if (!result.isError) {
        yield { type: "result", ok: true, text: result.resultText };
        return;
      }
      const cls = classifyFailureText(result.resultText);
      let errorKind: ErrorKind = failureClassToKind(cls);
      if (cls === "auth_like") {
        // (The `closing` skip below already makes the early assignment redundant for a close that arrives during the stop: no check is
        // spawned then. It stays as a second guard: `closed` must never be able to resolve before a check that does run.)
        // `confirming` is set BEFORE any await: a close() arriving while the turn's process is being stopped must find it and
        // wait (`closed` frees the cap slot, so it may not resolve before the check's own process has finished). If a close has
        // already begun, nothing is spawned at all.
        const confirmation: Promise<ErrorKind> = this.closing
          ? Promise.resolve("transient")
          : (async () => {
              // The turn's process is gone first: the check must not run beside it (one process per cap slot, and a CLI still inside its
              // stop grace may be writing a refreshed login the check would read half-written). Not gone in time => no check.
              const gone = await this.stopProcess();
              return this.closing || !gone ? "transient" : await this.adapter.confirmLoggedOut(this.ctx);
            })();
        this.confirming = confirmation;
        errorKind = await confirmation;
      }
      yield { type: "result", ok: false, text: "", errorKind };
    } catch (err) {
      if (!this.closing) yield { type: "result", ok: false, text: "", errorKind: this.adapter.mapError(err) };
    } finally {
      void this.close().catch(() => undefined);
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.handle) this.runner.interrupt(this.handle); // a Claude session cannot continue after an interrupt: the process is closed
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  /** Asks the runner to end the turn's process and waits for it to be gone, bounded: a kill that keeps failing must not hang the turn (`close()` keeps waiting for the real exit). */
  private async stopProcess(): Promise<boolean> {
    try {
      if (this.key) this.runner.close({ conversationId: this.key });
      else this.runner.closeAll();
    } catch {
      /* a kill that threw: the process is not gone, so waiting for its exit below keeps going */
    }
    await this.spawning?.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let gone = false;
    try {
      await Promise.race([
        Promise.all(this.exits).then(() => {
          gone = true;
        }),
        new Promise<void>((r) => (timer = setTimeout(r, this.cfg.killWaitMs))),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return gone;
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    try {
      try {
        if (this.key) this.runner.close({ conversationId: this.key });
        else this.runner.closeAll();
      } catch {
        /* a kill that threw: the process is not gone, so `exits` below keeps waiting for its real exit */
      }
      // A spawn that was in flight finishes (or aborts itself) first, so its process is in `exits` before we wait.
      // (Defense in depth: `ctx.spawnAs` is synchronous today, so a process cannot appear between a close request and the
      // runner registering it; the randomized lifecycle test cannot open this window. Keep it for a port that stops being synchronous.)
      await this.spawning?.catch(() => undefined);
      // Resolves only when the process is really gone (the core frees the cap slot and relies on it).
      let seen: number;
      do {
        seen = this.exits.length;
        await Promise.all(this.exits);
      } while (this.exits.length !== seen);
      // ...and when the auth confirmation (a second, short-lived process on this home) has finished.
      await this.confirming?.catch(() => undefined);
      // The relay goes with the turn: no connection, pending call or socket outlives the process (or the turn that ended without one).
      if (this.waiting) clearTimeout(this.waiting.timer);
      this.waiting = undefined;
      await this.relayEp?.close().catch(() => undefined);
    } finally {
      this.resolveClosed();
    }
  }
}

/** JSON with sorted keys: the same arguments compare equal however the producer ordered them. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
