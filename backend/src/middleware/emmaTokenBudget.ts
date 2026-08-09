/**
 * ENG-973 — token-quota enforcement for the `/api/emma/*` family.
 *
 * Why this exists as router-level middleware rather than a per-handler call:
 * this family is MCP's self-call surface (see the header of routes/emmaApi.ts),
 * and it grew to 59 routes without any of them checking quota. The gate the web
 * paths use lives in `controllers/agentModeController` and `controllers/chatbot`
 * — one layer ABOVE `services/agentModeService`, which is what these routes
 * delegate to. So "everything goes through agentModeService" delivered the tool
 * logic while skipping the guardrail.
 *
 * Adding 59 individual calls would reproduce the same failure the moment someone
 * adds route 60. Instead every route passes through one gate, classification is
 * explicit and declared, an unclassified route is treated as METERED, and a
 * contract test fails if a registered route has no entry here.
 *
 * Scope: this enforces the EXISTING monthly token meter. It is not usage-based
 * credits (ENG-249/ENG-668) and not per-vendor cost recording (ENG-695/666/698).
 */
import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';
import { checkTokenUsage } from '../services/tokenUsageService';

export type EmmaRouteBudget = 'metered' | 'exempt';

/**
 * Every route registered by routes/emmaApi.ts, classified.
 *
 * Key format is `${METHOD} ${path as declared on the router}` so the contract
 * test can compare this map against the router's own stack literally.
 *
 * `exempt` is deliberately narrow: reads a customer must still be able to make
 * while over quota, so they can see their own state and understand why work
 * stopped rather than facing a blank screen. Everything that performs work is
 * metered — including POST-shaped reads, which are gated because they are part
 * of Emma's working surface and because failing closed is the safe direction
 * for a bug whose symptom was unbounded spend.
 */
export const EMMA_ROUTE_BUDGET: Record<string, EmmaRouteBudget> = {
  // ─── Search & research ────────────────────────────────────────────────────
  'POST /you-search-web': 'metered',
  'POST /you-search-news': 'metered',
  'POST /google-search-web': 'metered',
  'POST /deep-research': 'metered',

  // ─── Knowledge base ───────────────────────────────────────────────────────
  'GET /knowledge-bases': 'exempt',
  'POST /search-knowledge-base': 'metered',
  'POST /search-ads-knowledge-base': 'metered',
  'POST /search-foreplay-discovery': 'metered',
  'POST /read-knowledge-base-files': 'metered',
  'POST /create-knowledge-base': 'metered',
  'POST /update-knowledge-base-file': 'metered',
  'POST /attach-knowledge-base-files': 'metered',

  // ─── Media generation ─────────────────────────────────────────────────────
  'POST /generate-image': 'metered',
  'POST /generate-video': 'metered',
  'POST /describe-media': 'metered',
  'POST /remove-c2pa': 'metered',

  // ─── Comms & social ───────────────────────────────────────────────────────
  'POST /email': 'metered',
  'POST /social-posts': 'metered',
  'POST /linkedin-outreach': 'metered',
  'POST /post-on-account': 'metered',
  'GET /connected-account-posts': 'exempt',
  'GET /connected-account-metrics': 'exempt',
  'POST /linkedin-comment': 'metered',
  'POST /linkedin-react': 'metered',

  // ─── Paid ads ─────────────────────────────────────────────────────────────
  'GET /meta-ads/campaigns': 'exempt',
  'POST /meta-ads/marketing-api': 'metered',
  'POST /meta-ads/insights': 'metered',
  'POST /meta-ads/metrics': 'metered',
  'POST /post-analytics': 'metered',
  'POST /data-analysis': 'metered',

  // ─── Files & HTML ─────────────────────────────────────────────────────────
  'POST /read-file': 'metered',
  'POST /read-page': 'metered',
  'POST /save-file': 'metered',
  'POST /create-html': 'metered',
  'GET /html-templates': 'exempt',
  'POST /create-html-from-template': 'metered',
  'POST /create-html-template': 'metered',
  'POST /update-html-file': 'metered',

  // ─── Books ────────────────────────────────────────────────────────────────
  'GET /books': 'exempt',
  'GET /books/:bookId': 'exempt',
  'GET /books/:bookId/content': 'exempt',
  'POST /books': 'metered',
  'PUT /books/:bookId/content': 'metered',
  'POST /books/:bookId/generate-content': 'metered',
  'POST /books/:bookId/outline': 'metered',
  'POST /books/:bookId/characters': 'metered',

  // ─── Work plans & tasks ───────────────────────────────────────────────────
  'POST /work-plans': 'metered',
  'PUT /work-plans': 'metered',
  // Status bookkeeping only (setWorkPlanStatus) — no model or vendor call. Left
  // open on purpose: if a run is cut off at the quota boundary, it must still be
  // able to record where it stopped, or work-plan state is stranded mid-flight.
  'PATCH /work-plans/status': 'exempt',
  'POST /send-for-review': 'metered',
  'GET /task-templates': 'exempt',
  'POST /task-from-template': 'metered',
  'POST /task-from-prompt': 'metered',
  'POST /image-task-from-prompt': 'metered',
  'POST /revision': 'metered',
  'GET /task-subscriber-metrics': 'exempt',
  'GET /task-subscriber-engagement': 'exempt',

  // ─── Leads, activity, misc ────────────────────────────────────────────────
  'POST /search-leads': 'metered',
  'GET /actions': 'exempt',
  'POST /repair-blog': 'metered',
};

/** Declared paths carry `:params`; requests carry values. Compile once. */
const MATCHERS: Array<{ method: string; pattern: RegExp; budget: EmmaRouteBudget }> = Object.entries(
  EMMA_ROUTE_BUDGET
).map(([key, budget]) => {
  const spaceAt = key.indexOf(' ');
  const method = key.slice(0, spaceAt);
  const declaredPath = key.slice(spaceAt + 1);
  const source =
    '^' +
    declaredPath
      .split('/')
      .map(segment =>
        segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      )
      .join('/') +
    '/?$';
  return { method, pattern: new RegExp(source), budget };
});

/**
 * Fail closed: a path with no declared entry is METERED. A new route that
 * nobody classified must not be free — that is exactly how this bug was created.
 */
export function classifyEmmaRoute(method: string, path: string): EmmaRouteBudget {
  const upper = method.toUpperCase();
  const match = MATCHERS.find(m => m.method === upper && m.pattern.test(path));
  return match ? match.budget : 'metered';
}

export async function requireEmmaTokenBudget(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (classifyEmmaRoute(req.method, req.path) === 'exempt') {
    next();
    return;
  }

  const user = (req as AuthenticatedRequest).user;
  if (!user?.userId) {
    // authenticateToken runs first and always populates this. If it is missing
    // the request is not attributable, so it cannot be metered — refuse rather
    // than let an unattributable caller spend.
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const usageStatus = await checkTokenUsage(user.userId);
    if (!usageStatus.allowed) {
      // Same contract as controllers/chatbot.ts:156-159, so an MCP caller that
      // runs out of quota is indistinguishable from a web caller that does.
      res.status(429).json({
        error: 'Monthly token limit reached. Please contact support or upgrade your plan.',
        tokenUsage: usageStatus,
      });
      return;
    }
    next();
  } catch (err) {
    // Deliberately not fail-open: if the meter cannot be read we surface the
    // error rather than silently restoring the bypass this fix exists to close.
    next(err);
  }
}
