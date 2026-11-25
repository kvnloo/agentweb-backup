import express from 'express';
import { authenticateToken } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';
import { activationCsv, buildActivationReport, type ActivationUser } from '../services/zomaActivationEvents';

export interface ProgressStore {
  listZomaActivationUsers(cursor?: { email: string }): Promise<{ users: ActivationUser[]; cursor?: Record<string, any> }>;
  getUserById(id: string): Promise<ActivationUser | undefined>;
}
export function createActivationReportRouter(store?: ProgressStore) {
  const router = express.Router();
  router.get('/zoma/activation-progress', authenticateToken, isAdmin, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let cursor: { email: string } | undefined;
    const rawHours = req.query.stuckAfterHours;
    if (rawHours !== undefined && typeof rawHours !== 'string') return res.status(400).json({ error: 'stuckAfterHours must be 1..8760' });
    const hours = rawHours === undefined ? 24 : Number(rawHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 8760) return res.status(400).json({ error: 'stuckAfterHours must be 1..8760' });
    if (req.query.format !== undefined && !['json', 'csv'].includes(req.query.format as string)) return res.status(400).json({ error: 'format must be json or csv' });
    if (req.query.userId !== undefined && (typeof req.query.userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(req.query.userId))) return res.status(400).json({ error: 'Invalid userId' });
    try {
      if (req.query.cursor !== undefined) {
        if (typeof req.query.cursor !== 'string' || req.query.cursor.length > 2048 || req.query.userId) throw new Error();
        const decoded = JSON.parse(Buffer.from(req.query.cursor, 'base64url').toString());
        if (!decoded || Object.keys(decoded).length !== 1 || typeof decoded.email !== 'string' || decoded.email.length > 320 || !decoded.email) throw new Error();
        cursor = { email: decoded.email };
      }
    } catch { return res.status(400).json({ error: 'Invalid cursor' }); }
    try {
      const db: ProgressStore = store ?? require('../services/db').userDb;
      const page = req.query.userId ? { users: [await db.getUserById(req.query.userId as string)].filter(Boolean) as ActivationUser[], cursor: undefined } : await db.listZomaActivationUsers(cursor);
      if (req.query.userId && !page.users.length) return res.status(404).json({ error: 'User not found' });
      const report = buildActivationReport(page.users, Date.now(), hours);
      const nextCursor = page.cursor ? Buffer.from(JSON.stringify(page.cursor)).toString('base64url') : null;
      // CSV is explicitly one page too; clients follow X-Next-Cursor until absent.
      res.setHeader('X-Report-Scope', 'page');
      if (nextCursor) res.setHeader('X-Next-Cursor', nextCursor);
      if (req.query.format === 'csv') return res.type('text/csv').attachment('zoma-activation-progress.csv').send(activationCsv(report.rows));
      return res.json({ ...report, scope: 'page', nextCursor, hasMore: !!nextCursor, trackingEnabled: process.env.ZOMA_ACTIVATION_EVENTS_ENABLED === 'true', cohort: 'account lifecycle; Zoma engagement begins at onboarding_started' });
    } catch (error: any) {
      const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(error.code) ? error.code : 'unknown';
      console.warn('[zoma-activation] progress report unavailable', code);
      return res.status(503).json({ error: 'Activation progress unavailable' });
    }
  });
  return router;
}
export default createActivationReportRouter();
