/**
 * Channel-neutral request for information required to begin a work-plan step.
 *
 * The work-plan author describes the information semantically; the customer
 * portal can render a chat card and an MCP adapter can translate the same
 * request to client-native elicitation. Values are validated here, not by
 * re-parsing an assistant message, so the next step receives deterministic
 * typed input regardless of channel.
 *
 * Keep this deliberately flat. MCP elicitation supports a restricted, flat
 * JSON-Schema subset, and nested or secret-bearing inputs need a dedicated
 * secure connection flow rather than a chat form.
 */

export type WorkPlanInputFieldType = 'text' | 'url' | 'number' | 'boolean' | 'select';
export type WorkPlanInputValue = string | number | boolean;

export interface WorkPlanInputField {
  /** Stable machine key consumed by the step and returned by every adapter. */
  id: string;
  /** Human label shown in the card or native MCP form. */
  label: string;
  type: WorkPlanInputFieldType;
  required?: boolean;
  helpText?: string;
  defaultValue?: WorkPlanInputValue;
  minimum?: number;
  maximum?: number;
  /** Required when type is select; its members are the only accepted values. */
  options?: Array<{ value: string; label: string }>;
}

export interface WorkPlanInputAnswer {
  values: Record<string, WorkPlanInputValue>;
  answeredBy: 'user';
  at: string;
}

export interface WorkPlanInputRequest {
  requestId: string;
  stepCount: number;
  title: string;
  prompt: string;
  fields: WorkPlanInputField[];
  status: 'awaiting' | 'answered';
  createdAt: string;
  answer?: WorkPlanInputAnswer;
}

export interface WorkPlanInputRequestInput {
  requestId: string;
  stepCount: number;
  title: string;
  prompt: string;
  fields: WorkPlanInputField[];
  createdAt?: string;
}

export class WorkPlanInputRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkPlanInputRequestError';
  }
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkPlanInputRequestError(`${label} is required`);
  }
  return value.trim();
}

function validateField(field: WorkPlanInputField, seenIds: Set<string>): void {
  const id = nonBlankString(field?.id, 'field id');
  if (seenIds.has(id)) throw new WorkPlanInputRequestError(`Duplicate field id: ${id}`);
  seenIds.add(id);
  nonBlankString(field.label, `field ${id} label`);

  if (!['text', 'url', 'number', 'boolean', 'select'].includes(field.type)) {
    throw new WorkPlanInputRequestError(`field ${id} has an unsupported type`);
  }
  if ((field.minimum !== undefined || field.maximum !== undefined) && field.type !== 'number') {
    throw new WorkPlanInputRequestError(`field ${id} numeric constraints require type number`);
  }
  if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
    throw new WorkPlanInputRequestError(`field ${id} minimum cannot exceed maximum`);
  }
  if (field.type === 'select') {
    if (!Array.isArray(field.options) || field.options.length < 2) {
      throw new WorkPlanInputRequestError(`field ${id} select needs at least two options`);
    }
    const values = new Set<string>();
    for (const option of field.options) {
      const value = nonBlankString(option?.value, `field ${id} option value`);
      if (values.has(value)) throw new WorkPlanInputRequestError(`field ${id} has duplicate option value: ${value}`);
      values.add(value);
      nonBlankString(option.label, `field ${id} option label`);
    }
  } else if (field.options !== undefined) {
    throw new WorkPlanInputRequestError(`field ${id} options require type select`);
  }

  if (field.defaultValue !== undefined) validateValue(field, field.defaultValue);
}

function validateValue(field: WorkPlanInputField, value: unknown): asserts value is WorkPlanInputValue {
  const id = field.id;
  if (field.type === 'text' && typeof value !== 'string') {
    throw new WorkPlanInputRequestError(`${id} must be text`);
  }
  if (field.type === 'url') {
    if (typeof value !== 'string') throw new WorkPlanInputRequestError(`${id} must be a valid URL`);
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid protocol');
    } catch {
      throw new WorkPlanInputRequestError(`${id} must be a valid URL`);
    }
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new WorkPlanInputRequestError(`${id} must be a number`);
    }
    if (field.minimum !== undefined && value < field.minimum) {
      throw new WorkPlanInputRequestError(`${id} must be at least ${field.minimum}`);
    }
    if (field.maximum !== undefined && value > field.maximum) {
      throw new WorkPlanInputRequestError(`${id} must be at most ${field.maximum}`);
    }
  }
  if (field.type === 'boolean' && typeof value !== 'boolean') {
    throw new WorkPlanInputRequestError(`${id} must be true or false`);
  }
  if (field.type === 'select') {
    if (typeof value !== 'string' || !field.options?.some((option) => option.value === value)) {
      throw new WorkPlanInputRequestError(`${id} must be one of the declared options`);
    }
  }
}

export function buildWorkPlanInputRequest(input: WorkPlanInputRequestInput): WorkPlanInputRequest {
  const requestId = nonBlankString(input.requestId, 'requestId');
  if (!Number.isInteger(input.stepCount) || input.stepCount < 1) {
    throw new WorkPlanInputRequestError('stepCount must be a positive integer');
  }
  const title = nonBlankString(input.title, 'title');
  const prompt = nonBlankString(input.prompt, 'prompt');
  if (!Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > 8) {
    throw new WorkPlanInputRequestError('fields must contain 1–8 entries');
  }
  const seenIds = new Set<string>();
  input.fields.forEach((field) => validateField(field, seenIds));

  return {
    requestId,
    stepCount: input.stepCount,
    title,
    prompt,
    fields: input.fields,
    status: 'awaiting',
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function resolveWorkPlanInputAnswer(
  request: WorkPlanInputRequest,
  values: Record<string, unknown>,
  at: string,
): WorkPlanInputRequest {
  if (request.status !== 'awaiting') {
    throw new WorkPlanInputRequestError('Input request already answered — cannot re-answer');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new WorkPlanInputRequestError('Input answer must be an object');
  }

  const validIds = new Set(request.fields.map((field) => field.id));
  for (const id of Object.keys(values)) {
    if (!validIds.has(id)) throw new WorkPlanInputRequestError(`Unknown input field: ${id}`);
  }

  const resolvedValues: Record<string, WorkPlanInputValue> = {};
  for (const field of request.fields) {
    const submitted = values[field.id];
    if (submitted === undefined) {
      if (field.defaultValue !== undefined) resolvedValues[field.id] = field.defaultValue;
      else if (field.required === true) throw new WorkPlanInputRequestError(`${field.id} is required`);
      continue;
    }
    validateValue(field, submitted);
    resolvedValues[field.id] = submitted;
  }

  return {
    ...request,
    status: 'answered',
    answer: { values: resolvedValues, answeredBy: 'user', at },
  };
}
