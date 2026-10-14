import { isStoredStepModelUnavailable, readStepModelsHint, stepModelOptions } from '../utils/workPlanStepModel';

describe('workPlanStepModel helpers (ENG-2378)', () => {
  it('readStepModelsHint is true only for a literal true', () => {
    expect(readStepModelsHint({ workPlanStepModelsEnabled: true })).toBe(true);
    for (const v of [false, 'true', 1, undefined, null]) expect(readStepModelsHint({ workPlanStepModelsEnabled: v })).toBe(false);
    expect(readStepModelsHint(undefined)).toBe(false);
  });
  it('offers the served models; a retired stored model stays visible, disabled and labelled', () => {
    expect(stepModelOptions(undefined, ['a', 'b']).map((o) => o.value)).toEqual(['a', 'b']);
    expect(stepModelOptions('a', ['a', 'b']).every((o) => !o.disabled)).toBe(true);
    const opts = stepModelOptions('old', ['a']);
    expect(opts[0]).toEqual({ value: 'old', label: 'old (unavailable)', disabled: true });
    expect(isStoredStepModelUnavailable('old', ['a'])).toBe(true);
    expect(isStoredStepModelUnavailable(undefined, ['a'])).toBe(false);
  });
});
