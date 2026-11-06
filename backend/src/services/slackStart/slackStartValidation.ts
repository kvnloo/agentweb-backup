/**
 * ENG-2782 S1 — input validation for the public Slack-start intake.
 *
 * The website is handed to the onboarding brand build, whose Emma session
 * fetches it server-side. It therefore gets the same treatment as any other
 * user-supplied URL we fetch: http(s) only, no credentials, default port,
 * a real public hostname (no IP literals, no single-label/internal names) and
 * every DNS answer public (utils/ssrfGuard). Only the origin is kept.
 */

import { isIP } from 'net';
import { isCompanyEmail, validateEmail } from '../../utils/validation';
import { assertPublicHostname } from '../../utils/ssrfGuard';

export type EmailResult = { ok: true; email: string; domain: string } | { ok: false; code: 'invalid_email' | 'personal_email' };
export type WebsiteResult = { ok: true; url: string; host: string } | { ok: false; code: 'invalid_website' };

const MAX_EMAIL_LENGTH = 254;
const MAX_HOST_LENGTH = 253;
const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const INTERNAL_SUFFIXES = ['.internal', '.local', '.localhost', '.lan', '.home', '.corp', '.intranet'];

export function normalizeWorkEmail(raw: unknown): EmailResult {
  if (typeof raw !== 'string') return { ok: false, code: 'invalid_email' };
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !validateEmail(email)) return { ok: false, code: 'invalid_email' };
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (!isPublicHostnameShape(domain)) return { ok: false, code: 'invalid_email' };
  if (!isCompanyEmail(email)) return { ok: false, code: 'personal_email' };
  return { ok: true, email, domain };
}

export interface WebsiteDeps {
  /** Throws when the URL's host is internal or resolves to a private address. */
  assertPublic?: (url: string) => Promise<void>;
}

export async function normalizeWebsite(raw: unknown, deps: WebsiteDeps = {}): Promise<WebsiteResult> {
  const fail: WebsiteResult = { ok: false, code: 'invalid_website' };
  if (typeof raw !== 'string') return fail;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return fail;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return fail;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fail;
  if (parsed.username || parsed.password || parsed.port) return fail;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!isPublicHostnameShape(host)) return fail;
  const url = `https://${host}`;
  try {
    await (deps.assertPublic ?? assertPublicHostname)(url);
  } catch {
    return fail;
  }
  return { ok: true, url, host };
}

function isPublicHostnameShape(host: string): boolean {
  if (!host || host.length > MAX_HOST_LENGTH) return false;
  if (isIP(host) || host.startsWith('[')) return false;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => HOST_LABEL_RE.test(l))) return false;
  return TLD_RE.test(labels[labels.length - 1]);
}
