/**
 * ENG-2782 S1 — public "Get started in Slack" intake API.
 * Mounted at /api/onboarding/slack-start (app.ts). Unauthenticated by design;
 * the per-intake capability is the bearer `intakeToken` (see slackStartService).
 *
 * CORS is handled HERE, not by app.ts's credentialed allowlist: the widget is
 * embedded on marketing sites, so the policy is an explicit origin allowlist
 * WITHOUT credentials (the API never reads cookies). app.ts skips its global
 * cors() for this prefix. Allowlist = AgentWeb's own sites + any exact origins
 * in SLACK_START_ALLOWED_ORIGINS (comma-separated), plus localhost when
 * NODE_ENV=development.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import type { SlackStartDeps, SlackStartService, ServiceResult } from '../services/slackStart/slackStartService';

const ALLOWED_HEADERS = 'Content-Type, Authorization, Idempotency-Key';

const BUILTIN_ORIGIN_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)?hireemma\.ai$/,
  /^https:\/\/([a-z0-9-]+\.)?agentweb\.pro$/,
];

export function isSlackStartOriginAllowed(origin: string, extra: string[], env: Record<string, string | undefined> = process.env): boolean {
  if (extra.includes(origin)) return true;
  if (BUILTIN_ORIGIN_PATTERNS.some((p) => p.test(origin))) return true;
  return env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function slackStartCors(allowedOrigins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    res.vary('Origin');
    if (origin && isSlackStartOriginAllowed(origin, allowedOrigins)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

const bearer = (req: Request): string | undefined => {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
};

const send = (res: Response, result: ServiceResult) => res.status(result.status).json(result.body);

const guard =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) =>
    fn(req, res).catch((err) => {
      console.error('[slack-start] unhandled error', { path: req.path, error: (err as Error)?.message });
      res.status(500).json({ code: 'internal_error' });
    });

export function createSlackStartRouter(service: SlackStartService, deps: Pick<SlackStartDeps, 'allowedOrigins'>) {
  const router = express.Router();
  router.use(slackStartCors(deps.allowedOrigins));
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get('/config', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    send(res, service.config());
  });

  router.post(
    '/',
    guard(async (req, res) => send(res, await service.start({ body: req.body, idempotencyKey: req.get('Idempotency-Key'), ip: req.ip }))),
  );
  router.get('/:intakeId', guard(async (req, res) => send(res, await service.read(req.params.intakeId, bearer(req)))));
  router.patch('/:intakeId', guard(async (req, res) => send(res, await service.answer(req.params.intakeId, bearer(req), req.body))));
  router.post(
    '/:intakeId/complete',
    guard(async (req, res) => send(res, await service.complete(req.params.intakeId, bearer(req)))),
  );
  return router;
}
