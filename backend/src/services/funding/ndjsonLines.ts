/**
 * ENG-2113: splits a worker's NDJSON stream into lines in LINEAR time. The previous reader did `buf += chunk` and then `indexOf("\n")` from the start of the
 * buffer on every chunk, so an 8 MiB line arriving in small chunks was rescanned once per chunk (2.2 s of CPU per turn for a hostile worker). This one scans
 * each chunk once, keeps the unfinished tail as a list of pieces (joined once, when the line ends) and bounds the unfinished line's length.
 */
export class LineSplitter {
  private pieces: string[] = [];
  private pending = 0;

  /** `maxLine`: the longest unfinished line (in characters) tolerated; `onTooLong` is called (and its result thrown) when it is exceeded. */
  constructor(
    private readonly maxLine: number,
    private readonly onTooLong: () => Error,
  ) {}

  /** The complete (non-empty) lines this chunk finishes, in order. */
  push(chunk: string): string[] {
    const lines: string[] = [];
    let from = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", from);
      if (nl < 0) break;
      const piece = chunk.slice(from, nl);
      from = nl + 1;
      let line = piece;
      if (this.pieces.length > 0) {
        this.pieces.push(piece);
        line = this.pieces.join("");
        this.pieces = [];
        this.pending = 0;
      }
      if (line) lines.push(line);
    }
    if (from < chunk.length) {
      const rest = from === 0 ? chunk : chunk.slice(from);
      this.pieces.push(rest);
      this.pending += rest.length;
      if (this.pending > this.maxLine) throw this.onTooLong();
    }
    return lines;
  }
}
