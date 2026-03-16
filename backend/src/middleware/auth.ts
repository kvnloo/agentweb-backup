import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';
import { agencyService } from '../services/agencyService';

export interface AgencyAccessInfo {
  agencyTeamId: string;
  clientTeamId: string;
  originalUserId: string;
}

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
  };
  agencyAccess?: AgencyAccessInfo;
}

export interface UserPayload {
  userId: string;
  email: string;
  isAdmin: boolean;
  roles?: ('partner' | 'customer' | 'free')[];
  // Delegation fields
  delegateAccess?: {
    adminUserId: string;
    adminEmail: string;
    targetUserId: string;
    targetEmail: string;
  };
  // Agency scoped access fields
  agencyAccess?: {
    agencyTeamId: string;
    clientTeamId: string;
    originalUserId: string;
  };
}

// Common function to extract user from request token (returns null if no token or invalid)
// Also returns the decoded payload for delegate info and agency access if needed
export async function getUserFromToken(req: Request): Promise<{
  user: { userId: string; email: string; isAdmin: boolean; roles?: ('partner' | 'customer' | 'free')[] } | null;
  decoded?: UserPayload;
  adminUser?: { userId: string; email: string };
  agencyAccess?: AgencyAccessInfo;
}> {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return { user: null };
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key'
    ) as UserPayload;

    // Handle delegate access tokens
    if (decoded.delegateAccess) {
      // This is a delegate token - admin accessing as another user
      const adminUser = await userDb.getUserById(decoded.delegateAccess.adminUserId);
      const targetUser = await userDb.getUserById(decoded.delegateAccess.targetUserId);

      if (!adminUser || !targetUser || !adminUser.isAdmin) {
        return { user: null };
      }

      return {
        user: {
          userId: targetUser.userId,
          email: targetUser.email,
          isAdmin: false, // Target user permissions, not admin permissions
          roles: (targetUser.roles && targetUser.roles.length > 0 ? targetUser.roles : ['customer']) as ('partner' | 'customer' | 'free')[]
        },
        decoded,
        adminUser: {
          userId: adminUser.userId,
          email: adminUser.email
        }
      };
    } else if (decoded.agencyAccess) {
      // This is an agency-scoped token — agency user accessing client workspace
      const { agencyTeamId, clientTeamId, originalUserId } = decoded.agencyAccess;

      // Verify the agency-client link is still active
      const isLinked = await agencyService.isAgencyForClient(agencyTeamId, clientTeamId);
      if (!isLinked) {
        return { user: null };
      }

      // Get the original agency user
      const agencyUser = await userDb.getUserById(originalUserId);
      if (!agencyUser) {
        return { user: null };
      }

      return {
        user: {
          userId: agencyUser.userId,
          email: agencyUser.email,
          isAdmin: false,
          roles: (agencyUser.roles && agencyUser.roles.length > 0 ? agencyUser.roles : ['customer']) as ('partner' | 'customer' | 'free')[]
        },
        decoded,
        agencyAccess: {
          agencyTeamId,
          clientTeamId,
          originalUserId,
        },
      };
    } else {
      // Normal token - get the user data
      const user = await userDb.getUserById(decoded.userId);
      
      if (!user) {
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
    return res.status(401).json({ message: 'Invalid token' });
  }

  // Set user properties to the request object
  const authReq = req as AuthenticatedRequest;
  authReq.user = result.user;

  // Handle delegate info if needed (for backward compatibility)
  if (result.decoded?.delegateAccess && result.adminUser) {
    authReq.delegateInfo = {
      adminUserId: result.adminUser.userId,
      adminEmail: result.adminUser.email,
      isDelegated: true
    };
  }

  // Handle agency access info
  if (result.agencyAccess) {
    authReq.agencyAccess = result.agencyAccess;
  }

  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  
  if (!authReq.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  if (!authReq.user.isAdmin) {
    return res.status(403).json({ message: 'Admin access required' });
  }
  
  next();
}

/**
 * Returns the effective owner ID for data access.
 * When in agency-switch mode, returns the clientTeamId so the agency user
 * sees the client's data. Otherwise returns the user's own userId.
 */
export function getEffectiveOwnerId(req: Request): string | undefined {
  const authReq = req as AuthenticatedRequest;
  if (authReq.agencyAccess) {
    return authReq.agencyAccess.clientTeamId;
  }
  return authReq.user?.userId;
}

export async function isAdmin(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthenticatedRequest;
  
  // Check if user exists in request (should be added by authenticateToken)
  if (!authReq.user) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  // Check if user is admin
  if (!authReq.user.isAdmin) {
    return res.status(403).json({ message: 'Admin access required' });
  }
  
  next();
} 