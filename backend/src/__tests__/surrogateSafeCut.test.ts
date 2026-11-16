import { cutWithoutSplittingPair, truncateToolContent } from '../utils/surrogateSafeCut';

const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe('ENG-2643 surrogate-safe cuts', () => {
  it('drops the high half when the cut lands inside an emoji', () => {
    const text = 'a'.repeat(4) + '\u{1F600}' + 'tail';
    expect(cutWithoutSplittingPair(text, 5)).toBe('aaaa');
    expect(cutWithoutSplittingPair(text, 6)).toBe('aaaa\u{1F600}');
  });

  it('knowledge-base tool content cut inside an emoji at 5000 keeps no lone half and is marked', () => {
    const content = 'x'.repeat(4999) + '\u{1F680}' + 'y'.repeat(100);
    const out = truncateToolContent(content);
    expect(hasLoneSurrogate(out)).toBe(false);
    expect(out).toBe('x'.repeat(4999) + '\n\n[Content truncated]');
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
  });

  it('leaves short content untouched', () => {
    expect(truncateToolContent('hi \u{1F600}')).toBe('hi \u{1F600}');
  });
});
