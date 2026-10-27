/**
 * ENG-2110 PR 1c-ii/1d: connecting, reconnecting and disconnecting a customer's subscription login that lives on the LOGIN HOST.
 *
 * The login (tokens, credential file) exists only inside a per-customer home on the host and is touched only by the provider's own
 * CLI. This service never sees a token: it passes the one-time sign-in code through to the host and keeps a reference-only record
 * (`subHosted`, `subHostEpoch`, plan label, expiry, status). The code is in one request body, in no response and in no log line.
 *
 * Ordering rules (verified against the host, see brain evidence/drafts/pr1c-backend-design-v1.md):
 *  - Sign-in is two-phase: host `complete` -> backend creates the record (epoch 1) -> host `promote`. A record that cannot be
 *    created cancels the host attempt; a promote that cannot finish rolls the record back through the revoke path.
 *  - Reconnect moves the RECORD to epoch+1 first, then asks the host to promote epoch+1 (the host only accepts a strictly newer
 *    epoch for a swap and demands an exact match for turns, so the record must never be behind the host).
 *  - Disconnect never says "revoked" before the host does: the record goes `revoking` (slot released, fenced at epoch+1) and becomes
 *    `revoked` only when the host confirms the wipe (or has never heard of the connection). Until then the sweeper retries.
 */
import { randomBytes, randomUUID } from "crypto";
import { ZodError } from "zod";
import { isClaudeSubscriptionEnabledFor } from "./fundingFlags";
import type { LlmConnectionKind } from "./llmConnection";
import { LlmConnectionDb, type LlmConnectionRecord } from "./llmConnectionDb";
import { MAX_ACTIVE_CONNECTIONS_PER_OWNER, toView, type Actor, type LlmConnectionView } from "./llmConnectionService";
import type { LoginReady } from "../../loginHost/connectionManager";
import { LoginHostClient, LoginHostError, UnixSocketTransport } from "./loginHostClient";
import { getLoginHostProvider } from "./loginHostProvider";
import { PROTOCOL_VERSION } from "../../loginHost/protocol";
import { openSignInToken, sealSignInToken, signInKey } from "./hostedSignInToken";

export type HostedErrorCode =
  | "disabled" | "forbidden" | "not_found" | "unsupported_provider" | "login_not_found" | "too_many_logins" | "bad_code_format"
  | "code_rejected" | "start_failed" | "complete_timeout" | "limit_reached" | "busy" | "host_unavailable";

const HTTP: Record<HostedErrorCode, number> = {
  disabled: 403, forbidden: 403, not_found: 404, unsupported_provider: 404, login_not_found: 409, too_many_logins: 429, bad_code_format: 400,
  code_rejected: 400, start_failed: 502, complete_timeout: 504, limit_reached: 409, busy: 409, host_unavailable: 503,
};

export class HostedSubscriptionError extends Error {
  readonly httpStatus: number;
  constructor(readonly code: HostedErrorCode) {
    super(code);
    this.name = "HostedSubscriptionError";
    this.httpStatus = HTTP[code];
  }
}

export interface HostedProvider {
  /** The `:provider` path segment. */
  route: string;
  kind: LlmConnectionKind;
  /** `provider` on the stored record (what listByProvider indexes). */
  recordProvider: string;
  /** The adapter id on the login host. */
  hostProvider: string;
  isEnabledFor: (userId: string) => Promise<boolean>;
}

export const HOSTED_PROVIDERS: Record<string, HostedProvider> = {
  claude: { route: "claude", kind: "claude_subscription", recordProvider: "anthropic", hostProvider: "claude", isEnabledFor: isClaudeSubscriptionEnabledFor },
};

export const LOGIN_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_LOGINS = 20;
export const PROMOTE_ATTEMPTS = 3;
export const PROMOTE_RETRY_MS = 300;
/** After this many failed revoke passes the sweeper logs an error every pass (a customer's login may still sit on the host). */
export const REVOKE_ALARM_ATTEMPTS = 10;
/** The sweeper does not judge a row written more recently than this (its own sign-in/reconnect may still be completing). */
export const RECONCILE_GRACE_MS = 2 * 60 * 1000;

export interface HostedSubscriptionDeps {
  db: LlmConnectionDb;
  /** Undefined when no login host is configured: every host-touching call answers `host_unavailable`. */
  client: () => LoginHostClient | undefined;
  providers?: Record<string, HostedProvider>;
  now: () => number;
  newId: () => string;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Whether the worker has been verified to speak this build's protocol (the provider's `host.info` check). "No such connection" (ENOTFOUND)
   * is taken to mean "nothing to wipe / the host lost it" ONLY then: an older worker that lacks a route used to answer ENOTFOUND for it, which
   * must never be read as "already wiped". Default: trusted (single-box test environments, unit tests).
   */
  workerSpeaksOurProtocol?: () => boolean;
  /**
   * The protocol version the worker reported (undefined while unknown). Fields added in protocol 3 (completion nonce, cancel-only-if-pending) are sent only to a
   * worker that reports 3 or more: an older worker refuses unknown fields, which would make every complete fail. Default: trusted (single-box test environments, unit tests).
   */
  workerProtocol?: () => number | undefined;
  /**
   * Called once the record is fenced for revocation (before the host is asked to wipe it): the caller stops every running turn of THIS process that
   * uses the connection, so a tool call cannot start under a login the user just disconnected. Never throws into the revoke; a failure is logged.
   * Turns running in another process are caught by the bridge's per-write liveness check.
   */
  onRevokeBegun?: (connectionId: string) => void;
}

interface Pending {
  userId: string;
  provider: HostedProvider;
  connectionId: string;
  loginRef: string;
  reconnect: boolean;
  /** Unset for a sign-in rebuilt from its token (it is held by no timer on this instance). */
  timer?: NodeJS.Timeout;
  expiresAtMs: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SweepResult {
  revoking: number;
  revoked: number;
  stuck: number;
  reconciled: number;
  markedNeedsReconnect: number;
  hostUnavailable: boolean;
}

export class HostedSubscriptionService {
  private readonly pending = new Map<string, Pending>();
  private readonly starting = new Set<string>();
  /** Sign-ins being completed by THIS instance: a double-submitted complete must not send the single-use code twice (the host also refuses it). */
  private readonly completing = new Set<string>();
  private readonly providers: Record<string, HostedProvider>;
  private sweeping: Promise<SweepResult> | undefined;

  constructor(private readonly deps: HostedSubscriptionDeps) {
    this.providers = deps.providers ?? HOSTED_PROVIDERS;
  }

  private provider(key: string): HostedProvider {
    const p = Object.prototype.hasOwnProperty.call(this.providers, key) ? this.providers[key] : undefined;
    if (!p) throw new HostedSubscriptionError("unsupported_provider");
    return p;
  }

  private host(): LoginHostClient {
    const c = this.deps.client();
    if (!c) throw new HostedSubscriptionError("host_unavailable");
    return c;
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private async owned(p: HostedProvider, userId: string, connectionId: string): Promise<LlmConnectionRecord> {
    const r = await this.deps.db.get(connectionId);
    // Same answer for "does not exist", "not yours" and "not a hosted login of this provider".
    if (!r || r.kind !== p.kind || r.ownerUserId !== userId || r.subHosted !== true || r.revokedAt) throw new HostedSubscriptionError("not_found");
    return r;
  }

  // ============================== the ceremony ==============================
  async startLogin(actor: Actor, providerKey: string, input: { reconnectConnectionId?: string } = {}): Promise<{ loginId: string; authorizeUrl: string; ceremony: "paste_code" | "device_code"; userCode?: string; expiresAt: string }> {
    const p = this.provider(providerKey);
    if (actor.adminId) throw new HostedSubscriptionError("forbidden");
    if (!(await p.isEnabledFor(actor.userId))) throw new HostedSubscriptionError("disabled");
    const client = this.host();
    let connectionId = this.deps.newId();
    if (input.reconnectConnectionId) {
      const target = await this.owned(p, actor.userId, input.reconnectConnectionId);
      if (target.status === "revoking" || target.status === "revoked") throw new HostedSubscriptionError("not_found");
      connectionId = target.connectionId;
    }
    if (this.starting.has(actor.userId)) throw new HostedSubscriptionError("busy");
    this.starting.add(actor.userId);
    try {
      await this.cancelFor(actor.userId);
      if (this.pending.size >= MAX_PENDING_LOGINS) throw new HostedSubscriptionError("too_many_logins");
      let started;
      try {
        // A record the host has lost (crash, wiped box) is reconnected as a NEW host connection: its promote epoch is still record epoch+1.
        let hostKnows = true;
        if (input.reconnectConnectionId) {
          hostKnows = await client.connectionStatus({ connectionId }).then(
            () => true,
            (err) => {
              if (err instanceof LoginHostError && err.code === "ENOTFOUND") return false;
              throw err;
            },
          );
        }
        started = await client.loginStart({ connectionId, provider: p.hostProvider, ...(input.reconnectConnectionId && hostKnows ? { reconnect: true } : {}) });
      } catch (err) {
        throw this.startError(err);
      }
      // The token and the local timer use the BACKEND's clock only: mixing in the host's absolute time would shrink every window by any clock difference between the
      // two machines, and the host enforces its own expiry anyway (an expired attempt answers login_not_found). The host's time only shortens what the user is shown.
      const expiresAtMs = this.deps.now() + LOGIN_TTL_MS;
      // Sealed so that ANY backend instance can finish this sign-in (a deploy replaces the instance that started it).
      let loginId: string;
      try {
        loginId = sealSignInToken({ userId: actor.userId, provider: p.route, connectionId, loginRef: started.loginRef, reconnect: !!input.reconnectConnectionId, expiresAtMs });
      } catch (err) {
        // No token, so nobody can ever complete this attempt: do not leave it on the host to block the next sign-in.
        await client.loginCancel({ connectionId, loginRef: started.loginRef }).catch(() => undefined);
        throw err;
      }
      const key = signInKey(connectionId, started.loginRef);
      const timer = setTimeout(() => void this.expire(key), Math.max(1_000, expiresAtMs - this.deps.now()));
      timer.unref?.();
      this.pending.set(key, { userId: actor.userId, provider: p, connectionId, loginRef: started.loginRef, reconnect: !!input.reconnectConnectionId, timer, expiresAtMs });
      return { loginId, authorizeUrl: started.url, ceremony: started.ceremony, ...(started.userCode ? { userCode: started.userCode } : {}), expiresAt: new Date(Math.min(started.expiresAtMs, expiresAtMs)).toISOString() };
    } finally {
      this.starting.delete(actor.userId);
    }
  }

  private workerHasProtocol3(): boolean {
    const v = this.deps.workerProtocol ? this.deps.workerProtocol() : Number.MAX_SAFE_INTEGER;
    return typeof v === "number" && v >= 3;
  }

  private startError(err: unknown): HostedSubscriptionError {
    if (err instanceof HostedSubscriptionError) return err;
    if (err instanceof LoginHostError) {
      if (err.busy) return new HostedSubscriptionError("busy");
      if (err.code === "ESTATE") return new HostedSubscriptionError("busy"); // a sign-in is still pending on the host (e.g. after a deploy): try again shortly
      if (err.ambiguous) return new HostedSubscriptionError("host_unavailable");
    }
    return new HostedSubscriptionError("start_failed");
  }

  async completeLogin(actor: Actor, loginId: string, code: unknown): Promise<LlmConnectionView> {
    if (actor.adminId) throw new HostedSubscriptionError("forbidden");
    const found = this.lookup(loginId);
    // Same answer for unknown, expired and someone else's: a wrong caller never cancels the real login.
    if (!found || found.pending.userId !== actor.userId) throw new HostedSubscriptionError("login_not_found");
    const { key, pending } = found;
    // Taken BEFORE any await: a double-submitted complete must not send the single-use code to the host twice. Keyed by the attempt, not by the
    // string the client sent, so no spelling of the token gets past it.
    if (this.completing.has(key)) throw new HostedSubscriptionError("login_not_found");
    this.completing.add(key);
    this.pending.delete(key);
    clearTimeout(pending.timer);
    try {
      return await this.completeTaken(actor, key, pending, code);
    } finally {
      this.completing.delete(key);
    }
  }

  /** This instance's pending sign-in, or (started by another instance or before a deploy) the one the token describes. */
  private lookup(loginId: unknown): { key: string; pending: Pending } | undefined {
    const t = openSignInToken(loginId, this.deps.now());
    const provider = t && Object.prototype.hasOwnProperty.call(this.providers, t.provider) ? this.providers[t.provider] : undefined;
    if (!t || !provider) return undefined;
    const key = signInKey(t.connectionId, t.loginRef);
    const local = this.pending.get(key);
    if (local) return { key, pending: local };
    return { key, pending: { userId: t.userId, provider, connectionId: t.connectionId, loginRef: t.loginRef, reconnect: t.reconnect, expiresAtMs: t.expiresAtMs } };
  }

  private async completeTaken(actor: Actor, key: string, pending: Pending, code: unknown): Promise<LlmConnectionView> {
    const { connectionId, loginRef, provider: p } = pending;
    if (!(await p.isEnabledFor(actor.userId))) {
      this.restore(key, pending);
      throw new HostedSubscriptionError("disabled");
    }
    let client: LoginHostClient;
    try {
      client = this.host();
    } catch (err) {
      this.restore(key, pending);
      throw err;
    }

    // Protocol 3: a random per-request value the host stores on the attempt that takes the code, so a lost-reply read of the status can tell whose complete it was.
    const completionNonce = this.workerHasProtocol3() ? randomBytes(12).toString("base64url") : undefined;
    let ready;
    try {
      ready = await client.loginComplete({ connectionId, loginRef, code: code as string, ...(completionNonce ? { completionNonce } : {}) });
    } catch (err) {
      if (err instanceof ZodError) {
        // Malformed code: nothing reached the host, so the sign-in is still pending and can be completed with a corrected code.
        this.restore(key, pending);
        throw new HostedSubscriptionError("bad_code_format");
      }
      ready = await this.afterCompleteError(client, err, connectionId, loginRef, completionNonce);
    }

    if (pending.reconnect) return this.finishReconnect(actor, p, client, connectionId, loginRef, ready);
    return this.finishNew(actor, p, client, connectionId, loginRef, ready);
  }

  private restore(key: string, pending: Pending): void {
    this.pending.set(key, pending);
    pending.timer = setTimeout(() => void this.expire(key), Math.max(1_000, pending.expiresAtMs - this.deps.now()));
    pending.timer.unref?.();
  }

  /** `login.complete` failed: decide between "start again", "wrong code" and (for a lost reply) "it may have worked". */
  private async afterCompleteError(client: LoginHostClient, err: unknown, connectionId: string, loginRef: string, completionNonce: string | undefined): Promise<LoginReady> {
    if (err instanceof LoginHostError) {
      if (err.code === "EINVALID" && err.detail === "code_rejected") throw new HostedSubscriptionError("code_rejected");
      if (err.code === "ENOTFOUND" || err.code === "ESTATE") throw new HostedSubscriptionError("login_not_found");
      if (err.busy) throw new HostedSubscriptionError("busy");
      if (err.ambiguous) {
        // The code is single-use and may have been spent: ask the host once whether the attempt became ready.
        try {
          const st = await client.loginStatus({ connectionId, loginRef });
          if (st.status === "ready") {
            // Ready, but did THIS request take the code? A protocol-3 host stores the nonce of the complete that took it, so a ready attempt with another nonce, or with
            // none (the winner was an older backend instance that sends no nonce, as in a rolling deploy), was taken by someone else: this one lost. It must stand down
            // WITHOUT cancelling, or it would discard the winner's login. (No nonce was sent = an older worker: the previous behaviour.)
            if (completionNonce && st.completionNonce !== completionNonce) throw new HostedSubscriptionError("login_not_found");
            return st;
          }
        } catch (inner) {
          if (inner instanceof HostedSubscriptionError) throw inner;
          /* fall through */
        }
        // Neither the reply nor the status arrived: the attempt may be ready and taken by ANOTHER request, so this cancel must not discard it (onlyIfPending). If this
        // request did take it, the host's ready-attempt limit clears it.
        await client.loginCancel({ connectionId, loginRef, ...(completionNonce ? { onlyIfPending: true } : {}) }).catch(() => undefined);
        throw new HostedSubscriptionError("complete_timeout");
      }
    }
    await client.loginCancel({ connectionId, loginRef, ...(completionNonce ? { onlyIfPending: true } : {}) }).catch(() => undefined);
    throw new HostedSubscriptionError("start_failed");
  }

  private async finishNew(actor: Actor, p: HostedProvider, client: LoginHostClient, connectionId: string, loginRef: string, ready: { planLabel?: string; accountFingerprint?: string; refreshExpiresAtMs?: number }): Promise<LlmConnectionView> {
    const nowIso = this.nowIso();
    const record: LlmConnectionRecord = {
      connectionId, ownerUserId: actor.userId, kind: p.kind, provider: p.recordProvider, status: "active", keyLast4: "", createdAt: nowIso, updatedAt: nowIso,
      subHosted: true, subHostEpoch: 1, subNeedsReconnect: false,
      ...(ready.planLabel ? { subType: ready.planLabel } : {}),
      ...(ready.refreshExpiresAtMs ? { subRefreshExpiresAtMs: ready.refreshExpiresAtMs } : {}),
      ...(ready.accountFingerprint ? { subAccountFingerprint: ready.accountFingerprint } : {}),
    };
    let created: boolean;
    try {
      created = await this.deps.db.createWithinLimit(record, MAX_ACTIVE_CONNECTIONS_PER_OWNER);
    } catch (err) {
      await client.loginCancel({ connectionId, loginRef }).catch(() => undefined); // no record: the attempt must not become a home
      throw err;
    }
    if (!created) {
      await client.loginCancel({ connectionId, loginRef }).catch(() => undefined);
      throw new HostedSubscriptionError("limit_reached");
    }
    if ((await this.promote(client, connectionId, loginRef, 1)) !== "active") {
      // A record with no home: put it through the normal disconnect so the slot is freed and the host cleans up.
      await this.revokeRecord(actor, connectionId).catch(() => undefined);
      throw new HostedSubscriptionError("host_unavailable");
    }
    // A sweep that ran between the record write and the promote may have flagged the row; the home is live now, so say so.
    await this.deps.db.hostedMarkReconnected(connectionId, 1, {}, this.nowIso()).catch(() => false);
    console.log(`[hosted-subscription] connected connection=${connectionId} provider=${p.route}`);
    return toView(record, actor.userId);
  }

  private async finishReconnect(actor: Actor, p: HostedProvider, client: LoginHostClient, connectionId: string, loginRef: string, ready: { planLabel?: string; accountFingerprint?: string; refreshExpiresAtMs?: number }): Promise<LlmConnectionView> {
    let epoch: number;
    try {
      const current = await this.deps.db.get(connectionId);
      if (!current || current.ownerUserId !== actor.userId || current.subHosted !== true || current.revokedAt || current.status === "revoking") {
        await client.loginCancel({ connectionId, loginRef }).catch(() => undefined);
        throw new HostedSubscriptionError("not_found");
      }
      epoch = current.subHostEpoch ?? 1;
      // The record moves first: it must never be behind the host.
      if (!(await this.deps.db.hostedAdvanceEpoch(connectionId, epoch, epoch + 1, this.nowIso()))) {
        await client.loginCancel({ connectionId, loginRef }).catch(() => undefined);
        throw new HostedSubscriptionError("busy");
      }
    } catch (err) {
      // A store failure before the promote: the code is spent, so the ready attempt must not linger and block the next sign-in.
      if (!(err instanceof HostedSubscriptionError)) await client.loginCancel({ connectionId, loginRef }).catch(() => undefined);
      throw err;
    }
    const promoted = await this.promote(client, connectionId, loginRef, epoch + 1);
    if (!promoted) {
      // The host keeps the ready attempt after a failed swap, and a new sign-in is refused while it exists: discard it (the owner
      // signs in again). If the promote in fact completed, there is no attempt left and this is a no-op.
      await client.loginCancel({ connectionId, loginRef }).catch(() => undefined);
      await this.deps.db.hostedMarkNeedsReconnect(connectionId, epoch + 1, "promote_failed", this.nowIso());
      throw new HostedSubscriptionError("host_unavailable");
    }
    if (!(await this.deps.db.hostedMarkReconnected(connectionId, epoch + 1, { plan: ready.planLabel, refreshExpiresAtMs: ready.refreshExpiresAtMs, fingerprint: ready.accountFingerprint, status: promoted }, this.nowIso()))) {
      console.error(`[hosted-subscription] reconnect applied on the host but the record moved on connection=${connectionId}`);
    }
    console.log(`[hosted-subscription] reconnected connection=${connectionId} epoch=${epoch + 1}`);
    return toView((await this.deps.db.get(connectionId))!, actor.userId);
  }

  /** `login.promote` is idempotent for the same login and epoch, so a lost reply is simply asked again. */
  private async promote(client: LoginHostClient, connectionId: string, loginRef: string, epoch: number): Promise<"active" | "disabled" | false> {
    const sleep = this.deps.sleep ?? realSleep;
    let lastAmbiguous = false;
    for (let i = 0; i < PROMOTE_ATTEMPTS; i++) {
      try {
        const r = await client.loginPromote({ connectionId, loginRef, epoch });
        return (r.state === "active" || r.state === "disabled") && r.epoch === epoch ? r.state : false;
      } catch (err) {
        // Definite refusals (stale, revoked, gone) will not change by asking again.
        if (err instanceof LoginHostError && !err.ambiguous && !err.busy && err.code !== "EINTERNAL") return false;
        lastAmbiguous = err instanceof LoginHostError && err.ambiguous;
      }
      if (i < PROMOTE_ATTEMPTS - 1) await sleep(PROMOTE_RETRY_MS * (i + 1));
    }
    if (lastAmbiguous) {
      // The last answers were lost, not refused: the promote may have landed. Ask the host before costing the owner another sign-in.
      try {
        const st = await client.connectionStatus({ connectionId });
        return (st.state === "active" || st.state === "disabled") && st.epoch === epoch ? st.state : false;
      } catch {
        /* still unknown: treated as failed */
      }
    }
    return false;
  }

  async cancelLogin(actor: Actor, loginId: string): Promise<void> {
    const found = this.lookup(loginId);
    if (!found || found.pending.userId !== actor.userId) return; // nothing to say about someone else's
    // A complete in flight owns the attempt: cancelling it now would discard the host's ready login after the code was spent.
    if (this.completing.has(found.key)) return;
    this.pending.set(found.key, found.pending);
    await this.expire(found.key);
  }

  private async cancelFor(userId: string): Promise<void> {
    for (const [id, pend] of [...this.pending]) if (pend.userId === userId) await this.expire(id);
  }

  private async expire(key: string): Promise<void> {
    const pend = this.pending.get(key);
    if (!pend) return;
    this.pending.delete(key);
    clearTimeout(pend.timer);
    // Best effort: the host expires an abandoned attempt itself.
    // Protocol 3: a cancel that is only the user's or the timer's must not discard a sign-in that already took its code (it is being finished, maybe by another instance).
    await this.deps.client()?.loginCancel({ connectionId: pend.connectionId, loginRef: pend.loginRef, ...(this.workerHasProtocol3() ? { onlyIfPending: true } : {}) }).catch(() => undefined);
  }

  /**
   * Stops this instance's timers. It does NOT cancel the pending sign-ins on the host: a sign-in is no longer tied to the instance that started it (any instance can
   * finish it from its token), and a deploy shuts the old instance down while the user is still on the sign-in page. The host expires an abandoned attempt itself.
   */
  async shutdown(): Promise<void> {
    for (const pend of this.pending.values()) clearTimeout(pend.timer);
    this.pending.clear();
  }

  pendingCount(): number {
    return this.pending.size;
  }

  // ============================== disconnect (1d) ==============================
  /**
   * Called by the generic disconnect route for a hosted login. Returns "revoked" only when the host confirmed the wipe;
   * "revoking" means it is fenced and unusable and the sweeper is finishing it.
   */
  async revokeRecord(actor: Actor, connectionId: string): Promise<"revoked" | "revoking"> {
    const current = await this.deps.db.get(connectionId);
    if (!current || current.subHosted !== true || current.ownerUserId !== actor.userId) throw new HostedSubscriptionError("not_found");
    if (current.status === "revoked") return "revoked";
    const began = await this.deps.db.hostedBeginRevoke(connectionId, (current.subHostEpoch ?? 0) + 1, { userId: actor.userId, adminId: actor.adminId }, this.nowIso());
    if (began.result === "missing" || began.result === "not_hosted") throw new HostedSubscriptionError("not_found");
    if (began.result === "contended") throw new HostedSubscriptionError("busy"); // the record kept moving under us: nothing was changed, try again
    try {
      this.deps.onRevokeBegun?.(connectionId);
    } catch (err) {
      console.error(`[hosted-subscription] stopping running turns failed connection=${connectionId}:`, err instanceof Error ? err.message : String(err));
    }
    // Idempotent and atomic with the row's flag: a retry after a failed release gives the slot back, a repeat never gives it back twice.
    // A failure here leaves the row `revoking`; the caller (or the sweeper) retries before anything is marked revoked.
    await this.deps.db.hostedReleaseSlot(connectionId, current.ownerUserId);
    return (await this.finishRevoke(connectionId, began.epoch)) === "revoked" ? "revoked" : "revoking";
  }

  private protocolOk(): boolean {
    return this.deps.workerSpeaksOurProtocol ? this.deps.workerSpeaksOurProtocol() : true;
  }

  /** Asks the host to revoke (idempotent) and records `revoked` only on its confirmation. Never throws for a host problem. */
  private async finishRevoke(connectionId: string, epoch: number): Promise<"revoked" | "revoking" | "host_down"> {
    const client = this.deps.client();
    let confirmed = false;
    let down = !client;
    if (client) {
      try {
        confirmed = (await this.revokeOnHost(client, connectionId, epoch)).state === "revoked";
      } catch (err) {
        // A host that has never heard of the connection has nothing to wipe (provided it is a worker we know speaks our protocol).
        confirmed = err instanceof LoginHostError && err.code === "ENOTFOUND" && this.protocolOk();
        down = err instanceof LoginHostError && err.ambiguous;
        if (!confirmed) console.error(`[hosted-subscription] revoke not confirmed connection=${connectionId} code=${err instanceof LoginHostError ? err.code : "error"}`);
      }
    }
    if (confirmed) {
      // "revoked" only if the record really became revoked (or already was): a record that is not `revoking` is not done.
      if ((await this.deps.db.hostedMarkRevoked(connectionId, this.nowIso())) || (await this.deps.db.get(connectionId))?.status === "revoked") return "revoked";
      return "revoking";
    }
    await this.deps.db.hostedNoteRevokeAttempt(connectionId, this.nowIso()).catch(() => undefined);
    return down ? "host_down" : "revoking";
  }

  private async revokeOnHost(client: LoginHostClient, connectionId: string, epoch: number) {
    try {
      return await client.connectionRevoke({ connectionId, epoch });
    } catch (err) {
      if (!(err instanceof LoginHostError) || err.code !== "ESTALE") throw err;
      // The host is ahead of the record (a promote the record missed): adopt the host's epoch, never go lower.
      const st = await client.connectionStatus({ connectionId });
      return client.connectionRevoke({ connectionId, epoch: st.epoch });
    }
  }

  // ============================== sweeper (1d) ==============================
  /** One pass: finish every `revoking`, and make `active` records follow what the host says. Safe to run on several instances at once. */
  sweepOnce(): Promise<SweepResult> {
    this.sweeping ??= this.sweepInner().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepInner(): Promise<SweepResult> {
    const out: SweepResult = { revoking: 0, revoked: 0, stuck: 0, reconciled: 0, markedNeedsReconnect: 0, hostUnavailable: false };
    const rows = await this.deps.db.listHosted();
    const client = this.deps.client();
    if (!client) {
      out.hostUnavailable = rows.some((r) => r.status === "revoking" || r.status === "active");
      if (out.hostUnavailable) console.error("[hosted-subscription] sweep: hosted logins exist but no login host is configured");
      return out;
    }
    for (const r of rows) {
      try {
        if (r.status === "revoking") {
          out.revoking++;
          await this.deps.db.hostedReleaseSlot(r.connectionId, r.ownerUserId); // heals a release that failed or was lost to a crash
          const res = await this.finishRevoke(r.connectionId, r.subHostEpoch ?? 1);
          if (res === "host_down") out.hostUnavailable = true;
          if (res === "revoked") out.revoked++;
          else if ((r.subRevokeAttempts ?? 0) + 1 >= REVOKE_ALARM_ATTEMPTS) {
            out.stuck++;
            console.error(`[hosted-subscription] ALARM revoke stuck connection=${r.connectionId} attempts=${(r.subRevokeAttempts ?? 0) + 1}: a customer login may still be on the host`);
          }
        } else if ((r.status === "active" || r.status === "invalid") && this.deps.now() - Date.parse(r.updatedAt) >= RECONCILE_GRACE_MS) {
          // A row written in the last minutes may be mid sign-in (record created, promote not yet landed): leave it to its own flow.
          out.reconciled++;
          if (await this.reconcile(client, r)) out.markedNeedsReconnect++;
        }
      } catch (err) {
        if (err instanceof LoginHostError && err.ambiguous) out.hostUnavailable = true;
        else console.error(`[hosted-subscription] sweep failed connection=${r.connectionId} code=${(err as { code?: string })?.code || "error"}`);
      }
    }
    return out;
  }

  /** Returns true if the record was marked as needing a reconnect. */
  private async reconcile(client: LoginHostClient, r: LlmConnectionRecord): Promise<boolean> {
    const epoch = r.subHostEpoch ?? 1;
    let st;
    try {
      st = await client.connectionStatus({ connectionId: r.connectionId });
    } catch (err) {
      if (err instanceof LoginHostError && err.code === "ENOTFOUND") return this.protocolOk() ? this.markLost(r, epoch, "host_lost") : false;
      throw err;
    }
    if (st.state === "revoking" || st.state === "revoked") {
      // The host retired this login without us (e.g. an operator). Checked BEFORE the "already waiting for the owner" shortcut:
      // a flagged record on a retired login must still be disconnected so its slot is freed and reconnect stops failing.
      const began = await this.deps.db.hostedBeginRevoke(r.connectionId, Math.max(epoch, st.epoch) + 1, { userId: "host-sweeper" }, this.nowIso());
      if (began.result === "started" || began.result === "already") await this.deps.db.hostedReleaseSlot(r.connectionId, r.ownerUserId);
      return false;
    }
    if (r.status === "invalid" && r.subNeedsReconnect) {
      // Flagged, but the host serves it at this very epoch: a reconnect whose final record write was lost. Make the record follow the host.
      if (st.state === "active" && st.epoch === epoch) await this.deps.db.hostedMarkReconnected(r.connectionId, epoch, {}, this.nowIso());
      return false; // otherwise: already waiting for the owner
    }
    if (st.epoch !== epoch) return this.markLost(r, epoch, "epoch_mismatch");
    if (st.state === "needs_reconnect" || st.state === "needs_attention") return this.markLost(r, epoch, st.reason ?? st.state);
    return false;
  }

  private async markLost(r: LlmConnectionRecord, epoch: number, reason: string): Promise<boolean> {
    if (r.status === "invalid" && r.subNeedsReconnect) return false;
    return this.deps.db.hostedMarkNeedsReconnect(r.connectionId, epoch, reason.slice(0, 60), this.nowIso(), r.updatedAt);
  }
}

/**
 * The host client for this deployment: the test environment's unix socket (bind-mounted into the backend container) when
 * AW_LOGIN_HOST_SOCKET is set; otherwise the production worker over mutual TLS (address from AW-Settings, certificate from Secrets
 * Manager), which is undefined until configured and loaded (every call then answers `host_unavailable`).
 */
export function defaultClient(): LoginHostClient | undefined {
  const socket = process.env.AW_LOGIN_HOST_SOCKET;
  if (socket) return new LoginHostClient(new UnixSocketTransport(socket));
  return getLoginHostProvider().client();
}

let defaultService: HostedSubscriptionService | null = null;
export function getHostedSubscriptionService(): HostedSubscriptionService {
  if (!defaultService) {
    defaultService = new HostedSubscriptionService({
      db: new LlmConnectionDb(),
      client: defaultClient,
      now: () => Date.now(),
      newId: () => randomUUID(),
      // The test environment's unix-socket host is built from the same checkout; the production worker must have been VERIFIED.
      workerSpeaksOurProtocol: () => !!process.env.AW_LOGIN_HOST_SOCKET || getLoginHostProvider().protocolStatus() === "match",
      workerProtocol: () => (process.env.AW_LOGIN_HOST_SOCKET ? PROTOCOL_VERSION : getLoginHostProvider().workerProtocol()),
      // Required on first use, not at load: the bridge singletons pull in Emma's whole service, which the sweeper and the routes must not load
      // just to exist. Synchronous on purpose: the turns are stopped before this call returns, i.e. before the host is asked to wipe the login.
      onRevokeBegun: (connectionId) => {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { claudeRunRegistry } = require("./claudeRunRegistry") as typeof import("./claudeRunRegistry");
        claudeRunRegistry.cancelConnection(connectionId);
        const { toolBridgeMcp } = require("./toolBridgeService") as typeof import("./toolBridgeService");
        toolBridgeMcp.revokeConnection(connectionId);
        /* eslint-enable @typescript-eslint/no-var-requires */
      },
    });
  }
  return defaultService;
}

export async function shutdownHostedSubscriptionService(): Promise<void> {
  if (defaultService) await defaultService.shutdown();
}
