import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserFromToken } from './auth';
import { isEvaluationUser } from '../services/evaluationPolicy';

/** Mounted before all routers, including public routes with optional authentication. */
export async function evaluationHttpBoundary(req: Request, res: Response, next: NextFunction) {
  // Connector callbacks use JWT state with the same signing key as app sessions.
  // Select the strict boundary there too; an app JWT must never serve as connect consent.
  const tokens = [req.headers.authorization?.split(' ')[1], req.query.state, req.query.token, req.body?.state];
  const evaluationToken = tokens.some(raw => {
    if (typeof raw !== 'string') return false;
    const decoded = jwt.decode(raw) as any;
    return isEvaluationUser(decoded?.userId) || isEvaluationUser(decoded?.delegateAccess?.targetUserId) || isEvaluationUser(decoded?.delegateAccess?.adminUserId);
  });
  if (!evaluationToken) return next();
  const result = await getUserFromToken(req);
  if (!result.user) return res.status(401).json({ code: 'session_invalid', message: 'Invalid token' });
  (req as any).user = result.user;
  const path = req.path;
  if (/^\/api\/evaluation\/?$/.test(path) || /^\/api\/evaluation\/artifacts\/[a-zA-Z0-9-]+\/?$/.test(path)) return next();
  if ((req.method === 'GET' && path === '/api/auth/me') || (req.method === 'PUT' && path === '/api/auth/change-password')) return next();
  return res.status(403).json({ error: 'Evaluation access denied' });
}
