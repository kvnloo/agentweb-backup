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
}

const DEFAULTS = {
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
class RunnerChildAdapter extends EventEmitter implements RunnerChild {
  readonly stdin: ChildLike["stdin"];
  readonly stdout: ChildLike["stdout"];
  readonly stderr: ChildLike["stderr"];
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly exited: Promise<void>;

  constructor(private readonly child: ChildLike) {
    super();
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    let done!: () => void;
    this.exited = new Promise<void>((r) => (done = r));
    child.onExit((code, signal) => {
      this.exitCode = code ?? (signal ? null : 0);
      this.signalCode = signal;
      if (this.exitCode === null && this.signalCode === null) this.signalCode = "UNKNOWN";
      done();
      this.emit("exit", code, signal);
    });
    child.onError?.((err) => {
      done();
      this.emit("error", err);
    });
  }
  kill(): boolean {
    this.child.kill();
    return true;
  }
}

/** A tiny unbounded async queue: events are pushed by the runner's sink and pulled by the turn generator. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  push(v: T): void {
    if (this.ended) return;
    this.items.push(v);
    this.waiter?.();
  }
  end(): void {
    this.ended = true;
    this.waiter?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) yield this.items.shift() as T;
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
  readonly loginTtlMs = 10 * 60 * 1000;
  readonly models: ReadonlySet<string>;

  private readonly logins = new WeakMap<LoginProcess, LoginState>();
  private readonly cfg: Required<Omit<ClaudeAdapterConfig, "binary" | "models">> & Pick<ClaudeAdapterConfig, "binary">;

  constructor(config: ClaudeAdapterConfig) {
    this.cfg = { ...DEFAULTS, ...stripUndefined(config) } as ClaudeAdapter["cfg"];
    this.models = new Set(config.models ?? DEFAULTS.models);
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
      const finish = (code: number | null, timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, timedOut, output });
      };
      const onData = (chunk: Buffer) => {
        if (output.length < MAX_LOGIN_OUTPUT_CHARS) output += chunk.toString("utf8");
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.stdin.on("error", () => undefined);
      child.stdin.end();
      child.onExit((code) => finish(code, false));
      child.onError?.(() => finish(null, false));
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        finish(null, true);
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
    if (/mcp server .* is not connected/i.test(message)) return "transient";
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
      const st = await this.authStatus(ctx);
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
            ctx.spawnAs({ file: cfg.turnWrapperPath, args: [s.file, ...s.args], env: s.env as Record<string, string>, cwd: s.cwd }),
          );
          this.exits.push(child.exited);
          return child;
        },
        scratch: { create: () => join(cfg.unitTmp, "aw-home"), remove: () => undefined }, // created by the wrapper inside the unit's private tmp; it vanishes with the unit
        binaryPath: cfg.binary.path,
        buildEnv: (configDir, home) => allowlistedEnv(cfg.basePath, configDir, home, { TMPDIR: cfg.unitTmp }),
      },
    });
  }

  /** Lazy: the process starts with the turn (it needs that turn's token and model), so there is nothing to check yet. */
  async preflight(): Promise<{ ok: true }> {
    return { ok: true };
  }

  answer(): void {
    /* mcp_direct: the CLI calls the bridge itself; nothing is relayed through the host */
  }

  async *turn(input: { turnId: string; prompt: string; model: string; bridgeToken: string }): AsyncGenerator<ProviderEvent> {
    if (this.used) throw new Error("claude_session_single_use");
    this.used = true;
    if (this.closing || this.interrupted) return;
    const events = new AsyncQueue<ProviderEvent>();
    const key = `${this.spec.connectionId}/${input.turnId}`;
    this.key = key;
    let result: Awaited<ReturnType<ClaudeCliRunner["send"]>> | undefined;
    let failure: unknown;
    try {
      this.spawning = this.runner.spawn(key, this.ctx.homeDir, this.cfg.systemPromptFile, {
        model: input.model,
        cwd: this.ctx.workDir,
        mcpServer: { name: this.cfg.mcpServerName, url: this.cfg.bridgeUrl, bearerToken: input.bridgeToken },
        mcpDelivery: { via: "stdin", path: join(this.cfg.unitTmp, "aw-mcp.json") },
      });
      await this.spawning;
      if (this.closing || this.interrupted) return;
      this.handle = { conversationId: key };
      this.runner
        .send(this.handle, input.prompt, {
          onEvent: (raw) => {
            for (const ev of normalizeClaudeEvent(raw)) events.push(ev);
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
      const errorKind = cls === "auth_like" ? await this.adapter.confirmLoggedOut(this.ctx) : failureClassToKind(cls);
      yield { type: "result", ok: false, text: "", errorKind };
    } catch (err) {
      if (!this.closing) yield { type: "result", ok: false, text: "", errorKind: this.adapter.mapError(err) };
    } finally {
      void this.close();
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.handle) this.runner.interrupt(this.handle); // a Claude session cannot continue after an interrupt: the process is closed
    void this.close();
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    try {
      if (this.key) this.runner.close({ conversationId: this.key });
      else this.runner.closeAll();
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
    } finally {
      this.resolveClosed();
    }
  }
}
