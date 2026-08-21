export type EditableWorkPlanInputValue = string | number | boolean;

export interface EditableWorkPlanInputField {
  id: string;
  label: string;
  type: 'text' | 'url' | 'number' | 'boolean' | 'select';
  required?: boolean;
  helpText?: string;
  defaultValue?: EditableWorkPlanInputValue;
  minimum?: number;
  maximum?: number;
  options?: Array<{ value: string; label: string }>;
}

export interface EditableWorkPlanInputRequest {
  title: string;
  prompt: string;
  fields: EditableWorkPlanInputField[];
}

export function validateEditableInputRequest(value: EditableWorkPlanInputRequest): string[] {
  const errors: string[] = [];
  if (!value.title.trim()) errors.push('Add a card title.');
  if (!value.prompt.trim()) errors.push('Add a short question.');
  if (value.fields.length === 0) errors.push('Add at least one answer.');

  const ids = new Set<string>();
  value.fields.forEach((field, index) => {
    const name = field.label.trim() || `Answer ${index + 1}`;
    if (!field.id.trim() || ids.has(field.id)) errors.push(`${name} needs a unique internal key.`);
    ids.add(field.id);
    if (!field.label.trim()) errors.push(`Answer ${index + 1} needs a label.`);
    if (field.type === 'select' && (!field.options || field.options.length < 2)) {
      errors.push(`${name} needs at least two choices.`);
    }
    if (
      field.type === 'number'
      && field.minimum !== undefined
      && field.maximum !== undefined
      && field.minimum > field.maximum
    ) {
      errors.push(`${name} has a minimum above its maximum.`);
    }
    if (field.type === 'number' && typeof field.defaultValue === 'number') {
      if (field.minimum !== undefined && field.defaultValue < field.minimum) errors.push(`${name}'s default is below its minimum.`);
      if (field.maximum !== undefined && field.defaultValue > field.maximum) errors.push(`${name}'s default is above its maximum.`);
    }
    if (field.type === 'url' && typeof field.defaultValue === 'string' && field.defaultValue) {
      try {
        const url = new URL(field.defaultValue);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
      } catch {
        errors.push(`${name}'s default must be a website.`);
      }
    }
    if (
      field.type === 'select'
      && typeof field.defaultValue === 'string'
      && !field.options?.some((option) => option.value === field.defaultValue)
    ) {
      errors.push(`${name}'s default is no longer one of its choices.`);
    }
  });
  return errors;
}
