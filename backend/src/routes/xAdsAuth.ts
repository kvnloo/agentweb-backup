/**
 * ENG-3142 — X (Twitter) Ads OAuth 1.0a connect routes (logic in mcp/zomaXAdsConnect.ts).
 *
 *   GET /api/oauth/x-ads/start?t=<signed link from zoma_status>  → redirect to X authorize
 *   GET /api/oauth/x-ads/callback?oauth_token&oauth_verifier     → store connection, result page
 *
 * Both 404 while ZOMA_X_ADS_ENABLED is off. The callback URL must be registered on X app 33152933.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { rateLimiter } from '../middleware/rateLimiter';
import { completeXAdsConnect, defaultZomaXAdsConnectDeps, startXAdsConnect, type XConnectStep, type ZomaXAdsConnectDeps } from '../mcp/zomaXAdsConnect';

export const X_ADS_AUTH_MAX_PER_MINUTE = 20;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function send(res: Response, step: XConnectStep) {
  if (step.kind === 'redirect') return res.redirect(302, step.url);
  return res
    .status(step.status)
    .type('html')
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(step.title)}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px"><h1>${escapeHtml(step.title)}</h1><p>${escapeHtml(step.body)}</p></body></html>`);
}

export function createXAdsAuthRouter(deps: () => ZomaXAdsConnectDeps = defaultZomaXAdsConnectDeps) {
  const router = Router();
  router.use((req: Request, res: Response, next: NextFunction) => {
    const result = rateLimiter.check(`x-ads-auth:${req.ip ?? 'unknown'}`, X_ADS_AUTH_MAX_PER_MINUTE);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.resetInMs / 1000))));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    return next();
  });

  const handle = (run: (req: Request) => Promise<XConnectStep>) => async (req: Request, res: Response) => {
    try {
      return send(res, await run(req));
    } catch (error) {
      console.error('[x-ads-auth] connect failed:', error instanceof Error ? error.message : error);
      return send(res, { kind: 'page', status: 502, title: 'X Ads connect failed', body: 'X did not complete the connection. Go back to your agent and ask it for a fresh connect link.' });
    }
  };

  router.get('/start', handle((req) => startXAdsConnect(req.query.t, deps())));
  router.get('/callback', handle((req) => completeXAdsConnect(req.query as any, deps())));
  return router;
}

export default createXAdsAuthRouter();
