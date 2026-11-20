/**
 * ENG-3163: guards for POST /api/agent-mode/ishare/:shareId/email-report.
 *
 * That endpoint is public on purpose: a landing page calls it so the visitor (the
 * lead) gets their own AI report by email. Holding a share link is all it needs,
 * so before this change anyone with a link could make AgentWeb send mail from our
 * sending domain to any address, with any "View Your Report" link in it, as often
 * as they liked (a spam/phishing relay).
 *
 * The lead flow is kept. What changes:
 *   1. The report link must be on a site we run (resolveReportUrl), and it is
 *      HTML-escaped where it goes into the email.
 *   2. The recipient must be one plain address (normalizeRecipient).
 *   3. Sends are limited per share link, per recipient address and per caller IP
 *      (checkEmailReportAllowed).
 */
import { RateLimiter } from '../middleware/rateLimiter';
import { escapeHtml } from '../emma/impl/shared/htmlEscaping';

const HOUR_MS = 60 * 60 * 1000;

export const ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR = 3;
export const ISHARE_EMAIL_REPORT_MAX_PER_RECIPIENT_PER_HOUR = 3;
// Deliberately loose: a landing page that calls this from its own server sends every
// lead from one IP. The per-link and per-address caps do the real limiting; this one
// only stops a single source from working through many links.
export const ISHARE_EMAIL_REPORT_MAX_PER_IP_PER_HOUR = 60;

const MAX_EMAIL_LENGTH = 254;
const MAX_REPORT_URL_LENGTH = 2048;

// One plain address: no whitespace, no list separators, no angle brackets, quotes,
// parentheses or backslashes (so no "Name <a@b>", no "a@b, c@d", no header tricks).
const PLAIN_EMAIL = /^[^\s@<>,;:"'()[\]\\]+@[^\s@<>,;:"'()[\]\\]+\.[^\s@<>,;:"'()[\]\\.]+$/;

export function normalizeRecipient(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  if (!PLAIN_EMAIL.test(email)) return null;
  return email;
}

/**
 * The hosts the API already trusts for browser calls (the CORS list in app.ts):
 * agentweb.pro and its subdomains, subdomains of agentwebforms.com, hireemma.ai
 * and its subdomains, plus the portal origins this environment is configured with.
 */
function isTrustedReportHost(url: URL, env: NodeJS.ProcessEnv): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:') {
    if (host === 'agentweb.pro' || host.endsWith('.agentweb.pro')) return true;
    if (host.endsWith('.agentwebforms.com')) return true;
    if (host === 'hireemma.ai' || host.endsWith('.hireemma.ai')) return true;
  }
  // Staging, env1 and local dev run the portals on their own origins.
  for (const configured of [env.FRONTEND_URL, env.CUSTOMER_FRONTEND_URL]) {
    if (!configured) continue;
    try {
      if (new URL(configured).origin === url.origin) return true;
    } catch {
      // A malformed env value never widens what is trusted.
    }
  }
  return false;
}

/**
 * Returns the normalised report link, or null if it is not a link we are willing
 * to put in an AgentWeb email. Normalising through URL also percent-encodes the
 * characters that could break out of an href attribute.
 */
export function resolveReportUrl(raw: unknown, env: NodeJS.ProcessEnv = process.env): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > MAX_REPORT_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  if (!isTrustedReportHost(url, env)) return null;
  return url.href;
}

export function buildReportEmail(reportUrl: string): { subject: string; text: string; html: string } {
  const safeUrl = escapeHtml(reportUrl);
  const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1B2549; margin: 0;">AgentWeb</h1>
            <p style="color: #666; margin: 5px 0;">Your AI-Powered Report</p>
          </div>

          <div style="background: #f8f9fa; padding: 30px; border-radius: 8px; margin-bottom: 20px;">
            <h2 style="color: #1B2549; margin-top: 0;">Your Report is Ready!</h2>
            <p style="color: #333; line-height: 1.6;">
              Your personalized AI analysis has been completed. Click below to view your full report.
            </p>

            <div style="text-align: center; margin: 20px 0;">
              <a href="${safeUrl}"
                 style="background: linear-gradient(90deg, #643B7E 0%, #6F3DFD 100%); color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
                View Your Report
              </a>
            </div>

            <p style="color: #333; line-height: 1.6; margin-top: 20px;">
              Want Emma to help you act on these insights?
              <a href="https://app.agentweb.pro/register" style="color: #643B7E; text-decoration: none;">Create your free account</a>
              and she'll walk you through fixing each issue step by step.
            </p>
          </div>

          <div style="text-align: center; color: #666; font-size: 12px;">
            <p>Powered by <a href="https://agentweb.pro" style="color: #643B7E; text-decoration: none;">AgentWeb</a></p>
          </div>
        </div>`;
  return {
    subject: 'Your AI Report is Ready — AgentWeb',
    text: `Your report is ready! View it here: ${reportUrl}`,
    html,
  };
}

// Created on first use so importing this module (the controller imports it) does
// not start a timer in every test or script that loads the controller.
let limiter: RateLimiter | undefined;
function getLimiter(): RateLimiter {
  if (!limiter) limiter = new RateLimiter(60_000, 50_000, HOUR_MS);
  return limiter;
}

/** Test hook: drop all counters. */
export function resetEmailReportLimiter(): void {
  limiter?.destroy();
  limiter = undefined;
}

export type EmailReportAllowance = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * Counts one send against the share link, the recipient address and the caller IP.
 * A refused attempt is not counted, so a blocked caller is not locked out longer
 * than the oldest send in the window.
 */
export function checkEmailReportAllowed(input: { shareId: string; recipient: string; ip?: string }): EmailReportAllowance {
  const l = getLimiter();
  const checks: Array<[string, number]> = [
    [`share:${input.shareId}`, ISHARE_EMAIL_REPORT_MAX_PER_SHARE_PER_HOUR],
    [`to:${input.recipient.toLowerCase()}`, ISHARE_EMAIL_REPORT_MAX_PER_RECIPIENT_PER_HOUR],
    [`ip:${input.ip || 'unknown'}`, ISHARE_EMAIL_REPORT_MAX_PER_IP_PER_HOUR],
  ];
  for (const [key, max] of checks) {
    const result = l.check(key, max);
    if (!result.allowed) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(result.resetInMs / 1000)) };
    }
  }
  return { allowed: true };
}
