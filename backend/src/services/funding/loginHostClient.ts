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
import { MAX_RATE_WINDOWS } from "../../loginHost/adapters/claudeParse";
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
  /** `signal`: aborts the request (the whole request, including a reply that is still arriving). */
  json(route: RouteName, body: unknown, opts?: { signal?: AbortSignal }): Promise<JsonReply>;
  /** Resolves when the host starts answering; a non-200 answer rejects with the host's error. `relay`: the turn carries a tool manifest (see streamPolicy). */
  stream(route: RouteName, body: unknown, opts?: { relay?: boolean }): Promise<StreamReply>;
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
  /** The longest NDJSON line of a turn stream (the final text of a turn is the big one). Default 8 MiB. */
  maxReplyBytes?: number;
  /** The longest body of an ordinary JSON reply (and of an error body). Default 64 KiB: see JSON_REPLY_BYTES. */
  maxJsonReplyBytes?: number;
}
/** @deprecated renamed: the options are shared by every transport. */
export type UnixSocketOptions = TransportOptions;

const DEFAULT_REPLY_BYTES = 8 * 1024 * 1024;
/**
 * The most a worker may answer on any non-stream route (host.info, connection.status, turn.renew, turn.interrupt, turn.toolResult, login.*, connection.revoke) and in an
 * error body. Every honest reply is a few hundred bytes (loginRef, a state and an epoch, a plan label, an error code); the old 8 MiB cap let a worker answer every renew
 * or the per-minute host.info check with a wide 8 MiB body that costs 0.5-0.7 s of JSON.parse and ~180 MB of heap in the main API process. No route needs more, so there
 * is no per-route override.
 */
export const JSON_REPLY_BYTES = 64 * 1024;

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

/**
 * What one turn.run stream may carry. A legitimate turn is tens to hundreds of events (a few KB each; the final text and a tool call's input are the big ones);
 * these are far above that and far below what stalls the API server (measured: 640k tiny events = 7.8 s of CPU; 700k-object `entitlement` line = ~5 s).
 */
export const MAX_STREAM_LINES = 20_000;
export const MAX_STREAM_BYTES = 64 * 1024 * 1024;
/**
 * The longest line per event type, in bytes, and what happens to a line over it. A legitimate event is far below all of these (measured on what the host can honestly
 * emit); a hostile worker's line costs the SHARED API process about 0.3-0.7 s of JSON.parse at the old 1.5 MiB (a nested array) or 8 MiB (an escape-heavy `text`), so
 * the caps sit just above the honest maximum and a line over one is thrown away unread where the backend does not need it, instead of ending the turn:
 *  - `text`: 64 KiB. The backend never reads a `text` event (the answer is `result.text`); a longer line is discarded.
 *  - `result`: 1 MiB. The final answer: the model's output is capped at 32,000 tokens (about 128-256 KB, AGENT_MODE_MAX_OUTPUT_TOKENS; the CLI allows up to 64,000), and the
 *    chat persists at most 350,000 bytes of a message (MAX_PERSISTED_MESSAGE_BYTES). Over 1 MiB the stream ends as BAD_RESPONSE `line_too_long`: the turn's outcome is
 *    unknown (what ran is kept) and nothing is silently truncated. At most one `result` line is read per stream.
 *  - `tool-use` on a RELAY turn (the stream's announcement of a call): 128 KiB. The dispatcher hashes an announced input only up to 64 KB; over the cap the line becomes a
 *    short "input too large" announcement of the same tool (the same thing the host sends for an input over 1 MiB), so grouping stays as it was for such a call.
 *  - `tool-call` on a RELAY turn (the call to execute): 320 KiB. The dispatcher refuses an input over 256 KiB (CALL_INPUT_MAX_BYTES) and the escaped JSON of an honest 256 KiB
 *    input can be somewhat larger; over the cap the line becomes a short call with `inputTooLarge`, which the dispatcher answers with ARGS_TOO_LARGE_MESSAGE.
 *  - `tool-use` on a LEGACY (bridgeToken) turn: unchanged, 1.5 MiB: the HTTP bridge records the announced input in the ledger. Only used with CLAUDE_PLAN_ALLOW_LEGACY_BRIDGE
 *    outside production.
 *  - everything else: 64 KB.
 */
export const LINE_CAPS = {
  tool: 1_536 * 1024,
  other: 64 * 1024,
  text: 64 * 1024,
  result: 1024 * 1024,
  relayToolUse: 128 * 1024,
  relayToolCall: 320 * 1024,
} as const;
/** More structure than this (`[` and `{` outside strings) in a tool event of a relay turn is not an honest tool input: the line is replaced as if it were over its cap. */
export const MAX_TOOL_STRUCTURES = 20_000;
/** Lines shorter than this cannot hold MAX_TOOL_STRUCTURES structures: they are not scanned. */
const STRUCTURE_SCAN_MIN_BYTES = 20_000;
/** The stream is handed back to the event loop after this many lines (a chunk can carry thousands: 20,000 tiny events were one 128 ms block). */
export const YIELD_EVERY_LINES = 64;
const TYPE_AT_START = /^\{"type":"([a-z-]{1,24})"/;
const typeOf = (head: Buffer): string | undefined => TYPE_AT_START.exec(head.toString("latin1"))?.[1];

/** What to do with the lines of one stream. `relay`: the turn carries a tool manifest (tool-call events are executed; tool-use ones only announce). */
function streamPolicy(relay: boolean) {
  return {
    /** The cap for a line, decided from its first bytes BEFORE the rest is read or parsed. A line whose type is not first is held to the small cap. */
    capFor(head: Buffer): number {
      const type = typeOf(head);
      if (type === "text") return LINE_CAPS.text;
      if (type === "result") return LINE_CAPS.result;
      if (type === "tool-use") return relay ? LINE_CAPS.relayToolUse : LINE_CAPS.tool;
      if (type === "tool-call") return relay ? LINE_CAPS.relayToolCall : LINE_CAPS.tool;
      return LINE_CAPS.other;
    },
    /** A line of this kind over its cap is discarded (and maybe replaced) instead of ending the stream. */
    skipsWhenTooLong(head: Buffer): boolean {
      const type = typeOf(head);
      if (type === "text") return true;
      if (relay && (type === "tool-use" || type === "tool-call")) return true;
      // Event types this client knows (plus `accepted`) end the stream; any OTHER type is discarded (a future host may add events).
      return type !== undefined && type !== "accepted" && !Object.prototype.hasOwnProperty.call(EVENT_SHAPES, type);
    },
    /** The short stand-in for a thrown-away tool line of a relay turn (same fields the host would have sent, the input replaced), or nothing. */
    replacement(head: Buffer): Buffer | undefined {
      return relay ? tooBigToolEvent(head) : undefined;
    },
  };
}

const TOOL_USE_HEAD = /^\{"type":"tool-use","operationId":"([^"\\]{1,256})","name":"([^"\\]{1,256})","input":/;
const TOOL_CALL_HEAD = /^\{"type":"tool-call","operationId":"([A-Za-z0-9_-]{1,64})","messageId":"([^"\\]{0,200})","name":"([^"\\]{1,200})","input":/;
/** The stand-in for a tool event whose input was too big to read, built from the fixed fields in front of it; nothing when the line is not in the host's own shape. */
function tooBigToolEvent(head: Buffer): Buffer | undefined {
  const text = head.toString("latin1");
  const use = TOOL_USE_HEAD.exec(text);
  if (use) return Buffer.from(JSON.stringify({ type: "tool-use", operationId: use[1], name: use[2], input: { _truncated: "size" } }));
  const call = TOOL_CALL_HEAD.exec(text);
  if (call) return Buffer.from(JSON.stringify({ type: "tool-call", operationId: call[1], messageId: call[2], name: call[3], input: null, inputTooLarge: true }));
  return undefined;
}
const TYPE_KEY = Buffer.from('"type"');
/**
 * `text` and `result` lines are flat (no nested objects) and are the only ones allowed to be big. JSON.parse takes the LAST of two `type` keys, while the cap above
 * is decided from the FIRST: `{"type":"text",...,"type":"usage"}` would get the big cap and be processed as another type. A flat line has exactly one `"type"`
 * (inside a string value every quote is escaped, so the text of a reply cannot add one). Scanned before parsing, linear time.
 */
function hasSecondTypeKey(line: Buffer): boolean {
  const first = line.indexOf(TYPE_KEY);
  return first >= 0 && line.indexOf(TYPE_KEY, first + TYPE_KEY.length) >= 0;
}
/** The most strings (keys and string values) a flat text/result line has outside its payload: honest ones have 4 to 8. */
const MAX_FLAT_STRINGS = 16;
/**
 * True when a big `text`/`result` line has any structure outside its strings: a nested `[` or `{`, or more than MAX_FLAT_STRINGS strings (a flat object of 400k keys).
 * Those lines are allowed to be megabytes only because they are ONE string; anything else is a hostile worker making JSON.parse and zod do real work. A linear scan
 * that jumps from quote to quote, so the payload string itself costs one indexOf.
 */
function hasStructureOutsideStrings(line: Buffer): boolean {
  const n = line.length;
  let strings = 0;
  let i = 1; // the first byte is the object's own `{`
  while (i < n) {
    const c = line[i];
    if (c === 0x22) {
      if (++strings > MAX_FLAT_STRINGS) return true;
      let j = i + 1;
      for (;;) {
        j = line.indexOf(0x22, j);
        if (j < 0) return false; // unterminated: the parse refuses it
        let backslashes = 0;
        for (let k = j - 1; k > i && line[k] === 0x5c; k--) backslashes++;
        if (backslashes % 2 === 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === 0x7b || c === 0x5b) return true;
    i++;
  }
  return false;
}
/**
 * How many `[` and `{` a line has OUTSIDE its strings, counted up to `limit` (a linear scan that jumps from quote to quote, so a big string costs one indexOf and a
 * bracket inside it is not counted). The cost of JSON.parse is in this structure, not in the bytes: `[[[0]]],` repeated to 1.5 MiB was a 330-680 ms stall.
 */
function structuresOutsideStrings(line: Buffer, limit: number): number {
  const n = line.length;
  let count = 0;
  let i = 1;
  while (i < n) {
    const c = line[i];
    if (c === 0x22) {
      let j = i + 1;
      for (;;) {
        j = line.indexOf(0x22, j);
        if (j < 0) return count; // unterminated: the parse refuses it
        let backslashes = 0;
        for (let k = j - 1; k > i && line[k] === 0x5c; k--) backslashes++;
        if (backslashes % 2 === 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if ((c === 0x7b || c === 0x5b) && ++count > limit) return count;
    i++;
  }
  return count;
}
function limitHit(code: string): LoginHostError {
  console.error("[login-host-client] stream_limit", { code });
  return new LoginHostError("BAD_RESPONSE", code);
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
  json(route: RouteName, body: unknown, opts: { signal?: AbortSignal } = {}): Promise<JsonReply> {
    return this.jsonInner(route, body, opts.signal).catch((e) => {
      throw mapSocketError(e);
    });
  }

  stream(route: RouteName, body: unknown, opts: { relay?: boolean } = {}): Promise<StreamReply> {
    return this.streamInner(route, body, opts.relay === true).catch((e) => {
      throw mapSocketError(e);
    });
  }

  private jsonInner(route: RouteName, body: unknown, signal?: AbortSignal): Promise<JsonReply> {
    const maxBytes = this.opts.maxJsonReplyBytes ?? JSON_REPLY_BYTES;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new LoginHostError("EBUSY", "aborted_while_waiting"));
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
      // An ABSOLUTE limit for the whole request, the reply body included. `req.setTimeout` is an idle timer: a worker that drips one byte every few seconds never trips
      // it, and with a 64 KiB reply cap one reply could last weeks (and pin the memory of whatever waits for it).
      const absolute = setTimeout(() => req.destroy(timeoutError("request")), this.opts.requestTimeoutMs ?? 60_000);
      absolute.unref?.();
      const onAbort = () => {
        req.destroy();
        reject(new LoginHostError("EBUSY", "aborted_while_waiting"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        clearTimeout(absolute);
        signal?.removeEventListener("abort", onAbort);
      };
      req.once("close", done);
      req.on("error", (e) => reject(mapSocketError(e)));
      req.end(payload);
    });
  }

  private streamInner(route: RouteName, body: unknown, relay: boolean): Promise<StreamReply> {
    const maxLine = this.opts.maxReplyBytes ?? DEFAULT_REPLY_BYTES;
    const policy = streamPolicy(relay);
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = this.conn.request(
        { ...this.conn.base, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          clearTimeout(startTimer);
          if (res.statusCode !== 200) {
            const chunks: Buffer[] = [];
            let errBytes = 0;
            // the error body is bounded in time as well as in size (a drip must not hold the call)
            const errTimer = setTimeout(() => req.destroy(timeoutError("request")), this.opts.requestTimeoutMs ?? 60_000);
            errTimer.unref?.();
            req.once("close", () => clearTimeout(errTimer));
            const errMax = this.opts.maxJsonReplyBytes ?? JSON_REPLY_BYTES;
            res.on("data", (c: Buffer) => {
              errBytes += c.length;
              if (errBytes > errMax) {
                // an error body is small: a bigger one is never read to the end nor parsed
                req.destroy();
                reject(hostErrorFrom(res.statusCode ?? 0, undefined));
                return;
              }
              chunks.push(c);
            });
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
            // Bounded BEFORE anything is parsed: a per-type cap on each line (see lineCapFor), and per-turn caps on how many lines and how many bytes one stream
            // may carry. A hostile worker's flood of tiny events, or one near-8 MiB event of a type that is never that big, costs a few bytes of scanning, not seconds.
            const splitter = new LineSplitter(maxLine, () => limitHit("line_too_long"), policy.capFor, policy.skipsWhenTooLong, () => limitHit("too_many_empty_lines"), policy.replacement);
            let count = 0;
            let bytes = 0;
            let sinceYield = 0;
            let resultSeen = false;
            try {
              for await (const chunk of res as AsyncIterable<Buffer>) {
                bytes += chunk.length;
                if (bytes > MAX_STREAM_BYTES) throw limitHit("too_many_bytes");
                for (const line of splitter.push(chunk)) {
                  if (++count > MAX_STREAM_LINES) throw limitHit("too_many_events");
                  // Hand the event loop back every few lines: a chunk can carry thousands, and the parse of each is work for the SHARED API process.
                  if (++sinceYield >= YIELD_EVERY_LINES) {
                    sinceYield = 0;
                    await new Promise<void>((r) => setImmediate(r));
                  }
                  const headType = typeOf(line.subarray(0, 48));
                  // A host sends exactly one `result`; a second one is never read (each is up to 1 MiB of parse for nothing).
                  if (headType === "result") {
                    if (resultSeen) continue;
                    resultSeen = true;
                  }
                  let toParse = line;
                  if (relay && line.length > STRUCTURE_SCAN_MIN_BYTES && (headType === "tool-use" || headType === "tool-call") && structuresOutsideStrings(line, MAX_TOOL_STRUCTURES) > MAX_TOOL_STRUCTURES) {
                    // Far more nesting than any honest tool input has: the same stand-in as for a line over the cap (JSON.parse of it was a 300-700 ms stall).
                    const stand = tooBigToolEvent(line.subarray(0, 1024));
                    if (!stand) throw limitHit("too_complex");
                    toParse = stand;
                  }
                  // A line nested deeper than anything legitimate is dropped unparsed (JSON.parse would stall the event loop) and ends the stream.
                  if (jsonTooDeep(toParse)) throw tooDeep(toParse.length);
                  // Only text/result/tool lines may be this big (see LINE_CAPS), and the cap was decided from the FIRST `type`: for the flat ones it must be the only one.
                  const big = toParse.length > LINE_CAPS.other;
                  if (big && (headType === "text" || headType === "result") && hasSecondTypeKey(toParse)) throw limitHit("duplicate_type");
                  if (big && (headType === "text" || headType === "result") && hasStructureOutsideStrings(toParse)) throw limitHit("not_flat");
                  let parsed: unknown;
                  try {
                    parsed = JSON.parse(toParse.toString("utf8"));
                  } catch {
                    throw new LoginHostError("BAD_RESPONSE", "line");
                  }
                  if (big && headType !== undefined && (parsed as { type?: unknown } | null)?.type !== headType) throw limitHit("type_mismatch"); // JSON.parse took another `type`
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
  "tool-use": z.object({ operationId: z.string().max(256), name: z.string().max(256), input: z.unknown() }),
  // ENG-2113 relay: a host-generated operation the backend must answer. `name` and `input` are NOT trusted here (the dispatcher re-validates them against the
  // run's tool list); only the envelope is checked. A bad envelope is a bad answer from the host, never something to execute.
  "tool-call": z.object({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), messageId: z.string().max(200), name: z.string().max(200), input: z.unknown(), inputTooLarge: z.boolean().optional() }),
  "tool-result": z.object({ operationId: z.string().max(256), ok: z.boolean() }),
  usage: z.object({ inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count }),
  entitlement: z.object({ observation: z.object({ windows: z.array(z.object({ name: z.string().max(64), utilization: z.number().optional(), resetsAtMs: z.number().optional() })).max(MAX_RATE_WINDOWS) }) }),
  alarm: z.object({ hazard: z.unknown() }),
  result: z.object({ ok: z.boolean(), text: z.string(), errorKind: z.string().max(64).optional(), aborted: z.string().max(64).optional() }),
};

export interface TurnStream {
  turnId: string;
  /** True when the host already knew this idempotency key: `events` is empty and `status` says how that turn stands. */
  duplicate: boolean;
  status?: "running" | "finished" | "failed" | "aborted";
  events: AsyncIterable<ProviderEvent>;
  close(): void;
}

/** Resolves with `p`, or rejects as soon as the signal aborts; a value that arrives after an abort is handed to `discard` (it must be closed, nobody will use it). */
function abortable<T>(p: Promise<T>, signal: AbortSignal | undefined, discard: (late: T) => void): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      reject(new LoginHostError("EBUSY", "aborted_while_waiting"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        if (aborted) discard(v);
        else resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        if (!aborted) reject(e);
      },
    );
  });
}

/** The first stream read, bounded by `ms` and by the abort signal; on either the stream is closed. */
function readFirst<T>(read: Promise<T>, ms: number, signal: AbortSignal | undefined, close: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () =>
      finish(() => {
        close();
        reject(new LoginHostError("EBUSY", "aborted_while_waiting"));
      });
    const timer = setTimeout(
      () =>
        finish(() => {
          close();
          reject(new LoginHostError("TIMEOUT", "start"));
        }),
      ms,
    );
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    read.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

export class LoginHostClient {
  constructor(private readonly transport: HostTransport) {}

  private async call<R extends RouteName, T>(route: R, input: RouteInput<R>, shape: z.ZodType<T>, opts?: { signal?: AbortSignal }): Promise<T> {
    // Our own schema first: a caller bug (a field the host would refuse) fails here without a round trip.
    const body = ROUTES[route].parse(input);
    const reply = await (opts?.signal ? this.transport.json(route, body, { signal: opts.signal }) : this.transport.json(route, body));
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
  async turnToolResult(input: RouteInput<"turn.toolResult">, opts?: { signal?: AbortSignal }): Promise<{ ok: true }> {
    try {
      return await this.call("turn.toolResult", input, z.object({ ok: z.literal(true) }), opts);
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
  async turnRun(input: RouteInput<"turn.run">, opts: { signal?: AbortSignal; startTimeoutMs?: number } = {}): Promise<TurnStream> {
    const body = ROUTES["turn.run"].parse(input);
    if (opts.signal?.aborted) throw new LoginHostError("EBUSY", "aborted_while_waiting");
    // The connection and the response headers are bounded by the transport's own timers; a Stop must not wait for them either.
    // A turn that carries a tool manifest is a RELAY turn (its tool events are bounded for that: see streamPolicy); one with a bridgeToken is the legacy HTTP-bridge turn.
    const relay = Array.isArray((body as { tools?: unknown }).tools);
    const reply = await abortable(this.transport.stream("turn.run", body, { relay }), opts.signal, (r) => r.close());
    const it = reply.lines[Symbol.asyncIterator]();
    let first: IteratorResult<unknown>;
    try {
      // The first line (`accepted`) is raced against a time limit AND the Stop: a worker that answers with headers and then says nothing must not make the turn
      // un-stoppable (and the session host_busy).
      first = await readFirst(it.next(), opts.startTimeoutMs ?? 30_000, opts.signal, () => reply.close());
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
