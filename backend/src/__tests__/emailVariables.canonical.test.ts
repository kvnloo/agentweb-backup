/**
 * Variable recognition must be identical across coverage (leadHasVariable),
 * substitution (substituteVariables) and support checks: camelCase,
 * snake_case and spaced spellings of standard fields all resolve to the lead field.
 */
import {
  canonicalVariableName, extractVariables, isSupportedVariable, leadHasVariable, substituteVariables,
} from '../utils/emailVariables';

const lead = { firstName: 'John', lastName: 'Smith', email: 'john@example.com', company: 'Acme', title: 'CEO' };

const spellings: Array<[string, string, string]> = [
  ['firstName', 'firstName', 'John'], ['first_name', 'firstName', 'John'], ['first name', 'firstName', 'John'],
  ['First Name', 'firstName', 'John'], ['FIRST_NAME', 'firstName', 'John'], [' first_name ', 'firstName', 'John'],
  ['last_name', 'lastName', 'Smith'], ['lastName', 'lastName', 'Smith'],
  ['company_name', 'company', 'Acme'], ['company', 'company', 'Acme'],
  ['email', 'email', 'john@example.com'], ['title', 'title', 'CEO'],
];

describe.each(spellings)('variable {{%s}}', (name, canonical, value) => {
  it(`canonicalizes to ${canonical}`, () => expect(canonicalVariableName(name)).toBe(canonical));
  it('counts as covered when the lead field is populated', () => expect(leadHasVariable(lead, name)).toBe(true));
  it('counts as missing when the lead field is empty', () =>
    expect(leadHasVariable({ ...lead, [canonical]: '' }, name)).toBe(false));
  it('substitutes the lead value', () => expect(substituteVariables(`Hi {{${name}}}!`, lead)).toBe(`Hi ${value}!`));
  it('is a supported variable', () => expect(isSupportedVariable(name)).toBe(true));
});

describe('coverage and substitution agree', () => {
  it('every extracted variable covered by leadHasVariable is fully substituted', () => {
    const tpl = 'Hi {{first_name}} {{lastName}} of {{company name}} ({{Title}})';
    const vars = extractVariables(tpl);
    expect(vars.every((v) => leadHasVariable(lead, v))).toBe(true);
    expect(substituteVariables(tpl, lead)).toBe('Hi John Smith of Acme (CEO)');
  });

  it('leaves unknown tokens untouched and unsupported', () => {
    expect(substituteVariables('x {{favorite_color}} y', lead)).toBe('x {{favorite_color}} y');
    expect(isSupportedVariable('favorite_color')).toBe(false);
    expect(leadHasVariable(lead, 'favorite_color')).toBe(false);
  });

  it('keeps customFields.* resolution exact', () => {
    const l = { ...lead, customFields: { region: 'West' } };
    expect(leadHasVariable(l, 'customFields.region')).toBe(true);
    expect(substituteVariables('{{customFields.region}}', l)).toBe('West');
  });
});
