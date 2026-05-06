import { trimQuote, mergeMeta, EnrichedFieldMeta } from '../utils/enrichedFieldValue';

describe('trimQuote', () => {
  it('returns undefined for non-string input', () => {
    expect(trimQuote(undefined)).toBeUndefined();
    expect(trimQuote(null)).toBeUndefined();
  });

  it('returns undefined for empty / whitespace-only strings', () => {
    expect(trimQuote('')).toBeUndefined();
    expect(trimQuote('   \n  ')).toBeUndefined();
  });

  it('returns the trimmed quote when under the cap', () => {
    expect(trimQuote('  Series B startup  ')).toBe('Series B startup');
  });

  it('truncates with ellipsis when over 240 chars', () => {
    const long = 'a'.repeat(300);
    const out = trimQuote(long);
    expect(out!.length).toBe(241);          // 240 + 1 for ellipsis
    expect(out!.endsWith('…')).toBe(true);
  });
});

describe('mergeMeta', () => {
  it('builds a fresh meta with manual source when no base provided', () => {
    const out = mergeMeta(undefined, { source: 'web_search', confidence: 'high' });
    expect(out.source).toBe('web_search');
    expect(out.confidence).toBe('high');
    expect(out.enrichedAt).toEqual(expect.any(String));
  });

  it('overlays the patch on top of the base', () => {
    const base: EnrichedFieldMeta = {
      source: 'web_search',
      enrichedAt: '2026-01-01T00:00:00Z',
      confidence: 'low',
    };
    const out = mergeMeta(base, { confidence: 'high', sourceQuote: 'foo' });
    expect(out.confidence).toBe('high');
    expect(out.sourceQuote).toBe('foo');
    expect(out.source).toBe('web_search');
    expect(out.enrichedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('drops undefined keys from the patch (does not erase base values)', () => {
    const base: EnrichedFieldMeta = {
      source: 'web_search',
      enrichedAt: '2026-01-01T00:00:00Z',
      confidence: 'high',
      sourceQuote: 'kept',
    };
    const out = mergeMeta(base, { confidence: undefined, sourceQuote: undefined });
    expect(out.confidence).toBe('high');
    expect(out.sourceQuote).toBe('kept');
  });

  it('preserves verifiedBy and rejectedReason on overlay', () => {
    const base: EnrichedFieldMeta = {
      source: 'web_search',
      enrichedAt: '2026-01-01T00:00:00Z',
      verifiedBy: { userId: 'u1', at: '2026-02-01' },
    };
    const out = mergeMeta(base, { confidence: 'high' });
    expect(out.verifiedBy).toEqual({ userId: 'u1', at: '2026-02-01' });
  });
});
