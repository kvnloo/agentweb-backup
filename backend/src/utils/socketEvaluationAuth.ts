import { isEvaluationUser } from '../services/evaluationPolicy';

export interface SocketTokenClaims {
  userId?: string;
  email?: string;
  sv?: number;
  dte?: number;
  _svc?: boolean;
  isAdmin?: boolean;
  delegateAccess?: { scope?: string; targetUserId?: string; adminUserId?: string } | unknown;
}

export interface SocketAccountRecord {
  userId?: string;
  email?: string;
  isActive?: boolean;
  isAdmin?: boolean;
  orgId?: string;
  sessionVersion?: number;
  delegateTokenEpoch?: number;
}

export type EvaluationSocketDecision = 'not_evaluation' | 'allow' | 'deny';

/**
 * Socket admission for sandbox (`eval_*`) principals — the same invariants as
 * the HTTP eval branch in middleware/auth.ts, kept free of server.ts so the
 * decision is unit-testable. Anything that is not an evaluation token is left
 * to the ordinary handshake rules; anything evaluation-shaped that fails a
 * check is refused, never downgraded to a normal user.
 */
export async function evaluationSocketDecision(
  decoded: SocketTokenClaims,
  requireActive: (userId: string) => Promise<unknown>,
  loadAccount: (claims: SocketTokenClaims) => Promise<SocketAccountRecord | null | undefined>,
): Promise<EvaluationSocketDecision> {
  const delegate = (decoded.delegateAccess && typeof decoded.delegateAccess === 'object'
    ? decoded.delegateAccess : undefined) as { scope?: string; targetUserId?: string; adminUserId?: string } | undefined;
  const involved = isEvaluationUser(decoded.userId) || isEvaluationUser(delegate?.targetUserId) || isEvaluationUser(delegate?.adminUserId);
  if (!involved) return 'not_evaluation';
  if (decoded._svc || decoded.isAdmin || typeof decoded.userId !== 'string' || !isEvaluationUser(decoded.userId)) return 'deny';
  if (decoded.delegateAccess !== undefined) {
    if (!delegate || delegate.scope !== 'evaluation' || delegate.targetUserId !== decoded.userId || isEvaluationUser(delegate.adminUserId)) return 'deny';
  }
  try {
    await requireActive(decoded.userId);
    const account = await loadAccount(decoded);
    if (!account || account.userId !== decoded.userId || account.isActive !== true || account.isAdmin || account.orgId) return 'deny';
    if ((decoded.sv ?? 0) < (account.sessionVersion ?? 0)) return 'deny';
    if (delegate) {
      // A delegate token is revoked by bumping either epoch; mirror the HTTP branch's exact match.
      if (!Number.isSafeInteger(decoded.dte) || !Number.isSafeInteger(decoded.sv) ||
          decoded.dte !== (account.delegateTokenEpoch ?? 0) || decoded.sv !== (account.sessionVersion ?? 0)) return 'deny';
    }
    return 'allow';
  } catch {
    return 'deny';
  }
}
