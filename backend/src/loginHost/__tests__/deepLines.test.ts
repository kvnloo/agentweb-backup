/**
 * ENG-2113: the CLI's stdout is customer-controlled. A line of megabytes of nested brackets costs seconds of event-loop time in JSON.parse (here and, worse,
 * in the backend that receives what the host forwards), so the host cuts such a line BEFORE anything parses it and forwards a fixed placeholder instead.
 * Everything below is time-bounded: handling must stay well under 100 ms however deep the line is.
 */
import { createInterface } from "readline";
import { PassThrough } from "stream";
import type { ChildLike } from "../adapter";
import { RunnerChildAdapter } from "../adapters/claudeAdapter";
import { classifyFailureText, MAX_CLASSIFY_CHARS, normalizeClaudeEvent } from "../adapters/claudeParse";
import { MAX_CLI_LINE_DEPTH, rawJsonDepthExceeds } from "../relay/bounds";

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

  it.each([5_000, 100_000, 1_000_000])("MUTATION TARGET: a line nested %i deep is cut in well under a second (a few ms when idle; seconds if it were parsed); what is forwarded is tiny; the lines around it are intact", async (k) => {
    const r = rig();
    const line = nested(k);
    const t0 = Date.now();
    await r.feed('{"type":"before"}\n', line + "\n", '{"type":"after"}\n');
    expect(Date.now() - t0).toBeLessThan(300);
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
    expect(Date.now() - t0).toBeLessThan(300);
    expect(r.deep).toHaveLength(1);
    expect(r.out()).toBe(`{"s":"x\\"y"}\n${"[".repeat(64)}\n${PLACEHOLDER}\n{"ok":1}\n`);
  });

  describe("the runner's readline splits lines at a LONE \\r too (Node 22: \\n, \\r\\n and \\r; U+2028/2029 do NOT split): the scanner must end its lines at exactly the same places", () => {
    it("MUTATION TARGET: the bypass: a string-opening quote, a lone \\r, then a deep nesting is still cut", async () => {
      const r = rig();
      await r.feed('"\r' + nested(100) + "\nafter\n");
      expect(r.deep).toHaveLength(1);
      expect(r.out()).toBe('"\n' + "[".repeat(64) + `\n${PLACEHOLDER}\nafter\n`);
    });

    it("MUTATION TARGET: the OUTPUT has only \\n as a separator: a lone \\r and \\r\\n become one \\n each (also across a chunk edge); lines are untouched", async () => {
      const text = "one\rtwo\r\nthree\n\nfour\r\rfive\n";
      const want = "one\ntwo\nthree\n\nfour\n\nfive\n";
      for (let size = 1; size <= 9; size += 4) {
        const r = rig();
        const bytes = Buffer.from(text);
        await r.feed(...Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
        expect({ size, out: r.out() }).toEqual({ size, out: want });
        expect(r.out()).not.toContain("\r");
      }
    });

    it("MUTATION TARGET: a lone \\r ends a line (depth and string state reset), so each segment is counted from zero", async () => {
      const r = rig();
      await r.feed(nested(40) + "\r" + nested(40) + "\r" + nested(40) + "\n"); // each segment is 40 deep: none passes 64
      expect(r.deep).toHaveLength(0);
      expect(r.out()).toBe(nested(40) + "\n" + nested(40) + "\n" + nested(40) + "\n");
    });

    it("MUTATION TARGET: a \\r\\n split between two chunks is ONE line end, and a deep line after a \\r is still dropped", async () => {
      const r = rig();
      await r.feed("a\r", "\nb\r", nested(100), "\n", "c\n");
      expect(r.out()).toBe(`a\nb\n${"[".repeat(64)}\n${PLACEHOLDER}\nc\n`);
    });

    it("DIFFERENTIAL: random and adversarial byte streams through LineLimit into the REAL readline: no delivered line is deeper than the cap, and no ordinary line is changed or lost", async () => {
      let seed = 12345;
      const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
      const atoms = ["[", "[", "]", "{", "}", '"', "\\", "\r", "\n", "\r\n", "a", " ", "[".repeat(30), "]".repeat(30), "[".repeat(40), "[".repeat(40), "\r", "\r", '"', '{"k":1}', "\u2028"];
      for (let round = 0; round < 150; round++) {
        let text = "";
        const n = 5 + rnd(60);
        for (let i = 0; i < n; i++) text += atoms[rnd(atoms.length)];
        const bytes = Buffer.from(text);
        const chunks: Buffer[] = [];
        for (let p = 0; p < bytes.length; ) {
          const len = 1 + rnd(12);
          chunks.push(bytes.subarray(p, p + len));
          p += len;
        }
        const stdout = new PassThrough();
        const child: ChildLike = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => undefined, onExit: () => undefined };
        const adapter = new RunnerChildAdapter(child, 1 << 20, () => undefined);
        const got: string[] = [];
        const rl = createInterface({ input: adapter.stdout });
        rl.on("line", (l) => got.push(l));
        for (const c of chunks) stdout.write(c);
        stdout.end();
        await new Promise((r) => rl.on("close", r));
        for (const l of got) expect({ round, deep: rawJsonDepthExceeds(Buffer.from(l), MAX_CLI_LINE_DEPTH) }).toEqual({ round, deep: false });
        // every ordinary (shallow) line of the input, split the way readline splits it, is delivered unchanged and in order
        const expected: string[] = [];
        for (const seg of text.split(/\r?\n|\r/)) if (!rawJsonDepthExceeds(Buffer.from(seg), MAX_CLI_LINE_DEPTH) && seg.length > 0) expected.push(seg);
        const delivered = got.filter((l) => l.length > 0 && l !== PLACEHOLDER);
        // a segment cut mid-line keeps its shallow head, so compare only segments the scanner would never cut: whole-line membership, in order
        let at = 0;
        for (const e of expected) {
          const hit = delivered.indexOf(e, at);
          if (hit >= 0) at = hit + 1;
        }
        // every segment shallow (what readline hands JSON.parse): nothing may be cut, altered or lost
        const segs = text.split(/\r?\n|\r/);
        if (segs.every((g) => !rawJsonDepthExceeds(Buffer.from(g), MAX_CLI_LINE_DEPTH))) expect({ round, got: got.filter((l) => l.length > 0) }).toEqual({ round, got: expected });
      }
    });

    it("MUTATION TARGET: end to end through the REAL readline the runner uses: no line that reaches JSON.parse is deeper than the cap", async () => {
      const stdout = new PassThrough();
      const child: ChildLike = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => undefined, onExit: () => undefined };
      const adapter = new RunnerChildAdapter(child, 16 * 1024 * 1024, () => undefined);
      const lines: string[] = [];
      const rl = createInterface({ input: adapter.stdout });
      rl.on("line", (l) => lines.push(l));
      stdout.write('{"a":"\r' + nested(200_000) + "\n");
      stdout.write('"\r' + nested(200_000) + "\r\n");
      stdout.write('{"type":"ok"}\n');
      stdout.end();
      await new Promise((r) => rl.on("close", r));
      expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(200);
      expect(lines).toContain('{"type":"ok"}');
      for (const l of lines) expect(l.split("[").length - 1).toBeLessThanOrEqual(64);
    });

    it("the byte cap counts each \\r/\\n segment on its own", async () => {
      const r = rig(100);
      await r.feed("x".repeat(60) + "\r" + "y".repeat(60) + "\r" + "z".repeat(60) + "\n"); // 180 bytes in all, no segment over 100
      expect(r.errors).toHaveLength(0);
      await r.feed("w".repeat(101));
      expect(r.errors.map((e) => e.message)).toEqual(["stdout_line_too_long"]);
    });
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
