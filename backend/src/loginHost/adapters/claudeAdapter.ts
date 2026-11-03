/**
 * ENG-2110 PR 1b-i: the Claude provider adapter for the login host.
 *
 * Contract highlights (see adapter.ts): every process is started through `ctx.spawnAs` (the host's
 * hardening, the customer's uid); the sign-in code goes to the CLI's stdin only; no method reads a
 * credential file (sign-in success is confirmed with `claude auth status`); CLI output is parsed for
 * specific fields and never logged or returned; a turn is ONE process (`singleUse`), because the bridge
 * token and the model are fixed when the CLI starts, and its MCP config reaches it through the host's
 * `claude-turn.sh` wrapper on stdin (never argv, env or a persistent file).
 */
import { EventEmitter } from "events";
import { performance } from "perf_hooks";
import { Transform } from "stream";
import { join } from "path";
import {
  allowlistedEnv,
  ClaudeCliRunner,
  ClaudeCliTurnError,
  type ClaudeCliSessionHandle,
  type ClaudeCliSpawnSpec,
  type RunnerChild,
} from "../../services/funding/claudeCliRunner";
import { CODE_PATTERN, extractAuthorizeUrl, MAX_LOGIN_OUTPUT_CHARS } from "../../services/funding/claudeLoginParse";
import type { Logger } from "../ports";
import type {
  ServerRequestAnswer,
  TurnInput,
  AdapterContext,
  AuthStatus,
  ChildLike,
  ErrorKind,
  Hazard,
  LoginProcess,
  ProviderEvent,
  ProviderSession,
  SessionSpec,
  SpawnSpec,
  SubscriptionProviderAdapter,
} from "../adapter";
import { manifestLines, qualifiedToolPrefix, RELAY_MCP_SERVER_NAME, relayCliEnv } from "../protocol";
import { CpuMeter, TokenBucket } from "../relay/cpuMeter";
import { RELAY_SOCKET_IN_UNIT } from "../ports/unitArgs";
import { approxJsonBytes, LogThrottle, MAX_CLI_LINE_DEPTH, MAX_FORWARDED_DEPTH, valueDepthExceeds } from "../relay/bounds";
import { canonicalJson } from "../relay/canonical";
import { createHash } from "crypto";
import type { RelayCall, RelayEndpoint, RelayHost } from "../relay/relayServer";
import { MAX_BLOCKS_NORMALIZED, MAX_CLASSIFY_CHARS, classifyFailureText, failureClassToKind, normalizeClaudeEvent, parseAuthStatus, parseDoctorHazards, usageFromResult } from "./claudeParse";

export interface ClaudeAdapterConfig {
  /** Pinned binary: absolute path, `--version` output and content digest, verified by the host at startup (never recomputed per call). */
  binary: { path: string; version: string; digest: string };
  /** Host-owned, read-only system prompt file (readable by every customer uid, writable by none). */
  systemPromptFile: string;
  /** Host-owned `deploy/claude-turn.sh`. */
  turnWrapperPath: string;
  /** The Emma tool bridge's MCP endpoint, as seen from a customer process. */
  bridgeUrl: string;
  /**
   * ENG-2113 tool relay. Absent = a turn that asks for the relay is refused (the legacy HTTP bridge path is unaffected). `shimPath` and `nodePath` are
   * host-owned, root-controlled files (trusted-path checked at start-up); they are run INSIDE the customer's unit by the CLI.
   */
  relay?: { host: RelayHost; shimPath: string; nodePath: string };
  /** How long a relayed call waits for the stream to show its model message id before it is emitted without one (default 2 s). */
  messageIdWaitMs?: number;
  /** Secret-free structured logging (fixed codes only). Without it nothing is logged. */
  log?: Pick<Logger, "warn">;
  models?: Iterable<string>;
  /** PATH inside customer processes (default a fixed system path; the host's own PATH is never used). */
  basePath?: string;
  /** The unit-private tmp the wrapper uses (default /tmp). */
  unitTmp?: string;
  mcpServerName?: string;
  startTimeoutMs?: number;
  completeTimeoutMs?: number;
  shortCommandTimeoutMs?: number;
  /** After SIGTERM-style kill requests the wait for a process to be gone. */
  killWaitMs?: number;
  /** Approximate cap on events buffered between the CLI and the consumer of a turn (default 8 MB). */
  maxQueuedBytes?: number;
  /** Longest stdout line (one stream-json event) accepted from the CLI before the process is killed (default 16 MB): the runner's line reader buffers a whole line. */
  maxLineBytes?: number;
  /** Bound on the `auth status` check that confirms an auth-looking failure (must stay below the host's abort grace; default 4 s). */
  authConfirmTimeoutMs?: number;
}

const DEFAULTS = {
  messageIdWaitMs: 2_000,
  maxQueuedBytes: 8 * 1024 * 1024,
  maxLineBytes: 16 * 1024 * 1024,
  authConfirmTimeoutMs: 4_000,
  basePath: "/usr/local/bin:/usr/bin:/bin",
  unitTmp: "/tmp",
  mcpServerName: RELAY_MCP_SERVER_NAME,
  startTimeoutMs: 30_000,
  completeTimeoutMs: 30_000,
  shortCommandTimeoutMs: 30_000,
  killWaitMs: 5_000,
  models: ["haiku", "sonnet", "opus"],
};

/** The host's ChildLike as the structural child the runner expects, plus an `exited` promise that resolves when the process is really gone. */
/** Exported for tests only. */
export class RunnerChildAdapter extends EventEmitter implements RunnerChild {
  readonly stdin: ChildLike["stdin"];
  readonly stdout: Transform;
  readonly stderr: ChildLike["stderr"];
  readonly meter: CpuMeter;
  exitCode: number | null = null;
  signalCode: string | null = null;
  /** Resolves only when the process is really gone (`onExit`), or never existed (`onError`: it could not be started). */
  readonly exited: Promise<void>;

  constructor(
    private readonly child: ChildLike,
    maxLineBytes: number,
    onDeepLine?: () => void,
    /** The turn's CPU meter (see relay/cpuMeter.ts): everything this child makes the host process is charged to it. A turn builds one and shares it with its relay. */
    meter: CpuMeter = new CpuMeter(),
  ) {
    super();
    this.meter = meter;
    this.stdin = child.stdin;
    // stderr is the unit's data too: it goes through a guard (metered, read- and byte-limited, and at most a few KiB forwarded) BEFORE the runner's tail logic sees it
    const errGuard = new StderrGuard(meter, () => {
      this.kill(true);
      this.emit("error", new Error("stderr_flood"));
    });
    child.stderr.on("error", () => undefined);
    child.stderr.pipe(errGuard);
    this.stderr = errGuard;
    meter.onExhausted(() => {
      this.kill(true);
      this.emit("error", new Error("cpu_budget"));
    });
    let done!: () => void;
    this.exited = new Promise<void>((r) => (done = r));
    // The runner's line reader buffers a whole line: a CLI that never prints a newline must not grow the host's memory without bound.
    this.stdout = new LineLimit(
      maxLineBytes,
      () => {
        this.kill(true);
        this.emit("error", new Error("stdout_line_too_long"));
      },
      onDeepLine,
      () => {
        this.kill(true);
        this.emit("error", new Error("stdout_flood"));
      },
      meter,
    );
    child.stdout.on("error", () => undefined);
    child.stdout.pipe(this.stdout);
    child.onExit((code, signal) => {
      this.exitCode = code;
      this.signalCode = signal ?? (code === null ? "UNKNOWN" : null); // a finished process never reports both as null (the runner reads that as "still running")
      done();
      this.emit("exit", code, signal);
    });
    child.onError?.((err) => {
      this.exitCode = -1; // it never ran: not "still running" for the runner
      done();
      this.emit("error", err);
    });
  }
  private pipesClosed = false;
  /** After a plain kill: keep reading the child's output, discard it unparsed and uncharged. */
  private drain(): void {
    const trip = (): void => this.closePipes();
    (this.stdout as LineLimit).discard(new DrainAccount(trip));
    (this.stderr as StderrGuard).discard(new DrainAccount(trip));
  }
  /**
   * Stops reading the child's pipes FOR GOOD. In production the kill is `systemctl stop` (SIGTERM, up to 10 s of grace, then SIGKILL): a writer that survives it keeps
   * filling the pipe, and every read would still cost ~70-90 us OUTSIDE any metered section (measured: utilisation 0.96-0.99 for stdout/stderr x one-byte/64 KiB writes).
   * Idempotent. The line reader downstream tolerates it: it is fed by this adapter's own LineLimit/guard streams, not by the raw pipes, and the turn is resolved by
   * the exit event.
   */
  private closePipes(): void {
    if (this.pipesClosed) return;
    this.pipesClosed = true;
    for (const [raw, sink] of [[this.child.stdout, this.stdout], [this.child.stderr, this.stderr]] as const) {
      try {
        raw.unpipe(sink as Transform);
      } catch {
        /* already unpiped */
      }
      try {
        raw.destroy();
      } catch {
        /* already destroyed */
      }
    }
    // Our own streams END (nothing more will come): a destroyed raw pipe would otherwise never deliver the end that closes the line reader downstream.
    for (const sink of [this.stdout, this.stderr as Transform]) {
      try {
        sink.end();
      } catch {
        /* already ended */
      }
    }
  }
  /**
   * `trip` = a guard tripped (cpu_budget, stdout_flood, stderr_flood, stdout_line_too_long, event_flood): the pipes are closed for good BEFORE the signal. A plain kill
   * (normal session close, idle retirement, a graceful shutdown with its SIGTERM grace) leaves the pipes OPEN: a CLI that is shutting down must not get EPIPE on its last
   * writes (a crash during a login refresh could damage a healthy login). Its output is still READ, and discarded without parsing or charging (a read costs ~0.08 ms).
   */
  kill(trip = false): boolean {
    if (trip) this.closePipes();
    else this.drain();
    try {
      this.child.kill();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Accounting for the output of a child that has been PLAIN-killed (normal close, idle retirement): it is still read and dropped, unparsed (so a CLI winding down
 * never gets EPIPE), but a writer that ignores SIGTERM for the whole grace period (up to 10 s) must not be free. Cheap numbers only, far above anything a graceful
 * shutdown writes (a few KiB in a handful of reads): 500 reads burst (refill 200/s), 4 MiB burst (refill 64 KiB/s), and a 300 ms meter charged the fixed per-read cost
 * (refill 20 ms/s). Past any of them the pipes are closed, exactly as a guard trip does (the process is already being stopped: nothing is reported).
 */
export const DRAIN_READ_BURST = 500;
export const DRAIN_BYTE_BURST = 4 * 1024 * 1024;
export class DrainAccount {
  private readonly reads = new TokenBucket(DRAIN_READ_BURST, READS_PER_SEC);
  private readonly bytes = new TokenBucket(DRAIN_BYTE_BURST, 64 * 1024);
  private readonly meter = new CpuMeter(300, 20);
  private done = false;
  constructor(private readonly trip: () => void) {}
  /** Charges one read of `len` bytes. */
  charge(len: number): void {
    if (this.done) return;
    this.meter.charge(READ_COST_MS);
    if (this.meter.exhausted || !this.reads.take() || !this.bytes.take(len)) {
      this.done = true;
      this.trip();
    }
  }
}

/** The child's stderr, metered and bounded before the runner (which concatenates a tail per chunk) sees it. */
export class StderrGuard extends Transform {
  private readonly tail: Buffer = Buffer.alloc(STDERR_FORWARD_CAP);
  private tailLen = 0;
  private tripped = false;
  private drain: DrainAccount | undefined;
  /** Stop recording: whatever the child still writes is read, counted (see DrainAccount) and dropped (what was kept is still delivered at the end). */
  discard(account: DrainAccount): void {
    this.drain = account;
  }
  private readonly reads = new TokenBucket(READ_BURST, READS_PER_SEC);
  private readonly bytes = new TokenBucket(1024 * 1024, 64 * 1024);
  constructor(
    private readonly meter: CpuMeter,
    private readonly onFlood: () => void,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    if (this.drain) {
      this.drain.charge(chunk.length);
      return cb();
    }
    if (this.tripped || this.meter.exhausted) return cb();
    this.meter.charge(READ_COST_MS);
    this.meter.time(() => {
      if (!this.reads.take() || !this.bytes.take(chunk.length)) {
        this.tripped = true;
        this.onFlood();
        return cb();
      }
      // keep the LAST few KiB (what a diagnostic wants), delivered when the stream ends
      this.keepTail(chunk);
      cb();
    });
  }
  /** A fixed ring of the last STDERR_FORWARD_CAP bytes: no allocation per read (a trickle is thousands of reads). */
  private keepTail(chunk: Buffer): void {
    if (chunk.length >= STDERR_FORWARD_CAP) {
      chunk.copy(this.tail, 0, chunk.length - STDERR_FORWARD_CAP);
      this.tailLen = STDERR_FORWARD_CAP;
      return;
    }
    const overflow = this.tailLen + chunk.length - STDERR_FORWARD_CAP;
    if (overflow > 0) {
      this.tail.copy(this.tail, 0, overflow, this.tailLen);
      this.tailLen -= overflow;
    }
    chunk.copy(this.tail, this.tailLen);
    this.tailLen += chunk.length;
  }
  override _flush(cb: (err?: Error | null) => void): void {
    if (this.tailLen > 0) this.push(Buffer.from(this.tail.subarray(0, this.tailLen)));
    this.tailLen = 0;
    cb();
  }
}
const DROPPED_LINE = Buffer.from("{\"type\":\"aw_line_dropped\"}\n");

/** Budgets for stdout lines that are NOT events (junk, blank, incomplete): a CLI printing them fast costs the host's event loop (the runner JSON.parses every non-empty line and throws on junk). */
export const JUNK_LINE_BURST = 200;
export const JUNK_LINES_PER_SEC = 50;
export const JUNK_BYTE_BURST = 1024 * 1024;
export const JUNK_BYTES_PER_SEC = 128 * 1024;
/** Budget for lines that ARE event-shaped: honest streams are a few dozen events a second; a flood of tiny valid ones (`{}`) is as costly as junk. */
export const EVENT_LINE_BURST = 5000;
export const EVENT_LINES_PER_SEC = 2000;
/**
 * Bytes of event lines. The runner JSON.parses every forwarded line (about 5 ms and 20 MB of heap per MB for an array of numbers), so bytes, not only lines, are
 * what a hostile CLI spends. Honest traffic: the CLI echoes each tool result once in a `user` event (up to the relay\'s 8 MiB frame) and the final result text, plus
 * small events; a turn with several big results is a burst of tens of MiB, then quiet. Burst 64 MiB: a 6 MB image result (base64 in the echoed `user` event) echoed twice
 * is 12 MB, and several of those in a few seconds must not be killed; sustained 4 MiB/s (1 MiB lines measured at 96 lines/s, event-loop utilization 0.98, never
 * touched the line bucket, so the byte bucket is what ends that).
 */
export const EVENT_BYTE_BURST = 64 * 1024 * 1024;
export const EVENT_BYTES_PER_SEC = 4 * 1024 * 1024;
/**
 * Values (commas, objects and arrays outside strings) in ONE event line. A 16 MB array of `0` is 8 million values (488 ms and +357 MB of heap in JSON.parse), an
 * array of `{}` 5 million (1.7 s, +1.3 GB). Honest events have far fewer: the init event lists the tools (~270 tools, a few thousand values each at most, well under
 * 50,000 in all); text and tool results are strings (one value). 150,000 is three times the largest honest line and a 64x cut of the worst hostile one.
 */
export const MAX_LINE_VALUES = 150_000;

/**
 * THE single authority on what a line of the CLI's stdout is (the runner's readline reads what comes out of here). It
 *  - calls `onOverflow` once if a single line exceeds `max` bytes, and forwards nothing after that;
 *  - bounds the JSON nesting of every line BEFORE anything parses it: a line nested deeper than MAX_CLI_LINE_DEPTH is cut where it passes the limit, the rest
 *    of it is discarded up to its end and replaced by a fixed placeholder line (`onDeep`); a megabytes-deep line would cost seconds in JSON.parse;
 *  - rewrites every lone \r and every \r\n to ONE \n (the runner's readline ends a line at \n, \r\n and a lone \r; U+2028/2029 do not split), so the runner
 *    sees exactly the lines counted here (state survives chunk edges; empty lines are ignored by the runner);
 *  - forwards ONLY event-shaped lines: a real stream-json event is one complete JSON object, so the first non-space byte is `{` and the last is `}` with the
 *    nesting back at zero outside a string. Everything else (`x`, `{`, `[1]`, an unterminated object) is dropped before the runner JSON.parses it and throws.
 *    An event line is held (copied into one growing buffer, never more than `max`) until its end, so the decision does not depend on how the bytes were chunked;
 *  - charges junk and blank lines (lines/s and bytes/s) and event-shaped lines (lines/s) to token buckets: past them the stream is treated like an overflow
 *    (`onFlood`: the CLI is killed). Honest output is a few events per second and no junk.
 * One pass over the bytes, no recursion, `indexOf` rather than a rescan per dropped line, and no extra buffer per \r (the chunk is copied once, on the first
 * \r, and rewritten in place).
 */
export class LineLimit extends Transform {
  private run = 0;
  private tripped = false;
  private depth = 0;
  private inString = false;
  private esc = false;
  /** 0: forwarding; 2: the rest of a junk, too-deep or too-dense line is being discarded (its bytes are charged to the junk bucket). */
  private skipping: 0 | 2 = 0;
  private values = 0;
  private lineStarted = false;
  private lastSig = 0;
  private afterCR = false;
  /** The part of an unfinished event line seen in earlier chunks (one buffer, copied into: it never keeps a read buffer alive). */
  private carry: Buffer | undefined;
  private carryLen = 0;
  /** Lines dropped because they were not events (a counter, for tests and diagnostics). */
  junkLines = 0;
  private lineTokens = JUNK_LINE_BURST;
  private byteTokens = JUNK_BYTE_BURST;
  private eventTokens = EVENT_LINE_BURST;
  private eventByteTokens = EVENT_BYTE_BURST;
  private lastRefill = performance.now();
  constructor(
    private readonly max: number,
    private readonly onOverflow: () => void,
    private readonly onDeep: () => void = () => undefined,
    private readonly onFlood: () => void = onOverflow,
    private readonly meter: CpuMeter = new CpuMeter(),
  ) {
    super();
  }
  /** Reads (chunks) per turn: a tiny read costs ~8 us through socket, pipe, Transform and readline, so one-byte writes are a flood by COUNT as well as by time. */
  private readonly reads = new TokenBucket(READ_BURST, READS_PER_SEC);
  private endLine(): void {
    this.run = 0;
    this.depth = 0;
    this.inString = false;
    this.esc = false;
    this.skipping = 0;
    this.lineStarted = false;
    this.lastSig = 0;
    this.values = 0;
  }
  private stop(cb: (err?: Error | null, data?: Buffer) => void, why: () => void): void {
    this.tripped = true;
    this.carry = undefined;
    why();
    cb();
  }
  private carryAppend(src: Buffer): void {
    const need = this.carryLen + src.length;
    if (!this.carry || need > this.carry.length) {
      const next = Buffer.allocUnsafe(Math.max(need, Math.min(this.max, Math.max(this.carry?.length ?? 0, 4096) * 2)));
      if (this.carry) this.carry.copy(next, 0, 0, this.carryLen);
      this.carry = next;
    }
    src.copy(this.carry, this.carryLen);
    this.carryLen = need;
  }
  /** The carried head of the line, as a buffer of its own; the carry is released (a large one is never kept for the next line). */
  private takeCarry(): Buffer {
    const head = Buffer.from(this.carry!.subarray(0, this.carryLen));
    this.carryLen = 0;
    if (this.carry!.length > 64 * 1024) this.carry = undefined;
    return head;
  }
  private dropCarry(): void {
    this.carryLen = 0;
    if (this.carry && this.carry.length > 64 * 1024) this.carry = undefined;
  }
  get retained(): { capacity: number; pending: number } {
    return { capacity: this.carry?.length ?? 0, pending: this.carryLen };
  }
  override _flush(cb: (err?: Error | null) => void): void {
    // the stream ended in the middle of a line: readline delivers an unterminated last line, so a complete object is still forwarded
    if (!this.tripped && this.skipping === 0 && this.lineStarted && this.depth === 0 && !this.inString && this.lastSig === 0x7d && this.carryLen > 0) this.push(this.takeCarry());
    cb();
  }
  /**
   * Every chunk is metered: the WHOLE synchronous section is timed, including the downstream push (readline, the runner's JSON.parse and the session's callbacks all run
   * inside it), so what the unit makes the host do is what is charged, however it made it expensive.
   */
  private drain: DrainAccount | undefined;
  /** Stop parsing: whatever the child still writes is read, counted (see DrainAccount) and dropped. */
  discard(account: DrainAccount): void {
    this.drain = account;
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    if (this.drain) {
      this.drain.charge(chunk.length);
      return cb();
    }
    if (this.tripped || this.meter.exhausted) return cb();
    this.meter.charge(READ_COST_MS);
    if (!this.reads.take()) return this.stop(cb, this.onFlood);
    this.meter.time(() => this.scan(chunk, cb));
  }
  private scan(chunk: Buffer, cb: (err?: Error | null, data?: Buffer) => void): void {
    if (this.tripped) return cb();
    const n = chunk.length;
    const out: Buffer[] = [];
    let buf = chunk; // copied on the first \r (see above); scanning always reads `chunk`
    let start = 0; // start of the bytes still to be forwarded
    let lineBeg = 0; // where the current line begins in this chunk (0: it began earlier, or begins here)
    let nextLF = -2; // cached positions of the next \n and \r at or after i (-1: none left)
    let nextCR = -2;
    let nextQuote = -2; // (the same cache for the bytes that can end a string body)
    let nextBackslash = -2;
    let jl = 0; // non-event lines seen in this chunk
    let jb = 0; // bytes of non-event lines
    let el = 0; // event-shaped lines seen in this chunk
    let eb = 0; // bytes of those
    let i = 0;
    while (i < n) {
      if (this.skipping !== 0) {
        if (nextLF !== -1 && nextLF < i) nextLF = chunk.indexOf(10, i);
        if (nextCR !== -1 && nextCR < i) nextCR = chunk.indexOf(13, i);
        const nl = nextLF < 0 ? nextCR : nextCR < 0 ? nextLF : Math.min(nextLF, nextCR);
        const end = nl < 0 ? n : nl;
        this.run += end - i;
        if (this.skipping === 2) jb += end - i;
        if (this.run > this.max) return this.stop(cb, this.onOverflow);
        if (nl < 0) {
          start = n;
          break;
        }
        this.afterCR = chunk[nl] === 13;
        this.endLine();
        start = lineBeg = i = nl + 1; // the terminator itself is dropped (a placeholder line, if any, was sent complete)
        continue;
      }
      // The body of a string (an image, a tool result: megabytes of base64 or text) cannot change anything until a quote, a backslash or a line end: jump straight there
      // (memchr speed, about 7x cheaper than a byte at a time) with the exact same state. The line cap is checked on the jump.
      if (this.inString && !this.esc && this.lineStarted && this.skipping === 0) {
        if (nextQuote !== -1 && nextQuote < i) nextQuote = chunk.indexOf(0x22, i);
        if (nextBackslash !== -1 && nextBackslash < i) nextBackslash = chunk.indexOf(0x5c, i);
        if (nextLF !== -1 && nextLF < i) nextLF = chunk.indexOf(10, i);
        if (nextCR !== -1 && nextCR < i) nextCR = chunk.indexOf(13, i);
        let target = n;
        for (const p of [nextQuote, nextBackslash, nextLF, nextCR]) if (p >= 0 && p < target) target = p;
        if (target > i) {
          this.run += target - i;
          if (this.run > this.max) return this.stop(cb, this.onOverflow);
          i = target;
          continue;
        }
      }
      const c = chunk[i];
      if (c === 10 && this.afterCR) {
        // the \n of a \r\n: the \r was already turned into the line end
        this.afterCR = false;
        if (i > start) out.push(buf.subarray(start, i));
        start = lineBeg = ++i;
        continue;
      }
      this.afterCR = false;
      if (c === 13 || c === 10) {
        if (c === 13) {
          if (buf === chunk) buf = Buffer.from(chunk);
          buf[i] = 10;
          this.afterCR = true;
        }
        if (!this.lineStarted) {
          // a blank (or whitespace-only) line: dropped, and its bytes are charged (30 lines of 8 MB of spaces used to pass unthrottled)
          jl++;
          jb += this.run;
          if (lineBeg > start) out.push(buf.subarray(start, lineBeg));
          start = i + 1;
        } else if (this.depth === 0 && !this.inString && this.lastSig === 0x7d) {
          el++; // a complete object: forwarded (the carried head of it first)
          eb += this.run + 64 * this.values; // cost units: a byte, plus 64 for each value (a value costs far more than a byte to parse and normalize)
          if (this.carryLen > 0) out.push(this.takeCarry());
        } else {
          // event-shaped at the start, but not a complete object: it would only make the runner's JSON.parse throw
          jl++;
          jb += this.run;
          this.junkLines++;
          this.dropCarry();
          if (lineBeg > start) out.push(buf.subarray(start, lineBeg));
          start = i + 1;
        }
        this.endLine();
        lineBeg = ++i;
        continue;
      }
      if (!this.lineStarted) {
        if (c === 0x20 || c === 0x09) {
          if (++this.run > this.max) return this.stop(cb, this.onOverflow);
          i++;
          continue;
        }
        if (c !== 0x7b) {
          // not an event: forward what precedes this line, discard the rest of it
          if (lineBeg > start) out.push(buf.subarray(start, lineBeg));
          start = n;
          this.skipping = 2;
          this.junkLines++;
          jl++;
          jb++;
          this.run++;
          i++;
          continue;
        }
        this.lineStarted = true;
      }
      if (++this.run > this.max) return this.stop(cb, this.onOverflow);
      if (c !== 0x20 && c !== 0x09) this.lastSig = c;
      if (this.inString) {
        if (this.esc) this.esc = false;
        else if (c === 0x5c) this.esc = true;
        else if (c === 0x22) this.inString = false;
      } else if (c === 0x22) this.inString = true;
      else if (c === 0x7b || c === 0x5b) {
        if (++this.depth > MAX_CLI_LINE_DEPTH || ++this.values > MAX_LINE_VALUES) {
          // Too deep or too dense: NOTHING of the line is forwarded (its head is junk), only the fixed placeholder; the rest is discarded and the line is charged
          // (lines and bytes) to the junk bucket, so a stream of such lines ends in stdout_flood instead of costing a parse exception each.
          this.dropCarry();
          if (lineBeg > start) out.push(buf.subarray(start, lineBeg));
          out.push(DROPPED_LINE);
          start = n;
          this.skipping = 2;
          this.junkLines++;
          jl++;
          jb += this.run;
          this.onDeep();
        }
      } else if (c === 0x2c) {
        if (++this.values > MAX_LINE_VALUES) {
          this.dropCarry();
          if (lineBeg > start) out.push(buf.subarray(start, lineBeg));
          out.push(DROPPED_LINE);
          start = n;
          this.skipping = 2;
          this.junkLines++;
          jl++;
          jb += this.run;
          this.onDeep();
        }
      } else if ((c === 0x7d || c === 0x5d) && this.depth > 0) this.depth--;
      i++;
    }
    // the chunk ended: an unfinished event line is held (copied) until its end, whitespace before a line's first byte is dropped
    if (this.skipping === 0) {
      if (lineBeg > start) out.push(buf.subarray(start, lineBeg));
      if (this.lineStarted && lineBeg < n) this.carryAppend(buf.subarray(lineBeg));
      start = n;
    }
    if (start < n) out.push(buf.subarray(start));
    if (jl > 0 || jb > 0 || el > 0 || eb > 0) {
      const now = performance.now();
      const dt = Math.max(0, now - this.lastRefill) / 1000;
      this.lastRefill = now;
      this.lineTokens = Math.min(JUNK_LINE_BURST, this.lineTokens + dt * JUNK_LINES_PER_SEC) - jl;
      this.byteTokens = Math.min(JUNK_BYTE_BURST, this.byteTokens + dt * JUNK_BYTES_PER_SEC) - jb;
      this.eventTokens = Math.min(EVENT_LINE_BURST, this.eventTokens + dt * EVENT_LINES_PER_SEC) - el;
      this.eventByteTokens = Math.min(EVENT_BYTE_BURST, this.eventByteTokens + dt * EVENT_BYTES_PER_SEC) - eb;
      if (this.lineTokens < 0 || this.byteTokens < 0 || this.eventTokens < 0 || this.eventByteTokens < 0) return this.stop(cb, this.onFlood);
    }
    cb(null, out.length === 0 ? undefined : out.length === 1 ? out[0] : Buffer.concat(out));
  }
}

/**
 * An async queue between the runner's event sink (pushes as the CLI prints) and the turn generator (pulled at
 * the pace of the host's consumer). Bounded by an approximate byte budget: a consumer that stops reading must
 * not let a chatty CLI grow the host's memory without limit.
 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: Array<{ v: T; size: number }> = [];
  private waiter: (() => void) | undefined;
  private ended = false;
  private bytes = 0;
  overflowed = false;
  constructor(private readonly maxBytes: number) {}
  push(v: T, size: number): void {
    if (this.ended) return;
    if (this.bytes + size > this.maxBytes) {
      this.overflowed = true;
      this.end();
      return;
    }
    this.items.push({ v, size });
    this.bytes += size;
    this.waiter?.();
  }
  end(): void {
    this.ended = true;
    this.waiter?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      while (this.items.length) {
        const it = this.items.shift() as { v: T; size: number };
        this.bytes -= it.size;
        yield it.v;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.waiter = resolve));
      this.waiter = undefined;
    }
  }
}

interface ShortResult {
  code: number | null;
  timedOut: boolean;
  output: string;
}

export class ClaudeAdapter implements SubscriptionProviderAdapter {
  readonly id = "claude";
  readonly flagKey = "claudeSubscription";
  readonly homeEnvVar = "CLAUDE_CONFIG_DIR";
  readonly ceremony = "paste_code" as const;
  readonly toolTransport = "mcp_direct" as const;
  /** Shared-dir concurrent refresh was verified up to 8 refreshers and crash-safe; the recorded cap is 3. */
  readonly maxProcessesPerHome = 3;
  readonly maxTurnsPerProcess = 1;
  readonly singleUse = true;
  /** Serves a turn's tools through the host relay when configured (turn.run `tools`). */
  readonly relay: boolean;
  readonly loginTtlMs = 10 * 60 * 1000;
  readonly models: ReadonlySet<string>;

  private readonly logins = new WeakMap<LoginProcess, LoginState>();
  private readonly cfg: Required<Omit<ClaudeAdapterConfig, "binary" | "models" | "relay" | "log">> & Pick<ClaudeAdapterConfig, "binary" | "relay" | "log">;

  constructor(config: ClaudeAdapterConfig) {
    this.cfg = { ...DEFAULTS, ...stripUndefined(config) } as ClaudeAdapter["cfg"];
    // The protocol's name cap assumes the default server name; a longer one would let a name through that the model API refuses once qualified.
    if (qualifiedToolPrefix(this.cfg.mcpServerName).length > qualifiedToolPrefix(RELAY_MCP_SERVER_NAME).length) throw new Error("claude adapter: mcpServerName longer than the protocol's tool-name cap allows");
    this.models = new Set(config.models ?? DEFAULTS.models);
    this.relay = !!config.relay;
  }

  binary(): { path: string; version: string; digest: string } {
    return this.cfg.binary;
  }

  /** Claude needs nothing written into a fresh home: the port created home/work/tmp, and no settings may exist (managed or user). */
  async prepareHome(): Promise<void> {
    /* intentionally empty */
  }

  /** The environment of the short commands (login/status/doctor/logout): HOME is the connection's own tmp dir. */
  private shortEnv(ctx: AdapterContext): NodeJS.ProcessEnv {
    return allowlistedEnv(this.cfg.basePath, ctx.homeDir, ctx.tmpDir, { TMPDIR: ctx.tmpDir });
  }

  private spawnCli(ctx: AdapterContext, args: string[]): ChildLike {
    const spec: SpawnSpec = { file: this.cfg.binary.path, args, env: this.shortEnv(ctx) as Record<string, string>, cwd: ctx.workDir };
    return ctx.spawnAs(spec);
  }

  /** Runs a non-interactive CLI command to completion (stdin closed, output collected and capped, killed on timeout). */
  private runShort(ctx: AdapterContext, args: string[], timeoutMs = this.cfg.shortCommandTimeoutMs): Promise<ShortResult> {
    return new Promise<ShortResult>((resolve) => {
      let child: ChildLike;
      try {
        child = this.spawnCli(ctx, args);
      } catch {
        return resolve({ code: null, timedOut: false, output: "" });
      }
      let output = "";
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, timedOut, output });
      };
      const onData = (chunk: Buffer) => {
        if (output.length < MAX_LOGIN_OUTPUT_CHARS) output += chunk.toString("utf8");
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.stdin.on("error", () => undefined);
      child.stdin.end();
      child.onExit((code) => finish(code));
      child.onError?.(() => finish(null));
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        // Resolve when the process is really gone; give up after the kill wait if it is not (a failing kill must not hang the caller).
        killTimer = setTimeout(() => finish(null), this.cfg.killWaitMs);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
    });
  }

  // ───────────────────────────── sign-in (paste code) ─────────────────────────────

  async loginStart(ctx: AdapterContext): Promise<LoginProcess> {
    const child = this.spawnCli(ctx, ["auth", "login"]);
    const st: LoginState = { child, output: "", exited: false, exitCode: null, used: false, exitWaiters: [] };
    const onData = (chunk: Buffer) => {
      if (st.output.length < MAX_LOGIN_OUTPUT_CHARS) st.output += chunk.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => undefined);
    const markExit = (code: number | null) => {
      st.exited = true;
      st.exitCode = code;
      st.exitWaiters.splice(0).forEach((f) => f());
    };
    child.onExit((code) => markExit(code));
    child.onError?.(() => markExit(-1));

    const url = await new Promise<string | undefined>((resolve) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const found = extractAuthorizeUrl(st.output);
        if (found) {
          clearInterval(poll);
          resolve(found);
        } else if (st.exited || Date.now() - started > this.cfg.startTimeoutMs) {
          clearInterval(poll);
          resolve(undefined);
        }
      }, 25);
    });
    if (!url) {
      const timedOut = !st.exited;
      await this.killLogin(st);
      throw Object.assign(new Error(timedOut ? "start_timeout" : "start_failed"), { code: timedOut ? "start_timeout" : "start_failed" });
    }
    const proc: LoginProcess = { data: { url } };
    this.logins.set(proc, st);
    return proc;
  }

  async loginComplete(proc: LoginProcess, code: string): Promise<void> {
    const st = this.logins.get(proc);
    if (!st || st.used) throw Object.assign(new Error("login_gone"), { code: "login_gone" });
    st.used = true;
    try {
      if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw Object.assign(new Error("bad_code_format"), { code: "bad_code_format" });
      if (st.exited) throw Object.assign(new Error("login_gone"), { code: "login_gone" });
      st.child.stdin.write(`${code}\n`); // the one place the code goes: the CLI's stdin
      if (!(await this.waitExit(st, this.cfg.completeTimeoutMs))) throw Object.assign(new Error("complete_timeout"), { code: "complete_timeout" });
      if (st.exitCode !== 0) throw Object.assign(new Error("code_rejected"), { code: "code_rejected" });
    } catch (err) {
      await this.killLogin(st);
      throw err;
    }
  }

  async loginCancel(proc: LoginProcess): Promise<void> {
    const st = this.logins.get(proc);
    if (st) await this.killLogin(st);
  }

  private waitExit(st: LoginState, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (st.exited) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
      st.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async killLogin(st: LoginState): Promise<void> {
    if (st.exited) return;
    try {
      st.child.kill();
    } catch {
      /* already gone */
    }
    await this.waitExit(st, this.cfg.killWaitMs);
  }

  // ───────────────────────────── status, hazards, logout ─────────────────────────────

  async authStatus(ctx: AdapterContext): Promise<AuthStatus> {
    const r = await this.runShort(ctx, ["auth", "status"]);
    const parsed = parseAuthStatus(r.output); // a logged-out CLI prints JSON and exits 1: the exit code is not the signal
    if (!parsed) throw new Error("status_unparseable");
    return parsed;
  }

  async hazards(ctx: AdapterContext): Promise<Hazard[]> {
    const r = await this.runShort(ctx, ["doctor"]);
    if (r.timedOut || r.output.trim() === "") return [{ kind: "other", detail: "doctor_failed" }];
    return parseDoctorHazards(r.output);
  }

  async logout(ctx: AdapterContext): Promise<void> {
    await this.runShort(ctx, ["auth", "logout"]); // best effort: the host wipes the home next
  }

  expiryModel(signedInAtMs: number): { refreshExpiresAtMs?: number } {
    return { refreshExpiresAtMs: signedInAtMs + 30 * 24 * 60 * 60 * 1000 };
  }

  mapError(raw: unknown): ErrorKind {
    if (raw instanceof ClaudeCliTurnError) return "transient";
    const message = (raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "").slice(0, MAX_CLASSIFY_CHARS); // bounded: the patterns below must never scan CLI-controlled text of any length
    if (/mcp server .* is not connected|stdout_line_too_long|stdout_flood|stderr_flood|cpu_budget|event_flood/i.test(message)) return "transient";
    if ((raw as { code?: string } | null)?.code === "open_failed") return "transient";
    return failureClassToKind(classifyFailureText(message)); // never auth_dead: host faults must not park a healthy login
  }

  // ───────────────────────────── sessions (one process per turn) ─────────────────────────────

  async openSession(ctx: AdapterContext, spec: SessionSpec): Promise<ProviderSession> {
    return new ClaudeSession(this, this.cfg, ctx, spec);
  }

  /** Used by sessions: runs `auth status` to confirm that an auth-looking failure really means the login is dead. */
  async confirmLoggedOut(ctx: AdapterContext): Promise<ErrorKind> {
    try {
      const r = await this.runShort(ctx, ["auth", "status"], this.cfg.authConfirmTimeoutMs);
      const st = parseAuthStatus(r.output);
      if (!st) return "transient"; // unreadable or timed out: uncertainty is never death
      return st.loggedIn ? "transient" : "auth_dead"; // a login the CLI itself reports as signed in is NOT dead: a failed refresh on the network prints similar words
    } catch {
      return "transient"; // uncertain => never park a possibly healthy login
    }
  }
}

interface LoginState {
  child: ChildLike;
  output: string;
  exited: boolean;
  exitCode: number | null;
  used: boolean;
  exitWaiters: Array<() => void>;
}

/** Cheap size estimate of one normalized event (the text it carries plus a fixed overhead); exactness is not needed for a memory bound. */
export function approxSize(ev: ProviderEvent, measuredBytes?: number): number {
  if (ev.type === "text") return 64 + ev.delta.length;
  // NEVER JSON.stringify an input here: it is the shim's (tool-call) or the CLI's (tool-use) data, and a deeply nested value makes stringify throw a RangeError, which
  // from a timer or an event handler is an uncaught exception that ends the whole host. A tool-call uses the frame size the relay already measured.
  if (ev.type === "tool-call") return 128 + (measuredBytes ?? approxJsonBytes(ev.input, MAX_EVENT_BYTES, QUEUE_NODE_BYTES));
  if (ev.type === "tool-use") return 128 + approxJsonBytes(ev.input, MAX_EVENT_BYTES, QUEUE_NODE_BYTES);
  // every other event: its REAL payload (a result carries the whole answer text; an entitlement carries window names and status words). No fixed weight for a variable event.
  return 128 + approxJsonBytes(ev, MAX_EVENT_BYTES, QUEUE_NODE_BYTES);
}
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
/** Memory a parsed object or array occupies beyond its JSON text, for the queue's size accounting (an event of 70,000 empty objects: 0.7 MB of JSON, ~27 MB of heap). */
const QUEUE_NODE_BYTES = 128;

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

class ClaudeSession implements ProviderSession {
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private readonly runner: ClaudeCliRunner;
  private readonly exits: Array<Promise<void>> = [];
  private key: string | undefined;
  private handle: ClaudeCliSessionHandle | undefined;
  private used = false;
  private interrupted = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private spawning: Promise<unknown> | undefined;
  /** An in-flight `auth status` confirmation: the session (and so its cap slot) stays alive until it settles. */
  private confirming: Promise<unknown> | undefined;

  constructor(
    private readonly adapter: ClaudeAdapter,
    private readonly cfg: ClaudeAdapter["cfg"],
    private readonly ctx: AdapterContext,
    private readonly spec: SessionSpec,
  ) {
    this.closed = new Promise<void>((r) => (this.resolveClosed = r));
    this.runner = new ClaudeCliRunner({
      maxConcurrentProcesses: 1,
      ports: {
        spawnProcess: (s: ClaudeCliSpawnSpec) => {
          const child = new RunnerChildAdapter(
            ctx.spawnAs({ file: cfg.turnWrapperPath, args: [s.file, ...s.args], env: s.env as Record<string, string>, cwd: s.cwd, ...(this.relayEp ? { relayDir: this.relayEp.dir } : {}) }),
            cfg.maxLineBytes,
            () => this.noteDeepLine(),
            this.meter,
          );
          this.exits.push(child.exited);
          this.childAdapter = child;
          return child;
        },
        scratch: { create: () => join(cfg.unitTmp, "aw-home"), remove: () => undefined }, // created by the wrapper inside the unit's private tmp; it vanishes with the unit
        binaryPath: cfg.binary.path,
        buildEnv: (configDir, home) => allowlistedEnv(cfg.basePath, configDir, home, { TMPDIR: cfg.unitTmp, ...(this.relayEp ? { AW_TURN_TOOLS: "1", ...relayCliEnv(this.relayCallTimeoutMs?.() ?? 1000) } : {}) }), // the wrapper reads the tool manifest line and removes the variable
      },
    });
  }

  private readonly deepLineLog = new LogThrottle(3, 60_000);
  /** A line of the CLI's stdout nested too deeply was dropped (see LineLimit): one fixed-code line, throttled; the customer's process is not otherwise punished. */
  private noteDeepLine(): void {
    try {
      if (this.deepLineLog.check("cli_line_too_deep").log) this.cfg.log?.warn("cli_line_too_deep");
    } catch {
      /* logging is best effort */
    }
  }

  /** Lazy: the process starts with the turn (it needs that turn's token and model), so there is nothing to check yet. */
  async preflight(): Promise<{ ok: true }> {
    return { ok: true };
  }

  /**
   * Legacy turns (mcp_direct): the CLI calls the HTTP bridge itself, nothing is relayed. Relay turns: the answer to a `tool-call` goes to the shim's socket.
   * Returns false when that operation is no longer pending (the relay's own timer fired, the shim is gone, the turn ended): "result lost".
   */
  answer(operationId: string, answer: ServerRequestAnswer): boolean {
    // After an interrupt or a close the turn is over (the process may still be exiting): an answer is a lost result, never "delivered".
    if (!this.relayEp || this.closing || this.interrupted || answer.kind !== "tool-result") return false;
    let sent: boolean;
    try {
      sent = this.relayEp.answer(operationId, { content: answer.content, isError: !answer.ok, ...(answer.images ? { images: answer.images } : {}), ...(answer.tools ? { tools: answer.tools } : {}) });
    } catch {
      return false; // fails closed: the caller reports the result as lost
    }
    if (sent) for (const t of answer.tools ?? []) this.visibleTools.add(t.name); // the shim lists them now: the host must accept calls to them
    return sent;
  }

  // ── tool relay (ENG-2113) ──

  /** Model message ids of tool_use blocks seen in the stream and not yet claimed by a relayed call: (bare name, canonical input) -> message id. */
  private readonly streamUses: Array<{ messageId: string; name: string; key: string | undefined }> = [];
  /** The call waiting for its message id. `key` is its input's digest, computed ONCE when the call arrives (undefined: too large to hash, matched by name only). */
  private waiting: { call: RelayCall; timer: NodeJS.Timeout; key: string | undefined } | undefined;
  private events: AsyncQueue<ProviderEvent> | undefined;
  private relayEp: RelayEndpoint | undefined;
  /** The in-flight relay.open(): a close that arrives meanwhile waits for it, so the endpoint it creates is never left behind. */
  private relayOpening: Promise<RelayEndpoint> | undefined;
  private readonly visibleTools = new Set<string>();
  /** This turn's CPU meter and normalized-events bucket (replaced at the start of every turn). */
  private meter = new CpuMeter();
  private eventBucket = new TokenBucket(EVENT_BURST, EVENTS_PER_SEC);
  private readonly budgetLog = new LogThrottle(3, 60_000);
  /** The current turn's child adapter (for a trip raised by the session itself). */
  private childAdapter: RunnerChildAdapter | undefined;
  private noteBudget(code: "cpu_budget" | "event_flood" | "event_blocks_dropped"): void {
    try {
      if (this.budgetLog.check(code).log) this.cfg.log?.warn(code);
    } catch {
      /* logging is best effort */
    }
  }
  /** Bytes canonicalized and hashed for matching in the current turn (stream announcements and call inputs together): a hard budget, then name-only matching. */
  private hashedBytes = 0;
  /** The turn's remaining call clock (relay turns only): the CLI's own tool timeout is set from it (see relayCliEnv). */
  private relayCallTimeoutMs: (() => number) | undefined;
  private spendHash(bytes: number): boolean {
    if (this.hashedBytes + bytes > TURN_HASH_BUDGET_BYTES) return false;
    this.hashedBytes += bytes;
    return true;
  }

  /** A tool_use block from the stream (informational ONLY: it is never executed or registered, it just tells us which model message a relayed call belongs to). */
  private noteStreamUse(raw: Record<string, unknown>): void {
    if (raw.type !== "assistant") return;
    const msg = raw.message as { id?: unknown; content?: unknown } | undefined;
    if (!msg || typeof msg.id !== "string" || !Array.isArray(msg.content)) return;
    const prefix = qualifiedToolPrefix(this.cfg.mcpServerName);
    // A hostile CLI can print a 16 MB line of a quarter million tiny blocks: look at a bounded number of blocks per event, and record a bounded number of announcements.
    const blocks = msg.content as Array<Record<string, unknown>>;
    let recorded = 0;
    for (let i = 0; i < blocks.length && i < MAX_BLOCKS_PER_EVENT && recorded < MAX_STREAM_USES; i++) {
      const b = blocks[i];
      if (b?.type !== "tool_use" || typeof b.name !== "string" || !b.name.startsWith(prefix)) continue;
      const name = b.name.slice(prefix.length);
      if (!this.visibleTools.has(name)) continue; // the stream is hostile input: only tools the turn can call are ever remembered
      // Bounded memory whatever the CLI prints: a fixed-size digest of the input (not the input), a truncated id, and at most MAX_STREAM_USES entries (oldest dropped).
      // An over-long id is NOT recorded (never sliced: in V8 a slice keeps the whole original string alive). The call then gets a unique unmatched id.
      if (msg.id.length > MAX_MESSAGE_ID_CHARS) continue;
      const input = b.input ?? {};
      // (estimated only up to the hashing limit: walking a 1 MiB input to learn its exact size cost ~100 ms for nothing, and over the limit it is name-only anyway)
      const inputBytes = approxJsonBytes(input, MAX_HASHED_CALL_BYTES + 1);
      // An input over 64 KiB is NEVER canonicalised or hashed (the same rule as a call's arguments, MAX_HASHED_CALL_BYTES): canonicalising a 116k-key object takes ~0.6 s of
      // loop, and eight turns doing it every 50 ms pinned the host for 26 s. It is announced by NAME only (key undefined): a call can still be tied to it when exactly one
      // announcement of that tool exists. Under the limit, the hashing budget of the turn applies.
      let key: string | undefined;
      if (inputBytes <= MAX_HASHED_CALL_BYTES) {
        if (!this.spendHash(inputBytes + 64)) continue; // the turn's hashing budget is spent: not recorded (the call then gets a unique unmatched id)
        key = digest(canonicalJson(input));
      }
      this.streamUses.push({ messageId: msg.id, name, key });
      recorded++;
      if (this.streamUses.length > MAX_STREAM_USES) this.streamUses.splice(0, this.streamUses.length - MAX_STREAM_USES);
    }
    // Only a NEW announcement can change which message a waiting call belongs to: re-checking on every line a hostile CLI prints would let it multiply the work.
    if (recorded > 0) this.flushWaiting(false);
  }

  /** Emits the waiting call once the stream has shown its model message (or, with `force`, without one after the wait). */
  private flushWaiting(force: boolean): void {
    const w = this.waiting;
    if (!w || !this.events) return;
    const key = w.key;
    const exact = key === undefined ? undefined : this.streamUses.find((u) => u.name === w.call.name && u.key === key);
    const byName = this.streamUses.filter((u) => u.name === w.call.name);
    const hit = exact ?? (byName.length === 1 ? byName[0] : undefined);
    if (!hit && !force) return;
    if (hit) this.streamUses.splice(this.streamUses.indexOf(hit), 1); // claimed: forgotten
    clearTimeout(w.timer);
    this.waiting = undefined;
    // Without a match the id is unique to this call, so the backend never collapses it with another one (a duplicate EXECUTION is worse than a missed collapse).
    const messageId = hit?.messageId ?? `unmatched-${w.call.operationId.slice(0, 16)}`;
    const ev: ProviderEvent = { type: "tool-call", operationId: w.call.operationId, messageId, name: w.call.name, input: w.call.args };
    this.events.push(ev, approxSize(ev, w.call.bytes + 64));
    if (this.events.overflowed) void this.close();
  }

  /**
   * Runs relay work that follows shim- or CLI-controlled input. Nothing here may throw into a timer or an event handler (an uncaught exception ends the whole
   * host for every customer): on any failure the pending call is answered with an internal error and the endpoint is closed (the shim loses its socket, the
   * turn carries on without tools). The log line carries a fixed code only.
   */
  private guarded(operationId: string | undefined, fn: () => void): void {
    try {
      fn();
    } catch {
      try {
        if (operationId) this.relayEp?.reject(operationId, "internal");
        if (this.waiting) clearTimeout(this.waiting.timer);
        this.waiting = undefined;
        void this.relayEp?.close().catch(() => undefined);
      } catch {
        /* closing is best effort; the turn ends with its process */
      }
    }
  }

  private onRelayCall(call: RelayCall): void {
    if (this.closing || this.interrupted || !this.events) return;
    // A call is EXECUTED by the backend: its input is forwarded exactly or not at all (never replaced by a marker). The relay already refused deeper frames; this is the check.
    // The digest used to find the call's message is computed ONCE, here, and only for a call small enough to be worth it: re-hashing a ~1 MiB input on every stream line
    // let a hostile unit stall the event loop for tens of seconds. A larger call is matched by name only (see flushWaiting).
    let key: string | undefined;
    try {
      if (valueDepthExceeds(call.args, MAX_FORWARDED_DEPTH)) throw new Error("args_too_deep");
      if (call.bytes <= MAX_HASHED_CALL_BYTES && this.spendHash(call.bytes + 64)) key = digest(canonicalJson(call.args));
    } catch {
      this.guarded(call.operationId, () => {
        throw new Error("call_unusable");
      });
      return;
    }
    const timer = setTimeout(() => this.guarded(call.operationId, () => this.flushWaiting(true)), this.cfg.messageIdWaitMs);
    timer.unref?.();
    this.waiting = { call, timer, key };
    this.guarded(call.operationId, () => this.flushWaiting(false));
  }

  private onRelayCallEnded(operationId: string): void {
    if (this.waiting?.call.operationId !== operationId) return; // already emitted: the manager's bookkeeping expires it
    clearTimeout(this.waiting.timer);
    this.waiting = undefined;
  }

  async *turn(input: TurnInput): AsyncGenerator<ProviderEvent> {
    if (this.used) throw new Error("claude_session_single_use");
    this.used = true;
    if (this.closing || this.interrupted) return;
    const events = new AsyncQueue<ProviderEvent>(this.cfg.maxQueuedBytes);
    this.events = events;
    const key = `${this.spec.connectionId}/${input.turnId}`;
    this.key = key;
    // a fresh CPU meter and event bucket for this turn; running out of the meter ends the turn (the child adapter kills the CLI), logged once with a fixed code
    this.meter = new CpuMeter();
    this.eventBucket = new TokenBucket(EVENT_BURST, EVENTS_PER_SEC);
    this.meter.onExhausted(() => this.noteBudget("cpu_budget"));
    let result: Awaited<ReturnType<ClaudeCliRunner["send"]>> | undefined;
    let failure: unknown;
    try {
      let mcpServer: { name: string; url: string; bearerToken: string; stdio?: { command: string; args: string[]; env?: Record<string, string> } };
      let extraLines: string[] | undefined;
      if (input.relay) {
        const relay = this.cfg.relay;
        if (!relay) throw Object.assign(new Error("relay_unavailable"), { code: "open_failed" });
        this.hashedBytes = 0;
        this.relayCallTimeoutMs = input.relay.callTimeoutMs;
        for (const t of input.relay.tools) this.visibleTools.add(t.name);
        // The per-turn socket exists (and accepts) BEFORE the unit starts. Identity is fixed here, from the session, never from a frame.
        this.relayOpening = relay.host.open({
          uid: this.ctx.uid,
          identity: { connectionId: this.spec.connectionId, epoch: this.spec.epoch, turnId: input.turnId },
          onCall: (c) => this.onRelayCall(c),
          onCallEnded: (op) => this.onRelayCallEnded(op),
          allowTool: (n) => this.visibleTools.has(n),
          callTimeoutMs: input.relay.callTimeoutMs,
          meter: this.meter,
        });
        try {
          this.relayEp = await this.relayOpening;
        } catch {
          // (ENOSPC, EACCES, a leftover directory...) the host could not open the turn's socket: a host-side failure, retryable, not a failed turn. Fixed message: nothing of the error.
          throw Object.assign(new Error("relay_open_failed"), { code: "open_failed" });
        }
        if (this.closing || this.interrupted) return; // close() is waiting for this very endpoint and closes it (doClose)
        mcpServer = {
          name: this.cfg.mcpServerName,
          url: "",
          bearerToken: "",
          stdio: { command: relay.nodePath, args: [relay.shimPath], env: { AW_RELAY_SOCKET: RELAY_SOCKET_IN_UNIT, AW_RELAY_TOOLS: join(this.cfg.unitTmp, "aw-cfg", "tools.json") } },
        };
        extraLines = manifestLines(input.relay.tools);
      } else {
        if (input.bridgeToken === undefined) throw Object.assign(new Error("no_tool_transport"), { code: "open_failed" });
        mcpServer = { name: this.cfg.mcpServerName, url: this.cfg.bridgeUrl, bearerToken: input.bridgeToken };
      }
      this.spawning = this.runner.spawn(key, this.ctx.homeDir, this.cfg.systemPromptFile, {
        model: input.model,
        cwd: this.ctx.workDir,
        mcpServer,
        mcpDelivery: { via: "stdin", path: join(this.cfg.unitTmp, "aw-cfg", "mcp.json"), ...(extraLines ? { extraLines } : {}) },
      });
      await this.spawning;
      if (this.closing || this.interrupted) return;
      this.handle = { conversationId: key };
      this.runner
        .send(this.handle, input.prompt, {
          // charged to the turn's CPU meter (nested inside the stdout section that delivered the line, so charged once)
          onEvent: (raw) =>
            this.meter.time(() => {
              this.guarded(this.waiting?.call.operationId, () => this.noteStreamUse(raw));
              const blocks = (raw as { message?: { content?: unknown } }).message?.content;
              if (Array.isArray(blocks) && blocks.length > MAX_BLOCKS_NORMALIZED) this.noteBudget("event_blocks_dropped"); // blocks past the cap are not forwarded: said once, fixed code
              const evs = normalizeClaudeEvent(raw);
              // one line must not fan out into hundreds of thousands of events: normalized events per second are limited per turn
              if (!this.eventBucket.take(evs.length)) {
                this.noteBudget("event_flood");
                this.childAdapter?.kill(true); // a guard tripped: the pipes are closed before the signal
                void this.close();
                return;
              }
              for (const ev of evs) events.push(ev, approxSize(ev));
              if (events.overflowed) void this.close(); // the consumer is not keeping up: end the process rather than buffer without bound
            }),
        })
        .then(
          (r) => {
            result = r;
            events.end();
          },
          (e: unknown) => {
            failure = e;
            events.end();
          },
        );
      for await (const ev of events) yield ev;
      if (events.overflowed) {
        yield { type: "result", ok: false, text: "", errorKind: "transient" };
        return;
      }
      if (failure !== undefined) {
        yield { type: "result", ok: false, text: "", errorKind: this.adapter.mapError(failure) };
        return;
      }
      if (!result) return;
      const usage = usageFromResult(result.raw as Record<string, unknown>);
      if (usage) yield usage;
      if (!result.isError) {
        yield { type: "result", ok: true, text: result.resultText };
        return;
      }
      const cls = classifyFailureText(result.resultText);
      let errorKind: ErrorKind = failureClassToKind(cls);
      if (cls === "auth_like") {
        // (The `closing` skip below already makes the early assignment redundant for a close that arrives during the stop: no check is
        // spawned then. It stays as a second guard: `closed` must never be able to resolve before a check that does run.)
        // `confirming` is set BEFORE any await: a close() arriving while the turn's process is being stopped must find it and
        // wait (`closed` frees the cap slot, so it may not resolve before the check's own process has finished). If a close has
        // already begun, nothing is spawned at all.
        const confirmation: Promise<ErrorKind> = this.closing
          ? Promise.resolve("transient")
          : (async () => {
              // The turn's process is gone first: the check must not run beside it (one process per cap slot, and a CLI still inside its
              // stop grace may be writing a refreshed login the check would read half-written). Not gone in time => no check.
              const gone = await this.stopProcess();
              return this.closing || !gone ? "transient" : await this.adapter.confirmLoggedOut(this.ctx);
            })();
        this.confirming = confirmation;
        errorKind = await confirmation;
      }
      yield { type: "result", ok: false, text: "", errorKind };
    } catch (err) {
      if (!this.closing) yield { type: "result", ok: false, text: "", errorKind: this.adapter.mapError(err) };
    } finally {
      void this.close().catch(() => undefined);
    }
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (this.handle) this.runner.interrupt(this.handle); // a Claude session cannot continue after an interrupt: the process is closed
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  /** Asks the runner to end the turn's process and waits for it to be gone, bounded: a kill that keeps failing must not hang the turn (`close()` keeps waiting for the real exit). */
  private async stopProcess(): Promise<boolean> {
    try {
      if (this.key) this.runner.close({ conversationId: this.key });
      else this.runner.closeAll();
    } catch {
      /* a kill that threw: the process is not gone, so waiting for its exit below keeps going */
    }
    await this.spawning?.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let gone = false;
    try {
      await Promise.race([
        Promise.all(this.exits).then(() => {
          gone = true;
        }),
        new Promise<void>((r) => (timer = setTimeout(r, this.cfg.killWaitMs))),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return gone;
  }

  private async doClose(): Promise<void> {
    this.closing = true;
    try {
      try {
        if (this.key) this.runner.close({ conversationId: this.key });
        else this.runner.closeAll();
      } catch {
        /* a kill that threw: the process is not gone, so `exits` below keeps waiting for its real exit */
      }
      // A spawn that was in flight finishes (or aborts itself) first, so its process is in `exits` before we wait.
      // (Defense in depth: `ctx.spawnAs` is synchronous today, so a process cannot appear between a close request and the
      // runner registering it; the randomized lifecycle test cannot open this window. Keep it for a port that stops being synchronous.)
      await this.spawning?.catch(() => undefined);
      // An endpoint still being opened is closed once it exists (a close during open() must not leave its listener and directory behind).
      const opening = await this.relayOpening?.catch(() => undefined);
      // Resolves only when the process is really gone (the core frees the cap slot and relies on it).
      let seen: number;
      do {
        seen = this.exits.length;
        await Promise.all(this.exits);
      } while (this.exits.length !== seen);
      // ...and when the auth confirmation (a second, short-lived process on this home) has finished.
      await this.confirming?.catch(() => undefined);
      // The relay goes with the turn: no connection, pending call or socket outlives the process (or the turn that ended without one).
      if (this.waiting) clearTimeout(this.waiting.timer);
      this.waiting = undefined;
      await opening?.close().catch(() => undefined); // the endpoint opened for this turn (the same object as relayEp), whether or not the turn got to use it
    } finally {
      this.resolveClosed();
    }
  }
}


const MAX_STREAM_USES = 64;
const EVENT_BURST = 2000;
const EVENTS_PER_SEC = 200;
const READ_BURST = 2000;
/** Sustained reads per second per stream. The real CLI emits a handful of lines a second (and the wrapper and the relay shim ping every 5 s), so 200 is far above honest use. */
const READS_PER_SEC = 200;
/**
 * Loop time of one read (socket -> pipe -> Transform -> readline) that happens OUTSIDE the timed section, in ms: measured at 0.07-0.09 ms through the real adapter with
 * one-byte writes (a 950 B/s trickle cost 7-9% of the loop per stream while the section timing charged 0.4-1.3%). Charged to the meter on every chunk, in addition to the
 * timed work, so a trickle is paid for what it costs.
 */
export const READ_COST_MS = 0.08;
/** stderr is diagnostics only: at most this many bytes (the LAST ones) are ever forwarded to the runner, when the stream ends. */
const STDERR_FORWARD_CAP = 8192;
/** At most this many content blocks of one assistant event are looked at, and a call whose frame is larger than this is never hashed. */
const MAX_BLOCKS_PER_EVENT = 32;
const MAX_HASHED_CALL_BYTES = 64 * 1024;
/** Hard budget of bytes canonicalized and hashed per turn (like the backend dispatcher's announce budget). */
const TURN_HASH_BUDGET_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_ID_CHARS = 128;
const digest = (text: string): string => createHash("sha256").update(text).digest("base64");
