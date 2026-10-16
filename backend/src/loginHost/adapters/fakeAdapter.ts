/**
 * ENG-2110 PR 1a: a scripted provider adapter. It exercises every method of the adapter
 * interface, including both sign-in ceremonies, so the host core cannot quietly depend on
 * Claude specifics. It is a TEST adapter: it never starts a process. Behaviour is scripted
 * through `FakeScript`, which tests mutate.
 */
import { EventEmitter } from "events";
import type {
  AuthStatus,
  ErrorKind,
  Hazard,
  LoginProcess,
  ProviderEvent,
  ProviderSession,
  ServerRequestAnswer,
  SubscriptionProviderAdapter,
} from "../adapter";

export interface FakeScript {
  loggedIn: boolean;
  planLabel?: string;
  accountFingerprint?: string;
  hazards: Hazard[];
  /** What loginComplete does with a code: "ok" or "reject". */
  codeResult: "ok" | "reject";
  devicePoll: "pending" | "done" | "failed";
  preflight: { ok: true } | { ok: false; kind: ErrorKind };
  /** Events each turn emits, in order; the last should be a result. A `{wait: promise}` entry pauses the turn until it resolves. */
  turnEvents: Array<ProviderEvent | { wait: Promise<void> }>;
  openFails?: boolean;
  /** A misbehaving provider: keeps emitting after interrupt(). */
  ignoreInterrupt?: boolean;
  /** A hung provider: a turn never ends and ignores interrupt() and close() entirely. */
  hangTurn?: boolean;
  /** openSession never resolves. */
  openHang?: boolean;
  /** preflight waits for this before answering. */
  preflightGate?: Promise<void>;
  /** Called by tests to make every open session report `closed` (the provider process died). */
  killSessions: Array<() => void>;
  /** Turns that were interrupted individually. */
  interruptedTurns: string[];
  /** Counters tests can assert on. */
  opened: number;
  closed: number;
  interrupts: number;
  logouts: number;
  prepared: number;
  loginsStarted: number;
  loginsCancelled: number;
  answers: Array<{ operationId: string; answer: ServerRequestAnswer }>;
  /** Number of turns currently inside session.turn() across all sessions. */
  activeTurns: number;
  maxActiveTurns: number;
}

export function newScript(): FakeScript {
  return {
    loggedIn: true,
    planLabel: "max",
    hazards: [],
    codeResult: "ok",
    devicePoll: "done",
    preflight: { ok: true },
    turnEvents: [{ type: "text", delta: "hi" }, { type: "result", ok: true, text: "hi" }],
    opened: 0,
    closed: 0,
    interrupts: 0,
    logouts: 0,
    prepared: 0,
    loginsStarted: 0,
    loginsCancelled: 0,
    answers: [],
    activeTurns: 0,
    maxActiveTurns: 0,
    killSessions: [],
    interruptedTurns: [],
  };
}

export interface FakeOptions {
  id?: string;
  ceremony?: "paste_code" | "device_code";
  maxProcessesPerHome?: number;
  maxTurnsPerProcess?: number;
  loginTtlMs?: number;
  toolTransport?: "mcp_direct" | "host_relay";
}

export function createFakeAdapter(script: FakeScript, opts: FakeOptions = {}): SubscriptionProviderAdapter {
  const ceremony = opts.ceremony ?? "paste_code";
  const adapter: SubscriptionProviderAdapter = {
    id: opts.id ?? "fake",
    flagKey: "fakeSubscription",
    homeEnvVar: "FAKE_HOME",
    ceremony,
    toolTransport: opts.toolTransport ?? "mcp_direct",
    maxProcessesPerHome: opts.maxProcessesPerHome ?? 3,
    maxTurnsPerProcess: opts.maxTurnsPerProcess ?? 1,
    loginTtlMs: opts.loginTtlMs ?? 10 * 60 * 1000,
    models: new Set(["fast", "smart"]),
    binary: () => ({ path: "/opt/fake/fake-cli", version: "0.0.0-fake", digest: "sha256:fake" }),
    prepareHome: async () => {
      script.prepared++;
    },
    loginStart: async () => {
      script.loginsStarted++;
      const proc: LoginProcess = { data: ceremony === "device_code" ? { url: "https://example.test/device", userCode: "ABCD-1234" } : { url: "https://example.test/authorize" } };
      return proc;
    },
    loginCancel: async () => {
      script.loginsCancelled++;
    },
    authStatus: async (): Promise<AuthStatus> => ({ loggedIn: script.loggedIn, planLabel: script.planLabel, accountFingerprint: script.accountFingerprint }),
    hazards: async () => script.hazards,
    openSession: async (): Promise<ProviderSession> => {
      if (script.openHang) await new Promise<void>(() => undefined);
      if (script.openFails) throw Object.assign(new Error("open failed"), { code: "open_failed" });
      script.opened++;
      const bus = new EventEmitter();
      const interrupted = new Set<string>();
      let closedAll = false;
      let markClosed!: () => void;
      const closed = new Promise<void>((resolve) => (markClosed = resolve));
      script.killSessions.push(() => {
        closedAll = true;
        bus.emit("interrupt");
        markClosed();
      });
      return {
        closed,
        preflight: async () => {
          if (script.preflightGate) await script.preflightGate;
          return script.preflight;
        },
        async *turn({ turnId }) {
          script.activeTurns++;
          script.maxActiveTurns = Math.max(script.maxActiveTurns, script.activeTurns);
          try {
            if (script.hangTurn) await new Promise<void>(() => undefined);
            const stopped = () => (interrupted.has(turnId) || closedAll) && !script.ignoreInterrupt;
            for (const item of script.turnEvents) {
              if (stopped()) return;
              if ("wait" in item) {
                await Promise.race([item.wait, new Promise<void>((resolve) => bus.once("interrupt", () => resolve()))]);
                if (stopped()) return;
                continue;
              }
              yield item;
            }
          } finally {
            script.activeTurns--;
          }
        },
        answer(operationId, answer) {
          script.answers.push({ operationId, answer });
        },
        async interrupt(turnId) {
          script.interrupts++;
          script.interruptedTurns.push(turnId);
          interrupted.add(turnId);
          bus.emit("interrupt");
        },
        async close() {
          script.closed++;
          closedAll = true;
          bus.emit("interrupt");
          markClosed();
        },
      };
    },
    mapError: (raw: unknown): ErrorKind => ((raw as { code?: string })?.code === "open_failed" ? "transient" : "unknown"),
    logout: async () => {
      script.logouts++;
    },
    expiryModel: (signedInAtMs: number) => ({ refreshExpiresAtMs: signedInAtMs + 30 * 24 * 60 * 60 * 1000 }),
  };
  if (ceremony === "paste_code") {
    adapter.loginComplete = async () => {
      if (script.codeResult === "reject") throw new Error("rejected");
    };
  } else {
    adapter.loginPoll = async () => script.devicePoll;
  }
  return adapter;
}
