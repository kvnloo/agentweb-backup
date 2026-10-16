/**
 * ENG-2110 PR 1a: the provider boundary. The host core knows nothing about any vendor's CLI;
 * everything vendor-specific is an adapter implementing this interface. The interface is
 * derived from two documented providers (Claude: per-conversation `claude -p` stream-json
 * process, paste-code sign-in; Codex: `codex app-server` JSON-RPC over stdio, device-code
 * sign-in) and may change when the second one is really implemented ("rule of three").
 *
 * A provider only gets an adapter when it passes the eligibility checklist: an official
 * binary; a remotely completable sign-in; a credential-free status check; a file-based
 * credential store; a stdio protocol; server-side logout; and a written terms review.
 */

/** What the adapter is allowed to do to a customer's home: runs AS the customer's uid (see UserFsPort). Never reads credential files. */
export interface AsUser {
  /** Write a file inside the connection's home (e.g. Codex config.toml). `rel` is validated by the host: relative, no `..`, no symlink traversal. */
  writeFile(rel: string, content: string, mode?: number): Promise<void>;
}

export type ErrorKind = "usage_limit" | "auth_dead" | "transient" | "device_code_disabled" | "refresh_reused" | "policy_blocks" | "unknown";

export type Hazard =
  | { kind: "managed_settings_present" } //  org-delivered settings (Claude Team/Enterprise): hooks/env/apiKeyHelper can run in the process
  | { kind: "api_key_source"; source: string } // billing flipped off the subscription
  | { kind: "hook_event" } //                 an org-delivered hook ran
  | { kind: "policy_blocks_agentweb"; detail: string } // org policy makes the runtime unusable for AgentWeb
  | { kind: "other"; detail: string };

/** Normalised events a turn emits to the backend. Provider-specific raw events never leave the adapter. */
export type ProviderEvent =
  | { type: "text"; delta: string }
  /** With `toolTransport = "host_relay"` the backend must answer `operationId` through the host (turn.toolResult), within the host's tool-call timeout. */
  | { type: "tool-use"; operationId: string; name: string; input: unknown }
  | { type: "tool-result"; operationId: string; ok: boolean }
  /** Unknown stays unknown: a count the provider did not report is left out, never 0. */
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  | { type: "entitlement"; observation: EntitlementObservation }
  | { type: "alarm"; hazard: Hazard }
  | { type: "result"; ok: boolean; text: string; errorKind?: ErrorKind; /** Set by the host when it ended the turn (lease lapse, deadline, epoch change, alarm, restart). */ aborted?: string };

/** What the plan reported about its own limits; unknown stays unknown (never 0). */
export interface EntitlementObservation {
  windows: Array<{ name: string; utilization?: number; resetsAtMs?: number }>;
  status?: string;
  overage?: { using: boolean; status?: string };
}

export interface AuthStatus {
  loggedIn: boolean;
  /** e.g. "max", "pro", "team": from the CLI's status output, never from the credential file. */
  planLabel?: string;
  /** Non-secret account identifier if the provider offers one without reading tokens. */
  accountFingerprint?: string;
  orgPresent?: boolean;
}

/** A server-initiated request inside a turn that the host must answer (Codex `item/tool/call`, approvals, elicitation). */
export type ServerRequest =
  | { kind: "tool-call"; operationId: string; name: string; input: unknown }
  | { kind: "approval"; detail: string }
  | { kind: "elicitation"; detail: string };

export type ServerRequestAnswer = { kind: "tool-result"; ok: boolean; content: string } | { kind: "decline" };

export interface ProviderSession {
  /** Resolves when the session's process is gone for any reason (the provider closed it, it crashed, close() was called). The host retires the session then. */
  readonly closed: Promise<void>;
  /**
   * Cheap "can this login still make a turn?" check on the OPEN session (Codex: `account/read`;
   * its 401 only shows after turn/start otherwise). Runs on the session, never in a second process
   * on the same home.
   */
  preflight(): Promise<{ ok: true } | { ok: false; kind: ErrorKind }>;
  /** Run one turn; resolves the events as they arrive. Throws only for host-level faults; provider failures are `result` events with an errorKind. */
  turn(input: { turnId: string; prompt: string; model: string; bridgeToken: string }): AsyncIterable<ProviderEvent>;
  /** Answer a server-initiated request that was surfaced as a `tool-use` event (host-relayed tools). */
  answer(operationId: string, answer: ServerRequestAnswer): void;
  /** Stop ONE turn (several can share a process: Codex threads); the session stays usable where the provider supports it (Codex `turn/interrupt`), otherwise it closes. */
  interrupt(turnId: string): Promise<void>;
  close(): Promise<void>;
}

export interface LoginCeremonyData {
  url: string;
  /** Device-code ceremonies only. */
  userCode?: string;
}

export interface LoginProcess {
  readonly data: LoginCeremonyData;
}

export interface SessionSpec {
  connectionId: string;
  epoch: number;
}

export interface SpawnSpec {
  file: string;
  args: string[];
  /** The complete environment; nothing is inherited. */
  env: Record<string, string>;
  cwd: string;
}

/** A process started as the customer's uid, inside the host's hardening (systemd-run properties, later the sandbox). */
export interface ChildLike {
  stdin: import("stream").Writable;
  stdout: import("stream").Readable;
  stderr: import("stream").Readable;
  kill(): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
}

/**
 * Handed to the adapter by the host. The paths are host-internal: they are never sent to the
 * backend, and the adapter may point the CLI at them (CLAUDE_CONFIG_DIR / CODEX_HOME) but must
 * not read credential files inside them.
 */
export interface AdapterContext {
  connectionId: string;
  uid: number;
  homeDir: string;
  workDir: string;
  tmpDir: string;
  /** Start a process as this connection's uid with the host's hardening applied. */
  spawnAs(spec: SpawnSpec): ChildLike;
}

export interface SubscriptionProviderAdapter {
  readonly id: string;
  /** Name of the per-user funding flag (e.g. "claudeSubscription"). */
  readonly flagKey: string;
  /** The environment variable that points the CLI at its login home (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  readonly homeEnvVar: string;
  readonly ceremony: "paste_code" | "device_code";
  /**
   * How Emma's tools reach the provider. `mcp_direct`: the CLI calls the backend's bridge itself
   * (Claude). `host_relay`: the provider asks the host (server request / dynamic tool call) and the
   * backend answers through the host (Codex).
   *
   * CONTRACT for every adapter: approvals and elicitations a provider asks for are DECLINED by the
   * adapter (never approved) and surfaced as an `alarm`; the prompt, the sign-in code and the bridge
   * token reach the provider through stdin / the protocol, NEVER through argv or the environment
   * (a value starting with "-" must not be able to become a flag); no method reads a credential file.
   */
  readonly toolTransport: "mcp_direct" | "host_relay";
  /** Single-use refresh tokens (Codex) force 1; Claude's shared-dir behaviour was verified up to 8. */
  readonly maxProcessesPerHome: number;
  /** Concurrent turns one process can serve (Claude 1; Codex: many threads). */
  readonly maxTurnsPerProcess: number;
  readonly loginTtlMs: number;
  /** Allowlist of model names the backend may request. */
  readonly models: ReadonlySet<string>;

  /** Pinned binary: absolute path, version and content digest (checked on every upgrade). */
  binary(): { path: string; version: string; digest: string };
  /** Runs as the customer's uid through `asUser`; must not read credential files. */
  prepareHome(asUser: AsUser, ctx: AdapterContext): Promise<void>;


  loginStart(ctx: AdapterContext): Promise<LoginProcess>;
  /** paste_code ceremonies. */
  loginComplete?(proc: LoginProcess, code: string): Promise<void>;
  /** device_code ceremonies. */
  loginPoll?(proc: LoginProcess): Promise<"pending" | "done" | "failed">;
  loginCancel(proc: LoginProcess): Promise<void>;

  /** At sign-in time: `proc` is the still-open login process when the provider needs it (Codex asks its login app-server). */
  authStatus(ctx: AdapterContext, proc?: LoginProcess): Promise<AuthStatus>;
  hazards(ctx: AdapterContext): Promise<Hazard[]>;

  openSession(ctx: AdapterContext, spec: SessionSpec): Promise<ProviderSession>;

  mapError(raw: unknown): ErrorKind;
  /** Server-side revoke (Claude `auth logout` is verified to invalidate the login; Codex unverified). Best effort; runs after the host closed every session, so a short-lived process on the home is allowed. */
  logout(ctx: AdapterContext): Promise<void>;
  expiryModel(signedInAtMs: number): { refreshExpiresAtMs?: number } | undefined;
}
