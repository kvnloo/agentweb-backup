// ENG-2720: a field whose instruction was edited must not keep the smart tags made for the OLD instruction
// when the new classification is missing (the call failed, or the two samples disagreed): every run would
// skip fetching it and compute the old condition. Candidates are cleared before the model is asked.
import { processEnrichmentConfig, type ConfigProcessingDeps } from '../services/enrichmentConfigService';
import type { EnrichmentConfig, EnrichmentFieldConfig } from '../services/crmEnrichmentServiceV3';

// Fixtures are plain objects; the service reads them as config/deps.
const asConfig = (c: object) => c as unknown as EnrichmentConfig;
const asDeps = (d: object) => d as unknown as ConfigProcessingDeps;
const asField = (f: unknown) => f as EnrichmentFieldConfig & Record<string, unknown>;

const OLD = 'qualified if the company has more than 50 employees';
const stored = (extra: object = {}) => ({
  schemaVersion: 1,
  fields: [{ name: 'q', type: 'string', instruction: OLD, include: true, overwritePolicy: 'fill_if_empty', smartCondition: OLD, smartDependencies: ['employee_count'], ...extra }],
});
const sent = (instruction: string) => ({ schemaVersion: 1, fields: [{ name: 'q', type: 'string', instruction, include: true, overwritePolicy: 'fill_if_empty' }] });
const run = (instruction: string, classify: jest.Mock, storedConfig: object = stored()) =>
  processEnrichmentConfig(
    { listId: 'l1', userId: 'u1', config: asConfig(sent(instruction)) },
    asDeps({ readListConfig: jest.fn().mockResolvedValue(storedConfig), llmInferAliases: jest.fn().mockResolvedValue({}), llmClassifySmartFields: classify }),
  ).then(r => asField(r.config.fields.find(f => f.name === 'q')));

describe('stale smart tags after an instruction edit', () => {
  it('clears them when the new classification is undecided', async () => {
    const f = await run('name of the CEO of the company', jest.fn().mockResolvedValue({}));
    expect(f.smartCondition).toBeUndefined();
    expect(f.smartDependencies).toBeUndefined();
    expect(f.notSmartInstruction).toBeUndefined();
  });

  it('clears them when the classification call fails', async () => {
    const f = await run('name of the CEO of the company', jest.fn().mockRejectedValue(new Error('provider down')));
    expect(f.smartCondition).toBeUndefined();
    expect(f.smartDependencies).toBeUndefined();
  });

  it('clears a stale not-smart marker too', async () => {
    const f = await run('qualified if the company has more than 200 employees', jest.fn().mockResolvedValue({}),
      stored({ smartCondition: undefined, smartDependencies: undefined, notSmartInstruction: 'old text' }));
    expect(f.notSmartInstruction).toBeUndefined();
  });

  it('replaces them with the new answer when the samples agree', async () => {
    const f = await run('name of the CEO of the company', jest.fn().mockResolvedValue({ q: { isSmartField: false, dependencies: [], fieldType: 'string' } }));
    expect(f.smartCondition).toBeUndefined();
    expect(f.notSmartInstruction).toBe('name of the CEO of the company');
  });

  it('keeps the tags, and asks nothing, when the instruction did not change', async () => {
    const classify = jest.fn();
    const f = await run(OLD, classify);
    expect(classify).not.toHaveBeenCalled();
    expect(f.smartCondition).toBe(OLD);
    expect(f.smartDependencies).toEqual(['employee_count']);
  });

  it('clears only the edited field and leaves an unchanged smart field alone', async () => {
    const R = 'good fit if the headcount is over 20';
    const storedTwo = {
      schemaVersion: 1,
      fields: [
        { name: 'q', type: 'string', instruction: OLD, include: true, overwritePolicy: 'fill_if_empty', smartCondition: OLD, smartDependencies: ['employee_count'] },
        { name: 'r', type: 'boolean', instruction: R, include: true, overwritePolicy: 'fill_if_empty', smartCondition: R, smartDependencies: ['employee_count'] },
      ],
    };
    const config = { schemaVersion: 1, fields: [
      { name: 'q', type: 'string', instruction: 'name of the CEO of the company', include: true, overwritePolicy: 'fill_if_empty' },
      { name: 'r', type: 'boolean', instruction: R, include: true, overwritePolicy: 'fill_if_empty' },
    ] };
    const classify = jest.fn().mockResolvedValue({});
    const out = await processEnrichmentConfig({ listId: 'l1', userId: 'u1', config: asConfig(config) }, asDeps({
      readListConfig: jest.fn().mockResolvedValue(storedTwo), llmInferAliases: jest.fn().mockResolvedValue({}), llmClassifySmartFields: classify,
    }));
    const byName = Object.fromEntries(out.config.fields.map(f => [f.name, asField(f)]));
    expect(classify).toHaveBeenCalledWith([{ name: 'q', instruction: 'name of the CEO of the company' }], 'u1');
    expect(byName.q.smartCondition).toBeUndefined();
    expect(byName.r.smartCondition).toBe(R);
    expect(byName.r.smartDependencies).toEqual(['employee_count']);
  });

  it('clears the tags of a field whose instruction was emptied, without asking the model', async () => {
    const classify = jest.fn();
    const f = await run('', classify);
    expect(classify).not.toHaveBeenCalled();
    expect(f.smartCondition).toBeUndefined();
    expect(f.smartDependencies).toBeUndefined();
    expect(f.notSmartInstruction).toBeUndefined();
  });
});
