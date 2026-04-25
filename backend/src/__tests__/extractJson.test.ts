/**
 * Tests for `extractJson` — the defensive JSON-from-LLM-text helper.
 *
 * Context: ICP service was throwing on `JSON.parse` when the LLM returned
 * conversational prose ("It looks like..."). This helper centralises the
 * robust extraction so every onboarding service gets the same defence.
 */

import {
  extractJson,
  JsonExtractError,
} from "../services/util/extractJson";

describe("extractJson", () => {
  it("parses a raw JSON object", () => {
    const out = extractJson<{ a: number }>('{"a":1}');
    expect(out).toEqual({ a: 1 });
  });

  it("parses a raw JSON array", () => {
    const out = extractJson<number[]>("[1,2,3]");
    expect(out).toEqual([1, 2, 3]);
  });

  it("strips ```json fences", () => {
    const raw = "```json\n" + '{"a":1,"b":"two"}' + "\n```";
    const out = extractJson<{ a: number; b: string }>(raw);
    expect(out).toEqual({ a: 1, b: "two" });
  });

  it("strips bare ``` fences", () => {
    const raw = "```\n" + '{"x":42}' + "\n```";
    const out = extractJson<{ x: number }>(raw);
    expect(out).toEqual({ x: 42 });
  });

  it("extracts the first balanced {...} block from prose", () => {
    const raw =
      'It looks like you want personas. Here is the JSON: {"icps":[{"name":"P1"}]} hope this helps!';
    const out = extractJson<{ icps: Array<{ name: string }> }>(raw);
    expect(out).toEqual({ icps: [{ name: "P1" }] });
  });

  it("extracts a balanced [...] array from prose", () => {
    const raw = "Sure! Here you go: [1, 2, 3] — let me know if you need more.";
    const out = extractJson<number[]>(raw);
    expect(out).toEqual([1, 2, 3]);
  });

  it("handles nested braces correctly when extracting from prose", () => {
    const raw =
      "Note: " +
      '{"outer": {"inner": {"deep": "value"}}, "x": [1, {"y": 2}]}' +
      " (with extra text after).";
    const out = extractJson<any>(raw);
    expect(out).toEqual({
      outer: { inner: { deep: "value" } },
      x: [1, { y: 2 }],
    });
  });

  it("ignores braces inside string literals", () => {
    const raw = 'Heads up: {"msg": "this } is not real"} done.';
    const out = extractJson<{ msg: string }>(raw);
    expect(out).toEqual({ msg: "this } is not real" });
  });

  it("throws JsonExtractError on completely malformed input", () => {
    const raw = "It looks like I cannot generate valid output right now.";
    expect(() => extractJson(raw)).toThrow(JsonExtractError);
  });

  it("throws JsonExtractError on empty input", () => {
    expect(() => extractJson("")).toThrow(JsonExtractError);
  });

  it("preserves a truncated raw snippet on the thrown error", () => {
    const raw = "x".repeat(2000);
    try {
      extractJson(raw);
      fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonExtractError);
      const e = err as JsonExtractError;
      expect(e.rawSnippet.length).toBeLessThanOrEqual(500);
      expect(e.rawSnippet).toMatch(/^x+/);
    }
  });

  it("handles fenced JSON wrapped in prose", () => {
    const raw =
      "Sure, here is the answer:\n```json\n" +
      '{"a": [1,2,3]}' +
      "\n```\nLet me know!";
    const out = extractJson<{ a: number[] }>(raw);
    expect(out).toEqual({ a: [1, 2, 3] });
  });

  it("throws on input where the first { is unbalanced", () => {
    // Open brace with no matching close — should fail extraction
    const raw = 'Sure: {"oops": "no closing brace';
    expect(() => extractJson(raw)).toThrow(JsonExtractError);
  });
});
