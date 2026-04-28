import { substituteVariables, extractVariables, leadHasVariable, injectUnsubscribeUrl } from '../utils/emailVariables';

describe('substituteVariables', () => {
  // FAIL cases
  it('should return template unchanged when no variables present', () => {
    const template = '<p>Hello world</p>';
    const lead = { firstName: 'John', lastName: 'Doe', email: 'john@test.com' };
    expect(substituteVariables(template, lead)).toBe('<p>Hello world</p>');
  });

  it('should leave unknown variables as-is', () => {
    const template = 'Hello {{unknownField}}';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('Hello {{unknownField}}');
  });

  it('should handle empty template', () => {
    const template = '';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('');
  });

  it('should handle lead with missing fields gracefully', () => {
    const template = 'Hello {{firstName}} {{lastName}} at {{company}}';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('Hello John  at ');
  });

  // SUCCESS cases
  it('should substitute all standard lead fields', () => {
    const template = '{{firstName}} {{lastName}} ({{email}}) - {{company}}, {{title}}';
    const lead = {
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@acme.com',
      company: 'Acme Corp',
      title: 'VP of Engineering',
    };
    expect(substituteVariables(template, lead)).toBe(
      'Jane Smith (jane@acme.com) - Acme Corp, VP of Engineering'
    );
  });

  it('should substitute custom fields', () => {
    const template = 'Your plan: {{customFields.plan}}, region: {{customFields.region}}';
    const lead = {
      customFields: { plan: 'Enterprise', region: 'US-West' },
    };
    expect(substituteVariables(template, lead)).toBe(
      'Your plan: Enterprise, region: US-West'
    );
  });

  it('should handle missing custom field gracefully', () => {
    const template = 'Plan: {{customFields.missing}}';
    const lead = { customFields: { other: 'value' } };
    expect(substituteVariables(template, lead)).toBe('Plan: ');
  });

  it('should handle lead with no customFields object', () => {
    const template = 'Plan: {{customFields.plan}}';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('Plan: ');
  });

  it('should substitute multiple occurrences of the same variable', () => {
    const template = '{{firstName}} - Dear {{firstName}}';
    const lead = { firstName: 'Alice' };
    expect(substituteVariables(template, lead)).toBe('Alice - Dear Alice');
  });
});

describe('extractVariables', () => {
  it('should extract standard and custom field variables', () => {
    const template = 'Hi {{firstName}}, your company {{company}} plan: {{customFields.plan}}';
    expect(extractVariables(template)).toEqual(['firstName', 'company', 'customFields.plan']);
  });

  it('should ignore {{unsubscribeUrl}}', () => {
    const template = '{{firstName}} <a href="{{unsubscribeUrl}}">unsub</a>';
    expect(extractVariables(template)).toEqual(['firstName']);
  });

  it('should deduplicate repeated variables', () => {
    const template = '{{firstName}} and again {{firstName}}';
    expect(extractVariables(template)).toEqual(['firstName']);
  });

  it('should return empty array for empty template', () => {
    expect(extractVariables('')).toEqual([]);
  });
});

describe('leadHasVariable', () => {
  it('should return true for present standard field', () => {
    expect(leadHasVariable({ firstName: 'John' }, 'firstName')).toBe(true);
  });

  it('should return false for missing standard field', () => {
    expect(leadHasVariable({}, 'firstName')).toBe(false);
  });

  it('should return false for empty string value', () => {
    expect(leadHasVariable({ firstName: '' }, 'firstName')).toBe(false);
  });

  it('should return true for present custom field', () => {
    expect(leadHasVariable({ customFields: { plan: 'Pro' } }, 'customFields.plan')).toBe(true);
  });

  it('should return false for missing custom field', () => {
    expect(leadHasVariable({ customFields: {} }, 'customFields.plan')).toBe(false);
  });

  it('should return false when customFields object is missing', () => {
    expect(leadHasVariable({}, 'customFields.plan')).toBe(false);
  });
});

describe('injectUnsubscribeUrl', () => {
  const url = 'https://example.com/unsubscribe?id=123';

  // FAIL cases (edge inputs)
  it('should return empty string unchanged', () => {
    expect(injectUnsubscribeUrl('', url)).toBe('');
  });

  it('should handle html with no body tag and no unsubscribe anchor by appending footer at end', () => {
    const html = '<p>Hello</p>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(url);
    expect(result).toContain('Unsubscribe');
  });

  // Step 1: {{unsubscribeUrl}} replacement
  it('should replace {{unsubscribeUrl}} variable in place', () => {
    const html = '<a href="{{unsubscribeUrl}}">Unsubscribe</a>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toBe(`<a href="${url}">Unsubscribe</a>`);
  });

  it('should replace multiple {{unsubscribeUrl}} occurrences', () => {
    const html = '{{unsubscribeUrl}} and again {{unsubscribeUrl}}';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toBe(`${url} and again ${url}`);
  });

  // Step 2: update existing unsubscribe anchor href
  it('should update existing unsubscribe anchor href="#" to real URL', () => {
    const html = '<body><a href="#">Unsubscribe</a></body>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(`href="${url}"`);
    expect(result).not.toContain('href="#"');
  });

  it('should update unsubscribe anchor in full HTML document preserving structure', () => {
    const html = '<!DOCTYPE html><html><head><style>body{color:red}</style></head><body><a href="#">Unsubscribe</a></body></html>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(`href="${url}"`);
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('body{color:red}');
  });

  it('should not cross tag boundaries when matching unsubscribe anchor', () => {
    // Two separate anchors: first one has no "unsubscribe" text, second does
    const html = '<body><a href="https://other.com">Visit us</a><a href="#">Unsubscribe</a></body>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain('href="https://other.com"'); // other link unchanged
    expect(result).toContain(`href="${url}"`);
  });

  it('should add href if unsubscribe anchor has none', () => {
    const html = '<body><a>Unsubscribe</a></body>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(`href="${url}"`);
  });

  // Step 3: no unsubscribe found — append default footer
  it('should append default footer before </body> when no unsubscribe exists', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(url);
    expect(result).toContain('Unsubscribe');
    expect(result.indexOf(url)).toBeLessThan(result.indexOf('</body>'));
  });

  it('should use fallbackFooterHtml when provided and no unsubscribe exists', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const footer = `<div><a href="{{unsubscribeUrl}}">Click to unsubscribe</a></div>`;
    const result = injectUnsubscribeUrl(html, url, footer);
    expect(result).toContain(`href="${url}"`);
    expect(result).toContain('Click to unsubscribe');
  });
});
