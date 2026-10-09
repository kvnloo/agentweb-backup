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
 * ENG-2315 adds the owner-facing "enable tracking" API on the same router:
 *
 *   POST /api/tracking/session-lists                     create a session list + its tracker config, return the embed tag
 *   PUT  /api/tracking/session-lists/:listId/config      update allowedOrigins / pageLabel / routing (ENG-2316) of a session list
 *
 * Auth is the ordinary user JWT (authenticateToken), applied inside this router so a future mount
 * cannot forget it. Deliberately NOT admin-only: the portal user is the one building their links.
 * The taxonomy is not tenant data, so no org/ownership scoping applies.
 */
import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { crmDb } from '../services/db';
import { canDestructiveCrmList, CRM_EDITOR_REQUIRED_MESSAGE } from '../services/crmAccessControl';
import { isSessionList } from '../utils/sessionList';
import { buildEmbedSnippet, createTrackerSessionList, SESSION_LIST_DISPLAY_FIELDS } from '../services/sessionTrackingService';
import {
  normalizeAllowedOrigins,
  normalizePageLabel,
  normalizeRouting,
  validateRoutingTargets,
  TrackingConfigError,
  type TrackingConfig,
} from '../utils/trackingConfig';
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

router.get('/channels', (_req: Request, res: Response): void => {
  res.json({ ...getTrafficTaxonomy(), taggedLinkPresets: listTaggedLinkPresets(), maxBulkRows: MAX_BULK_ROWS });
});

router.post('/tagged-links', (req: Request, res: Response): void => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ code: 'invalid_rows', message: 'JSON object body required' });
    return;
  }
  try {
    // allowedHosts is shape-checked inside buildTaggedLink (per row in bulk), so a bad value is a 400/row error.
    const allowedHosts = body.allowedHosts;
    if (body.rows !== undefined) {
      const defaults = body.defaults && typeof body.defaults === 'object' && !Array.isArray(body.defaults) ? body.defaults : {};
      const results = buildTaggedLinks(body.rows, { ...(defaults as Partial<TaggedLinkInput>), ...(allowedHosts !== undefined ? { allowedHosts } : {}) });
      const failed = results.filter((r) => !r.ok).length;
      res.json({ results, summary: { total: results.length, ok: results.length - failed, failed } });
      return;
    }
    res.json({ link: buildTaggedLink(body as TaggedLinkInput) });
  } catch (err) {
    if (err instanceof TaggedLinkError) {
      res.status(400).json({ code: err.code, message: err.message });
      return;
    }
    console.error('tracking tagged-links error:', (err as Error)?.message ?? err);
    res.status(500).json({ message: 'Failed to build tagged link' });
  }
});

// ─── ENG-2315: enable tracking ──────────────────────────────────────────────────────────

// Extracted to services/sessionTrackingService.ts (ENG-2327) so landing pages share it; re-exported unchanged.
export { SESSION_LIST_DISPLAY_FIELDS, buildEmbedSnippet };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Unknown keys are a 400, not ignored: a typo like "allowedOrigin" must not silently leave the list deny-all. */
function rejectUnknownKeys(body: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new TrackingConfigError('unknown_field', `unknown field "${k}"`);
  }
}

function sendConfigError(res: Response, err: unknown, label: string): void {
  if (err instanceof TrackingConfigError) {
    res.status(400).json({ code: err.code, message: err.message });
    return;
  }
  console.error(`${label}:`, (err as Error)?.message ?? err);
  res.status(500).json({ message: 'Failed to update tracking configuration' });
}

router.post('/session-lists', async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }
  try {
    const body = req.body;
    if (!isPlainObject(body)) throw new TrackingConfigError('invalid_body', 'JSON object body required');
    rejectUnknownKeys(body, ['name', 'allowedOrigins', 'pageLabel']);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) throw new TrackingConfigError('invalid_name', 'name is required (at most 100 characters)');
    const allowedOrigins = normalizeAllowedOrigins(body.allowedOrigins);
    // A session list with no origin allows no browser at all; creating one that way is never what was meant.
    if (allowedOrigins.length === 0) throw new TrackingConfigError('origins_required', 'at least one allowed origin is required');
    const pageLabel = normalizePageLabel(body.pageLabel);

    const trackingConfig: TrackingConfig = { allowedOrigins, ...(pageLabel ? { pageLabel } : {}) };
    const list = await createTrackerSessionList(userId, name, trackingConfig);
    res.status(201).json({ list, trackingConfig, embedSnippet: buildEmbedSnippet(list.listId) });
  } catch (err) {
    sendConfigError(res, err, 'tracking create session list error');
  }
});

router.put('/session-lists/:listId/config', async (req: Request, res: Response): Promise<void> => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }
  try {
    const list = await crmDb.getLeadListById(req.params.listId);
    if (!list) {
      res.status(404).json({ message: 'Lead list not found' });
      return;
    }
    // canDestructiveCrmList = list owner, org owner or a listed CRM editor, regardless of the org's
    // crm sharing toggle: exactly the gate PUT /api/crm/lists/:listId uses for list settings. This
    // config decides which sites may write rows into the list, so it is edit-level (canAccessCrmList
    // is read-level and would let any org viewer widen the allow-list).
    if (!(await canDestructiveCrmList(userId, list))) {
      res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE });
      return;
    }
    if (!isSessionList(list)) {
      res.status(400).json({ code: 'not_session_list', message: 'Tracking can only be configured on a session list' });
      return;
    }

    const body = req.body;
    if (!isPlainObject(body)) throw new TrackingConfigError('invalid_body', 'JSON object body required');
    rejectUnknownKeys(body, ['allowedOrigins', 'pageLabel', 'routing']);
    if (Object.keys(body).length === 0) throw new TrackingConfigError('empty_update', 'nothing to update');

    const current: Partial<TrackingConfig> = (list as any).trackingConfig && typeof (list as any).trackingConfig === 'object' ? (list as any).trackingConfig : {};
    const next: TrackingConfig = {
      ...current,
      allowedOrigins: body.allowedOrigins !== undefined ? normalizeAllowedOrigins(body.allowedOrigins) : (Array.isArray(current.allowedOrigins) ? current.allowedOrigins : []),
    };
    if (body.pageLabel !== undefined) {
      const label = normalizePageLabel(body.pageLabel);
      if (label) next.pageLabel = label; else delete next.pageLabel;
    }

    if (body.routing !== undefined) {
      // null / [] clears routing. A non-empty array is validated shape-first, then against the lists it names.
      const rules = body.routing === null ? [] : normalizeRouting(body.routing);
      if (rules.length > 0) {
        const children = new Map<string, Record<string, any> | null>();
        const getChild = async (id: string) => {
          if (!children.has(id)) children.set(id, ((await crmDb.getLeadListById(id)) as Record<string, any> | null | undefined) ?? null);
          return children.get(id);
        };
        await validateRoutingTargets(list as { listId: string; userId: string }, rules, getChild);
        // Copying sessions into a list is writing to it: the caller must be able to edit every child too,
        // not merely the parent (otherwise a parent-editor could fill a list they cannot touch).
        for (const rule of rules) {
          if (!(await canDestructiveCrmList(userId, children.get(rule.childListId) as Record<string, any>))) {
            res.status(403).json({ message: CRM_EDITOR_REQUIRED_MESSAGE, code: 'routing_child_forbidden', childListId: rule.childListId });
            return;
          }
        }
        // No chains, other direction: this list must not already be a CHILD of another list's routing.
        // Read via the existing userId-index (children share the owner). Eventually consistent, and the
        // ingest only ever fans out ONE level from the list the event was posted to, so a race here
        // can mis-configure but can never loop.
        const owned = await crmDb.getLeadListsByUserId(list.userId);
        const parent = owned.find((l: any) => l.listId !== list.listId && Array.isArray(l.trackingConfig?.routing) && l.trackingConfig.routing.some((r: any) => r?.childListId === list.listId));
        if (parent) throw new TrackingConfigError('routing_is_child', `this list is already a routing target of list ${parent.listId} (chains are not allowed)`);
        next.routing = rules;
      } else {
        delete next.routing;
      }
    }

    const updated = await crmDb.updateLeadList(list.listId, { trackingConfig: next });
    res.json({ trackingConfig: (updated as any)?.trackingConfig ?? next, embedSnippet: buildEmbedSnippet(list.listId) });
  } catch (err) {
    sendConfigError(res, err, 'tracking update config error');
  }
});

export default router;
