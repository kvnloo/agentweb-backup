/**
 * ENG-2110: the backend's client for the login host (src/loginHost).
 *
 * The host owns every customer login; this client only speaks its closed protocol. Nothing here ever reads, stores or logs a token,
 * a sign-in code, a prompt or a response body: errors carry a code and (for host errors) the short detail the host chose.
 *
 * Two transports reach the same closed API:
 *   - `MutualTlsTransport`: PRODUCTION. The worker is a separate machine; TLS 1.3 with a client certificate on both ends (see the class).
 *   - `UnixSocketTransport`: the test environment, where the host's socket directory is bind-mounted into the backend container.
 *
 * Protocol compatibility: the backend deploys on every merge, the worker by hand. See PROTOCOL_VERSION in loginHost/protocol.ts for the
 * deploy-order rule; `hostInfo()` lets the provider compare versions.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "http";
import { request as httpsRequest } from "https";
import { z } from "zod";
import type { ProviderEvent } from "../../loginHost/adapter";
import type { LoginReady, LoginStartResult } from "../../loginHost/connectionManager";
import { jsonTooDeep } from "./jsonDepthGuard";
import { LineSplitter } from "./ndjsonLines";
import { ROUTES, type HostErrorCode, type RouteInput, type RouteName } from "../../loginHost/protocol";

const HOST_CODES: ReadonlySet<string> = new Set<HostErrorCode>(["EINVALID", "ENOTFOUND", "ESTALE", "ESTATE", "EBUSY", "EEXISTS", "EUNSUPPORTED", "EHAZARD", "EINTERNAL"]);

/**
 * The tool relay's "result lost" answers to `turn.toolResult`: the turn was ended by the host (`ESTALE turn_aborted`), the operation is not pending any more
 * (`ENOTFOUND operation_unknown`: never issued, already answered, timed out, or the turn is gone) or the provider's own timer fired first (`ESTALE result_lost`).
 * In all three the tool MAY HAVE RUN; only the answer did not arrive. This is deliberately NOT a LoginHostError: on every other route a bare ENOTFOUND means
 * "no such connection" and has a destructive meaning for revoke and the sweeper (protocol.ts), and this route must never be mistaken for that.
 */
export type ToolResultLostReason = "turn_aborted" | "operation_unknown" | "result_lost";
export class ToolResultLostError extends Error {
  constructor(readonly reason: ToolResultLostReason) {
    super(`tool result lost (${reason})`);
    this.name = "ToolResultLostError";
  }
}

export type LoginHostErrorCode = HostErrorCode | "UNREACHABLE" | "TIMEOUT" | "BAD_RESPONSE";

/** A failed host call. `code` and `detail` are safe to log; neither can contain a path, token or code. */
export class LoginHostError extends Error {
  constructor(readonly code: LoginHostErrorCode, readonly detail?: string) {
    super(code);
    this.name = "LoginHostError";
  }
  /** The host refused for capacity and says it is fine to ask again. */
  get busy(): boolean {
    return this.code === "EBUSY";
  }
  /**
   * The request provably never reached the host: the connection was refused or unroutable, or never got established in time. This is what a
   * caller sees during a worker restart, and it is always safe to repeat (nothing was admitted), unlike a reset or a timeout AFTER connecting.
   * Certificate failures are NOT in here: they will not fix themselves in a few seconds.
   */
  get notSent(): boolean {
    if (this.code === "TIMEOUT") return this.detail === "connect";
    return this.code === "UNREACHABLE" && (this.detail === "ECONNREFUSED" || this.detail === "EHOSTUNREACH" || this.detail === "ENETUNREACH" || this.detail === "ENOENT");
    // (ECONNRESET is deliberately not here: it can come after the request was sent.)
  }
  /** The call may or may not have reached the host (no usable answer). */
  get ambiguous(): boolean {
    return this.code === "UNREACHABLE" || this.code === "TIMEOUT" || this.code === "BAD_RESPONSE";
  }
}

export interface JsonReply {
  status: number;
  json: unknown;
}

export interface StreamReply {
  /** Parsed NDJSON lines, in order. Ends when the host closes the stream. */
  lines: AsyncIterable<unknown>;
  /** Drops the connection (the host then ends the turn: a dropped stream means the caller is gone). */
  close(): void;
}

export interface HostTransport {
  json(route: RouteName, body: unknown): Promise<JsonReply>;
  /** Resolves when the host starts answering; a non-200 answer rejects with the host's error. */
  stream(route: RouteName, body: unknown): Promise<StreamReply>;
}

export interface TransportOptions {
  /**
   * The connection (TCP, and for TLS the handshake) must be established within this. Default 5 s. Node's own request timeouts only start
   * counting AFTER the connect, so a stopped instance or a security group that drops packets would otherwise take the kernel's ~130 s of
   * SYN retries to fail, longer than the load balancer waits for a user's request.
   */
  connectTimeoutMs?: number;
  /** A one-shot call (everything except `turn.run`) must answer within this. Default 60 s (host adapter calls are bounded at 60 s). */
  requestTimeoutMs?: number;
  /** `turn.run` must start answering (`accepted`) within this. Default 30 s. */
  streamStartTimeoutMs?: number;
  maxReplyBytes?: number;
}
/** @deprecated renamed: the options are shared by every transport. */
export type UnixSocketOptions = TransportOptions;

const DEFAULT_REPLY_BYTES = 8 * 1024 * 1024;

/**
 * The causes an operator needs to tell apart (an expired or mismatched certificate, a refused or reset connection, a TLS alert, a
 * timeout) all arrive as `err.code`. Only codes of these exact shapes are kept, never message text, so a cause can be logged safely.
 */
const CAUSE_CODE = /^(?:E[A-Z]{3,12}|CERT_[A-Z_]{2,40}|ERR_TLS_[A-Z_]{1,60}|ERR_SSL_[A-Z0-9_]{1,60}|ERR_OSSL_[A-Z0-9_]{1,60}|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|HOSTNAME_MISMATCH)$/;

type Phase = "connect" | "request" | "start";
/** An ETIMEDOUT we raised ourselves, tagged with the phase that timed out. */
function timeoutError(phase: Phase): Error {
  return Object.assign(new Error("timeout"), { code: "ETIMEDOUT", awPhase: phase });
}

/** A reply nested deeper than MAX_JSON_DEPTH: logged by length only (a fixed code, never content), then a bad answer from the host. */
function logTooDeep(bytes: number): void {
  console.error("[login-host-client] json_too_deep", { bytes });
}
function tooDeep(bytes: number): LoginHostError {
  logTooDeep(bytes);
  return new LoginHostError("BAD_RESPONSE", "too_deep");
}

function mapSocketError(err: unknown): LoginHostError {
  if (err instanceof LoginHostError) return err;
  const code = (err as { code?: string })?.code;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    const phase = (err as { awPhase?: string }).awPhase;
    return new LoginHostError("TIMEOUT", phase === "connect" || phase === "request" || phase === "start" ? phase : undefined);
  }
  return new LoginHostError("UNREACHABLE", typeof code === "string" && CAUSE_CODE.test(code) ? code : undefined);
}

/**
 * Fails the request fast if the connection is not established in `ms` (see TransportOptions.connectTimeoutMs). Armed at once, cleared
 * when the socket is connected (`secureConnect` for TLS: the handshake is part of connecting). Deliberately NOT the `timeout` option:
 * that would also cut a long, legitimately silent streaming turn.
 */
function failFastConnect(req: ClientRequest, ms: number, secure: boolean): void {
  const timer = setTimeout(() => req.destroy(timeoutError("connect")), ms);
  timer.unref?.();
  const clear = () => clearTimeout(timer);
  req.once("socket", (socket) => {
    if (!secure && !socket.connecting) return clear(); // a plain socket that is already connected (never the case with agent:false, kept for safety)
    socket.once(secure ? "secureConnect" : "connect", clear);
  });
  req.once("close", clear);
}

/** A host error body is `{error: CODE, detail?}`; anything else is a bad answer, never echoed. */
function hostErrorFrom(status: number, json: unknown): LoginHostError {
  if (json && typeof json === "object") {
    const { error, detail } = json as { error?: unknown; detail?: unknown };
    if (typeof error === "string" && HOST_CODES.has(error)) {
      return new LoginHostError(error as HostErrorCode, typeof detail === "string" && /^[A-Za-z0-9_.:,-]{1,120}$/.test(detail) ? detail : undefined);
    }
  }
  return new LoginHostError("BAD_RESPONSE", `http_${status}`);
}

/** How a transport reaches the host: which request function and the connection part of the options. */
interface Connector {
  request: (options: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest;
  base: RequestOptions & Record<string, unknown>;
  /** TLS: the connection is only up after the handshake. */
  secure?: boolean;
}

class NodeTransport implements HostTransport {
  constructor(private readonly conn: Connector, private readonly opts: TransportOptions = {}) {}

  /**
   * Every failure leaves as a LoginHostError. `https.request` can THROW synchronously (a client certificate and key that do not match, a
   * malformed PEM after a bad rotation): inside the promise that would surface as a raw Error with OpenSSL text, which the callers' error
   * handling does not recognise. The cause code is kept, never the message.
   */
  json(route: RouteName, body: unknown): Promise<JsonReply> {
    return this.jsonInner(route, body).catch((e) => {
      throw mapSocketError(e);
    });
  }

  stream(route: RouteName, body: unknown): Promise<StreamReply> {
    return this.streamInner(route, body).catch((e) => {
      throw mapSocketError(e);
    });
  }

  private jsonInner(route: RouteName, body: unknown): Promise<JsonReply> {
    const maxBytes = this.opts.maxReplyBytes ?? DEFAULT_REPLY_BYTES;
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = this.conn.request(
        { ...this.conn.base, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
              req.destroy();
              reject(new LoginHostError("BAD_RESPONSE", "too_large"));
              return;
            }
            chunks.push(c);
          });
          res.on("error", (e) => reject(mapSocketError(e)));
          res.on("end", () => {
            try {
              const raw = Buffer.concat(chunks);
              if (jsonTooDeep(raw)) throw tooDeep(raw.length);
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw.toString("utf8")) });
            } catch (e) {
              reject(e instanceof LoginHostError ? e : new LoginHostError("BAD_RESPONSE", `http_${res.statusCode ?? 0}`));
            }
          });
        },
      );
      failFastConnect(req, this.opts.connectTimeoutMs ?? 5_000, this.conn.secure === true);
      req.setTimeout(this.opts.requestTimeoutMs ?? 60_000, () => req.destroy(timeoutError("request")));
      req.on("error", (e) => reject(mapSocketError(e)));
      req.end(payload);
    });
  }

  private streamInner(route: RouteName, body: unknown): Promise<StreamReply> {
    const maxLine = this.opts.maxReplyBytes ?? DEFAULT_REPLY_BYTES;
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = this.conn.request(
        { ...this.conn.base, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          clearTimeout(startTimer);
          if (res.statusCode !== 200) {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.length < 64 && chunks.push(c));
            res.on("error", (e) => reject(mapSocketError(e)));
            res.on("end", () => {
              let json: unknown;
              try {
                const raw = Buffer.concat(chunks);
                if (jsonTooDeep(raw)) logTooDeep(raw.length);
                else json = JSON.parse(raw.toString("utf8"));
              } catch {
                /* falls through to BAD_RESPONSE */
              }
              reject(hostErrorFrom(res.statusCode ?? 0, json));
            });
            return;
          }
          const lines = (async function* (): AsyncGenerator<unknown> {
            const splitter = new LineSplitter(maxLine, () => new LoginHostError("BAD_RESPONSE", "too_large"));
            res.setEncoding("utf8");
            try {
              for await (const chunk of res as AsyncIterable<string>) {
                for (const line of splitter.push(chunk)) {
                  // A line nested deeper than anything legitimate is dropped unparsed (JSON.parse would stall the event loop) and ends the stream.
                  if (jsonTooDeep(line)) throw tooDeep(line.length);
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(line);
                  } catch {
                    throw new LoginHostError("BAD_RESPONSE", "line");
                  }
                  yield parsed;
                }
              }
            } catch (e) {
              // A cut connection ends the stream as an error the caller treats as "outcome unknown".
              throw mapSocketError(e);
            }
          })();
          resolve({ lines, close: () => req.destroy() });
        },
      );
      failFastConnect(req, this.opts.connectTimeoutMs ?? 5_000, this.conn.secure === true);
      const startTimer = setTimeout(() => req.destroy(timeoutError("start")), this.opts.streamStartTimeoutMs ?? 30_000);
      startTimer.unref?.();
      req.on("error", (e) => {
        clearTimeout(startTimer);
        reject(mapSocketError(e));
      });
      req.end(payload);
    });
  }
}

/** The host on the same machine, over its unix socket (the test environment; the socket directory is the access gate). */
export class UnixSocketTransport extends NodeTransport {
  constructor(socketPath: string, opts: TransportOptions = {}) {
    super({ request: httpRequest, base: { socketPath, agent: false } }, opts);
  }
}

export interface MutualTlsTarget {
  /** The worker's address (an IP or a name that appears in the server certificate's SAN). */
  host: string;
  port: number;
  /** This backend's client certificate and key, and the CA that signed the worker's certificate. PEM. */
  cert: string | Buffer;
  key: string | Buffer;
  ca: string | Buffer;
}

/**
 * The host on ANOTHER machine, over mutual TLS: TLS 1.3 only, the worker's certificate must chain to `ca` AND name `host`, and the worker
 * only talks to a client certificate its CA signed with the backend's identity. No keep-alive pool (a restarted host would leave stale sockets).
 */
export class MutualTlsTransport extends NodeTransport {
  constructor(target: MutualTlsTarget, opts: TransportOptions = {}) {
    super({ request: httpsRequest as Connector["request"], secure: true, base: { host: target.host, port: target.port, cert: target.cert, key: target.key, ca: target.ca, minVersion: "TLSv1.3", rejectUnauthorized: true, agent: false } }, opts);
  }
}

// ---- reply shapes: only what the backend relies on; extra fields are ignored, wrong shapes are BAD_RESPONSE ----
const stateReply = z.object({ state: z.string(), epoch: z.number().int() });
const revokeReply = stateReply.extend({ cleanupConfirmed: z.boolean() });
const statusReply = stateReply.extend({ runningTurns: z.number().int(), planLabel: z.string().optional(), reason: z.string().optional() });
const loginStartReply = z.object({
  loginRef: z.string(),
  ceremony: z.enum(["paste_code", "device_code"]),
  url: z.string(),
  userCode: z.string().optional(),
  expiresAtMs: z.number(),
});
const loginReadyReply = z.object({ status: z.literal("ready"), planLabel: z.string().optional(), accountFingerprint: z.string().optional(), refreshExpiresAtMs: z.number().optional(), completionNonce: z.string().optional() });
const loginStatusReply = z.union([loginReadyReply, z.object({ status: z.enum(["pending", "failed"]) })]);
const renewReply = z.object({ leaseMs: z.number().int().positive() });
const hostInfoReply = z.object({ protocol: z.number().int().min(0), node: z.string().max(40), uptimeSec: z.number().int().min(0) });
const acceptedLine = z.object({ type: z.literal("accepted"), turnId: z.string(), duplicate: z.boolean(), status: z.enum(["running", "finished", "failed", "aborted"]).optional() });

const count = z.number().finite().nonnegative().optional();
/** Known events are checked field by field; unknown types are dropped. A known type with wrong fields is BAD_RESPONSE. */
const EVENT_SHAPES: Record<string, z.ZodTypeAny> = {
  text: z.object({ delta: z.string() }),
  "tool-use": z.object({ operationId: z.string(), name: z.string(), input: z.unknown() }),
  // ENG-2113 relay: a host-generated operation the backend must answer. `name` and `input` are NOT trusted here (the dispatcher re-validates them against the
  // run's tool list); only the envelope is checked. A bad envelope is a bad answer from the host, never something to execute.
  "tool-call": z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), messageId: z.string().max(200), name: z.string().max(200), input: z.unknown() }),
  "tool-result": z.object({ operationId: z.string(), ok: z.boolean() }),
  usage: z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count }),
  entitlement: z.object({ observation: z.object({ windows: z.array(z.object({ name: z.string(), utilization: z.number().optional(), resetsAtMs: z.number().optional() })) }) }),
  alarm: z.object({ hazard: z.unknown() }),
  result: z.object({ ok: z.boolean(), text: z.string(), errorKind: z.string().optional(), aborted: z.string().optional() }),
};

export interface TurnStream {
  turnId: string;
  /** True when the host already knew this idempotency key: `events` is empty and `status` says how that turn stands. */
  duplicate: boolean;
  status?: "running" | "finished" | "failed" | "aborted";
  events: AsyncIterable<ProviderEvent>;
  close(): void;
}

export class LoginHostClient {
  constructor(private readonly transport: HostTransport) {}

  private async call<R extends RouteName, T>(route: R, input: RouteInput<R>, shape: z.ZodType<T>): Promise<T> {
    // Our own schema first: a caller bug (a field the host would refuse) fails here without a round trip.
    const body = ROUTES[route].parse(input);
    const reply = await this.transport.json(route, body);
    if (reply.status < 200 || reply.status >= 300) throw hostErrorFrom(reply.status, reply.json);
    const parsed = shape.safeParse(reply.json);
    if (!parsed.success) throw new LoginHostError("BAD_RESPONSE", route);
    return parsed.data;
  }

  loginStart(input: RouteInput<"login.start">): Promise<LoginStartResult> {
    return this.call("login.start", input, loginStartReply);
  }
  loginComplete(input: RouteInput<"login.complete">): Promise<LoginReady> {
    return this.call("login.complete", input, loginReadyReply);
  }
  loginStatus(input: RouteInput<"login.status">): Promise<{ status: "pending" | "failed" } | LoginReady> {
    return this.call("login.status", input, loginStatusReply);
  }
  loginCancel(input: RouteInput<"login.cancel">): Promise<{ cancelled: true }> {
    return this.call("login.cancel", input, z.object({ cancelled: z.literal(true) }));
  }
  loginPromote(input: RouteInput<"login.promote">): Promise<{ state: string; epoch: number }> {
    return this.call("login.promote", input, stateReply);
  }
  connectionDisable(input: RouteInput<"connection.disable">): Promise<{ state: string; epoch: number }> {
    return this.call("connection.disable", input, stateReply);
  }
  connectionEnable(input: RouteInput<"connection.enable">): Promise<{ state: string; epoch: number }> {
    return this.call("connection.enable", input, stateReply);
  }
  /** Idempotent. Done only when the answer's `state` is "revoked"; otherwise ask again later. */
  connectionRevoke(input: RouteInput<"connection.revoke">): Promise<{ state: string; epoch: number; cleanupConfirmed: boolean }> {
    return this.call("connection.revoke", input, revokeReply);
  }
  connectionStatus(input: RouteInput<"connection.status">): Promise<{ state: string; epoch: number; runningTurns: number; planLabel?: string; reason?: string }> {
    return this.call("connection.status", input, statusReply);
  }
  /** The worker's protocol version (see PROTOCOL_VERSION in loginHost/protocol.ts). An older worker answers EINVALID/route. */
  hostInfo(): Promise<{ protocol: number; node: string; uptimeSec: number }> {
    return this.call("host.info", {}, hostInfoReply);
  }
  turnRenew(input: RouteInput<"turn.renew">): Promise<{ leaseMs: number }> {
    return this.call("turn.renew", input, renewReply);
  }
  turnInterrupt(input: RouteInput<"turn.interrupt">): Promise<{ interrupted: true }> {
    return this.call("turn.interrupt", input, z.object({ interrupted: z.literal(true) }));
  }
  /**
   * Answer to a `tool-call` event of a relay turn (protocol 4: `{operationId, content, isError?, images?, tools?}`; the host replies `{ok:true}`).
   * Resolves only when the host accepted the answer. Rejects with ToolResultLostError for the three "result lost" answers (see there), with a
   * LoginHostError for anything else (EINVALID `result_too_large` / `tools_invalid` / `tools_limit` / `tools:<reason>` leave the operation pending, so the caller may retry with a valid answer).
   */
  async turnToolResult(input: RouteInput<"turn.toolResult">): Promise<{ ok: true }> {
    try {
      return await this.call("turn.toolResult", input, z.object({ ok: z.literal(true) }));
    } catch (err) {
      if (err instanceof LoginHostError) {
        // Any ESTALE or ENOTFOUND on THIS route is "the answer cannot be taken", whatever the detail (an older or newer host may word it differently).
        if (err.code === "ESTALE") throw new ToolResultLostError(err.detail === "result_lost" ? "result_lost" : "turn_aborted");
        if (err.code === "ENOTFOUND") throw new ToolResultLostError("operation_unknown");
      }
      throw err;
    }
  }

  /**
   * Starts a turn. Resolves once the host has admitted it (or already knew the idempotency key).
   * Rejects with `EBUSY` when the host is full; with an ambiguous error when no usable answer arrived
   * (the turn may or may not exist: ask again with the SAME idempotency key, never a new one).
   */
  async turnRun(input: RouteInput<"turn.run">): Promise<TurnStream> {
    const body = ROUTES["turn.run"].parse(input);
    const reply = await this.transport.stream("turn.run", body);
    const it = reply.lines[Symbol.asyncIterator]();
    let first: IteratorResult<unknown>;
    try {
      first = await it.next();
    } catch (err) {
      reply.close();
      throw err instanceof LoginHostError ? err : new LoginHostError("UNREACHABLE");
    }
    const accepted = first.done ? undefined : acceptedLine.safeParse(first.value);
    if (!accepted?.success) {
      reply.close();
      throw new LoginHostError("BAD_RESPONSE", "accepted");
    }
    const { turnId, duplicate, status } = accepted.data;
    const events = (async function* (): AsyncGenerator<ProviderEvent> {
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        const v = next.value as { type?: unknown };
        if (!v || typeof v !== "object" || typeof v.type !== "string") throw new LoginHostError("BAD_RESPONSE", "event");
        // An event type this client does not know is dropped, not guessed at; a known one with wrong fields is a bad answer.
        const shape = Object.prototype.hasOwnProperty.call(EVENT_SHAPES, v.type) ? EVENT_SHAPES[v.type] : undefined;
        if (!shape) continue;
        if (!shape.safeParse(next.value).success) throw new LoginHostError("BAD_RESPONSE", "event");
        yield next.value as ProviderEvent;
      }
    })();
    return { turnId, duplicate, ...(status ? { status } : {}), events, close: () => reply.close() };
  }
}
