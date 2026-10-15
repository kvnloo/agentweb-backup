/**
 * ENG-2496 — HTTP surface for Zoma device-flow onboarding. Logic lives in
 * mcp/zomaDeviceFlow.ts; this file maps HTTP <-> flow and throttles per IP.
 *
 *   POST /api/zoma/setup              (unauthenticated) start; RFC 8628 device authorization response
 *   POST /api/zoma/setup/poll         {device_code} -> RFC errors, then next_step + link, then the token once
 *   GET  /api/zoma/activate           verification page; ?user_code= -> AgentWeb sign-in + consent
 *   GET  /api/zoma/activate/callback  consent result; binds the device code to the signed-in user
 *   POST /api/zoma/token/revoke       Authorization: Bearer zoma_... -> revoked (idempotent)
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { rateLimiter } from '../middleware/rateLimiter';
import {
  beginVerification,
  completeVerification,
  pollSetup,
  revokeZomaToken,
  startSetup,
} from '../mcp/zomaDeviceFlow';

export const ZOMA_SETUP_MAX_PER_MINUTE = 10;
export const ZOMA_POLL_MAX_PER_MINUTE = 60;
export const ZOMA_ACTIVATE_MAX_PER_MINUTE = 20;

const router = Router();

function throttle(bucket: string, maxPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = rateLimiter.check(`zoma-${bucket}:${req.ip ?? 'unknown'}`, maxPerMinute);
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.resetInMs / 1000))));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    return next();
  };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function page(res: Response, status: number, title: string, body: string) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
  return res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}` +
        `input{font-size:1.25rem;letter-spacing:.15em;text-transform:uppercase;padding:.4rem;width:10rem}button{font-size:1rem;padding:.45rem 1rem}</style></head>` +
        `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    );
}

function codeForm(message?: string) {
  return (
    (message ? `<p>${escapeHtml(message)}</p>` : '<p>Enter the code your agent showed you to connect Zoma to your AgentWeb account.</p>') +
    `<form method="get" action="activate"><input name="user_code" placeholder="XXXX-XXXX" autocomplete="off" autofocus required> <button type="submit">Continue</button></form>`
  );
}

router.post('/setup', throttle('setup', ZOMA_SETUP_MAX_PER_MINUTE), async (_req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await startSetup());
  } catch (error) {
    console.error('[zoma] setup failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'server_error', error_description: 'Could not start Zoma setup.' });
  }
});

router.post('/setup/poll', throttle('poll', ZOMA_POLL_MAX_PER_MINUTE), async (req: Request, res: Response) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const result = await pollSetup(req.body?.device_code);
    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error('[zoma] poll failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'server_error', error_description: 'Could not check Zoma setup right now; poll again.' });
  }
});

router.get('/activate', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
  if (req.query.user_code === undefined) return page(res, 200, 'Set up Zoma', codeForm());
  try {
    const start = await beginVerification(req.query.user_code);
    if (!start.ok) return page(res, 400, 'Set up Zoma', codeForm(start.message));
    return res.redirect(302, start.redirect);
  } catch (error) {
    console.error('[zoma] activate failed:', error instanceof Error ? error.message : error);
    return page(res, 500, 'Set up Zoma', '<p>Something went wrong. Try again in a moment.</p>');
  }
});

router.get('/activate/callback', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
  try {
    const result = await completeVerification({ code: req.query.code, state: req.query.state, error: req.query.error });
    return page(res, result.ok ? 200 : 400, result.ok ? 'Zoma approved' : 'Zoma setup', `<p>${escapeHtml(result.message)}</p>`);
  } catch (error) {
    console.error('[zoma] activate callback failed:', error instanceof Error ? error.message : error);
    return page(res, 500, 'Zoma setup', '<p>Something went wrong. Ask your agent to start Zoma setup again.</p>');
  }
});

router.post('/token/revoke', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
  const match = (req.headers.authorization ?? '').match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return res.status(401).json({ error: 'Send the Zoma token as Authorization: Bearer <token>.' });
  try {
    await revokeZomaToken(match[1]);
    // RFC 7009 §2.2: unknown tokens are not an error, so the response never confirms existence.
    return res.json({ revoked: true });
  } catch (error) {
    console.error('[zoma] revoke failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'Could not revoke the token right now.' });
  }
});

export default router;
