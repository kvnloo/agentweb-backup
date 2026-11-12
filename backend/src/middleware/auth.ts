import { isEvaluationUser, requireActiveEvaluation } from '../services/evaluationPolicy';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';
import { getJwtSecret } from '../config/jwt';

export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    isAdmin: boolean;
    roles?: ('partner' | 'customer' | 'free')[];
  };
  delegateInfo?: {
    adminUserId: string;
    adminEmail: string;
    isDelegated: boolean;
    isContractor?: boolean;
  };
  /**
   * ENG-2962: true when the login token is a self-call token (`_svc`), which only mcpFetch mints: the request was made by an MCP
   * tool on someone's behalf, not by a person in the app. Routes that need a person's own action (approving an outward action) check it.
   */
  isSelfCall?: boolean;
}

export interface UserPayload {
  userId: string;
  email: string;
  isAdmin: boolean;
  roles?: ('partner' | 'customer' | 'free')[];
  /**
   * Session version the token was minted with. Compared against the user's current
   * `sessionVersion` in the DB; a mismatch means the password was changed after this
   * token was issued, so the token is rejected (other-device logout). Absent = 0.
   */
  sv?: number;
  /** Marks short-lived service-to-service self-call tokens — isAdmin claim is trusted directly */
  _svc?: boolean;
  // Delegation fields
  delegateAccess?: {
    scope?: 'evaluation';
    adminUserId: string;
    adminEmail: string;
    targetUserId: string;
    targetEmail: string;
  };
  /**
   * Delegate-token epoch (ENG-1506). Stamped from the TARGET user's
   * `delegateTokenEpoch` at mint time and compared against the stored value on
   * every request, so an admin can cut off outstanding support access without
   * waiting for the token to expire. Absent = 0.
   */
  dte?: number;
}

// Common function to extract user from request token (returns null if no token or invalid)
// Also returns the decoded payload for delegate info if needed
export async function getUserFromToken(req: Request): Promise<{
  user: { userId: string; email: string; isAdmin: boolean; roles?: ('partner' | 'customer' | 'free')[] } | null;
  decoded?: UserPayload;
  adminUser?: { userId: string; email: string; isContractor?: boolean };
}> {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return { user: null };
  }

  try {
    const decoded = jwt.verify(
      token,
      getJwtSecret()
    ) as UserPayload;

    // Evaluation Access Portal delegation stays a candidate principal; generic delegation remains denied.
    if (isEvaluationUser(decoded.userId) || isEvaluationUser(decoded.delegateAccess?.targetUserId) || isEvaluationUser(decoded.delegateAccess?.adminUserId)) {
      if (decoded._svc || decoded.isAdmin || !isEvaluationUser(decoded.userId)) return { user: null };
      const delegate = decoded.delegateAccess;
      if (delegate && (delegate.scope !== 'evaluation' || delegate.targetUserId !== decoded.userId ||
          delegate.targetEmail !== decoded.email || isEvaluationUser(delegate.adminUserId))) return { user: null };
      const evaluation = await requireActiveEvaluation(decoded.userId);
      if (decoded.email !== evaluation.email) return { user: null };
      const account = await userDb.getUserByEmailConsistent(evaluation.email);
      if (!account || account.userId !== decoded.userId || account.isActive !== true || account.isAdmin || account.orgId ||
          (decoded.sv ?? 0) < (account.sessionVersion ?? 0)) return { user: null };
      let adminUser;
      if (delegate) {
        if (!Number.isSafeInteger(decoded.dte) || !Number.isSafeInteger(decoded.sv) ||
            decoded.dte !== (account.delegateTokenEpoch ?? 0) || decoded.sv !== (account.sessionVersion ?? 0)) return { user: null };
        adminUser = await userDb.getUserByIdConsistent(delegate.adminUserId);
        if (!adminUser || adminUser.userId !== delegate.adminUserId || adminUser.email !== delegate.adminEmail ||
            adminUser.isAdmin !== true || adminUser.isActive !== true) return { user: null };
      }
      return { user: { userId: account.userId, email: account.email, isAdmin: false, roles: ['customer'] }, decoded,
        ...(adminUser ? { adminUser: { userId: adminUser.userId, email: adminUser.email } } : {}) };
    }

    // Handle delegate access tokens
    if (decoded.delegateAccess) {
      // This is a delegate token - admin or contractor accessing as another user
      const adminUser = await userDb.getUserById(decoded.delegateAccess.adminUserId);
      const targetUser = await userDb.getUserById(decoded.delegateAccess.targetUserId);

      if (!adminUser || !targetUser) {
        return { user: null };
      }

      const isAdmin = adminUser.isAdmin;
      const isContractor = adminUser.roles?.includes('contractor');

      // Contractors may only delegate to users in their assigned list
      if (!isAdmin && isContractor) {
        const assignedIds: string[] = (adminUser as any).contractorAssignedUserIds || [];
        if (!assignedIds.includes(decoded.delegateAccess.targetUserId)) {
          return { user: null };
        }
      } else if (!isAdmin && !isContractor) {
        return { user: null };
      }

      // ENG-1506. Two independent kill switches for a delegate token, because
      // until now there were none: the only thing standing between a leaked
      // support token and the customer's account was the clock.
      //
      // Same `<` (token behind server) comparison as the sessionVersion check
      // below, and for the same eventual-consistency reason: getUserById reads
      // an eventually-consistent GSI, so a freshly-minted token can legitimately
      // carry a value the read has not caught up to yet. A strict `!==` would
      // reject the token the admin just created.
      //
      // 1. delegateTokenEpoch — revokes support access on demand, without
      //    logging the customer out of their own devices.
      if ((decoded.dte ?? 0) < (targetUser.delegateTokenEpoch ?? 0)) {
        return { user: null };
      }
      // 2. the TARGET user's sessionVersion — a customer changing their password
      //    should end delegate sessions too. This branch used to return before
      //    reaching the sessionVersion check further down, so a delegate token
      //    outlived the password change that was supposed to kill every session.
      if ((decoded.sv ?? 0) < (targetUser.sessionVersion ?? 0)) {
        return { user: null };
      }

      return {
        user: {
          userId: targetUser.userId,
          email: targetUser.email,
          isAdmin: targetUser.isAdmin || false,
          roles: (targetUser.roles && targetUser.roles.length > 0 ? targetUser.roles : ['customer']) as ('partner' | 'customer' | 'free')[]
        },
        decoded,
        adminUser: {
          userId: adminUser.userId,
          email: adminUser.email,
          isContractor: !!isContractor && !isAdmin,
        }
      };
    } else if (decoded._svc) {
      // Service-to-service self-call token (generated by mcpFetch/generateSelfCallToken).
      // Trust the JWT claims directly — DB lookup would overwrite isAdmin with the real
      // user's DB value, defeating the purpose of elevating privileges for admin delegation.
      return {
        user: {
          userId: decoded.userId,
          email: decoded.email,
          isAdmin: decoded.isAdmin || false,
          roles: (decoded.roles && decoded.roles.length > 0 ? decoded.roles : ['partner']) as ('partner' | 'customer' | 'free')[]
        },
        decoded
      };
    } else {
      // Normal token - get the user data
      if (decoded.userId?.startsWith("deleted_")) {
        return { user: null };
      }

      const user = await userDb.getUserById(decoded.userId);

      if (!user) {
        return { user: null };
      }

      // Reject tokens minted before the user's most recent password change.
      // A bumped sessionVersion invalidates every token carrying an older `sv`,
      // logging out all other devices. Both sides default to 0 for backward compat.
      //
      // Use `<` (token behind server), NOT `!==`: getUserById reads the
      // UserIdIndex GSI, which is eventually consistent. Right after a password
      // change the GSI can still return the stale (lower) sessionVersion while
      // the freshly-issued token already carries the new (higher) `sv`. A strict
      // `!==` would then reject that brand-new token and log the user out of the
      // very device they just used. A token's `sv` can only exceed the stored
      // value because the server legitimately signed it, so accepting `>=` is safe.
      if ((decoded.sv ?? 0) < (user.sessionVersion ?? 0)) {
        return { user: null };
      }

      return {
        user: {
          userId: user.userId,
          email: user.email,
          isAdmin: user.isAdmin || false,
          roles: (user.roles && user.roles.length > 0 ? user.roles : ['partner']) as ('partner' | 'customer' | 'free')[]
        },
        decoded
      };
    }
  } catch (error) {
    return { user: null };
  }
}

export async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const result = await getUserFromToken(req);

  if (!result.user) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }
    // `code` lets the frontend distinguish a dead app session (token expired,
    // signature invalid, user gone, or session version bumped by a password
    // change) from the many route-level 401s that signal a disconnected
    // third-party integration. Only this code should trigger a global logout.
    return res.status(401).json({ message: 'Invalid token', code: 'session_invalid' });
  }

  // Set user properties to the request object
  const authReq = req as AuthenticatedRequest;
  authReq.user = result.user;
  authReq.isSelfCall = result.decoded?._svc === true;

  // Handle delegate info if needed (for backward compatibility)
  if (result.decoded?.delegateAccess && result.adminUser) {
    authReq.delegateInfo = {
      adminUserId: result.adminUser.userId,
      adminEmail: result.adminUser.email,
      isDelegated: true,
      isContractor: result.adminUser.isContractor,
    };
  }

  next();
}

/**
 * Returns true only if the request represents a real (non-delegated) admin session.
 * When an admin delegates to another admin user, the delegated session should NOT
 * inherit admin privileges — it should operate as the target user only.
 * Use this helper instead of checking `req.user.isAdmin` directly.
 */
export function isRealAdmin(req: Request): boolean {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user?.isAdmin) return false;
  // Delegated sessions must not get admin powers, even if target is also an admin
  if (authReq.delegateInfo?.isDelegated) return false;
  return true;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;

  if (!authReq.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  // Delegated sessions must not get admin powers, even if target user is an admin
  if (!isRealAdmin(req)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  next();
}

export async function isAdmin(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;

  // Check if user exists in request (should be added by authenticateToken)
  if (!authReq.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  // Delegated sessions must not get admin powers, even if target user is an admin
  if (!isRealAdmin(req)) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  next();
}
