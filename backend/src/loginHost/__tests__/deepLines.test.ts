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
import { MAX_LINE_VALUES } from "../adapters/claudeAdapter";

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
// an EVENT-shaped deep line: real stream-json lines start with `{` (anything else is dropped as junk before the depth scan matters); depth k
const nested = (k: number) => "{" + "[".repeat(k - 1) + "]".repeat(k - 1) + "}";
const PLACEHOLDER = '{"type":"aw_line_dropped"}';

// reference implementation, written independently of LineLimit: one complete JSON object per line (first non-space `{`, last `}`, balanced outside strings)
function eventShaped(seg: string): boolean {
  const t = seg.replace(/^[ \t]+|[ \t]+$/g, ""); // only the JSON whitespace the scanner knows (not U+2028 etc.)
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (const ch of t) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if ((ch === "}" || ch === "]") && depth > 0) depth--;
  }
  return depth === 0 && !inStr;
}

describe("CLI stdout: lines nested deeper than the cap are dropped before anything parses them", () => {
  it("ordinary lines pass through byte for byte, whatever the chunk boundaries (strings, escapes, brackets inside strings)", async () => {
    const r = rig();
    const lines = ['{"type":"assistant","message":{"content":[{"type":"text","text":"a [[[[ \\" {{{{ \\\\"}]}}', '{"a":{"b":{"c":[1,2,{"d":null}]}}}', '{"plain":"noise"}', ""];
    const text = lines.join("\n") + "\n";
    const kept = lines.filter(Boolean).join("\n") + "\n"; // blank lines are dropped (and charged to the junk budget)
    for (let size = 1; size <= 9; size += 4) {
      const r2 = rig();
      const bytes = Buffer.from(text);
      await r2.feed(...Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
      expect(r2.out()).toBe(kept);
      expect(r2.deep).toHaveLength(0);
    }
    await r.feed(text);
    expect(r.out()).toBe(kept);
  });

  it("MUTATION TARGET: the boundary is exact: depth 64 passes, depth 65 is cut", async () => {
    expect(MAX_CLI_LINE_DEPTH).toBe(64);
    const ok = rig();
    await ok.feed(nested(64) + "\n");
    expect(ok.out()).toBe(nested(64) + "\n");
    expect(ok.deep).toHaveLength(0);
    const bad = rig();
    await bad.feed(nested(65) + "\n{\"next\":1}\n");
    expect(bad.deep).toHaveLength(1);
    expect(bad.out()).not.toContain("]]]]");
    expect(bad.out()).toBe(`${PLACEHOLDER}\n{"next":1}\n`);
  });

  it.each([5_000, 100_000, 500_000])("MUTATION TARGET: a line nested %i deep is cut in well under a second (a few ms when idle; seconds if it were parsed); what is forwarded is tiny; the lines around it are intact", async (k) => {
    const r = rig();
    const line = nested(k);
    const t0 = Date.now();
    await r.feed('{"type":"before"}\n', line + "\n", '{"type":"after"}\n');
    expect(Date.now() - t0).toBeLessThan(2500); // (a few ms idle; parsed it would take seconds and a stack overflow: the structural checks below are the real pins)
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
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(r.deep).toHaveLength(1);
    expect(r.out()).toBe(`{"s":"x\\"y"}\n${PLACEHOLDER}\n{"ok":1}\n`);
  });

  describe("the runner's readline splits lines at a LONE \\r too (Node 22: \\n, \\r\\n and \\r; U+2028/2029 do NOT split): the scanner must end its lines at exactly the same places", () => {
    it("MUTATION TARGET: the bypass: a string-opening quote, a lone \\r, then a deep nesting is still cut", async () => {
      const r = rig();
      await r.feed('{"x":"\r' + nested(100) + '\n{"after":1}\n');
      expect(r.deep).toHaveLength(1);
      expect(r.out()).toBe(`${PLACEHOLDER}\n{"after":1}\n`); // the unterminated first line is not an event: dropped
    });

    it("MUTATION TARGET: the OUTPUT has only \\n as a separator: a lone \\r and \\r\\n become one \\n each (also across a chunk edge); lines are untouched", async () => {
      const text = '{"o":1}\r{"t":2}\r\n{"h":3}\n\n{"f":4}\r\r{"v":5}\n';
      const want = '{"o":1}\n{"t":2}\n{"h":3}\n{"f":4}\n{"v":5}\n'; // (blank lines are dropped)
      for (let size = 1; size <= 9; size += 4) {
        const r = rig();
        const bytes = Buffer.from(text);
        await r.feed(...Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
        expect({ size, out: r.out() }).toEqual({ size, out: want });
        expect(r.out()).not.toContain("\r");
      }
    });

    it("MUTATION TARGET: a deep line that ends in a lone \\r (while being discarded) does not swallow the event after it, in one chunk or many", async () => {
      const text = nested(100) + "\r" + '{"ev":1}' + "\n" + nested(100) + "\r\n" + '{"ev":2}' + "\n";
      const want = `${PLACEHOLDER}\n{"ev":1}\n${PLACEHOLDER}\n{"ev":2}\n`;
      const whole = rig();
      await whole.feed(text);
      expect(whole.out()).toBe(want);
      const bytes = Buffer.from(text);
      for (const size of [1, 7]) {
        const r = rig();
        await r.feed(...Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
        expect({ size, out: r.out() }).toEqual({ size, out: want });
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
      await r.feed('{"a":1}\r', '\n{"b":1}\r', nested(100), "\n", '{"c":1}\n');
      expect(r.out()).toBe(`{"a":1}\n{"b":1}\n${PLACEHOLDER}\n{"c":1}\n`);
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
        for (const seg of text.split(/\r?\n|\r/)) if (!rawJsonDepthExceeds(Buffer.from(seg), MAX_CLI_LINE_DEPTH) && eventShaped(seg)) expected.push(seg.trimStart()); // junk lines are dropped; whitespace-only lines are not compared (the runner ignores them)
        const delivered = got.filter((l) => l.trim().length > 0 && l !== PLACEHOLDER).map((l) => l.trimStart());
        // a segment cut mid-line keeps its shallow head, so compare only segments the scanner would never cut: whole-line membership, in order
        let at = 0;
        for (const e of expected) {
          const hit = delivered.indexOf(e, at);
          if (hit >= 0) at = hit + 1;
        }
        // every segment shallow (what readline hands JSON.parse): nothing may be cut, altered or lost
        const segs = text.split(/\r?\n|\r/);
        if (segs.every((g) => !rawJsonDepthExceeds(Buffer.from(g), MAX_CLI_LINE_DEPTH))) expect({ round, got: got.filter((l) => l.trim().length > 0).map((l) => l.trimStart()) }).toEqual({ round, got: expected });
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
    await r.feed(nested(100) + "\n" + nested(100) + "\n{\"fine\":1}\n");
    expect(r.deep).toHaveLength(2);
    expect(r.out().split("\n").filter((l) => l === PLACEHOLDER)).toHaveLength(2);
    expect(r.out().endsWith("{\"fine\":1}\n")).toBe(true);
  });

  it("brackets inside a string never count as nesting, however many", async () => {
    const r = rig();
    const line = `{"t":"${"[".repeat(100_000)}"}\n`;
    await r.feed(line);
    expect(r.out()).toBe(line);
    expect(r.deep).toHaveLength(0);
  });

  describe("junk lines (not events) never reach the runner, and a flood of them ends the stream", () => {
    // what the runner does with every non-empty line it is given: JSON.parse, and throw on junk
    async function viaRunner(chunks: Array<string | Buffer>, maxLine = 16 * 1024 * 1024) {
      const stdout = new PassThrough();
      const child: ChildLike = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => undefined, onExit: () => undefined };
      const adapter = new RunnerChildAdapter(child, maxLine, () => undefined);
      const errors: string[] = [];
      adapter.on("error", (e: Error) => errors.push(e.message));
      let parsed = 0;
      let threw = 0;
      const rl = createInterface({ input: adapter.stdout });
      rl.on("line", (l) => {
        if (!l.trim()) return;
        try {
          JSON.parse(l);
          parsed++;
        } catch {
          threw++;
        }
      });
      const t0 = process.hrtime.bigint();
      for (const c of chunks) stdout.write(c);
      stdout.end();
      await new Promise((r) => rl.on("close", r));
      return { parsed, threw, errors, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    }

    it("MUTATION TARGET: a non-event line (first non-space byte is not {) is dropped before the runner sees it; events around it are untouched; the counter counts", async () => {
      const r = rig();
      await r.feed('{"a":1}\nx\n  [1,2]\n\tnull\n{"b":2}\nwarning: not json\n   {"c":3}\n');
      expect(r.out()).toBe('{"a":1}\n{"b":2}\n   {"c":3}\n');
    });

    it("MUTATION TARGET: the same across chunk edges and \\r endings", async () => {
      const text = '{"a":1}\rjunk\r\n  xx\r{"b":2}\n';
      for (let size = 1; size <= 7; size += 3) {
        const r = rig();
        const bytes = Buffer.from(text);
        await r.feed(...Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)));
        expect({ size, lines: r.out().split("\n").map((l) => l.trim()).filter(Boolean) }).toEqual({ size, lines: ['{"a":1}', '{"b":2}'] });
      }
    });

    it("MUTATION TARGET: THE FLOOD: 64 KiB of \"x\\n\" (32k junk lines) never reaches JSON.parse, ends the stream with stdout_flood, and costs a few ms instead of ~0.8 s", async () => {
      const r = await viaRunner([Buffer.from("x\n".repeat(32 * 1024))]);
      console.log("FLOOD x\\n ms", r.ms.toFixed(1), JSON.stringify({ parsed: r.parsed, threw: r.threw }));
      expect(r.threw).toBe(0);
      expect(r.errors).toEqual(["stdout_flood"]);
      expect(r.ms).toBeLessThan(2500);
    });

    it("MUTATION TARGET: the same flood with '{\\n' lines (starts like an event, is not one) is parsed at most for the lines that fit the budget", async () => {
      const r = await viaRunner([Buffer.from("{\n".repeat(32 * 1024))]);
      console.log("FLOOD {\\n ms", r.ms.toFixed(1), JSON.stringify({ parsed: r.parsed, threw: r.threw }));
      expect(r.ms).toBeLessThan(10_000); // catastrophe bound only (the gate fails closed: a slow runner must not block a deploy); the structural assertions are the pins
    });

    it("MUTATION TARGET: 600 incomplete `{` lines are charged to the JUNK bucket (burst 200), not the event bucket (burst 5,000): the stream ends", async () => {
      const r = await viaRunner([Buffer.from("{\n".repeat(600))]);
      expect(r.errors).toEqual(["stdout_flood"]);
      expect(r.threw).toBe(0);
    });

    it("MUTATION TARGET: the value cap is exact: a line of MAX_LINE_VALUES values passes, one more is dropped (and never forwarded, only the fixed placeholder)", async () => {
      const arr = (n: number) => '{"a":[' + "0,".repeat(n - 2) + "0]}\n"; // {"a": array: values = the array + (n-2) commas... counted as [ and each comma
      const ok = rig();
      await ok.feed(Buffer.from(arr(MAX_LINE_VALUES)));
      expect(ok.out()).toBe(arr(MAX_LINE_VALUES));
      const over = rig();
      await over.feed(Buffer.from(arr(MAX_LINE_VALUES + 2)));
      expect(over.out()).toBe(`${PLACEHOLDER}\n`);
      expect(over.deep).toHaveLength(1);
    });

    it("MUTATION TARGET: a flood of tiny VALID events ({} 21,000 times in one 64 KiB chunk) ends the stream too: each is cheap, but not 21,000 of them", async () => {
      const r = await viaRunner([Buffer.from("{}\n".repeat(21 * 1024))]);
      console.log("FLOOD {} ms", r.ms.toFixed(1), JSON.stringify({ parsed: r.parsed, threw: r.threw }));
      expect(r.errors).toEqual(["stdout_flood"]);
      expect(r.parsed).toBe(0); // nothing of the chunk is released once the budget is passed
    });

    it("MUTATION TARGET: a flood of BLANK lines ends the stream too", async () => {
      const r = await viaRunner([Buffer.alloc(64 * 1024, 10)]);
      expect(r.errors).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: the byte budget: a few huge junk lines end the stream even though the line count is tiny", async () => {
      const r = await viaRunner(["x".repeat(600 * 1024) + "\n", "y".repeat(600 * 1024) + "\n"]);
      expect(r.errors).toEqual(["stdout_flood"]);
    });

    it("an honest stream is untouched: 2,000 events with an occasional junk line (well inside the budget)", async () => {
      const chunks: string[] = [];
      for (let i = 0; i < 2000; i++) chunks.push(`{"type":"assistant","n":${i}}\n${i % 100 === 0 ? "note\n" : ""}`);
      const r = await viaRunner(chunks);
      expect(r.parsed).toBe(2000);
      expect(r.threw).toBe(0);
      expect(r.errors).toEqual([]);
    });

    it("MUTATION TARGET: the budget REFILLS with time (a slow trickle of junk never ends the stream)", async () => {
      const stdout = new PassThrough();
      const child: ChildLike = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => undefined, onExit: () => undefined };
      const errors: string[] = [];
      const adapter = new RunnerChildAdapter(child, 1 << 20, () => undefined);
      adapter.on("error", (e: Error) => errors.push(e.message));
      adapter.stdout.resume();
      const now = jest.spyOn(performance, "now");
      let t = 1000;
      now.mockImplementation(() => t);
      try {
        for (let round = 0; round < 10; round++) {
          stdout.write("j\n".repeat(150)); // 150 junk lines: fits the burst of 200 only when it has refilled
          await new Promise((r) => setImmediate(r));
          t += 4000; // 4 s at 50/s refills 200
        }
        expect(errors).toEqual([]);
        stdout.write("j\n".repeat(150));
        stdout.write("j\n".repeat(150)); // no time passes: 300 in a burst of 200
        await new Promise((r) => setImmediate(r));
        expect(errors).toEqual(["stdout_flood"]);
      } finally {
        now.mockRestore();
      }
    });

    async function clocked(rounds: Array<{ chunks: Array<string | Buffer>; advanceMs: number }>) {
      const stdout = new PassThrough();
      const child: ChildLike = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => undefined, onExit: () => undefined };
      const errors: string[] = [];
      const adapter = new RunnerChildAdapter(child, 16 * 1024 * 1024, () => undefined);
      adapter.on("error", (e: Error) => errors.push(e.message));
      let out = "";
      adapter.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
      const now = jest.spyOn(performance, "now");
      let t = 1000;
      now.mockImplementation(() => t);
      try {
        for (const r of rounds) {
          for (const c of r.chunks) stdout.write(c);
          await new Promise((res) => setImmediate(res));
          t += r.advanceMs;
        }
      } finally {
        now.mockRestore();
      }
      lastOut = out;
      return errors;
    }
    let lastOut = ""; // what the last clocked() run let through

    it("MUTATION TARGET: the event LINE bucket REFILLS: 15,000 honest events over time (3,000 per 2 s, the burst is 5,000, 2,000 a second) never end the stream; 6,000 at once do", async () => {
      const chunk = Buffer.from("{}\n".repeat(3000));
      expect(await clocked(Array.from({ length: 5 }, () => ({ chunks: [chunk], advanceMs: 2000 })))).toEqual([]);
      expect(await clocked([{ chunks: [Buffer.from("{}\n".repeat(3000)), Buffer.from("{}\n".repeat(3000))], advanceMs: 0 }])).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: the event BYTE bucket REFILLS: 60 MiB of events every 16 s (burst 64 MiB, 4 MiB/s) never ends the stream; 70 MiB at once does", async () => {
      const line = Buffer.from('{"s":"' + "a".repeat(1024 * 1024 - 10) + '"}\n'); // 1 MiB
      const round = { chunks: Array.from({ length: 60 }, () => line), advanceMs: 16_000 };
      expect(await clocked([round, round, round])).toEqual([]);
      expect(await clocked([{ chunks: Array.from({ length: 70 }, () => line), advanceMs: 0 }])).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: the value count RESETS at every line: 3,000 honest events of 100 values each (300,000 in all, twice the per-line cap) lose nothing", async () => {
      const line = Buffer.from('{"a":[' + "0,".repeat(98) + "0]}\n"); // 100 values
      expect(await clocked([{ chunks: [Buffer.concat(Array.from({ length: 3000 }, () => line))], advanceMs: 0 }])).toEqual([]);
      expect(lastOut.split("\n").filter(Boolean)).toHaveLength(3000);
    });

    it("MUTATION TARGET: an idle turn does not bank credit: an hour of silence refills only up to the 64 MiB burst, so 70 MiB at once still ends the stream", async () => {
      const line = Buffer.from('{"s":"' + "a".repeat(1024 * 1024 - 10) + '"}\n');
      const errors = await clocked([
        { chunks: ["{}\n"], advanceMs: 3_600_000 },
        { chunks: Array.from({ length: 70 }, () => line), advanceMs: 0 },
      ]);
      expect(errors).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: the same for the junk LINE bucket (an hour idle, then 250 junk lines at once) and the event LINE bucket (6,000 events at once)", async () => {
      expect(await clocked([{ chunks: ["j\n"], advanceMs: 3_600_000 }, { chunks: ["j\n".repeat(250)], advanceMs: 0 }])).toEqual(["stdout_flood"]);
      expect(await clocked([{ chunks: ["{}\n"], advanceMs: 3_600_000 }, { chunks: ["{}\n".repeat(6000)], advanceMs: 0 }])).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: the junk BYTE bucket: burst 1 MiB (an idle hour does not raise it), refill 128 KiB a second", async () => {
      const junk = (n: number) => "x".repeat(n - 1) + "\n";
      // burst: 1.5 MiB of junk after an idle hour is still over the 1 MiB burst
      expect(await clocked([{ chunks: ["j\n"], advanceMs: 3_600_000 }, { chunks: [junk(1_500_000)], advanceMs: 0 }])).toEqual(["stdout_flood"]);
      // rate: 1,000,000 bytes leaves 48,576; 4 s refill 512 KiB; 500,000 fits; 500,000 more at once does not
      expect(await clocked([{ chunks: [junk(1_000_000)], advanceMs: 4000 }, { chunks: [junk(500_000)], advanceMs: 0 }])).toEqual([]);
      expect(await clocked([{ chunks: [junk(1_000_000)], advanceMs: 4000 }, { chunks: [junk(500_000), junk(500_000)], advanceMs: 0 }])).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: the value cap is exact at both ends (MAX_LINE_VALUES kept, MAX_LINE_VALUES + 1 dropped) and the dropped line is charged to the junk bucket", async () => {
      const valuesLine = (v: number) => '{"a":[' + "0,".repeat(v - 2) + "0]}\n"; // {  [  and v-2 commas = v values
      expect(await clocked([{ chunks: [Buffer.from(valuesLine(MAX_LINE_VALUES))], advanceMs: 0 }])).toEqual([]);
      expect(lastOut).toBe(valuesLine(MAX_LINE_VALUES));
      expect(await clocked([{ chunks: [Buffer.from(valuesLine(MAX_LINE_VALUES + 1))], advanceMs: 0 }])).toEqual([]);
      expect(lastOut).toBe(`${PLACEHOLDER}\n`);
      // charged: six dense lines of ~300 KB each pass the 1 MiB junk byte burst (the comma branch)
      const dense = Buffer.from(valuesLine(MAX_LINE_VALUES + 1));
      expect(await clocked([{ chunks: Array.from({ length: 6 }, () => dense), advanceMs: 0 }])).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: a dense line whose values are OPENERS (the other branch) is dropped and charged too", async () => {
      const dense = Buffer.from('{"a":[' + "[]".repeat(MAX_LINE_VALUES + 1) + "]}\n");
      expect(await clocked([{ chunks: [dense], advanceMs: 0 }])).toEqual([]);
      expect(lastOut).toBe(`${PLACEHOLDER}\n`);
      expect(await clocked([{ chunks: Array.from({ length: 6 }, () => dense), advanceMs: 0 }])).toEqual(["stdout_flood"]);
    });

    it("MUTATION TARGET: whitespace-only lines are charged to the junk bucket, by count and by bytes", async () => {
      expect(await clocked([{ chunks: ["  \n".repeat(300)], advanceMs: 0 }])).toEqual(["stdout_flood"]); // lines
      expect(await clocked([{ chunks: [" ".repeat(1_500_000) + "\n"], advanceMs: 0 }])).toEqual(["stdout_flood"]); // bytes
      expect(await clocked([{ chunks: ["  \n".repeat(100)], advanceMs: 0 }])).toEqual([]); // a few are fine
      expect(lastOut).toBe("");
    });

    it("MUTATION TARGET: the bytes of a deep line that never ends are counted against the cap while they are being discarded (overflow, not a free ride)", async () => {
      const r = rig(10_000);
      await r.feed(nested(100));
      await r.feed("[".repeat(4000), "[".repeat(4000), "[".repeat(4000));
      expect(r.errors.map((e) => e.message)).toEqual(["stdout_line_too_long"]);
    });

    it("MUTATION TARGET: 64 KiB of lone \\r costs the same order as 64 KiB of \\n (no buffer per \\r), and scanning a dropped-line chunk is linear", async () => {
      const cr = rig();
      const lf = rig();
      const t0 = process.hrtime.bigint();
      await cr.feed(Buffer.from("{}\r".repeat(4000)));
      const crMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const t1 = process.hrtime.bigint();
      await lf.feed(Buffer.from("{}\n".repeat(4000)));
      const lfMs = Number(process.hrtime.bigint() - t1) / 1e6;
      console.log("CR vs LF ms", crMs.toFixed(1), lfMs.toFixed(1));
      expect(cr.out()).toBe("{}\n".repeat(4000));
      expect(crMs).toBeLessThan(2500);
      const jr = rig();
      const t2 = process.hrtime.bigint();
      await jr.feed(Buffer.from("junk\n".repeat(30)).toString().repeat(1)); // within the budget: many dropped lines in ONE chunk
      expect(Number(process.hrtime.bigint() - t2) / 1e6).toBeLessThan(2500);
    });
  });

  it("the byte cap on a line still applies (a line that never ends is cut off as before)", async () => {
    const r = rig(1000);
    // the adapter kills the child and emits an error; the stream stops forwarding
    await r.feed("{" + "x".repeat(599), "y".repeat(600));
    expect(r.errors.map((e) => e.message)).toEqual(["stdout_line_too_long"]);
    expect(r.out()).toBe(""); // an unfinished event line is held until its end, and never released once the stream is cut
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
    expect(Date.now() - t0).toBeLessThan(2500);
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
  it("MUTATION TARGET: a 5 MB failure text with many near-matches is classified in bounded time (the patterns have unbounded gaps: quadratic on the whole text is minutes)", () => {
    const hostile = "oauth".repeat(1_000_000) + "stream".repeat(1_000_000);
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      expect(classifyFailureText(hostile)).toBe("unknown");
      best = Math.min(best, Date.now() - t0); // the fastest of three: robust against a loaded machine, still orders of magnitude under the quadratic cost
    }
    expect(best).toBeLessThan(1500);
  });
  it("only the head is searched: a marker inside the first MAX_CLASSIFY_CHARS counts, one after it does not", () => {
    expect(classifyFailureText("You've hit your session limit " + "x".repeat(100))).toBe("usage_limit");
    expect(classifyFailureText("x".repeat(MAX_CLASSIFY_CHARS) + " session limit")).toBe("unknown");
    expect(classifyFailureText("Not logged in")).toBe("auth_like");
  });
});
