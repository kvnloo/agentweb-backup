import type { WorkPlanInputRequest } from '../../services/agentMode/core/workPlanInputRequest';

/**
 * Converts the shared work-plan request into MCP's deliberately restricted
 * flat form schema. This is an adapter only: the work-plan model never stores
 * MCP-shaped JSON and the customer portal can render the original request.
 */
export function toMcpElicitation(request: WorkPlanInputRequest) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const field of request.fields) {
    const shared = {
      title: field.label,
      ...(field.helpText ? { description: field.helpText } : {}),
      ...(field.defaultValue !== undefined ? { default: field.defaultValue } : {}),
    };
    if (field.type === 'text') properties[field.id] = { type: 'string', ...shared };
    if (field.type === 'url') properties[field.id] = { type: 'string', format: 'uri', ...shared };
    if (field.type === 'number') {
      properties[field.id] = {
        type: 'number',
        ...shared,
        ...(field.minimum !== undefined ? { minimum: field.minimum } : {}),
        ...(field.maximum !== undefined ? { maximum: field.maximum } : {}),
      };
    }
    if (field.type === 'boolean') properties[field.id] = { type: 'boolean', ...shared };
    if (field.type === 'select') {
      properties[field.id] = {
        type: 'string',
        ...shared,
        oneOf: field.options!.map((option) => ({ const: option.value, title: option.label })),
      };
    }
    if (field.required) required.push(field.id);
  }

  return {
    mode: 'form' as const,
    message: request.prompt,
    requestedSchema: {
      type: 'object' as const,
      properties,
      ...(required.length ? { required } : {}),
    },
  };
}
