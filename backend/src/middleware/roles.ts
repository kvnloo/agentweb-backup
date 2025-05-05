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
    
    // Admin always has access
    if (user.isAdmin) {
      return next();
    }
    
    // Get the user's role, defaulting to 'partner' if not set
    const userRole = user.role || 'partner';
    console.log('Role middleware - user role:', { userId, role: userRole });
    
    // Check if user's role is in the allowed roles
    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ 
        message: 'Access denied. Required role not found.', 
        requiredRoles: allowedRoles,
        userRole: userRole
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