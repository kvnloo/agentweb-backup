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
import { performance } from "perf_hooks";
import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { createServer, type Server, type Socket } from "net";
import type { Logger } from "../ports";
import type { Layout } from "../ports/layout";
import { RELAY_FRAME_LIMITS, TOOL_NAME, type ToolDef } from "../protocol";
import { CpuMeter, TokenBucket } from "./cpuMeter";

/** Loop time of one socket read outside the timed section, in ms (measured; see READ_COST_MS in the Claude adapter, which carries the measurement). */
const READ_COST_MS = 0.08;
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
  /** Refused connections after which the listener is closed. */
  maxRefusals: number;
  /** Calls relayed to the backend in one turn. */
  maxCallsPerTurn: number;
  /** Byte budget next to the frame bucket: scanning and parsing a 1 MiB frame costs tens of ms of the shared host's event loop, so frames per second alone is not a limit. */
  byteBurst: number;
  bytesPerSec: number;
  /** Connections accepted over the life of one turn (a shim that restarts reconnects; a flood does not). */
  maxConnectionsPerTurn: number;
  shimToHostBytes: number;
  hostToShimBytes: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  idleMs: 15_000,
  burst: 30,
  refillPerSec: 10,
  maxRefusals: 32,
  maxCallsPerTurn: 500,
  byteBurst: 4 * 1024 * 1024,
  bytesPerSec: 2 * 1024 * 1024,
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
  /** The turn's CPU meter, shared with the adapter: frame handling is charged to it. A turn without one gets its own. */
  meter?: CpuMeter;
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
    this.meter = o.meter ?? new CpuMeter();
    this.server = createServer((s) => {
      try {
        this.onConnection(s);
      } catch {
        this.violate("internal_error");
        s.destroy();
        if (this.conn === s) this.conn = undefined; // its close handler was never registered: do not leave the one connection slot taken by a dead socket
      }
    });
    this.server.maxConnections = 8; // refused at the listener beyond this; the one-connection rule below is the real limit
    this.server.on("error", () => this.violate("server_error"));
  }

  private refusals = 0;
  private readonly meter: CpuMeter;
  private readonly reads = new TokenBucket(2000, 200);
  private callsRelayed = 0;
  private callCapLogged = false;
  /** No more connections are accepted (the connected one, if any, stays). The kernel refuses further connects; close() still removes the directory. */
  private stopListening(): void {
    if (this.server.listening) this.server.close();
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

  /** The turn this endpoint belongs to, for a log line: host-chosen identity only (ids are validated by the protocol schema), never anything from a frame. */
  private who(): Record<string, string> {
    const id = this.o.identity;
    const ok = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);
    return { ...(ok(id.connectionId) ? { connectionId: id.connectionId } : {}), ...(ok(id.turnId) ? { turnId: id.turnId } : {}) };
  }

  private violate(code: string): void {
    try {
      // The host-wide quota is charged ONLY by a line this endpoint itself let through: endpoints that are already suppressed must not use it up and hide another turn's line.
      const mine = this.throttle.check(code);
      const shared = mine.log ? this.sharedThrottle.check(code) : { log: false, suppressedBefore: 0 };
      const who = this.who();
      if (mine.log && shared.log) this.log?.warn("relay_violation", { code, ...who });
      const before = Math.max(mine.suppressedBefore, shared.suppressedBefore);
      if (before > 0) this.log?.warn("relay_violation_suppressed", { code, count: before, ...who });
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
      // Accepting a connection only to destroy it still costs a syscall round trip each: a connect flood (73,000 attempts in 5 s measured = 94% of a core) is ended at the
      // kernel by closing the listener once the turn can accept no more, or has been refused too often. An honest shim reconnects a handful of times, not dozens.
      if (++this.refusals >= this.limits.maxRefusals || (!this.conn && this.accepted >= this.limits.maxConnectionsPerTurn)) this.stopListening();
      return;
    }
    this.accepted++;
    this.conn = s;
    const assembler = new LineAssembler(this.limits.shimToHostBytes);
    let tokens = this.limits.burst;
    let byteTokens = this.limits.byteBurst;
    let lastRefill = performance.now(); // a MONOTONIC clock: a backwards step of the wall clock must not drop a healthy connection
    let idle = setTimeout(() => this.drop(s, "idle_timeout"), this.limits.idleMs);
    idle.unref?.();
    s.once("close", () => {
      clearTimeout(idle);
      if (this.conn === s) this.conn = undefined;
      if (this.accepted >= this.limits.maxConnectionsPerTurn) this.stopListening(); // the last connection this turn may have is gone
      if (this.pending?.socket === s) this.endPending("disconnected");
    });
    s.on("data", (chunk: Buffer) => {
      try {
        // each read is metered: the whole synchronous handling (scan, parse, validate, the adapter's onCall) is charged to the turn's CPU meter
        if (this.meter.exhausted) return this.drop(s, "cpu_budget");
        this.meter.charge(READ_COST_MS); // the per-read cost outside the timed section (see claudeAdapter READ_COST_MS)
        if (!this.reads.take()) return this.drop(s, "rate_limited");
        this.meter.time(() => onData(chunk));
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
        const now = performance.now();
        const dt = (now - lastRefill) / 1000;
        tokens = Math.min(this.limits.burst, tokens + dt * this.limits.refillPerSec);
        byteTokens = Math.min(this.limits.byteBurst, byteTokens + dt * this.limits.bytesPerSec);
        lastRefill = now;
        // frames per second AND bytes per second: a 1 MiB frame costs tens of ms to scan and parse, and the frame count alone would allow ten of them a second
        if (tokens < 1 || byteTokens < line.length + 1) return this.drop(s, "rate_limited");
        tokens -= 1;
        byteTokens -= line.length + 1;
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
    // An absurd key count is refused BEFORE the keys are sorted and joined (870 KB of 80,000 keys cost 62 ms there); a valid frame has at most four.
    let keyCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (const _k in rec) if (++keyCount > 4) break;
    if (keyCount > 4) {
      this.drop(s, "bad_frame");
      return false;
    }
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
    // A hard cap on calls relayed in one turn (the backend treats more than 400 as misbehaving): past it every call gets the fixed `call_limit` error, logged once.
    if (this.callsRelayed >= this.limits.maxCallsPerTurn) {
      if (!this.callCapLogged) {
        this.callCapLogged = true;
        this.violate("call_limit");
      }
      this.send(s, { type: "error", callId, code: "call_limit" });
      return true;
    }
    this.callsRelayed++;
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

  /** The answer path (stringify twice, up to 8 MiB) is charged to the turn's CPU meter like every other path that handles a unit's data. */
  answer(operationId: string, r: RelayResult): boolean {
    return this.meter.time(() => this.answerInner(operationId, r));
  }
  private answerInner(operationId: string, r: RelayResult): boolean {
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
        for (const [code, count] of this.throttle.flush()) this.log?.warn("relay_violation_suppressed", { code, count, ...this.who() });
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
