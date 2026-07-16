import {
  trimQuote,
  mergeMeta,
  fieldVerificationStatus,
  fieldProvenanceBadge,
  EnrichedFieldMeta,
} from '../utils/enrichedFieldValue';

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

describe('fieldVerificationStatus', () => {
  const at = '2026-01-01T00:00:00Z';

  it('treats absent meta as unverified', () => {
    expect(fieldVerificationStatus(undefined)).toBe('unverified');
  });

  // ── The Slashy bug: web-sourced funding_stage gets confidence 'medium' ──
  it('treats a web-search medium-confidence field (the Slashy funding_stage case) as unverified', () => {
    const meta: EnrichedFieldMeta = {
      source: 'web_search',
      provider: 'llm_web_search',
      confidence: 'medium',
      enrichedAt: at,
    };
    expect(fieldVerificationStatus(meta)).toBe('unverified');
  });

  it('treats low confidence as unverified', () => {
    expect(fieldVerificationStatus({ source: 'api', confidence: 'low', enrichedAt: at })).toBe('unverified');
  });

  it('treats missing confidence as unverified', () => {
    expect(fieldVerificationStatus({ source: 'api', enrichedAt: at })).toBe('unverified');
  });

  it('treats high confidence (e.g. Apollo funding_stage) as verified', () => {
    const meta: EnrichedFieldMeta = {
      source: 'api',
      provider: 'apollo',
      confidence: 'high',
      enrichedAt: at,
    };
    expect(fieldVerificationStatus(meta)).toBe('verified');
  });

  // ── User actions take precedence over confidence/critic ──
  it('treats a user-verified field as verified even when confidence is medium', () => {
    const meta: EnrichedFieldMeta = {
      source: 'web_search',
      confidence: 'medium',
      enrichedAt: at,
      verifiedBy: { userId: 'u1', at },
    };
    expect(fieldVerificationStatus(meta)).toBe('verified');
  });

  it('treats a user-rejected field as unverified even when confidence is high', () => {
    const meta: EnrichedFieldMeta = {
      source: 'api',
      confidence: 'high',
      enrichedAt: at,
      rejectedReason: 'wrong stage',
      rejectedAt: at,
    };
    expect(fieldVerificationStatus(meta)).toBe('unverified');
  });

  // ── Critic verdict (web tier) takes precedence over raw confidence ──
  it('treats a critic-supported (criticView high) field as verified despite medium confidence', () => {
    const meta: EnrichedFieldMeta = {
      source: 'web_search',
      confidence: 'medium',
      criticView: 'high',
      criticVerdict: 'supported',
      enrichedAt: at,
    };
    expect(fieldVerificationStatus(meta)).toBe('verified');
  });

  it('treats a critic-flagged (criticView low) field as unverified', () => {
    const meta: EnrichedFieldMeta = {
      source: 'web_search',
      confidence: 'medium',
      criticView: 'low',
      criticVerdict: 'unsupported',
      enrichedAt: at,
    };
    expect(fieldVerificationStatus(meta)).toBe('unverified');
  });

  it('treats a critic-contradicted (criticView drop) field as unverified', () => {
    const meta: EnrichedFieldMeta = {
      source: 'web_search',
      confidence: 'medium',
      criticView: 'drop',
      criticVerdict: 'contradicted',
      enrichedAt: at,
    };
    expect(fieldVerificationStatus(meta)).toBe('unverified');
  });

  // ENG-122 grounding classification
  it('treats a grounded web value as verified', () => {
    expect(fieldVerificationStatus({ source: 'web_search', grounding: 'grounded', enrichedAt: at })).toBe('verified');
  });

  it('treats web-unverified and ai-knowledge as unverified even if confidence somehow says high', () => {
    expect(fieldVerificationStatus({ source: 'web_search', grounding: 'web-unverified', confidence: 'high', enrichedAt: at })).toBe('unverified');
    expect(fieldVerificationStatus({ source: 'web_search', grounding: 'ai-knowledge', confidence: 'high', enrichedAt: at })).toBe('unverified');
  });

  it('lets critic caution downgrade a grounded value (possible wrong entity)', () => {
    expect(fieldVerificationStatus({ source: 'web_search', grounding: 'grounded', criticView: 'low', enrichedAt: at })).toBe('unverified');
  });
});

describe('fieldProvenanceBadge', () => {
  const at = '2026-07-01T00:00:00.000Z';
  it('returns null for a verified (grounded) value', () => {
    expect(fieldProvenanceBadge({ source: 'web_search', grounding: 'grounded', enrichedAt: at })).toBeNull();
  });
  it('returns the ai-knowledge badge for a training-memory value', () => {
    expect(fieldProvenanceBadge({ source: 'web_search', grounding: 'ai-knowledge', enrichedAt: at })).toBe('ai-knowledge');
  });
  it('returns the web-unverified badge for an unmatched web value', () => {
    expect(fieldProvenanceBadge({ source: 'web_search', grounding: 'web-unverified', enrichedAt: at })).toBe('web-unverified');
  });
  it('falls back to the web badge for legacy web-sourced unverified values', () => {
    expect(fieldProvenanceBadge({ source: 'web_search', confidence: 'low', enrichedAt: at })).toBe('web-unverified');
  });
  it('returns null when there is no meta', () => {
    expect(fieldProvenanceBadge(undefined)).toBeNull();
  });
});
