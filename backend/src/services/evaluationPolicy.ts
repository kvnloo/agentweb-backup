/** Reserved at provisioning; immutable identity survives stale user/credential indexes. */
export function isEvaluationUser(userId: unknown): boolean {
  return typeof userId === 'string' && userId.startsWith('eval_');
}

export class EvaluationDenied extends Error {
  constructor() { super('Evaluation access denied'); }
}

export async function requireActiveEvaluation(userId: string) {
  const { evaluationStore } = await import('./evaluationStore');
  const record = await evaluationStore.get(userId);
  if (!record || record.userId !== userId || record.status !== 'active' ||
      !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) {
    throw new EvaluationDenied();
  }
  return record;
}

/** No inferred read-only classifications: reads can expose staff/customer material. */
export async function enforceEvaluationTool(userId: unknown, name: string, extraContext?: Record<string, unknown>) {
  if ((isEvaluationUser(userId) || isEvaluationUser(extraContext?.userId)) &&
      extraContext && 'userId' in extraContext && extraContext.userId !== userId) throw new EvaluationDenied();
  if (typeof userId !== 'string' || !isEvaluationUser(userId)) return;
  await requireActiveEvaluation(userId);
  if (name !== 'evaluation_workspace') throw new EvaluationDenied();
}

/** Lifecycle mutations require a current app/Emma administrator, never ambient MCP authority. */
export async function requireEvaluationAdmin(userId: string, context?: Record<string, unknown>) {
  if (isEvaluationUser(userId) || context?.externalMcp || context?.isInternal || context?.delegateInfo ||
      context?.isDelegatedAdmin || context?.isDelegatedAccess) throw new EvaluationDenied();
  const { userDb } = await import('./db');
  const admin = await userDb.getUserByIdConsistent(userId);
  if (!admin || admin.userId !== userId || admin.isAdmin !== true || admin.isActive !== true) throw new EvaluationDenied();
}
