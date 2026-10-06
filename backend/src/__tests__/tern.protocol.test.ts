import {
  encodeHelloQuery,
  encodeTspJson,
  parseTspJson,
  splitUtf8,
  TspStreamReader,
} from '../tern/protocol';

describe('Tern protocol transport', () => {
  it('encodes the v1 hello with native editor features', () => {
    const hello = encodeHelloQuery();
    expect(hello).toContain('tsp;q;');
    expect(hello).toContain('agentweb-emma');
    expect(hello).toContain('edit');
    expect(hello).toContain('send');
  });

  it('splits UTF-8 without breaking surrogate pairs', () => {
    expect(splitUtf8('🙂🙂', 4)).toEqual(['🙂', '🙂']);
  });

  it('never starts a continuation chunk with a parameter-shaped segment', () => {
    const pieces = splitUtf8('xxxxfoo=bar;zz', 4);
    expect(pieces.join('')).toBe('xxxxfoo=bar;zz');
    for (const piece of pieces.slice(1)) {
      expect(piece).not.toMatch(/^[A-Za-z0-9_-]+=[\x21-\x3a\x3c-\x7e]*;/);
    }
  });

  it('preserves raw key bytes around TSP events', () => {
    const reader = new TspStreamReader();
    const event = encodeTspJson('e', {
      ev: 'select',
      sf: 'agentweb-emma',
      id: 'session-picker',
      item: 's2',
    });
    const parts = reader.pushParts(`abc${event}\x1b[B`);
    expect(parts[0]).toEqual({ type: 'raw', data: 'abc' });
    expect(parts[1]?.type).toBe('message');
    expect(parts[2]).toEqual({ type: 'raw', data: '\x1b[B' });
  });

  it('holds a split TSP prefix instead of leaking it as keyboard input', () => {
    const reader = new TspStreamReader();
    expect(reader.pushParts('x\x1b_ts')).toEqual([{ type: 'raw', data: 'x' }]);
    const rest = reader.pushParts('p;e;{"ev":"focus","sf":"agentweb-emma","id":"composer"}\x1b\\');
    expect(rest).toHaveLength(1);
    expect(rest[0]?.type).toBe('message');
  });

  it('reassembles chunked TSP messages across arbitrary PTY reads', () => {
    const encoded = encodeTspJson(
      'e',
      { ev: 'send', sf: 'agentweb-emma', id: 'composer', text: 'hello 🙂 world' },
      undefined,
      12,
    );
    const reader = new TspStreamReader();
    const cut = Math.floor(encoded.length / 2);
    expect(reader.push(encoded.slice(0, cut))).toEqual([]);
    const messages = reader.push(encoded.slice(cut));
    expect(messages).toHaveLength(1);
    expect(parseTspJson(messages[0])).toMatchObject({
      ev: 'send',
      id: 'composer',
      text: 'hello 🙂 world',
    });
  });
});
