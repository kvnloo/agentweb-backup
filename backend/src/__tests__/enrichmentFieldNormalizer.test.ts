// Tests for enrichmentFieldNormalizer — field name synonym/alias normalization
// TDD: these tests are written before the implementation exists.

import { normalizeOutputFields } from '../emma/enrichmentFieldNormalizer';
import type { EmmaEnrichmentOutputField } from '../emma/enrichmentToolConfig';

function field(name: string, instruction = 'some instruction', overwrite_policy?: 'fill_if_empty' | 'always_overwrite'): EmmaEnrichmentOutputField {
  return overwrite_policy ? { name, instruction, overwrite_policy } : { name, instruction };
}

describe('normalizeOutputFields — standard column synonyms', () => {
  it('maps company_name → company (reason: standard_column)', () => {
    const { fields, remaps } = normalizeOutputFields([field('company_name', 'the company')], []);
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('company');
    expect(fields[0].instruction).toBe('the company');
    expect(remaps).toHaveLength(1);
    expect(remaps[0]).toEqual({ from: 'company_name', to: 'company', reason: 'standard_column' });
  });

  it('maps job_title → title (reason: standard_column)', () => {
    const { fields, remaps } = normalizeOutputFields([field('job_title')], []);
    expect(fields[0].name).toBe('title');
    expect(remaps[0]).toMatchObject({ from: 'job_title', to: 'title', reason: 'standard_column' });
  });

  it('maps linkedin_url → linkedin (reason: standard_column)', () => {
    const { fields, remaps } = normalizeOutputFields([field('linkedin_url')], []);
    expect(fields[0].name).toBe('linkedin');
    expect(remaps[0]).toMatchObject({ from: 'linkedin_url', to: 'linkedin', reason: 'standard_column' });
  });

  it('leaves a field already named company unchanged with no remap', () => {
    const { fields, remaps } = normalizeOutputFields([field('company')], []);
    expect(fields[0].name).toBe('company');
    expect(remaps).toHaveLength(0);
  });

  it('leaves a genuinely custom field like funding_stage unchanged with no remap', () => {
    const { fields, remaps } = normalizeOutputFields([field('funding_stage')], []);
    expect(fields[0].name).toBe('funding_stage');
    expect(remaps).toHaveLength(0);
  });

  it('preserves instruction and overwrite_policy across a standard remap', () => {
    const { fields } = normalizeOutputFields(
      [field('company_name', 'find the company name', 'always_overwrite')],
      [],
    );
    expect(fields[0].name).toBe('company');
    expect(fields[0].instruction).toBe('find the company name');
    expect(fields[0].overwrite_policy).toBe('always_overwrite');
  });

  it('maps organization → company', () => {
    const { fields, remaps } = normalizeOutputFields([field('organization')], []);
    expect(fields[0].name).toBe('company');
    expect(remaps[0]).toMatchObject({ from: 'organization', to: 'company', reason: 'standard_column' });
  });

  it('maps work_email → email', () => {
    const { fields, remaps } = normalizeOutputFields([field('work_email')], []);
    expect(fields[0].name).toBe('email');
    expect(remaps[0]).toMatchObject({ from: 'work_email', to: 'email', reason: 'standard_column' });
  });

  it('maps first_name → firstName', () => {
    const { fields, remaps } = normalizeOutputFields([field('first_name')], []);
    expect(fields[0].name).toBe('firstName');
    expect(remaps[0]).toMatchObject({ from: 'first_name', to: 'firstName', reason: 'standard_column' });
  });

  it('maps last_name → lastName', () => {
    const { fields, remaps } = normalizeOutputFields([field('last_name')], []);
    expect(fields[0].name).toBe('lastName');
    expect(remaps[0]).toMatchObject({ from: 'last_name', to: 'lastName', reason: 'standard_column' });
  });
});

describe('normalizeOutputFields — standard column not remapped onto custom field', () => {
  it('keeps a field already named "company" even when the list has a custom company_name field', () => {
    const result = normalizeOutputFields(
      [field('company', 'the company')],
      ['company_name', 'funding_stage'],
    );
    expect(result.fields[0].name).toBe('company');
    expect(result.remaps).toHaveLength(0);
  });
});

describe('normalizeOutputFields — existing custom field match', () => {
  it('maps funding_round onto existing custom field funding_stage (reason: existing_custom_field)', () => {
    // funding_round → canonicalFieldName = 'funding_stage'
    // existing 'funding_stage' → canonicalFieldName = 'funding_stage'
    // They match → remap requested 'funding_round' to existing 'funding_stage'
    const { fields, remaps } = normalizeOutputFields(
      [field('funding_round', 'what funding round are they on')],
      ['funding_stage'],
    );
    expect(fields[0].name).toBe('funding_stage');
    expect(remaps).toHaveLength(1);
    expect(remaps[0]).toEqual({
      from: 'funding_round',
      to: 'funding_stage',
      reason: 'existing_custom_field',
    });
  });

  it('preserves instruction across existing-custom remap', () => {
    const { fields } = normalizeOutputFields(
      [field('funding_round', 'series A or B?', 'fill_if_empty')],
      ['funding_stage'],
    );
    expect(fields[0].instruction).toBe('series A or B?');
    expect(fields[0].overwrite_policy).toBe('fill_if_empty');
  });

  it('does not remap a field when no existing custom field matches the canonical', () => {
    // 'funding_round' canonical = 'funding_stage', but list has no 'funding_stage'
    const { fields, remaps } = normalizeOutputFields(
      [field('funding_round')],
      ['revenue', 'employee_count'],
    );
    // 'revenue' is a standard column synonym, not a custom field to remap onto
    expect(fields[0].name).toBe('funding_round');
    expect(remaps).toHaveLength(0);
  });

  it('does not match against standard columns when looking for existing custom fields', () => {
    // Ensure we don't treat 'company' (a standard column) as an existing custom match
    const { fields, remaps } = normalizeOutputFields(
      [field('organization')],
      ['company', 'funding_stage'],
    );
    // 'organization' is a synonym for 'company' via STANDARD_FIELD_SYNONYMS → standard_column remap
    expect(fields[0].name).toBe('company');
    expect(remaps[0].reason).toBe('standard_column');
  });
});

describe('normalizeOutputFields — post-dedup', () => {
  it('keeps only the first when two requested fields normalize to the same name', () => {
    // 'company' is already correct; 'company_name' maps → company too
    const { fields, remaps } = normalizeOutputFields(
      [field('company', 'instr-a'), field('company_name', 'instr-b')],
      [],
    );
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('company');
    expect(fields[0].instruction).toBe('instr-a');
    // remap for company_name → company should be present (the synonym remap)
    // but no extra remap for the drop (just omit the duplicate)
    expect(remaps.some(r => r.from === 'company_name' && r.to === 'company')).toBe(true);
  });

  it('deduplicates when both names are synonyms resolving to the same standard column', () => {
    // 'organization' and 'company_name' both → 'company'
    const { fields, remaps } = normalizeOutputFields(
      [field('organization', 'org-a'), field('company_name', 'org-b')],
      [],
    );
    expect(fields).toHaveLength(1);
    expect(fields[0].name).toBe('company');
    expect(fields[0].instruction).toBe('org-a'); // first wins
    expect(remaps.length).toBeGreaterThanOrEqual(1);
  });
});

describe('normalizeOutputFields — edge cases', () => {
  it('returns empty arrays for empty input', () => {
    const { fields, remaps } = normalizeOutputFields([], []);
    expect(fields).toEqual([]);
    expect(remaps).toEqual([]);
  });

  it('handles multiple fields, remapping some and leaving others unchanged', () => {
    const { fields, remaps } = normalizeOutputFields(
      [
        field('company_name'),
        field('funding_stage'),
        field('linkedin_url'),
      ],
      [],
    );
    expect(fields.map(f => f.name)).toEqual(['company', 'funding_stage', 'linkedin']);
    expect(remaps).toHaveLength(2);
    expect(remaps.map(r => r.from)).toContain('company_name');
    expect(remaps.map(r => r.from)).toContain('linkedin_url');
  });
});
