import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { userDb } from '../services/db';

export interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    isAdmin: boolean;
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
    ) as { userId: string; email: string };

    // Check if user exists and is not deactivated
    const user = await userDb.getUserById(decoded.userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isActive === false) {
      return res.status(403).json({ message: 'Account has been deactivated. Please contact support.' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ message: 'Invalid token' });
  }
} 