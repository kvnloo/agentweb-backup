/**
 * ENG-2113 PR C: the cancel path for a Claude Code turn running in the MAIN process.
 *
 * Emma's turn runs in a forked worker and is stopped through `generateMarketingResponseWorkerService.cancelSession(sessionId)` + the
 * `sseProgress` flag. A Claude turn runs in main, where nothing reads that flag, so it needs its own handle. This registry is it: one entry per
 * session with a running Claude turn, holding the two things that stop it, in the order they must happen:
 *   1. `refuseNewCalls()`: the bridge refuses every tool call not yet started (`bridge.cancelSession(owner, session)`), so a stopped turn cannot
 *      start another write while the host is still winding down;
 *   2. `abort()`: aborts the host turn (`turn.interrupt`, graceful after PR H).
 * Both are called synchronously from a Stop, a generation timeout, an auto-continuation preemption or a revoke; both must be quick and must not throw
 * (a throw from one never skips the other).
 *
 * Fail-closed on a second registration for the same session: the per-session generation lock should make that impossible, and if it ever
 * happens the NEW turn is refused rather than silently orphaning the running one (which could then never be stopped).
 *
 * A Stop that lands BEFORE `register` is not seen here. The backend re-checks `isCancelled(sessionId)` right after registering (the controller
 * clears the flag at the start of a turn, so a Stop in that window sets it again).
 */

export interface ClaudeRunHandle {
  /** Removes THIS entry only. Safe to call twice, and safe after a newer entry replaced it (it does not touch that one). */
  release(): void;
}

export interface ClaudeRunHooks {
  refuseNewCalls(): void;
  abort(): void;
}

interface Entry {
  sessionId: string;
  ownerUserId: string;
  connectionId: string;
  hooks: ClaudeRunHooks;
  cancelled: boolean;
}

export class ClaudeRunConflictError extends Error {
  constructor() {
    super("a claude turn is already running for this session");
    this.name = "ClaudeRunConflictError";
  }
}

export class ClaudeRunRegistry {
  private readonly bySession = new Map<string, Entry>();

  register(sessionId: string, ownerUserId: string, connectionId: string, hooks: ClaudeRunHooks): ClaudeRunHandle {
    if (this.bySession.has(sessionId)) throw new ClaudeRunConflictError();
    const entry: Entry = { sessionId, ownerUserId, connectionId, hooks, cancelled: false };
    this.bySession.set(sessionId, entry);
    return {
      release: () => {
        if (this.bySession.get(sessionId) === entry) this.bySession.delete(sessionId);
      },
    };
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  get size(): number {
    return this.bySession.size;
  }

  /** Stops the session's running Claude turn. False when there is none (an Emma turn, or nothing running): a safe no-op for every caller. */
  cancel(sessionId: string): boolean {
    const entry = this.bySession.get(sessionId);
    if (!entry) return false;
    this.stop(entry);
    return true;
  }

  /** Revoke / disable / kill switch: stops every running turn that uses this connection (A6). Returns how many. */
  cancelConnection(connectionId: string): number {
    let n = 0;
    for (const entry of [...this.bySession.values()]) {
      if (entry.connectionId === connectionId) {
        this.stop(entry);
        n++;
      }
    }
    return n;
  }

  /** The kill switch for a user: every running turn of that owner. */
  cancelOwner(ownerUserId: string): number {
    let n = 0;
    for (const entry of [...this.bySession.values()]) {
      if (entry.ownerUserId === ownerUserId) {
        this.stop(entry);
        n++;
      }
    }
    return n;
  }

  /** Process shutdown: stops every running Claude turn (so the host turns are interrupted before this process exits). Returns how many. */
  cancelAll(): number {
    let n = 0;
    for (const entry of [...this.bySession.values()]) {
      this.stop(entry);
      n++;
    }
    return n;
  }

  private stop(entry: Entry): void {
    if (entry.cancelled) return; // idempotent: a Stop and a timeout landing together act once
    entry.cancelled = true;
    for (const step of [entry.hooks.refuseNewCalls, entry.hooks.abort]) {
      try {
        step.call(entry.hooks);
      } catch (err) {
        console.error("[claude-run] cancel step failed (swallowed):", err instanceof Error ? err.message : String(err));
      }
    }
  }
}

/** The process-wide registry. Every cancel site reaches it through `cancelSession` (see generateMarketingResponseWorkerService). */
export const claudeRunRegistry = new ClaudeRunRegistry();
