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

export function substituteVariables(template: string, lead: Record<string, any>): string {
  if (!template) return template;

  let result = template;

  // Replace standard fields: {{firstName}}, {{lastName}}, etc.
  for (const field of STANDARD_FIELDS) {
    const regex = new RegExp(`\\{\\{${field}\\}\\}`, 'g');
    result = result.replace(regex, lead[field] != null ? String(lead[field]) : '');
  }

  // Replace custom fields: {{customFields.xxx}}
  result = result.replace(/\{\{customFields\.([^}]+)\}\}/g, (_match, fieldName) => {
    const customFields = lead.customFields;
    if (customFields && typeof customFields === 'object' && fieldName in customFields) {
      return String(customFields[fieldName]);
    }
    return '';
  });

  return result;
}
