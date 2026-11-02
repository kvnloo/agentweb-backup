/**
 * ENG-2113: splits a worker's NDJSON byte stream into lines in LINEAR time and BOUNDED memory.
 *
 *  - Each chunk is scanned once, for a newline, from its own start (the previous reader rescanned the whole buffer for every chunk: 2.2 s of CPU for an 8 MiB line
 *    in small chunks).
 *  - The unfinished line lives in ONE growing buffer (doubling, never above the cap): the chunk-list version kept one string per chunk, so 1-byte chunks held ~87 MB
 *    for an 8 MiB line.
 *  - A line is never decoded here: callers get Buffers (views of the chunk when the line sits in one chunk, a copy otherwise) so they can bound them before parsing.
 *  - `capFor(head)` may give a line its own, smaller cap once its first bytes are known (a hostile 8 MiB `entitlement` line is cut at its type's cap, not buffered).
 */
/**
 * Empty lines carry no data and cost a call per newline, so they are bounded by COUNT, not only by bytes: 64 MiB of "\n" through the generic path cost ~27 s of
 * event-loop time (a latin1 decode and a regex per empty line). The host never writes an empty line; a handful is tolerated, a flood fails the stream, and an empty
 * line never reaches `check`/`capFor`.
 */
export const MAX_EMPTY_LINES = 256;
const HEAD_BYTES = 48;
const MIN_BUFFER = 16 * 1024;

export class LineSplitter {
  private buf: Buffer = Buffer.alloc(0);
  private len = 0;
  private cap: number | undefined;
  /** The current line passed its cap and is being thrown away up to its newline. */
  private discarding = false;
  private discardLen = 0;
  private emptyLines = 0;

  /** `maxLine`: the longest line in BYTES; `onTooLong` is called (and its result thrown) when a line passes its cap. */
  constructor(
    private readonly maxLine: number,
    private readonly onTooLong: () => Error,
    private readonly capFor?: (head: Buffer) => number,
    /** True for a line that may be DISCARDED instead of failing the stream when it passes its cap (an event type nobody here knows). Its bytes are still counted by the caller. */
    private readonly skipFor?: (head: Buffer) => boolean,
    /** Called (and its result thrown) when a stream has carried more than MAX_EMPTY_LINES empty lines. Default: `onTooLong`. */
    private readonly onTooManyEmpty?: () => Error,
  ) {}

  /** The complete (non-empty) lines this chunk finishes, in order. */
  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf(10, from);
      if (nl < 0) break;
      const seg = chunk.subarray(from, nl);
      from = nl + 1;
      if (this.discarding) {
        this.discardLen += seg.length;
        if (this.discardLen > this.maxLine) throw this.onTooLong();
        this.discarding = false; // the newline ends the thrown-away line
        this.cap = undefined;
        continue;
      }
      if (this.len === 0) {
        if (seg.length === 0) {
          // an empty line: counted, and never looked at (no cap, no head decode)
          if (++this.emptyLines > MAX_EMPTY_LINES) throw (this.onTooManyEmpty ?? this.onTooLong)();
          continue;
        }
        const keep = this.check(seg.length, seg);
        this.discarding = false; // the line is complete either way
        this.cap = undefined; // this line is finished: the next one gets its own cap
        if (keep && seg.length) lines.push(seg);
      } else {
        this.append(seg);
        const line = Buffer.from(this.buf.subarray(0, this.len)); // a copy: the buffer is reused
        const keep = this.check(this.len, line);
        this.discarding = false;
        this.len = 0;
        this.cap = undefined;
        if (keep && line.length) lines.push(line);
      }
    }
    if (from < chunk.length) {
      if (this.discarding) {
        this.discardLen += chunk.length - from;
        if (this.discardLen > this.maxLine) throw this.onTooLong();
      } else {
        this.append(from === 0 ? chunk : chunk.subarray(from));
        this.check(this.len, this.buf);
      }
    }
    return lines;
  }

  /** False when the line must not be emitted (it was too long and is being discarded). Throws when it is too long and may not be discarded. */
  private check(length: number, head: Buffer): boolean {
    if (this.cap === undefined && (length >= HEAD_BYTES || head !== this.buf)) {
      this.cap = Math.min(this.maxLine, this.capFor ? this.capFor(head.subarray(0, HEAD_BYTES)) : this.maxLine);
    }
    if (length > (this.cap ?? this.maxLine)) {
      if (this.skipFor && this.skipFor(head.subarray(0, HEAD_BYTES)) && length <= this.maxLine) {
        this.discarding = true; // an unknown event type: thrown away, the rest of the line is not buffered
        this.discardLen = length;
        this.len = 0;
        return false;
      }
      throw this.onTooLong();
    }
    return true;
  }

  private append(piece: Buffer): void {
    const need = this.len + piece.length;
    if (need > this.buf.length) {
      let size = Math.max(this.buf.length, MIN_BUFFER);
      while (size < need) size *= 2;
      const next = Buffer.allocUnsafe(Math.min(size, Math.max(this.maxLine + piece.length, MIN_BUFFER)));
      this.buf.copy(next, 0, 0, this.len);
      this.buf = next;
    }
    piece.copy(this.buf, this.len);
    this.len += piece.length;
  }
}
