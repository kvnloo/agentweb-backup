import { classifyMetaBudgetChange } from '../services/agentMode/metaBudgetAnomaly';

describe('classifyMetaBudgetChange (same currency unit)', () => {
  it.each([
    [190, 'normal', 1.9], [200, 'normal', 2], [210, 'warning', 2.1],
    [1000, 'warning', 10], [1010, 'critical', 10.1], [10000, 'critical', 100],
    [50, 'normal', 0.5],
  ])('%s against 100 is %s', (proposed, severity, ratio) => {
    expect(classifyMetaBudgetChange('100', proposed)).toMatchObject({ severity, ratio });
  });
  it('requires critical review for an increase from zero', () => {
    expect(classifyMetaBudgetChange('0', 100)).toMatchObject({ severity: 'critical', ratio: null });
  });
  it.each([undefined, null, '', ' ', 'NaN', true, {}, [], -1, Infinity])('does not coerce invalid amount %p', value => {
    expect(classifyMetaBudgetChange(value, 100).severity).toBe('unknown');
    expect(classifyMetaBudgetChange(100, value).severity).toBe('unknown');
  });
});
