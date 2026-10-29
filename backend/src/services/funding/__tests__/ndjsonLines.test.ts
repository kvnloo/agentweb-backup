/** ENG-2113: the NDJSON line splitter is linear in the input (a hostile worker\'s 8 MiB line in small chunks used to cost seconds of CPU). */
import { LineSplitter } from '../ndjsonLines';

const make = (max = 9 * 1024 * 1024) => new LineSplitter(max, () => new Error('too_long'));

describe('LineSplitter', () => {
  it('splits lines across chunk boundaries, drops empty lines, keeps the tail', () => {
    const s = make();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n\n{"c":3}')).toEqual(['{"b":2}']);
    expect(s.push('\n')).toEqual(['{"c":3}']);
    expect(s.push('x\ny\nz')).toEqual(['x', 'y']);
    expect(s.push('\n')).toEqual(['z']);
  });
  it('a chunk with many lines yields them in order', () => {
    expect(make().push('1\n2\n3\n4\n')).toEqual(['1', '2', '3', '4']);
  });
  it('an unfinished line over the limit throws once it passes the limit (counted across chunks)', () => {
    const s = new LineSplitter(10, () => new Error('too_long'));
    s.push('12345');
    expect(() => s.push('678901')).toThrow('too_long');
    expect(() => new LineSplitter(10, () => new Error('too_long')).push('1234567890\n')).not.toThrow(); // finished lines are not "unfinished"
  });
  it('an 8 MiB line arriving in 4 KB chunks is assembled in linear time (well under what the quadratic reader needed: seconds)', () => {
    const line = 'x'.repeat(8 * 1024 * 1024 - 1);
    const s = make();
    const t0 = process.hrtime.bigint();
    let out: string[] = [];
    for (let i = 0; i < line.length; i += 4096) out = out.concat(s.push(line.slice(i, i + 4096)));
    out = out.concat(s.push('\n'));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(out).toHaveLength(1);
    expect(out[0].length).toBe(line.length);
    expect(ms).toBeLessThan(400);
  });
});
