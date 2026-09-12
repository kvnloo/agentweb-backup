import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getUserFromToken } from './auth';
import { isEvaluationUser } from '../services/evaluationPolicy';

export const SANDBOX_ROUTE_REFUSAL = { error: 'Not available in this sandbox workspace' };

/**
 * Sandbox principals (`eval_*`) use the real customer portal and the real Emma, so
 * this is a DENYLIST, not an allowlist (Stripe test mode: the account works like a
 * live one; outbound side effects and account-shape mutations are off by default).
 * Denied classes:
 *   - connector OAuth for every provider (start/callback/connect) and connection
 *     mutation — the sandbox is pre-connected to a simulated Meta account and must
 *     never hold a real token; only reading the connection list stays open;
 *   - MCP OAuth 2.1 consent/token, MCP servers, agent API keys — no external client
 *     may act on the account and the account may not install tools;
 *   - Stripe and org routes — billing and tenancy are fixed at provisioning;
 *   - Featurebase identity, public share links, session transfer, Clarity replay
 *     registration — no identity or transcript leaves the sandbox;
 *   - the retired candidate surface (/api/evaluation) and /api/admin (defense in depth).
 * Everything else falls through to the route's own authorization.
 */
const CONNECTED_ACCOUNTS_READ = /^\/api\/oauth\/connected-accounts(\/[^/]+)*\/?$/;
const DENIED: Array<{ methods?: string[]; pattern: RegExp }> = [
  { pattern: /^\/api\/oauth(\/|$)/ },
  { pattern: /^\/oauth(\/|$)/ },
  { pattern: /^\/\.well-known\/oauth-/ },
  { pattern: /^\/api\/mcp-oauth(\/|$)/ },
  { pattern: /^\/api\/(admin\/)?mcp-servers(\/|$)/ },
  { pattern: /^\/api\/v1\/agent(\/|$)/ },
  { pattern: /^\/api\/stripe(\/|$)/ },
  { pattern: /^\/api\/orgs?(\/|$)/ },
  { pattern: /^\/api\/featurebase(\/|$)/ },
  { methods: ['POST'], pattern: /^\/api\/agent-mode\/share\/?$/ },
  { pattern: /^\/api\/agent-mode\/session\/[^/]+\/transfer\/?$/ },
  { pattern: /^\/api\/settings\/replay-sessions\/?$/ },
  { pattern: /^\/api\/evaluation(\/|$)/ },
  { pattern: /^\/api\/admin(\/|$)/ },
];

export function isSandboxDeniedRoute(method: string, path: string): boolean {
  if (method === 'GET' && CONNECTED_ACCOUNTS_READ.test(path)) return false;
  return DENIED.some(rule => (!rule.methods || rule.methods.includes(method)) && rule.pattern.test(path));
}

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
  if (isSandboxDeniedRoute(req.method, req.path)) return res.status(403).json(SANDBOX_ROUTE_REFUSAL);
  return next();
}
