import { Router } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { signFeaturebaseIdentityJwt, getFeaturebaseCredentials, FEATUREBASE_ORG } from '../services/featurebaseService';
import { userDb } from '../services/db';

const router = Router();

/**
 * GET /api/featurebase/identity — mint a short-lived Featurebase Identity-Verification (SSO) JWT
 * for the logged-in user. The frontend passes the returned `jwt` to
 * `Featurebase("identify", { organization, featurebaseJwt })` so the embedded widget recognizes the
 * user and shows their OWN posts + private tickets — no separate Featurebase login.
 *
 * Under delegation, `req.user` is the TARGET customer (per auth middleware), so an admin acting on a
 * customer's behalf correctly identifies AS that customer.
 *
 * Returns 503 (not 500) when SSO isn't configured yet, so the widget degrades to anonymous rather
 * than the page erroring — a missing feedback identity must never break the app.
 */
router.get('/identity', authenticateToken, async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  if (!user?.userId || !user?.email) {
    return res.status(401).json({ message: 'Not authenticated' });
  }
  try {
    // The auth token carries only id + email; fetch the display name best-effort.
    let name: string | undefined;
    try {
      const rec = await userDb.getUserById(user.userId);
      name = rec?.displayName || undefined;
    } catch {
      /* name is optional — proceed without it */
    }

    const jwt = await signFeaturebaseIdentityJwt({ userId: user.userId, email: user.email, name });
    const { appId } = await getFeaturebaseCredentials();
    return res.json({ jwt, organization: FEATUREBASE_ORG, appId });
  } catch (e) {
    console.error('[featurebase/identity] mint failed:', e instanceof Error ? e.message : e);
    return res.status(503).json({ message: 'Featurebase identity unavailable' });
  }
});

export default router;
