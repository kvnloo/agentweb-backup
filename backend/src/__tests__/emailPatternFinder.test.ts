import {
  generateEmailPatterns,
  findEmailViaPatterns,
} from '../services/emailPatternFinder';
import type { ValidateResult } from '../services/enrichSoService';

function vr(opts: Partial<ValidateResult>): ValidateResult {
  return {
    status: 'unknown',
    confidence: 'low',
    isCatchAll: false,
    fromCache: false,
    checkedAt: '2026-05-07T00:00:00Z',
    ...opts,
  };
}

describe('generateEmailPatterns', () => {
  it('emits 10 patterns when both first and last name are present', () => {
    const p = generateEmailPatterns('John', 'Doe', 'acme.com');
    expect(p.length).toBe(10);
    expect(p[0]).toBe('john.doe@acme.com');     // most common pattern first
    expect(p).toContain('jdoe@acme.com');
    expect(p).toContain('johndoe@acme.com');
    expect(p).toContain('john_doe@acme.com');
    expect(p).toContain('doej@acme.com');
  });

  it('strips non-alphanumerics from names', () => {
    const p = generateEmailPatterns("D'Angelo", 'O Brien', 'acme.com');
    expect(p[0]).toBe('dangelo.obrien@acme.com');
  });

  it('folds diacritics to ASCII (NFKD) — "Müller" → "muller", not "mller"', () => {
    expect(generateEmailPatterns('Müller', 'Schmidt', 'acme.com')[0]).toBe('muller.schmidt@acme.com');
    expect(generateEmailPatterns('José', 'García', 'acme.com')[0]).toBe('jose.garcia@acme.com');
    // Ž decomposes via NFKD; ę does too. (Ł and other precomposed letters
    // without a canonical decomposition still drop — explicit translit table
    // would be needed; out of scope for this fix.)
    expect(generateEmailPatterns('Žilina', 'Pęcki', 'acme.com')[0]).toBe('zilina.pecki@acme.com');
  });

  it('strips scheme/www/path from domain', () => {
    const p = generateEmailPatterns('a', 'b', 'https://www.acme.com/contact');
    expect(p[0]).toBe('a.b@acme.com');
  });

  it('emits a single pattern when only one name is present', () => {
    expect(generateEmailPatterns('john', '', 'acme.com')).toEqual(['john@acme.com']);
    expect(generateEmailPatterns('', 'doe', 'acme.com')).toEqual(['doe@acme.com']);
  });

  it('returns empty when domain or names insufficient', () => {
    expect(generateEmailPatterns('john', 'doe', 'localhost')).toEqual([]);
    expect(generateEmailPatterns('', '', 'acme.com')).toEqual([]);
    expect(generateEmailPatterns('john', 'doe', '')).toEqual([]);
  });
});

describe('findEmailViaPatterns', () => {
  it('returns first deliverable match and stops', async () => {
    const seen: string[] = [];
    const validate = jest.fn(async (email: string) => {
      seen.push(email);
      // First two patterns undeliverable, 3rd deliverable.
      if (seen.length === 3) return vr({ status: 'deliverable', confidence: 'high' });
      return vr({ status: 'undeliverable', confidence: 'high' });
    });
    const r = await findEmailViaPatterns('John', 'Doe', 'acme.com', { validate });
    expect(r.found).toBe(true);
    expect(r.email).toBe(seen[2]);
    expect(r.attempts).toBe(3);
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it('aborts on catchall — every pattern would fake-pass otherwise', async () => {
    const validate = jest.fn(async () => vr({ status: 'deliverable', isCatchAll: true }));
    const r = await findEmailViaPatterns('John', 'Doe', 'acme.com', { validate });
    expect(r.found).toBe(false);
    expect(r.catchall).toBe(true);
    expect(r.attempts).toBe(1);    // bailed after first call
  });

  it('returns highest-confidence risky as fallback when no deliverable found', async () => {
    let i = 0;
    const validate = jest.fn(async () => {
      i++;
      if (i === 4) return vr({ status: 'risky', confidence: 'medium' });
      return vr({ status: 'undeliverable' });
    });
    const r = await findEmailViaPatterns('John', 'Doe', 'acme.com', { validate });
    expect(r.found).toBe(true);
    expect(r.status).toBe('risky');
  });

  it('returns not-found when every pattern is undeliverable', async () => {
    const validate = jest.fn(async () => vr({ status: 'undeliverable' }));
    const r = await findEmailViaPatterns('John', 'Doe', 'acme.com', { validate });
    expect(r.found).toBe(false);
    expect(r.attempts).toBe(10);
  });

  it('respects maxAttempts cap', async () => {
    const validate = jest.fn(async () => vr({ status: 'undeliverable' }));
    const r = await findEmailViaPatterns('John', 'Doe', 'acme.com', { validate, maxAttempts: 3 });
    expect(r.attempts).toBe(3);
    expect(validate).toHaveBeenCalledTimes(3);
  });

  it('skips transiently-failing patterns and continues', async () => {
    let i = 0;
    const validate = jest.fn(async () => {
      i++;
      if (i === 2) throw new Error('transient');
      if (i === 3) return vr({ status: 'deliverable', confidence: 'high' });
      return vr({ status: 'undeliverable' });
    });
    const r = await findEmailViaPatterns('John', 'Doe', 'acme.com', { validate });
    expect(r.found).toBe(true);
    expect(r.attempts).toBe(3);
  });

  it('returns empty when no patterns can be generated', async () => {
    const validate = jest.fn();
    const r = await findEmailViaPatterns('', '', 'acme.com', { validate });
    expect(r.found).toBe(false);
    expect(r.attempts).toBe(0);
    expect(validate).not.toHaveBeenCalled();
  });
});
