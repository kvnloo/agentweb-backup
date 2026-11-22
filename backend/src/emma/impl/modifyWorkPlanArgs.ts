/**
 * ENG-2399: single source of truth for the `modify_work_plan` argument contract.
 *
 * The model-facing schema (registered in emma/tools.ts) and the handler-side
 * validation are both derived from MODIFY_WORK_PLAN_INPUT_SCHEMA, so they can no
 * longer disagree. Before this, the schema required `steps` (a remove-only or
 * autocomplete-only call was schema-invalid), while the handler did no
 * validation at all: a missing `steps` crashed with a generic TypeError and a
 * string `stepCount` silently failed to match an existing step and appended a
 * duplicate. Rejections now name the field and the expected type.
 */

type SchemaNode = {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  minimum?: number;
  minProperties?: number;
};

export const MODIFY_WORK_PLAN_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description: 'Optional array of steps to add or update. Omit (or pass []) when only removing steps or changing autocomplete.',
      items: {
        type: 'object',
        properties: {
          stepCount: {
            type: 'integer',
            minimum: 1,
            description: 'Step number (positive integer, e.g. 1, 2, 3)'
          },
          title: {
            type: 'string',
            description: 'Step title'
          },
          description: {
            type: 'string',
            description: 'Optional detailed description'
          },
          requiredFunctionCalls: {
            type: 'array',
            description: 'Optional array of function names that must be called before marking this step as completed',
            items: { type: 'string' }
          },
          expectedAssetCount: {
            type: 'integer',
            minimum: 0,
            description: 'Optional. Number of media assets the step must produce before it can be completed. Set to a lower number (or 0 to remove the requirement entirely) when the user explicitly approves generating fewer assets than originally planned. Omitting it leaves the existing value unchanged.'
          }
        },
        required: ['stepCount', 'title']
      }
    },
    removeStepCounts: {
      type: 'array',
      description: 'Optional array of step numbers to remove',
      items: { type: 'integer', minimum: 1 }
    },
    autocomplete: {
      type: 'boolean',
      description: 'Optional. Update the autocomplete setting. When true, Emma runs all steps automatically without asking for user confirmation between steps.'
    }
  },
  // At least one of steps / removeStepCounts / autocomplete must be present.
  minProperties: 1,
  required: [] as string[]
} satisfies SchemaNode;

export interface ModifyWorkPlanArgsError {
  success: false;
  errorClass: 'invalid_args';
  field: string;
  expected: string;
  message: string;
}

function typeOk(node: SchemaNode, value: unknown): boolean {
  switch (node.type) {
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
  }
}

function describe(node: SchemaNode): string {
  const base = node.type === 'array' && node.items ? `array of ${describe(node.items)}` : node.type;
  return node.minimum !== undefined ? `${base} >= ${node.minimum}` : base;
}

function fail(field: string, node: SchemaNode | { type: string }, detail: string): ModifyWorkPlanArgsError {
  const expected = 'minimum' in node || 'items' in node ? describe(node as SchemaNode) : node.type;
  return {
    success: false,
    errorClass: 'invalid_args',
    field,
    expected,
    message: `Invalid parameters for modify_work_plan: \`${field}\` ${detail} (expected ${expected}). Fix this field to match the tool schema and retry.`,
  };
}

function check(node: SchemaNode, value: unknown, path: string): ModifyWorkPlanArgsError | null {
  if (!typeOk(node, value)) {
    return fail(path, node, value === undefined ? 'is missing' : `has the wrong type (got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value})`);
  }
  if (node.minimum !== undefined && (value as number) < node.minimum) {
    return fail(path, node, `is out of range (got ${value})`);
  }
  if (node.type === 'array' && node.items) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const err = check(node.items, arr[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  if (node.type === 'object' && node.properties) {
    const obj = value as Record<string, unknown>;
    for (const key of node.required || []) {
      if (obj[key] === undefined) return check(node.properties[key], undefined, path ? `${path}.${key}` : key);
    }
    for (const [key, child] of Object.entries(node.properties)) {
      if (obj[key] === undefined) continue;
      const err = check(child, obj[key], path ? `${path}.${key}` : key);
      if (err) return err;
    }
  }
  return null;
}

/**
 * Validate raw `modify_work_plan` tool args against MODIFY_WORK_PLAN_INPUT_SCHEMA.
 * Unknown extra fields are tolerated (the handler ignores or merges them), so no
 * field the schema advertises is ever rejected.
 */
export function validateModifyWorkPlanArgs(args: unknown): ModifyWorkPlanArgsError | null {
  const schema = MODIFY_WORK_PLAN_INPUT_SCHEMA as SchemaNode;
  const err = check(schema, args, '');
  if (err) return err.field ? err : fail('arguments', schema, 'must be an object');
  const obj = args as Record<string, unknown>;
  const present = Object.keys(schema.properties!).filter((k) => obj[k] !== undefined);
  if (present.length < (schema.minProperties || 0)) {
    return {
      success: false,
      errorClass: 'invalid_args',
      field: 'steps',
      expected: 'at least one of steps, removeStepCounts, autocomplete',
      message: 'Invalid parameters for modify_work_plan: provide at least one of `steps`, `removeStepCounts`, or `autocomplete`.',
    };
  }
  return null;
}
