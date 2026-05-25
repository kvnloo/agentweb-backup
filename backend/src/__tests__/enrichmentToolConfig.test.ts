import {
  buildRawEnrichmentConfig,
  getEmmaEnrichMaxLeads,
} from '../emma/enrichmentToolConfig';

describe('buildRawEnrichmentConfig', () => {
  it('throws when output_fields is empty', () => {
    expect(() => buildRawEnrichmentConfig([], 'user-1')).toThrow(/non-empty/);
  });

  it('throws when a field is missing a name', () => {
    expect(() =>
      buildRawEnrichmentConfig([{ name: '', instruction: 'find it' } as any], 'user-1'),
    ).toThrow(/name is required/);
  });

  it('throws when a field is missing an instruction', () => {
    expect(() =>
      buildRawEnrichmentConfig([{ name: 'industry', instruction: '' } as any], 'user-1'),
    ).toThrow(/instruction is required/);
  });

  it('maps a single field with default overwrite policy', () => {
    const cfg = buildRawEnrichmentConfig(
      [{ name: 'industry', instruction: 'classify their industry' }],
      'user-7',
    );
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.globalOverwriteDefault).toBe('fill_if_empty');
    expect(cfg.updatedBy).toBe('user-7');
    expect(cfg.fields).toHaveLength(1);
    expect(cfg.fields[0]).toMatchObject({
      name: 'industry',
      type: 'string',
      instruction: 'classify their industry',
      include: true,
      overwritePolicy: 'fill_if_empty',
    });
  });

  it('honors an explicit always_overwrite policy per field', () => {
    const cfg = buildRawEnrichmentConfig(
      [
        { name: 'a', instruction: 'x', overwrite_policy: 'always_overwrite' },
        { name: 'b', instruction: 'y' },
      ],
      'user-1',
    );
    expect(cfg.fields[0].overwritePolicy).toBe('always_overwrite');
    expect(cfg.fields[1].overwritePolicy).toBe('fill_if_empty');
  });

  it('trims whitespace from name and instruction', () => {
    const cfg = buildRawEnrichmentConfig(
      [{ name: '  industry  ', instruction: '  find it  ' }],
      'user-1',
    );
    expect(cfg.fields[0].name).toBe('industry');
    expect(cfg.fields[0].instruction).toBe('find it');
  });

  it('throws when field name is not a string (non-string type coerced to empty)', () => {
    // Exercises the `typeof f?.name === 'string' ? ... : ''` false branch (line 32)
    expect(() =>
      buildRawEnrichmentConfig([{ name: 123 as any, instruction: 'find it' }], 'user-1'),
    ).toThrow(/name is required/);
  });

  it('throws when field instruction is not a string (non-string type coerced to empty)', () => {
    // Exercises the `typeof f?.instruction === 'string' ? ... : ''` false branch (line 33)
    expect(() =>
      buildRawEnrichmentConfig([{ name: 'industry', instruction: null as any }], 'user-1'),
    ).toThrow(/instruction is required/);
  });

  it('throws when a field item itself is null (optional-chaining null path)', () => {
    // Exercises the `f?.name` optional-chaining null branch (line 32-33)
    expect(() =>
      buildRawEnrichmentConfig([null as any], 'user-1'),
    ).toThrow(/name is required/);
  });
});

describe('getEmmaEnrichMaxLeads', () => {
  const original = process.env.EMMA_ENRICH_MAX_LEADS;
  afterEach(() => {
    if (original === undefined) delete process.env.EMMA_ENRICH_MAX_LEADS;
    else process.env.EMMA_ENRICH_MAX_LEADS = original;
  });

  it('defaults to 500 when the env var is unset', () => {
    delete process.env.EMMA_ENRICH_MAX_LEADS;
    expect(getEmmaEnrichMaxLeads()).toBe(500);
  });

  it('reads a positive integer from the env var', () => {
    process.env.EMMA_ENRICH_MAX_LEADS = '25';
    expect(getEmmaEnrichMaxLeads()).toBe(25);
  });

  it('falls back to 500 for a non-numeric or non-positive value', () => {
    process.env.EMMA_ENRICH_MAX_LEADS = 'abc';
    expect(getEmmaEnrichMaxLeads()).toBe(500);
    process.env.EMMA_ENRICH_MAX_LEADS = '0';
    expect(getEmmaEnrichMaxLeads()).toBe(500);
  });
});
