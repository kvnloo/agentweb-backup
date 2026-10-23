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
import { escapeHtml } from '../emma/impl/shared/htmlEscaping';

/** Request header the review page sends the capability token in (never the URL). */
export const REVIEW_TOKEN_HEADER = 'X-Review-Token';

/** Sentinel asset URL for "send the session's inline contentHtml". */
export const INLINE_HTML_ASSET = '__inline_html__';

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

// The WHATWG `input[type=email]` grammar — the same check the review page's
// recipient field applies in the browser. Rejects lists, display names, quotes,
// whitespace and header-breaking characters.
const RECIPIENT_EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidRecipientEmail(value: string): boolean {
  return value.length <= 254 && RECIPIENT_EMAIL_PATTERN.test(value);
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

const BUTTON_STYLE =
  'background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;';

function assetBlockFor(assetUrl: string, resultLabel: string): string {
  const url = escapeHtml(assetUrl);
  if (assetUrl.match(/\.(png|jpg|jpeg|gif|webp)$/i) || assetUrl.includes('image')) {
    return `<p style="text-align: center;"><img src="${url}" alt="${escapeHtml(resultLabel)}" style="max-width: 100%; border-radius: 8px;" /></p>`;
  }
  const label = assetUrl.match(/\.(mp4|webm|mov)$/i) || assetUrl.includes('video') ? 'Watch Video' : 'View Your Result';
  return `
        <div style="text-align: center; margin: 20px 0;">
          <a href="${url}"
             style="${BUTTON_STYLE}">
            ${label}
          </a>
        </div>`;
}

/**
 * The AgentWeb-branded "your result is ready" email sent to a lead, by the
 * reviewer (POST /review/:sessionId/send) or automatically (skipReview).
 * Every interpolated value is escaped; `inlineHtml` is the session's own
 * generated content (the thing being delivered) and is inserted as-is.
 * A non-http(s) `assetUrl` renders no asset block.
 */
export function buildResultDeliveryEmailHtml(opts: {
  resultLabel: string;
  replyTo: string;
  assetUrl?: string;
  inlineHtml?: string;
  customMessage?: string;
}): string {
  const label = escapeHtml(opts.resultLabel);
  const replyTo = escapeHtml(opts.replyTo);
  let assetBlock = '';
  if (opts.inlineHtml !== undefined) {
    assetBlock = opts.inlineHtml;
  } else if (opts.assetUrl && isHttpUrl(opts.assetUrl)) {
    assetBlock = assetBlockFor(opts.assetUrl, opts.resultLabel);
  }
  const customMessageBlock = opts.customMessage && opts.customMessage.trim()
    ? `<div style="background: #fff; padding: 20px; border-radius: 6px; border-left: 4px solid #643B7E; margin: 20px 0;">
           <p style="margin: 0; color: #333; line-height: 1.6; white-space: pre-wrap;">${escapeHtml(opts.customMessage)}</p>
         </div>`
    : '';

  return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
          <p style="color: #666; margin: 5px 0;">${label}</p>
        </div>

        <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1B2549; margin-top: 0;">Your ${label} is Ready!</h2>
          <p style="color: #333; line-height: 1.6;">
            We're excited to send you the requested ${label}. Our team has prepared this content specifically for you.
          </p>

          ${customMessageBlock}

          ${assetBlock}

          <p style="color: #333; line-height: 1.6; margin-top: 20px;">
            If you have any questions or would like to request changes, simply reply to this email or reach out to us at
            <a href="mailto:${replyTo}" style="color: #643B7E; text-decoration: none;">${replyTo}</a>
            and we'll be happy to assist.
          </p>
        </div>

        <div style="text-align: center; color: #666; font-size: 12px;">
          <p>Powered by <a href="https://agentweb.pro" style="color: #643B7E; text-decoration: none;">AgentWeb</a></p>
        </div>
      </div>`;
}
