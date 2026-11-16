/**
 * ENG-2113: ported from the final security review's fuzz. LineLimit + the REAL readline == an independent reference, over random streams, line endings and
 * chunkings (seeded, so deterministic): exactly the complete, shallow event lines come out, in order, however the stream is cut.
 */
import { createInterface } from "readline";
import { LineLimit } from "../adapters/claudeAdapter";

function refEvents(text: string): string[] {
  const out: string[] = [];
  for (const seg of text.split(/\r\n|\n|\r/)) {
    const t = seg.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!t.startsWith("{") || !t.endsWith("}")) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let maxd = 0;
    for (const ch of t) {
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") {
        depth++;
        maxd = Math.max(maxd, depth);
      } else if ((ch === "}" || ch === "]") && depth > 0) depth--;
    }
    if (depth === 0 && !inStr && maxd <= 64) out.push(seg.replace(/^[ \t]+/, ""));
  }
  return out;
}

const CORPUS = [
  '{"a":1}', ' {"a":"x\\"}"}', '\t{"u":"  "}', '﻿{"bom":1}', '{"a":"b\rc"}', '{"a":[1,2,{"b":"}"}]}', "junk", "{", "}", '{"a":1} x', '{"a":1}\f', "", "  ", '{"s":"\\\\"}',
  '{"s":"\\\\\\"}"}', "[1]", '{"x":"\\u0000"}', '{"é":"日本"}', '{"a":1}\t ', '{"a":"\\', '"}{', '{"k":"v"}}', "{{}", '{"d":' + "[".repeat(60) + "]".repeat(60) + "}",
];

it("DIFFERENTIAL: LineLimit + the real readline deliver exactly the complete, shallow event lines of any stream, however it is cut (400 seeded streams)", async () => {
  let seed = 987654;
  const rnd = (n: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n);
  const nl = ["\n", "\r\n", "\r"];
  const bad: string[] = [];
  for (let iter = 0; iter < 400; iter++) {
    let text = "";
    const n = 1 + rnd(12);
    for (let i = 0; i < n; i++) text += CORPUS[rnd(CORPUS.length)] + (i === n - 1 && rnd(3) === 0 ? "" : nl[rnd(3)]);
    const lim = new LineLimit(1 << 20, () => undefined);
    const got: string[] = [];
    const rl = createInterface({ input: lim, crlfDelay: 100 });
    rl.on("line", (l) => {
      const t = l.replace(/^[ \t]+/, "");
      if (t.length) got.push(t);
    });
    const buf = Buffer.from(text);
    for (let p = 0; p < buf.length; ) {
      const k = 1 + rnd(7);
      lim.write(buf.subarray(p, p + k));
      p += k;
    }
    lim.end();
    await new Promise((r) => rl.once("close", r));
    if (JSON.stringify(got) !== JSON.stringify(refEvents(text))) bad.push(JSON.stringify(text).slice(0, 120));
  }
  expect(bad).toEqual([]);
});
