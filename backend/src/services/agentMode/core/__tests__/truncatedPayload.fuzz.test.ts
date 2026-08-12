/**
 * Property test for `sealTruncatedPayload` (ENG-1054).
 *
 * Every large tool response in agent mode flows through this function, so a throw
 * here would break tool dispatch for all providers, and an unparseable result would
 * reinstate the exact defect it exists to prevent — handing the model an open JSON
 * structure to complete.
 *
 * Example-based tests missed two real bugs that this caught:
 *   - deep nesting (`{"deep":{"n":{"n":`) rewound onto a dangling key that no set of
 *     closers can make valid, exhausting the retries and emitting the raw slice;
 *   - a boundary at index 0 (`{"a":`) hit the `cut <= 0` guard and bailed out before
 *     the outermost container could be closed empty.
 *
 * The PRNG is seeded so any future failure reproduces exactly.
 */

import { sealTruncatedPayload, TRUNCATION_NOTICE } from '../truncatedPayload';

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const CORPUS = [
  '{"success":true,"ads":[{"id":"120248669405960585","name":"P3 A1 – Lo-fi","picture":"https://s3.example.com/a.png","live":false}]}',
  '{"knowledge_bases":[{"identifier":"x","files":[{"fileName":"a.txt","fileSize":220,"url":null}]}]}',
  '[{"a":1},{"b":[1,2,3]},{"c":{"d":"e, f: g"}}]',
  '{"escaped":"say \\"hi\\" {not a brace}","n":[1,2]}',
  '{"unicode":"café ünïcode 日本語","emoji":"✅🎉","x":[{"y":"z"}]}',
  'Plain prose with no JSON at all, just words and punctuation: a, b; c.',
  '{"deep":' + '{"n":'.repeat(40) + '1' + '}'.repeat(40) + '}',
  '', '{', '[', '{"a":', '{"a":1,',
];

describe('sealTruncatedPayload — property tests (ENG-1054)', () => {
  it('never throws and never emits unparseable JSON, across 20k random cuts', () => {
    let sealed = 0;
    let passthrough = 0;
    for (let i = 0; i < 20_000; i++) {
      const src = CORPUS[Math.floor(rnd() * CORPUS.length)];
      const slice = src.slice(0, Math.floor(rnd() * (src.length + 1)));

      const out = sealTruncatedPayload(slice);
      expect(typeof out).toBe('string');
      expect(out).toContain(TRUNCATION_NOTICE);

      const body = out.slice(0, out.indexOf(TRUNCATION_NOTICE)).trim();
      const head = body.trimStart()[0];
      if (head !== '{' && head !== '[') { passthrough++; continue; }
      // Throws with the offending slice in the message if this ever regresses.
      expect(() => JSON.parse(body)).not.toThrow();
      sealed++;
    }
    expect(sealed).toBeGreaterThan(10_000);
    expect(passthrough).toBeGreaterThan(0);
  });

  it('closes the outermost container when the cut leaves only a dangling key', () => {
    for (const slice of ['{"a":', '{"deep":{"n":{"n":', '[{"a":']) {
      const out = sealTruncatedPayload(slice);
      const body = out.slice(0, out.indexOf(TRUNCATION_NOTICE)).trim();
      expect(() => JSON.parse(body)).not.toThrow();
    }
  });

  it('stays cheap enough for the hot path', () => {
    const big = `{"success":true,"ads":[${'{"id":"120248664084720585","picture":"https://s3.example.com/aaaaaaaaaaaaaaaaaaaa.png"},'.repeat(300)}]}`;
    const slice = big.slice(0, 20_000);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) sealTruncatedPayload(slice);
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 100;
    expect(perCallMs).toBeLessThan(25);
  });
});

describe('sealTruncatedPayload — fail-safe wrapper (ENG-1054)', () => {
  const NOISY = jest.spyOn(console, 'error').mockImplementation(() => {});
  afterAll(() => NOISY.mockRestore());

  it('falls back to the unsealed slice instead of throwing into tool dispatch', () => {
    // A String subclass whose trimStart explodes — stands in for any unforeseen
    // input that could make the pure path throw once it is live on the hot path.
    const hostile: any = new String('{"a":1');
    hostile.trimStart = () => { throw new Error('boom'); };
    hostile.trim = () => { throw new Error('boom'); };

    const out = sealTruncatedPayload(hostile as unknown as string);
    expect(out).toContain(TRUNCATION_NOTICE);
    expect(NOISY).toHaveBeenCalled();
  });
});
