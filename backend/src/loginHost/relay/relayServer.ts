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
  /** Ends the connection and the pending call, closes the listener and removes the directory. Idempotent. */
  close(): Promise<void>;
  readonly closed: boolean;
}

export interface RelayHostOptions {
  layout: Layout;
  /** Production: sockets and directories belong to the customer uid. Tests run unprivileged. */
  ownByUid?: boolean;
  log?: Pick<Logger, "warn">;
  limits?: Partial<RelayLimits>;
  randomHex?: (bytes: number) => string;
}

const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Serialized size of the result frame the host would send (the manager refuses an answer that cannot fit BEFORE it consumes the operation). */
export function resultFrameBytes(callId: string, r: RelayResult): number {
  return Buffer.byteLength(JSON.stringify(resultFrame(callId, r)) + "\n", "utf8");
}

function resultFrame(callId: string, r: RelayResult): Record<string, unknown> {
  return { type: "result", callId, content: r.content, isError: r.isError === true, ...(r.images?.length ? { images: r.images } : {}), ...(r.tools?.length ? { tools: r.tools } : {}) };
}

export class RelayHost {
  private readonly layout: Layout;
  private readonly limits: RelayLimits;
  private readonly hex: (n: number) => string;

  constructor(private readonly opts: RelayHostOptions) {
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
    if (this.opts.ownByUid !== false) chownSync(root, 0, 0);
  }

  /** Creates this turn's directory and listening socket. Resolves when the socket accepts connections; only then may the unit be started. */
  async open(o: RelayOpenOptions): Promise<RelayEndpoint> {
    const uidDir = this.layout.relayUidDir(o.uid);
    const dir = this.layout.relayTurnDir(o.uid, this.hex(16));
    const sock = `${dir}/relay.sock`;
    const own = this.opts.ownByUid !== false;
    // The uid directory is root-owned and only traversable: the customer never gets write access above its own turn directory.
    mkdirSync(uidDir, { recursive: true, mode: 0o711 });
    chmodSync(uidDir, 0o711);
    mkdirSync(dir, { mode: 0o700 }); // exclusive: a leftover is an error, never reused
    chmodSync(dir, 0o700);
    const ep = new Endpoint(this.limits, this.opts.log, dir, o);
    try {
      await ep.listen(sock);
      chmodSync(sock, 0o600);
      if (own) {
        chownSync(sock, o.uid, o.uid);
        chownSync(dir, o.uid, o.uid);
      }
    } catch (e) {
      await ep.close();
      throw e;
    }
    return ep;
  }
}

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
  ) {
    this.server = createServer((s) => this.onConnection(s));
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
    this.log?.warn("relay_violation", { code });
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
    let buf = Buffer.alloc(0);
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
      if (this.conn !== s) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const nl = buf.indexOf(10);
        if (nl < 0) {
          if (buf.length > this.limits.shimToHostBytes) return this.drop(s, "frame_too_large");
          return;
        }
        if (nl > this.limits.shimToHostBytes) return this.drop(s, "frame_too_large");
        const line = buf.subarray(0, nl);
        buf = buf.subarray(nl + 1);
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
    });
  }

  private drop(s: Socket, code: string): void {
    this.violate(code);
    s.destroy();
  }

  /** Handles one complete line. Returns false when the connection was dropped. */
  private frame(s: Socket, line: Buffer): boolean {
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
      if (this.pending?.operationId !== operationId) return;
      this.send(s, { type: "error", callId, code: "timeout" });
      this.endPending("timeout");
    }, ms);
    timer.unref?.();
    this.pending = { callId, operationId, timer, socket: s };
    try {
      this.o.onCall({ identity: this.o.identity, operationId, name, args: args as Record<string, unknown> });
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
    const text = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(text, "utf8") > this.limits.hostToShimBytes) return false;
    s.write(text);
    return true;
  }

  answer(operationId: string, r: RelayResult): boolean {
    const p = this.pending;
    if (this.isClosed || !p || p.operationId !== operationId || p.socket.destroyed) return false;
    let frame = resultFrame(p.callId, r);
    if (Buffer.byteLength(JSON.stringify(frame) + "\n", "utf8") > this.limits.hostToShimBytes) frame = { type: "error", callId: p.callId, code: "result_too_large" };
    clearTimeout(p.timer);
    this.pending = undefined;
    this.send(p.socket, frame);
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
      await new Promise<void>((resolve) => {
        if (!this.server.listening) return resolve();
        this.server.close(() => resolve());
      });
      rmSync(this.dir, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
