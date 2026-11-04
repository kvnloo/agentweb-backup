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
    expect(Date.now() - t0).toBeLessThan(2500);
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
  it.each([[7, 1], [42, 2], [123, 3], [4567, 4], [45678, 5], [456789, 6], [-5, 1], [12345678, 8]])("MUTATION TARGET: the number %p (%p digits) is counted by what it costs in JSON (never far under, at most about 3x over), so 55,000 two-digit numbers (~165 KB) are nowhere near 1 MiB", (n) => {
    const arr = new Array(55_000).fill(n);
    const real = Buffer.byteLength(JSON.stringify(arr));
    const est = approxJsonBytes(arr, 100 * 1024 * 1024);
    expect(est).toBeGreaterThanOrEqual(real * 0.95);
    expect(est).toBeLessThanOrEqual(real * 3);
  });
  it("MUTATION TARGET: 55,000 two-digit numbers are not over a 1 MiB cap", () => {
    expect(approxJsonBytes(new Array(55_000).fill(42), 1024 * 1024 + 1)).toBeLessThan(1024 * 1024);
  });

  it("MUTATION TARGET: strings count their quotes and comma, and their UTF-8 length when they are not ASCII (cheaply: only a string with a character above 0x7f is measured)", () => {
    const ascii = new Array(100_000).fill("abc");
    expect(approxJsonBytes(ascii, 1 << 30)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(ascii)) * 0.95);
    const accents = new Array(100_000).fill("\u00e9\u00e9\u00e9"); // 3 chars, 6 bytes
    expect(approxJsonBytes(accents, 1 << 30)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(accents)) * 0.95);
    const cjk = new Array(50_000).fill("\u4e2d\u6587\u5b57"); // 3 chars, 9 bytes
    expect(approxJsonBytes(cjk, 1 << 30)).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(cjk)) * 0.95);
    expect(approxJsonBytes("x".repeat(5000), 100)).toBe(100); // longer than the cap in characters alone: no scan needed
  });

  it("MUTATION TARGET: an array that has already passed the cap is not walked further (early exit)", () => {
    let reads = 0;
    const big = new Proxy(new Array(5_000_000).fill("x".repeat(1000)), {
      get(t, k, r) {
        if (typeof k === "string" && /^\d+$/.test(k)) reads++;
        return Reflect.get(t, k, r);
      },
    });
    expect(approxJsonBytes(big, 10_000)).toBe(10_000);
    expect(reads).toBeLessThan(100);
  });

  it("MUTATION TARGET: the step cap: a 6,000,000-element array returns the limit at once instead of being walked to its (smaller) true size", () => {
    let reads = 0;
    const arr = new Proxy(new Array(6_000_000).fill(1), {
      get(t, k, r) {
        if (typeof k === "string" && /^\d+$/.test(k)) reads++;
        return Reflect.get(t, k, r);
      },
    });
    expect(approxJsonBytes(arr, 100 * 1024 * 1024)).toBe(100 * 1024 * 1024); // really ~12 MB: only the step cap makes this the limit
    // counted, not timed (a wall-clock bound flaked under load): the walk stops at the 1,000,000-step cap, not at the 6,000,000th element
    expect(reads).toBeLessThanOrEqual(1_000_001);
    expect(reads).toBeGreaterThan(900_000);
  });

  it("MUTATION TARGET: nodeBytes charges every object and array on top of the JSON size (for memory accounting), and 0 is the plain JSON estimate", () => {
    const v = { a: [{}, {}, {}] }; // 5 containers
    expect(approxJsonBytes(v, 1e9, 100)).toBe(approxJsonBytes(v, 1e9) + 500);
    expect(approxJsonBytes(v, 1e9, 0)).toBe(approxJsonBytes(v, 1e9));
    expect(approxJsonBytes("a string has no container", 1e9, 100)).toBe(approxJsonBytes("a string has no container", 1e9));
  });

  it("MUTATION TARGET: only OWN properties count (an inherited enumerable one is not part of the JSON), and a key counts its length", () => {
    const o = Object.create({ inherited: "x".repeat(5000) }) as Record<string, unknown>;
    o.own = 1;
    expect(approxJsonBytes(o, 1 << 20)).toBeLessThan(100);
    expect(approxJsonBytes({ ["k".repeat(1000)]: 1 }, 1 << 20)).toBeGreaterThanOrEqual(1000);
  });

  it("is in the right order of magnitude for ordinary data", () => {
    const v = { name: "search", args: { q: "hello world", n: [1, 2, 3] } };
    const real = Buffer.byteLength(JSON.stringify(v));
    const est = approxJsonBytes(v, 1 << 20);
    expect(est).toBeGreaterThan(real / 3);
    expect(est).toBeLessThan(real * 3);
  });
});
