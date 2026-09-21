import { deriveDominanceLegacyIds, type DominanceCandidate } from '../services/agentModeService';

// Pure-function unit tests for deriveDominanceLegacyIds — the real-registry
// integration behavior (GPT-5.4 Nano vs GPT-5.6 Luna, and the Sonnet/Opus
// false-positive guard) is covered in agentModeService.sonnet45.test.ts.
describe('deriveDominanceLegacyIds', () => {
  function candidate(overrides: Partial<DominanceCandidate> & Pick<DominanceCandidate, 'id'>): DominanceCandidate {
    return { tier: 'medium', legacy: false, ...overrides };
  }

  it('flags a model dominated by a same-family sibling: same tier, strictly higher quality', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'weak', family: 'x', tier: 'ultra_cheap', qualityScore: 40 }),
      candidate({ id: 'strong', family: 'x', tier: 'ultra_cheap', qualityScore: 52 }),
    ]);
    expect(result.has('weak')).toBe(true);
    expect(result.has('strong')).toBe(false);
  });

  it('flags a model dominated by a cheaper same-family sibling: same quality, strictly cheaper tier', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'expensive', family: 'x', tier: 'pro', qualityScore: 60 }),
      candidate({ id: 'cheaper', family: 'x', tier: 'medium', qualityScore: 60 }),
    ]);
    expect(result.has('expensive')).toBe(true);
  });

  it('does NOT flag a tie (identical tier and quality) — dominance requires strict improvement in at least one dimension', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'a', family: 'x', tier: 'medium', qualityScore: 50 }),
      candidate({ id: 'b', family: 'x', tier: 'medium', qualityScore: 50 }),
    ]);
    expect(result.size).toBe(0);
  });

  it('does NOT flag a model that is cheaper but also worse — that is a real tradeoff, not dominance', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'cheap-and-weak', family: 'x', tier: 'ultra_cheap', qualityScore: 20 }),
      candidate({ id: 'expensive-and-strong', family: 'x', tier: 'ultra_premium', qualityScore: 90 }),
    ]);
    expect(result.size).toBe(0);
  });

  it('never compares across different `family` values, even at identical tier/quality gaps', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'sonnet', family: 'claude-sonnet', tier: 'pro', qualityScore: 55 }),
      candidate({ id: 'opus', family: 'claude-opus', tier: 'pro', qualityScore: 90 }),
    ]);
    expect(result.size).toBe(0);
  });

  it('never uses an already-legacy sibling as a dominator', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'candidate', family: 'x', tier: 'medium', qualityScore: 40 }),
      candidate({ id: 'legacy-but-better', family: 'x', tier: 'medium', qualityScore: 80, legacy: true }),
    ]);
    expect(result.size).toBe(0);
  });

  it('ignores a model with no `family` tag entirely — never auto-dominated or used as a dominator', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'no-family-weak', tier: 'ultra_cheap', qualityScore: 10 }),
      candidate({ id: 'no-family-strong', tier: 'ultra_cheap', qualityScore: 99 }),
    ]);
    expect(result.size).toBe(0);
  });

  it('ignores a candidate with no qualityScore — cannot prove dominance without a real quality number', () => {
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'unscored', family: 'x', tier: 'ultra_cheap' }),
      candidate({ id: 'scored', family: 'x', tier: 'ultra_cheap', qualityScore: 90 }),
    ]);
    expect(result.size).toBe(0);
  });

  it('chains transitively: a model dominated by an already-dominated sibling is still flagged', () => {
    // c beats b beats a — a is dominated by b even though b is itself
    // beaten by c; b's ORIGINAL (not recomputed) legacy flag is what counts.
    const result = deriveDominanceLegacyIds([
      candidate({ id: 'a', family: 'x', tier: 'ultra_cheap', qualityScore: 10 }),
      candidate({ id: 'b', family: 'x', tier: 'ultra_cheap', qualityScore: 40 }),
      candidate({ id: 'c', family: 'x', tier: 'ultra_cheap', qualityScore: 90 }),
    ]);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
    expect(result.has('c')).toBe(false);
  });
});
