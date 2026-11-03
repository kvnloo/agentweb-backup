/**
 * ENG-2113: bounded, NON-RECURSIVE helpers for data a customer's unit (the shim's frames), the CLI's stdout or a request body controls.
 *
 * Why this file exists: V8's JSON.parse accepts nesting hundreds of thousands deep, but JSON.stringify, recursive walks and zod refinements over such a value
 * throw RangeError (stack overflow, around depth 5,000 on Node 22). A throw from a timer or an event handler is an uncaught exception, and that kills the whole
 * host process for every customer. So nothing that touches such data may recurse without a cap or stringify it unchecked; these functions never recurse and
 * never throw on any input.
 */

/** The deepest JSON nesting accepted in a shim frame: the frame is depth 1, its `args` object depth 2, so `args` nests at most MAX_FORWARDED_DEPTH (32) levels. Tool inputs are a few levels deep. */
export const MAX_FRAME_DEPTH = 33;
// A new AgentWeb tool must fit these; see docs/plan-route-tool-limits.md, which exists on the backend branch (manan/eng-2113-relay-backend), not on this one. Changing a value: update that doc.
/** Nesting accepted in anything forwarded to the backend or stored: tool inputs from the shim and the CLI's stream. */
export const MAX_FORWARDED_DEPTH = 32;
export const MAX_FORWARDED_BYTES = 1024 * 1024;
/** Nesting accepted in one line of the CLI's stdout: real stream-json events are a handful of levels deep; a deeper line is dropped before anything parses it. */
export const MAX_CLI_LINE_DEPTH = 64;

/**
 * Whether the JSON text in `buf` nests deeper than `max` levels of [ or {. A single pass over the bytes (strings and escapes tracked), no allocation, no parse:
 * it runs BEFORE JSON.parse, so a hostile frame never becomes a deep object at all. Unbalanced or malformed text is the parser's problem, not this function's.
 */
export function rawJsonDepthExceeds(buf: Uint8Array, max: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (inString) {
      if (c === 0x5c) i++; // backslash: skip the escaped byte
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > max) return true;
    } else if ((c === 0x7d || c === 0x5d) && depth > 0) depth--;
  }
  return false;
}

/** Whether an already parsed value nests deeper than `max` (iterative; cycles cannot occur in parsed JSON and would only stop at `max` anyway). */
export function valueDepthExceeds(value: unknown, max: number): boolean {
  if (value === null || typeof value !== "object") return false;
  const stack: Array<{ v: object; d: number }> = [{ v: value, d: 1 }];
  let visited = 0;
  while (stack.length) {
    const { v, d } = stack.pop() as { v: object; d: number };
    if (d > max) return true;
    if (++visited > 2_000_000) return true; // a structure this wide is not a tool input either
    for (const child of Array.isArray(v) ? v : Object.values(v)) if (child !== null && typeof child === "object") stack.push({ v: child, d: d + 1 });
  }
  return false;
}

/**
 * A cheap estimate of the JSON size of `value` (memory accounting, and the decision to forward or replace an informational value; never a protocol limit):
 * strings count their length, a single-digit integer 2 bytes (digit and comma: 130,000 of them are ~260 KB of real JSON), other numbers 20, keys a few bytes. Iterative; stops and returns `limit` as soon as the estimate passes it, so the work is bounded too. Never throws.
 *
 * `nodeBytes` (default 0: the JSON size) is an extra cost charged to every object and array: for MEMORY accounting (the event queue) where a JSON size understates what a
 * parsed value occupies by tens of times when it is made of many tiny containers (70,000 empty objects are 0.7 MB of JSON and ~27 MB of heap).
 */
export function approxJsonBytes(value: unknown, limit: number, nodeBytes = 0): number {
  let total = 0;
  let steps = 0;
  /** Primitives are counted on the spot (nothing is pushed for them): a 6,000,000-element array costs a bounded number of steps, not 6,000,000 stack entries. */
  const scalar = (v: unknown): void => {
    if (typeof v === "string") {
      if (v.length > limit) total = limit; // longer than the cap in characters alone
      else total += (NON_ASCII.test(v) ? Buffer.byteLength(v, "utf8") : v.length) + 3; // quotes and comma; UTF-8 length only for a string that has a non-ASCII character
    } else if (typeof v === "number") {
      const a = Math.abs(v);
      if (Number.isInteger(v) && a < 1e6) total += (a < 10 ? 1 : a < 100 ? 2 : a < 1000 ? 3 : a < 1e4 ? 4 : a < 1e5 ? 5 : 6) + (v < 0 ? 1 : 0) + 1; // its digits, a sign, the comma
      else total += 20; // a larger integer or a fraction, at its longest ordinary form
    } else total += 5; // true / false / null and the comma
  };
  if (value === null || typeof value !== "object") {
    scalar(value);
    return Math.min(total, limit);
  }
  const containers: object[] = [value];
  while (containers.length) {
    const c = containers.pop() as object;
    total += 2 + nodeBytes;
    const take = (x: unknown): void => {
      if (x !== null && typeof x === "object") containers.push(x);
      else scalar(x);
    };
    if (Array.isArray(c)) {
      // an index loop: for...in on an array first builds all its keys as strings (seconds for millions of elements)
      for (let i = 0; i < c.length; i++) {
        if (total >= limit || ++steps > 1_000_000) return limit;
        take(c[i]);
      }
    } else {
      for (const k in c) {
        if (total >= limit || ++steps > 1_000_000) return limit;
        if (!Object.prototype.hasOwnProperty.call(c, k)) continue;
        total += k.length + 4;
        take((c as Record<string, unknown>)[k]);
      }
    }
  }
  return Math.min(total, limit);
}
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * A value that came from the CLI's stream or the shim, made safe to forward to the backend or store: nested deeper than MAX_FORWARDED_DEPTH or larger than
 * MAX_FORWARDED_BYTES it becomes a FIXED marker instead (the backend's JSON.parse of a deeply nested line stalls its event loop, and the host must not be the source of
 * that). ONLY for informational data: a value that will be EXECUTED must be refused, never replaced by a marker (see ClaudeSession.flushWaiting).
 */
export function boundedValue(v: unknown): unknown {
  if (valueDepthExceeds(v, MAX_FORWARDED_DEPTH)) return { _truncated: "depth" };
  if (approxJsonBytes(v, MAX_FORWARDED_BYTES + 1) > MAX_FORWARDED_BYTES) return { _truncated: "size" };
  return v;
}

/**
 * Log throttle for lines a hostile peer can trigger at will: at most `max` per key per window; the rest are only counted, and the count is reported with the first
 * line of the next window (`suppressedBefore`) or by flush(). Keys are fixed codes, never peer data, so the map stays tiny.
 */
export class LogThrottle {
  private state = new Map<string, { start: number; logged: number; suppressed: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  check(key: string): { log: boolean; suppressedBefore: number } {
    const t = this.now();
    const s = this.state.get(key);
    if (!s || t - s.start >= this.windowMs) {
      this.state.set(key, { start: t, logged: 1, suppressed: 0 });
      return { log: true, suppressedBefore: s?.suppressed ?? 0 };
    }
    if (s.logged < this.max) {
      s.logged++;
      return { log: true, suppressedBefore: 0 };
    }
    s.suppressed++;
    return { log: false, suppressedBefore: 0 };
  }
  /** Counts suppressed and not yet reported, per key (then forgotten). */
  flush(): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    for (const [k, s] of this.state) if (s.suppressed > 0) out.push([k, s.suppressed]);
    this.state.clear();
    return out;
  }
}

/**
 * Splits a byte stream into newline-delimited lines with a hard cap on one line, in LINEAR time and BOUNDED memory however the bytes are chunked. The newline is
 * searched for ONLY in the new chunk; the bytes of an unfinished line go into ONE growing buffer (allocated lazily, doubling up to the cap, so the copying is
 * amortized linear and the memory is at most about twice the pending bytes, never one object per chunk); a finished line is copied out once. The naive loop (concat
 * the whole buffer and re-scan it on every chunk) cost about 1.8 s of event-loop time for ONE 1 MiB line fed in 64-byte chunks, and keeping a Buffer per chunk
 * cost ~157 MB for a 1-byte trickle of the same line; a hostile unit can repeat either to load the shared host. Never retains a read buffer.
 */
/** More complete lines than this in ONE chunk is a flood (a legitimate shim sends one frame at a time). */
export const MAX_LINES_PER_PUSH = 256;
export class LineAssembler {
  private buf: Buffer | undefined;
  private len = 0;
  constructor(private readonly maxLine: number) {}

  /** What is held for the unfinished line (tests: the capacity must stay within about twice the pending bytes, whatever the chunking). */
  get retained(): { capacity: number; pending: number } {
    return { capacity: this.buf?.length ?? 0, pending: this.len };
  }

  private append(src: Buffer): void {
    const need = this.len + src.length;
    if (!this.buf || this.buf.length < need) {
      const next = Buffer.allocUnsafe(Math.min(this.maxLine, Math.max(need, (this.buf?.length ?? 0) * 2, 1024)));
      if (this.buf) this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    src.copy(this.buf, this.len);
    this.len = need;
  }

  /** `tooLarge`: a line passed `maxLine` bytes (without its newline) before ending; nothing after that point of this chunk is looked at. */
  push(chunk: Buffer): { lines: Buffer[]; tooLarge: boolean } {
    const lines: Buffer[] = [];
    let pos = 0;
    while (pos < chunk.length) {
      if (lines.length >= MAX_LINES_PER_PUSH) return { lines, tooLarge: true }; // a flood of empty lines in one chunk: refuse before it becomes thousands of buffers
      const nl = chunk.indexOf(10, pos);
      if (nl < 0) {
        if (this.len + (chunk.length - pos) > this.maxLine) return { lines, tooLarge: true };
        this.append(chunk.subarray(pos));
        break;
      }
      const tail = chunk.subarray(pos, nl);
      if (this.len + tail.length > this.maxLine) return { lines, tooLarge: true };
      if (this.len === 0) lines.push(tail);
      else {
        this.append(tail);
        const buf = this.buf as Buffer;
        lines.push(Buffer.from(buf.subarray(0, this.len))); // one copy out, so the buffer can be reused or released
        this.len = 0;
        if (buf.length > 64 * 1024) this.buf = undefined; // a big buffer is not kept for the next line
      }
      pos = nl + 1;
    }
    return { lines, tooLarge: false };
  }
}
