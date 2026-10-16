/**
 * ENG-2110 PR 1a: the provider-neutral core of the login host.
 *
 * Owns the connection state machine, epoch fencing, sign-in attempts, turn admission and caps,
 * backend-renewed turn leases, idempotency, alarms, and the revoke / disable / sweep paths. It
 * knows nothing about any vendor CLI (adapters) and nothing about real uids or files (ports).
 *
 * Invariants (each has a test):
 *  - A request carrying an epoch older than the host's is refused (ESTALE). Fencing actions
 *    (disable, revoke, promote) may carry a NEWER epoch (the backend writes the new epoch to its
 *    record first, then tells the host) and the host adopts it; everything else needs equality.
 *  - A uid returns to the pool only after: processes killed, home/attempt wiped, residue scan = 0.
 *  - The host never opens a credential file: it only moves directories and asks adapters/ports.
 *  - A turn needs a backend-renewed lease (monotonic clock); a lapse ends the turn.
 *  - A retried idempotent request never runs a second turn.
 */
import { createHash } from "crypto";
import type { AdapterContext, EntitlementObservation, Hazard, ProviderEvent, ProviderSession, SubscriptionProviderAdapter, LoginProcess } from "./adapter";
import { HostError, type RouteInput } from "./protocol";
import type { Clock, IdGen, Logger, UserFsPort } from "./ports";
import { noopLogger } from "./ports";
import type { ConnRecord, HostState, StateStore } from "./stateStore";
import { UidAllocator } from "./uidAllocator";

export interface ManagerConfig {
  uidMin: number;
  uidMax: number;
  /** A turn must be renewed within this window or the host ends it. */
  leaseMs: number;
  /** Concurrent turns across all connections on this host. */
  maxTurnsPerHost: number;
  /** Turn slots kept free for interactive turns: scheduled turns are admitted only below max - reserve. */
  scheduledReserve: number;
  idempotencyTtlMs: number;
  /** Org-delivered settings (Claude Team/Enterprise) are refused unless the sandbox gate is enabled. */
  allowManagedSettings: boolean;
}

export const DEFAULT_CONFIG: ManagerConfig = {
  uidMin: 400_000,
  uidMax: 460_000,
  leaseMs: 30_000,
  maxTurnsPerHost: 12,
  scheduledReserve: 2,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  allowManagedSettings: false,
};

export interface ManagerDeps {
  store: StateStore;
  clock: Clock;
  fs: UserFsPort;
  ids: IdGen;
  adapters: ReadonlyMap<string, SubscriptionProviderAdapter>;
  config?: Partial<ManagerConfig>;
  log?: Logger;
}

interface HostSession {
  provider: string;
  ready: Promise<ProviderSession>;
  turns: Set<string>;
  dead: boolean;
}

interface RunningTurn {
  connectionId: string;
  epoch: number;
  turnId: string;
  hs: HostSession;
  leaseUntilMono: number;
  deadlineMono?: number;
  priority: "interactive" | "scheduled";
  /** Ends the turn. Safe at any moment, including before the session has finished opening: the reason is recorded first, the provider is interrupted once it can be. */
  abort: (reason: string) => void;
  /** Set once the provider session exists. */
  onAbort?: () => void;
  aborted?: string;
}

export interface LoginStartResult {
  loginRef: string;
  ceremony: "paste_code" | "device_code";
  url: string;
  userCode?: string;
  expiresAtMs: number;
}

export interface LoginReady {
  status: "ready";
  planLabel?: string;
  accountFingerprint?: string;
  refreshExpiresAtMs?: number;
}

export interface TurnStarted {
  duplicate: boolean;
  turnId: string;
  /** Present unless this was a duplicate of a request already accepted. */
  events?: AsyncIterable<ProviderEvent>;
  /** For a duplicate: what is known about the earlier request. */
  status?: "running" | "finished" | "failed" | "aborted";
}

const FENCING_ACTIONS = new Set(["disable", "revoke", "promote"]);

export class ConnectionManager {
  private readonly cfg: ManagerConfig;
  private readonly log: Logger;
  private readonly uids: UidAllocator;
  private readonly logins = new Map<string, { connectionId: string; proc: LoginProcess; provider: string }>();
  private readonly sessions = new Map<string, HostSession[]>();
  private readonly turns = new Map<string, RunningTurn>();

  constructor(private readonly deps: ManagerDeps) {
    this.cfg = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
    this.log = deps.log ?? noopLogger;
    this.uids = new UidAllocator(() => this.state(), this.cfg.uidMin, this.cfg.uidMax);
  }

  private state(): HostState {
    return this.deps.store.get();
  }

  private save(): void {
    this.deps.store.save();
  }

  // ───────────────────────────── startup recovery ─────────────────────────────

  /** After a host restart every turn that was running is gone (systemd killed the children). */
  recover(): void {
    const st = this.state();
    for (const rec of Object.values(st.idempotency)) {
      const outcome = rec.outcome as { status?: string } | undefined;
      if (outcome?.status === "running") outcome.status = "aborted";
    }
    // A sign-in process died with the host: its attempt can never complete.
    for (const c of Object.values(st.connections)) {
      if (c.attempt && !this.logins.has(c.attempt.loginRef)) this.expireAttempt(c, "host_restart");
    }
    this.save();
  }

  // ───────────────────────────── sign-in ─────────────────────────────

  async loginStart(req: RouteInput<"login.start">): Promise<LoginStartResult> {
    const adapter = this.adapter(req.provider);
    const st = this.state();
    let c = st.connections[req.connectionId];
    if (c) {
      if (c.provider !== req.provider) throw new HostError("EINVALID", "provider_mismatch");
      if (c.state === "revoking" || c.state === "revoked") throw new HostError("ESTATE", "revoked");
      if (!req.reconnect && c.state !== "attempting") throw new HostError("ESTATE", "exists_use_reconnect");
      this.expireStaleAttempt(c);
      if (c.attempt) throw new HostError("ESTATE", "login_pending");
    } else {
      if (req.reconnect) throw new HostError("ENOTFOUND");
      const now = this.deps.clock.nowMs();
      c = { connectionId: req.connectionId, provider: req.provider, uid: -1, homeRef: "", epoch: 0, state: "attempting", createdAtMs: now, updatedAtMs: now };
      st.connections[req.connectionId] = c;
    }
    const attemptRef = this.deps.ids.next("att");
    const loginRef = this.deps.ids.next("login");
    const uid = this.uids.allocate(`attempt:${attemptRef}`);
    const now = this.deps.clock.nowMs();
    c.attempt = { loginRef, uid, attemptRef, startedAtMs: now, expiresAtMs: now + adapter.loginTtlMs, state: "pending" };
    this.save();
    try {
      await this.deps.fs.createAttemptDir(uid, attemptRef);
      const ctx = this.deps.fs.contextFor(req.connectionId, uid, attemptRef, "attempt");
      const proc = await adapter.loginStart(ctx);
      this.logins.set(loginRef, { connectionId: req.connectionId, proc, provider: req.provider });
      return { loginRef, ceremony: adapter.ceremony, url: proc.data.url, ...(proc.data.userCode ? { userCode: proc.data.userCode } : {}), expiresAtMs: c.attempt.expiresAtMs };
    } catch (err) {
      await this.discardAttempt(c, "start_failed");
      this.log.warn("login_start_failed", { connectionId: req.connectionId, code: errCode(err) });
      throw err instanceof HostError ? err : new HostError("EINTERNAL", "login_start_failed");
    }
  }

  async loginComplete(req: RouteInput<"login.complete">): Promise<LoginReady> {
    const { c, login } = this.requireAttempt(req.connectionId, req.loginRef);
    const adapter = this.adapter(login.provider);
    if (adapter.ceremony !== "paste_code" || !adapter.loginComplete) throw new HostError("ESTATE", "ceremony_not_paste_code");
    try {
      await adapter.loginComplete(login.proc, req.code);
    } catch (err) {
      await this.discardAttempt(c, "code_rejected");
      this.log.warn("login_complete_failed", { connectionId: req.connectionId, code: errCode(err) });
      throw new HostError("EINVALID", "code_rejected");
    }
    return this.finishAttempt(c, adapter);
  }

  async loginStatus(req: RouteInput<"login.status">): Promise<{ status: "pending" | "failed" } | LoginReady> {
    const { c, login } = this.requireAttempt(req.connectionId, req.loginRef);
    const adapter = this.adapter(login.provider);
    if (c.attempt?.state === "ready") return this.readyInfo(c, adapter);
    if (adapter.ceremony !== "device_code" || !adapter.loginPoll) throw new HostError("ESTATE", "ceremony_not_device_code");
    const polled = await adapter.loginPoll(login.proc);
    if (polled === "pending") return { status: "pending" };
    if (polled === "failed") {
      await this.discardAttempt(c, "login_failed");
      return { status: "failed" };
    }
    return this.finishAttempt(c, adapter);
  }

  async loginCancel(req: RouteInput<"login.cancel">): Promise<{ cancelled: true }> {
    const c = this.state().connections[req.connectionId];
    if (!c?.attempt || c.attempt.loginRef !== req.loginRef) return { cancelled: true }; // already gone: idempotent
    await this.discardAttempt(c, "cancelled");
    return { cancelled: true };
  }

  /** Phase 3: the backend has created its record at `epoch`; make the attempt the connection's home. */
  async loginPromote(req: RouteInput<"login.promote">): Promise<{ state: "active"; epoch: number }> {
    const c = this.state().connections[req.connectionId];
    if (!c) throw new HostError("ENOTFOUND");
    if (c.promotedLoginRef === req.loginRef && c.epoch === req.epoch && c.state === "active") return { state: "active", epoch: c.epoch }; // retry
    if (!c.attempt || c.attempt.loginRef !== req.loginRef || c.attempt.state !== "ready") throw new HostError("ENOTFOUND");
    if (req.epoch < c.epoch) throw new HostError("ESTALE");
    if (c.state === "revoking" || c.state === "revoked") throw new HostError("ESTATE", "revoked");
    const attempt = c.attempt;
    const adapter = this.adapter(c.provider);
    const previous = c.uid >= 0 && c.homeRef ? { uid: c.uid, ref: c.homeRef } : undefined;

    // Fence the old home first: new epoch recorded, every process of the old login stopped.
    c.epoch = req.epoch;
    c.updatedAtMs = this.deps.clock.nowMs();
    this.save();
    await this.terminateConnection(c, "reconnect");

    const homeRef = this.deps.ids.next("home");
    await this.deps.fs.promoteAttempt(attempt.uid, attempt.attemptRef, homeRef);
    this.uids.transfer(attempt.uid, `attempt:${attempt.attemptRef}`, c.connectionId);
    c.uid = attempt.uid;
    c.homeRef = homeRef;
    c.promotedLoginRef = attempt.loginRef;
    c.state = "active";
    c.reason = undefined;
    c.signedInAtMs = this.deps.clock.nowMs();
    delete c.attempt;
    delete c.cleanupConfirmedAtMs;
    if (previous) (c.wipePending ??= []).push({ ...previous, kind: "home" });
    this.logins.delete(attempt.loginRef);
    this.save();
    try {
      const ctx = this.deps.fs.contextFor(c.connectionId, c.uid, c.homeRef, "home");
      await adapter.prepareHome(this.deps.fs.asUser(c.uid, c.homeRef), ctx);
    } catch (err) {
      this.log.warn("prepare_home_failed", { connectionId: c.connectionId, code: errCode(err) });
      c.state = "needs_attention";
      c.reason = "prepare_home_failed";
      this.save();
      throw new HostError("EINTERNAL", "prepare_home_failed");
    }
    return { state: "active", epoch: c.epoch };
  }

  // ───────────────────────────── turns ─────────────────────────────

  async runTurn(req: RouteInput<"turn.run">): Promise<TurnStarted> {
    const st = this.state();
    const key = `turn:${req.connectionId}:${req.idempotencyKey}`;
    const hash = hashOf({ c: req.connectionId, e: req.epoch, t: req.turnId, p: req.prompt, m: req.model, pr: req.priority ?? "interactive" });
    const prior = st.idempotency[key];
    if (prior) {
      if (prior.requestHash !== hash) throw new HostError("EEXISTS");
      const o = prior.outcome as { turnId: string; status: "running" | "finished" | "failed" | "aborted" };
      return { duplicate: true, turnId: o.turnId, status: o.status };
    }
    const c = this.requireConn(req.connectionId);
    this.requireEpoch(c, req.epoch);
    if (c.state !== "active") throw new HostError("ESTATE", c.state);
    const adapter = this.adapter(c.provider);
    if (!adapter.models.has(req.model)) throw new HostError("EINVALID", "model_not_allowed");
    if (this.turns.has(req.turnId)) throw new HostError("EEXISTS");

    // Admission: host-wide, scheduled turns leave room for interactive ones.
    const priority = req.priority ?? "interactive";
    const hostLimit = priority === "scheduled" ? this.cfg.maxTurnsPerHost - this.cfg.scheduledReserve : this.cfg.maxTurnsPerHost;
    if (this.turns.size >= hostLimit) throw new HostError("EBUSY", "host_busy");

    // Reserve a session slot synchronously (before any await) so concurrent requests cannot exceed the caps.
    const list = this.sessions.get(c.connectionId) ?? [];
    this.sessions.set(c.connectionId, list);
    let hs = list.find((s) => !s.dead && s.turns.size < adapter.maxTurnsPerProcess);
    if (!hs) {
      if (list.filter((s) => !s.dead).length >= adapter.maxProcessesPerHome) throw new HostError("EBUSY", "connection_busy");
      const ctx = this.deps.fs.contextFor(c.connectionId, c.uid, c.homeRef, "home");
      hs = { provider: c.provider, turns: new Set(), dead: false, ready: undefined as unknown as Promise<ProviderSession> };
      hs.ready = adapter.openSession(ctx, { connectionId: c.connectionId, epoch: c.epoch });
      list.push(hs);
    }
    const session = hs;
    session.turns.add(req.turnId);

    const nowMono = this.deps.clock.monotonicMs();
    const running: RunningTurn = {
      connectionId: c.connectionId,
      epoch: c.epoch,
      turnId: req.turnId,
      hs: session,
      leaseUntilMono: nowMono + this.cfg.leaseMs,
      ...(req.deadlineMs ? { deadlineMono: nowMono + req.deadlineMs } : {}),
      priority,
      abort: (reason: string) => {
        running.aborted ??= reason;
        running.onAbort?.();
      },
    };
    this.turns.set(req.turnId, running);
    st.idempotency[key] = { requestHash: hash, outcome: { turnId: req.turnId, status: "running" }, atMs: this.deps.clock.nowMs() };
    this.save();

    const finish = (status: "finished" | "failed" | "aborted") => {
      this.turns.delete(req.turnId);
      session.turns.delete(req.turnId);
      const rec = this.state().idempotency[key];
      if (rec) (rec.outcome as { status: string }).status = status;
      this.save();
    };

    const events = this.streamTurn(c, adapter, session, running, req, finish);

    return { duplicate: false, turnId: req.turnId, events };
  }

  /** Runs one turn against its provider session and cleans up when the consumer is done (or stops listening). */
  private async *streamTurn(
    c: ConnRecord,
    adapter: SubscriptionProviderAdapter,
    session: HostSession,
    running: RunningTurn,
    req: RouteInput<"turn.run">,
    finish: (status: "finished" | "failed" | "aborted") => void,
  ): AsyncGenerator<ProviderEvent> {
    let status: "finished" | "failed" | "aborted" = "failed";
    try {
      let providerSession: ProviderSession;
      try {
        providerSession = await session.ready;
      } catch (err) {
        session.dead = true;
        yield { type: "result", ok: false, text: "", errorKind: adapter.mapError(err) };
        return;
      }
      running.onAbort = () => void providerSession.interrupt().catch(() => undefined);
      if (running.aborted) {
        status = "aborted";
        yield { type: "result", ok: false, text: "", aborted: running.aborted };
        return;
      }
      const pre = await adapter.preflight(this.deps.fs.contextFor(c.connectionId, c.uid, c.homeRef, "home"));
      if (!pre.ok) {
        if (pre.kind === "auth_dead") this.markNeedsReconnect(c, "auth_dead");
        yield { type: "result", ok: false, text: "", errorKind: pre.kind };
        return;
      }
      for await (const ev of providerSession.turn({ turnId: req.turnId, prompt: req.prompt, model: req.model, bridgeToken: req.bridgeToken })) {
        if (running.aborted) break;
        if (ev.type === "alarm") {
          await this.raiseAlarm(c, ev.hazard);
          running.aborted = "alarm";
          yield ev;
          break;
        }
        yield ev;
        if (ev.type === "result") {
          status = ev.ok ? "finished" : "failed";
          return;
        }
      }
      status = "aborted";
      yield { type: "result", ok: false, text: "", aborted: running.aborted ?? "stream_ended" };
    } catch (err) {
      yield { type: "result", ok: false, text: "", errorKind: adapter.mapError(err) };
    } finally {
      finish(running.aborted ? "aborted" : status);
    }
  }

  renewLease(req: RouteInput<"turn.renew">): { leaseMs: number } {
    const t = this.requireTurn(req.connectionId, req.turnId);
    this.requireEpochNumber(t.epoch, req.epoch);
    t.leaseUntilMono = this.deps.clock.monotonicMs() + this.cfg.leaseMs;
    return { leaseMs: this.cfg.leaseMs };
  }

  async interruptTurn(req: RouteInput<"turn.interrupt">): Promise<{ interrupted: true }> {
    const t = this.requireTurn(req.connectionId, req.turnId);
    this.requireEpochNumber(t.epoch, req.epoch);
    t.abort("interrupted");
    return { interrupted: true };
  }

  async turnToolResult(req: RouteInput<"turn.toolResult">): Promise<{ ok: true }> {
    const t = this.requireTurn(req.connectionId, req.turnId);
    this.requireEpochNumber(t.epoch, req.epoch);
    const session = await t.hs.ready;
    session.answer(req.operationId, { kind: "tool-result", ok: req.ok, content: req.content });
    return { ok: true };
  }

  /** Ends a turn from inside the host (the caller's stream dropped). Unknown turns are ignored. */
  abortTurn(turnId: string, reason: string): void {
    this.turns.get(turnId)?.abort(reason);
  }

  /** Called periodically: ends turns whose lease lapsed or whose deadline passed. */
  tick(): void {
    const mono = this.deps.clock.monotonicMs();
    for (const t of [...this.turns.values()]) {
      if (t.aborted) continue;
      if (mono > t.leaseUntilMono) t.abort("lease_lapsed");
      else if (t.deadlineMono !== undefined && mono > t.deadlineMono) t.abort("deadline");
    }
  }

  // ───────────────────────────── connection actions ─────────────────────────────

  async disable(req: RouteInput<"connection.disable">): Promise<{ state: string; epoch: number }> {
    const c = this.requireConn(req.connectionId);
    this.adoptEpoch(c, req.epoch, "disable");
    if (c.state === "revoking" || c.state === "revoked") throw new HostError("ESTATE", c.state);
    if (c.state === "active" || c.state === "needs_attention") c.state = "disabled";
    this.save();
    await this.terminateConnection(c, "disabled");
    return { state: c.state, epoch: c.epoch };
  }

  enable(req: RouteInput<"connection.enable">): { state: string; epoch: number } {
    const c = this.requireConn(req.connectionId);
    this.requireEpoch(c, req.epoch);
    if (c.state !== "disabled") throw new HostError("ESTATE", c.state);
    c.state = "active";
    this.save();
    return { state: c.state, epoch: c.epoch };
  }

  /** Idempotent. Returns once the connection is `revoking`; cleanup completes now or in a later sweep. */
  async revoke(req: RouteInput<"connection.revoke">): Promise<{ state: string; epoch: number; cleanupConfirmed: boolean }> {
    const c = this.requireConn(req.connectionId);
    if (c.state === "revoked") return { state: "revoked", epoch: c.epoch, cleanupConfirmed: c.cleanupConfirmedAtMs !== undefined };
    this.adoptEpoch(c, req.epoch, "revoke");
    c.state = "revoking";
    c.updatedAtMs = this.deps.clock.nowMs();
    this.save();
    await this.cleanupRevoking(c);
    return { state: c.state, epoch: c.epoch, cleanupConfirmed: c.cleanupConfirmedAtMs !== undefined };
  }

  status(req: RouteInput<"connection.status">): { state: string; epoch: number; runningTurns: number; planLabel?: string; reason?: string } {
    const c = this.requireConn(req.connectionId);
    const running = [...this.turns.values()].filter((t) => t.connectionId === c.connectionId).length;
    return { state: c.state, epoch: c.epoch, runningTurns: running, ...(c.planLabel ? { planLabel: c.planLabel } : {}), ...(c.reason ? { reason: c.reason } : {}) };
  }

  // ───────────────────────────── sweeper ─────────────────────────────

  /** Expire attempts, retry wipes, finish revokes, free uids that are provably clean, prune idempotency. */
  async sweep(): Promise<void> {
    const st = this.state();
    for (const c of Object.values(st.connections)) {
      this.expireStaleAttempt(c);
      if (c.state === "revoking") await this.cleanupRevoking(c);
      await this.drainWipes(c);
      if (c.state === "attempting" && !c.attempt && !(c.wipePending?.length)) delete st.connections[c.connectionId]; // abandoned first sign-in
    }
    const now = this.deps.clock.nowMs();
    for (const [k, rec] of Object.entries(st.idempotency)) {
      if (now - rec.atMs > this.cfg.idempotencyTtlMs && (rec.outcome as { status?: string }).status !== "running") delete st.idempotency[k];
    }
    this.save();
  }

  // ───────────────────────────── internals ─────────────────────────────

  private adapter(id: string): SubscriptionProviderAdapter {
    const a = this.deps.adapters.get(id);
    if (!a) throw new HostError("EUNSUPPORTED");
    return a;
  }

  private requireConn(id: string): ConnRecord {
    const c = this.state().connections[id];
    if (!c) throw new HostError("ENOTFOUND");
    return c;
  }

  private requireEpoch(c: ConnRecord, epoch: number): void {
    if (epoch !== c.epoch) throw new HostError("ESTALE");
  }

  private requireEpochNumber(have: number, got: number): void {
    if (have !== got) throw new HostError("ESTALE");
  }

  /** Fencing actions may carry a newer epoch (adopted) but never an older one. */
  private adoptEpoch(c: ConnRecord, epoch: number, action: string): void {
    if (!FENCING_ACTIONS.has(action)) throw new HostError("EINTERNAL");
    if (epoch < c.epoch) throw new HostError("ESTALE");
    c.epoch = epoch;
  }

  private requireTurn(connectionId: string, turnId: string): RunningTurn {
    const t = this.turns.get(turnId);
    if (!t || t.connectionId !== connectionId) throw new HostError("ENOTFOUND");
    return t;
  }

  private requireAttempt(connectionId: string, loginRef: string): { c: ConnRecord; login: { connectionId: string; proc: LoginProcess; provider: string } } {
    const c = this.state().connections[connectionId];
    const login = this.logins.get(loginRef);
    // Unknown, expired and "not yours" all answer the same.
    if (!c || !c.attempt || c.attempt.loginRef !== loginRef || !login || login.connectionId !== connectionId) throw new HostError("ENOTFOUND");
    if (this.deps.clock.nowMs() > c.attempt.expiresAtMs) {
      void this.discardAttempt(c, "expired");
      throw new HostError("ENOTFOUND");
    }
    return { c, login };
  }

  private async finishAttempt(c: ConnRecord, adapter: SubscriptionProviderAdapter): Promise<LoginReady> {
    const attempt = c.attempt!;
    const ctx = this.deps.fs.contextFor(c.connectionId, attempt.uid, attempt.attemptRef, "attempt");
    let status;
    let hazards: Hazard[];
    try {
      status = await adapter.authStatus(ctx);
      hazards = await adapter.hazards(ctx);
    } catch {
      await this.discardAttempt(c, "status_failed");
      throw new HostError("EINTERNAL", "status_failed");
    }
    if (!status.loggedIn) {
      await this.discardAttempt(c, "not_logged_in");
      throw new HostError("EINVALID", "not_logged_in");
    }
    const blocking = hazards.find((h) => (h.kind === "managed_settings_present" && !this.cfg.allowManagedSettings) || h.kind === "api_key_source" || h.kind === "policy_blocks_agentweb");
    if (blocking) {
      await this.discardAttempt(c, "hazard");
      throw new HostError("EHAZARD", blocking.kind);
    }
    attempt.state = "ready";
    c.planLabel = status.planLabel;
    c.accountFingerprint = status.accountFingerprint;
    this.save();
    return this.readyInfo(c, adapter);
  }

  private readyInfo(c: ConnRecord, adapter: SubscriptionProviderAdapter): LoginReady {
    const now = this.deps.clock.nowMs();
    const expiry = adapter.expiryModel(now);
    return { status: "ready", ...(c.planLabel ? { planLabel: c.planLabel } : {}), ...(c.accountFingerprint ? { accountFingerprint: c.accountFingerprint } : {}), ...(expiry?.refreshExpiresAtMs ? { refreshExpiresAtMs: expiry.refreshExpiresAtMs } : {}) };
  }

  private expireStaleAttempt(c: ConnRecord): void {
    if (c.attempt && this.deps.clock.nowMs() > c.attempt.expiresAtMs) this.expireAttempt(c, "expired");
  }

  /** Marks the attempt for discard (sync) and starts the wipe; the uid is freed only after a confirmed clean wipe. */
  private expireAttempt(c: ConnRecord, reason: string): void {
    void this.discardAttempt(c, reason);
  }

  private async discardAttempt(c: ConnRecord, reason: string): Promise<void> {
    const attempt = c.attempt;
    if (!attempt) return;
    delete c.attempt;
    (c.wipePending ??= []).push({ uid: attempt.uid, ref: attempt.attemptRef, kind: "attempt" });
    const login = this.logins.get(attempt.loginRef);
    this.logins.delete(attempt.loginRef);
    this.save();
    if (login) {
      try {
        await this.adapter(login.provider).loginCancel(login.proc);
      } catch {
        /* the process is killed by killAll below */
      }
    }
    this.log.info("attempt_discarded", { connectionId: c.connectionId, reason });
    await this.drainWipes(c);
  }

  /** Wipe whatever is pending; free a uid only when killed + wiped + residue-free. */
  private async drainWipes(c: ConnRecord): Promise<void> {
    if (!c.wipePending?.length) return;
    const remaining: NonNullable<ConnRecord["wipePending"]> = [];
    for (const w of c.wipePending) {
      try {
        await this.deps.fs.killAll(w.uid);
        if (w.kind === "attempt") await this.deps.fs.wipeAttempt(w.uid, w.ref);
        else await this.deps.fs.wipeHome(w.uid, w.ref);
        if ((await this.deps.fs.residueCount(w.uid)) === 0) this.uids.free(w.uid);
        else remaining.push(w);
      } catch {
        remaining.push(w);
      }
    }
    c.wipePending = remaining.length ? remaining : undefined;
    this.save();
  }

  private async cleanupRevoking(c: ConnRecord): Promise<void> {
    await this.terminateConnection(c, "revoked");
    const adapter = this.deps.adapters.get(c.provider);
    if (adapter && c.uid >= 0 && c.homeRef) {
      try {
        await adapter.logout(this.deps.fs.contextFor(c.connectionId, c.uid, c.homeRef, "home"));
      } catch {
        /* best effort: the home is wiped next */
      }
    }
    if (c.uid >= 0 && c.homeRef) {
      (c.wipePending ??= []).push({ uid: c.uid, ref: c.homeRef, kind: "home" });
      c.uid = -1;
      c.homeRef = "";
    }
    if (c.attempt) await this.discardAttempt(c, "revoked");
    await this.drainWipes(c);
    if (!c.wipePending?.length) {
      c.state = "revoked";
      c.cleanupConfirmedAtMs = this.deps.clock.nowMs();
      this.save();
    }
  }

  /** Stops every turn and process of a connection (epoch changed, disabled, revoked, alarm). */
  private async terminateConnection(c: ConnRecord, reason: string): Promise<void> {
    for (const t of [...this.turns.values()]) if (t.connectionId === c.connectionId) t.abort(reason);
    const list = this.sessions.get(c.connectionId) ?? [];
    this.sessions.delete(c.connectionId);
    await Promise.all(
      list.map(async (hs) => {
        hs.dead = true;
        try {
          await (await hs.ready).close();
        } catch {
          /* the process is killed below */
        }
      }),
    );
    if (c.uid >= 0) await this.deps.fs.killAll(c.uid);
  }

  private markNeedsReconnect(c: ConnRecord, reason: string): void {
    if (c.state === "active") {
      c.state = "needs_reconnect";
      c.reason = reason;
      this.save();
    }
  }

  private async raiseAlarm(c: ConnRecord, hazard: Hazard): Promise<void> {
    this.log.warn("alarm", { connectionId: c.connectionId, hazard: hazard.kind });
    if (c.state === "active") {
      c.state = "needs_attention";
      c.reason = hazard.kind;
      this.save();
    }
    await this.terminateConnection(c, "alarm");
  }
}

function hashOf(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

function errCode(err: unknown): string {
  return err instanceof HostError ? err.code : (err as { code?: string })?.code || (err as Error)?.name || "error";
}

export type { EntitlementObservation, AdapterContext };
