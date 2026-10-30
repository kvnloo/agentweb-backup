/**
 * ENG-2113: the CLI's stdout is customer-controlled. A line of megabytes of nested brackets costs seconds of event-loop time in JSON.parse (here and, worse,
 * in the backend that receives what the host forwards), so the host cuts such a line BEFORE anything parses it and forwards a fixed placeholder instead.
 * Everything below is time-bounded: handling must stay well under 100 ms however deep the line is.
 */
import { PassThrough } from "stream";
import type { ChildLike } from "../adapter";
import { RunnerChildAdapter } from "../adapters/claudeAdapter";
import { classifyFailureText, MAX_CLASSIFY_CHARS, normalizeClaudeEvent } from "../adapters/claudeParse";
import { MAX_CLI_LINE_DEPTH } from "../relay/bounds";

function rig(maxLine = 16 * 1024 * 1024) {
  const stdout = new PassThrough();
  const child: ChildLike = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => undefined, onExit: () => undefined };
  const deep: number[] = [];
  const adapter = new RunnerChildAdapter(child, maxLine, () => deep.push(1));
  const errors: Error[] = [];
  adapter.on("error", (e: Error) => errors.push(e));
  let out = "";
  adapter.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
  const feed = async (...chunks: Array<string | Buffer>) => {
    for (const c of chunks) stdout.write(c);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { feed, out: () => out, deep, errors };
}
const nested = (k: number) => "[".repeat(k) + "]".repeat(k);
const PLACEHOLDER = '{"type":"aw_line_dropped"}';

describe("CLI stdout: lines nested deeper than the cap are dropped before anything parses them", () => {
  it("ordinary lines pass through byte for byte, whatever the chunk boundaries (strings, escapes, brackets inside strings)", async () => {
    const r = rig();
    const lines = ['{"type":"assistant","message":{"content":[{"type":"text","text":"a [[[[ \\" {{{{ \\\\"}]}}', '{"a":{"b":{"c":[1,2,{"d":null}]}}}', "plain noise", ""];
    const text = lines.join("\n") + "\n";
    for (let size = 1; size <= 9; size += 4) {
      const r2 = rig();
      const bytes = Buffer.from(text);
      await r2.feed(...Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
      expect(r2.out()).toBe(text);
      expect(r2.deep).toHaveLength(0);
    }
    await r.feed(text);
    expect(r.out()).toBe(text);
  });

  it("MUTATION TARGET: the boundary is exact: depth 64 passes, depth 65 is cut", async () => {
    expect(MAX_CLI_LINE_DEPTH).toBe(64);
    const ok = rig();
    await ok.feed(nested(64) + "\n");
    expect(ok.out()).toBe(nested(64) + "\n");
    expect(ok.deep).toHaveLength(0);
    const bad = rig();
    await bad.feed(nested(65) + "\nnext line\n");
    expect(bad.deep).toHaveLength(1);
    expect(bad.out()).not.toContain("]]]]");
    expect(bad.out()).toBe("[".repeat(64) + `\n${PLACEHOLDER}\nnext line\n`);
  });

  it.each([5_000, 100_000, 1_000_000])("MUTATION TARGET: a line nested %i deep is cut in under 100 ms; what is forwarded is tiny; the lines around it are intact", async (k) => {
    const r = rig();
    const line = nested(k);
    const t0 = Date.now();
    await r.feed('{"type":"before"}\n', line + "\n", '{"type":"after"}\n');
    expect(Date.now() - t0).toBeLessThan(100);
    expect(r.deep).toHaveLength(1);
    expect(r.out().length).toBeLessThan(400);
    expect(r.out().endsWith(`\n${PLACEHOLDER}\n{"type":"after"}\n`)).toBe(true);
    expect(r.out().startsWith('{"type":"before"}\n')).toBe(true);
  });

  it("MUTATION TARGET: a deep line split over many chunks (and a string spanning a chunk edge) is cut once, and the dropped remainder is discarded up to ITS newline only", async () => {
    const r = rig();
    const deepLine = nested(200_000);
    const chunks: string[] = [];
    for (let i = 0; i < deepLine.length; i += 7_000) chunks.push(deepLine.slice(i, i + 7_000));
    const t0 = Date.now();
    await r.feed('{"s":"x\\', '"y"}\n', ...chunks, "\n", '{"ok":1}\n');
    expect(Date.now() - t0).toBeLessThan(100);
    expect(r.deep).toHaveLength(1);
    expect(r.out()).toBe(`{"s":"x\\"y"}\n${"[".repeat(64)}\n${PLACEHOLDER}\n{"ok":1}\n`);
  });

  it("two deep lines in a row are each dropped (the state resets at the newline)", async () => {
    const r = rig();
    await r.feed(nested(100) + "\n" + nested(100) + "\nfine\n");
    expect(r.deep).toHaveLength(2);
    expect(r.out().split("\n").filter((l) => l === PLACEHOLDER)).toHaveLength(2);
    expect(r.out().endsWith("fine\n")).toBe(true);
  });

  it("brackets inside a string never count as nesting, however many", async () => {
    const r = rig();
    const line = `{"t":"${"[".repeat(100_000)}"}\n`;
    await r.feed(line);
    expect(r.out()).toBe(line);
    expect(r.deep).toHaveLength(0);
  });

  it("the byte cap on a line still applies (a line that never ends is cut off as before)", async () => {
    const r = rig(1000);
    // the adapter kills the child and emits an error; the stream stops forwarding
    await r.feed("x".repeat(600), "y".repeat(600));
    expect(r.errors.map((e) => e.message)).toEqual(["stdout_line_too_long"]);
    expect(r.out()).toBe("x".repeat(600));
  });
});

describe("normalized stream events: informational values are bounded before they are forwarded", () => {
  const deepValue = (k: number): unknown => {
    let v: unknown = "leaf";
    for (let i = 0; i < k; i++) v = [v];
    return v;
  };
  const toolUse = (input: unknown, id = "tu1", name = "mcp__emma__search") => ({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id, name, input }] } });

  it.each([5_000, 100_000, 1_000_000])("MUTATION TARGET: a tool_use input nested %i deep becomes a fixed marker, fast, and the event can be serialized", (k) => {
    const raw = toolUse(deepValue(k));
    const t0 = Date.now();
    const evs = normalizeClaudeEvent(raw);
    expect(Date.now() - t0).toBeLessThan(100);
    expect(evs).toEqual([{ type: "tool-use", operationId: "tu1", name: "mcp__emma__search", input: { _truncated: "depth" } }]);
    expect(() => JSON.stringify(evs)).not.toThrow();
  });

  it("MUTATION TARGET: the depth cap is exact (32 levels pass, 33 are replaced) and an oversized input becomes a size marker", () => {
    const ok = { a: deepValue(30) }; // object (1) + 30 arrays + leaf: 31 levels
    expect(normalizeClaudeEvent(toolUse(ok))[0]).toMatchObject({ input: ok });
    expect(normalizeClaudeEvent(toolUse({ a: deepValue(32) }))[0]).toMatchObject({ input: { _truncated: "depth" } });
    const big = { blob: "x".repeat(2 * 1024 * 1024) };
    expect(normalizeClaudeEvent(toolUse(big))[0]).toMatchObject({ input: { _truncated: "size" } });
    expect(normalizeClaudeEvent(toolUse({ q: "small" }))[0]).toMatchObject({ input: { q: "small" } });
  });

  it("MUTATION TARGET: a legitimate input of 130,000 small integers (~260 KB of JSON) is forwarded as is, not replaced by a marker (the backend groups batched approvals by input)", () => {
    const input = { ids: new Array(130_000).fill(7) };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(1024 * 1024);
    expect((normalizeClaudeEvent(toolUse(input))[0] as { input: unknown }).input).toBe(input);
    const real = { ids: new Array(300_000).fill(123456) }; // ~2.1 MB of JSON
    expect(normalizeClaudeEvent(toolUse(real))[0]).toMatchObject({ input: { _truncated: "size" } });
  });

  it("MUTATION TARGET: events with an over-long id or name are dropped (a 16 MB id would be forwarded to the backend as is)", () => {
    expect(normalizeClaudeEvent(toolUse({}, "i".repeat(257)))).toEqual([]);
    expect(normalizeClaudeEvent(toolUse({}, "tu1", "n".repeat(257)))).toEqual([]);
    expect(normalizeClaudeEvent(toolUse({}, "i".repeat(256)))).toHaveLength(1);
    const result = (id: string) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });
    expect(normalizeClaudeEvent(result("i".repeat(257)))).toEqual([]);
    expect(normalizeClaudeEvent(result("tu1"))).toEqual([{ type: "tool-result", operationId: "tu1", ok: true }]);
  });
});

describe("failure classification cannot be made to scan without bound", () => {
  it("MUTATION TARGET: a 5 MB failure text with many near-matches is classified in under 100 ms (the patterns have unbounded gaps: quadratic on the whole text)", () => {
    const hostile = "oauth".repeat(1_000_000) + "stream".repeat(1_000_000);
    const t0 = Date.now();
    expect(classifyFailureText(hostile)).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(100);
  });
  it("only the head is searched: a marker inside the first MAX_CLASSIFY_CHARS counts, one after it does not", () => {
    expect(classifyFailureText("You've hit your session limit " + "x".repeat(100))).toBe("usage_limit");
    expect(classifyFailureText("x".repeat(MAX_CLASSIFY_CHARS) + " session limit")).toBe("unknown");
    expect(classifyFailureText("Not logged in")).toBe("auth_like");
  });
});
