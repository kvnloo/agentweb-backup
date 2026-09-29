export type ShadowRoute = 'local' | 'frontier' | 'abstain';

export interface ShadowTask {
  estimatedInputTokens: number;
  requiresFreshWeb?: boolean;
  destructiveWrite?: boolean;
  ambiguous?: boolean;
  exactToolMatch?: boolean;
}

export interface ShadowDecision {
  route: ShadowRoute;
  confidence: number;
  reason: string;
}

export function routeShadowTask(task: ShadowTask): ShadowDecision {
  if (task.destructiveWrite || task.ambiguous) {
    return { route: 'abstain', confidence: 0.5, reason: 'risk_or_ambiguity' };
  }

  if (task.requiresFreshWeb) {
    return { route: 'frontier', confidence: 0.98, reason: 'fresh_external_context' };
  }

  if (task.exactToolMatch && task.estimatedInputTokens <= 4000) {
    return { route: 'local', confidence: 0.98, reason: 'bounded_exact_tool_task' };
  }

  if (task.estimatedInputTokens > 16000) {
    return { route: 'frontier', confidence: 0.9, reason: 'long_context' };
  }

  return { route: 'abstain', confidence: 0.6, reason: 'insufficient_evidence' };
}

export function highConfidenceAgreement(
  fixtures: Array<{ task: ShadowTask; expected: Exclude<ShadowRoute, 'abstain'> }>,
  minConfidence = 0.95,
): number {
  const eligible = fixtures
    .map(({ task, expected }) => ({ decision: routeShadowTask(task), expected }))
    .filter(({ decision }) => decision.confidence >= minConfidence && decision.route !== 'abstain');

  if (eligible.length === 0) return 0;
  return eligible.filter(({ decision, expected }) => decision.route === expected).length / eligible.length;
}
