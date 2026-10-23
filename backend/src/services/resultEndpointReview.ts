/**
 * ENG-2650: access control and email rendering for the result-endpoint review
 * page (`/review/:sessionId`, the `reviewRouter` in routes/resultEndpoints.ts).
 *
 * Result-endpoint sessions are owned by an anonymous `anon_<uuid>` user, so the
 * only legitimate readers of a review are the configured reviewer (who receives
 * the link from `send_for_review`, emma/impl/workPlans.ts) and real admins.
 * Before ENG-2650 the routes trusted the session id alone, and the session id
 * also travels to the lead (the trigger response and the `/r/:name/:sessionId`
 * status page), so anyone holding it could read the lead's email, mint the
 * conversable iShare link and send AgentWeb-branded email to any address.
 *
 * The reviewer capability is an HMAC of the session id under a key derived from
 * JWT_SECRET (the same derivation pattern as agentMode/modelComparison.ts). It is
 * stateless: every review email issued for a session carries the same token, no
 * new field is persisted, and verification is a constant-time compare. Rotating
 * JWT_SECRET invalidates every outstanding review link (admins can still open
 * them while signed in).
 */
import { createHmac, timingSafeEqual } from 'crypto';
import { getJwtSecret } from '../config/jwt';

/** Request header the review page sends the capability token in (never the URL). */
export const REVIEW_TOKEN_HEADER = 'X-Review-Token';

const REVIEW_TOKEN_KEY_LABEL = 'agentweb:result-endpoint-review-link:v1';
// base64url of a 32-byte HMAC-SHA256 digest, unpadded.
const REVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function reviewTokenKey(): Buffer {
  return createHmac('sha256', getJwtSecret()).update(REVIEW_TOKEN_KEY_LABEL).digest();
}

export function signReviewToken(sessionId: string): string {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('sessionId is required to sign a review token');
  }
  return createHmac('sha256', reviewTokenKey()).update(sessionId).digest('base64url');
}

/** Constant-time; tolerates a caller-supplied value of any type. Fails closed. */
export function verifyReviewToken(sessionId: string, supplied: unknown): boolean {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  if (typeof supplied !== 'string' || !REVIEW_TOKEN_PATTERN.test(supplied)) return false;
  const expected = Buffer.from(signReviewToken(sessionId), 'utf8');
  const given = Buffer.from(supplied, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The reviewer link. The token rides in the URL fragment so it is never sent to
 * the portal's host, CDN or page-view analytics; the review page reads it from
 * `location.hash` and forwards it to the API in the REVIEW_TOKEN_HEADER header.
 */
export function buildReviewUrl(customerFrontendUrl: string, sessionId: string): string {
  const base = customerFrontendUrl.replace(/\/+$/, '');
  return `${base}/review/${encodeURIComponent(sessionId)}#token=${signReviewToken(sessionId)}`;
}
