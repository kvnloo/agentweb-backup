/**
 * ENG-2110 PR 1c-i: the backend's client for the login host (src/loginHost).
 *
 * The host owns every customer login; this client only speaks its closed protocol. Nothing here ever
 * reads, stores or logs a token, a sign-in code, a prompt or a response body: errors carry a code and
 * (for host errors) the short detail the host chose. The transport is injectable because the production
 * path between the backend (Elastic Beanstalk) and the shared worker is not decided yet; the unix-socket
 * transport below is what the test environment uses (socket directory bind-mounted into the backend).
 */
import { request } from "http";
import { z } from "zod";
import type { ProviderEvent } from "../../loginHost/adapter";
import type { LoginReady, LoginStartResult } from "../../loginHost/connectionManager";
import { ROUTES, type HostErrorCode, type RouteInput, type RouteName } from "../../loginHost/protocol";

const HOST_CODES: ReadonlySet<string> = new Set<HostErrorCode>(["EINVALID", "ENOTFOUND", "ESTALE", "ESTATE", "EBUSY", "EEXISTS", "EUNSUPPORTED", "EHAZARD", "EINTERNAL"]);

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

export interface UnixSocketOptions {
  /** A one-shot call (everything except `turn.run`) must answer within this. Default 60 s (host adapter calls are bounded at 60 s). */
  requestTimeoutMs?: number;
  /** `turn.run` must start answering (`accepted`) within this. Default 30 s. */
  streamStartTimeoutMs?: number;
  maxReplyBytes?: number;
}

const DEFAULT_REPLY_BYTES = 8 * 1024 * 1024;

function mapSocketError(err: unknown): LoginHostError {
  if (err instanceof LoginHostError) return err;
  const code = (err as { code?: string })?.code;
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return new LoginHostError("TIMEOUT");
  return new LoginHostError("UNREACHABLE", typeof code === "string" && /^E[A-Z]{3,12}$/.test(code) ? code : undefined);
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

export class UnixSocketTransport implements HostTransport {
  constructor(private readonly socketPath: string, private readonly opts: UnixSocketOptions = {}) {}

  json(route: RouteName, body: unknown): Promise<JsonReply> {
    const maxBytes = this.opts.maxReplyBytes ?? DEFAULT_REPLY_BYTES;
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        { socketPath: this.socketPath, agent: false, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
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
              resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            } catch {
              reject(new LoginHostError("BAD_RESPONSE", `http_${res.statusCode ?? 0}`));
            }
          });
        },
      );
      req.setTimeout(this.opts.requestTimeoutMs ?? 60_000, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      req.on("error", (e) => reject(mapSocketError(e)));
      req.end(payload);
    });
  }

  stream(route: RouteName, body: unknown): Promise<StreamReply> {
    const maxLine = this.opts.maxReplyBytes ?? DEFAULT_REPLY_BYTES;
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = request(
        { socketPath: this.socketPath, agent: false, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          clearTimeout(startTimer);
          if (res.statusCode !== 200) {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.length < 64 && chunks.push(c));
            res.on("error", (e) => reject(mapSocketError(e)));
            res.on("end", () => {
              let json: unknown;
              try {
                json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                /* falls through to BAD_RESPONSE */
              }
              reject(hostErrorFrom(res.statusCode ?? 0, json));
            });
            return;
          }
          const lines = (async function* (): AsyncGenerator<unknown> {
            let buf = "";
            res.setEncoding("utf8");
            try {
              for await (const chunk of res as AsyncIterable<string>) {
                buf += chunk;
                let nl: number;
                while ((nl = buf.indexOf("\n")) >= 0) {
                  const line = buf.slice(0, nl);
                  buf = buf.slice(nl + 1);
                  if (!line) continue;
                  try {
                    yield JSON.parse(line);
                  } catch {
                    throw new LoginHostError("BAD_RESPONSE", "line");
                  }
                }
                if (buf.length > maxLine) throw new LoginHostError("BAD_RESPONSE", "too_large");
              }
            } catch (e) {
              // A cut connection ends the stream as an error the caller treats as "outcome unknown".
              throw mapSocketError(e);
            }
          })();
          resolve({ lines, close: () => req.destroy() });
        },
      );
      const startTimer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), this.opts.streamStartTimeoutMs ?? 30_000);
      startTimer.unref?.();
      req.on("error", (e) => {
        clearTimeout(startTimer);
        reject(mapSocketError(e));
      });
      req.end(payload);
    });
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
const loginReadyReply = z.object({ status: z.literal("ready"), planLabel: z.string().optional(), accountFingerprint: z.string().optional(), refreshExpiresAtMs: z.number().optional() });
const loginStatusReply = z.union([loginReadyReply, z.object({ status: z.enum(["pending", "failed"]) })]);
const renewReply = z.object({ leaseMs: z.number().int().positive() });
const acceptedLine = z.object({ type: z.literal("accepted"), turnId: z.string(), duplicate: z.boolean(), status: z.enum(["running", "finished", "failed", "aborted"]).optional() });

const EVENT_TYPES: ReadonlySet<string> = new Set(["text", "tool-use", "tool-result", "usage", "entitlement", "alarm", "result"]);

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
  turnRenew(input: RouteInput<"turn.renew">): Promise<{ leaseMs: number }> {
    return this.call("turn.renew", input, renewReply);
  }
  turnInterrupt(input: RouteInput<"turn.interrupt">): Promise<{ interrupted: true }> {
    return this.call("turn.interrupt", input, z.object({ interrupted: z.literal(true) }));
  }
  /** Answer to a `tool-use` event of a turn run with a host-relayed tool transport. */
  turnToolResult(input: RouteInput<"turn.toolResult">): Promise<{ ok: true }> {
    return this.call("turn.toolResult", input, z.object({ ok: z.literal(true) }));
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
        // An event type this client does not know is dropped, not guessed at.
        if (v && typeof v === "object" && typeof v.type === "string" && EVENT_TYPES.has(v.type)) yield next.value as ProviderEvent;
      }
    })();
    return { turnId, duplicate, ...(status ? { status } : {}), events, close: () => reply.close() };
  }
}
