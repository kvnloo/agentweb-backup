/**
 * External-user identity resolution — the part the vendor's own prompt flags
 * as "the part to get exactly right."
 *
 * Two ways in, both ending at the same raw AgentWeb userId (never the AF
 * `ext:`-prefixed form, which only appears on the minted token's `sub` claim):
 *
 *   1. forUserFromRequest(req)               — session-derived, for live HTTP requests
 *   2. forUserRaw(rawUserId)                 — explicit, for workers/cron/webhooks
 *
 * NEVER derive the id from model output, a tool argument, or any
 * client-supplied value — including every query parameter on the OAuth
 * callback (attacker-controlled browser redirect). This module has no code
 * path that reads req.query, req.body, or a tool-call argument for identity.
 */

import { AgenticFabriqIdentityError } from './errors';

/** Shape this module knows how to pull a userId out of — matches AuthenticatedRequest. */
export interface RequestLike {
  user?: { userId?: string } | null;
  state?: { userId?: string } | null;
  session?: { userId?: string } | null;
  auth?: { userId?: string } | null;
}

/**
 * Resolves the external user id from OUR OWN auth session — never from the
 * request body, query string, or headers. Throws AgenticFabriqIdentityError
 * (callers map this to 401) when no session identity is present, per the
 * vendor's rule: "if the id cannot be resolved, fail the request with 401."
 */
export function forUserFromRequest(req: RequestLike): string {
  const candidates = [req.user?.userId, req.state?.userId, req.session?.userId, req.auth?.userId];
  const resolved = candidates.find((c) => typeof c === 'string' && c.trim().length > 0);
  if (!resolved) {
    throw new AgenticFabriqIdentityError(
      'No authenticated session identity found. Refusing to resolve an Agentic Fabriq external ' +
      'user id from any other source (query params, body, tool args are never trusted for identity).',
    );
  }
  return resolved;
}

/**
 * Explicit escape hatch for workers/cron/queue consumers/webhook handlers that
 * have no live HTTP session to read. Named `dangerously*` deliberately — per
 * the vendor's own guidance, the point is to stand out in code review, not to
 * be forbidden. A bare positional string is refused: this must be the ONLY
 * call shape, forcing the caller to name what they're doing at each call site.
 */
export function forUserDangerouslyUsingRawUserId(input: { dangerouslyUseRawUserId: string }): string {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof (input as any).dangerouslyUseRawUserId !== 'string' ||
    Object.keys(input).length !== 1
  ) {
    // TypeError, not our own error class — matches the vendor's own contract:
    // "A bare positional string must raise TypeError."
    throw new TypeError(
      'forUserDangerouslyUsingRawUserId requires exactly {dangerouslyUseRawUserId: "<id>"} — ' +
      'a bare positional string (or any other shape) is refused so this call stands out in review.',
    );
  }
  const raw = input.dangerouslyUseRawUserId.trim();
  if (!raw) {
    throw new TypeError('forUserDangerouslyUsingRawUserId: dangerouslyUseRawUserId must be a non-empty string.');
  }
  return raw;
}

/**
 * A webhook's `subject_user` is trustworthy ONLY because the delivery's HMAC
 * signature already verified (caller's responsibility — see webhookVerify.ts).
 * This is a thin, self-documenting wrapper so a call site can't accidentally
 * treat an unverified payload's subject_user as identity.
 */
export function forUserFromVerifiedWebhook(verifiedSubjectUser: string): string {
  return forUserDangerouslyUsingRawUserId({ dangerouslyUseRawUserId: verifiedSubjectUser });
}
