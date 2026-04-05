import { extractVariables, parseTemplateArray } from '../utils/templateParser';

describe('extractVariables', () => {
  describe('basic variable extraction', () => {
    it('returns empty arrays for content with no placeholders', () => {
      const result = extractVariables('<h1>Hello World</h1>');
      expect(result.variables).toEqual([]);
      expect(result.arrayVariables).toEqual([]);
    });

    it('extracts a single regular variable', () => {
      const result = extractVariables('<h1>{{title}}</h1>');
      expect(result.variables).toContain('title');
      expect(result.arrayVariables).toEqual([]);
    });

    it('extracts multiple regular variables', () => {
      const result = extractVariables('<h1>{{title}}</h1><p>{{body}}</p><a>{{cta}}</a>');
      expect(result.variables).toEqual(expect.arrayContaining(['title', 'body', 'cta']));
      expect(result.arrayVariables).toEqual([]);
    });

    it('deduplicates repeated variables', () => {
      const result = extractVariables('{{title}} - {{title}} - {{title}}');
      expect(result.variables.filter(v => v === 'title')).toHaveLength(1);
    });

    it('trims whitespace inside placeholders', () => {
      const result = extractVariables('{{  title  }}');
      expect(result.variables).toContain('title');
    });
  });

  describe('subject extraction', () => {
    it('extracts variables from subject when provided', () => {
      const result = extractVariables('<p>{{body}}</p>', 'Hello {{first_name}}');
      expect(result.variables).toContain('body');
      expect(result.variables).toContain('first_name');
    });

    it('ignores subject extraction when subject is undefined', () => {
      const result = extractVariables('<p>{{body}}</p>', undefined);
      expect(result.variables).toEqual(['body']);
    });

    it('does not duplicate variables that appear in both html and subject', () => {
      const result = extractVariables('{{title}}', '{{title}}');
      expect(result.variables.filter(v => v === 'title')).toHaveLength(1);
    });

    it('extracts subject-only variables after parsing a longer html string', () => {
      const result = extractVariables('{{title}}{{body}}{{cta}}{{footer}}', 'Hello {{first_name}}');
      expect(result.variables).toContain('first_name');
    });
  });

  describe('array variable detection', () => {
    it('identifies _n placeholders as array variables', () => {
      const result = extractVariables('{{features_n}}');
      expect(result.arrayVariables).toContain('features_n');
      expect(result.variables).not.toContain('features_n');
    });

    it('identifies numeric instances (features_1, features_2) paired with _n pattern', () => {
      // Template that has both the _n placeholder AND numeric instances
      const result = extractVariables('{{features_n}} {{features_1}} {{features_2}}');
      expect(result.arrayVariables).toContain('features_n');
      // Numeric instances should NOT appear as regular variables
      expect(result.variables).not.toContain('features_1');
      expect(result.variables).not.toContain('features_2');
    });

    it('identifies _n_suffix pattern as array variable', () => {
      const result = extractVariables('{{results_n_title}} {{results_1_title}}');
      expect(result.arrayVariables).toContain('results_n_title');
      expect(result.variables).not.toContain('results_n_title');
      expect(result.variables).not.toContain('results_1_title');
    });

    it('separates regular and array variables correctly in a mixed template', () => {
      const html = '<h1>{{company_name}}</h1><ul>{{features_n}}<li>{{features_1}}</li></ul>';
      const result = extractVariables(html);
      expect(result.variables).toContain('company_name');
      expect(result.arrayVariables).toContain('features_n');
      expect(result.variables).not.toContain('features_n');
      expect(result.variables).not.toContain('features_1');
    });

    it('handles multiple independent array variable groups', () => {
      const html = '{{benefits_n}} {{benefits_1}} {{steps_n}} {{steps_1}} {{title}}';
      const result = extractVariables(html);
      expect(result.arrayVariables).toContain('benefits_n');
      expect(result.arrayVariables).toContain('steps_n');
      expect(result.variables).toContain('title');
      expect(result.variables).not.toContain('benefits_1');
      expect(result.variables).not.toContain('steps_1');
    });

    it('does not mark plain numbered variables (without _n) as array variables', () => {
      // e.g. {{option1}} — no _n counterpart present
      const result = extractVariables('{{option1}} {{option2}}');
      expect(result.variables).toContain('option1');
      expect(result.variables).toContain('option2');
      expect(result.arrayVariables).toEqual([]);
    });
  });
});

describe('parseTemplateArray', () => {
  it('returns empty array when setting is null', () => {
    expect(parseTemplateArray(null)).toEqual([]);
  });

  it('returns empty array when setting is undefined', () => {
    expect(parseTemplateArray(undefined)).toEqual([]);
  });

  it('returns empty array when settingValue is missing', () => {
    expect(parseTemplateArray({})).toEqual([]);
  });

  it('parses a valid JSON array from settingValue', () => {
    const setting = {
      settingValue: JSON.stringify([
        { template_name: 'foo', html_content: '<p>hi</p>' }
      ])
    };
    const result = parseTemplateArray(setting);
    expect(result).toHaveLength(1);
    expect(result[0].template_name).toBe('foo');
  });

  it('returns empty array when settingValue is a JSON object (not array)', () => {
    const setting = { settingValue: JSON.stringify({ template_name: 'foo' }) };
    expect(parseTemplateArray(setting)).toEqual([]);
  });

  it('returns empty array and does not throw on invalid JSON', () => {
    const setting = { settingValue: 'not-valid-json' };
    expect(() => parseTemplateArray(setting)).not.toThrow();
    expect(parseTemplateArray(setting)).toEqual([]);
  });

  it('returns empty array when settingValue is an empty string', () => {
    expect(parseTemplateArray({ settingValue: '' })).toEqual([]);
  });

  it('handles an empty JSON array', () => {
    const setting = { settingValue: '[]' };
    expect(parseTemplateArray(setting)).toEqual([]);
  });

  it('preserves all fields from each template entry', () => {
    const templates = [
      { template_name: 'a', type: ['email'], html_content: '<p/>', variables: ['x'], arrayVariables: [] },
      { template_name: 'b', type: ['landing_page'], html_content: '<div/>', variables: [], arrayVariables: ['items_n'] },
    ];
    const result = parseTemplateArray({ settingValue: JSON.stringify(templates) });
    expect(result).toHaveLength(2);
    expect(result[1].arrayVariables).toContain('items_n');
  });
});
