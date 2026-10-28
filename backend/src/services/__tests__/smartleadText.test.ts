import { containsSpintax } from "../smartleadText";

describe("containsSpintax (ENG-673)", () => {
  it("is true for a single-brace group with a pipe, and false for tags, plain braces and CSS", () => {
    expect(containsSpintax("{a|b}")).toBe(true);
    expect(containsSpintax("Hi {there|friend}, {{first_name}}")).toBe(true);
    for (const t of ["{{first_name}}", "x {a} {b|", "{a|{b}}", "css {color:red} | x", "a | b", "", "}{|"]) expect(containsSpintax(t)).toBe(false);
  });

  it("is linear: a brace followed by a million pipes takes milliseconds (the regex form took 3.5 s at 100,000)", () => {
    const started = Date.now();
    expect(containsSpintax("{" + "|".repeat(1_000_000))).toBe(false);
    expect(containsSpintax("{".repeat(500_000) + "}".repeat(500_000))).toBe(false);
    expect(containsSpintax("{".repeat(500_000) + "|" + "}")).toBe(true); // the innermost `{|}` is a real group
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
