/**
 * ENG-2113: the non-recursive bounds helpers. Everything here runs on data a customer's unit or CLI controls, so none of it may recurse or throw.
 */
import { MAX_FRAME_DEPTH, approxJsonBytes, rawJsonDepthExceeds, valueDepthExceeds } from "../../relay/bounds";

const buf = (s: string) => Buffer.from(s, "utf8");
const nested = (k: number, open = "[", close = "]") => open.repeat(k) + close.repeat(k);

describe("rawJsonDepthExceeds", () => {
  it("MUTATION TARGET: the boundary is exact (frame depth 1 + args depth 1 + 31 nested = 33 allowed, one more refused)", () => {
    const frame = (k: number) => buf(`{"type":"call","callId":"c","name":"t","args":{"a":${nested(k)}}}`);
    expect(MAX_FRAME_DEPTH).toBe(33);
    expect(rawJsonDepthExceeds(frame(31), MAX_FRAME_DEPTH)).toBe(false); // frame 1 + args 1 + 31 = 33: args nests 32 levels
    expect(rawJsonDepthExceeds(frame(32), MAX_FRAME_DEPTH)).toBe(true);
  });

  it("counts objects and arrays alike, and closes them again (siblings do not add up)", () => {
    expect(rawJsonDepthExceeds(buf(`[${"[],".repeat(1000)}[]]`), 2)).toBe(false);
    expect(rawJsonDepthExceeds(buf(`{"a":[{"b":[{}]}]}`), 5)).toBe(false);
    expect(rawJsonDepthExceeds(buf(`{"a":[{"b":[{}]}]}`), 4)).toBe(true);
  });

  it("MUTATION TARGET: brackets inside strings (with escaped quotes and backslashes) are not nesting", () => {
    expect(rawJsonDepthExceeds(buf(`{"a":"${"[".repeat(1000)}","b":"x\\"${"{".repeat(1000)}","c":"\\\\"}`), 2)).toBe(false);
    expect(rawJsonDepthExceeds(buf(`{"a":"\\\\","b":${nested(3)}}`), 3)).toBe(true); // an escaped backslash ends the escape: the string closed, the arrays count
  });

  it("is a single pass over a frame as deep as a 1 MiB line can be (no recursion, no allocation)", () => {
    const t0 = Date.now();
    expect(rawJsonDepthExceeds(buf(nested(500_000)), MAX_FRAME_DEPTH)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("malformed or empty input never throws", () => {
    for (const s of ["", "}}}}", "]]", '"unterminated', "{\"a\":", "\\", "\u0000"]) expect(() => rawJsonDepthExceeds(buf(s), 5)).not.toThrow();
    expect(rawJsonDepthExceeds(buf("}}}}"), 1)).toBe(false);
  });
});

describe("valueDepthExceeds", () => {
  const deep = (k: number): unknown => {
    let v: unknown = "leaf";
    for (let i = 0; i < k; i++) v = [v];
    return v;
  };
  it("MUTATION TARGET: exact boundary, iterative on a value nested far past the stack", () => {
    expect(valueDepthExceeds(deep(34), 34)).toBe(false);
    expect(valueDepthExceeds(deep(35), 34)).toBe(true);
    expect(valueDepthExceeds(deep(1_000_000), 34)).toBe(true); // JSON.stringify of this throws; this must not
    expect(() => JSON.stringify(deep(1_000_000))).toThrow(RangeError);
    expect(valueDepthExceeds("x", 1)).toBe(false);
    expect(valueDepthExceeds(null, 1)).toBe(false);
    expect(valueDepthExceeds({ a: { b: 1 }, c: [1, { d: 2 }] }, 3)).toBe(false);
  });
  it("a cycle ends at the cap instead of looping", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(valueDepthExceeds(a, 34)).toBe(true);
  });
});

describe("approxJsonBytes", () => {
  it("MUTATION TARGET: small integers count about what they cost in JSON (130,000 of them are ~260 KB, nowhere near a 1 MiB cap), other numbers more, booleans and null a few bytes", () => {
    const ints = { ids: new Array(130_000).fill(7) };
    const real = Buffer.byteLength(JSON.stringify(ints));
    expect(real).toBeLessThan(300_000);
    const est = approxJsonBytes(ints, 1 << 20);
    expect(est).toBeLessThan(1024 * 1024);
    expect(est).toBeGreaterThan(real * 0.9);
    expect(approxJsonBytes(new Array(1000).fill(1234567.891), 1 << 30)).toBeGreaterThanOrEqual(1000 * 18);
    expect(approxJsonBytes([true, false, null], 1 << 20)).toBeGreaterThanOrEqual(15);
  });
  it("MUTATION TARGET: a value that is really over the cap still reaches it (strings, wide arrays of larger numbers)", () => {
    expect(approxJsonBytes({ s: "x".repeat(2 * 1024 * 1024) }, 1024 * 1024 + 1)).toBe(1024 * 1024 + 1);
    expect(approxJsonBytes({ n: new Array(200_000).fill(123456) }, 1024 * 1024 + 1)).toBe(1024 * 1024 + 1);
    expect(approxJsonBytes(new Array(6_000_000).fill(1), 1024 * 1024 + 1)).toBe(1024 * 1024 + 1); // stops at the step cap, fast
  });
  it("MUTATION TARGET: never throws on a value JSON.stringify cannot serialize, and stops at the limit", () => {
    let v: unknown = "leaf";
    for (let i = 0; i < 1_000_000; i++) v = [v];
    expect(() => JSON.stringify(v)).toThrow(RangeError);
    expect(() => approxJsonBytes(v, 1 << 20)).not.toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(approxJsonBytes(cyc, 1000)).toBe(1000);
    expect(approxJsonBytes({ s: "x".repeat(10_000) }, 100)).toBe(100);
  });
  it("is in the right order of magnitude for ordinary data", () => {
    const v = { name: "search", args: { q: "hello world", n: [1, 2, 3] } };
    const real = Buffer.byteLength(JSON.stringify(v));
    const est = approxJsonBytes(v, 1 << 20);
    expect(est).toBeGreaterThan(real / 3);
    expect(est).toBeLessThan(real * 3);
  });
});
