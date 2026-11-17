/**
 * ENG-2496 — HTTP surface for Zoma device-flow onboarding. Logic lives in
 * mcp/zomaDeviceFlow.ts; this file maps HTTP <-> flow and throttles per IP.
 *
 *   POST /api/zoma/setup              (unauthenticated) start; RFC 8628 device authorization response
 *                                     optional `ref` (body or query, /^[a-z0-9_-]{1,64}$/) for attribution
 *   POST /api/zoma/setup/poll         {device_code[, ads_experience]} -> RFC errors, then next_step + link, then the token once
 *   POST /api/zoma/ads-experience     ENG-3128 "How familiar are you with ads?" form submit
 *   GET  /api/zoma/activate           verification page; ?user_code= -> AgentWeb sign-in + consent
 *   GET  /api/zoma/activate/callback  consent result; binds the device code, then continues the journey
 *   GET  /api/zoma/meta/callback      Meta OAuth result for a Zoma setup or an MCP user's zoma_status link (forwarded by /api/oauth/meta/callback)
 *   POST /api/zoma/meta/select        server-rendered ad-account picker submit
 *   GET  /api/zoma/google/callback    ENG-3135 Google Ads OAuth result for an MCP user's zoma_status link (forwarded by /api/oauth/google-ads/callback)
 *   POST /api/zoma/google/select      server-rendered Google Ads account picker submit
 *   GET  /api/zoma/continue           resume the journey from a signed link
 *   GET  /api/zoma/done               Stripe Checkout success/cancel return -> "You're set" (?mcp=1: zoma_status card link)
 *   POST /api/zoma/token/revoke       Authorization: Bearer zoma_... -> revoked (idempotent)
 *
 * None of these read the browser's AgentWeb session: the setup's user always comes from the
 * device item (bound at approval), named by a signed state/link.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { rateLimiter } from '../middleware/rateLimiter';
import {
  answerAdsExperience,
  beginVerification,
  completeMetaConnect,
  completeVerification,
  continueInBrowser,
  defaultZomaDeviceFlowDeps,
  finishPayment,
  pollSetup,
  resumeInBrowser,
  revokeZomaToken,
  selectMetaAccounts,
  startSetup,
  type BrowserStep,
  type ZomaDeviceFlowDeps,
} from '../mcp/zomaDeviceFlow';
import { completeGoogleConnect, defaultZomaGoogleDeps, selectGoogleAccounts, type ZomaGoogleDeps } from '../mcp/zomaGoogleConnect';
import { logZomaSetup } from '../mcp/zomaSetupLog';

export const ZOMA_SETUP_MAX_PER_MINUTE = 10;
export const ZOMA_POLL_MAX_PER_MINUTE = 60;
export const ZOMA_ACTIVATE_MAX_PER_MINUTE = 20;

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

// Browsers enforce form-action on the redirect chain a form submit starts, and the picker's
// submit continues on to Stripe Checkout (or back to Meta), so that page allows those hops.
const PICKER_FORM_ACTION = "'self' https://checkout.stripe.com https://www.facebook.com";

function page(res: Response, status: number, title: string, body: string, formAction = "'self'") {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}`);
  // Not no-referrer: under that policy browsers send `Origin: null` on the picker's form POST, and
  // the global CORS check rejects it with 403 Forbidden. same-origin still never leaks a referrer
  // off api.agentweb.pro (to Meta or Stripe).
  res.setHeader('Referrer-Policy', 'same-origin');
  return res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;line-height:1.5}` +
        `label{display:block;margin:.4rem 0}a.button{display:inline-block;margin-top:.5rem}` +
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

function renderStep(res: Response, step: BrowserStep, req?: Request) {
  if (step.kind === 'redirect') return res.redirect(req?.method === 'POST' ? 303 : 302, step.url);
  if (step.kind === 'ask_ads_experience') {
    const options = step.options
      .map(
        (o, i) =>
          `<label><input type="radio" name="answer" value="${escapeHtml(o.value)}"${i === 0 ? ' required' : ''}> ${escapeHtml(o.label)}</label>`,
      )
      .join('');
    return page(
      res,
      200,
      step.question,
      (step.message ? `<p><strong>${escapeHtml(step.message)}</strong></p>` : '<p>So Zoma can set you up the right way.</p>') +
        `<form method="post" action="${escapeHtml(step.action)}"><input type="hidden" name="t" value="${escapeHtml(step.token)}">${options}` +
        `<p><button type="submit">Continue</button></p></form>`,
      // A "runs_ads" answer continues on to Meta (or Stripe) from this submit.
      PICKER_FORM_ACTION,
    );
  }
  if (step.kind === 'pick_account') {
    const options = step.accounts
      .map(
        (a, i) =>
          `<label><input type="checkbox" name="account_id" value="${escapeHtml(a.account_id)}"${i === 0 ? ' checked' : ''}> ` +
          `${escapeHtml(a.name || a.account_id)} <small>(${escapeHtml(a.account_id)}${a.currency ? `, ${escapeHtml(a.currency)}` : ''})</small></label>`,
      )
      .join('');
    return page(
      res,
      200,
      'Choose your ad account',
      (step.message ? `<p><strong>${escapeHtml(step.message)}</strong></p>` : '<p>Pick the Meta ad account(s) Zoma should manage.</p>') +
        `<form method="post" action="${escapeHtml(step.action)}"><input type="hidden" name="t" value="${escapeHtml(step.token)}">${options}` +
        `<p><button type="submit">Continue</button></p></form>`,
      PICKER_FORM_ACTION,
    );
  }
  const retry = step.retryUrl ? `<p><a class="button" href="${escapeHtml(step.retryUrl)}">${escapeHtml(step.retryLabel ?? 'Try again')}</a></p>` : '';
  const steps = step.steps?.length ? `<ol>${step.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '';
  return page(res, step.status, step.title, `<p>${escapeHtml(step.message)}</p>${steps}${retry}`);
}

function failPage(res: Response, step: string, error: unknown) {
  logZomaSetup({ step, outcome: 'error', reason: error });
  return page(res, 500, 'Zoma setup', '<p>Something went wrong. Try again in a moment, or ask your agent to start Zoma setup again.</p>');
}

export function createZomaRouter(deps: ZomaDeviceFlowDeps = defaultZomaDeviceFlowDeps, googleDeps: ZomaGoogleDeps = defaultZomaGoogleDeps): Router {
  const router = Router();

  router.post('/setup', throttle('setup', ZOMA_SETUP_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      // ENG-2906: optional attribution ref (body or ?ref=); invalid values are dropped, never rejected.
      return res.json(await startSetup(deps, { ref: req.body?.ref ?? req.query.ref }));
    } catch (error) {
      logZomaSetup({ step: 'setup_started', outcome: 'error', reason: error });
      return res.status(500).json({ error: 'server_error', error_description: 'Could not start Zoma setup.' });
    }
  });

  router.post('/setup/poll', throttle('poll', ZOMA_POLL_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await pollSetup(req.body?.device_code, deps, { adsExperience: req.body?.ads_experience });
      return res.status(result.status).json(result.body);
    } catch (error) {
      logZomaSetup({ step: 'poll', outcome: 'error', reason: error });
      return res.status(500).json({ error: 'server_error', error_description: 'Could not check Zoma setup right now; poll again.' });
    }
  });

  router.get('/activate', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    if (req.query.user_code === undefined) return page(res, 200, 'Set up Zoma', codeForm());
    try {
      const start = await beginVerification(req.query.user_code, deps);
      if (!start.ok) return page(res, 400, 'Set up Zoma', codeForm(start.message));
      return res.redirect(302, start.redirect);
    } catch (error) {
      return failPage(res, 'activate_visited', error);
    }
  });

  router.get('/activate/callback', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      const result = await completeVerification({ code: req.query.code, state: req.query.state, error: req.query.error }, deps);
      if (!result.ok) return page(res, 400, 'Zoma setup', `<p>${escapeHtml(result.message)}</p>`);
      // Approved: go straight on to the next unfinished step (Meta, then payment) in this browser.
      return renderStep(res, await continueInBrowser(result.deviceId, deps));
    } catch (error) {
      return failPage(res, 'approval', error);
    }
  });

  router.get('/meta/callback', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      const q = req.query;
      return renderStep(res, await completeMetaConnect({ code: q.code, state: q.state, error: q.error, error_reason: q.error_reason }, deps));
    } catch (error) {
      return failPage(res, 'meta_callback', error);
    }
  });

  router.post('/meta/select', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      return renderStep(res, await selectMetaAccounts({ t: req.body?.t, account_id: req.body?.account_id }, deps), req);
    } catch (error) {
      return failPage(res, 'meta_connect', error);
    }
  });

  router.get('/google/callback', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      const q = req.query;
      return renderStep(res, await completeGoogleConnect({ code: q.code, state: q.state, error: q.error }, googleDeps));
    } catch (error) {
      return failPage(res, 'google_callback', error);
    }
  });

  router.post('/google/select', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      return renderStep(res, await selectGoogleAccounts({ t: req.body?.t, account_id: req.body?.account_id }, googleDeps), req);
    } catch (error) {
      return failPage(res, 'google_connect', error);
    }
  });

  router.post('/ads-experience', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      return renderStep(res, await answerAdsExperience({ t: req.body?.t, answer: req.body?.answer }, deps), req);
    } catch (error) {
      return failPage(res, 'ads_experience', error);
    }
  });

  router.get('/continue', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      return renderStep(res, await resumeInBrowser(req.query.t, deps));
    } catch (error) {
      return failPage(res, 'continue', error);
    }
  });

  router.get('/done', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    try {
      const q = req.query;
      return renderStep(res, await finishPayment({ t: q.t, session_id: q.session_id, canceled: q.canceled, mcp: q.mcp }, deps));
    } catch (error) {
      return failPage(res, 'checkout_completed', error);
    }
  });

  router.post('/token/revoke', throttle('activate', ZOMA_ACTIVATE_MAX_PER_MINUTE), async (req: Request, res: Response) => {
    const match = (req.headers.authorization ?? '').match(/^Bearer\s+(\S+)\s*$/i);
    if (!match) return res.status(401).json({ error: 'Send the Zoma token as Authorization: Bearer <token>.' });
    try {
      await revokeZomaToken(match[1], deps);
      // RFC 7009 §2.2: unknown tokens are not an error, so the response never confirms existence.
      return res.json({ revoked: true });
    } catch (error) {
      logZomaSetup({ step: 'token_revoked', outcome: 'error', reason: error });
      return res.status(500).json({ error: 'Could not revoke the token right now.' });
    }
  });

  return router;
}

export default createZomaRouter();
