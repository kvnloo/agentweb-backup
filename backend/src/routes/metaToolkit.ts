/**
 * ENG-2288 — HTTP surface for the Meta Toolkit (ENG-2268 child 4).
 *
 * Mounts the ENG-2283 gateway so an external agent can list and call the ENG-2282 manifest:
 *   GET  /api/meta-toolkit/tools              -> manifest (bearer auth required)
 *   POST /api/meta-toolkit/tools/:name/call   -> handleMetaToolkitCall
 * Auth, account resolution, write guards and metering all live in the gateway; this file only
 * maps HTTP <-> gateway and errors -> status codes. No new storage.
 */
import { Router, type Request, type Response } from 'express';
import {
  authenticateMetaToolkitCaller,
  handleMetaToolkitCall,
  MetaToolkitAuthError,
} from '../mcp/metaToolkitGateway';
import { getMetaToolkitManifest, MetaToolkitRefusal } from '../mcp/metaToolkitManifest';
import { rateLimiter } from '../middleware/rateLimiter';

/** Per-IP request ceiling, applied before bearer auth so unauthenticated floods are throttled too. */
export const META_TOOLKIT_MAX_PER_MINUTE = 60;

export function sendMetaToolkitError(res: Response, error: unknown) {
  if (error instanceof MetaToolkitAuthError) {
    if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({ error: error.message });
  }
  if (error instanceof MetaToolkitRefusal) {
    return res.status(400).json({ error: error.message });
  }
  console.error('[meta-toolkit] call failed:', error instanceof Error ? error.message : error);
  return res.status(500).json({ error: 'Meta Toolkit call failed.' });
}

const router = Router();

router.use((req: Request, res: Response, next) => {
  const result = rateLimiter.check(`meta-toolkit:${req.ip ?? 'unknown'}`, META_TOOLKIT_MAX_PER_MINUTE);
  if (!result.allowed) {
    res.setHeader('Retry-After', String(Math.ceil(result.resetInMs / 1000)));
    return res.status(429).json({ error: 'Too many Meta Toolkit requests. Try again shortly.' });
  }
  return next();
});

router.get('/tools', async (req: Request, res: Response) => {
  try {
    await authenticateMetaToolkitCaller(req.headers.authorization);
    return res.json({ tools: getMetaToolkitManifest() });
  } catch (error) {
    return sendMetaToolkitError(res, error);
  }
});

router.post('/tools/:name/call', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const result = await handleMetaToolkitCall({
      authorization: req.headers.authorization,
      toolName: req.params.name,
      args: body.args && typeof body.args === 'object' ? body.args : {},
      sessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
      userAgent: req.get('user-agent') ?? undefined,
    });
    return res.json({ result });
  } catch (error) {
    return sendMetaToolkitError(res, error);
  }
});

export default router;
