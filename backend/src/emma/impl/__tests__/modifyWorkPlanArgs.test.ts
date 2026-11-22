import { MODIFY_WORK_PLAN_INPUT_SCHEMA, validateModifyWorkPlanArgs } from '../modifyWorkPlanArgs';

// ENG-2399: schema/handler parity for modify_work_plan. Every schema-valid
// fixture must pass handler validation; every schema-invalid one must be
// rejected with a structured, model-readable error naming the field.
describe('modify_work_plan argument contract (ENG-2399)', () => {
  const valid: Array<[string, unknown]> = [
    ['add/update steps', { steps: [{ stepCount: 1, title: 'Draft' }] }],
    ['all advertised step fields', { steps: [{ stepCount: 2, title: 'Img', description: 'd', requiredFunctionCalls: ['generate_image'], expectedAssetCount: 0 }] }],
    ['remove-only call (steps omitted)', { removeStepCounts: [3] }],
    ['autocomplete-only call', { autocomplete: true }],
    ['empty steps with removal', { steps: [], removeStepCounts: [1, 2] }],
    ['tolerates handler-merged extras', { steps: [{ stepCount: 1, title: 't', skillIds: ['s'], userInstructions: 'u' }] }],
  ];
  const invalid: Array<[string, unknown, string]> = [
    ['no fields', {}, 'steps'],
    ['non-object args', 'steps', 'arguments'],
    ['string stepCount', { steps: [{ stepCount: '2', title: 't' }] }, 'steps[0].stepCount'],
    ['fractional stepCount', { steps: [{ stepCount: 1.5, title: 't' }] }, 'steps[0].stepCount'],
    ['zero stepCount', { steps: [{ stepCount: 0, title: 't' }] }, 'steps[0].stepCount'],
    ['missing title', { steps: [{ stepCount: 1 }] }, 'steps[0].title'],
    ['steps not an array', { steps: { stepCount: 1, title: 't' } }, 'steps'],
    ['string removeStepCounts entry', { removeStepCounts: ['3'] }, 'removeStepCounts[0]'],
    ['string autocomplete', { autocomplete: 'true' }, 'autocomplete'],
    ['negative expectedAssetCount', { steps: [{ stepCount: 1, title: 't', expectedAssetCount: -1 }] }, 'steps[0].expectedAssetCount'],
    ['non-string requiredFunctionCalls', { steps: [{ stepCount: 1, title: 't', requiredFunctionCalls: [1] }] }, 'steps[0].requiredFunctionCalls[0]'],
  ];

  it.each(valid)('accepts schema-valid: %s', (_name, args) => {
    expect(validateModifyWorkPlanArgs(args)).toBeNull();
  });

  it.each(invalid)('rejects schema-invalid: %s', (_name, args, field) => {
    const err = validateModifyWorkPlanArgs(args);
    expect(err).not.toBeNull();
    expect(err).toMatchObject({ success: false, errorClass: 'invalid_args', field });
    expect(err!.message).toContain(`\`${field}\``);
    expect(err!.message).toMatch(/Invalid parameters/); // classified invalid_args by toolErrorClassifier
    expect(err!.expected).toBeTruthy();
  });

  it('registered tool advertises exactly the validated schema', () => {
    jest.isolateModules(() => {
      // Parity by construction: the registry entry must reference the same object.
      const src = require('fs').readFileSync(require('path').join(__dirname, '../../tools.ts'), 'utf8');
      const block = src.slice(src.indexOf("name: 'modify_work_plan',\n  definition"), src.indexOf("name: 'set_work_plan_status',\n  definition"));
      expect(block).toContain('inputSchema: MODIFY_WORK_PLAN_INPUT_SCHEMA');
      expect(block).toContain('validateModifyWorkPlanArgs(args)');
    });
    expect(MODIFY_WORK_PLAN_INPUT_SCHEMA.required).toEqual([]);
    expect(MODIFY_WORK_PLAN_INPUT_SCHEMA.properties.steps.items.required).toEqual(['stepCount', 'title']);
  });
});
