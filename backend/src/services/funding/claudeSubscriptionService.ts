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
import { randomBytes, randomUUID } from "crypto";
import { watch, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type FSWatcher } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { AwsKmsPort, openSecret, sealSecret, type KmsPort } from "./llmConnectionCrypto";
import { LlmConnectionDb, type LlmConnectionRecord, type SubHealth } from "./llmConnectionDb";
import { CODE_PATTERN, LocalClaudeLoginRunner, LoginError, type LoginHandle, type LoginRunner } from "./claudeLoginRunner";
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
}

interface Pending {
  userId: string;
  handle: LoginHandle;
  reconnectConnectionId?: string;
  timer: NodeJS.Timeout;
  expiresAtMs: number;
}

export interface LoginContext {
  configDir: string;
  /** Aborts when the single live copy can no longer be guaranteed: stop the CLI at once. */
  signal: AbortSignal;
  connectionId: string;
}
export type LoginStatus = "ok" | "revoked" | "lost" | "save_failed";

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
    }
    if (this.starting.has(actor.userId)) throw new ClaudeSubscriptionError("busy");
    this.starting.add(actor.userId);
    try {
      await this.cancelFor(actor.userId);
      if (this.pending.size >= MAX_PENDING_LOGINS) throw new ClaudeSubscriptionError("too_many_logins");
      let handle: LoginHandle;
      try {
        handle = await this.deps.runner.start();
      } catch (err) {
        throw new ClaudeSubscriptionError(err instanceof LoginError && err.code === "start_timeout" ? "start_timeout" : "start_failed");
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
    this.pending.delete(loginId);
    clearTimeout(pending.timer);

    let text: string;
    try {
      text = await pending.handle.complete(code);
    } catch (err) {
      const c = err instanceof LoginError ? err.code : "start_failed";
      if (c === "complete_timeout") throw new ClaudeSubscriptionError("complete_timeout");
      if (c === "code_rejected" || c === "bad_code_format") throw new ClaudeSubscriptionError("code_rejected");
      throw new ClaudeSubscriptionError("bad_credentials");
    }
    const nowMs = this.deps.now();
    const { health } = parseCredentials(text, nowMs);
    const nowIso = new Date(nowMs).toISOString();

    if (pending.reconnectConnectionId) {
      const current = await this.deps.db.get(pending.reconnectConnectionId);
      if (!current || current.kind !== "claude_subscription" || current.ownerUserId !== actor.userId || current.revokedAt) throw new ClaudeSubscriptionError("not_found");
      const sealed = await sealSecret(this.deps.kms, text, loginCtx(current));
      const replaced = await this.deps.db.replaceSubCredentials(current.connectionId, { expectedVersion: current.subVersion ?? 1, sealed, health, nowMs, nowIso });
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
      subAccessExpiresAtMs: health.accessExpiresAtMs, subRefreshExpiresAtMs: health.refreshExpiresAtMs, subSavedAt: nowIso,
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
    if (!(await db.acquireSubLease(connectionId, owner, this.deps.now(), LEASE_MS))) throw new ClaudeSubscriptionError("busy");
    let confirmedUntil = this.deps.now() + LEASE_MS;
    const abort = new AbortController();
    const stop = (reason: string) => {
      if (!abort.signal.aborted) abort.abort(reason);
    };

    let record: LlmConnectionRecord | null;
    let text: string;
    try {
      record = await db.get(connectionId);
      if (!record || record.revokedAt || !record.sealed) throw new ClaudeSubscriptionError("not_found");
      text = await openSecret(kms, record.sealed, loginCtx(record));
    } catch (err) {
      await db.releaseSubLease(connectionId, owner).catch(() => undefined);
      throw err;
    }

    const root = this.deps.tmpRoot ?? tmpdir();
    const dir = mkdtempSync(join(root, HOME_DIR_PREFIX)); // 0700
    const configDir = join(dir, "cfg");
    mkdirSync(configDir, { mode: 0o700 });
    const credsPath = join(configDir, ".credentials.json");
    writeFileSync(credsPath, text, { mode: 0o600 });
    let version = record.subVersion ?? 1;
    writeFileSync(join(dir, MARKER), JSON.stringify({ connectionId, owner, version, ownerUserId: record.ownerUserId }), { mode: 0o600 });

    let lastText = text;
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
      for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
        try {
          const sealed = await sealSecret(kms, current, loginCtx(record!));
          const res = await db.saveSubCredentials(connectionId, { owner, expectedVersion: version, sealed, health, nowIso: new Date(this.deps.now()).toISOString() });
          if (res === "ok") {
            version += 1;
            lastText = current;
            saveFailed = false;
            confirmedUntil = Math.max(confirmedUntil, this.deps.now());
            return;
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

    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          if (await db.extendSubLease(connectionId, owner, this.deps.now(), LEASE_MS)) confirmedUntil = this.deps.now() + LEASE_MS;
          else {
            // Someone else holds it now, or it was revoked: stop the CLI before a second copy can refresh.
            leaseLost = true;
            stop("lease_lost");
            const now = await db.get(connectionId).catch(() => null);
            if (!now || now.revokedAt) lost = lost ?? "revoked";
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
      }
    }, WATCHDOG_MS);
    heartbeat.unref?.();
    watchdog.unref?.();

    let value: T | undefined;
    let thrown: unknown;
    let threw = false;
    try {
      value = await fn({ configDir, signal: abort.signal, connectionId });
    } catch (err) {
      threw = true;
      thrown = err;
    }
    clearInterval(heartbeat);
    clearInterval(watchdog);
    clearTimeout(debounce);
    watcher?.close();
    await enqueue();
    await queue;

    const status: LoginStatus = lost === "revoked" ? "revoked" : lost || leaseLost ? "lost" : saveFailed ? "save_failed" : "ok";
    if (saveFailed) {
      // The refreshed login exists only in this dir: keep it (private, 0700) and the lease,
      // so boot recovery can still save it, rather than wiping the only live copy.
      console.error(`[claude-subscription] save-back failed for connection=${connectionId}; keeping the login dir for recovery`);
    } else {
      rmSync(dir, { recursive: true, force: true });
      await db.releaseSubLease(connectionId, owner).catch(() => undefined);
    }
    if (threw) throw thrown;
    return { value: value as T, status };
  }

  /** The CLI itself said the stored login is dead. Conditional on the version the caller saw. */
  async reportDeadLogin(connectionId: string, version: number, reason: string): Promise<boolean> {
    return this.deps.db.markSubNeedsReconnect(connectionId, version, reason.slice(0, 64), new Date(this.deps.now()).toISOString());
  }

  /**
   * Boot recovery: a previous process may have died holding a refreshed login that never
   * reached the store. Try the compare-and-swap with the lease it recorded; wipe the dir
   * unless the store itself was unreachable.
   */
  async recoverOrphans(): Promise<{ saved: number; wiped: number; kept: number }> {
    const root = this.deps.tmpRoot ?? tmpdir();
    const out = { saved: 0, wiped: 0, kept: 0 };
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      if (!name.startsWith(HOME_DIR_PREFIX)) continue;
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as { connectionId: string; owner: string; version: number; ownerUserId: string };
        const text = readFileSync(join(dir, "cfg", ".credentials.json"), "utf8");
        const { health } = parseCredentials(text, 0);
        const sealed = await sealSecret(this.deps.kms, text, loginCtx({ connectionId: marker.connectionId, ownerUserId: marker.ownerUserId }));
        const res = await this.deps.db.saveSubCredentials(marker.connectionId, { owner: marker.owner, expectedVersion: marker.version, sealed, health, nowIso: new Date(this.deps.now()).toISOString() });
        if (res === "ok") out.saved++;
        await this.deps.db.releaseSubLease(marker.connectionId, marker.owner).catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
        out.wiped++;
      } catch (err) {
        if ((err as { code?: string })?.code === "ENOENT" || err instanceof SyntaxError || err instanceof ClaudeSubscriptionError) {
          rmSync(dir, { recursive: true, force: true });
          out.wiped++;
        } else out.kept++; // the store was unreachable: keep the only copy for the next boot
      }
    }
    return out;
  }

  // ============================ expiry ============================
  /** Marks logins past their fixed refresh lifetime as expired, and counts those about to be. */
  async expiryPass(): Promise<{ expired: number; within7Days: number; within2Days: number }> {
    const nowMs = this.deps.now();
    const out = { expired: 0, within7Days: 0, within2Days: 0 };
    for (const r of await this.deps.db.listSubscriptions()) {
      if (r.revokedAt || r.status !== "active" || !r.subRefreshExpiresAtMs) continue;
      const left = r.subRefreshExpiresAtMs - nowMs;
      if (left < 0) {
        if (await this.deps.db.markSubExpired(r.connectionId, nowMs, new Date(nowMs).toISOString())) out.expired++;
      } else if (left < 2 * 86400_000) out.within2Days++;
      else if (left < 7 * 86400_000) out.within7Days++;
    }
    return out;
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
