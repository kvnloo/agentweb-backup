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
