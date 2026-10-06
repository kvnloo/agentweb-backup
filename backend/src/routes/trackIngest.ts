/**
 * ENG-2315: the PUBLIC tracker surface.
 *
 *   POST /api/track/event   one event from the SDK (or any browser/server) for a SESSION list
 *
 * Anonymous and CORS-open by design (a landing page on any customer domain posts here), so the
 * trust model is explicit and layered, cheapest check first:
 *   1. body: <=16kb, parsed by trackBodyParser before the app-wide 50mb parser can see it;
 *   2. per IP+list rate limit that DROPS (429) — this endpoint only ever writes session rows, so
 *      dropping loses telemetry, never a lead (lead saves go through forward-lead, which has no limiter here);
 *   3. strict body parsing (utils/trackingIngest): allow-listed event, bounded fields, valid session identity;
 *   4. the list is resolved server-side from `listId` and must be a session list with public access ON
 *      (listType is set-once and server-owned: a body can never opt a list in);
 *   5. a browser's Origin must be in the list's trackingConfig.allowedOrigins (empty list = no browsers).
 *      A request WITHOUT an Origin header (a server, curl) is not a browser cross-site request and is
 *      allowed through steps 1-4 only; it can write nothing a browser could not, to a list whose id it knows.
 * It answers 204 and nothing else: the browser's beacon ignores the response, and an error body is
 * only ever a hint for a developer reading the network tab.
 */
import express, { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { crmDb } from '../services/db';
import { ingestTrackerEvent } from '../services/trackerIngestService';
import { isSessionList } from '../utils/sessionList';
import { parseIngestBody } from '../utils/trackingIngest';
import { isOriginAllowed, isPlausibleListId } from '../utils/trackingConfig';

export const MAX_INGEST_BODY = '16kb';
export const INGEST_RATE_WINDOW_MS = 60_000;
/** Events per IP per list per minute. A real visitor sends well under 30 a minute; 240 leaves room for a shared office/campus NAT. */
export const INGEST_RATE_LIMIT = 240;

export const setCors = (res: Response): void => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
};

/**
 * Parses the body for /api/track/event at 16kb, whatever Content-Type the browser used:
 * sendBeacon with a string/Blob sends text/plain, and a "simple" content type is what avoids a
 * CORS preflight. Mounted in app.ts BEFORE the global express.json({limit:'50mb'}) — body-parser
 * skips a request whose body is already parsed, which is what makes the 16kb limit the effective one.
 */
export const trackBodyParser: Array<express.RequestHandler | express.ErrorRequestHandler> = [
  express.json({ type: () => true, limit: MAX_INGEST_BODY }),
  (err: any, _req: Request, res: Response, next: NextFunction) => {
    if (!err) return next();
    setCors(res);
    if (err.type === 'entity.too.large') return void res.status(413).json({ success: false, code: 'payload_too_large' });
    return void res.status(400).json({ success: false, code: 'invalid_body' });
  },
];

export function createIngestRateLimiter(opts: { limit?: number; windowMs?: number } = {}): express.RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? INGEST_RATE_WINDOW_MS,
    limit: opts.limit ?? INGEST_RATE_LIMIT,
    standardHeaders: false,
    legacyHeaders: false,
    // req.ip honours `trust proxy` (app.ts: 2 hops), so it is the address the ALB saw — NOT the
    // first X-Forwarded-For hop, which a client can set to anything and so could never be a limiter key.
    keyGenerator: (req) => {
      const listId = isPlausibleListId(req.body?.listId) ? req.body.listId : '-';
      return `${ipKeyGenerator(req.ip ?? '')}|${listId}`;
    },
    handler: (_req, res) => {
      setCors(res);
      res.status(429).json({ success: false, code: 'rate_limited' });
    },
  });
}

export function createTrackIngestRouter(opts: { rateLimiter?: express.RequestHandler } = {}): express.Router {
  const router = express.Router();
  const limiter = opts.rateLimiter ?? createIngestRateLimiter();

  router.options('/event', (_req: Request, res: Response) => {
    setCors(res);
    res.status(204).end();
  });

  router.post('/event', (req, res, next) => { setCors(res); next(); }, limiter, async (req: Request, res: Response) => {
    try {
      const parsed = parseIngestBody(req.body, Date.now());
      if (!parsed.ok) {
        res.status(400).json({ success: false, code: parsed.code, message: parsed.message });
        return;
      }
      const { value } = parsed;

      const list = await crmDb.getLeadListById(value.listId);
      if (!list) {
        res.status(404).json({ success: false, code: 'list_not_found' });
        return;
      }
      // Both conditions from the row the DATABASE returned. Same message for both: whether a list
      // is a session list is not something an anonymous caller needs to learn.
      if (!isSessionList(list) || (list as any).publicAccessEnabled !== true) {
        res.status(403).json({ success: false, code: 'tracking_not_enabled' });
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined && (typeof origin !== 'string' || !isOriginAllowed((list as any).trackingConfig, origin))) {
        res.status(403).json({ success: false, code: 'origin_not_allowed' });
        return;
      }

      const xff = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim();
      await ingestTrackerEvent({
        list: list as Record<string, any>,
        parsed: value,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 512),
        visitorIp: xff || req.ip || '',
      });
      res.status(204).end();
    } catch (err: any) {
      // Never echo the error: it can carry a DynamoDB message. The SDK ignores the response anyway.
      console.error('[trackIngest] failed:', err?.message ?? err);
      res.status(500).json({ success: false, code: 'ingest_failed' });
    }
  });

  return router;
}

export default createTrackIngestRouter();
