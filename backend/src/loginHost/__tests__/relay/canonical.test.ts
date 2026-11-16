import { CANONICAL_MAX_DEPTH, canonicalJson } from "../../relay/canonical";

import { canonicalDigest } from "../../relay/canonical";

describe("canonicalDigest", () => {
  it("MUTATION TARGET: key order does not matter, but a difference at ANY depth does (canonicalJson collapses below 32 levels; the digest does not)", () => {
    const at = (depth: number, leaf: string) => {
      let v: unknown = leaf;
      for (let i = 0; i < depth; i++) v = { k: v, z: i };
      return v;
    };
    expect(canonicalDigest({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalDigest({ a: { c: undefined, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson(at(40, "one"))).toBe(canonicalJson(at(40, "two"))); // the capped form cannot tell these apart
    expect(canonicalDigest(at(40, "one"))).not.toBe(canonicalDigest(at(40, "two")));
    expect(canonicalDigest([1, 2])).not.toBe(canonicalDigest([2, 1]));
    expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: "1" }));
    expect(canonicalDigest([])).not.toBe(canonicalDigest({}));
  });
  it("MUTATION TARGET: a value nested far past the call stack hashes without recursion, and differs from its neighbour", () => {
    const deep = (leaf: string) => {
      let v: unknown = leaf;
      for (let i = 0; i < 300_000; i++) v = [v];
      return v;
    };
    const t0 = Date.now();
    expect(canonicalDigest(deep("a"))).not.toBe(canonicalDigest(deep("b")));
    expect(Date.now() - t0).toBeLessThan(10_000); // catastrophe bound only (the gate fails closed: a slow runner must not block a deploy); the structural assertions are the pins (a recursive hash would overflow the stack, not run slowly)
  });
});

describe("canonicalJson", () => {
  it("is key-order independent and treats undefined members like JSON does", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(canonicalJson({ a: { c: undefined, d: [1, { y: 2, z: 1 }] }, b: 1 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson(undefined)).toBe("null");
  });
  it("MUTATION TARGET: nesting deeper than the cap collapses to a marker (bounded work on hostile input)", () => {
    let v: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) v = [v];
    const out = canonicalJson(v);
    expect(out).toContain("[too deep]");
    expect(out.length).toBeLessThan(CANONICAL_MAX_DEPTH * 3 + 100);
  });
});
