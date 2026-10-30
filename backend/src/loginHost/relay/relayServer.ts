/**
 * ENG-2113: the host side of the tool relay. One unix socket PER TURN, `<relayRoot>/<uid>/<relayId>/relay.sock`, bound read-only into that turn's unit
 * at the fixed path /run/aw-relay/relay.sock (unitArgs.ts). The unit's stdio MCP shim (deploy/aw-relay-shim.js) connects to it and sends newline-delimited
 * JSON frames. This module is the security boundary between customer code and the host process, so it is strict and boring:
 *
 *  - IDENTITY comes from the socket, never from a frame. `open()` is given {connectionId, epoch, turnId} by the adapter session that created the socket;
 *    every call the socket produces carries that identity. A frame has no identity field and a frame with any unexpected field is a violation.
 *  - ONE connection at a time, a small total per turn; the extra one is destroyed before a byte is read.
 *  - Frames: shim -> host at most 1 MiB, host -> shim at most 8 MiB, newline delimited, every frame must be one of the known types, otherwise the
 *    connection is destroyed. 15 s without a COMPLETE frame (slow-loris, silence) destroys the connection (the shim pings every 5 s).
 *  - A token bucket per turn caps the frame rate; running dry destroys the connection.
 *  - ONE pending operation per turn. The operationId is 128 random bits generated HERE per request (the shim's callId stays internal to this socket).
 *  - A call's clock starts when it ARRIVES and lasts `callTimeoutMs()` (the turn's remaining deadline). On expiry the shim gets an error frame and a
 *    later answer is refused (`answer()` returns false), which the manager reports as "result lost".
 *  - Nothing in a frame is ever logged. Log lines carry fixed codes only.
 */
import { randomBytes } from "crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { createServer, type Server, type Socket } from "net";
import type { Logger } from "../ports";
import type { Layout } from "../ports/layout";
import { RELAY_FRAME_LIMITS, TOOL_NAME, type ToolDef } from "../protocol";
import { LineAssembler, LogThrottle, MAX_FRAME_DEPTH, rawJsonDepthExceeds } from "./bounds";

export interface RelayIdentity {
  connectionId: string;
  epoch: number;
  turnId: string;
}

/** What the adapter session receives for every accepted call. `operationId` is host-generated. */
export interface RelayCall {
  identity: RelayIdentity;
  operationId: string;
  name: string;
  args: Record<string, unknown>;
  /** The size of the frame the shim sent (what the host measured); memory accounting uses this, never a stringify of `args`. */
  bytes: number;
}

export interface RelayResult {
  content: string;
  isError?: boolean;
  images?: Array<{ mimeType: string; data: string }>;
  /** Definitions newly available because of this call (already validated by the manager); the shim adds them and waits for the CLI to re-list. */
  tools?: ToolDef[];
}

export interface RelayLimits {
  /** A connection with no complete frame for this long is destroyed. */
  idleMs: number;
  /** Token bucket: burst size and refill per second. */
  burst: number;
  refillPerSec: number;
  /** Connections accepted over the life of one turn (a shim that restarts reconnects; a flood does not). */
  maxConnectionsPerTurn: number;
  shimToHostBytes: number;
  hostToShimBytes: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  idleMs: 15_000,
  burst: 30,
  refillPerSec: 10,
  maxConnectionsPerTurn: 16,
  shimToHostBytes: RELAY_FRAME_LIMITS.shimToHostBytes,
  hostToShimBytes: RELAY_FRAME_LIMITS.hostToShimBytes,
};

export interface RelayOpenOptions {
  uid: number;
  identity: RelayIdentity;
  /** Called once per accepted call. The relay's clock for the call is already running. */
  onCall(call: RelayCall): void;
  /** A call that ended without an answer (timeout, shim gone): the adapter forgets its bookkeeping for it. */
  onCallEnded?(operationId: string, why: "timeout" | "disconnected"): void;
  /** Whether the shim may call this tool now (in the turn's visible set). */
  allowTool(name: string): boolean;
  /** Milliseconds a call that starts now may take. */
  callTimeoutMs(): number;
}

export interface RelayEndpoint {
  /** Host path of the directory to bind read-only at /run/aw-relay. */
  readonly dir: string;
  /** Answers the pending operation. False = there is no such pending operation (timed out, ended, or never issued): the result is lost. */
  answer(operationId: string, result: RelayResult): boolean;
  /** Fails the pending call with a fixed error code (the shim gets an error frame). False = no such pending call. */
  reject(operationId: string, code: "internal"): boolean;
  /** Ends the connection and the pending call, closes the listener and removes the directory. Idempotent. */
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface RelayHostOptions {
  layout: Layout;
  /** Production: sockets and directories belong to the customer uid. Tests run unprivileged. */
  ownByUid?: boolean;
  /** Test seam for the ownership change (default fs.chownSync). */
  chown?: (path: string, uid: number, gid: number) => void;
  /** Test seam for the log throttle's clock. */
  now?: () => number;
  log?: Pick<Logger, "warn">;
  limits?: Partial<RelayLimits>;
  randomHex?: (bytes: number) => string;
}

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Serialized size of the result frame the host would send (the manager refuses an answer that cannot fit BEFORE it consumes the operation). */
export function resultFrameBytes(callId: string, r: RelayResult): number {
  try {
    return Buffer.byteLength(JSON.stringify(resultFrame(callId, r)) + "\n", "utf8");
  } catch {
    return Infinity; // not serializable: never fits
  }
}

function resultFrame(callId: string, r: RelayResult): Record<string, unknown> {
  return { type: "result", callId, content: r.content, isError: r.isError === true, ...(r.images?.length ? { images: r.images } : {}), ...(r.tools?.length ? { tools: r.tools } : {}) };
}

export class RelayHost {
  private readonly layout: Layout;
  private readonly limits: RelayLimits;
  private readonly hex: (n: number) => string;
  /** Production passes true: sockets and directories belong to the customer uid. Public so a start-up test can pin it. */
  readonly ownByUid: boolean;
  private readonly chown: (path: string, uid: number, gid: number) => void;
  /** Violation lines across ALL turns: a hostile unit opening turns cannot flood the journal either. */
  private readonly sharedThrottle: LogThrottle;

  constructor(private readonly opts: RelayHostOptions) {
    this.ownByUid = opts.ownByUid !== false;
    this.chown = opts.chown ?? chownSync;
    this.sharedThrottle = new LogThrottle(LOG_MAX_PER_CODE_HOST, LOG_WINDOW_MS, opts.now);
    this.layout = opts.layout;
    this.limits = { ...DEFAULT_RELAY_LIMITS, ...(opts.limits ?? {}) };
    this.hex = opts.randomHex ?? ((n) => randomBytes(n).toString("hex"));
  }

  /** Start-up: the root is created root-owned and emptied (sockets of a previous run are dead). */
  init(): void {
    const root = this.layout.relayRoot;
    if (existsSync(root)) {
      for (const name of readdirSync(root)) rmSync(`${root}/${name}`, { recursive: true, force: true });
    } else {
      mkdirSync(root, { recursive: true, mode: 0o755 });
    }
    chmodSync(root, 0o755);
    if (this.ownByUid) this.chown(root, 0, 0);
  }

  /** Creates this turn's directory and listening socket. Resolves when the socket accepts connections; only then may the unit be started. */
  async open(o: RelayOpenOptions): Promise<RelayEndpoint> {
    const uidDir = this.layout.relayUidDir(o.uid);
    const dir = this.layout.relayTurnDir(o.uid, this.hex(16));
    const sock = `${dir}/relay.sock`;
    const own = this.ownByUid;
    // The uid directory is root-owned and only traversable: the customer never gets write access above its own turn directory.
    mkdirSync(uidDir, { recursive: true, mode: 0o711 });
    chmodSync(uidDir, 0o711);
    mkdirSync(dir, { mode: 0o700 }); // exclusive: a leftover is an error, never reused
    chmodSync(dir, 0o700);
    const ep = new Endpoint(this.limits, this.opts.log, dir, o, this.sharedThrottle, new LogThrottle(LOG_MAX_PER_CODE_ENDPOINT, LOG_WINDOW_MS, this.opts.now));
    try {
      await ep.listen(sock);
      chmodSync(sock, 0o600);
      if (own) {
        // The socket first, the DIRECTORY LAST: until the directory is the customer's, nobody but root can even reach the socket.
        this.chown(sock, o.uid, o.uid);
        this.chown(dir, o.uid, o.uid);
      }
    } catch (e) {
      await ep.close();
      throw e;
    }
    return ep;
  }
}

/** Violation logs: per endpoint and per code at most this many per window (then counted, not logged), and across the whole host a larger number. */
const LOG_MAX_PER_CODE_ENDPOINT = 5;
const LOG_MAX_PER_CODE_HOST = 50;
const LOG_WINDOW_MS = 10_000;

class Endpoint implements RelayEndpoint {
  private readonly server: Server;
  private conn: Socket | undefined;
  private accepted = 0;
  private pending: { callId: string; operationId: string; timer: NodeJS.Timeout; socket: Socket } | undefined;
  private isClosed = false;
  private closing: Promise<void> | undefined;

  constructor(
    private readonly limits: RelayLimits,
    private readonly log: Pick<Logger, "warn"> | undefined,
    readonly dir: string,
    private readonly o: RelayOpenOptions,
    private readonly sharedThrottle: LogThrottle,
    private readonly throttle: LogThrottle,
  ) {
    this.server = createServer((s) => {
      try {
        this.onConnection(s);
      } catch {
        this.violate("internal_error");
        s.destroy();
      }
    });
    this.server.maxConnections = 8; // refused at the listener beyond this; the one-connection rule below is the real limit
    this.server.on("error", () => this.violate("server_error"));
  }

  get closed(): boolean {
    return this.isClosed;
  }

  listen(path: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(path, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  private violate(code: string): void {
    try {
      const mine = this.throttle.check(code);
      const shared = this.sharedThrottle.check(code);
      if (mine.log && shared.log) this.log?.warn("relay_violation", { code });
      const before = Math.max(mine.suppressedBefore, shared.suppressedBefore);
      if (before > 0) this.log?.warn("relay_violation_suppressed", { code, count: before });
    } catch {
      /* a failing logger must not become an uncaught exception either */
    }
  }

  private onConnection(s: Socket): void {
    s.on("error", () => undefined);
    // One connection per socket: a second is destroyed before anything is read. The total is bounded too.
    if (this.isClosed || this.conn || this.accepted >= this.limits.maxConnectionsPerTurn) {
      this.violate(this.conn ? "second_connection" : "connection_refused");
      s.destroy();
      return;
    }
    this.accepted++;
    this.conn = s;
    const assembler = new LineAssembler(this.limits.shimToHostBytes);
    let tokens = this.limits.burst;
    let lastRefill = Date.now();
    let idle = setTimeout(() => this.drop(s, "idle_timeout"), this.limits.idleMs);
    idle.unref?.();
    s.once("close", () => {
      clearTimeout(idle);
      if (this.conn === s) this.conn = undefined;
      if (this.pending?.socket === s) this.endPending("disconnected");
    });
    s.on("data", (chunk: Buffer) => {
      try {
        onData(chunk);
      } catch {
        // Nothing a shim sends may throw out of an event handler: that would be an uncaught exception, which ends the whole host. Drop the connection, fixed code.
        this.drop(s, "internal_error");
      }
    });
    const onData = (chunk: Buffer): void => {
      if (this.conn !== s) return;
      const { lines, tooLarge } = assembler.push(chunk); // linear in the bytes received, however they are chunked (see LineAssembler)
      for (const line of lines) {
        // Token bucket, refilled by elapsed time. Every complete frame costs one token.
        const now = Date.now();
        tokens = Math.min(this.limits.burst, tokens + ((now - lastRefill) / 1000) * this.limits.refillPerSec);
        lastRefill = now;
        if (tokens < 1) return this.drop(s, "rate_limited");
        tokens -= 1;
        clearTimeout(idle);
        idle = setTimeout(() => this.drop(s, "idle_timeout"), this.limits.idleMs);
        idle.unref?.();
        if (!this.frame(s, line)) return;
      }
      if (tooLarge) this.drop(s, "frame_too_large");
    };
  }

  private drop(s: Socket, code: string): void {
    this.violate(code);
    s.destroy();
  }

  /** Handles one complete line. Returns false when the connection was dropped. */
  private frame(s: Socket, line: Buffer): boolean {
    // BEFORE parsing: a hostile frame nested hundreds of thousands deep fits in 1 MiB, JSON.parse accepts it, and every later stringify or walk of it throws a
    // RangeError that no handler catches. The single-pass scan rejects it without ever building the object.
    if (rawJsonDepthExceeds(line, MAX_FRAME_DEPTH)) {
      this.drop(s, "frame_too_deep");
      return false;
    }
    let f: unknown;
    try {
      f = JSON.parse(line.toString("utf8"));
    } catch {
      this.drop(s, "bad_json");
      return false;
    }
    if (f === null || typeof f !== "object" || Array.isArray(f)) {
      this.drop(s, "bad_frame");
      return false;
    }
    const rec = f as Record<string, unknown>;
    const keys = Object.keys(rec).sort().join(",");
    if (rec.type === "ping") {
      if (keys !== "type") {
        this.drop(s, "bad_frame");
        return false;
      }
      return true;
    }
    // Exactly {type, callId, name, args}: identity (or anything else) in a frame is a violation, never silently ignored.
    if (rec.type !== "call" || keys !== "args,callId,name,type") {
      this.drop(s, rec.type === "call" ? "bad_frame" : "unknown_frame_type");
      return false;
    }
    const { callId, name, args } = rec as { callId: unknown; name: unknown; args: unknown };
    if (typeof callId !== "string" || !CALL_ID.test(callId) || typeof name !== "string" || !TOOL_NAME.safeParse(name).success || args === null || typeof args !== "object" || Array.isArray(args)) {
      this.drop(s, "bad_frame");
      return false;
    }
    if (this.pending) {
      this.send(s, { type: "error", callId, code: "busy" }); // the shim serializes calls; this is a misbehaving one
      return true;
    }
    if (!this.o.allowTool(name)) {
      this.send(s, { type: "error", callId, code: "unknown_tool" });
      return true;
    }
    const operationId = randomBytes(16).toString("hex");
    const ms = Math.max(0, Math.floor(this.o.callTimeoutMs()));
    const timer = setTimeout(() => {
      try {
        if (this.pending?.operationId !== operationId) return;
        this.send(s, { type: "error", callId, code: "timeout" });
        this.endPending("timeout");
      } catch {
        this.violate("internal_error");
        s.destroy();
      }
    }, ms);
    timer.unref?.();
    this.pending = { callId, operationId, timer, socket: s };
    try {
      this.o.onCall({ identity: this.o.identity, operationId, name, args: args as Record<string, unknown>, bytes: line.length });
    } catch {
      this.send(s, { type: "error", callId, code: "internal" });
      this.endPending("disconnected");
    }
    return true;
  }

  private endPending(why: "timeout" | "disconnected"): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    this.o.onCallEnded?.(p.operationId, why);
  }

  private send(s: Socket, frame: Record<string, unknown>): boolean {
    if (s.destroyed) return false;
    let text: string;
    try {
      text = JSON.stringify(frame) + "\n";
    } catch {
      return false; // not serializable: nothing is sent, the call times out or is ended by the caller
    }
    const size = Buffer.byteLength(text, "utf8");
    if (size > this.limits.hostToShimBytes) return false;
    // A peer that never reads must not make the host buffer without bound (answers are up to 8 MiB each): past two maximum frames queued, the connection is cut.
    if (s.writableLength + size > 2 * this.limits.hostToShimBytes) {
      this.drop(s, "write_backlog");
      this.endPending("disconnected");
      return false;
    }
    s.write(text);
    return true;
  }

  answer(operationId: string, r: RelayResult): boolean {
    const p = this.pending;
    if (this.isClosed || !p || p.operationId !== operationId || p.socket.destroyed) return false;
    let frame = resultFrame(p.callId, r);
    let size = Infinity;
    try {
      size = Buffer.byteLength(JSON.stringify(frame) + "\n", "utf8");
    } catch {
      /* not serializable: treated as too large */
    }
    if (size > this.limits.hostToShimBytes) frame = { type: "error", callId: p.callId, code: "result_too_large" };
    clearTimeout(p.timer);
    this.pending = undefined;
    return this.send(p.socket, frame); // false (queue cap hit, not serializable): the result did not reach the shim
  }

  reject(operationId: string, code: "internal"): boolean {
    const p = this.pending;
    if (this.isClosed || !p || p.operationId !== operationId) return false;
    clearTimeout(p.timer);
    this.pending = undefined;
    this.send(p.socket, { type: "error", callId: p.callId, code });
    return true;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      this.isClosed = true;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending = undefined;
      }
      this.conn?.destroy();
      this.conn = undefined;
      try {
        for (const [code, count] of this.throttle.flush()) this.log?.warn("relay_violation_suppressed", { code, count });
      } catch {
        /* logging is best effort */
      }
      await new Promise<void>((resolve) => {
        if (!this.server.listening) return resolve();
        this.server.close(() => resolve());
      });
      rmSync(this.dir, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
