/**
 * ENG-2113 (independent security review F1): empty NDJSON lines used to bypass the stream budget. LineSplitter ran its per-line cap check (a latin1 decode and a regex)
 * for EVERY empty line and nothing counted them, only bytes: 64 MiB of "\n" cost ~27 s of event-loop time (28.4 s end to end through the real transport, 25 s of it
 * as lag). Empty lines are now skipped before any check and counted; past MAX_EMPTY_LINES the stream fails.
 */
import { LineSplitter, MAX_EMPTY_LINES } from '../ndjsonLines';

const TYPE_AT_START = /^\{"type":"([a-z-]{1,24})"/;
function capFor(head: Buffer): number {
  const type = TYPE_AT_START.exec(head.toString('latin1'))?.[1];
  if (type === 'text' || type === 'result') return Number.MAX_SAFE_INTEGER;
  if (type === 'tool-call' || type === 'tool-use') return 1_536 * 1024;
  return 64 * 1024;
}
const mk = (cap = capFor) => {
  const capFor_ = jest.fn(cap);
  const sp = new LineSplitter(8 * 1024 * 1024, () => new Error('too long'), capFor_, () => false, () => new Error('too many empty lines'));
  return { sp, capFor_ };
};

describe('LineSplitter: empty lines are counted, and cheap', () => {
  it('a 64 KiB chunk of newlines fails the stream within that one push, in milliseconds, without the per-line check ever running', () => {
    const { sp, capFor_ } = mk();
    const chunk = Buffer.alloc(64 * 1024, 10);
    const t0 = process.hrtime.bigint();
    expect(() => sp.push(chunk)).toThrow('too many empty lines');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(50);
    expect(capFor_).not.toHaveBeenCalled();
  });

  it('newlines delivered chunk by chunk end at the first chunk that passes the limit (64 MiB used to take 27 s)', () => {
    const { sp } = mk();
    const chunk = Buffer.alloc(64 * 1024, 10);
    const t0 = Date.now();
    let pushes = 0;
    expect(() => {
      for (let i = 0; i < 8; i++) {
        pushes++;
        sp.push(chunk);
      }
    }).toThrow('too many empty lines');
    expect(pushes).toBe(1);
    expect(Date.now() - t0).toBeLessThan(200);
  });

  it('honest streams are unchanged: blank lines between events are tolerated up to the limit, the events come out in order', () => {
    const { sp } = mk();
    const out = sp.push(Buffer.from('{"type":"usage"}\n\n\n{"type":"text","delta":"a"}\n\n{"type":"result","ok":true,"text":"t"}\n'));
    expect(out.map((l) => l.toString())).toEqual(['{"type":"usage"}', '{"type":"text","delta":"a"}', '{"type":"result","ok":true,"text":"t"}']);
  });

  it(`exactly ${MAX_EMPTY_LINES} empty lines in a stream pass, one more fails (the count is per stream, across chunks)`, () => {
    expect(MAX_EMPTY_LINES).toBe(256);
    const { sp } = mk();
    for (let i = 0; i < 256; i++) expect(sp.push(Buffer.from('\n'))).toEqual([]);
    expect(() => sp.push(Buffer.from('\n'))).toThrow('too many empty lines');
  });

  it('empty lines are counted wherever they sit: after a buffered partial line they still count, and a finished line is never mistaken for one', () => {
    const { sp } = mk();
    expect(sp.push(Buffer.from('{"type":"usage"'))).toEqual([]);
    expect(sp.push(Buffer.from('}\n')).map((l) => l.toString())).toEqual(['{"type":"usage"}']); // the buffered line ends: not empty
    for (let i = 0; i < 256; i++) sp.push(Buffer.from('\n'));
    expect(() => sp.push(Buffer.from('\n'))).toThrow('too many empty lines');
  });

  it('a line of only spaces is a line (the client counts it toward MAX_STREAM_LINES), not an empty one', () => {
    const { sp } = mk();
    const lines = sp.push(Buffer.from(' \n'.repeat(1000)));
    expect(lines).toHaveLength(1000);
  });

  it('without a dedicated callback the flood fails with the generic too-long error', () => {
    const sp = new LineSplitter(1000, () => new Error('too long'));
    expect(() => sp.push(Buffer.alloc(1024, 10))).toThrow('too long');
  });
});
