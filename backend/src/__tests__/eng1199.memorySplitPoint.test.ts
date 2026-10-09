/**
 * ENG-1199 — a scheduled run's save_memory handoff failed five times (2911 → 2046 chars)
 * trimming blind. The rejection must hand back a concrete split point that, used once,
 * produces a first part that fits.
 */
import {
  assertMemoryContentWithinLimit,
  memoryContentLength,
  MEMORY_CONTENT_MAX_CHARS,
  suggestMemorySplitPoint,
} from '../utils/memoryContentLimit';

const handoff = () => {
  const lines: string[] = ['HANDOFF list=abc123 account=xyz'];
  for (let i = 0; lines.join('\n').length < 2911; i++) {
    lines.push(`lead ${i}: id=L${i} li=public-${i} score=${i % 100} tier=A.`);
  }
  return lines.join('\n');
};

describe('ENG-1199 suggested split point', () => {
  it('returns full length for content within the cap', () => {
    expect(suggestMemorySplitPoint('short')).toBe(5);
  });

  it('splits an oversized handoff at a line boundary inside the cap', () => {
    const text = handoff();
    const split = suggestMemorySplitPoint(text);
    expect(split).toBeLessThanOrEqual(MEMORY_CONTENT_MAX_CHARS);
    expect(split).toBeGreaterThanOrEqual(MEMORY_CONTENT_MAX_CHARS / 2);
    expect(Array.from(text)[split - 1]).toBe('\n');
  });

  it('one retry using the hint succeeds: both parts fit (for <= 2x cap)', () => {
    const text = handoff();
    const split = suggestMemorySplitPoint(text);
    const chars = Array.from(text);
    const first = chars.slice(0, split).join('');
    const rest = chars.slice(split).join('');
    expect(() => assertMemoryContentWithinLimit(first)).not.toThrow();
    expect(() => assertMemoryContentWithinLimit(rest)).not.toThrow();
    expect(first + rest).toBe(text);
  });

  it('falls back to the hard cap for unbroken text', () => {
    expect(suggestMemorySplitPoint('x'.repeat(2500))).toBe(MEMORY_CONTENT_MAX_CHARS);
  });

  it('counts code points for astral characters', () => {
    const text = '🙂'.repeat(MEMORY_CONTENT_MAX_CHARS + 50);
    const split = suggestMemorySplitPoint(text);
    expect(split).toBe(MEMORY_CONTENT_MAX_CHARS);
    expect(memoryContentLength(Array.from(text).slice(0, split).join(''))).toBe(split);
  });

  it('honours a custom max', () => {
    expect(suggestMemorySplitPoint('aaaa bbbb cccc dddd', 12)).toBe(9);
  });

  it('the rejection message carries the split point and remainder', () => {
    const text = handoff();
    const split = suggestMemorySplitPoint(text);
    const len = memoryContentLength(text);
    expect(() => assertMemoryContentWithinLimit(text))
      .toThrow(new RegExp(`Suggested split point: character ${split}.*remaining ${len - split}`));
  });
});
