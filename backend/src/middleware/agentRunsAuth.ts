import { Request, Response, NextFunction, RequestHandler } from 'express';
import { timingSafeEqual } from 'crypto';
import { authenticateToken } from './auth';
import { isAdmin } from './admin';

/**
 * Narrow, read-only auth for `GET /api/admin/agent-runs` (D78).
 *
 * `AW_AGENT_ADMIN_JWT` (D61) is a full 90-day admin LOGIN SESSION token — the backend re-reads the
 * user from the DB per request, so it carries that account's whole privilege set (~195 admin
 * handlers, ~108 state-changing) even though `.aw-agent/lib/adminapi.mjs` only ever makes ONE
 * read-only call with it: this route, filtered to a single `sessionId`, `limit=3`. This middleware
 * is a dedicated credential scoped to exactly that call, in the shared-secret pattern of
 * `middleware/serviceAuth.ts` — a static header secret, compared in constant time, that fails
 * closed rather than validating a session.
 *
 * THE ADMIN UI STILL USES THIS ROUTE. `partner-portal/src/pages/AgentRunsInspector.tsx` calls the
 * same endpoint with a real admin's JWT, unfiltered by `sessionId`, to browse arbitrary runs. So
 * this cannot simply replace `authenticateToken, isAdmin` — it has to sit ahead of that pair and
 * decide which path a request is taking:
 *
 *   - `x-aw-agent-runs-secret` header present: this is the narrow credential's path. The secret
 *     must match exactly (wrong or unconfigured -> fail closed, 401/503) — a valid admin JWT sent
 *     alongside is never consulted and can never substitute for a wrong or missing secret. On a
 *     match, the request is additionally narrowed server-side to what `adminapi.mjs` actually
 *     asks for (a `sessionId`, `limit` capped at 3) before reaching the route handler directly,
 *     bypassing `authenticateToken`/`isAdmin` entirely.
 *   - No header: unchanged behaviour — falls through to `authenticateToken`, `isAdmin`, exactly as
 *     mounted in app.ts before this existed, so the admin UI is untouched.
 *
 * `AW_AGENT_ADMIN_JWT` is left in place (not removed, not scrubbed from the env file) — this is a
 * new path alongside the old one, not a replacement of it.
 */

export const AGENT_RUNS_SECRET_HEADER = 'x-aw-agent-runs-secret';
export const AW_AGENT_RUNS_SECRET_ENV = 'AW_AGENT_RUNS_SECRET';

/**
 * `.aw-agent/lib/adminapi.mjs` (`ADMIN_API.path` query) requests exactly `limit=3` — the fetcher
 * only ever wants the most recent run for one session, "more than one run for a session is a
 * retry" is its own comment for why even 2 would sometimes matter. 3 matches what the caller
 * already sends, so capping there doesn't change its behaviour, and it also matches D78's own
 * recommended cap. Enforced here (not trusted from the query string) so the secret can never be
 * used to page through more than that, however the caller asks.
 */
export const AGENT_RUNS_SECRET_MAX_LIMIT = 3;

let warnedSecretUnset = false;
function warnSecretUnset() {
  if (warnedSecretUnset) return;
  console.error(
    `[agentRunsAuth] ${AGENT_RUNS_SECRET_HEADER} header was sent but ${AW_AGENT_RUNS_SECRET_ENV} ` +
      'is not set on this server — failing CLOSED (503) rather than falling through to admin auth.'
  );
  warnedSecretUnset = true;
}

/** Test-only: let tests re-trigger the once-per-process warn log. */
export function __resetAgentRunsSecretWarnForTests() {
  warnedSecretUnset = false;
}

/** Constant-time compare; false (not a throw) on a length mismatch, spending comparable time either way. */
function safeSecretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function firstString(value: unknown): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v : undefined;
}

/**
 * Narrow an already-secret-authenticated request in place to the one shape `adminapi.mjs` uses:
 * a required `sessionId` and a `limit` clamped (never raised) to `AGENT_RUNS_SECRET_MAX_LIMIT`.
 * `runId`/`userId` are dropped — the secret authenticates a "read this one session" call, not the
 * open-ended browsing the admin UI's own JWT-authenticated path still allows.
 */
function narrowToSessionLookup(req: Request, res: Response): boolean {
  const sessionId = firstString(req.query.sessionId)?.trim();
  if (!sessionId) {
    res.status(400).json({ error: 'sessionId is required when authenticating with the agent-runs secret' });
    return false;
  }
  req.query.sessionId = sessionId;
  delete (req.query as Record<string, unknown>).runId;
  delete (req.query as Record<string, unknown>).userId;

  const rawLimit = firstString(req.query.limit);
  const n = rawLimit !== undefined ? Number(rawLimit) : NaN;
  const capped = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), AGENT_RUNS_SECRET_MAX_LIMIT) : AGENT_RUNS_SECRET_MAX_LIMIT;
  req.query.limit = String(capped);
  return true;
}

/**
 * Builds the gate mounted in front of `agentRunsRoutes`. Takes the downstream router as a
 * parameter (rather than importing it) so the gate's own branching can be unit tested against a
 * stub handler, independent of the route's DynamoDB logic.
 */
export function authenticateAgentRunsSecretOrAdmin(agentRunsRouter: RequestHandler): RequestHandler {
  return function agentRunsGate(req: Request, res: Response, next: NextFunction) {
    const provided = req.header(AGENT_RUNS_SECRET_HEADER);

    if (provided) {
      const expected = process.env[AW_AGENT_RUNS_SECRET_ENV]?.trim();
      if (!expected) {
        warnSecretUnset();
        return res.status(503).json({ error: 'Service temporarily unavailable' });
      }
      // Fail closed: a present-but-wrong secret is rejected outright. It never falls through to
      // authenticateToken/isAdmin below — a regular admin session is not an accepted substitute.
      if (!safeSecretEquals(provided, expected)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      // The secret covers the run list only. Sub-routes such as /trace return tool arguments and
      // results, so they stay behind a real admin session.
      if (req.path !== '/') {
        return res.status(403).json({ error: 'The agent-runs secret only covers the run list' });
      }
      if (!narrowToSessionLookup(req, res)) return; // response already sent (400)
      return agentRunsRouter(req, res, next);
    }

    // No secret header: unchanged behaviour, the admin UI's own JWT-authenticated path.
    // authenticateToken/isAdmin are invoked directly (not via a second app.use entry), so their
    // own "next" must be wired to actually reach the router on success — Express's own `next` here
    // would just fall off the end of this middleware with nothing registered after it.
    return authenticateToken(req, res, (err?: unknown) => {
      if (err) return next(err);
      return isAdmin(req, res, (err2?: unknown) => {
        if (err2) return next(err2);
        return agentRunsRouter(req, res, next);
      });
    });
  };
}
