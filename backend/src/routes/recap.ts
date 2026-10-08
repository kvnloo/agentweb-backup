/**
 * ENG-1100 — backend read paths for the ENG-711 "since you last logged in" recap.
 *
 * Self-service, caller-scoped, read-only. Every route:
 *   - authenticates (authenticateToken) and reads ONLY the caller's own data;
 *   - requires the existing Super Premium entitlement (subscriptionService), and
 *     refuses non-entitled callers with 403 rather than an empty success (AC2).
 *
 * Deliberately NOT here:
 *   - POST /api/crm/registration-status stays admin-only and unchanged (AC3). This
 *     route never accepts an email list — it resolves the caller's own email only,
 *     so it cannot be used for account enumeration.
 *   - `lastSeenAt` (AC1) is a new persisted AW-Users attribute and is held behind
 *     the database/data-plane approval gate; it ships in a separate slice.
 */
import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { scheduleDb, userDb } from '../services/db';
import { getUserSubscriptionType } from '../services/subscriptionService';

const router = express.Router();
router.use(authenticateToken);

export const RECAP_ENTITLED_TIER = 'Super Premium';
const MAX_RESULTS_PER_SCHEDULE = 50;

async function requireEntitledCaller(req: Request, res: Response): Promise<AuthenticatedRequest['user'] | null> {
  const user = (req as AuthenticatedRequest).user;
  if (!user?.userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return null;
  }
  const tier = await getUserSubscriptionType(user.userId);
  if (tier !== RECAP_ENTITLED_TIER) {
    res.status(403).json({ message: 'Recap requires a Super Premium subscription', code: 'RECAP_NOT_ENTITLED' });
    return null;
  }
  return user;
}

/** Parse `since` (ISO). Missing → no lower bound; invalid → null (caller returns 400). */
export function parseSince(raw: unknown): { ok: true; since: number | null } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, since: null };
  if (typeof raw !== 'string') return { ok: false };
  // Require a full ISO date-time with an explicit timezone, and a real calendar date
  // (Date.parse normalizes 2026-02-30 and treats zone-less values as server-local).
  const m = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!m) return { ok: false };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return { ok: false };
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? { ok: true, since: ms } : { ok: false };
}

function resultTime(r: any): number {
  const t = Date.parse(r?.completedAt || r?.executedAt || r?.timestamp || r?.createdAt || '');
  return Number.isFinite(t) ? t : NaN;
}

/** Bounded projection: only recap-relevant fields, never raw run payloads. */
export function projectRunResults(runResults: unknown, since: number | null) {
  const list = Array.isArray(runResults) ? runResults : [];
  return list
    .filter((r: any) => {
      if (since === null) return true;
      const t = resultTime(r);
      return Number.isFinite(t) && t >= since;
    })
    .slice(-MAX_RESULTS_PER_SCHEDULE)
    .map((r: any) => ({
      status: r?.status ?? null,
      at: r?.completedAt || r?.executedAt || r?.timestamp || r?.createdAt || null,
      sessionId: r?.sessionId ?? null,
    }));
}

/**
 * @route GET /api/recap/registration-status
 * @desc  The caller's OWN registration/conversion signal (AC3). No email input.
 */
router.get('/registration-status', async (req: Request, res: Response) => {
  try {
    const user = await requireEntitledCaller(req, res);
    if (!user) return;
    const [status] = await userDb.getRegistrationStatusByEmails([user.email]);
    if (!status) return res.status(404).json({ message: 'No registration record for caller' });
    // Never echo another account's id even if the email join were to resolve one.
    if (status.userId && status.userId !== user.userId) {
      return res.status(404).json({ message: 'No registration record for caller' });
    }
    return res.json({ status });
  } catch (error: any) {
    console.error('Error in GET /api/recap/registration-status:', error);
    return res.status(500).json({ message: 'Failed to resolve registration status' });
  }
});

/**
 * @route GET /api/recap/scheduled-activity?since=<ISO>
 * @desc  Run results for the caller's own schedules only (AC4).
 */
router.get('/scheduled-activity', async (req: Request, res: Response) => {
  try {
    const user = await requireEntitledCaller(req, res);
    if (!user) return;
    const parsed = parseSince(req.query.since);
    if (!parsed.ok) return res.status(400).json({ message: 'Invalid since; expected ISO timestamp' });

    const schedules = ((await scheduleDb.getSchedulesByUserId(user.userId)) || []) as any[];
    const activity = schedules
      // Defense in depth: the GSI query is by userId, but re-check ownership per row.
      .filter((s) => s && s.userId === user.userId)
      .map((s) => ({
        scheduleId: s.scheduleId,
        name: s.scheduleName ?? s.name ?? s.title ?? null,
        runResults: projectRunResults(s.runResults, parsed.since),
      }))
      .filter((s) => s.runResults.length > 0);
    return res.json({ since: parsed.since === null ? null : new Date(parsed.since).toISOString(), schedules: activity });
  } catch (error: any) {
    console.error('Error in GET /api/recap/scheduled-activity:', error);
    return res.status(500).json({ message: 'Failed to load scheduled activity' });
  }
});

/**
 * @route GET /api/recap/schedules/:scheduleId/run-results?since=<ISO>
 * @desc  One schedule's run results; fails closed (404) unless the caller owns it.
 */
router.get('/schedules/:scheduleId/run-results', async (req: Request, res: Response) => {
  try {
    const user = await requireEntitledCaller(req, res);
    if (!user) return;
    const parsed = parseSince(req.query.since);
    if (!parsed.ok) return res.status(400).json({ message: 'Invalid since; expected ISO timestamp' });

    const owned = ((await scheduleDb.getSchedulesByUserId(user.userId)) || []) as any[];
    const schedule = owned.find((s) => s?.scheduleId === req.params.scheduleId && s?.userId === user.userId);
    // 404 (not 403) so the response does not confirm another user's scheduleId exists.
    if (!schedule) return res.status(404).json({ message: 'Schedule not found' });

    const runResults = await scheduleDb.getRunResults(schedule.scheduleId);
    return res.json({ scheduleId: schedule.scheduleId, runResults: projectRunResults(runResults, parsed.since) });
  } catch (error: any) {
    console.error('Error in GET /api/recap/schedules/:scheduleId/run-results:', error);
    return res.status(500).json({ message: 'Failed to load run results' });
  }
});

export default router;
