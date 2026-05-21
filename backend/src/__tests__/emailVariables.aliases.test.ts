/**
 * Tests that substituteVariables handles spaced variable names like {{first name}}
 * in addition to the canonical camelCase {{firstName}}.
 */

import { substituteVariables } from '../utils/emailVariables';

const lead = {
  firstName: 'John',
  lastName: 'Smith',
  email: 'john@example.com',
  company: 'Acme',
  title: 'CEO',
};

describe('substituteVariables - variable name aliases', () => {
  it('replaces {{first name}} with firstName value', () => {
    const result = substituteVariables('Hi {{first name}} — thanks!', lead);
    expect(result).toBe('Hi John — thanks!');
  });

  it('replaces {{last name}} with lastName value', () => {
    const result = substituteVariables('Hello {{last name}}!', lead);
    expect(result).toBe('Hello Smith!');
  });

  it('replaces {{First Name}} (title case) with firstName value', () => {
    const result = substituteVariables('Dear {{First Name}},', lead);
    expect(result).toBe('Dear John,');
  });

  it('replaces {{Last Name}} (title case) with lastName value', () => {
    const result = substituteVariables('Hi {{Last Name}}', lead);
    expect(result).toBe('Hi Smith');
  });

  it('replaces {{First name}} (sentence case) with firstName value', () => {
    const result = substituteVariables('Hey {{First name}}!', lead);
    expect(result).toBe('Hey John!');
  });

  it('replaces canonical {{firstName}} as before', () => {
    const result = substituteVariables('Hi {{firstName}}!', lead);
    expect(result).toBe('Hi John!');
  });

  it('replaces both spaced and camelCase in same template', () => {
    const result = substituteVariables('Hi {{first name}} {{last name}}, aka {{firstName}}', lead);
    expect(result).toBe('Hi John Smith, aka John');
  });

  it('replaces with empty string when lead has no firstName', () => {
    const result = substituteVariables('Hi {{first name}}!', { ...lead, firstName: undefined });
    expect(result).toBe('Hi !');
  });

  it('replaces all occurrences of spaced alias', () => {
    const result = substituteVariables('{{first name}} - {{first name}}', lead);
    expect(result).toBe('John - John');
  });
});
