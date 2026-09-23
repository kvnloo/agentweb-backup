import { Router } from 'express';
import axios from 'axios';
import { rateLimit } from 'express-rate-limit';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { userDb, orgDb } from '../services/db';
import { canInOrg } from '../services/orgAuthz';
import { decryptPassword } from '../utils/crypto';
import { getGoogleDriveConfig } from '../config/integrations';
import { inspectSource } from '../services/sourceAccessInventory';

const router = Router();
router.use(authenticateToken);
router.use(rateLimit({ windowMs: 60000, limit: 12, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => (req as AuthenticatedRequest).user!.userId,
}));

// No caller-supplied org or user IDs: credentials are resolved from fresh membership.
router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const user = userId ? await userDb.getUserById(userId) : null;
    const org = user?.orgId ? await orgDb.getOrgById(user.orgId) : null;
    if (!user || !org || !canInOrg({ userId: user.userId, orgId: user.orgId, orgRole: user.orgRole }, org, 'org:accounts:read')) {
      return res.status(403).json({ error: 'Organization admin access required' });
    }
    // Reject targeting parameters rather than silently ignoring a cross-org request.
    if (Object.keys(req.query).some(key => key !== 'source')) {
      return res.status(400).json({ error: 'Invalid inventory request' });
    }
    type Source = { id: string; provider: 'clickup' | 'google_drive'; identity: string | null; scope: string; config?: Record<string, unknown> };
    const sources: Source[] = [];
    if (typeof org.secrets?.clickup_access_token === 'string') {
      sources.push({ id: 'clickup', provider: 'clickup', identity: null, scope: 'Organization' });
    }
    const collect = (accounts: unknown, ownerId: string, own: boolean) => {
      if (!Array.isArray(accounts)) return;
      for (const account of accounts) {
        if (!account || account.platform !== 'google_drive' || typeof account.account_id !== 'string' ||
            !account.config || typeof account.config !== 'object' || Array.isArray(account.config) ||
            (!own && account.sharedWithOrg !== true)) continue;
        sources.push({ id: JSON.stringify([ownerId, account.account_id]), provider: 'google_drive',
          identity: typeof account.config.email === 'string' ? account.config.email : null,
          scope: ownerId === org.orgId || account.sharedWithOrg === true ? 'Organization' : 'Your account', config: account.config });
      }
    };
    collect(org.connected_accounts, org.orgId, true);
    collect(user.connected_accounts, user.userId, true);
    for (const member of await orgDb.getOrgMembers(org.orgId)) {
      if (member.orgId === org.orgId && member.userId !== user.userId) collect(member.connected_accounts, member.userId, false);
    }
    if (req.query.source === undefined) {
      return res.json({ sources: sources.map(({ config, ...safe }) => safe) });
    }
    const source = sources.find(s => s.id === req.query.source);
    if (!source) return res.status(404).json({ error: 'Source not found' });
    let token: string;
    if (source.provider === 'clickup') {
      token = decryptPassword(org.secrets!.clickup_access_token).password;
    } else {
      const cfg = source.config!;
      if (typeof cfg.access_token !== 'string' || !cfg.access_token) throw new Error('Missing token');
      token = cfg.access_token;
      if (typeof cfg.token_expires_at !== 'number' || cfg.token_expires_at < Date.now() + 60000) {
        if (typeof cfg.refresh_token !== 'string' || !cfg.refresh_token) throw new Error('Expired token');
        const app = await getGoogleDriveConfig();
        // In-memory refresh only: this read-only inventory never mutates stored connections.
        const refreshed = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
          client_id: app.clientId, client_secret: app.clientSecret, refresh_token: cfg.refresh_token, grant_type: 'refresh_token',
        }), { timeout: 5000, maxRedirects: 0, maxContentLength: 16384 });
        if (typeof refreshed.data?.access_token !== 'string' || !refreshed.data.access_token) throw new Error('Token refresh failed');
        token = refreshed.data.access_token;
      }
    }
    const inventory = await inspectSource(source.provider, token);
    console.info('[Source access inventory]', { orgId: org.orgId, userId, provider: source.provider, count: inventory.items.length, complete: inventory.complete });
    return res.json(inventory);
  } catch {
    // Never expose tokens, upstream payloads or axios error/config objects.
    return res.status(502).json({ error: 'Unable to check source access' });
  }
});
export default router;
