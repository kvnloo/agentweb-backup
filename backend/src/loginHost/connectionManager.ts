/**
 * ENG-2110 PR 1a: the provider-neutral core of the login host.
 *
 * Owns the connection state machine, epoch fencing, sign-in attempts, turn admission and caps,
 * backend-renewed turn leases, idempotency, alarms, and the revoke / disable / sweep paths. It
 * knows nothing about any vendor CLI (adapters) and nothing about real uids or files (ports).
 *
 * Invariants (each has a test):
 *  - Every operation that changes a connection runs under that connection's mutex, so a cancel,
 *    sweep, revoke, disable or promote can never interleave with another on the same connection.
 *  - A request carrying an epoch older than the host's is refused (ESTALE). Fencing actions
 *    (disable, revoke) may carry a NEWER epoch (the backend writes the new epoch to its record
 *    first, then tells the host) and the host adopts it; everything else needs equality.
 *    A promote always needs a strictly newer epoch.
 *  - A uid returns to the pool only after: processes killed, home/attempt wiped, residue scan = 0,
 *    and only while the owner recorded with the wipe still owns it.
 *  - The host never opens a credential file: it only moves directories and asks adapters/ports.
 *  - The home is prepared (adapter lockdown config) BEFORE the sign-in runs, and no turn is
 *    admitted while a connection is swapping homes.
 *  - A turn needs a backend-renewed lease (monotonic clock); a lapse ends the turn, and a provider
 *    that does not stop within the abort grace is closed and its uid's processes killed.
 *  - A retried idempotent request never runs a second turn.
 */
import { createHash } from "crypto";
import type { Hazard, LoginProcess, ProviderEvent, ProviderSession, SubscriptionProviderAdapter } from "./adapter";
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
  /** After a turn is aborted the provider gets this long to stop; then its session is force-closed. */
  abortGraceMs: number;
  /** Concurrent turns across all connections on this host. */
  maxTurnsPerHost: number;
  /** Provider processes across all connections on this host. */
  maxSessionsPerHost: number;
  /** Turn slots kept free for interactive turns: scheduled turns are admitted only below max - reserve. */
  scheduledReserve: number;
  /** A session with no turn for this long is closed ("idle runtimes stop"). */
  idleSessionMs: number;
  /** A relayed tool call the backend does not answer within this window is answered with a failure. */
  toolCallTimeoutMs: number;
  idempotencyTtlMs: number;
  /** Every adapter call made while a connection's lock is held is bounded by this; a hung CLI must not wedge a connection (or its revoke) forever. */
  adapterCallTimeoutMs: number;
  /** Same for filesystem / process port calls. */
  portCallTimeoutMs: number;
  /** Org-delivered settings (Claude Team/Enterprise) are refused unless the sandbox gate is enabled. */
  allowManagedSettings: boolean;
}

export const DEFAULT_CONFIG: ManagerConfig = {
  uidMin: 400_000,
  uidMax: 460_000,
  leaseMs: 30_000,
  abortGraceMs: 5_000,
  maxTurnsPerHost: 12,
  maxSessionsPerHost: 24,
  scheduledReserve: 2,
  idleSessionMs: 10 * 60 * 1000,
  toolCallTimeoutMs: 120_000,
  idempotencyTtlMs: 6 * 60 * 60 * 1000,
  adapterCallTimeoutMs: 60_000,
  portCallTimeoutMs: 30_000,
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
  connectionId: string;
  ready: Promise<ProviderSession>;
  turns: Set<string>;
  dead: boolean;
  lastUsedMono: number;
}

interface RunningTurn {
  connectionId: string;
  epoch: number;
  /** The uid this turn started on: cleanup after a revoke or reconnect must target THIS uid, never the connection's current one. */
  uid: number;
  turnId: string;
  hs: HostSession;
  leaseUntilMono: number;
  deadlineMono?: number;
  priority: "interactive" | "scheduled";
  /** Relayed tool calls awaiting the backend's answer: operationId -> when it was issued (monotonic). */
  operations: Map<string, number>;
  /** Ends the turn. Safe at any moment, including before the session has finished opening. */
  abort: (reason: string) => void;
  onAbort?: () => void;
  /** Called on the first abort; starts the grace timer that force-closes a provider that will not stop. */
  onFirstAbort?: () => void;
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
  events?: AsyncIterable<ProviderEvent>;
  status?: "running" | "finished" | "failed" | "aborted";
}

const FENCING_ACTIONS = new Set(["disable", "revoke"]);

/** Rejects if `p` has not settled within `ms`; the timer is always cleared. */
function bounded<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HostError("EINTERNAL", `${label}_timeout`)), ms);
  });
  return Promise.race([p, limit]).finally(() => timer && clearTimeout(timer));
}

/** Resolves racing waits to "hung" once fired; listeners are removed as each wait settles (no handler pile-up on long turns). */
class AbortGate {
  fired = false;
  private readonly listeners = new Set<() => void>();
  fire(): void {
    this.fired = true;
    for (const l of [...this.listeners]) l();
  }
  race<T>(p: Promise<T>): Promise<T | "hung"> {
    return new Promise((resolve, reject) => {
      const onFire = () => resolve("hung");
      this.listeners.add(onFire);
      p.then(
        (v) => {
          this.listeners.delete(onFire);
          resolve(v);
        },
        (e) => {
          this.listeners.delete(onFire);
          reject(e);
        },
      );
      if (this.fired) onFire();
    });
  }
}

/** Runs async work one at a time per key, in arrival order. */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    return prev.then(fn).finally(() => {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }
}

export class ConnectionManager {
  private readonly cfg: ManagerConfig;
  private readonly log: Logger;
  private readonly uids: UidAllocator;
  private readonly locks = new KeyedMutex();
  private readonly logins = new Map<string, { connectionId: string; proc: LoginProcess; provider: string }>();
  private readonly sessions = new Map<string, HostSession[]>();
  private readonly turns = new Map<string, RunningTurn>();
  private sweeping: Promise<void> | undefined;

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

  /** An adapter call bounded in time. */
  private a<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return bounded(fn(), this.cfg.adapterCallTimeoutMs, label);
  }

  /** A port call bounded in time. */
  private f<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return bounded(fn(), this.cfg.portCallTimeoutMs, label);
  }

  /** Kill every process of a uid, but never with a value outside the reserved range (-1 would mean "everything" to kill(2)). */
  private async safeKill(uid: number): Promise<boolean> {
    if (!Number.isInteger(uid) || uid < this.cfg.uidMin || uid > this.cfg.uidMax) return false;
    await this.f("killAll", () => this.deps.fs.killAll(uid));
    return true;
  }

  private turnKey(connectionId: string, turnId: string): string {
    return `${connectionId}/${turnId}`;
  }

  private locked<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(connectionId, fn);
  }

  // ───────────────────────────── startup recovery ─────────────────────────────

  /**
   * After a host restart: processes started through systemd-run live OUTSIDE the host's cgroup and
   * may still be running, so every allocated uid is killed before the host serves anything. Turns
   * that were running are gone; sign-ins that were in flight can never complete.
   */
  async recover(): Promise<void> {
    const st = this.state();
    for (const uid of Object.keys(st.uidOwners)) await this.safeKill(Number(uid)).catch(() => undefined);
    for (const rec of Object.values(st.idempotency)) {
      const outcome = rec.outcome as { status?: string } | undefined;
      if (outcome?.status === "running") outcome.status = "aborted";
    }
    for (const c of Object.values(st.connections)) {
      if (c.state === "swapping") {
        c.state = "needs_attention";
        c.reason = "swap_interrupted";
      }
      // An attempt whose promote was interrupted may have been moved into place: its intended home is wiped too (discardAttempt queues both).
      if (c.attempt && !this.logins.has(c.attempt.loginRef)) await this.discardAttempt(c, "host_restart").catch(() => undefined);
    }
    this.save();
  }

  // ───────────────────────────── sign-in ─────────────────────────────

  loginStart(req: RouteInput<"login.start">): Promise<LoginStartResult> {
    return this.locked(req.connectionId, async () => {
      const adapter = this.adapter(req.provider);
      const st = this.state();
      let c = st.connections[req.connectionId];
      if (c) {
        if (c.provider !== req.provider) throw new HostError("EINVALID", "provider_mismatch");
        if (c.state === "revoking" || c.state === "revoked") throw new HostError("ESTATE", "revoked");
        if (c.state === "swapping") throw new HostError("ESTATE", "swapping");
        if (!req.reconnect && c.state !== "attempting") throw new HostError("ESTATE", "exists_use_reconnect");
        await this.expireStaleAttempt(c);
        if (c.attempt) throw new HostError("ESTATE", "login_pending");
      } else {
        if (req.reconnect) throw new HostError("ENOTFOUND");
        const now = this.deps.clock.nowMs();
        c = { connectionId: req.connectionId, provider: req.provider, uid: -1, homeRef: "", epoch: 0, state: "attempting", createdAtMs: now, updatedAtMs: now };
        st.connections[req.connectionId] = c;
      }
      const attemptRef = this.deps.ids.next("att");
      const loginRef = this.deps.ids.next("login");
      const owner = `attempt:${attemptRef}`;
      const uid = this.uids.allocate(owner);
      const now = this.deps.clock.nowMs();
      c.attempt = { loginRef, uid, attemptRef, startedAtMs: now, expiresAtMs: now + adapter.loginTtlMs, state: "pending" };
      this.save();
      try {
        await this.f("createAttemptDir", () => this.deps.fs.createAttemptDir(uid, attemptRef));
        const ctx = this.deps.fs.contextFor(req.connectionId, uid, attemptRef, "attempt");
        // The lockdown configuration must exist before the CLI runs for the first time (Codex: file credential store, no tools).
        await this.a("prepareHome", () => adapter.prepareHome(this.deps.fs.asUser(uid, attemptRef, "attempt"), ctx));
        const proc = await this.a("loginStart", () => adapter.loginStart(ctx));
        this.logins.set(loginRef, { connectionId: req.connectionId, proc, provider: req.provider });
        return { loginRef, ceremony: adapter.ceremony, url: proc.data.url, ...(proc.data.userCode ? { userCode: proc.data.userCode } : {}), expiresAtMs: c.attempt.expiresAtMs };
      } catch (err) {
        await this.discardAttempt(c, "start_failed");
        this.log.warn("login_start_failed", { connectionId: req.connectionId, code: errCode(err) });
        throw err instanceof HostError ? err : new HostError("EINTERNAL", "login_start_failed");
      }
    });
  }

  loginComplete(req: RouteInput<"login.complete">): Promise<LoginReady> {
    return this.locked(req.connectionId, async () => {
      const { c, login } = await this.requireAttempt(req.connectionId, req.loginRef);
      const adapter = this.adapter(login.provider);
      if (adapter.ceremony !== "paste_code" || !adapter.loginComplete) throw new HostError("ESTATE", "ceremony_not_paste_code");
      try {
        await this.a("loginComplete", () => adapter.loginComplete!(login.proc, req.code));
      } catch (err) {
        await this.discardAttempt(c, "code_rejected");
        this.log.warn("login_complete_failed", { connectionId: req.connectionId, code: errCode(err) });
        throw new HostError("EINVALID", "code_rejected");
      }
      return this.finishAttempt(c, adapter, login.proc);
    });
  }

  loginStatus(req: RouteInput<"login.status">): Promise<{ status: "pending" | "failed" } | LoginReady> {
    return this.locked(req.connectionId, async () => {
      const { c, login } = await this.requireAttempt(req.connectionId, req.loginRef);
      const adapter = this.adapter(login.provider);
      if (c.attempt?.state === "ready") return this.readyInfo(c, adapter);
      if (adapter.ceremony !== "device_code" || !adapter.loginPoll) throw new HostError("ESTATE", "ceremony_not_device_code");
      const polled = await this.a("loginPoll", () => adapter.loginPoll!(login.proc));
      if (polled === "pending") return { status: "pending" as const };
      if (polled === "failed") {
        await this.discardAttempt(c, "login_failed");
        return { status: "failed" as const };
      }
      return this.finishAttempt(c, adapter, login.proc);
    });
  }

  loginCancel(req: RouteInput<"login.cancel">): Promise<{ cancelled: true }> {
    return this.locked(req.connectionId, async () => {
      const c = this.state().connections[req.connectionId];
      if (c?.attempt && c.attempt.loginRef === req.loginRef) await this.discardAttempt(c, "cancelled");
      return { cancelled: true as const }; // already gone: idempotent
    });
  }

  /** Phase 3: the backend has created its record at `epoch`; make the attempt the connection's home. */
  loginPromote(req: RouteInput<"login.promote">): Promise<{ state: string; epoch: number }> {
    return this.locked(req.connectionId, async () => {
      const c = this.state().connections[req.connectionId];
      if (!c) throw new HostError("ENOTFOUND");
      // A retry of a promote that already completed returns the actual state (a disabled connection stays disabled).
      if (c.promotedLoginRef === req.loginRef && c.epoch === req.epoch && (c.state === "active" || c.state === "disabled")) return { state: c.state, epoch: c.epoch };
      if (!c.attempt || c.attempt.loginRef !== req.loginRef || c.attempt.state !== "ready") throw new HostError("ENOTFOUND");
      // A home swap always needs a strictly newer epoch, except resuming the same promote after it failed part-way.
      const resuming = c.reason === "promote_failed" && req.epoch === c.epoch;
      if (!resuming && req.epoch <= c.epoch) throw new HostError("ESTALE");
      if (c.state === "revoking" || c.state === "revoked") throw new HostError("ESTATE", "revoked");
      const attempt = c.attempt;
      const previous = c.uid >= 0 && c.homeRef ? { uid: c.uid, ref: c.homeRef, owner: c.connectionId } : undefined;

      // Fence the old home first: new epoch recorded, no turn admitted while swapping.
      c.swapWasDisabled = c.swapWasDisabled || c.state === "disabled"; // sticky until a promote completes (cleared at success): a reconnect, its resume or a retry must not silently re-enable a disabled connection
      c.epoch = req.epoch;
      c.state = "swapping";
      c.reason = undefined;
      c.updatedAtMs = this.deps.clock.nowMs();
      this.save();
      try {
        await this.terminateConnection(c, "reconnect");
        const homeRef = attempt.homeRef ?? this.deps.ids.next("home");
        attempt.homeRef = homeRef;
        this.save(); // the intended home is recorded BEFORE the rename: a crash cannot lose track of where the credentials went
        await this.f("promoteAttempt", () => this.deps.fs.promoteAttempt(attempt.uid, attempt.attemptRef, homeRef));
        const uidOwner = this.uids.ownerOf(attempt.uid);
        if (uidOwner === `attempt:${attempt.attemptRef}`) this.uids.transfer(attempt.uid, `attempt:${attempt.attemptRef}`, c.connectionId);
        else if (uidOwner !== c.connectionId) throw new Error("uid_owner_mismatch"); // already transferred by an earlier try of this promote, or a bug: never carry on
      } catch (err) {
        c.state = "needs_attention";
        c.reason = "promote_failed"; // only a reconnect (or resuming this promote) clears it
        this.save();
        this.log.warn("promote_failed", { connectionId: c.connectionId, code: errCode(err) });
        throw new HostError("EINTERNAL", "promote_failed");
      }
      c.uid = attempt.uid;
      c.homeRef = attempt.homeRef!;
      c.promotedLoginRef = attempt.loginRef;
      c.reason = undefined;
      c.signedInAtMs = this.deps.clock.nowMs();
      delete c.attempt;
      delete c.cleanupConfirmedAtMs;
      if (previous) (c.wipePending ??= []).push({ ...previous, kind: "home" });
      this.logins.delete(attempt.loginRef);
      c.state = c.swapWasDisabled ? "disabled" : "active"; // only now may turns be admitted
      delete c.swapWasDisabled;
      this.save();
      return { state: c.state, epoch: c.epoch };
    });
  }

  // ───────────────────────────── turns ─────────────────────────────

  async runTurn(req: RouteInput<"turn.run">): Promise<TurnStarted> {
    // Admission is synchronous up to the point where its slots are reserved (no await before `turns.set`),
    // so concurrent requests cannot exceed the caps. State changes that must stop admission set the
    // connection state synchronously before their first await.
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
    const tkey = this.turnKey(c.connectionId, req.turnId);
    if (this.turns.has(tkey)) throw new HostError("EEXISTS");

    const priority = req.priority ?? "interactive";
    const hostLimit = priority === "scheduled" ? this.cfg.maxTurnsPerHost - this.cfg.scheduledReserve : this.cfg.maxTurnsPerHost;
    if (this.turns.size >= hostLimit) throw new HostError("EBUSY", "host_busy");

    const list = this.sessions.get(c.connectionId) ?? [];
    this.sessions.set(c.connectionId, list);
    const nowMono = this.deps.clock.monotonicMs();
    let hs = list.find((s) => !s.dead && s.turns.size < adapter.maxTurnsPerProcess);
    if (!hs) {
      if (list.filter((s) => !s.dead).length >= adapter.maxProcessesPerHome) throw new HostError("EBUSY", "connection_busy");
      if (this.liveSessionCount() >= this.cfg.maxSessionsPerHost) throw new HostError("EBUSY", "host_busy");
      const ctx = this.deps.fs.contextFor(c.connectionId, c.uid, c.homeRef, "home");
      const fresh: HostSession = { provider: c.provider, connectionId: c.connectionId, turns: new Set(), dead: false, lastUsedMono: nowMono, ready: undefined as unknown as Promise<ProviderSession> };
      fresh.ready = adapter.openSession(ctx, { connectionId: c.connectionId, epoch: c.epoch });
      void fresh.ready.then(
        (ps) => void ps.closed.then(() => this.retireSession(fresh)),
        () => this.retireSession(fresh),
      );
      list.push(fresh);
      hs = fresh;
    }
    const session = hs;
    session.turns.add(req.turnId);
    session.lastUsedMono = nowMono;

    const running: RunningTurn = {
      connectionId: c.connectionId,
      epoch: c.epoch,
      uid: c.uid,
      turnId: req.turnId,
      hs: session,
      leaseUntilMono: nowMono + this.cfg.leaseMs,
      ...(req.deadlineMs ? { deadlineMono: nowMono + req.deadlineMs } : {}),
      priority,
      operations: new Map(),
      abort: (reason: string) => {
        const first = running.aborted === undefined;
        running.aborted ??= reason;
        running.onAbort?.();
        if (first) running.onFirstAbort?.();
      },
    };
    this.turns.set(tkey, running);
    st.idempotency[key] = { requestHash: hash, outcome: { turnId: req.turnId, status: "running" }, atMs: this.deps.clock.nowMs() };
    this.save();

    const finish = (status: "finished" | "failed" | "aborted") => {
      this.turns.delete(tkey);
      session.turns.delete(req.turnId);
      session.lastUsedMono = this.deps.clock.monotonicMs();
      const rec = this.state().idempotency[key];
      if (rec) (rec.outcome as { status: string }).status = status;
      this.save();
    };

    return { duplicate: false, turnId: req.turnId, events: this.streamTurn(c, adapter, session, running, req, finish) };
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
    // After an abort the provider gets abortGraceMs to stop; the gate resolves waits as "hung" if it does not.
    let graceTimer: NodeJS.Timeout | undefined;
    const gate = new AbortGate();
    running.onFirstAbort = () => {
      graceTimer = setTimeout(() => gate.fire(), this.cfg.abortGraceMs);
    };
    if (running.aborted !== undefined) running.onFirstAbort();
    let iterator: AsyncIterator<ProviderEvent> | undefined;
    try {
      const opened = await gate.race(session.ready.then((s) => ({ s }), (e: unknown) => ({ e })));
      if (opened === "hung") return yield* this.abandonHung(c, session, running, () => (status = "aborted"));
      if ("e" in opened) {
        session.dead = true;
        yield { type: "result", ok: false, text: "", errorKind: adapter.mapError(opened.e) };
        return;
      }
      const providerSession = opened.s;
      running.onAbort = () => void providerSession.interrupt(req.turnId).catch(() => undefined);
      if (running.aborted) {
        status = "aborted";
        yield { type: "result", ok: false, text: "", aborted: running.aborted };
        return;
      }
      const pre = await gate.race(providerSession.preflight());
      if (pre === "hung") return yield* this.abandonHung(c, session, running, () => (status = "aborted"));
      if (!pre.ok) {
        // Only if this turn is still on the current login: a reconnect that landed meanwhile must not be parked by the old login's failure.
        if (pre.kind === "auth_dead") await this.locked(c.connectionId, async () => (c.epoch === running.epoch && running.aborted === undefined ? this.markNeedsReconnect(c, "auth_dead") : undefined));
        yield { type: "result", ok: false, text: "", errorKind: pre.kind };
        return;
      }
      iterator = providerSession.turn({ turnId: req.turnId, prompt: req.prompt, model: req.model, bridgeToken: req.bridgeToken })[Symbol.asyncIterator]();
      for (;;) {
        const next = await gate.race(iterator.next());
        if (next === "hung") return yield* this.abandonHung(c, session, running, () => (status = "aborted"));
        if (next.done) break;
        const ev = next.value;
        if (running.aborted) break;
        if (ev.type === "alarm") {
          // Defense in depth: an epoch change always aborts the turn first (checked above), so a stale alarm should not get here.
          await this.locked(c.connectionId, async () => (c.epoch === running.epoch ? this.raiseAlarm(c, ev.hazard) : undefined));
          running.aborted ??= "alarm";
          yield ev;
          break;
        }
        if (ev.type === "tool-use" && adapter.toolTransport === "host_relay") running.operations.set(ev.operationId, this.deps.clock.monotonicMs());
        if (ev.type === "tool-result") running.operations.delete(ev.operationId);
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
      if (graceTimer) clearTimeout(graceTimer);
      void iterator?.return?.().catch(() => undefined);
      finish(running.aborted ? "aborted" : status);
    }
  }

  /** The provider did not stop after an abort: close its session, kill the uid's processes, report the abort. */
  private async *abandonHung(c: ConnRecord, session: HostSession, running: RunningTurn, mark: () => void): AsyncGenerator<ProviderEvent, void> {
    mark();
    this.retireSession(session);
    void session.ready.then((s) => this.a("closeSession", async () => s.close())).catch(() => undefined);
    try {
      await this.safeKill(running.uid); // the uid this turn ran on, not whatever the connection has now
    } catch {
      /* the sweeper retries */
    }
    this.log.warn("provider_hung", { connectionId: c.connectionId });
    yield { type: "result", ok: false, text: "", aborted: running.aborted ?? "hung" };
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

  /** The backend's answer to a relayed tool call; the operation must be one this turn issued and not yet answered. */
  async turnToolResult(req: RouteInput<"turn.toolResult">): Promise<{ ok: true }> {
    const t = this.requireTurn(req.connectionId, req.turnId);
    this.requireEpochNumber(t.epoch, req.epoch);
    if (!t.operations.delete(req.operationId)) throw new HostError("ENOTFOUND");
    const session = await t.hs.ready;
    session.answer(req.operationId, { kind: "tool-result", ok: req.ok, content: req.content });
    return { ok: true };
  }

  /** Ends a turn from inside the host (the caller's stream dropped). Unknown turns are ignored. */
  abortTurn(connectionId: string, turnId: string, reason: string): void {
    this.turns.get(this.turnKey(connectionId, turnId))?.abort(reason);
  }

  /** Called periodically: ends turns whose lease lapsed or whose deadline passed, times out relayed tool calls, retires idle sessions. */
  tick(): void {
    const mono = this.deps.clock.monotonicMs();
    for (const t of [...this.turns.values()]) {
      if (!t.aborted) {
        if (mono > t.leaseUntilMono) t.abort("lease_lapsed");
        else if (t.deadlineMono !== undefined && mono > t.deadlineMono) t.abort("deadline");
      }
      for (const [op, issuedAt] of [...t.operations]) {
        if (mono - issuedAt > this.cfg.toolCallTimeoutMs) {
          t.operations.delete(op);
          void t.hs.ready.then((s) => s.answer(op, { kind: "tool-result", ok: false, content: "tool_call_timeout" })).catch(() => undefined);
        }
      }
    }
    for (const list of [...this.sessions.values()]) {
      for (const hs of [...list]) {
        if (!hs.dead && hs.turns.size === 0 && mono - hs.lastUsedMono > this.cfg.idleSessionMs) {
          this.retireSession(hs);
          void hs.ready.then((s) => s.close()).catch(() => undefined);
        }
      }
    }
  }

  // ───────────────────────────── connection actions ─────────────────────────────

  disable(req: RouteInput<"connection.disable">): Promise<{ state: string; epoch: number }> {
    return this.locked(req.connectionId, async () => {
      const c = this.requireConn(req.connectionId);
      if (c.state === "revoking" || c.state === "revoked") throw new HostError("ESTATE", c.state);
      this.adoptEpoch(c, req.epoch, "disable");
      // Every non-terminal state records the disable (a first sign-in or a parked connection included): otherwise
      // the call succeeds and does nothing, and the next promote activates the connection.
      if (c.state === "active" || c.state === "needs_attention" || c.state === "attempting" || c.state === "needs_reconnect") c.state = "disabled";
      this.save();
      await this.terminateConnection(c, "disabled");
      return { state: c.state, epoch: c.epoch };
    });
  }

  enable(req: RouteInput<"connection.enable">): Promise<{ state: string; epoch: number }> {
    return this.locked(req.connectionId, async () => {
      const c = this.requireConn(req.connectionId);
      this.requireEpoch(c, req.epoch);
      if (c.state !== "disabled") throw new HostError("ESTATE", c.state);
      // A connection parked for a reason (failed swap, interrupted swap, dead login) or without a home is cleared only by a reconnect.
      if (c.reason || c.uid < 0 || !c.homeRef) throw new HostError("ESTATE", c.reason ?? "no_home");
      c.state = "active";
      this.save();
      return { state: c.state, epoch: c.epoch };
    });
  }

  /** Idempotent. Returns once the connection is `revoking`; cleanup completes now or in a later sweep. */
  revoke(req: RouteInput<"connection.revoke">): Promise<{ state: string; epoch: number; cleanupConfirmed: boolean }> {
    return this.locked(req.connectionId, async () => {
      const c = this.requireConn(req.connectionId);
      if (c.state === "revoked") return { state: "revoked", epoch: c.epoch, cleanupConfirmed: c.cleanupConfirmedAtMs !== undefined };
      this.adoptEpoch(c, req.epoch, "revoke");
      c.state = "revoking"; // set before any await: no new turn is admitted from here on
      c.updatedAtMs = this.deps.clock.nowMs();
      this.save();
      // A failure here (a kill that errors, a wipe that times out) leaves the connection revoking with cleanup pending; the sweeper finishes it.
      await this.cleanupRevoking(c).catch((err) => this.log.warn("revoke_cleanup_failed", { connectionId: c.connectionId, code: errCode(err) }));
      return { state: c.state, epoch: c.epoch, cleanupConfirmed: c.cleanupConfirmedAtMs !== undefined };
    });
  }

  status(req: RouteInput<"connection.status">): { state: string; epoch: number; runningTurns: number; planLabel?: string; reason?: string } {
    const c = this.requireConn(req.connectionId);
    const running = [...this.turns.values()].filter((t) => t.connectionId === c.connectionId).length;
    return { state: c.state, epoch: c.epoch, runningTurns: running, ...(c.planLabel ? { planLabel: c.planLabel } : {}), ...(c.reason ? { reason: c.reason } : {}) };
  }

  // ───────────────────────────── sweeper ─────────────────────────────

  /** Expire attempts, retry wipes, finish revokes, free uids that are provably clean, prune idempotency. One sweep at a time; one stuck connection never blocks the rest. */
  sweep(): Promise<void> {
    this.sweeping ??= this.sweepAll().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  private async sweepAll(): Promise<void> {
    const ids = Object.keys(this.state().connections);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < ids.length; i = next++) {
        const id = ids[i];
        try {
          await this.locked(id, async () => {
            const c = this.state().connections[id];
            if (!c) return;
            await this.expireStaleAttempt(c);
            if (c.state === "revoking") await this.cleanupRevoking(c);
            await this.drainWipes(c);
            if ((c.state === "attempting" || (c.state === "disabled" && c.uid < 0 && !c.homeRef)) && !c.attempt && !c.wipePending?.length) delete this.state().connections[id]; // abandoned first sign-in
          });
        } catch (err) {
          this.log.warn("sweep_connection_failed", { connectionId: id, code: errCode(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
    const st = this.state();
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
    const t = this.turns.get(this.turnKey(connectionId, turnId));
    if (!t) throw new HostError("ENOTFOUND");
    return t;
  }

  private liveSessionCount(): number {
    let n = 0;
    for (const list of this.sessions.values()) n += list.filter((s) => !s.dead).length;
    return n;
  }

  private retireSession(hs: HostSession): void {
    hs.dead = true;
    const list = this.sessions.get(hs.connectionId);
    if (!list) return;
    const i = list.indexOf(hs);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this.sessions.delete(hs.connectionId);
  }

  private async requireAttempt(connectionId: string, loginRef: string): Promise<{ c: ConnRecord; login: { connectionId: string; proc: LoginProcess; provider: string } }> {
    const c = this.state().connections[connectionId];
    const login = this.logins.get(loginRef);
    // Unknown, expired and "not yours" all answer the same.
    if (!c || !c.attempt || c.attempt.loginRef !== loginRef || !login || login.connectionId !== connectionId) throw new HostError("ENOTFOUND");
    if (c.state === "revoking" || c.state === "revoked") throw new HostError("ENOTFOUND"); // a revoked connection never gets a login
    if (this.deps.clock.nowMs() > c.attempt.expiresAtMs) {
      await this.discardAttempt(c, "expired");
      throw new HostError("ENOTFOUND");
    }
    return { c, login };
  }

  private async finishAttempt(c: ConnRecord, adapter: SubscriptionProviderAdapter, proc: LoginProcess): Promise<LoginReady> {
    const attempt = c.attempt!;
    const ctx = this.deps.fs.contextFor(c.connectionId, attempt.uid, attempt.attemptRef, "attempt");
    let status;
    let hazards: Hazard[];
    try {
      status = await this.a("authStatus", () => adapter.authStatus(ctx, proc));
      hazards = await this.a("hazards", () => adapter.hazards(ctx));
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
    const expiry = adapter.expiryModel(this.deps.clock.nowMs());
    return { status: "ready", ...(c.planLabel ? { planLabel: c.planLabel } : {}), ...(c.accountFingerprint ? { accountFingerprint: c.accountFingerprint } : {}), ...(expiry?.refreshExpiresAtMs ? { refreshExpiresAtMs: expiry.refreshExpiresAtMs } : {}) };
  }

  private async expireStaleAttempt(c: ConnRecord): Promise<void> {
    if (c.attempt && this.deps.clock.nowMs() > c.attempt.expiresAtMs) await this.discardAttempt(c, "expired");
  }

  /** Caller holds the connection's lock (or the host is starting up). The uid is freed only after a confirmed clean wipe. */
  private async discardAttempt(c: ConnRecord, reason: string): Promise<void> {
    const attempt = c.attempt;
    if (!attempt) return;
    delete c.attempt;
    (c.wipePending ??= []).push({ uid: attempt.uid, ref: attempt.attemptRef, kind: "attempt", owner: `attempt:${attempt.attemptRef}` });
    // A promote that was interrupted after the rename leaves the credentials in the intended home: wipe that too.
    if (attempt.homeRef) c.wipePending.push({ uid: attempt.uid, ref: attempt.homeRef, kind: "home", owner: `attempt:${attempt.attemptRef}` });
    const login = this.logins.get(attempt.loginRef);
    this.logins.delete(attempt.loginRef);
    this.save();
    if (login) {
      try {
        await this.a("loginCancel", () => this.adapter(login.provider).loginCancel(login.proc));
      } catch {
        /* the process is killed by killAll below */
      }
    }
    this.log.info("attempt_discarded", { connectionId: c.connectionId, reason });
    await this.drainWipes(c);
  }

  /**
   * Wipe whatever is pending. A uid is freed only when ALL of its pending entries (the attempt dir and any
   * intended home) are wiped, nothing new was queued for it meanwhile, the residue scan is clean, and the
   * owner that queued the entry still owns it. An entry whose owner no longer owns the uid is stale (the uid
   * was freed and re-allocated): it is dropped without touching the new owner's processes or files.
   */
  private async drainWipes(c: ConnRecord): Promise<void> {
    const queue = c.wipePending;
    if (!queue?.length) return;
    // The queue stays on the record (and so on disk) until the wipes are confirmed: a save by any other
    // operation during the awaits below must still show the pending work. Entries pushed meanwhile are
    // appended after index n.
    const n = queue.length;
    const byUid = new Map<number, NonNullable<ConnRecord["wipePending"]>>();
    for (const w of queue) byUid.set(w.uid, [...(byUid.get(w.uid) ?? []), w]);
    const remaining: NonNullable<ConnRecord["wipePending"]> = [];
    for (const [uid, entries] of byUid) {
      const mine = entries.filter((w) => this.uids.ownerOf(uid) === w.owner);
      if (!mine.length) continue; // stale: the uid is free or belongs to someone else now
      try {
        if (!(await this.safeKill(uid))) {
          // Never treat as clean: the credentials may still be on disk. Kept (and re-logged each sweep) until an operator acts.
          this.log.warn("wipe_entry_uid_out_of_range_kept", { connectionId: c.connectionId });
          remaining.push(...mine);
          continue;
        }
        for (const w of mine) {
          if (w.kind === "attempt") await this.f("wipeAttempt", () => this.deps.fs.wipeAttempt(w.uid, w.ref));
          else await this.f("wipeHome", () => this.deps.fs.wipeHome(w.uid, w.ref));
        }
        const queuedMeanwhile = (c.wipePending ?? []).slice(n).some((w) => w.uid === uid); // entries pushed during the awaits above
        if (!queuedMeanwhile && (await this.f("residueCount", () => this.deps.fs.residueCount(uid))) === 0) {
          for (const w of mine) this.uids.free(uid, w.owner);
        } else remaining.push(...mine);
      } catch {
        remaining.push(...mine); // all of this uid's entries stay together; the uid stays allocated
      }
    }
    const added = (c.wipePending ?? []).slice(n);
    const merged = [...remaining, ...added];
    c.wipePending = merged.length ? merged : undefined;
    this.save();
  }

  private async cleanupRevoking(c: ConnRecord): Promise<void> {
    await this.terminateConnection(c, "revoked");
    const adapter = this.deps.adapters.get(c.provider);
    if (adapter && c.uid >= 0 && c.homeRef) {
      try {
        await this.a("logout", () => adapter.logout(this.deps.fs.contextFor(c.connectionId, c.uid, c.homeRef, "home")));
      } catch {
        /* best effort: the home is wiped next */
      }
    }
    if (c.uid >= 0 && c.homeRef) {
      (c.wipePending ??= []).push({ uid: c.uid, ref: c.homeRef, kind: "home", owner: c.connectionId });
      c.uid = -1;
      c.homeRef = "";
      this.save();
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
          await this.a("closeSession", async () => (await hs.ready).close());
        } catch {
          /* the process is killed below */
        }
      }),
    );
    if (c.uid >= 0) await this.safeKill(c.uid);
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
