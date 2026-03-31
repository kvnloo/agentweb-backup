/**
 * Utility for parsing HTML templates and extracting real-time variables.
 * Handles standard placeholders and special array expansion variables (e.g., _n patterns).
 */

export interface ExtractedVariables {
  variables: string[];
  arrayVariables: string[];
}

export function extractVariables(htmlContent: string, subject?: string): ExtractedVariables {
  const variableRegex = /\{\{([^}]+)\}\}/g;
  const allVariables: string[] = [];
  const regularVariables: string[] = [];
  const arrayVariableNames = new Set<string>();
  let match;

  // Extract from HTML
  while ((match = variableRegex.exec(htmlContent)) !== null) {
    const variable = match[1].trim();
    if (!allVariables.includes(variable)) allVariables.push(variable);
  }

  // Extract from Subject (if email)
  if (subject) {
    let subjectMatch;
    // Reset regex index for new string
    variableRegex.lastIndex = 0;
    while ((subjectMatch = variableRegex.exec(subject)) !== null) {
      const variable = subjectMatch[1].trim();
      if (!allVariables.includes(variable)) allVariables.push(variable);
    }
  }

  // Identify array patterns (e.g. features_n, results_n_title)
  const nPatterns = new Set<string>();
  allVariables.forEach(variable => {
    const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
    if (nMatch) {
      const baseName = nMatch[1];
      const suffix = nMatch[2];
      nPatterns.add(suffix ? `${baseName}_n_${suffix}` : `${baseName}_n`);
    }
  });

  const processedArrayNames = new Set<string>();
  allVariables.forEach(variable => {
    let isArrayVariable = false;

    // Check if this variable belongs to an identified array pattern (e.g. features_1 matches features_n)
    nPatterns.forEach(nPattern => {
      const baseName = nPattern.replace(/_n.*$/, '');
      const numericMatch = variable.match(new RegExp(`^${baseName}_(\\d+)(?:_|$)`));
      if (numericMatch) {
        if (!processedArrayNames.has(nPattern)) {
          arrayVariableNames.add(nPattern);
          processedArrayNames.add(nPattern);
        }
        isArrayVariable = true;
      }
    });

    // Directly handle the _n placeholder itself
    const nMatch = variable.match(/^(.+)_n(?:_(.+))?$/);
    if (nMatch) {
      const baseName = nMatch[1];
      const suffix = nMatch[2];
      const fullName = suffix ? `${baseName}_n_${suffix}` : `${baseName}_n`;
      if (!processedArrayNames.has(fullName)) {
        arrayVariableNames.add(fullName);
        processedArrayNames.add(fullName);
      }
      isArrayVariable = true;
    }

    if (!isArrayVariable) {
      regularVariables.push(variable);
    }
  });

  return { 
    variables: regularVariables, 
    arrayVariables: Array.from(arrayVariableNames) 
  };
}

export function parseTemplateArray(setting: any): any[] {
  if (!setting?.settingValue) return [];
  try {
    const parsed = JSON.parse(setting.settingValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Error parsing template array:', error);
    return [];
  }
}
