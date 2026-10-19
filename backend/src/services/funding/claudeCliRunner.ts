/**
 * ENG-2107 (B1): a kept-open `claude -p` process per conversation, under the
 * lockdown contract Claude Code's own docs require for a subscription-funded run.
 *
 * Every rule below is enforced by this module, not by caller discipline — the
 * caller supplies only a conversationId, a login's CLAUDE_CONFIG_DIR, and a
 * system-prompt file; there is no parameter that could leak the backend's own
 * process.env (which holds static AWS keys and would silently convert a
 * subscription run into API billing if a stray ANTHROPIC_* var reached the
 * child — see the ticket's "Watch" section).
 */

import { spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface, type Interface } from "readline";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { resolveClaudeBinary } from "./claudeBinary";

/** The one MCP server a session may reach: the tool bridge (ENG-2109), with its run token. */
export interface ClaudeCliMcpServer {
  name: string;
  url: string;
  bearerToken: string;
}

export interface ClaudeCliRunnerOptions {
  /** Model alias or id, e.g. "haiku" | "sonnet" | "opus" | a full model id. Omit for the CLI's own default. */
  model?: string;
  /**
   * Gives the session tools through this MCP server and nothing else. The config,
   * token included, is written to a 0600 file in the session's scratch dir rather than
   * passed on the command line, where it would be visible in the process list.
   */
  mcpServer?: ClaudeCliMcpServer;
  /**
   * Called for every tool call the model emits, with the id of the model message it
   * came in. The tool bridge needs this to collapse an identical call repeated within
   * one message, which the MCP request alone cannot show.
   */
  onToolUse?: (event: ClaudeCliToolUseEvent) => void;
  /**
   * Working directory for the process. Keep it stable for a given login: Claude Code keeps
   * per-project state in the login's `.claude.json` keyed by the working directory, so a
   * new directory per session would add a key per session. Defaults to one shared, empty,
   * private (0700) directory. A host that serves several logins should pass a directory
   * per login, outside any world-writable parent: memory files such as CLAUDE.md are
   * looked up from the working directory upwards.
   */
  cwd?: string;
  /**
   * Called with every parsed stream-json event the process prints (system/init, assistant,
   * user, rate_limit_event, hook events, result, ...), before the runner acts on it. The
   * runner's own handling does not depend on this hook, and an error thrown from it is
   * swallowed. Per-turn events can also be taken through `send()`'s `onEvent`.
   * The runner acts on an event first; sinks then receive it read-only (frozen). A sink runs
   * after the runner has settled the turn, so a sink may call `send()` for the next turn from a
   * `result` event. A sink also sees the `system/init` event that made the runner reject a turn or
   * close the session (an MCP server that is not connected), after that decision. Events that arrive between turns, or after a `result`, go to the
   * session-level sink only or to whichever turn is pending when they arrive: a caller must
   * not rely on per-turn attribution for hook events. To stop on an alarm use `terminate()`
   * (works between turns) or `interrupt()` (a turn in flight).
   */
  onEvent?: (event: ClaudeCliEvent) => void;
  /**
   * Called once when the session's process is gone for any reason (idle close, exit,
   * close(), MCP not connected), so the caller can end what it tied to the session,
   * such as the tool-bridge run and its token.
   */
  onClose?: (reason: string) => void;
}

/** One parsed stream-json line, as printed by the CLI. Nothing here is interpreted by the runner except where noted. */
export type ClaudeCliEvent = Record<string, unknown>;

export interface ClaudeCliSendOptions {
  /** Called with every event printed while this turn is in flight (and only then). */
  onEvent?: (event: ClaudeCliEvent) => void;
  /**
   * Wall-clock limit for this turn. When it passes, the turn rejects with a
   * `ClaudeCliTurnError` (code "deadline") and the session is closed: a CLI that has not
   * answered in time cannot be resynchronised, and the next turn gets a fresh process.
   */
  deadlineMs?: number;
}

export class ClaudeCliTurnError extends Error {
  constructor(readonly code: "deadline" | "interrupted") {
    super(`claudeCliRunner: turn ${code === "deadline" ? "exceeded its deadline" : "was interrupted"}`);
    this.name = "ClaudeCliTurnError";
  }
}

export interface ClaudeCliToolUseEvent {
  messageId: string;
  toolUseId: string;
  name: string;
}

export interface ClaudeCliTurnResult {
  isError: boolean;
  resultText: string;
  /** The raw parsed `result`-type stream-json event (frozen), for callers that need fields this type doesn't surface yet. */
  raw: Readonly<Record<string, unknown>>;
}

export interface ClaudeCliSessionHandle {
  readonly conversationId: string;
}

const STDERR_TAIL_MAX_CHARS = 4000;
const MAX_TIMER_MS = 2_147_483_647;

interface PendingTurn {
  resolve: (result: ClaudeCliTurnResult) => void;
  reject: (err: Error) => void;
  onEvent: ((event: ClaudeCliEvent) => void) | undefined;
  deadlineTimer: NodeJS.Timeout | null;
}

interface PooledSession {
  conversationId: string;
  child: ChildProcessWithoutNullStreams;
  rl: Interface;
  scratchHomeDir: string;
  pending: PendingTurn | null;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
  /** From the session's `system`/`init` event — the ENG-2107 contract-test field. Undefined until init arrives. */
  apiKeySource: string | undefined;
  /** Last ~4000 chars of stderr, kept only for error diagnostics. Draining it also prevents an OS pipe-buffer deadlock on this long-lived, --verbose child. */
  stderrTail: string;
  /** Name of the MCP server this session was given, if any. */
  expectedMcpServer: string | undefined;
  /** That server's status from the latest `system/init` event. */
  mcpServerStatus: string | undefined;
  onToolUse: ((event: ClaudeCliToolUseEvent) => void) | undefined;
  onEvent: ((event: ClaudeCliEvent) => void) | undefined;
  onClose: ((reason: string) => void) | undefined;
  /** The MCP server this process was started with; it cannot be changed afterwards. */
  mcpServer: ClaudeCliMcpServer | undefined;
}

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_PROCESSES = 8;

export class ClaudeCliRunner {
  private readonly pool = new Map<string, PooledSession>();
  private readonly spawnQueue: Array<{ conversationId: string; resolve: (granted: boolean) => void }> = [];
  /** Slots committed to spawning OR already live. Incremented synchronously the instant a
   * spawn passes the cap check — never derived from pool.size, which only grows after that
   * spawn's own async gap and would let several different conversationIds, spawned without
   * awaiting between them, all observe the same stale count and all bypass the cap. */
  private reservedSlots = 0;
  /** conversationId -> the in-flight spawn, so concurrent spawn()/prewarm() calls for the
   * same conversation serialize onto one real process instead of racing to create two. */
  private readonly spawning = new Map<string, Promise<void>>();
  /** conversationIds whose close() arrived before the spawn it targets finished — the
   * spawn must self-abort (or self-close immediately) rather than leave an orphan. */
  private readonly pendingCloseRequests = new Set<string>();
  private readonly maxConcurrentProcesses: number;
  private readonly idleCloseMs: number;
  /** The empty, private (mkdtemp: 0700, unpredictable name) working directory for sessions that pass no `cwd`. */
  private defaultCwd: string | undefined;

  constructor(opts: { maxConcurrentProcesses?: number; idleCloseMs?: number } = {}) {
    this.maxConcurrentProcesses = opts.maxConcurrentProcesses ?? DEFAULT_MAX_CONCURRENT_PROCESSES;
    this.idleCloseMs = opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  }

  /**
   * One empty private directory per runner, created on first use. Created with `mkdtemp` (an
   * unpredictable name, so nobody can pre-plant it), and recreated if the OS temp cleaner
   * removed it while the backend was running (a missing cwd makes the spawn fail with an error
   * that blames the binary).
   */
  private workingDir(): string {
    if (!this.defaultCwd || !existsSync(this.defaultCwd)) {
      this.defaultCwd = mkdtempSync(join(tmpdir(), "claude-cli-cwd-"));
    }
    return this.defaultCwd;
  }

  get activeProcessCount(): number {
    return this.pool.size;
  }

  /**
   * Returns the pooled session for conversationId, spawning a fresh process only if
   * none is open. Queues behind the concurrency cap when every slot is in use by a
   * different conversation. Concurrent calls for the same conversationId (e.g. a
   * chat-open signal firing twice) serialize onto the same spawn rather than each
   * starting a real process.
   *
   * Calling this ahead of the first real turn IS pre-warming — it pays the ~1s CLI
   * cold-start cost before the user is waiting on it, so the first real send() lands
   * at warm-session latency instead. `prewarm()` below is this same method under the
   * name a caller reaches for on a chat-open signal.
   */
  async spawn(
    conversationId: string,
    configDir: string,
    systemPromptFile: string,
    opts: ClaudeCliRunnerOptions = {},
  ): Promise<ClaudeCliSessionHandle> {
    // A relative cwd would resolve against the backend's own working directory.
    if (opts.cwd !== undefined && !isAbsolute(opts.cwd)) {
      throw new Error("claudeCliRunner: cwd must be an absolute path");
    }
    const existing = this.pool.get(conversationId);
    if (existing && !existing.closed) {
      // The MCP config is fixed at process start. Handing back a process that holds a
      // different (by now revoked) run token would give the caller a toolless session.
      if (opts.mcpServer && !sameMcpServer(existing.mcpServer, opts.mcpServer)) {
        throw new Error("claudeCliRunner: a session is already open for this conversation with a different MCP server; close it first");
      }
      this.scheduleIdleClose(existing);
      return { conversationId };
    }

    let inFlight = this.spawning.get(conversationId);
    if (!inFlight) {
      inFlight = this.doSpawn(conversationId, configDir, systemPromptFile, opts);
      this.spawning.set(conversationId, inFlight);
      // The cleanup chain is its own promise: without a handler a failed spawn would
      // surface there as an unhandled rejection, on top of the one the caller awaits.
      inFlight
        .finally(() => {
          if (this.spawning.get(conversationId) === inFlight) this.spawning.delete(conversationId);
        })
        .catch(() => undefined);
    }
    await inFlight;
    // This call may have joined a spawn started by an earlier one (a prewarm) with
    // other options. The process then holds that call's MCP config, not this one's.
    const spawned = this.pool.get(conversationId);
    if (opts.mcpServer && spawned && !spawned.closed && !sameMcpServer(spawned.mcpServer, opts.mcpServer)) {
      throw new Error("claudeCliRunner: a session is already open for this conversation with a different MCP server; close it first");
    }
    return { conversationId };
  }

  private async doSpawn(
    conversationId: string,
    configDir: string,
    systemPromptFile: string,
    opts: ClaudeCliRunnerOptions,
  ): Promise<void> {
    const slotGranted = await this.waitForFreeSlot(conversationId);
    if (!slotGranted) {
      // Cancelled while still queued -- never actually granted a slot, so there is
      // nothing to release. Must not fall through to releaseSlotToQueue() below.
      this.pendingCloseRequests.delete(conversationId);
      return;
    }

    let sessionCreated = false;
    try {
      if (this.pendingCloseRequests.delete(conversationId)) {
        return; // close() arrived right after the slot was granted -- it WAS granted, so the finally below must release it.
      }

      const scratchHomeDir = mkdtempSync(join(tmpdir(), "claude-cli-home-"));
      let child: ChildProcessWithoutNullStreams;
      try {
        const env = buildAllowlistedEnv(configDir, scratchHomeDir);
        const mcpConfigFile = opts.mcpServer ? writeMcpConfig(scratchHomeDir, opts.mcpServer) : undefined;
        // Absolute path to the pinned binary (never a PATH lookup) and a fixed, stable working
        // directory, so the process does not inherit the backend's cwd.
        child = spawnChildProcess(resolveClaudeBinary(), buildArgs(systemPromptFile, opts, mcpConfigFile), {
          env,
          cwd: opts.cwd ?? this.workingDir(),
        });
      } catch (err) {
        // Nothing owns the scratch dir yet, and it may already hold the run token.
        rmSync(scratchHomeDir, { recursive: true, force: true });
        throw err;
      }

      const session: PooledSession = {
        conversationId,
        child,
        rl: createInterface({ input: child.stdout }),
        scratchHomeDir,
        pending: null,
        idleTimer: null,
        closed: false,
        apiKeySource: undefined,
        stderrTail: "",
        expectedMcpServer: opts.mcpServer?.name,
        mcpServerStatus: undefined,
        onToolUse: opts.onToolUse,
        onEvent: opts.onEvent,
        onClose: opts.onClose,
        mcpServer: opts.mcpServer,
      };

      session.rl.on("line", (line) => this.handleLine(session, line));
      child.stderr.on("data", (chunk: Buffer) => {
        // Drains the pipe (preventing a backpressure deadlock on this long-lived,
        // --verbose child) and keeps a bounded tail for error diagnostics only.
        session.stderrTail = (session.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX_CHARS);
      });
      child.on("exit", () => this.closeSessionInternal(session, "process-exit"));
      child.on("error", (err) => {
        this.clearPending(session)?.reject(err);
        this.closeSessionInternal(session, "process-error");
      });
      child.stdin.on("error", (err) => {
        // An async EPIPE-type error here is an EventEmitter 'error' event; leaving it
        // unhandled would crash the whole backend process, not just this session.
        this.clearPending(session)?.reject(err);
      });

      this.pool.set(conversationId, session);
      sessionCreated = true; // set immediately after pool.set() — if anything after this throws, the
      // session is already live and will release its slot via its own eventual close, not here.
      this.scheduleIdleClose(session);
      // No await since the first pendingCloseRequests check above — nothing (including
      // another close() call) can run between that check and this point, so a second
      // check here would be unreachable; the single check above is sufficient.
    } finally {
      this.pendingCloseRequests.delete(conversationId);
      // If no session was created, this doSpawn is the sole owner of the slot
      // waitForFreeSlot claimed above, and nothing else will ever release it — a live
      // session's own close (closeSessionInternal) owns that release instead, exactly
      // once, so this must not also run when sessionCreated is true (that would double-free).
      if (!sessionCreated) this.releaseSlotToQueue();
    }
  }

  /** Sends one turn to an already-open session and resolves on its terminal `result` event. */
  send(handle: ClaudeCliSessionHandle, message: string, options: ClaudeCliSendOptions = {}): Promise<ClaudeCliTurnResult> {
    const session = this.pool.get(handle.conversationId);
    if (!session || session.closed) {
      return Promise.reject(
        new Error(`claudeCliRunner: no open session for conversation ${handle.conversationId}`),
      );
    }
    if (session.pending) {
      return Promise.reject(
        new Error(`claudeCliRunner: a turn is already in flight for conversation ${handle.conversationId}`),
      );
    }

    this.scheduleIdleClose(session);
    return new Promise<ClaudeCliTurnResult>((resolve, reject) => {
      const pending: PendingTurn = { resolve, reject, onEvent: options.onEvent, deadlineTimer: null };
      session.pending = pending;
      if (typeof options.deadlineMs === "number" && Number.isFinite(options.deadlineMs) && options.deadlineMs > 0) {
        pending.deadlineTimer = setTimeout(() => {
          if (session.pending !== pending) return;
          this.closeSessionInternal(session, "turn-deadline", new ClaudeCliTurnError("deadline"));
        }, Math.min(options.deadlineMs, MAX_TIMER_MS)); // a larger delay would make Node fire the timer after 1 ms
      }
      const line = JSON.stringify({ type: "user", message: { role: "user", content: message } });
      try {
        session.child.stdin.write(line + "\n");
      } catch (err) {
        this.clearPending(session);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Stops the turn in flight for this conversation by closing its session (the process is
   * killed; there is no verified graceful interrupt). The turn rejects with a
   * `ClaudeCliTurnError` (code "interrupted"). Returns false when nothing is in flight.
   */
  interrupt(handle: ClaudeCliSessionHandle): boolean {
    const session = this.pool.get(handle.conversationId);
    if (!session || session.closed || !session.pending) return false;
    this.closeSessionInternal(session, "interrupted", new ClaudeCliTurnError("interrupted"));
    return true;
  }

  /**
   * Closes the session whether or not a turn is in flight (an alarm that arrives between
   * turns, such as a hook event at start-up, has nothing for `interrupt()` to stop). Any
   * turn in flight rejects with the generic "session closed" error. Returns false when no
   * session is open.
   */
  terminate(handle: ClaudeCliSessionHandle): boolean {
    const session = this.pool.get(handle.conversationId);
    if (!session || session.closed) {
      // A spawn still queued or in flight has no session yet: close() makes it abort itself.
      if (!session && this.spawning.has(handle.conversationId)) {
        this.close(handle);
        return true;
      }
      return false;
    }
    this.closeSessionInternal(session, "terminated");
    return true;
  }

  /** Clears the in-flight turn and its deadline timer. */
  private clearPending(session: PooledSession): PendingTurn | null {
    const pending = session.pending;
    if (pending?.deadlineTimer) clearTimeout(pending.deadlineTimer);
    session.pending = null;
    return pending;
  }

  /**
   * Closes the session for conversationId. Safe to call while a spawn for the same
   * conversationId is still queued behind the concurrency cap, or mid-flight past the
   * queue but not yet in the pool — in both cases the spawn is made to self-abort (or
   * self-close immediately) instead of completing as an orphaned, unreachable process.
   */
  close(handle: ClaudeCliSessionHandle): void {
    const { conversationId } = handle;
    const session = this.pool.get(conversationId);
    if (session) {
      this.closeSessionInternal(session, "explicit-close");
      return;
    }

    // this.spawning is the actual source of truth for "something is in flight for this
    // conversationId" — it covers a spawn still queued behind the cap AND one on the
    // fast path that hasn't reached the queue or the pool yet. Without this guard, a
    // defensive close() on an id with nothing live or queued would still plant a
    // pendingCloseRequests marker that nothing would ever consume except a future,
    // unrelated spawn() call for that same id — silently turning it into a no-op that
    // resolves a fake-successful handle to no real session.
    if (!this.spawning.has(conversationId)) return;

    this.pendingCloseRequests.add(conversationId);
    for (let i = this.spawnQueue.length - 1; i >= 0; i--) {
      if (this.spawnQueue[i].conversationId === conversationId) {
        const [entry] = this.spawnQueue.splice(i, 1);
        // false: this entry never held a slot (it was only ever queued, waiting for
        // one) -- resolving it directly here, instead of through releaseSlotToQueue(),
        // must not be mistaken by its doSpawn for a real grant it now owes a release for.
        entry.resolve(false);
      }
    }
  }

  /** Alias of spawn() for a caller warming a session ahead of the first real turn (e.g. on chat open). */
  prewarm(
    conversationId: string,
    configDir: string,
    systemPromptFile: string,
    opts: ClaudeCliRunnerOptions = {},
  ): Promise<ClaudeCliSessionHandle> {
    return this.spawn(conversationId, configDir, systemPromptFile, opts);
  }

  /**
   * The session's `system/init.apiKeySource` field — ENG-2107's own named contract
   * assertion. `undefined` until the init event has arrived (always before the first
   * `result`), or if the session isn't open.
   */
  apiKeySourceFor(handle: ClaudeCliSessionHandle): string | undefined {
    return this.pool.get(handle.conversationId)?.apiKeySource;
  }

  /** Status of the session's MCP server from its latest `system/init` event ("connected" when usable). */
  mcpServerStatusFor(handle: ClaudeCliSessionHandle): string | undefined {
    return this.pool.get(handle.conversationId)?.mcpServerStatus;
  }

  /** Closes every open session, and guarantees nothing still queued or mid-spawn survives it either. */
  closeAll(): void {
    // this.spawning (not just spawnQueue) is the real source of truth for "in flight" —
    // it also covers a spawn on the fast path that hasn't reached the queue or the pool
    // yet (the common case: a slot is free, so waitForFreeSlot never queues it, but the
    // call still doesn't resume past its `await` until the next microtask tick). Marking
    // only spawnQueue entries missed that case entirely, letting a real, unreachable
    // process spawn asynchronously right after closeAll() had already returned.
    for (const id of this.spawning.keys()) this.pendingCloseRequests.add(id);
    for (const session of [...this.pool.values()]) this.closeSessionInternal(session, "close-all");

    // Anything still queued after every live session closed (the queue was longer than
    // the pool ever was) would otherwise wait forever for a slot that will never free on
    // its own. Release it now; pendingCloseRequests (set above) ensures none of it spawns.
    const remaining = this.spawnQueue.splice(0, this.spawnQueue.length);
    for (const entry of remaining) entry.resolve(false); // never held a slot -- see close()'s own comment on this.
  }

  private handleLine(session: PooledSession, line: string): void {
    // readline keeps delivering the rest of a chunk after close(); a session that was already closed emits nothing.
    if (session.closed || !line.trim()) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // stray non-JSON stdout noise is not a valid event; ignore rather than crash the session
    }
    // `null`, numbers, strings and arrays are valid JSON but not events; reading `.type` on null throws,
    // and a throw inside the readline listener would be an uncaught exception in the backend.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    // The sinks that were listening when this event arrived. The runner acts on the event
    // first and the sinks see it afterwards (read-only), so a sink cannot change what the
    // runner decides, and a sink that closes the session cannot mask the runner's own
    // diagnosis (such as an MCP server that is not connected).
    const sinks = [session.onEvent, session.pending?.onEvent];
    this.actOn(session, parsed);
    Object.freeze(parsed);
    emitEvent(sinks, parsed);
  }

  private actOn(session: PooledSession, parsed: Record<string, unknown>): void {
    if (parsed.type === "system" && parsed.subtype === "init") {
      session.apiKeySource = typeof parsed.apiKeySource === "string" ? parsed.apiKeySource : undefined;
      if (session.expectedMcpServer) {
        session.mcpServerStatus = mcpStatus(parsed.mcp_servers, session.expectedMcpServer);
        if (session.mcpServerStatus !== "connected") {
          // The CLI carries on with zero tools when its MCP server fails to connect (a
          // rejected token, an unreachable bridge) and reports the turn as a success.
          // A toolless Emma turn must not pass for a real one, so stop here.
          this.clearPending(session)?.reject(
            new Error(
              `claudeCliRunner: MCP server "${session.expectedMcpServer}" is not connected (${session.mcpServerStatus ?? "missing"})`,
            ),
          );
          this.closeSessionInternal(session, "mcp-not-connected");
        }
      }
      return;
    }
    if (parsed.type === "assistant") {
      if (session.onToolUse) reportToolUses(parsed.message, session.onToolUse);
      return;
    }
    if (parsed.type !== "result" || !session.pending) return;
    const { resolve } = this.clearPending(session)!;
    this.scheduleIdleClose(session); // restart the idle window from actual completion, not from when the turn started
    resolve({
      isError: parsed.is_error === true,
      resultText: typeof parsed.result === "string" ? parsed.result : "",
      raw: parsed,
    });
  }

  private scheduleIdleClose(session: PooledSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (session.pending) {
        // A turn is still genuinely in flight -- this session isn't idle. Don't kill a
        // live turn; just keep checking back every idle window instead.
        this.scheduleIdleClose(session);
        return;
      }
      this.closeSessionInternal(session, "idle");
    }, this.idleCloseMs);
  }

  private closeSessionInternal(session: PooledSession, reason: string, pendingError?: Error): void {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    // Delete by identity, not just by key -- a key collision from a since-fixed race
    // must never let closing a stale session erase a different, live one at that key.
    if (this.pool.get(session.conversationId) === session) {
      this.pool.delete(session.conversationId);
    }
    session.rl.close();
    const removeScratch = () => {
      try {
        rmSync(session.scratchHomeDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup of a throwaway scratch dir
      }
    };
    // Removed now so the run token file is gone at once, and again when the process has
    // really exited: a CLI that is still shutting down re-creates its HOME (a cache dir).
    if (session.child.exitCode === null && session.child.signalCode === null) {
      session.child.once("exit", removeScratch);
    }
    session.child.kill();
    removeScratch();
    this.clearPending(session)?.reject(
      pendingError ?? new Error(`claudeCliRunner: session closed (${reason}) with a turn still in flight`),
    );
    this.releaseSlotToQueue();
    if (session.onClose) {
      try {
        session.onClose(reason);
      } catch (err) {
        console.error("[claudeCliRunner] onClose failed (swallowed):", err instanceof Error ? err.message : String(err));
      }
    }
  }

  /**
   * Resolves `true` once a slot is actually granted (fast path, or handed off from the
   * queue by releaseSlotToQueue), or `false` if this call was cancelled while still
   * queued (close()/closeAll() on a still-waiting conversationId) and was never granted
   * one at all. The caller must not release a slot it was never granted — that was the
   * bug: close()/closeAll() used to resolve a queued waiter directly, and doSpawn's own
   * cleanup had no way to tell that apart from a real handoff, so it released a slot
   * that was never counted, corrupting reservedSlots downward and reopening the cap.
   */
  private async waitForFreeSlot(conversationId: string): Promise<boolean> {
    if (this.reservedSlots < this.maxConcurrentProcesses) {
      this.reservedSlots++; // claim it now, synchronously -- not after this function's own await
      return true;
    }
    return new Promise<boolean>((resolve) => this.spawnQueue.push({ conversationId, resolve }));
  }

  /** Hands a freed slot directly to the next queued waiter, or actually frees it if none is waiting. */
  private releaseSlotToQueue(): void {
    const next = this.spawnQueue.shift();
    if (next) {
      next.resolve(true); // the slot transfers to them -- reservedSlots is unchanged, not re-claimed.
    } else {
      this.reservedSlots--;
    }
  }
}

export function buildAllowlistedEnv(configDir: string, scratchHomeDir: string): NodeJS.ProcessEnv {
  const path = process.env.PATH;
  if (!path) throw new Error("claudeCliRunner: PATH is not set in the parent process — cannot resolve the claude binary");
  return {
    PATH: path,
    HOME: scratchHomeDir,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    // CLAUDE_CODE_DISABLE_THINKING alone does not stop sonnet from producing a real
    // thinking block on a reasoning-shaped prompt (verified live, 2.1.294 — a step-by-step
    // math question produced a 'thinking' content block and 111 thinking_tokens with only
    // the var above set). MAX_THINKING_TOKENS=0 is what actually suppresses it; confirmed
    // live afterward (0 thinking_tokens, no thinking block) and harmless on haiku.
    MAX_THINKING_TOKENS: "0",
    CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
  };
}

function writeMcpConfig(scratchHomeDir: string, server: ClaudeCliMcpServer): string {
  const file = join(scratchHomeDir, "mcp.json");
  const config = {
    mcpServers: {
      [server.name]: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.bearerToken}` } },
    },
  };
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

function sameMcpServer(a: ClaudeCliMcpServer | undefined, b: ClaudeCliMcpServer): boolean {
  return !!a && a.name === b.name && a.url === b.url && a.bearerToken === b.bearerToken;
}

function emitEvent(sinks: Array<((event: ClaudeCliEvent) => void) | undefined>, event: ClaudeCliEvent): void {
  for (const sink of sinks) {
    if (!sink) continue;
    try {
      sink(event);
    } catch (err) {
      console.error("[claudeCliRunner] onEvent failed (swallowed):", err instanceof Error ? err.message : String(err));
    }
  }
}

function reportToolUses(message: unknown, report: (event: ClaudeCliToolUseEvent) => void): void {
  const { id, content } = (message ?? {}) as { id?: unknown; content?: unknown };
  if (typeof id !== "string" || !Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
    try {
      report({ messageId: id, toolUseId: block.id, name: typeof block.name === "string" ? block.name : "" });
    } catch (err) {
      console.error("[claudeCliRunner] onToolUse failed (swallowed):", err instanceof Error ? err.message : String(err));
    }
  }
}

function mcpStatus(servers: unknown, name: string): string | undefined {
  if (!Array.isArray(servers)) return undefined;
  const entry = servers.find((server) => server && typeof server === "object" && (server as any).name === name);
  return typeof (entry as any)?.status === "string" ? (entry as any).status : undefined;
}

function buildArgs(systemPromptFile: string, opts: ClaudeCliRunnerOptions, mcpConfigFile?: string): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt-file",
    systemPromptFile,
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "",
    // Hook lifecycle events are alarms for the host: an organization can deliver hooks that
    // run in `-p` sessions, and only SessionStart/Setup events are printed without this flag.
    "--include-hook-events",
    // Conversations stay in Emma's own transcript; nothing is written under the login's home.
    "--no-session-persistence",
  ];
  if (opts.model) args.push("--model", opts.model);
  // --strict-mcp-config above already limits the session to exactly this file.
  if (mcpConfigFile) args.push("--mcp-config", mcpConfigFile);
  return args;
}

const defaultRunner = new ClaudeCliRunner();

export function spawn(
  conversationId: string,
  configDir: string,
  systemPromptFile: string,
  opts?: ClaudeCliRunnerOptions,
): Promise<ClaudeCliSessionHandle> {
  return defaultRunner.spawn(conversationId, configDir, systemPromptFile, opts);
}

export function send(handle: ClaudeCliSessionHandle, message: string, options?: ClaudeCliSendOptions): Promise<ClaudeCliTurnResult> {
  return defaultRunner.send(handle, message, options);
}

export function interrupt(handle: ClaudeCliSessionHandle): boolean {
  return defaultRunner.interrupt(handle);
}

export function terminate(handle: ClaudeCliSessionHandle): boolean {
  return defaultRunner.terminate(handle);
}

export function close(handle: ClaudeCliSessionHandle): void {
  defaultRunner.close(handle);
}

export function prewarm(
  conversationId: string,
  configDir: string,
  systemPromptFile: string,
  opts?: ClaudeCliRunnerOptions,
): Promise<ClaudeCliSessionHandle> {
  return defaultRunner.prewarm(conversationId, configDir, systemPromptFile, opts);
}

export function apiKeySourceFor(handle: ClaudeCliSessionHandle): string | undefined {
  return defaultRunner.apiKeySourceFor(handle);
}
