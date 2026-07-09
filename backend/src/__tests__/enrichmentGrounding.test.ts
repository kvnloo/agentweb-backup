import {
  groundWebValue,
  companyNameMatches,
  extractNumericTokens,
} from '../utils/enrichmentGrounding';

/**
 * ENG-122: grounding must verify the *fact*, not the exact characters, and the
 * entity-identity gate must separate similarly-named-but-distinct companies
 * ("Slash" vs "Slashy") while tolerating formatting/suffix noise.
 */
describe('extractNumericTokens', () => {
  it('canonicalizes currency + scale words to the same token', () => {
    expect(extractNumericTokens('$100M')).toContain('100000000');
    expect(extractNumericTokens('$100 million')).toContain('100000000');
    expect(extractNumericTokens('100,000,000')).toContain('100000000');
    expect(extractNumericTokens('$100mm')).toContain('100000000');
  });

  it('handles billions and thousands', () => {
    expect(extractNumericTokens('$1.5B')).toContain('1500000000');
    expect(extractNumericTokens('$40M Series B')).toContain('40000000');
    expect(extractNumericTokens('500k ARR')).toContain('500000');
  });

  it('returns empty for non-numeric text', () => {
    expect(extractNumericTokens('Series C fintech company').size).toBe(0);
  });
});

describe('groundWebValue', () => {
  const SOURCE =
    'Slash is a fintech company for agencies. In 2023 Slash raised $100 million ' +
    'in a Series B round led by Accel. The company is headquartered in San Francisco.';

  it('grounds a figure despite formatting differences ($100M vs "$100 million")', () => {
    expect(groundWebValue('$100M', undefined, SOURCE)).toBe(true);
  });

  it('grounds a value whose quote is a verbatim substring of the source', () => {
    expect(groundWebValue('Series B', 'raised $100 million in a Series B round led by Accel', SOURCE)).toBe(true);
  });

  it('grounds a value via 5-word soft-match window when lightly rephrased', () => {
    // Quote drops "in" but keeps a 5-word run present in the source.
    expect(groundWebValue('Series B', 'raised $100 million in a Series B round led by', SOURCE)).toBe(true);
  });

  it('grounds a short firmographic value that appears verbatim in the source', () => {
    expect(groundWebValue('San Francisco', undefined, SOURCE)).toBe(true);
  });

  // ── The quote must support the VALUE, not merely exist in the source ────────
  // Live bug: Facebook's funding_stage came back "Grant (prize money)" stamped
  // grounding=grounded / confidence=high. Its quote was real and verbatim in the
  // source — but it was the quote for *total_funding* and says nothing about a
  // grant. The quote rule only checked quote ⊆ source, never value ⊆ quote, so a
  // genuine quote laundered an unsupported answer into a "verified" badge.
  const FB_SOURCE =
    'Facebook has raised a total of $2.27B over 21 funding rounds: 3 Seed, ' +
    '2 Early-Stage, 12 Late-Stage, 1 Grant (prize money).';

  it('does NOT ground a value whose real quote does not support it (the Grant/prize-money bug)', () => {
    expect(
      groundWebValue(
        'Grant (prize money)',
        'Facebook has raised a total of $2.27B over 21 funding rounds',
        FB_SOURCE,
      ),
    ).toBe(false);
  });

  it('still grounds a value its quote genuinely contains', () => {
    expect(
      groundWebValue('Series B', 'raised $100 million in a Series B round', SOURCE),
    ).toBe(true);
  });

  it('still grounds a figure via the numeric rule even with a terse quote', () => {
    expect(groundWebValue('$2.27B', 'Facebook has raised a total of $2.27B', FB_SOURCE)).toBe(true);
  });

  it('does NOT ground when the cited quote is itself absent from the source, even if the value appears there', () => {
    // The model's own evidence is fabricated, so the value is unverified — it
    // falls to "web-unverified" (kept + badged), not "grounded".
    expect(groundWebValue('San Francisco', 'Slash is based out of SoMa district', SOURCE)).toBe(false);
  });

  it('does NOT ground a fabricated figure that is not in the source', () => {
    // The classic ENG-122 fabrication: value + a plausible but invented quote.
    expect(groundWebValue('$100M', undefined, 'Acme makes widgets. No funding disclosed.')).toBe(false);
    expect(
      groundWebValue('Series C', 'Slash raised a $250M Series C', SOURCE),
    ).toBe(false); // quote text not present in source, and no shared numbers
  });

  it('does NOT ground against an empty source', () => {
    expect(groundWebValue('Series B', 'anything', '')).toBe(false);
  });
});

describe('companyNameMatches', () => {
  it('rejects similarly-named but distinct companies (the Slash/Slashy bug)', () => {
    expect(companyNameMatches('Slash', 'Slashy')).toBe(false);
    expect(companyNameMatches('Stripe', 'Stripes')).toBe(false);
  });

  it('matches the same company across case, punctuation, and legal suffixes', () => {
    expect(companyNameMatches('Slash', 'Slash, Inc.')).toBe(true);
    expect(companyNameMatches('slash inc', 'Slash')).toBe(true);
    expect(companyNameMatches('Acme Corp', 'Acme Corporation')).toBe(true);
  });

  it('matches when one name adds a descriptive token', () => {
    expect(companyNameMatches('Slash', 'Slash Labs')).toBe(true);
  });

  it('fails the gate when the claimed company is missing (anti-Slashy guard)', () => {
    expect(companyNameMatches('Slash', undefined)).toBe(false);
    expect(companyNameMatches('Slash', '')).toBe(false);
    expect(companyNameMatches(undefined, 'Slash')).toBe(false);
  });
});
