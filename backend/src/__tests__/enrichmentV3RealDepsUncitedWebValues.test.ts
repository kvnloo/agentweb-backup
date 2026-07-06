import { classifyWebValues } from '../services/enrichmentV3RealDeps';
import type { LLMFilledValue } from '../services/enrichmentGroupWaterfall';

/**
 * ENG-122: V3 web-tier extraction must not surface fabricated funding /
 * firmographic figures AS FACT. classifyWebValues tags each value by how well
 * it grounds in the REAL fetched source and drops only wrong-entity values:
 *  - grounded (fact found in source)          → kept, verified
 *  - web-unverified (has URL, quote unmatched) → kept, "Web — unverified" badge
 *  - ai-knowledge (no source, company matches) → kept, "AI knowledge — unverified" badge
 *  - no source + company mismatch/unstated      → DROPPED (anti-fabrication)
 */
describe('classifyWebValues', () => {
  const fv = (value: string, extra?: Partial<LLMFilledValue>): LLMFilledValue => ({ value, ...extra });

  const SOURCE =
    'Slash is a fintech company for agencies. In 2023 Slash raised $100 million ' +
    'in a Series B round led by Accel.';

  it('marks a value found in the source as grounded (kept, trustworthy)', () => {
    const r = classifyWebValues(
      { funding_stage: fv('Series B', { sourceQuote: 'raised $100 million in a Series B round' }) },
      { source: SOURCE, leadCompany: 'Slash' },
    );
    expect(r.funding_stage?.grounding).toBe('grounded');
  });

  it('grounds a figure despite currency formatting differences ($100M vs "$100 million")', () => {
    const r = classifyWebValues(
      { total_funding: fv('$100M') },
      { source: SOURCE, leadCompany: 'Slash' },
    );
    expect(r.total_funding?.grounding).toBe('grounded');
  });

  it('tags a web-sourced value whose quote is unmatched as web-unverified (kept)', () => {
    const r = classifyWebValues(
      { arr: fv('$5M', { sourceUrl: 'https://news.example.com/slash', sourceQuote: 'not in our captured text' }) },
      { source: SOURCE, leadCompany: 'Slash' },
    );
    expect(r.arr?.grounding).toBe('web-unverified');
    expect(r.arr?.value).toBe('$5M');
  });

  it('keeps an unsourced training-memory value as ai-knowledge when the company matches', () => {
    const r = classifyWebValues(
      { funding_stage: fv('Series A') }, // no quote, no url → memory
      { source: SOURCE, leadCompany: 'Slash', claimedCompany: 'Slash, Inc.' },
    );
    expect(r.funding_stage?.grounding).toBe('ai-knowledge');
    expect(r.funding_stage?.value).toBe('Series A');
  });

  it('DROPS an unsourced value when the stated company is a different (Slashy) entity', () => {
    const r = classifyWebValues(
      { funding_stage: fv('Series C'), total_funding: fv('$250M') },
      { source: SOURCE, leadCompany: 'Slash', claimedCompany: 'Slashy' },
    );
    expect(r.funding_stage).toBeUndefined();
    expect(r.total_funding).toBeUndefined();
  });

  it('DROPS an unsourced value when no company was stated (anti-Slashy guard)', () => {
    const r = classifyWebValues(
      { funding_stage: fv('Series C') },
      { source: SOURCE, leadCompany: 'Slash' }, // claimedCompany undefined
    );
    expect(r.funding_stage).toBeUndefined();
  });

  it('does not let a fabricated quote alone make an unsourced value look grounded', () => {
    // Model invented both the value and a plausible quote, no URL, company matches
    // → kept but only as ai-knowledge (badged), never grounded/verified.
    const r = classifyWebValues(
      { funding_stage: fv('Series C', { sourceQuote: 'Slash raised a Series C round' }) },
      { source: SOURCE, leadCompany: 'Slash', claimedCompany: 'Slash' },
    );
    expect(r.funding_stage?.grounding).toBe('ai-knowledge');
    expect(r.funding_stage?.grounding).not.toBe('grounded');
  });

  it('DROPS a value that is grounded but in a WRONG-ENTITY source (Quill Meetings for a Quillwork AI lead)', () => {
    // The figure is genuinely in the source, but the source is about a different
    // company — must be dropped, not shown as grounded fact (ENG-122 AC#2).
    const source = 'Quill Meetings today announced $6.5 million in seed funding led by Foo.';
    const r = classifyWebValues(
      {
        funding_stage: fv('Seed', { sourceQuote: 'announced $6.5 million in seed funding' }),
        total_funding: fv('$6.5M', { sourceQuote: 'announced $6.5 million in seed funding' }),
      },
      { source, leadCompany: 'Quillwork AI', claimedCompany: 'Quill Meetings' },
    );
    expect(r.funding_stage).toBeUndefined();
    expect(r.total_funding).toBeUndefined();
  });

  it('keeps a grounded value when the claimed company matches the lead', () => {
    const r = classifyWebValues(
      { funding_stage: fv('Series B', { sourceQuote: 'raised $100 million in a Series B round' }) },
      { source: SOURCE, leadCompany: 'Slash', claimedCompany: 'Slash Financial' },
    );
    expect(r.funding_stage?.grounding).toBe('grounded');
  });

  it('does not over-drop a grounded value when no company was claimed', () => {
    const r = classifyWebValues(
      { funding_stage: fv('Series B', { sourceQuote: 'raised $100 million in a Series B round' }) },
      { source: SOURCE, leadCompany: 'Slash' }, // claimedCompany undefined
    );
    expect(r.funding_stage?.grounding).toBe('grounded');
  });

  it('exempts linkedin URL fields (verified separately, no grounding tag)', () => {
    const r = classifyWebValues(
      { linkedin_url: fv('https://www.linkedin.com/in/jane-doe') },
      { source: SOURCE, leadCompany: 'Slash' },
    );
    expect(r.linkedin_url?.value).toBe('https://www.linkedin.com/in/jane-doe');
    expect(r.linkedin_url?.grounding).toBeUndefined();
  });
});
