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
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface ClaudeCliRunnerOptions {
  /** Model alias or id, e.g. "haiku" | "sonnet" | "opus" | a full model id. Omit for the CLI's own default. */
  model?: string;
}

export interface ClaudeCliTurnResult {
  isError: boolean;
  resultText: string;
  /** The raw parsed `result`-type stream-json event, for callers that need fields this type doesn't surface yet. */
  raw: Record<string, unknown>;
}

export interface ClaudeCliSessionHandle {
  readonly conversationId: string;
}

interface PooledSession {
  conversationId: string;
  child: ChildProcessWithoutNullStreams;
  rl: Interface;
  scratchHomeDir: string;
  pending: { resolve: (result: ClaudeCliTurnResult) => void; reject: (err: Error) => void } | null;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
  /** From the session's `system`/`init` event — the ENG-2107 contract-test field. Undefined until init arrives. */
  apiKeySource: string | undefined;
}

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_PROCESSES = 8;

export class ClaudeCliRunner {
  private readonly pool = new Map<string, PooledSession>();
  private readonly spawnQueue: Array<() => void> = [];
  private readonly maxConcurrentProcesses: number;
  private readonly idleCloseMs: number;

  constructor(opts: { maxConcurrentProcesses?: number; idleCloseMs?: number } = {}) {
    this.maxConcurrentProcesses = opts.maxConcurrentProcesses ?? DEFAULT_MAX_CONCURRENT_PROCESSES;
    this.idleCloseMs = opts.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  }

  get activeProcessCount(): number {
    return this.pool.size;
  }

  /**
   * Returns the pooled session for conversationId, spawning a fresh process only if
   * none is open. Queues behind the concurrency cap when every slot is in use by a
   * different conversation.
   */
  async spawn(
    conversationId: string,
    configDir: string,
    systemPromptFile: string,
    opts: ClaudeCliRunnerOptions = {},
  ): Promise<ClaudeCliSessionHandle> {
    const existing = this.pool.get(conversationId);
    if (existing && !existing.closed) {
      this.scheduleIdleClose(existing);
      return { conversationId };
    }

    await this.waitForFreeSlot();

    const scratchHomeDir = mkdtempSync(join(tmpdir(), "claude-cli-home-"));
    const child = spawnChildProcess("claude", buildArgs(systemPromptFile, opts), {
      env: buildAllowlistedEnv(configDir, scratchHomeDir),
    });

    const session: PooledSession = {
      conversationId,
      child,
      rl: createInterface({ input: child.stdout }),
      scratchHomeDir,
      pending: null,
      idleTimer: null,
      closed: false,
      apiKeySource: undefined,
    };

    session.rl.on("line", (line) => this.handleLine(session, line));
    child.on("exit", () => this.closeSessionInternal(session, "process-exit"));
    child.on("error", (err) => {
      session.pending?.reject(err);
      session.pending = null;
      this.closeSessionInternal(session, "process-error");
    });

    this.pool.set(conversationId, session);
    this.scheduleIdleClose(session);
    return { conversationId };
  }

  /** Sends one turn to an already-open session and resolves on its terminal `result` event. */
  send(handle: ClaudeCliSessionHandle, message: string): Promise<ClaudeCliTurnResult> {
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
      session.pending = { resolve, reject };
      const line = JSON.stringify({ type: "user", message: { role: "user", content: message } });
      session.child.stdin.write(line + "\n");
    });
  }

  close(handle: ClaudeCliSessionHandle): void {
    const session = this.pool.get(handle.conversationId);
    if (session) this.closeSessionInternal(session, "explicit-close");
  }

  /**
   * The session's `system/init.apiKeySource` field — ENG-2107's own named contract
   * assertion. `undefined` until the init event has arrived (always before the first
   * `result`), or if the session isn't open.
   */
  apiKeySourceFor(handle: ClaudeCliSessionHandle): string | undefined {
    return this.pool.get(handle.conversationId)?.apiKeySource;
  }

  /** Closes every open session. For process shutdown and test teardown. */
  closeAll(): void {
    for (const session of [...this.pool.values()]) this.closeSessionInternal(session, "close-all");
  }

  private handleLine(session: PooledSession, line: string): void {
    if (!line.trim()) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // stray non-JSON stdout noise is not a valid event; ignore rather than crash the session
    }
    if (parsed.type === "system" && parsed.subtype === "init") {
      session.apiKeySource = typeof parsed.apiKeySource === "string" ? parsed.apiKeySource : undefined;
      return;
    }
    if (parsed.type !== "result" || !session.pending) return;
    const { resolve } = session.pending;
    session.pending = null;
    resolve({
      isError: parsed.is_error === true,
      resultText: typeof parsed.result === "string" ? parsed.result : "",
      raw: parsed,
    });
  }

  private scheduleIdleClose(session: PooledSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.closeSessionInternal(session, "idle"), this.idleCloseMs);
  }

  private closeSessionInternal(session: PooledSession, reason: string): void {
    if (session.closed) return;
    session.closed = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    this.pool.delete(session.conversationId);
    session.rl.close();
    session.child.kill();
    try {
      rmSync(session.scratchHomeDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of a throwaway scratch dir; nothing sensitive survives it anyway
    }
    if (session.pending) {
      session.pending.reject(new Error(`claudeCliRunner: session closed (${reason}) with a turn still in flight`));
      session.pending = null;
    }
    this.releaseSlotToQueue();
  }

  private async waitForFreeSlot(): Promise<void> {
    if (this.pool.size < this.maxConcurrentProcesses) return;
    return new Promise<void>((resolve) => this.spawnQueue.push(resolve));
  }

  private releaseSlotToQueue(): void {
    const next = this.spawnQueue.shift();
    if (next) next();
  }
}

function buildAllowlistedEnv(configDir: string, scratchHomeDir: string): NodeJS.ProcessEnv {
  const path = process.env.PATH;
  if (!path) throw new Error("claudeCliRunner: PATH is not set in the parent process — cannot resolve the claude binary");
  return {
    PATH: path,
    HOME: scratchHomeDir,
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
  };
}

function buildArgs(systemPromptFile: string, opts: ClaudeCliRunnerOptions): string[] {
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
  ];
  if (opts.model) args.push("--model", opts.model);
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

export function send(handle: ClaudeCliSessionHandle, message: string): Promise<ClaudeCliTurnResult> {
  return defaultRunner.send(handle, message);
}

export function close(handle: ClaudeCliSessionHandle): void {
  defaultRunner.close(handle);
}

export function apiKeySourceFor(handle: ClaudeCliSessionHandle): string | undefined {
  return defaultRunner.apiKeySourceFor(handle);
}
