import {
  EnrichmentInputError,
  MAX_INSTRUCTION_CHARS,
  MAX_OUTPUT_FIELDS,
  validateFieldName,
  validateGoal,
  validateInstruction,
  validateOptionalTemplate,
  validateOutputFields,
  validateSources,
  validateSourcesPerField,
} from '../utils/enrichmentValidation';

describe('validateFieldName', () => {
  it('accepts simple snake_case names', () => {
    expect(validateFieldName('web_company_info')).toBe('web_company_info');
    expect(validateFieldName('CamelCase')).toBe('CamelCase');
  });

  it('trims whitespace before validating', () => {
    expect(validateFieldName('  funding_round  ')).toBe('funding_round');
  });

  it('rejects reserved names', () => {
    for (const name of ['email', 'enrichmentMetadata', '__proto__', 'constructor', 'customFields']) {
      expect(() => validateFieldName(name)).toThrow(EnrichmentInputError);
    }
  });

  it('rejects names with disallowed characters', () => {
    expect(() => validateFieldName('foo-bar')).toThrow(/must match/);
    expect(() => validateFieldName('foo bar')).toThrow();
    expect(() => validateFieldName('foo.bar')).toThrow();
    expect(() => validateFieldName('foo[bar]')).toThrow();
    expect(() => validateFieldName('1foo')).toThrow();
  });

  it('rejects empty / non-string / oversized', () => {
    expect(() => validateFieldName('')).toThrow();
    expect(() => validateFieldName(null)).toThrow();
    expect(() => validateFieldName(123 as any)).toThrow();
    expect(() => validateFieldName('a'.repeat(65))).toThrow(/exceeds/);
  });
});

describe('validateOutputFields', () => {
  it('rejects non-arrays and empty arrays', () => {
    expect(() => validateOutputFields(undefined)).toThrow();
    expect(() => validateOutputFields([])).toThrow();
    expect(() => validateOutputFields('foo' as any)).toThrow();
  });

  it('caps array length at MAX_OUTPUT_FIELDS', () => {
    const tooMany = Array.from({ length: MAX_OUTPUT_FIELDS + 1 }, (_, i) => `field_${i}`);
    expect(() => validateOutputFields(tooMany)).toThrow(/exceeds max/);
  });

  it('rejects when any element is invalid', () => {
    expect(() => validateOutputFields(['ok_field', 'email'])).toThrow();
    expect(() => validateOutputFields(['ok_field', '__proto__'])).toThrow();
  });

  it('dedups while preserving order', () => {
    expect(validateOutputFields(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('accepts a typical valid payload', () => {
    expect(validateOutputFields(['web_company_info', 'funding_round'])).toEqual([
      'web_company_info',
      'funding_round',
    ]);
  });
});

describe('validateInstruction', () => {
  it('falls back when missing or blank', () => {
    expect(validateInstruction(undefined, 'fallback')).toBe('fallback');
    expect(validateInstruction(null, 'fallback')).toBe('fallback');
    expect(validateInstruction('   ', 'fallback')).toBe('fallback');
  });

  it('rejects non-string', () => {
    expect(() => validateInstruction(42 as any, 'fallback')).toThrow();
  });

  it('rejects oversized strings', () => {
    expect(() => validateInstruction('x'.repeat(MAX_INSTRUCTION_CHARS + 1), 'fb')).toThrow(/exceeds/);
  });

  it('trims and returns valid input', () => {
    expect(validateInstruction('  hello  ', 'fb')).toBe('hello');
  });
});

describe('validateOptionalTemplate', () => {
  it('returns undefined when missing or blank', () => {
    expect(validateOptionalTemplate(undefined, 'webSearchTemplate')).toBeUndefined();
    expect(validateOptionalTemplate('', 'webSearchTemplate')).toBeUndefined();
    expect(validateOptionalTemplate('   ', 'webSearchTemplate')).toBeUndefined();
  });

  it('rejects oversized strings', () => {
    expect(() => validateOptionalTemplate('x'.repeat(1001), 'webSearchTemplate')).toThrow(/exceeds/);
  });
});

describe('validateSources', () => {
  it('falls back when missing/empty', () => {
    expect(validateSources(undefined)).toEqual(['web_search']);
    expect(validateSources([])).toEqual(['web_search']);
  });

  it('rejects unknown source values', () => {
    expect(() => validateSources(['email_ping'])).toThrow(/invalid value/);
  });

  it('passes recognized values and dedups', () => {
    expect(validateSources(['web_search', 'linkedin', 'web_search'])).toEqual([
      'web_search',
      'linkedin',
    ]);
  });
});

describe('validateSourcesPerField', () => {
  it('returns undefined when missing', () => {
    expect(validateSourcesPerField(undefined)).toBeUndefined();
    expect(validateSourcesPerField(null)).toBeUndefined();
  });

  it('rejects arrays / primitives', () => {
    expect(() => validateSourcesPerField(['x'])).toThrow();
    expect(() => validateSourcesPerField('foo')).toThrow();
  });

  it('validates each key and value', () => {
    const out = validateSourcesPerField({
      web_company_info: ['web_search'],
      funding_round: ['linkedin'],
    });
    expect(out).toEqual({
      web_company_info: ['web_search'],
      funding_round: ['linkedin'],
    });
  });

  it('silently drops reserved/invalid key names', () => {
    // sourcesPerField is auxiliary — extra/stale keys (e.g. a saved config
    // referencing `phone` from a prior session) shouldn't 400 the request.
    // Hard validation lives on outputFields. Reserved keys are dropped, and
    // crucially never assigned (so __proto__ can't pollute).
    const out = validateSourcesPerField({
      email: ['web_search'],
      phone: ['web_search'],
      good_field: ['web_search'],
    });
    expect(out).toEqual({ good_field: ['web_search'] });

    const proto = JSON.parse('{"__proto__": ["web_search"], "ok": ["web_search"]}');
    const protoOut = validateSourcesPerField(proto)!;
    expect(protoOut).toEqual({ ok: ['web_search'] });
    // Sanity: prototype unchanged
    expect(({} as any).__proto__).toBe(Object.prototype);
  });
});

describe('validateGoal', () => {
  it('rejects empty / non-string', () => {
    expect(() => validateGoal('')).toThrow();
    expect(() => validateGoal('   ')).toThrow();
    expect(() => validateGoal(null)).toThrow();
    expect(() => validateGoal(42 as any)).toThrow();
  });

  it('rejects oversized strings', () => {
    expect(() => validateGoal('x'.repeat(2001))).toThrow(/exceeds/);
  });

  it('accepts and trims a valid goal', () => {
    expect(validateGoal('  enrich techstack  ')).toBe('enrich techstack');
  });
});
