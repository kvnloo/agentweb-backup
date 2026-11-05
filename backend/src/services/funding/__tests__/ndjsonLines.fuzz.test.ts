import { LineSplitter } from '../ndjsonLines';

const TYPE_AT_START = /^\{"type":"([a-z-]{1,24})"/;
const MAXLINE = 5000;
const KNOWN = new Set(['text', 'result', 'tool-call', 'tool-use', 'usage', 'tool-result', 'entitlement', 'alarm']);
function capFor(head: Buffer): number {
  const type = TYPE_AT_START.exec(head.toString('latin1'))?.[1];
  if (type === 'text' || type === 'result') return Number.MAX_SAFE_INTEGER;
  if (type === 'tool-call' || type === 'tool-use') return 2000;
  return 600;
}
function skipFor(head: Buffer): boolean {
  const type = TYPE_AT_START.exec(head.toString('latin1'))?.[1];
  return type !== undefined && type !== 'accepted' && !KNOWN.has(type);
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function reference(raw: Buffer): { lines: string[]; threw: boolean } {
  const lines: string[] = [];
  const parts: Buffer[] = [];
  let from = 0;
  for (;;) {
    const nl = raw.indexOf(10, from);
    if (nl < 0) break;
    parts.push(raw.subarray(from, nl));
    from = nl + 1;
  }
  for (const p of parts) {
    const cap = Math.min(MAXLINE, capFor(p.subarray(0, 48)));
    if (p.length > cap) {
      if (skipFor(p.subarray(0, 48)) && p.length <= MAXLINE) continue;
      return { lines, threw: true };
    }
    if (p.length) lines.push(p.toString('latin1'));
  }
  return { lines, threw: false };
}

describe('SEC: LineSplitter differential fuzz', () => {
  it('matches a whole-buffer reference under random chunking', () => {
    let mismatches = 0;
    let first = '';
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const types = ['text', 'tool-call', 'usage', 'zzz', 'result', 'tool-use'];
      const pieces: Buffer[] = [];
      const n = 1 + Math.floor(r() * 8);
      for (let i = 0; i < n; i++) {
        const k = r();
        let line: string;
        if (k < 0.1) line = '';
        else if (k < 0.2) line = 'x'.repeat(Math.floor(r() * 80));
        else {
          const t = types[Math.floor(r() * types.length)];
          const len = Math.floor(r() * (r() < 0.3 ? 7000 : 800));
          line = `{"type":"${t}","d":"${'a'.repeat(len)}"}`;
        }
        pieces.push(Buffer.from(line + '\n'));
      }
      const raw = Buffer.concat(pieces);
      const ref = reference(raw);
      const sp = new LineSplitter(MAXLINE, () => new Error('long'), capFor, skipFor);
      const got: string[] = [];
      let threw = false;
      let pos = 0;
      try {
        while (pos < raw.length) {
          const sz = 1 + Math.floor(r() * (r() < 0.5 ? 20 : 3000));
          const chunk = raw.subarray(pos, Math.min(raw.length, pos + sz));
          pos += sz;
          for (const l of sp.push(Buffer.from(chunk))) got.push(l.toString('latin1'));
        }
      } catch {
        threw = true;
      }
      const ok = threw === ref.threw && (threw ? got.every((l, i) => l === ref.lines[i]) : JSON.stringify(got) === JSON.stringify(ref.lines));
      if (!ok) {
        mismatches++;
        if (!first) first = `seed ${seed}: threw=${threw} ref.threw=${ref.threw} got=${got.length} ref=${ref.lines.length}`;
      }
    }
    console.log('fuzz mismatches:', mismatches, first);
    expect(mismatches).toBe(0);
  });
});
