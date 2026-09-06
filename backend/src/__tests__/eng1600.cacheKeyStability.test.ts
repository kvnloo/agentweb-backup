import { createHash } from 'crypto';
import { buildDataAnalysisCacheKey } from '../services/agentMode/csvProvenance';

/**
 * The separator in this cache key was written as a LITERAL NUL byte in the source. That single
 * byte made git classify the file as binary, so GitHub rendered no patch for it and automated
 * review could not see changes inside it at all — on `agentModeService.ts`, a 36k-line file.
 *
 * It is now written as the `\u0000` escape: the same character at runtime, but the file stays
 * text and stays reviewable.
 *
 * This test exists because that substitution MUST be bit-identical. The key is a cache key —
 * if the hash changes, every stored entry silently misses and the cross-call consistency check
 * that ENG-1295 built stops firing, with no error anywhere.
 */
describe('ENG-1600 buildDataAnalysisCacheKey separator', () => {
  const USER = 'user-123';
  const URLS = ['https://example.com/a.csv', 'https://example.com/b.csv'];
  const INSTRUCTION = 'group by ad group and sum spend';

  /** What the original literal-NUL source produced, reconstructed independently. */
  const expectedHash = createHash('sha256')
    .update(JSON.stringify(URLS) + String.fromCharCode(0) + INSTRUCTION)
    .digest('hex');

  it('produces exactly the hash the literal-NUL version produced', () => {
    expect(buildDataAnalysisCacheKey(USER, URLS, INSTRUCTION)).toBe(`${USER}:${expectedHash}`);
  });

  it('still separates the fields — a url/instruction boundary shift changes the key', () => {
    // The separator's whole job: `['ab'] + 'c'` must not collide with `['a'] + 'bc'`.
    const a = buildDataAnalysisCacheKey(USER, ['ab'], 'c');
    const b = buildDataAnalysisCacheKey(USER, ['a'], 'bc');
    expect(a).not.toBe(b);
  });

  it('is stable across calls and scoped per user', () => {
    expect(buildDataAnalysisCacheKey(USER, URLS, INSTRUCTION))
      .toBe(buildDataAnalysisCacheKey(USER, URLS, INSTRUCTION));
    expect(buildDataAnalysisCacheKey('other-user', URLS, INSTRUCTION))
      .not.toBe(buildDataAnalysisCacheKey(USER, URLS, INSTRUCTION));
  });
});
