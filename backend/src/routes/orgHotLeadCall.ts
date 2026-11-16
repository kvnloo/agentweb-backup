import express, { type Request, type Response } from 'express';
import { orgDb, userDb, type Organization } from '../services/db';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  confirmMemberVerification, getHotLeadCallSettings, previewHotLeadCallSettings, startMemberVerification, updateHotLeadCallSettings,
  REST_SETTINGS_KEYS, type HotLeadCallCaller,
} from '../services/hotLeadCallSettingsService';
import { MEMBER_ID } from '../services/hotLeadCallConfig';
import { isRecord } from '../services/leadNotificationAttribution';
import {
  ConflictError, ForbiddenError, NotEntitledError, NotFoundError, ProviderError, RateLimitedError, RevisionRequiredError,
  StoredStateInvalidError, ValidationError, VerificationCodeError,
} from '../services/hotLeadCallErrors';

/**
 * Org-scoped hot-lead-call settings for the portal (mounted at /api/orgs/me/hot-lead-call). The org comes from the
 * caller's persisted user record, never from the URL or body, and every route needs org:configure, which the
 * service enforces. Phones leave only masked. Error bodies are `{error}`, plus the fields the portal reads.
 */
const router = express.Router();

// JSON.stringify(body).length, so characters of JSON text rather than bytes: a cap against absurd bodies, not a byte quota.
const MAX_BODY_JSON_CHARS = 32 * 1024;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

async function loadCaller(req: Request): Promise<{ org: Organization; caller: HotLeadCallCaller } | null> {
  const userId = (req as AuthenticatedRequest).user?.userId;
  const user = userId ? await userDb.getUserById(userId) : null;
  if (!userId || !user?.orgId) return null;
  // Consistent read: the revision handed to the portal must be the one a write will be checked against.
  const org = await orgDb.getOrgById(user.orgId, undefined, true);
  if (!org) return null;
  return { org, caller: { userId, orgRole: typeof user.orgRole === 'string' ? user.orgRole : undefined } };
}

function sendError(res: Response, err: unknown, what: string): Response {
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message, ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) });
  if (err instanceof NotEntitledError) return res.status(403).json({ error: err.message, code: 'not_entitled' });
  if (err instanceof ForbiddenError) return res.status(403).json({ error: err.message });
  if (err instanceof NotFoundError) return res.status(404).json({ error: err.message });
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message });
  if (err instanceof RevisionRequiredError) return res.status(428).json({ error: err.message });
  if (err instanceof RateLimitedError) {
    return res.status(429).set('Retry-After', String(err.retryAfterSeconds)).json({ error: err.message, retryAfterSeconds: err.retryAfterSeconds });
  }
  if (err instanceof VerificationCodeError) return res.status(400).json({ error: err.message, attemptsLeft: err.attemptsLeft });
  if (err instanceof ProviderError) return res.status(502).json({ error: err.message });
  if (err instanceof StoredStateInvalidError) {
    console.error(`[hotLeadCall] ${what}: ${err.message}`);
    return res.status(500).json({ error: 'Your hot lead call settings could not be read. Contact support.' });
  }
  console.error(`[hotLeadCall] ${what} failed:`, err instanceof Error ? err.name : 'error');
  return res.status(500).json({ error: `Failed to ${what}` });
}


router.get('/', async (req, res) => {
  try {
    const ctx = await loadCaller(req);
    if (!ctx) return res.status(404).json({ error: 'No organization' });
    return res.json(await getHotLeadCallSettings(ctx.org, ctx.caller));
  } catch (err) {
    return sendError(res, err, 'load the hot lead call settings');
  }
});

router.put('/', async (req, res) => {
  try {
    const ctx = await loadCaller(req);
    if (!ctx) return res.status(404).json({ error: 'No organization' });
    const body: unknown = req.body;
    if (!isRecord(body)) return res.status(400).json({ error: 'A settings object is required' });
    if (JSON.stringify(body).length > MAX_BODY_JSON_CHARS) return res.status(400).json({ error: 'The settings are too large' });
    const unknown = Object.keys(body).filter(k => !(REST_SETTINGS_KEYS as readonly string[]).includes(k));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown setting: ${unknown[0]}`, fieldErrors: Object.fromEntries(unknown.map(k => [k, 'Unknown field'])) });
    }
    return res.json(await updateHotLeadCallSettings(ctx.org, ctx.caller, body));
  } catch (err) {
    return sendError(res, err, 'save the hot lead call settings');
  }
});

// An id that cannot be one is simply not a member.
const memberIdOf = (req: Request): string | null => (MEMBER_ID.test(req.params.memberId) ? req.params.memberId : null);

router.post('/members/:memberId/verification/start', async (req: Request, res: Response) => {
  try {
    const ctx = await loadCaller(req);
    if (!ctx) return res.status(404).json({ error: 'No organization' });
    const memberId = memberIdOf(req);
    if (!memberId) return res.status(404).json({ error: 'That team member does not exist.' });
    const { expiresInSeconds, nextStartAllowedInSeconds, startsLeftToday } = await startMemberVerification(ctx.org, ctx.caller, memberId);
    return res.json({ expiresInSeconds, nextStartAllowedInSeconds, startsLeftToday });
  } catch (err) {
    return sendError(res, err, 'start the verification');
  }
});

router.post('/members/:memberId/verification/confirm', async (req: Request, res: Response) => {
  try {
    const ctx = await loadCaller(req);
    if (!ctx) return res.status(404).json({ error: 'No organization' });
    const memberId = memberIdOf(req);
    if (!memberId) return res.status(404).json({ error: 'That team member does not exist.' });
    const body: unknown = req.body;
    if (!isRecord(body) || Object.keys(body).some(k => k !== 'code')) return res.status(400).json({ error: 'Send {code} with the 6 digits', attemptsLeft: 0 });
    await confirmMemberVerification(ctx.org, ctx.caller, memberId, body.code);
    return res.json({ verified: true });
  } catch (err) {
    return sendError(res, err, 'confirm the verification');
  }
});

router.get('/preview', async (req, res) => {
  try {
    const ctx = await loadCaller(req);
    if (!ctx) return res.status(404).json({ error: 'No organization' });
    const raw = req.query.at;
    let at = new Date();
    if (raw !== undefined) {
      at = typeof raw === 'string' && ISO_INSTANT.test(raw) ? new Date(raw) : new Date(NaN);
      if (isNaN(at.getTime())) return res.status(400).json({ error: 'at must be an ISO-8601 time such as 2026-10-20T15:00:00Z', fieldErrors: { at: 'Not an ISO-8601 time' } });
    }
    return res.json(await previewHotLeadCallSettings(ctx.org, ctx.caller, at));
  } catch (err) {
    return sendError(res, err, 'preview who would be called');
  }
});

export default router;
