/**
 * ENG-2110 PR 1a: the login host's HTTP API over a unix socket.
 *
 * Authentication is the filesystem: the socket lives in a directory only the host (root) and the
 * backend's group can enter. SO_PEERCRED cannot help (the backend container runs as root, so every
 * caller looks like uid 0), which is why the protocol itself is closed (see protocol.ts): the
 * worst a compromised caller can do is spend customers' plans. Nothing here logs a request body,
 * a prompt, a code or a token; errors carry a code and a short host-chosen detail.
 *
 *   POST /v1/<route>   JSON body, schema-checked and closed. `turn.run` answers with NDJSON
 *                      (one JSON object per line); everything else answers with one JSON object.
 */
import { chmodSync, existsSync, rmSync } from "fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "https";
import type { TLSSocket } from "tls";
import { connect } from "net";
import { ZodError } from "zod";
import type { ConnectionManager } from "./connectionManager";
import type { Logger } from "./ports";
import { DEFAULT_MAX_BODY_BYTES, HostError, HTTP_STATUS, LOCAL_ONLY_ROUTES, maxBodyBytes, PROTOCOL_VERSION, ROUTES, type RouteName } from "./protocol";

/** A request body that stops arriving for this long is dropped (slowloris). */
const BODY_IDLE_MS = 15_000;
/** A rejected TLS client is logged at most once per this window per reason (a scanner or a misconfigured peer must not flood the journal). */
const TLS_REJECT_LOG_WINDOW_MS = 10_000;

export interface HostServerOptions {
  socketPath: string;
  /** Unix mode of the socket file; the directory's permissions are the real gate. */
  socketMode?: number;
  /** Background tick (lease/deadline enforcement) and sweep intervals. */
  tickMs?: number;
  sweepMs?: number;
  /** Concurrent connections accepted; a flood of idle connections cannot exhaust file descriptors. */
  maxConnections?: number;
  /** A request body that stops arriving for this long is dropped (default 15 s). */
  bodyIdleMs?: number;
  /** A turn stream the reader stops draining for this long is cut, which also ends the turn (default 30 s). */
  streamStallMs?: number;
  /**
   * A second listener for a backend on ANOTHER machine: mutual TLS only (TLS 1.3, a client certificate signed by `ca` is REQUIRED, and its
   * subject CN must be one of `clientCommonNames`). Same closed API, same handler; the unix socket stays as it is.
   */
  tls?: { host: string; port: number; cert: string | Buffer; key: string | Buffer; ca: string | Buffer; clientCommonNames: string[]; maxConnections?: number; handshakeMs?: number };
  /** Secret-free structured logging (codes and a certificate common name only). Without it nothing is logged. */
  log?: Pick<Logger, "warn">;
  /** Test seam for the rejection log's rate limit. */
  now?: () => number;
}

export class SocketInUseError extends Error {
  constructor() {
    super("another login host is listening on this socket");
    this.name = "SocketInUseError";
  }
}

/** True if something accepts connections on the socket (a live host); a stale file left by a dead host does not. */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = connect(path);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

export interface HostServerHandle {
  server: Server;
  /** The mutual-TLS listener, when configured. */
  tlsServer?: HttpsServer;
  /** The port the TLS listener actually bound (differs from the configured one only when that was 0, in tests). */
  tlsPort?: number;
  close(): Promise<void>;
}

export async function startHostServer(manager: ConnectionManager, opts: HostServerOptions): Promise<HostServerHandle> {
  if (existsSync(opts.socketPath)) {
    if (await socketIsLive(opts.socketPath)) throw new SocketInUseError(); // never hijack another environment's host
    rmSync(opts.socketPath, { force: true });
  }
  // Processes started by a previous run may still be alive: kill them before serving anything.
  await manager.recover();
  const bodyIdleMs = opts.bodyIdleMs ?? BODY_IDLE_MS;
  const streamStallMs = opts.streamStallMs ?? 30_000;
  /** The one request handler both listeners use. */
  const makeOnRequest = (local: boolean) => (req: IncomingMessage, res: ServerResponse): void => {
    void handle(manager, req, res, bodyIdleMs, streamStallMs, local).catch(() => {
      if (!res.headersSent) sendError(res, new HostError("EINTERNAL"));
      else res.end();
    });
  };
  const onRequest = makeOnRequest(true);
  const onSecureRequest = makeOnRequest(false);
  const server = createServer(onRequest);
  applyLimits(server, opts.maxConnections ?? 128);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => resolve());
  });
  chmodSync(opts.socketPath, opts.socketMode ?? 0o660);
  let tlsServer: HttpsServer | undefined;
  let tlsPort: number | undefined;
  if (opts.tls) {
    const t = opts.tls;
    const allowed = new Set(t.clientCommonNames);
    const rejected = createRejectionLog(opts.log, opts.now ?? Date.now);
    // The caller must be the backend's IDENTITY: a certificate the CA signed is necessary, not sufficient.
    const identityOk = (socket: TLSSocket): boolean => {
      const cn = socket.getPeerCertificate().subject?.CN;
      return socket.authorized === true && typeof cn === "string" && allowed.has(cn);
    };
    const secure = createHttpsServer(
      { cert: t.cert, key: t.key, ca: t.ca, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3", handshakeTimeout: t.handshakeMs ?? 10_000 },
      (req, res) => {
        // Second line of defence, checked per REQUEST: nothing reaches the manager unless this very socket carries the allowed identity.
        if (!identityOk(req.socket as TLSSocket)) {
          rejected("identity", req.socket as TLSSocket);
          req.socket.destroy();
          return;
        }
        onSecureRequest(req, res);
      },
    );
    // First line: dropped before the HTTP parser sees a byte. `prependListener` is essential: https.Server registers its own
    // `secureConnection` listener when it is created, and a listener added with `on` would run AFTER it, i.e. after the request
    // had already been handed to the handler.
    secure.prependListener("secureConnection", (socket: TLSSocket) => {
      if (!identityOk(socket)) {
        rejected("identity", socket);
        socket.destroy();
      }
    });
    // A failed handshake (no certificate, another CA, TLS < 1.3, a scanner) is the client's problem; logged (rate limited), never an unhandled event.
    secure.on("tlsClientError", (err: Error) => rejected("handshake", undefined, (err as { code?: string }).code));
    secure.on("clientError", (_err, socket) => socket.destroy());
    applyLimits(secure, t.maxConnections ?? 64);
    await new Promise<void>((resolve, reject) => {
      secure.once("error", reject);
      secure.listen(t.port, t.host, () => resolve());
    });
    tlsServer = secure;
    tlsPort = (secure.address() as { port: number }).port;
  }
  const tick = setInterval(() => {
    try {
      manager.tick();
    } catch {
      opts.log?.warn("host_tick_failed"); // a failing tick must not be an uncaught exception (it would end the host for every customer); the next tick tries again
    }
  }, opts.tickMs ?? 5_000);
  const sweep = setInterval(() => void manager.sweep().catch(() => undefined), opts.sweepMs ?? 60_000);
  tick.unref();
  sweep.unref();
  const servers: Server[] = tlsServer ? [server, tlsServer] : [server];
  return {
    server,
    ...(tlsServer ? { tlsServer, tlsPort } : {}),
    close: async () => {
      clearInterval(tick);
      clearInterval(sweep);
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections?.();
            }),
        ),
      );
    },
  };
}

/** Limits both listeners share: turn.run streams for a long time, so only the BODY is bounded (BODY_IDLE_MS), never the request. */
function applyLimits(server: Server, maxConnections: number): void {
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  server.maxConnections = maxConnections;
}

/**
 * `tls_client_rejected {reason, cn?, code?}` at most once per window per reason. A client-certificate name that is wrong after a rotation
 * otherwise looks like "the network is down" on both sides. The common name is not secret; nothing else from the certificate is logged,
 * and `code` is an OpenSSL/Node error code, checked against a strict shape.
 */
function createRejectionLog(log: Pick<Logger, "warn"> | undefined, now: () => number): (reason: "identity" | "handshake", socket?: TLSSocket, errCode?: string) => void {
  const lastAt = new Map<string, number>();
  return (reason, socket, errCode) => {
    if (!log) return;
    const t = now();
    const prev = lastAt.get(reason);
    if (prev !== undefined && t - prev < TLS_REJECT_LOG_WINDOW_MS) return;
    lastAt.set(reason, t);
    const fields: Record<string, string> = { reason };
    const cn = socket?.getPeerCertificate().subject?.CN;
    if (typeof cn === "string") fields.cn = /^[A-Za-z0-9._ -]{1,64}$/.test(cn) ? cn : "(unprintable)";
    if (typeof errCode === "string" && /^[A-Z0-9_]{1,64}$/.test(errCode)) fields.code = errCode;
    log.warn("tls_client_rejected", fields);
  };
}

async function handle(manager: ConnectionManager, req: IncomingMessage, res: ServerResponse, bodyIdleMs: number, streamStallMs: number, local: boolean): Promise<void> {
  if (req.method !== "POST") return sendError(res, new HostError("EINVALID", "method"), 405);
  const match = /^\/v1\/([A-Za-z.]+)$/.exec(req.url ?? "");
  const route = match?.[1] as RouteName | undefined;
  // An unknown route is NOT "not found": ENOTFOUND means "no such connection/login/turn" and has a destructive meaning for the backend's
  // revoke and sweeper (a connection the host has never heard of is treated as already wiped). A newer backend talking to an older worker
  // must get something it can only read as an error (see PROTOCOL_VERSION).
  if (!route || !Object.prototype.hasOwnProperty.call(ROUTES, route)) return sendError(res, new HostError("EINVALID", "route"), 404);
  // Operator routes answer exactly like an unknown route on the network listener: the backend can never starve or probe the host through them.
  if (!local && LOCAL_ONLY_ROUTES.has(route)) return sendError(res, new HostError("EINVALID", "route"), 404);
  if (!/^application\/json(;|$)/i.test(String(req.headers["content-type"] ?? ""))) return sendError(res, new HostError("EINVALID", "content_type"), 415);

  let body: unknown;
  try {
    const text = await readBody(req, bodyIdleMs, maxBodyBytes(route));
    body = JSON.parse(text);
    // turn.run's cap is 8 MiB only for the relay shape (a manifest rides along); the LEGACY shape (no `tools`) keeps exactly protocol 3's 5 MiB. The upload is already complete here.
    if (route === "turn.run" && Buffer.byteLength(text) > DEFAULT_MAX_BODY_BYTES && !(body !== null && typeof body === "object" && "tools" in body)) throw new HostError("EINVALID", "too_large");
  } catch (err) {
    if (err instanceof HostError) {
      sendError(res, err, err.detail === "too_large" ? 413 : undefined);
      if (err.detail === "too_large" || err.detail === "body_timeout") res.once("finish", () => req.destroy()); // reply first, then cut the upload
      return;
    }
    return sendError(res, new HostError("EINVALID", "json"));
  }
  let input: never;
  try {
    input = ROUTES[route].parse(body) as never;
  } catch (err) {
    // Only the field names and the kind of problem; never the offending value (it may be a token or a code).
    const detail = err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".") || "body"}:${i.code === "custom" && /^[a-z_]{1,40}$/.test(i.message) ? i.message : i.code}`).slice(0, 5).join(",") : "invalid";
    return sendError(res, new HostError("EINVALID", detail));
  }

  try {
    if (route === "host.info") return send(res, 200, { protocol: PROTOCOL_VERSION, node: process.version, uptimeSec: Math.floor(process.uptime()), ...manager.hostStatus() });
    if (route === "host.drain") return send(res, 200, manager.setDrain(input));
    if (route === "turn.run") return await streamTurn(manager, input, res, streamStallMs);
    const result = await dispatch(manager, route, input);
    send(res, 200, result);
  } catch (err) {
    sendError(res, err instanceof HostError ? err : new HostError("EINTERNAL"));
  }
}

async function dispatch(m: ConnectionManager, route: RouteName, input: never): Promise<unknown> {
  switch (route) {
    case "login.start":
      return m.loginStart(input);
    case "login.complete":
      return m.loginComplete(input);
    case "login.status":
      return m.loginStatus(input);
    case "login.cancel":
      return m.loginCancel(input);
    case "login.promote":
      return m.loginPromote(input);
    case "turn.renew":
      return m.renewLease(input);
    case "turn.interrupt":
      return m.interruptTurn(input);
    case "turn.toolResult":
      return m.turnToolResult(input);
    case "connection.disable":
      return m.disable(input);
    case "connection.enable":
      return m.enable(input);
    case "connection.revoke":
      return m.revoke(input);
    case "connection.status":
      return m.status(input);
    default:
      throw new HostError("ENOTFOUND");
  }
}

async function streamTurn(m: ConnectionManager, input: never, res: ServerResponse, stallMs: number): Promise<void> {
  const started = await m.runTurn(input);
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
  res.write(JSON.stringify({ type: "accepted", turnId: started.turnId, duplicate: started.duplicate, ...(started.status ? { status: started.status } : {}) }) + "\n");
  if (!started.events) return void res.end();
  let finished = false;
  // A dropped stream means the caller is gone: end the turn (it would otherwise run until its lease lapses).
  res.on("close", () => {
    if (!finished) m.abortTurn((input as { connectionId: string }).connectionId, started.turnId, "stream_dropped");
  });
  try {
    for await (const ev of started.events) {
      if (res.destroyed) break;
      // Backpressure: wait for a slow reader to drain instead of buffering without bound.
      let line: string;
      try {
        line = JSON.stringify(ev) + "\n";
      } catch {
        // An event that cannot be serialized (data from a customer's unit or CLI): end the turn instead of throwing out of the stream.
        m.abortTurn((input as { connectionId: string }).connectionId, started.turnId, "event_unserializable");
        break;
      }
      if (!res.write(line)) {
        // A reader that stops draining must not park the turn (and its slot) forever: cut the stream after stallMs.
        await new Promise<void>((resolve) => {
          const stall = setTimeout(() => res.destroy(), stallMs);
          const done = () => {
            clearTimeout(stall);
            res.off("drain", done);
            res.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
        });
      }
    }
  } finally {
    finished = true;
    res.end();
  }
}

function readBody(req: IncomingMessage, bodyIdleMs: number, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        clearTimeout(idle);
        req.pause();
        reject(new HostError("EINVALID", "too_large"));
        return;
      }
      chunks.push(c);
      idle.refresh();
    });
    const idle = setTimeout(() => {
      req.pause();
      reject(new HostError("EINVALID", "body_timeout")); // answered first; the connection is cut after the reply
    }, bodyIdleMs);
    req.on("end", () => {
      clearTimeout(idle);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      clearTimeout(idle);
      reject(e);
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, err: HostError, status?: number): void {
  send(res, status ?? HTTP_STATUS[err.code], err.toBody());
}
