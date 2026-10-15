/**
 * ENG-2110 (B3): connecting, holding and disconnecting a customer's Claude subscription
 * login, and the lease + compare-and-swap protocol that keeps exactly ONE live copy of it.
 *
 * Why one copy: every refresh rotates both tokens and refresh tokens are single-use
 * (verified live, finding-claude-login-refresh-rotation-single-use). Two processes
 * holding the same login means one of them kills it. So a login is only ever unsealed
 * under a lease, every change the CLI makes is written back at once (compare-and-swap on a
 * version), and the caller is told to stop the moment the lease or the version is lost.
 *
 * Owner-only: a Claude login is for its owner's ordinary use and is never shared with an
 * org. Delegated admin sessions may not run the ceremony (an admin's own Claude account
 * would end up stored under the customer).
 */
import { createHash, randomBytes, randomUUID } from "crypto";
import { watch, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type FSWatcher } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { AwsKmsPort, openSecret, sealSecret, type KmsPort } from "./llmConnectionCrypto";
import { LlmConnectionDb, type LlmConnectionRecord, type SubHealth } from "./llmConnectionDb";
import { CODE_PATTERN, LocalClaudeLoginRunner, LoginError, TMP_ROOT_PREFIX, sweepStaleLoginDirs, type LoginHandle, type LoginRunner } from "./claudeLoginRunner";
import { isClaudeSubscriptionEnabledFor } from "./fundingFlags";
import { MAX_ACTIVE_CONNECTIONS_PER_OWNER, type LlmConnectionView } from "./llmConnectionService";

export type SubscriptionErrorCode =
  | "disabled" | "forbidden" | "not_found" | "login_not_found" | "too_many_logins" | "bad_code_format" | "code_rejected"
  | "start_failed" | "start_timeout" | "complete_timeout" | "bad_credentials" | "limit_reached" | "busy" | "needs_reconnect" | "not_usable";

const HTTP: Record<SubscriptionErrorCode, number> = {
  disabled: 403, forbidden: 403, not_found: 404, login_not_found: 409, too_many_logins: 429, bad_code_format: 400, code_rejected: 400,
  start_failed: 502, start_timeout: 504, complete_timeout: 504, bad_credentials: 502, limit_reached: 409, busy: 409, needs_reconnect: 409, not_usable: 409,
};

export class ClaudeSubscriptionError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: SubscriptionErrorCode) {
    super(code);
    this.name = "ClaudeSubscriptionError";
    this.httpStatus = HTTP[code];
  }
}

export interface Actor {
  userId: string;
  adminId?: string;
}

export const LOGIN_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_LOGINS = 10;
export const LEASE_MS = 90_000;
export const HEARTBEAT_MS = 30_000;
/** The caller is stopped this long before the lease could lapse, to cover clock skew between instances. */
export const SKEW_MARGIN_MS = 10_000;
export const WATCHDOG_MS = 5_000;
export const SAVE_DEBOUNCE_MS = 200;
export const SAVE_ATTEMPTS = 3;
export const HOME_DIR_PREFIX = "aw-claude-home-";
/** After an abort, how long the caller gets to stop its CLI before withLogin stops waiting for it. */
export const ABORT_GRACE_MS = 10_000;
/** When a save-back keeps failing, retry this often, for at most this long, while still holding the lease. */
export const PERSIST_RETRY_MS = 5_000;
export const PERSIST_MAX_MS = 10 * 60 * 1000;
/** How long the "was it revoked?" read may take before the run just ends as lost. */
export const WHY_LOST_TIMEOUT_MS = 3_000;
/** A recovery pass leaves a login dir younger than this alone if its marker is missing (it is still being set up). */
export const YOUNG_DIR_MS = 60_000;
/** A login dir recorded by another host is left alone this long, then treated as abandoned. */
export const FOREIGN_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MARKER = "marker.json";

export interface ParsedLogin {
  health: SubHealth;
}

/** Reads only what a valid Claude login must contain; never returns or logs the tokens. */
export function parseCredentials(text: string, nowMs: number): ParsedLogin {
  let o: any;
  try {
    o = JSON.parse(text)?.claudeAiOauth;
  } catch {
    throw new ClaudeSubscriptionError("bad_credentials");
  }
  const ok =
    o && typeof o === "object" && typeof o.accessToken === "string" && o.accessToken && typeof o.refreshToken === "string" && o.refreshToken &&
    Number.isFinite(o.expiresAt) && Number.isFinite(o.refreshTokenExpiresAt) && o.refreshTokenExpiresAt > nowMs;
  if (!ok) throw new ClaudeSubscriptionError("bad_credentials");
  return {
    health: {
      type: typeof o.subscriptionType === "string" && o.subscriptionType ? o.subscriptionType : "unknown",
      tier: typeof o.rateLimitTier === "string" ? o.rateLimitTier : "",
      accessExpiresAtMs: o.expiresAt,
      refreshExpiresAtMs: o.refreshTokenExpiresAt,
    },
  };
}

export interface ClaudeSubscriptionDeps {
  db: LlmConnectionDb;
  kms: KmsPort;
  runner: LoginRunner;
  isEnabledFor: (userId: string) => Promise<boolean>;
  now: () => number;
  newId: () => string;
  newToken: () => string;
  tmpRoot?: string;
  abortGraceMs?: number;
  persistRetryMs?: number;
  persistMaxMs?: number;
}

interface Pending {
  userId: string;
  handle: LoginHandle;
  reconnectConnectionId?: string;
  timer: NodeJS.Timeout;
  expiresAtMs: number;
}

export interface LoginContext {
  /** The stored version the CLI's changes build on (needed for `reportDeadLogin`). Moves up after each save-back. */
  version: () => number;
  configDir: string;
  /** Aborts when the single live copy can no longer be guaranteed: stop the CLI at once. */
  signal: AbortSignal;
  connectionId: string;
}
export type LoginStatus = "ok" | "revoked" | "lost" | "save_failed";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function loginCtx(r: Pick<LlmConnectionRecord, "connectionId" | "ownerUserId">) {
  return { connectionId: r.connectionId, ownerUserId: r.ownerUserId, provider: "anthropic", purpose: "claude_login" };
}

function viewOf(r: LlmConnectionRecord, callerId: string): LlmConnectionView {
  return {
    connectionId: r.connectionId,
    ownerUserId: r.ownerUserId,
    kind: r.kind,
    provider: r.provider,
    status: r.status,
    keyLast4: "",
    createdAt: r.createdAt,
    health: r.subRefreshExpiresAtMs ? { expiresAt: new Date(r.subRefreshExpiresAtMs).toISOString() } : {},
    ownedByCaller: r.ownerUserId === callerId,
    subscription: { ...(r.subType ? { plan: r.subType } : {}), needsReconnect: r.subNeedsReconnect === true },
  };
}

export class ClaudeSubscriptionService {
  private readonly pending = new Map<string, Pending>();
  private readonly starting = new Set<string>();
  private readonly activeDirs = new Set<string>();
  /** Runs live in THIS process, so a revoke here can stop them at once (another instance's holder notices at its next heartbeat). */
  private readonly runs = new Map<string, Set<(reason: string) => void>>();
  private reserved = 0;

  constructor(private readonly deps: ClaudeSubscriptionDeps) {}

  private async requireEnabled(userId: string): Promise<void> {
    if (!(await this.deps.isEnabledFor(userId))) throw new ClaudeSubscriptionError("disabled");
  }

  // ============================== the ceremony ==============================
  async startLogin(actor: Actor, input: { reconnectConnectionId?: string } = {}): Promise<{ loginId: string; authorizeUrl: string; expiresAt: string }> {
    if (actor.adminId) throw new ClaudeSubscriptionError("forbidden");
    await this.requireEnabled(actor.userId);
    if (input.reconnectConnectionId) {
      const target = await this.deps.db.get(input.reconnectConnectionId);
      if (!target || target.kind !== "claude_subscription" || target.ownerUserId !== actor.userId || target.revokedAt) throw new ClaudeSubscriptionError("not_found");
      // Do not spend the user's one-time code on a sign-in that cannot be applied right now.
      if ((target.subLeaseUntil ?? 0) > this.deps.now()) throw new ClaudeSubscriptionError("busy");
    }
    if (this.starting.has(actor.userId)) throw new ClaudeSubscriptionError("busy");
    this.starting.add(actor.userId);
    try {
      await this.cancelFor(actor.userId);
      // The slot is reserved before the (slow) CLI start, so concurrent starts cannot overshoot the cap.
      if (this.pending.size + this.reserved >= MAX_PENDING_LOGINS) throw new ClaudeSubscriptionError("too_many_logins");
      this.reserved++;
      let handle: LoginHandle;
      try {
        handle = await this.deps.runner.start();
      } catch (err) {
        throw new ClaudeSubscriptionError(err instanceof LoginError && err.code === "start_timeout" ? "start_timeout" : "start_failed");
      } finally {
        this.reserved--;
      }
      const loginId = randomBytes(16).toString("hex");
      const expiresAtMs = this.deps.now() + LOGIN_TTL_MS;
      const timer = setTimeout(() => void this.expire(loginId), LOGIN_TTL_MS);
      timer.unref?.();
      this.pending.set(loginId, { userId: actor.userId, handle, reconnectConnectionId: input.reconnectConnectionId, timer, expiresAtMs });
      return { loginId, authorizeUrl: handle.authorizeUrl, expiresAt: new Date(expiresAtMs).toISOString() };
    } finally {
      this.starting.delete(actor.userId);
    }
  }

  async completeLogin(actor: Actor, loginId: string, code: unknown): Promise<LlmConnectionView> {
    if (actor.adminId) throw new ClaudeSubscriptionError("forbidden");
    await this.requireEnabled(actor.userId);
    const pending = typeof loginId === "string" ? this.pending.get(loginId) : undefined;
    // Same answer for "unknown", "expired" and "someone else's": a wrong caller never cancels the real login.
    if (!pending || pending.userId !== actor.userId) throw new ClaudeSubscriptionError("login_not_found");
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw new ClaudeSubscriptionError("bad_code_format");
    if (pending.reconnectConnectionId) {
      // A turn may have started since the sign-in began: say so BEFORE the one-time code is spent.
      const target = await this.deps.db.get(pending.reconnectConnectionId);
      if (target && (target.subLeaseUntil ?? 0) > this.deps.now()) throw new ClaudeSubscriptionError("busy");
    }
    this.pending.delete(loginId);
    clearTimeout(pending.timer);

    let text: string;
    try {
      text = await pending.handle.complete(code);
    } catch (err) {
      const c = err instanceof LoginError ? err.code : "start_failed";
      if (c === "complete_timeout") throw new ClaudeSubscriptionError("complete_timeout");
      if (c === "code_rejected" || c === "bad_code_format") throw new ClaudeSubscriptionError("code_rejected");
      // The CLI went away before the code arrived (a deploy, a restart, a cancel): start again.
      if (c === "cancelled" || c === "login_gone") throw new ClaudeSubscriptionError("login_not_found");
      throw new ClaudeSubscriptionError("bad_credentials");
    }
    const nowMs = this.deps.now();
    const { health } = parseCredentials(text, nowMs);
    const nowIso = new Date(nowMs).toISOString();

    if (pending.reconnectConnectionId) {
      const current = await this.deps.db.get(pending.reconnectConnectionId);
      if (!current || current.kind !== "claude_subscription" || current.ownerUserId !== actor.userId || current.revokedAt) throw new ClaudeSubscriptionError("not_found");
      const sealed = await sealSecret(this.deps.kms, text, loginCtx(current));
      const replaced = await this.deps.db.replaceSubCredentials(current.connectionId, { expectedVersion: current.subVersion ?? 1, sealed, health, nowMs, nowIso, contentHash: sha256(text) });
      if (!replaced) throw new ClaudeSubscriptionError("busy");
      console.log(`[claude-subscription] reconnected connection=${current.connectionId} instance=${hostname()}`);
      return viewOf((await this.deps.db.get(current.connectionId))!, actor.userId);
    }

    const connectionId = this.deps.newId();
    const sealed = await sealSecret(this.deps.kms, text, loginCtx({ connectionId, ownerUserId: actor.userId }));
    const record: LlmConnectionRecord = {
      connectionId, ownerUserId: actor.userId, kind: "claude_subscription", provider: "anthropic", status: "active", keyLast4: "",
      createdAt: nowIso, updatedAt: nowIso, sealed,
      subVersion: 1, subNeedsReconnect: false, subType: health.type, subTier: health.tier,
      subAccessExpiresAtMs: health.accessExpiresAtMs, subRefreshExpiresAtMs: health.refreshExpiresAtMs, subSavedAt: nowIso, subContentHash: sha256(text),
    };
    if (!(await this.deps.db.createWithinLimit(record, MAX_ACTIVE_CONNECTIONS_PER_OWNER))) throw new ClaudeSubscriptionError("limit_reached");
    console.log(`[claude-subscription] connected connection=${connectionId} instance=${hostname()}`);
    return viewOf(record, actor.userId);
  }

  async cancelLogin(actor: Actor, loginId: string): Promise<void> {
    const pending = this.pending.get(loginId);
    if (!pending || pending.userId !== actor.userId) return; // nothing to say about someone else's
    await this.expire(loginId);
  }

  private async cancelFor(userId: string): Promise<void> {
    for (const [id, p] of [...this.pending]) if (p.userId === userId) await this.expire(id);
  }

  private async expire(loginId: string): Promise<void> {
    const p = this.pending.get(loginId);
    if (!p) return;
    this.pending.delete(loginId);
    clearTimeout(p.timer);
    await p.handle.cancel().catch(() => undefined);
  }

  /** For shutdown: stop every pending CLI and wipe its dir. */
  async shutdown(): Promise<void> {
    for (const id of [...this.pending.keys()]) await this.expire(id);
  }

  pendingCount(): number {
    return this.pending.size;
  }

  // ===================== holding the single live copy (for B4) =====================
  /**
   * Runs `fn` with the customer's login unsealed in a private dir, under the lease.
   * Every change the CLI makes to the credentials file is written back at once
   * (compare-and-swap). `fn` must stop its CLI when `signal` aborts. Resolves with how it ended.
   */
  async withLogin<T>(connectionId: string, forUserId: string, fn: (ctx: LoginContext) => Promise<T>): Promise<{ value: T; status: LoginStatus }> {
    const { cronJobRegistry } = require("../../utils/cronJobRegistry") as typeof import("../../utils/cronJobRegistry");
    return cronJobRegistry.track("ClaudeSubscriptionTurn", this.withLoginInner(connectionId, forUserId, fn));
  }

  private async withLoginInner<T>(connectionId: string, forUserId: string, fn: (ctx: LoginContext) => Promise<T>): Promise<{ value: T; status: LoginStatus }> {
    const { db, kms } = this.deps;
    await this.requireEnabled(forUserId);
    const first = await db.get(connectionId);
    // Owner-only: not even an org owner can run turns on someone else's login.
    if (!first || first.kind !== "claude_subscription" || first.ownerUserId !== forUserId || first.revokedAt) throw new ClaudeSubscriptionError("not_found");
    if (first.subNeedsReconnect) throw new ClaudeSubscriptionError("needs_reconnect");
    if (first.status !== "active") throw new ClaudeSubscriptionError("not_usable");

    const owner = this.deps.newToken();
    const acquiredAt = this.deps.now();
    if (!(await db.acquireSubLease(connectionId, owner, acquiredAt, LEASE_MS))) throw new ClaudeSubscriptionError("busy");
    let confirmedUntil = acquiredAt + LEASE_MS;
    const abort = new AbortController();
    const stop = (reason: string) => {
      if (!abort.signal.aborted) abort.abort(reason);
    };
    let abortedAsRevoked = false;
    const onAbortRequest = (reason: string) => {
      if (reason === "revoked") abortedAsRevoked = true;
      stop(reason);
    };
    const registered = this.runs.get(connectionId) ?? new Set<(reason: string) => void>();
    registered.add(onAbortRequest);
    this.runs.set(connectionId, registered);
    const unregister = () => {
      registered.delete(onAbortRequest);
      if (registered.size === 0) this.runs.delete(connectionId);
    };

    // Everything between taking the lease and handing over to the caller is inside one try:
    // a failure here (disk full, bad blob) must neither leak a dir that may hold the login
    // nor keep the lease.
    let dir: string | undefined;
    let record: LlmConnectionRecord | null;
    let text: string;
    let configDir: string;
    let credsPath: string;
    try {
      record = await db.get(connectionId);
      if (!record || record.revokedAt || !record.sealed) throw new ClaudeSubscriptionError("not_found");
      text = await openSecret(kms, record.sealed, loginCtx(record));
      dir = mkdtempSync(join(this.deps.tmpRoot ?? tmpdir(), HOME_DIR_PREFIX)); // 0700
      configDir = join(dir, "cfg");
      mkdirSync(configDir, { mode: 0o700 });
      credsPath = join(configDir, ".credentials.json");
      writeFileSync(credsPath, text, { mode: 0o600 });
      var runDir: string = dir;
      var version: number = record.subVersion ?? 1;
      var writeMarker = () =>
        writeFileSync(join(runDir, MARKER), JSON.stringify({ connectionId, owner, version, ownerUserId: record!.ownerUserId, pid: process.pid, host: hostname() }), { mode: 0o600 });
      writeMarker();
      this.activeDirs.add(runDir);
    } catch (err) {
      unregister();
      this.activeDirs.delete(dir ?? "");
      if (dir) rmSync(dir, { recursive: true, force: true });
      await db.releaseSubLease(connectionId, owner).catch(() => undefined);
      throw err;
    }

    let lastText = text;
    /** Content hashes of every save attempted in this run: a lost response from ANY may have committed. */
    const attemptedHashes = new Set<string>();
    let lost: "stale" | "revoked" | undefined;
    let leaseLost = false;
    let saveFailed = false;
    let queue: Promise<void> = Promise.resolve();

    const trySave = async (): Promise<void> => {
      if (lost) return;
      let current: string;
      try {
        current = readFileSync(credsPath, "utf8");
      } catch {
        return;
      }
      if (current === lastText) return;
      let health: SubHealth;
      try {
        health = parseCredentials(current, 0).health; // a half-written file is skipped, not saved
      } catch {
        return;
      }
      const hash = sha256(current);
      const succeeded = (newVersion: number = version + 1) => {
        version = newVersion;
        lastText = current;
        saveFailed = false;
        confirmedUntil = Math.max(confirmedUntil, this.deps.now());
        try {
          writeMarker(); // recovery must start from the version we now hold
        } catch {
          console.error(`[claude-subscription] could not update the recovery marker for connection=${connectionId}`);
        }
      };
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
        const nowIso = new Date(this.deps.now()).toISOString();
        attemptedHashes.add(hash);
        try {
          const sealed = await sealSecret(kms, current, loginCtx(record!));
          const res = await db.saveSubCredentials(connectionId, { owner, expectedVersion: version, sealed, health, nowIso, contentHash: hash });
          if (res === "ok") return succeeded();
          if (res === "stale") {
            // An earlier attempt may have committed although its response never arrived. A stored copy that is
            // held by us, newer than our version, and has content WE tried to save in this run is our own write.
            // A failed read here throws into the retry path below: a transient error must never be read as "lost".
            const cur = await db.get(connectionId);
            if (cur && !cur.revokedAt && cur.subLeaseOwner === owner && cur.subVersion !== undefined && cur.subVersion > version && attemptedHashes.has(cur.subContentHash ?? "")) {
              if (cur.subContentHash === hash) return succeeded(cur.subVersion); // exactly this content: done
              // An OLDER refresh of ours landed. Build on it: the newest content still has to go in, on top.
              version = cur.subVersion;
              try {
                writeMarker();
              } catch {
                /* recovery retries against the stored version */
              }
              continue;
            }
          }
          lost = res;
          stop(res === "revoked" ? "revoked" : "lease_or_version_lost");
          return;
        } catch {
          saveFailed = true;
          if (attempt < SAVE_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * attempt));
        }
      }
    };
    const enqueue = (): Promise<void> => (queue = queue.then(trySave, trySave));

    let debounce: NodeJS.Timeout | undefined;
    let watcher: FSWatcher | undefined;
    try {
      watcher = watch(configDir, { persistent: false }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => void enqueue(), SAVE_DEBOUNCE_MS);
        debounce.unref?.();
      });
      watcher.on("error", () => undefined);
    } catch {
      /* the final save below still covers it */
    }

    // Why the lease was lost (revoked or not) is read separately and with a deadline, and the final status waits for it,
    // so a hung read can delay the answer but never the stop.
    let whyLost: Promise<void> | undefined;
    let whyLostAnswered = false;
    const lookUpWhyLost = () => {
      whyLost ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const now = await Promise.race([
            db.get(connectionId),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("timeout")), WHY_LOST_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
          whyLostAnswered = true;
          if (!now || now.revokedAt) lost = lost ?? "revoked";
        } catch {
          /* unknown, not revoked: the lease loss alone already stopped the caller */
        } finally {
          clearTimeout(timer);
          if (!whyLostAnswered) whyLost = undefined; // a lookup that did not get an answer may be tried again
        }
      })();
    };
    /** Settles the "was it revoked?" question before a status is computed: waits for the lookup, and asks once more if it never got an answer. */
    const settleWhyLost = async () => {
      await whyLost;
      if (leaseLost && !whyLostAnswered && lost === undefined) {
        lookUpWhyLost();
        await whyLost;
      }
    };

    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const requestedAt = this.deps.now(); // the lease runs from when we asked, not from when the answer came back
          if (await db.extendSubLease(connectionId, owner, requestedAt, LEASE_MS)) confirmedUntil = requestedAt + LEASE_MS;
          else {
            // Someone else holds it now, or it was revoked: stop the CLI before a second copy can refresh.
            leaseLost = true;
            stop("lease_lost"); // never wait on a read before stopping the caller
            lookUpWhyLost();
          }
        } catch {
          /* the watchdog decides */
        }
      })();
    }, HEARTBEAT_MS);
    const watchdog = setInterval(() => {
      if (this.deps.now() > confirmedUntil - SKEW_MARGIN_MS) {
        leaseLost = true;
        stop("lease_unconfirmed");
        lookUpWhyLost();
      }
    }, WATCHDOG_MS);
    heartbeat.unref?.();
    watchdog.unref?.();
    const stopTimers = () => {
      clearInterval(heartbeat);
      clearInterval(watchdog);
      unregister();
    };
    const wipe = () => {
      this.activeDirs.delete(runDir);
      rmSync(runDir, { recursive: true, force: true });
    };

    // Run the caller. If the lease is lost the caller is told to stop (signal); if it does not, we
    // stop waiting for it after a grace period rather than hang with the dir and lease dangling.
    const grace = this.deps.abortGraceMs ?? ABORT_GRACE_MS;
    let graceTimer: NodeJS.Timeout | undefined;
    const graceExpired = new Promise<{ kind: "grace" }>((resolve) => {
      abort.signal.addEventListener("abort", () => {
        graceTimer = setTimeout(() => resolve({ kind: "grace" }), grace);
        graceTimer.unref?.();
      });
    });
    const fnPromise = (async () => fn({ configDir, signal: abort.signal, connectionId, version: () => version }))().then(
      (value) => ({ kind: "done" as const, value }),
      (error) => ({ kind: "threw" as const, error }),
    );
    const outcome = await Promise.race([fnPromise, graceExpired]);
    clearTimeout(graceTimer);
    clearTimeout(debounce);
    watcher?.close();

    if (outcome.kind === "grace") {
      // The caller ignored the abort. Do not wait for it. Save what is there, wipe, and leave the
      // lease to lapse (it is not released: a CLI that is still running may hold the live copy).
      void fnPromise.catch(() => undefined);
      await enqueue();
      await queue;
      await settleWhyLost();
      stopTimers();
      wipe();
      console.error(`[claude-subscription] caller ignored the abort for connection=${connectionId}; stopped waiting, lease left to lapse`);
      return { value: undefined as T, status: lost === "revoked" || abortedAsRevoked ? "revoked" : "lost" };
    }

    await enqueue();
    await queue;
    await settleWhyLost();
    const status: LoginStatus = lost === "revoked" || abortedAsRevoked ? "revoked" : lost || leaseLost ? "lost" : saveFailed ? "save_failed" : "ok";
    if (status === "save_failed") {
      // The refreshed login exists only in this dir. Keep the lease alive and keep trying in the
      // background until the save lands, the connection is revoked, or we give up (then boot recovery).
      const { cronJobRegistry } = require("../../utils/cronJobRegistry") as typeof import("../../utils/cronJobRegistry");
      const retryMs = this.deps.persistRetryMs ?? PERSIST_RETRY_MS;
      const until = this.deps.now() + (this.deps.persistMaxMs ?? PERSIST_MAX_MS);
      console.error(`[claude-subscription] save-back failed for connection=${connectionId}; retrying in the background`);
      void cronJobRegistry
        .track(
          "ClaudeSubscriptionPersist",
          (async () => {
            while (saveFailed && !lost && this.deps.now() < until) {
              await new Promise((r) => setTimeout(r, retryMs));
              await enqueue();
              await queue;
            }
            stopTimers();
            if (saveFailed && !lost) {
              console.error(`[claude-subscription] giving up on save-back for connection=${connectionId}; the login stays in its private dir for boot recovery`);
              this.activeDirs.delete(runDir); // no longer a live run: a recovery pass may take it
              return; // dir kept on purpose: it is the only copy
            }
            if (lost === "stale") console.error(`[claude-subscription] lost the live copy of connection=${connectionId} while the store was unreachable; the customer may need to sign in again`);
            wipe();
            await db.releaseSubLease(connectionId, owner).catch(() => undefined);
          })(),
        )
        .catch(() => undefined);
    } else {
      stopTimers();
      wipe();
      await db.releaseSubLease(connectionId, owner).catch(() => undefined);
    }
    if (outcome.kind === "threw") throw outcome.error;
    return { value: outcome.value, status };
  }

  /**
   * The connection was just revoked: stop any run on it in this process now, rather than at the next
   * heartbeat. The run ends as "revoked" and its dir is wiped.
   */
  abortConnection(connectionId: string): void {
    for (const stop of [...(this.runs.get(connectionId) ?? [])]) stop("revoked");
  }

  /** The CLI itself said the stored login is dead. Conditional on the version the caller saw. */
  async reportDeadLogin(connectionId: string, version: number, reason: string): Promise<boolean> {
    return this.deps.db.markSubNeedsReconnect(connectionId, version, reason.slice(0, 64), new Date(this.deps.now()).toISOString());
  }

  /**
   * Boot recovery: a previous process may have died holding a refreshed login that never
   * reached the store. Try the compare-and-swap with the lease and the latest version it
   * recorded; wipe the dir unless the store was unreachable. Never touches a dir whose
   * recording process is still alive. Also removes sign-in dirs a dead process left behind.
   */
  async recoverOrphans(): Promise<{ saved: number; wiped: number; kept: number }> {
    const root = this.deps.tmpRoot ?? tmpdir();
    const out = { saved: 0, wiped: 0, kept: 0 };
    sweepStaleLoginDirs(root, this.deps.now());
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      if (!name.startsWith(HOME_DIR_PREFIX)) continue;
      const dir = join(root, name);
      if (this.activeDirs.has(dir)) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
        const marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { connectionId: string; owner: string; version: number; ownerUserId: string; pid?: number; host?: string };
        // Another machine's dir (or another live process's) is not ours to touch; a very old one is wiped regardless.
        const ageMs = this.deps.now() - statSync(dir).mtimeMs;
        if (marker.host && marker.host !== hostname() && ageMs < FOREIGN_DIR_MAX_AGE_MS) continue;
        if (marker.pid && marker.pid !== process.pid && (!marker.host || marker.host === hostname()) && pidAlive(marker.pid)) continue;
        const text = readFileSync(join(dir, "cfg", ".credentials.json"), "utf8");
        const { health } = parseCredentials(text, 0);
        const sealed = await sealSecret(this.deps.kms, text, loginCtx({ connectionId: marker.connectionId, ownerUserId: marker.ownerUserId }));
        let expectedVersion = marker.version;
        for (let attempt = 0; attempt < 2; attempt++) {
          const res = await this.deps.db.saveSubCredentials(marker.connectionId, { owner: marker.owner, expectedVersion, sealed, health, nowIso: new Date(this.deps.now()).toISOString(), contentHash: sha256(text) });
          if (res === "ok") {
            out.saved++;
            break;
          }
          if (res !== "stale") break;
          // The marker may lag one save behind the store: if the lease is still the recorded owner's, build on the stored version.
          const cur = await this.deps.db.get(marker.connectionId);
          // Only when the store is exactly one save ahead of the marker (a crash between a save and its marker
          // write) and the lease is still the recorded owner's. A reconnect clears the owner, so it is never overwritten.
          if (!cur || cur.revokedAt || cur.subLeaseOwner !== marker.owner || cur.subVersion !== expectedVersion + 1) break;
          expectedVersion = cur.subVersion;
        }
        await this.deps.db.releaseSubLease(marker.connectionId, marker.owner).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
        out.wiped++;
      } catch (err) {
        if ((err as { code?: string })?.code === "ENOENT" || err instanceof SyntaxError || err instanceof ClaudeSubscriptionError) {
          // A run still setting up has not written its marker yet: leave a young dir alone.
          try {
            if (this.deps.now() - statSync(dir).mtimeMs < YOUNG_DIR_MS) continue;
          } catch {
            continue;
          }
          rmSync(dir, { recursive: true, force: true });
          out.wiped++;
        } else out.kept++; // the store was unreachable: keep the only copy for the next boot
      }
    }
    return out;
  }

  // ============================ expiry ============================
  /** Marks logins past their fixed refresh lifetime as expired, and counts those about to be. */
  async expiryPass(): Promise<{ expired: number; within7Days: number; within2Days: number; soon: Array<{ connectionId: string; daysLeft: number }> }> {
    const nowMs = this.deps.now();
    const out = { expired: 0, within7Days: 0, within2Days: 0, soon: [] as Array<{ connectionId: string; daysLeft: number }> };
    for (const r of await this.deps.db.listSubscriptions()) {
      if (r.revokedAt || r.status !== "active" || !r.subRefreshExpiresAtMs) continue;
      const left = r.subRefreshExpiresAtMs - nowMs;
      if (left < 0) {
        if (await this.deps.db.markSubExpired(r.connectionId, nowMs, new Date(nowMs).toISOString())) out.expired++;
      } else if (left < 7 * 86400_000) {
        // Actionable: which connection, and how long it has left.
        out.soon.push({ connectionId: r.connectionId, daysLeft: Math.ceil(left / 86400_000) });
        if (left < 2 * 86400_000) out.within2Days++;
        else out.within7Days++;
      }
    }
    return out;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string })?.code === "EPERM";
  }
}

let defaultService: ClaudeSubscriptionService | null = null;
export function getClaudeSubscriptionService(): ClaudeSubscriptionService {
  if (!defaultService) {
    defaultService = new ClaudeSubscriptionService({
      db: new LlmConnectionDb(),
      kms: new AwsKmsPort(),
      runner: new LocalClaudeLoginRunner(),
      isEnabledFor: isClaudeSubscriptionEnabledFor,
      now: () => Date.now(),
      newId: () => randomUUID(),
      newToken: () => randomBytes(16).toString("hex"),
    });
  }
  return defaultService;
}

/** Revoke hook: stops a run on this connection in this process. Does nothing if the service was never used. */
export function abortClaudeSubscriptionConnection(connectionId: string): void {
  defaultService?.abortConnection(connectionId);
}

/** Shutdown hook: stops any pending sign-in CLI and wipes its dir. Does nothing if the service was never used. */
export async function shutdownClaudeSubscriptionService(): Promise<void> {
  await defaultService?.shutdown();
}

/**
 * Boot hook: recover a refreshed login a previous process died holding, and clear leftover
 * sign-in dirs. Runs whatever the flag says (an orphan can outlive a flag change), but builds
 * nothing and touches no AWS service unless such a dir actually exists.
 */
export async function recoverClaudeSubscriptionOrphansAtBoot(root: string = tmpdir()): Promise<{ saved: number; wiped: number; kept: number } | null> {
  const present = existsSync(root) ? readdirSync(root).filter((n) => n.startsWith(HOME_DIR_PREFIX) || n.startsWith(TMP_ROOT_PREFIX)) : [];
  if (present.length === 0) return null;
  return getClaudeSubscriptionService().recoverOrphans();
}
