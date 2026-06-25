// Crunchbase specialist parser tests — pure-function tests on snippet shapes.

import {
  parseFundingRound,
  parseTotalFunding,
  parseHqCity,
  buildCrunchbaseSourceContext,
  clearCrunchbaseCache,
  crunchbaseFundingRound,
  crunchbaseTotalFunding,
  crunchbaseHqCity,
  getCrunchbaseSnippets,
  _crunchbaseCacheSize,
} from '../services/specialists/crunchbaseSpecialist';

const mockSearchWeb = jest.fn();
jest.mock('../services/agentModeService', () => ({
  agentModeService: { youSearchWeb: (...a: any[]) => mockSearchWeb(...a) },
}));

const cbSnippet = (overrides: Partial<{ title: string; url: string; snippet: string }> = {}) => ({
  title: 'Stripe - Crunchbase Company Profile & Funding',
  url: 'https://www.crunchbase.com/organization/stripe',
  snippet: 'Stripe • San Francisco, California, US • Last Funding Series I',
  ...overrides,
});

beforeEach(() => {
  mockSearchWeb.mockReset();
  clearCrunchbaseCache();
});

// ── parseFundingRound ────────────────────────────────────────────────────────

describe('parseFundingRound', () => {
  it('extracts Series A from "raised a $5M Series A"', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'Acme raised a $5M Series A in 2024' })]);
    expect(r?.value).toBe('Series A');
    expect(r?.confidence).toBe('high');
    expect(r?.source).toBe('web_search');
  });

  it('extracts Series B', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'closed Series B funding round' })]);
    expect(r?.value).toBe('Series B');
  });

  it('extracts Series C', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'Brex - Last Funding Series C' })]);
    expect(r?.value).toBe('Series C');
  });

  it('classifies Series D as Series D+', () => {
    const r = parseFundingRound([cbSnippet({ snippet: '$300M Series D-2 round' })]);
    expect(r?.value).toBe('Series D+');
  });

  it('classifies Series E/F/G... as Series D+', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'Series F growth round' })]);
    expect(r?.value).toBe('Series D+');
  });

  it('extracts Seed', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'pre-launch • Seed funding round in 2023' })]);
    expect(r?.value).toBe('Seed');
  });

  it('extracts Pre-seed', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'pre-seed round of $500K' })]);
    expect(r?.value).toBe('Pre-seed');
  });

  it('extracts Public for IPO/listed companies', () => {
    const r = parseFundingRound([cbSnippet({ title: 'NVIDIA - NASDAQ: NVDA', snippet: 'publicly listed company' })]);
    expect(r?.value).toBe('Public');
  });

  it('extracts Acquired when text says "acquired by"', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'AcmeCo was acquired by BigCorp in Q4 2024' })]);
    expect(r?.value).toBe('Acquired');
  });

  it('returns null on snippets with no funding signal', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'A startup based in San Francisco' })]);
    expect(r).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseFundingRound([])).toBeNull();
  });

  it('attaches sourceUrl from the matching snippet', () => {
    const r = parseFundingRound([cbSnippet({ url: 'https://www.crunchbase.com/organization/acme', snippet: 'Series A' })]);
    expect(r?.sourceUrl).toBe('https://www.crunchbase.com/organization/acme');
  });

  it('attaches a non-empty sourceQuote that contains the matched span', () => {
    const r = parseFundingRound([cbSnippet({ snippet: 'In 2024 the company raised a Series A round of $7M' })]);
    expect(r?.sourceQuote).toMatch(/series a/i);
  });
});

// ── parseTotalFunding ────────────────────────────────────────────────────────

describe('parseTotalFunding', () => {
  it.each([
    ['raised $50M total',          50_000_000],
    ['$1.2B in funding',           1_200_000_000],
    ['$300K seed round',           300_000],
    ['$5 million Series A',        5_000_000],
    ['has raised $2.5 billion',    2_500_000_000],
  ])('parses %s -> %s', (snippet, expected) => {
    const r = parseTotalFunding([cbSnippet({ snippet })]);
    expect(r?.value).toBe(String(expected));
  });

  it('uses medium confidence (snippet may show last round, not total)', () => {
    const r = parseTotalFunding([cbSnippet({ snippet: 'raised $50M in last round' })]);
    expect(r?.confidence).toBe('medium');
  });

  it('returns null when no dollar amount is present', () => {
    const r = parseTotalFunding([cbSnippet({ snippet: 'an early-stage startup' })]);
    expect(r).toBeNull();
  });
});

// ── parseHqCity ──────────────────────────────────────────────────────────────

describe('parseHqCity', () => {
  it('extracts HQ city from "Stripe - San Francisco, California, US"', () => {
    const r = parseHqCity([cbSnippet({ title: 'Stripe - San Francisco, California, US' })]);
    expect(r?.value).toBe('San Francisco');
  });

  it('handles "Headquartered in Palo Alto"', () => {
    const r = parseHqCity([cbSnippet({ snippet: 'Headquartered in Palo Alto, California' })]);
    expect(r?.value).toBe('Palo Alto');
  });

  it('handles "Based in Mountain View"', () => {
    const r = parseHqCity([cbSnippet({ snippet: 'Based in Mountain View, California' })]);
    expect(r?.value).toBe('Mountain View');
  });

  it('returns null when no recognized HQ pattern', () => {
    const r = parseHqCity([cbSnippet({ title: 'Acme', snippet: 'A startup company' })]);
    expect(r).toBeNull();
  });

  it('confidence is high when matched', () => {
    const r = parseHqCity([cbSnippet({ title: 'Acme - Palo Alto, California, US' })]);
    expect(r?.confidence).toBe('high');
  });
});

// ── buildCrunchbaseSourceContext ────────────────────────────────────────────

describe('buildCrunchbaseSourceContext', () => {
  it('joins multiple snippets into one context string with title + snippet + url per entry', () => {
    const ctx = buildCrunchbaseSourceContext([
      cbSnippet({ title: 'A - Crunchbase', snippet: 'a snippet', url: 'https://www.crunchbase.com/organization/a' }),
      cbSnippet({ title: 'B - Crunchbase', snippet: 'b snippet', url: 'https://www.crunchbase.com/organization/b' }),
    ]);
    expect(ctx).toContain('A - Crunchbase');
    expect(ctx).toContain('a snippet');
    expect(ctx).toContain('B - Crunchbase');
    expect(ctx).toContain('b snippet');
  });

  it('returns empty string for no snippets', () => {
    expect(buildCrunchbaseSourceContext([])).toBe('');
  });
});

// ── End-to-end: specialist resolves via mocked You.com search ───────────────

describe('crunchbase specialist (end-to-end with mocked SERP)', () => {
  it('resolves funding_round when Crunchbase returns a Series B snippet', async () => {
    mockSearchWeb.mockResolvedValueOnce({
      success: true,
      results: [{ title: 'Acme - Crunchbase', url: 'https://www.crunchbase.com/organization/acme', snippet: 'closed a $40M Series B' }],
    });
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: 'Acme', email: 'jane@acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('Series B');
  });

  it('resolves null when no SERP result mentions the company name (precision filter)', async () => {
    // Returns a story about a different company — should NOT match
    mockSearchWeb.mockResolvedValueOnce({
      success: true,
      results: [{ title: 'Stripe raises Series I', url: 'https://example.com/stripe', snippet: 'Stripe raised $6.5B Series I' }],
    });
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: 'Acme', email: 'jane@acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
  });

  it('skips VC-named companies (Ventures/Capital/Partners) — would only return false positives', async () => {
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: 'Sapphire Ventures', email: 'jane@sapphireventures.com' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
    expect(mockSearchWeb).not.toHaveBeenCalled();  // skipped before search
  });

  it('skips mega-cap public companies whose names are common words (Target, NVIDIA)', async () => {
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: 'Target', email: 'jane@target.com' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });

  it('rejects matches where company is mentioned far from a funding verb (precision)', async () => {
    // "Acme Co" mentioned but unrelated to a funding event
    mockSearchWeb.mockResolvedValueOnce({
      success: true,
      results: [{
        title: 'Industry roundup: AI startups',
        url: 'https://example.com/roundup',
        snippet: 'Many companies including Acme Co are building AI tools. Separately, Brex closed a Series D.',
      }],
    });
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: 'Acme Co', email: 'jane@acme.com' } as any,
      { userId: 'u1' },
    );
    // Acme is mentioned, but the funding verb (closed) refers to Brex
    expect(r).toBeNull();
  });

  it('matches when company name is in title even on non-crunchbase URLs (e.g., press releases)', async () => {
    mockSearchWeb.mockResolvedValueOnce({
      success: true,
      results: [{
        title: 'Acme closes $40M Series B funding',
        url: 'https://prnewswire.com/news/acme-series-b',
        snippet: 'Acme today announced it has closed a $40M Series B round led by Accel.',
      }],
    });
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: 'Acme', email: 'jane@acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r?.value).toBe('Series B');
    expect(r?.sourceUrl).toContain('prnewswire.com');
  });

  it('caches: 3 specialists for the same company → 1 search', async () => {
    mockSearchWeb.mockResolvedValueOnce({
      success: true,
      results: [{
        title: 'Acme closes Series C - San Mateo, California, US',
        url: 'https://www.crunchbase.com/organization/acme',
        snippet: 'Acme today announced it raised a $25M Series C round',
      }],
    });
    const lead = { leadId: 'l1', company: 'Acme', email: 'jane@acme.com' } as any;
    const ctx = { userId: 'u1' };

    // Run all three specialists for the same lead
    const [f, t, h] = await Promise.all([
      crunchbaseFundingRound.resolve(lead, ctx),
      crunchbaseTotalFunding.resolve(lead, ctx),
      crunchbaseHqCity.resolve(lead, ctx),
    ]);

    expect(mockSearchWeb).toHaveBeenCalledTimes(1);
    expect(f?.value).toBe('Series C');
    expect(t?.value).toBe('25000000');
    expect(h?.value).toBe('San Mateo');
  });

  it('returns null when SERP fails (does not throw)', async () => {
    mockSearchWeb.mockRejectedValueOnce(new Error('rate limit'));
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: 'Acme', email: 'jane@acme.com' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
  });

  it('returns null when lead has no company and no email domain', async () => {
    const r = await crunchbaseFundingRound.resolve(
      { leadId: 'l1', company: '', email: '' } as any,
      { userId: 'u1' },
    );
    expect(r).toBeNull();
    expect(mockSearchWeb).not.toHaveBeenCalled();
  });
});

describe('crunchbase cache bounds (LRU)', () => {
  it('evicts oldest entries when more than 200 distinct keys are inserted', async () => {
    // Always-empty result so the cache simply records a Promise per key.
    mockSearchWeb.mockResolvedValue({ success: true, results: [] });
    for (let i = 0; i < 250; i++) {
      await getCrunchbaseSnippets({ leadId: `l${i}`, company: `Co${i}`, email: `u@d${i}.com` } as any);
    }
    // Cap is 200; size after 250 insertions should be at most 200.
    expect(_crunchbaseCacheSize()).toBeLessThanOrEqual(200);
  });
});
