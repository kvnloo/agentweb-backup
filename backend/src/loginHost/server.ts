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
import { connect } from "net";
import { ZodError } from "zod";
import type { ConnectionManager } from "./connectionManager";
import { HostError, HTTP_STATUS, ROUTES, type RouteName } from "./protocol";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** A request body that stops arriving for this long is dropped (slowloris). */
const BODY_IDLE_MS = 15_000;

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
  close(): Promise<void>;
}

export async function startHostServer(manager: ConnectionManager, opts: HostServerOptions): Promise<HostServerHandle> {
  if (existsSync(opts.socketPath)) {
    if (await socketIsLive(opts.socketPath)) throw new SocketInUseError(); // never hijack another environment's host
    rmSync(opts.socketPath, { force: true });
  }
  // Processes started by a previous run may still be alive: kill them before serving anything.
  await manager.recover();
  const server = createServer((req, res) => {
    void handle(manager, req, res, opts.bodyIdleMs ?? BODY_IDLE_MS, opts.streamStallMs ?? 30_000).catch(() => {
      if (!res.headersSent) sendError(res, new HostError("EINTERNAL"));
      else res.end();
    });
  });
  server.requestTimeout = 0; // turn.run streams for a long time; the BODY is bounded separately (BODY_IDLE_MS)
  server.headersTimeout = 10_000;
  server.maxConnections = opts.maxConnections ?? 128;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => resolve());
  });
  chmodSync(opts.socketPath, opts.socketMode ?? 0o660);
  const tick = setInterval(() => manager.tick(), opts.tickMs ?? 5_000);
  const sweep = setInterval(() => void manager.sweep().catch(() => undefined), opts.sweepMs ?? 60_000);
  tick.unref();
  sweep.unref();
  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tick);
        clearInterval(sweep);
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

async function handle(manager: ConnectionManager, req: IncomingMessage, res: ServerResponse, bodyIdleMs: number, streamStallMs: number): Promise<void> {
  if (req.method !== "POST") return sendError(res, new HostError("EINVALID", "method"), 405);
  const match = /^\/v1\/([A-Za-z.]+)$/.exec(req.url ?? "");
  const route = match?.[1] as RouteName | undefined;
  if (!route || !Object.prototype.hasOwnProperty.call(ROUTES, route)) return sendError(res, new HostError("ENOTFOUND"), 404);
  if (!/^application\/json(;|$)/i.test(String(req.headers["content-type"] ?? ""))) return sendError(res, new HostError("EINVALID", "content_type"), 415);

  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, bodyIdleMs));
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
    const detail = err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".") || "body"}:${i.code}`).slice(0, 5).join(",") : "invalid";
    return sendError(res, new HostError("EINVALID", detail));
  }

  try {
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
      if (!res.write(JSON.stringify(ev) + "\n")) {
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

function readBody(req: IncomingMessage, bodyIdleMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
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
