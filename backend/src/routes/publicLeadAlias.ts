import type express from 'express';

/**
 * ENG-2657: customer sites embedding /emma-forms.js POST to /api/leads/public/:listId.
 * Alias it onto /api/webhooks/forward-lead (same per-list publicAccessEnabled gate) by
 * moving the path param into body.listId; the path param wins over any body value.
 *
 * Lives here rather than inline in app.ts so a route test can mount the exact alias the
 * server mounts (ENG-2837 asserts idempotency through both paths).
 */
export const PUBLIC_LEAD_ALIAS_PATH = /^\/api\/leads\/public\/([^\/]+)\/?$/;

export function publicLeadAlias(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  const listId = (req.params as Record<string, string>)[0];
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  req.body = { ...body, listId };
  req.url = '/api/webhooks/forward-lead';
  next();
}
