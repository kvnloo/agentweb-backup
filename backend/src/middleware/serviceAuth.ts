import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

/**
 * Shared-secret authentication for internal service-to-service endpoints.
 *
 * POST /api/agent-mode/run-scheduled-chats is called by the Python
 * agent-engine (agent-engine/task_monitor.py), which has no user JWT. Auth is
 * a shared secret sent in the `x-service-secret` header and compared in
 * constant time (same helper pattern as routes/apolloWebhook.ts).
 *
 * Rollout safety (ENG-347): enforcement is gated on the env var being set.
 * If SCHEDULED_CHATS_SERVICE_SECRET is unset, requests pass through
 * unauthenticated (pre-ENG-347 behavior) and a warning is logged once per
 * process. This makes the deploy additive: the backend auto-deploys daily at
 * 02:00 UTC, while the agent-engine is manually deployed on a GCP VM — a
 * hard requirement would break every customer's scheduled chats at the next
 * backend deploy until someone touched the VM. Enforcement turns on the
 * moment the backend env var is set (after the agent-engine has it too).
 */

export const SERVICE_SECRET_HEADER = 'x-service-secret';
export const SCHEDULED_CHATS_SERVICE_SECRET_ENV = 'SCHEDULED_CHATS_SERVICE_SECRET';

/**
 * Constant-time secret check. Returns false for length mismatches without
 * leaking that information through compare timing — the compare still runs
 * (against `expected` twice) so both paths cost roughly the same.
 */
function safeSecretEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Spend ~the same time as the success path — the result is discarded.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

// The agent-engine polls run-scheduled-chats continuously; warn once per
// process, not once per request, so the rollout mode doesn't flood logs.
let warnedSecretUnset = false;

export function requireScheduledChatsServiceSecret(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const expected = process.env[SCHEDULED_CHATS_SERVICE_SECRET_ENV];

  if (!expected) {
    if (!warnedSecretUnset) {
      console.warn(
        `[serviceAuth] ${SCHEDULED_CHATS_SERVICE_SECRET_ENV} is not set — ` +
          'POST /api/agent-mode/run-scheduled-chats is accepting unauthenticated ' +
          'requests (pre-ENG-347 rollout mode). Set the env var on the ' +
          'agent-engine first, then on the backend, to enforce.'
      );
      warnedSecretUnset = true;
    }
    return next();
  }

  const provided = req.header(SERVICE_SECRET_HEADER);
  if (!provided || !safeSecretEquals(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}
