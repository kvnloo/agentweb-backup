import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types/express';

export const isAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Delegated sessions (admin accessing as another user) must not get admin powers.
    // Self-call tokens (_svc: true, from mcpFetch) do NOT set delegateInfo, so they
    // pass through this check and are evaluated on req.user.isAdmin below.
    if ((req as any).delegateInfo?.isDelegated) {
      return res.status(403).json({ message: 'Access denied. Delegated sessions cannot access admin routes.' });
    }

    // Trust req.user.isAdmin — already resolved by authenticateToken (from JWT or DB).
    if (!req.user?.isAdmin) {
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
