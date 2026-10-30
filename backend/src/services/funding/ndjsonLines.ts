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
const HEAD_BYTES = 48;
const MIN_BUFFER = 16 * 1024;

export class LineSplitter {
  private buf: Buffer = Buffer.alloc(0);
  private len = 0;
  private cap: number | undefined;

  /** `maxLine`: the longest line in BYTES; `onTooLong` is called (and its result thrown) when a line passes its cap. */
  constructor(
    private readonly maxLine: number,
    private readonly onTooLong: () => Error,
    private readonly capFor?: (head: Buffer) => number,
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
      if (this.len === 0) {
        this.check(seg.length, seg);
        this.cap = undefined; // this line is finished: the next one gets its own cap
        if (seg.length) lines.push(seg);
      } else {
        this.append(seg);
        const line = Buffer.from(this.buf.subarray(0, this.len)); // a copy: the buffer is reused
        this.check(this.len, line);
        this.len = 0;
        this.cap = undefined;
        if (line.length) lines.push(line);
      }
    }
    if (from < chunk.length) {
      this.append(from === 0 ? chunk : chunk.subarray(from));
      this.check(this.len, this.buf);
    }
    return lines;
  }

  private check(length: number, head: Buffer): void {
    if (this.cap === undefined && (length >= HEAD_BYTES || head !== this.buf)) {
      this.cap = Math.min(this.maxLine, this.capFor ? this.capFor(head.subarray(0, HEAD_BYTES)) : this.maxLine);
    }
    if (length > (this.cap ?? this.maxLine)) throw this.onTooLong();
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
