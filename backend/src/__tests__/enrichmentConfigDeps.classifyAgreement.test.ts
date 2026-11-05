// ENG-2720: saved classifications must not depend on one sample of a non-deterministic model, and the alias
// prompt must say whose details each canonical group holds (so "email of the CEO" is not the lead's email).
const mockGenerate = jest.fn();
jest.mock('../utils/llmService', () => ({
  createLLMService: jest.fn(() => ({ generateJSONContent: mockGenerate })),
}));
jest.mock('../services/modelRoles', () => ({ resolveModelForUser: jest.fn().mockResolvedValue('openrouter/openai/gpt-5.6-luna') }));
jest.mock('../services/db', () => ({ crmDb: {} }));

import { agreeingClassifications, buildConfigServiceDeps } from '../services/enrichmentConfigDeps';
import { buildAliasInferenceSystemPrompt } from '../services/enrichmentPrompts';

const smart = (deps: string[], extra: object = {}) => ({ isSmartField: true, dependencies: deps, fieldType: 'boolean' as const, ...extra });
const plain = (extra: object = {}) => ({ isSmartField: false, dependencies: [], fieldType: 'string' as const, ...extra });

describe('agreeingClassifications', () => {
  it('keeps a field both samples classify the same way', () => {
    const a = { q: smart(['employee_count', 'funding_stage']), n: plain() };
    expect(agreeingClassifications(a, { q: smart(['funding_stage', 'employee_count']), n: plain() })).toEqual(a);
  });

  it('drops a field when the smart flag differs', () => {
    expect(agreeingClassifications({ f: plain({ fieldType: 'boolean' }) }, { f: smart(['industry']) })).toEqual({});
  });

  it('drops a field when the type differs', () => {
    expect(agreeingClassifications({ p: plain({ fieldType: 'boolean' }) }, { p: plain({ fieldType: 'string' }) })).toEqual({});
  });

  it('compares enum options as a case-insensitive set and drops a field whose options differ', () => {
    const a = { t: plain({ fieldType: 'enum', enumOptions: ['A', 'B', 'C'] }) };
    expect(agreeingClassifications(a, { t: plain({ fieldType: 'enum', enumOptions: ['c', 'b', 'a'] }) })).toEqual(a);
    expect(agreeingClassifications(a, { t: plain({ fieldType: 'enum', enumOptions: ['A', 'B'] }) })).toEqual({});
  });

  it('keeps the dependencies from both samples, without duplicates, and drops a smart field that names none', () => {
    const merged = agreeingClassifications({ q: smart(['employee_count', 'industry']) }, { q: smart(['Employee_Count', 'funding_stage']) });
    expect(merged.q.dependencies).toEqual(['employee_count', 'industry', 'funding_stage']);
    expect(agreeingClassifications({ q: smart([]) }, { q: smart([]) })).toEqual({});
  });

  it('ignores spurious dependencies on a field that is not smart', () => {
    const a = { n: plain({ dependencies: ['industry'] }) };
    expect(agreeingClassifications(a, { n: plain({ dependencies: ['employee_count'] }) })).toEqual(a);
  });

  it('drops fields missing from either sample and tolerates garbage entries', () => {
    expect(agreeingClassifications({ a: plain(), b: plain() }, { a: plain() })).toEqual({ a: plain() });
    expect(agreeingClassifications({ a: null as any, b: 'x' as any }, { a: plain(), b: plain() })).toEqual({});
  });
});

describe('llmClassifySmartFields asks twice and saves only agreement', () => {
  const fields = [{ name: 'q', instruction: 'qualifies if 50+ employees' }, { name: 'n', instruction: 'number of employees' }];
  beforeEach(() => mockGenerate.mockReset());

  it('makes two calls and returns the fields both answers agree on', async () => {
    mockGenerate.mockResolvedValueOnce({ q: smart(['employee_count']), n: plain({ fieldType: 'number' }) })
      .mockResolvedValueOnce({ q: smart(['employee_count']), n: plain({ fieldType: 'string' }) });
    const out = await buildConfigServiceDeps().llmClassifySmartFields(fields, 'u1');
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(Object.keys(out)).toEqual(['q']);
  });

  it('saves nothing when one of the two calls fails', async () => {
    mockGenerate.mockResolvedValueOnce({ q: smart(['employee_count']) }).mockRejectedValueOnce(new Error('provider down'));
    expect(await buildConfigServiceDeps().llmClassifySmartFields(fields, 'u1')).toEqual({});
  });

  it('treats an empty answer as no agreement', async () => {
    mockGenerate.mockResolvedValueOnce(null).mockResolvedValueOnce({ q: smart(['employee_count']) });
    expect(await buildConfigServiceDeps().llmClassifySmartFields(fields, 'u1')).toEqual({});
  });
});

describe('alias inference prompt', () => {
  it('tells the model whose details each group holds and to return null for anyone else', () => {
    const p = buildAliasInferenceSystemPrompt('  person_identity: email, phone\n  company_firmographic: company_phone');
    expect(p).toContain('person_identity: email, phone');
    expect(p).toMatch(/THE LEAD THEMSELVES/);
    expect(p).toMatch(/THE LEAD'S CURRENT EMPLOYER/);
    expect(p).toMatch(/"email of the CEO" is NOT email/);
    expect(p).toMatch(/return null/);
    expect(p).toMatch(/"contact number", "mobile", "cell"/); // synonyms still matched by meaning
  });

  it('llmInferAliases sends that prompt', async () => {
    mockGenerate.mockReset().mockResolvedValue({});
    await buildConfigServiceDeps().llmInferAliases([{ name: 'ceo_email', instruction: 'email of the CEO' }], 'u1');
    const system = mockGenerate.mock.calls[0][0] as string;
    expect(system).toMatch(/THE LEAD THEMSELVES/);
    expect(system).toContain('person_identity:');
  });
});
