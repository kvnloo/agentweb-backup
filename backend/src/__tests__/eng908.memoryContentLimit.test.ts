/**
 * ENG-908 / ENG-1298 / ENG-831 — three separately-reported tickets, one cause.
 *
 * The old rejection said only "Content must be 2000 characters or less" — the limit the
 * schema had already declared, and nothing the caller could act on. With no actual length
 * and no instruction, the agent re-sent the identical payload and looped. ENG-908 measured
 * it as the most repeated tool-level defect in its window; ENG-831 watched it fail three
 * times consecutively on one run.
 *
 * These pin the message, because here the message IS the fix. A guard that rejects
 * correctly and explains uselessly is the bug.
 */
import {
  assertMemoryContentWithinLimit,
  memoryContentLength,
  MEMORY_CONTENT_MAX_CHARS,
} from '../utils/memoryContentLimit';

const over = (n: number) => 'x'.repeat(MEMORY_CONTENT_MAX_CHARS + n);

describe('ENG-908 the over-length error has to be actionable', () => {
  it('accepts content exactly at the limit', () => {
    expect(() => assertMemoryContentWithinLimit('x'.repeat(MEMORY_CONTENT_MAX_CHARS))).not.toThrow();
  });

  it('accepts empty and short content — this guard is only about length', () => {
    expect(() => assertMemoryContentWithinLimit('')).not.toThrow();
    expect(() => assertMemoryContentWithinLimit('a short fact')).not.toThrow();
  });

  it('rejects one character over', () => {
    expect(() => assertMemoryContentWithinLimit(over(1))).toThrow();
  });

  it('reports the ACTUAL length, which is what the old message withheld', () => {
    // ENG-831's first complaint verbatim: "The error does not report the ACTUAL character
    // count of the submitted content."
    expect(() => assertMemoryContentWithinLimit(over(347)))
      .toThrow(new RegExp(`${MEMORY_CONTENT_MAX_CHARS + 347} characters`));
  });

  it('reports how far over the limit it is, so the caller can cut exactly that much', () => {
    expect(() => assertMemoryContentWithinLimit(over(347))).toThrow(/347 over the limit/);
  });

  it('tells the caller NOT to retry the same text', () => {
    // The whole failure mode: the agent retried identical content because nothing said
    // the retry was hopeless.
    expect(() => assertMemoryContentWithinLimit(over(10))).toThrow(/Do NOT retry the same text/i);
  });

  it('names the two ways out — shorten, or split across several memories', () => {
    expect(() => assertMemoryContentWithinLimit(over(10))).toThrow(/shorten/i);
    expect(() => assertMemoryContentWithinLimit(over(10))).toThrow(/split it into multiple memories/i);
  });

  it('still names the limit itself', () => {
    expect(() => assertMemoryContentWithinLimit(over(10)))
      .toThrow(new RegExp(`${MEMORY_CONTENT_MAX_CHARS} characters or less`));
  });

  it('names the field the caller actually passed', () => {
    expect(() => assertMemoryContentWithinLimit(over(5), 'org memory'))
      .toThrow(/this org memory is/);
  });

  describe('counts code points, not UTF-16 units (ENG-821)', () => {
    it('treats an astral character as one, matching the declared maxLength', () => {
      // '🙂' is two UTF-16 code units. Counting units would reject at ~1000 emoji, which
      // would contradict the schema's own maxLength: 2000 and reject content the cap
      // permits.
      const emoji = '🙂'.repeat(MEMORY_CONTENT_MAX_CHARS);
      expect(memoryContentLength(emoji)).toBe(MEMORY_CONTENT_MAX_CHARS);
      expect(() => assertMemoryContentWithinLimit(emoji)).not.toThrow();
    });

    it('quotes back the same unit it enforces', () => {
      // A number the caller cannot reconcile with its own content is worse than none.
      const emoji = '🙂'.repeat(MEMORY_CONTENT_MAX_CHARS + 12);
      expect(() => assertMemoryContentWithinLimit(emoji))
        .toThrow(new RegExp(`${MEMORY_CONTENT_MAX_CHARS + 12} characters`));
    });
  });
});
