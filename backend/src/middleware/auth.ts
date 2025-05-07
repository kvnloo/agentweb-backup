import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';

export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    isAdmin: boolean;
    roles?: ('partner' | 'customer')[];
  };
}

export interface UserPayload {
  userId: string;
  email: string;
  isAdmin: boolean;
  roles?: ('partner' | 'customer')[];
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

    // Get the latest user data to ensure up-to-date permissions
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
      roles: (user.roles && user.roles.length > 0 ? user.roles : ['partner']) as ('partner' | 'customer')[] // Use roles array, default if empty
    };

    next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
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