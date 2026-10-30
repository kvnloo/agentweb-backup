/**
 * ENG-2113 (review): the relay's line reader must be LINEAR in the bytes received however a hostile unit chunks them. The naive reader (concat the whole buffer and
 * re-scan it on every 'data' event) cost ~1.5 s of the shared host's event loop for one 1 MiB line fed in 64-byte chunks.
 */
import { LineAssembler } from "../../relay/bounds";

const B = (s: string) => Buffer.from(s, "utf8");
const feed = (a: LineAssembler, chunks: Buffer[]) => {
  const lines: string[] = [];
  let tooLarge = false;
  for (const c of chunks) {
    const r = a.push(c);
    lines.push(...r.lines.map((l) => l.toString("utf8")));
    if (r.tooLarge) {
      tooLarge = true;
      break;
    }
  }
  return { lines, tooLarge };
};

describe("LineAssembler: correctness", () => {
  const text = 'alpha\n\n{"b":[1,2]}\nz\nlast-no-newline-yet';
  const expected = ["alpha", "", '{"b":[1,2]}', "z"];

  it("MUTATION TARGET: the same lines come out for EVERY way of cutting the stream in two, and for every chunk size", () => {
    const bytes = B(text);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const r = feed(new LineAssembler(100), [bytes.subarray(0, cut), bytes.subarray(cut)]);
      expect({ cut, lines: r.lines, tooLarge: r.tooLarge }).toEqual({ cut, lines: expected, tooLarge: false });
    }
    for (let size = 1; size <= bytes.length; size++) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
      expect({ size, lines: feed(new LineAssembler(100), chunks).lines }).toEqual({ size, lines: expected });
    }
  });

  it("a chunk that ends exactly at a newline delivers the line at once; several lines in one chunk all come out; the remainder waits", () => {
    const a = new LineAssembler(100);
    expect(a.push(B("one\n")).lines.map(String)).toEqual(["one"]);
    expect(a.push(B("two\nthree\nfo")).lines.map(String)).toEqual(["two", "three"]);
    expect(a.push(B("ur\n")).lines.map(String)).toEqual(["four"]);
    expect(a.push(B("")).lines).toEqual([]);
  });

  it("MUTATION TARGET: a line exactly at the cap passes (in one chunk and across chunks); one byte over is refused, with or without its newline", () => {
    const at = "x".repeat(100);
    const over = "x".repeat(101);
    expect(feed(new LineAssembler(100), [B(at + "\n")])).toEqual({ lines: [at], tooLarge: false });
    expect(feed(new LineAssembler(100), [B(at.slice(0, 40)), B(at.slice(40, 99)), B(at.slice(99) + "\n")])).toEqual({ lines: [at], tooLarge: false });
    expect(feed(new LineAssembler(100), [B(over + "\n")]).tooLarge).toBe(true);
    expect(feed(new LineAssembler(100), [B(over)]).tooLarge).toBe(true);
    expect(feed(new LineAssembler(100), [B(at.slice(0, 60)), B(at.slice(60) + "y")]).tooLarge).toBe(true); // 101 bytes pending, no newline yet
    expect(feed(new LineAssembler(100), [B(at.slice(0, 60)), B(at.slice(60) + "y\n")]).tooLarge).toBe(true);
    expect(feed(new LineAssembler(100), [B(at)]).tooLarge).toBe(false); // 100 pending, still waiting
  });

  it("lines completed before the oversize line in the same chunk are still delivered; nothing after it is", () => {
    const r = new LineAssembler(10).push(B("ok\n" + "y".repeat(11) + "\nafter\n"));
    expect(r.tooLarge).toBe(true);
    expect(r.lines.map(String)).toEqual(["ok"]);
  });

  it("MUTATION TARGET: pending bytes are COPIED: overwriting the read buffer afterwards (the socket reuses them) cannot change a line", () => {
    const c = new LineAssembler(100);
    const src = Buffer.from("abc");
    c.push(src);
    src.fill(0x7a);
    expect(c.push(B("\n")).lines.map(String)).toEqual(["abc"]);
  });
});

describe("LineAssembler: cost", () => {
  it.each([7, 64, 100, 512])("MUTATION TARGET: one 1 MiB line with no newline fed in %i-byte chunks costs well under the 1.5 s the naive reader took", (size) => {
    const total = 1024 * 1024;
    const chunk = Buffer.alloc(size, 0x61);
    const a = new LineAssembler(total);
    const t0 = process.hrtime.bigint();
    let fed = 0;
    let r = { lines: [] as Buffer[], tooLarge: false };
    while (fed < total + size && !r.tooLarge) {
      r = a.push(chunk);
      fed += size;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(r.tooLarge).toBe(true); // the cap is enforced as soon as the running total passes it
    expect(ms).toBeLessThan(size <= 7 ? 600 : 150);
  });

  it("MUTATION TARGET: 1 MiB delivered as 64-byte chunks ending in a newline joins ONCE and costs under 150 ms", () => {
    const a = new LineAssembler(1024 * 1024);
    const chunk = Buffer.alloc(64, 0x62);
    const t0 = process.hrtime.bigint();
    let got: Buffer[] = [];
    for (let i = 0; i < 16383; i++) a.push(chunk);
    got = a.push(Buffer.concat([chunk.subarray(0, 63), B("\n")])).lines;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(got).toHaveLength(1);
    expect(got[0].length).toBe(64 * 16383 + 63);
    expect(ms).toBeLessThan(150);
  });
});
