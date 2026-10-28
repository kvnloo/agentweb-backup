import { CANONICAL_MAX_DEPTH, canonicalJson } from "../../relay/canonical";

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
