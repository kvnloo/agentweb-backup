/**
 * ENG-2313 (S3): traffic-source taxonomy + tagged-link generator for the portal.
 *
 *   GET  /api/tracking/channels       the channel taxonomy (keys, groups, display names, utm_source per platform)
 *   POST /api/tracking/tagged-links   build ONE link ({ baseUrl, platform, campaign, ... })
 *                                     or MANY ({ rows: [...], defaults?: {...} }, <= 200 rows)
 *
 * Pure and non-persisting: both handlers only call utils/trafficSource.ts and utils/taggedLink.ts.
 * No DynamoDB, no outbound requests, nothing stored — a link is a string we hand back.
 *
 * Auth is the ordinary user JWT (authenticateToken), applied inside this router so a future mount
 * cannot forget it. Deliberately NOT admin-only: the portal user is the one building their links.
 * The taxonomy is not tenant data, so no org/ownership scoping applies.
 */
import express, { Request, Response } from 'express';
import { authenticateToken } from '../middleware/auth';
import { getTrafficTaxonomy } from '../utils/trafficSource';
import {
  buildTaggedLink,
  buildTaggedLinks,
  listTaggedLinkPresets,
  MAX_BULK_ROWS,
  TaggedLinkError,
  type TaggedLinkInput,
} from '../utils/taggedLink';

const router = express.Router();

router.use(authenticateToken);

const MAX_ALLOWED_HOSTS = 20;

router.get('/channels', (_req: Request, res: Response): void => {
  res.json({ ...getTrafficTaxonomy(), taggedLinkPresets: listTaggedLinkPresets(), maxBulkRows: MAX_BULK_ROWS });
});

function readAllowedHosts(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ALLOWED_HOSTS || value.some((h) => typeof h !== 'string' || h.length > 253)) {
    throw new TaggedLinkError('invalid_base_url', `allowedHosts must be an array of up to ${MAX_ALLOWED_HOSTS} hostnames`);
  }
  return value as string[];
}

router.post('/tagged-links', (req: Request, res: Response): void => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ code: 'invalid_rows', message: 'JSON object body required' });
    return;
  }
  try {
    const allowedHosts = readAllowedHosts(body.allowedHosts);
    if (body.rows !== undefined) {
      const defaults = body.defaults && typeof body.defaults === 'object' && !Array.isArray(body.defaults) ? body.defaults : {};
      const results = buildTaggedLinks(body.rows, { ...(defaults as Partial<TaggedLinkInput>), ...(allowedHosts ? { allowedHosts } : {}) });
      const failed = results.filter((r) => !r.ok).length;
      res.json({ results, summary: { total: results.length, ok: results.length - failed, failed } });
      return;
    }
    const { allowedHosts: _ignored, ...input } = body;
    res.json({ link: buildTaggedLink({ ...(input as TaggedLinkInput), ...(allowedHosts ? { allowedHosts } : {}) }) });
  } catch (err) {
    if (err instanceof TaggedLinkError) {
      res.status(400).json({ code: err.code, message: err.message });
      return;
    }
    console.error('tracking tagged-links error:', (err as Error)?.message ?? err);
    res.status(500).json({ message: 'Failed to build tagged link' });
  }
});

export default router;
