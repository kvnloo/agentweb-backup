import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../types/express';
import { userDb } from '../services/db';

// Role-based middleware creator for flexibility
export const hasRole = (allowedRoles: string[]) => async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    console.log('Role middleware - checking user:', req.user);
    const userId = req.user?.userId;
    if (!userId) {
      console.log('Role middleware - no userId found');
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    // Admin always has access — but not delegated admin sessions.
    // Delegated sessions operate as the target user only.
    if (user.isAdmin && !(req as any).delegateInfo?.isDelegated) {
      return next();
    }
    
    // Get the user's roles, defaulting to ['partner'] if not set or empty
    const userRoles = (user.roles && user.roles.length > 0 ? user.roles : ['partner']) as ('partner' | 'customer')[];
    console.log('Role middleware - user roles:', { userId, roles: userRoles });
    
    // Check if any of user's roles are in the allowed roles
    const hasPermission = userRoles.some(role => allowedRoles.includes(role));
    
    if (!hasPermission) {
      return res.status(403).json({ 
        message: 'Access denied. Required role not found.', 
        requiredRoles: allowedRoles,
        userRoles: userRoles
      });
    }

    next();
  } catch (error) {
    console.error('Error in role middleware:', error);
    res.status(500).json({ 
      message: 'Internal server error', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
};

// Specific middleware for common roles
export const isPartner = hasRole(['partner']);
export const isCustomer = hasRole(['customer']); 