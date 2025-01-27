import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../types/express';
import { userDb } from '../services/db';

export const isAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    console.log('Admin middleware - checking user:', req.user);
    const userId = req.user?.userId;
    if (!userId) {
      console.log('Admin middleware - no userId found');
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const user = await userDb.getUserById(userId);
    console.log('Admin middleware - user found:', { userId, isAdmin: user?.isAdmin });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    if (!user.isAdmin) {
      return res.status(403).json({ message: 'Access denied. Admin privileges required.' });
    }

    next();
  } catch (error) {
    console.error('Error in admin middleware:', error);
    res.status(500).json({ 
      message: 'Internal server error', 
      error: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}; 
