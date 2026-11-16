/**
 * ENG-2113: a rate-limit event is the CLI's own data, so a hostile CLI controls its size. Measured before the fix (one 16.8 MB line): 434 ms to parse, 790 ms to
 * normalize, a ~21 MB event forwarded to the backend with a fixed weight of 256 bytes, and RSS growing to 2.4 GB behind a stalled consumer.
 */
import { approxSize } from "../adapters/claudeAdapter";
import { MAX_BLOCKS_NORMALIZED, MAX_RATE_WINDOWS, normalizeClaudeEvent } from "../adapters/claudeParse";
import type { ProviderEvent } from "../adapter";

type Ent = Extract<ProviderEvent, { type: "entitlement" }>;
const ent = (info: Record<string, unknown>): Ent => normalizeClaudeEvent({ type: "rate_limit_event", rate_limit_info: info })[0] as Ent;

describe("rate_limit_event is bounded", () => {
  it("MUTATION TARGET: at most MAX_RATE_WINDOWS windows are kept", () => {
    const unified: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) unified["w" + i] = { utilization: 0.1 };
    const e = ent({ unifiedWindows: unified });
    expect(e.observation.windows).toHaveLength(MAX_RATE_WINDOWS);
    expect(MAX_RATE_WINDOWS).toBe(16);
    expect(e.observation.windows[0].name).toBe("w0");
  });

  it("MUTATION TARGET: status words are short tokens: anything else is dropped, not forwarded", () => {
    expect(ent({ status: "allowed_warning", overageStatus: "rejected", isUsingOverage: true }).observation).toEqual({ windows: [], status: "allowed_warning", overage: { using: true, status: "rejected" } });
    const long = "x".repeat(5000);
    expect(ent({ status: long, overageStatus: long, isUsingOverage: false }).observation).toEqual({ windows: [], overage: { using: false } });
    expect(ent({ status: "has space and \u0000 junk" }).observation).toEqual({ windows: [] });
    expect(ent({ status: 7 }).observation).toEqual({ windows: [] });
  });

  it("MUTATION TARGET: a hostile line with 300,000 windows (~17 MB) is normalized in ~100 ms (was ~790 ms), and what is forwarded is tiny", () => {
    const unified: Record<string, unknown> = {};
    for (let i = 0; i < 300_000; i++) unified["window_number_" + i] = { utilization: 0.5, resetsAt: 1789728000, junk: "y".repeat(10) };
    const raw = { type: "rate_limit_event", rate_limit_info: { status: "x".repeat(4000), unifiedWindows: unified } };
    const t0 = process.hrtime.bigint();
    const [ev] = normalizeClaudeEvent(raw);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log("rate_limit normalize ms", ms.toFixed(1), "approxSize", approxSize(ev));
    expect(ms).toBeLessThan(4000); // ~100 ms idle (300+ ms on a loaded box): V8 collects the keys of a dictionary-mode object before for-in starts, so the cost is linear in the line, which the line cap bounds. A catastrophe bound only: the size below is the real pin
    expect(approxSize(ev)).toBeLessThan(8192); // (16 windows, each also charged the per-object memory cost)
  });

  it("unknown fields are never forwarded", () => {
    const e = ent({ status: "allowed", secret: "s", unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1789728000, token: "t" } } });
    expect(JSON.stringify(e)).not.toMatch(/secret|token/);
  });
});

describe("content blocks of one message are bounded", () => {
  it("MUTATION TARGET: only the first MAX_BLOCKS_NORMALIZED blocks of an assistant message are looked at", () => {
    const content = Array.from({ length: 1000 }, (_, i) => ({ type: "text", text: "t" + i }));
    const evs = normalizeClaudeEvent({ type: "assistant", message: { content } });
    expect(evs).toHaveLength(MAX_BLOCKS_NORMALIZED);
    expect(MAX_BLOCKS_NORMALIZED).toBe(32);
  });

  it("MUTATION TARGET: the same for tool_result blocks of a user message", () => {
    const content = Array.from({ length: 1000 }, (_, i) => ({ type: "tool_result", tool_use_id: "id" + i }));
    expect(normalizeClaudeEvent({ type: "user", message: { content } })).toHaveLength(MAX_BLOCKS_NORMALIZED);
  });
});

describe("approxSize counts the REAL payload of every event type", () => {
  it("MUTATION TARGET: a result carries its whole text", () => {
    expect(approxSize({ type: "result", ok: true, text: "r".repeat(1_000_000) })).toBeGreaterThanOrEqual(1_000_000);
  });
  it("MUTATION TARGET: an entitlement counts its windows and words", () => {
    const small = approxSize({ type: "entitlement", observation: { windows: [] } });
    const big = approxSize({ type: "entitlement", observation: { windows: Array.from({ length: 16 }, (_, i) => ({ name: "window_" + i, utilization: 0.5, resetsAtMs: 1789728000000 })), status: "allowed_warning" } });
    expect(big).toBeGreaterThan(small + 400);
  });
  it("MUTATION TARGET: tool-result, alarm and usage are measured, not fixed", () => {
    expect(approxSize({ type: "tool-result", operationId: "o".repeat(256), ok: true })).toBeGreaterThanOrEqual(256 + 128);
    expect(approxSize({ type: "alarm", hazard: { kind: "other", detail: "d".repeat(500) } })).toBeGreaterThanOrEqual(500 + 128);
    expect(approxSize({ type: "usage", inputTokens: 1 })).toBeLessThan(512);
  });
  it("MUTATION TARGET: an event of 70,000 empty objects weighs what it occupies, not its JSON text (0.7 MB of JSON, ~27 MB of heap): over the 8 MB queue cap, so a stalled consumer is cut", () => {
    const input = { a: Array.from({ length: 70_000 }, () => ({})) };
    expect(JSON.stringify(input).length).toBeLessThan(1_000_000);
    expect(approxSize({ type: "tool-use", operationId: "o", name: "n", input })).toBeGreaterThan(8 * 1024 * 1024);
    // ordinary events are not inflated: a small tool input stays small
    expect(approxSize({ type: "tool-use", operationId: "o", name: "n", input: { q: "x", opts: { a: 1 } } })).toBeLessThan(1000);
  });
  it("MUTATION TARGET: every other event type counts its containers too (an alarm event is two objects: at least 128 + 2 x the 128-byte node cost)", () => {
    expect(approxSize({ type: "alarm", hazard: { kind: "other", detail: "d" } })).toBeGreaterThanOrEqual(128 + 2 * 128);
  });
  it("text is its length", () => {
    expect(approxSize({ type: "text", delta: "abc" })).toBe(67);
  });
});
