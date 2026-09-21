import { isEvaluationUser, EvaluationDenied } from './evaluationPolicy';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';

/**
 * Mint a delegate-access JWT: `authenticateToken` (middleware/auth.ts) treats this
 * exactly like a real customer-portal delegate session — `req.user` becomes the
 * target, `req.delegateInfo` carries the admin — so every existing user-scoped
 * route works against the target's data with zero route-level changes.
 *
 * Extracted from routes/admin.ts's `/users/:userId/delegate-access` handler
 * (ENG-1596) so the MCP tool layer can mint the same shape of token internally,
 * per tool call, without going through the customer-portal browser flow.
 *
 * `adminUser`/`targetUser` are raw DB records (untyped `AttributeMap` from
 * `userDb.getUserById`/`getUserByEmail`) — accepted loosely like every other
 * caller of these DB reads in this codebase, rather than re-declaring a
 * narrower interface that would need a cast at every call site.
 */
export function mintDelegateToken(
  adminUser: { userId: string; email: string },
  targetUser: any,
  expiresIn: jwt.SignOptions['expiresIn'],
): string {
  if (isEvaluationUser(adminUser.userId) || isEvaluationUser(targetUser?.userId)) throw new EvaluationDenied();
  return signDelegateToken(adminUser, targetUser, expiresIn);
}

/** Access Portal only: a candidate session, never generic staff/tool delegation. */
export function mintEvaluationDelegateToken(
  adminUser: { userId: string; email: string },
  targetUser: any,
  expiresIn: jwt.SignOptions['expiresIn'],
): string {
  if (isEvaluationUser(adminUser.userId) || !isEvaluationUser(targetUser?.userId)) throw new EvaluationDenied();
  return signDelegateToken(adminUser, targetUser, expiresIn, 'evaluation');
}

function signDelegateToken(
  adminUser: { userId: string; email: string }, targetUser: any,
  expiresIn: jwt.SignOptions['expiresIn'], scope?: 'evaluation',
): string {
  const payload = {
    userId: targetUser.userId, // This will be the active user in the token
    email: targetUser.email,
    roles: targetUser.roles,
    isAdmin: false, // Target user permissions
    dte: targetUser.delegateTokenEpoch ?? 0,
    sv: targetUser.sessionVersion ?? 0,
    delegateAccess: {
      ...(scope ? { scope } : {}),
      adminUserId: adminUser.userId,
      adminEmail: adminUser.email,
      targetUserId: targetUser.userId,
      targetEmail: targetUser.email,
    },
  };

  return jwt.sign(payload, getJwtSecret(), { expiresIn });
}
