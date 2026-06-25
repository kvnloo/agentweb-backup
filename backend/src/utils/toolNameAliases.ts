const MODEL_EXPOSURE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  search_web: 'you_search_web',
};

export const MODEL_HIDDEN_COMPATIBILITY_TOOLS = new Set(
  Object.keys(MODEL_EXPOSURE_TOOL_ALIASES)
);

export function canonicalToolNameForRequirement(toolName: string): string {
  return MODEL_EXPOSURE_TOOL_ALIASES[toolName] || toolName;
}

export function countCallsForRequirement(functionName: string, calls: string[]): number {
  const requiredCanonical = canonicalToolNameForRequirement(functionName);
  return calls.filter(call => canonicalToolNameForRequirement(call) === requiredCanonical).length;
}

export function countCalledFunctionsForRequirement(
  functionName: string,
  calledFunctions: Record<string, number>
): number {
  const requiredCanonical = canonicalToolNameForRequirement(functionName);
  return Object.entries(calledFunctions).reduce((sum, [calledName, count]) => {
    return canonicalToolNameForRequirement(calledName) === requiredCanonical
      ? sum + count
      : sum;
  }, 0);
}

export function decrementCalledFunctionForRequirement(
  functionName: string,
  calledFunctions: Record<string, number>
): boolean {
  const requiredCanonical = canonicalToolNameForRequirement(functionName);
  const candidateNames = [
    functionName,
    requiredCanonical,
    ...Object.keys(MODEL_EXPOSURE_TOOL_ALIASES)
      .filter(alias => MODEL_EXPOSURE_TOOL_ALIASES[alias] === requiredCanonical),
  ];

  for (const name of [...new Set(candidateNames)]) {
    if ((calledFunctions[name] || 0) > 0) {
      calledFunctions[name] -= 1;
      return true;
    }
  }

  return false;
}

export function canonicalizeModelVisibleToolNames(toolNames: Iterable<string>): Set<string> {
  const normalized = new Set<string>();
  for (const name of toolNames) {
    normalized.add(canonicalToolNameForRequirement(name));
  }
  MODEL_HIDDEN_COMPATIBILITY_TOOLS.forEach(name => normalized.delete(name));
  return normalized;
}

export function expandAllowedFunctionCallsForCanonicalTools(toolNames: string[]): string[] {
  if (toolNames.includes('*')) return toolNames;
  return [...canonicalizeModelVisibleToolNames(toolNames)];
}

export function isModelHiddenCompatibilityTool(toolName: string): boolean {
  return MODEL_HIDDEN_COMPATIBILITY_TOOLS.has(toolName);
}
