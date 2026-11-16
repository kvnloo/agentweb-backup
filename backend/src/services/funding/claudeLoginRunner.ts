/**
 * ENG-2110 (B3): runs the `claude auth login` ceremony in an isolated, throwaway login
 * dir. `start()` returns the authorize URL; `complete(code)` hands the one-time code to
 * the waiting process and returns the credentials file it wrote. Nothing here keeps a
 * credential: the dir is wiped on every path (success, wrong code, timeout, cancel).
 *
 * Verified live on the pinned CLI (2.1.294): over a plain pipe the URL appears in well
 * under a second; a wrong code makes the process exit 1 ("Login failed ... 400") in about
 * a second; a right one exits 0 and writes `.credentials.json` (+ `.claude.json`).
 *
 * The spawn uses the same allowlisted environment as the B1 runner (no backend env, so no
 * stray ANTHROPIC_* and no AWS keys). Output is parsed for the URL only and never logged.
 */
import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildAllowlistedEnv } from "./claudeCliRunner";
import { resolveClaudeBinary } from "./claudeBinary";
import { CODE_PATTERN, extractAuthorizeUrl, MAX_LOGIN_OUTPUT_CHARS } from "./claudeLoginParse";

export { resolveClaudeBinary };

export type LoginErrorCode = "start_failed" | "start_timeout" | "bad_code_format" | "code_rejected" | "complete_timeout" | "no_credentials" | "cancelled" | "login_gone";

export class LoginError extends Error {
  constructor(readonly code: LoginErrorCode) {
    super(`claude login failed (${code})`);
    this.name = "LoginError";
  }
}

export const START_TIMEOUT_MS = 30_000;
export const COMPLETE_TIMEOUT_MS = 30_000;
export const KILL_GRACE_MS = 2_000;
export const MAX_OUTPUT_CHARS = MAX_LOGIN_OUTPUT_CHARS;
/** The code is `<code>#<state>`: URL-safe characters only, bounded, no whitespace or control characters. */
export { CODE_PATTERN };
export const TMP_ROOT_PREFIX = "aw-claude-login-";
/** A pending sign-in lives at most 10 minutes; a login dir older than this is a leftover. */
export const STALE_LOGIN_DIR_MS = 30 * 60 * 1000;


/** Removes login dirs a dead process left behind (they may hold a freshly written credentials file). */
export function sweepStaleLoginDirs(root: string, nowMs: number = Date.now(), maxAgeMs: number = STALE_LOGIN_DIR_MS): number {
  let removed = 0;
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (!name.startsWith(TMP_ROOT_PREFIX)) continue;
    const dir = join(root, name);
    try {
      if (nowMs - statSync(dir).mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* raced with its owner */
    }
  }
  return removed;
}

export interface LoginHandle {
  authorizeUrl: string;
  /** Hands the code to the waiting CLI and returns the text of the `.credentials.json` it wrote. Single use. */
  complete(code: string): Promise<string>;
  /** Stops the CLI and wipes the dir. Safe to call at any time, more than once. */
  cancel(): Promise<void>;
}

export interface LoginRunner {
  start(): Promise<LoginHandle>;
}

export interface LocalLoginRunnerOptions {
  /** For tests: a stand-in for the `claude` binary. */
  command?: string;
  args?: string[];
  tmpRoot?: string;
  startTimeoutMs?: number;
  completeTimeoutMs?: number;
}


export class LocalClaudeLoginRunner implements LoginRunner {
  constructor(private readonly options: LocalLoginRunnerOptions = {}) {}

  async start(): Promise<LoginHandle> {
    const root = this.options.tmpRoot ?? tmpdir();
    const dir = mkdtempSync(join(root, TMP_ROOT_PREFIX)); // 0700
    const configDir = join(dir, "cfg");
    const homeDir = join(dir, "home");
    mkdirSync(configDir, { mode: 0o700 });
    mkdirSync(homeDir, { mode: 0o700 });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnChild(this.options.command ?? resolveClaudeBinary(), this.options.args ?? ["auth", "login"], {
        env: buildAllowlistedEnv(configDir, homeDir),
        stdio: ["pipe", "pipe", "pipe"],
        detached: false,
      });
    } catch {
      rmSync(dir, { recursive: true, force: true });
      throw new LoginError("start_failed");
    }

    let output = "";
    let exited = false;
    let exitCode: number | null = null;
    let wiped = false;
    const exitWaiters: Array<() => void> = [];
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      exitWaiters.splice(0).forEach((f) => f());
    });
    child.on("error", () => {
      exited = true;
      exitCode = -1;
      exitWaiters.splice(0).forEach((f) => f());
    });
    child.stdin.on("error", () => undefined);
    const onData = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const waitExit = (ms: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (exited) return resolve(true);
        const timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
        exitWaiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });

    const wipe = async (): Promise<void> => {
      if (wiped) return;
      wiped = true;
      if (!exited) {
        child.kill("SIGTERM");
        if (!(await waitExit(this.options.completeTimeoutMs ? Math.min(KILL_GRACE_MS, this.options.completeTimeoutMs) : KILL_GRACE_MS))) {
          child.kill("SIGKILL");
          await waitExit(KILL_GRACE_MS);
        }
      }
      rmSync(dir, { recursive: true, force: true });
    };

    // 1. wait for the authorize URL
    const startTimeout = this.options.startTimeoutMs ?? START_TIMEOUT_MS;
    const authorizeUrl = await new Promise<string | null>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const match = extractAuthorizeUrl(output);
        if (match) {
          clearInterval(poll);
          resolve(match);
        } else if (exited || Date.now() - started > startTimeout) {
          clearInterval(poll);
          resolve(null);
        }
      }, 25);
    });
    if (!authorizeUrl) {
      const timedOut = !exited;
      await wipe();
      throw new LoginError(timedOut ? "start_timeout" : "start_failed");
    }

    let used = false;
    return {
      authorizeUrl,
      cancel: wipe,
      complete: async (code: string): Promise<string> => {
        if (used) throw new LoginError("cancelled");
        used = true;
        try {
          if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw new LoginError("bad_code_format");
          // The CLI is gone already (it exited on its own, or the sign-in was cancelled): start again.
          if (exited) throw new LoginError("login_gone");
          child.stdin.write(`${code}\n`);
          const done = await waitExit(this.options.completeTimeoutMs ?? COMPLETE_TIMEOUT_MS);
          if (!done) throw new LoginError("complete_timeout");
          if (exitCode !== 0) throw new LoginError("code_rejected");
          try {
            // Read only after exit, so a half-written file is never seen.
            return readFileSync(join(configDir, ".credentials.json"), "utf8");
          } catch {
            throw new LoginError("no_credentials");
          }
        } finally {
          await wipe();
        }
      },
    };
  }
}
