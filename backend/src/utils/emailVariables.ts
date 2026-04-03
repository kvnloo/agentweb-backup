const STANDARD_FIELDS = ['firstName', 'lastName', 'email', 'company', 'title'] as const;

/**
 * Extract all variable names used in a template string.
 * Returns standard fields like "firstName" and custom fields like "customFields.region".
 */
export function extractVariables(template: string): string[] {
  if (!template) return [];
  const vars = new Set<string>();
  const regex = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = regex.exec(template)) !== null) {
    const varName = match[1].trim();
    // Skip special non-lead variables
    if (varName === 'unsubscribeUrl') continue;
    vars.add(varName);
  }
  return Array.from(vars);
}

/**
 * Check whether a lead has a non-empty value for a given variable name.
 */
export function leadHasVariable(lead: Record<string, any>, varName: string): boolean {
  if (varName.startsWith('customFields.')) {
    const fieldName = varName.slice('customFields.'.length);
    const customFields = lead.customFields;
    if (customFields && typeof customFields === 'object' && fieldName in customFields) {
      const val = customFields[fieldName];
      return val != null && val !== '';
    }
    return false;
  }
  const val = lead[varName];
  return val != null && val !== '';
}

export function substituteVariables(
  template: string,
  lead: Record<string, any>,
  eventData?: Record<string, any>
): string {
  if (!template) return template;

  let result = template;

  // Replace standard fields: {{firstName}}, {{lead.firstName}}, etc.
  for (const field of STANDARD_FIELDS) {
    const value = lead[field] != null ? String(lead[field]) : '';
    result = result.replace(new RegExp(`\\{\\{${field}\\}\\}`, 'g'), value);
    result = result.replace(new RegExp(`\\{\\{lead\\.${field}\\}\\}`, 'g'), value);
  }

  // Replace custom fields: {{customFields.xxx}}
  result = result.replace(/\{\{customFields\.([^}]+)\}\}/g, (_match, fieldName) => {
    const customFields = lead.customFields;
    if (customFields && typeof customFields === 'object' && fieldName in customFields) {
      return String(customFields[fieldName]);
    }
    return '';
  });

  // Replace event data: {{event.click.link}}, {{event.source}}, etc.
  if (eventData) {
    result = result.replace(/\{\{event\.([^}]+)\}\}/g, (_match, path) => {
      const value = path.split('.').reduce((obj: any, key: string) => obj?.[key], eventData);
      return value != null ? String(value) : '';
    });
  }

  return result;
}
