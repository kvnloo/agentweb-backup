/** ENG-2113: the NDJSON line splitter is linear in the input and bounded in memory (a hostile worker's 8 MiB line in tiny chunks used to cost seconds of CPU and ~90 MB). */
import { LineSplitter } from '../ndjsonLines';

const make = (max = 9 * 1024 * 1024, capFor?: (head: Buffer) => number) => new LineSplitter(max, () => new Error('too_long'), capFor);
const B = (s: string) => Buffer.from(s);
const text = (lines: Buffer[]) => lines.map((l) => l.toString());

describe('LineSplitter', () => {
  it('splits lines across chunk boundaries, drops empty lines, keeps the tail', () => {
    const s = make();
    expect(text(s.push(B('{"a":1}\n{"b"')))).toEqual(['{"a":1}']);
    expect(text(s.push(B(':2}\n\n{"c":3}')))).toEqual(['{"b":2}']);
    expect(text(s.push(B('\n')))).toEqual(['{"c":3}']);
    expect(text(s.push(B('x\ny\nz')))).toEqual(['x', 'y']);
    expect(text(s.push(B('\n')))).toEqual(['z']);
  });
  it('a chunk with many lines yields them in order; multi-byte characters split across chunks survive', () => {
    expect(text(make().push(B('1\n2\n3\n4\n')))).toEqual(['1', '2', '3', '4']);
    const s = make();
    const euro = B('{"s":"€"}\n');
    expect(s.push(euro.subarray(0, 7))).toEqual([]); // cuts the 3-byte character
    expect(text(s.push(euro.subarray(7)))).toEqual(['{"s":"€"}']);
  });
  it('a line is held to the cap, counted in bytes across chunks; finished lines are not "unfinished"', () => {
    const s = new LineSplitter(10, () => new Error('too_long'));
    s.push(B('12345'));
    expect(() => s.push(B('678901'))).toThrow('too_long');
    expect(() => new LineSplitter(10, () => new Error('too_long')).push(B('1234567890\n'))).not.toThrow();
    expect(() => new LineSplitter(10, () => new Error('too_long')).push(B('12345678901\n'))).toThrow('too_long');
  });
  it('capFor gives a line a smaller cap as soon as its first bytes are known (an 8 MiB line of a small type is cut early, not buffered)', () => {
    const capFor = (head: Buffer) => (head.toString().startsWith('{"type":"entitlement"') ? 100 : 1_000_000);
    const s = make(9 * 1024 * 1024, capFor);
    expect(() => s.push(B('{"type":"entitlement","observation":{"windows":[' + '{},'.repeat(100)))).toThrow('too_long');
    const ok = make(9 * 1024 * 1024, capFor);
    expect(text(ok.push(B('{"type":"text","delta":"' + 'x'.repeat(5000) + '"}\n')))).toHaveLength(1);
    const small = make(9 * 1024 * 1024, capFor);
    expect(text(small.push(B('{"type":"entitlement"}\n')))).toEqual(['{"type":"entitlement"}']); // a short line of a capped type is fine
  });
  it('a finished line does not leave its cap to the next line (a small `accepted` line must not shrink the cap of the big text line after it)', () => {
    const capFor = (head: Buffer) => (head.toString().startsWith('{"type":"accepted"') ? 100 : 1_000_000);
    const s = make(9 * 1024 * 1024, capFor);
    const lines = s.push(B('{"type":"accepted"}\n{"type":"text","delta":"' + 'x'.repeat(50_000) + '"}\n'));
    expect(lines).toHaveLength(2);
    const s2 = make(9 * 1024 * 1024, capFor);
    s2.push(B('{"type":"accepted"}\n'));
    expect(text(s2.push(B('{"type":"text","delta":"' + 'x'.repeat(50_000) + '"}\n')))).toHaveLength(1);
  });

  it('an 8 MiB line in 4 KB chunks is assembled in linear time', () => {
    const line = Buffer.alloc(8 * 1024 * 1024 - 1, 0x78);
    const s = make();
    const t0 = process.hrtime.bigint();
    let out: Buffer[] = [];
    for (let i = 0; i < line.length; i += 4096) out = out.concat(s.push(line.subarray(i, i + 4096)));
    out = out.concat(s.push(B('\n')));
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(400);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(line.length);
  });
  it('1-byte chunks: an 8 MiB line costs about 8 MiB of memory, not 90 MB (one growing buffer, no piece per chunk)', () => {
    const one = Buffer.from('x');
    const s = make();
    if (global.gc) global.gc();
    const before = process.memoryUsage();
    for (let i = 0; i < 8 * 1024 * 1024 - 1; i++) s.push(one);
    const after = process.memoryUsage();
    const grown = after.heapUsed - before.heapUsed + (after.arrayBuffers - before.arrayBuffers);
    expect(grown).toBeLessThan(40 * 1024 * 1024);
    const done = s.push(B('\n'));
    expect(done).toHaveLength(1);
    expect(done[0].length).toBe(8 * 1024 * 1024 - 1);
  });
});

describe('LineSplitter: discarding an over-cap line of a skippable type', () => {
  const mk = () => new LineSplitter(1_000_000, () => new Error('too long'), (h) => (h.toString('latin1').startsWith('{"type":"big"') ? 100 : 1_000_000), (h) => h.toString('latin1').startsWith('{"type":"big"'));
  const bigLine = '{"type":"big","pad":"' + 'p'.repeat(5_000) + '"}\n';
  const feed = (sp: LineSplitter, text: string, size: number) => {
    const out: string[] = [];
    const b = Buffer.from(text);
    for (let i = 0; i < b.length; i += size) for (const l of sp.push(b.subarray(i, i + size))) out.push(l.toString());
    return out;
  };
  it.each([1, 7, 100, 100_000])('drops the over-cap line and keeps its neighbours (chunks of %i bytes)', (size) => {
    const out = feed(mk(), '{"type":"a"}\n' + bigLine + '{"type":"b"}\n', size);
    expect(out).toEqual(['{"type":"a"}', '{"type":"b"}']);
  });
  it('a discarded line that never ends is still cut at the hard line cap', () => {
    const sp = new LineSplitter(10_000, () => new Error('too long'), () => 100, () => true);
    expect(() => feed(sp, '{"type":"big","pad":"' + 'p'.repeat(50_000), 1_000)).toThrow('too long');
  });
  it('the total of a discarded line is counted up to and including its last piece (the closing piece cannot take it past the hard cap unnoticed)', () => {
    const sp = new LineSplitter(10_000, () => new Error('too long'), () => 100, () => true);
    sp.push(Buffer.from('{"type":"big","pad":"' + 'p'.repeat(4_000))); // over the small cap: now being discarded, 4 KB so far
    expect(() => sp.push(Buffer.from('q'.repeat(7_000) + '"}\n'))).toThrow('too long'); // the piece that ends the line brings it over 10 KB
  });
});
