import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';

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
}

export async function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'No token provided' });
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
      
      if (!adminUser || !targetUser) {
        return res.status(404).json({ message: 'User not found in delegation' });
      }
      
      if (!adminUser.isAdmin) {
        return res.status(403).json({ message: 'Delegation only allowed for admin users' });
      }

      // Set user properties to target user but preserve admin context
      const authReq = req as AuthenticatedRequest;
      authReq.user = {
        userId: targetUser.userId,
        email: targetUser.email,
        isAdmin: false, // Target user permissions, not admin permissions
        roles: (targetUser.roles && targetUser.roles.length > 0 ? targetUser.roles : ['customer']) as ('partner' | 'customer' | 'free')[]
      };
      
      // Add delegation info for logging/audit purposes
      authReq.delegateInfo = {
        adminUserId: adminUser.userId,
        adminEmail: adminUser.email,
        isDelegated: true
      };
    } else {
      // Normal token - get the user data
      const user = await userDb.getUserById(decoded.userId);
      
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      // Assign user properties to the request object
      const authReq = req as AuthenticatedRequest;
      authReq.user = {
        userId: user.userId,
        email: user.email,
        isAdmin: user.isAdmin || false,
        roles: (user.roles && user.roles.length > 0 ? user.roles : ['partner']) as ('partner' | 'customer' | 'free')[] // Use roles array, default if empty
      };
    }

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
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