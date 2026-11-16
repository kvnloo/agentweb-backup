import type { Request } from 'express';
import { getUserFromToken } from '../middleware/auth';

/**
 * ENG-2816: is the person on a share link the link's own owner?
 *
 * A share link runs the turn under the owner's userId, so the server cannot tell the owner from a visitor by the
 * session alone. The portal sends the viewer's login (when there is one) in the Authorization header; this
 * answers "is that login the owner's own?". True only for a normal user login that
 *  - verifies (signature, expiry, session version: the same `getUserFromToken` every authenticated route uses), and
 *  - belongs to `ownerUserId`, and
 *  - is not a delegate token (an admin acting as the owner is not the owner) and not a service self-call token.
 *
 * Every other case is false, and false means "treat as a visitor", exactly as before: a missing, malformed, expired,
 * revoked or someone else's login never produces an error here and never loosens anything. It can only
 * recognise the owner, never restrict one further.
 *
 * Takes the request itself (not just the header) so the verifier sees exactly what it sees on every other route.
 */
export async function isSessionOwnerRequest(req: Pick<Request, 'headers'>, ownerUserId: string): Promise<boolean> {
  const authorization = req.headers?.authorization;
  if (typeof authorization !== 'string' || !authorization || !ownerUserId) return false;
  try {
    const { user, decoded } = await getUserFromToken(req as Request);
    if (!user || !decoded) return false;
    if (decoded.delegateAccess || decoded._svc) return false;
    return user.userId === ownerUserId;
  } catch {
    return false;
  }
}
