// .linear-autofix/preview/auth.mjs
// Shared-secret gate for the preview proxy (ENG-920).
//
// Why this exists: preview.mjs binds every real server (backend, both portals) to 127.0.0.1, so
// preview/proxy.mjs is the ONLY listener on the public ports (5173/5174/3001). Those ports are
// internet-exposed on the runner and the backend behind them holds live dev AWS credentials — so
// the gate has to live here, in the one process that answers the internet.
//
// Everything below is pure (no I/O, no listeners) so test/preview-auth.test.mjs can exercise the
// real decision function rather than a re-implementation of it.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'preview_access';
export const COOKIE_MAX_AGE = 30 * 24 * 3600;            // ~30d, matches the "visit once with ?k=" flow
export const TOKEN_PARAM = 'k';
const COOKIE_PAYLOAD = 'preview-access-v1';              // what the cookie signs; the raw token never leaves the box

// Constant-time compare that is also length-agnostic: timingSafeEqual throws on unequal lengths,
// and bailing on a length mismatch would itself leak the token length. Hash both sides first.
export function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const hb = createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

// The cookie carries an HMAC of the secret, not the secret itself — a leaked cookie can't be pasted
// back as ?k= into an unrelated tool, and the value is stable so no server-side session store is needed.
export function cookieValue(secret) {
  return createHmac('sha256', String(secret)).update(COOKIE_PAYLOAD).digest('hex');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// "::ffff:127.0.0.1" -> "127.0.0.1"; strips the IPv6 zone id too ("fe80::1%eth0").
export function normalizeIp(ip) {
  let s = String(ip || '').trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%');
  if (pct > 0) s = s.slice(0, pct);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  return m ? m[1] : s;
}

// Loopback + RFC1918. This is what keeps the on-box Playwright browser-verify step working without a
// token: it reaches the preview over loopback or the instance's own private address.
export function isPrivateAddr(ip) {
  const s = normalizeIp(ip);
  if (!s) return false;
  if (s === '::1' || s === '::') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  if (a === 127) return true;                       // 127/8 loopback
  if (a === 10) return true;                        // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true;          // 192.168/16
  if (a === 169 && b === 254) return true;          // link-local (169.254/16), incl. IMDS-side traffic
  return false;
}

// Requests the box makes to its OWN public URL (PREVIEW_IP is the EIP, and the verify browser opens
// the nip.io URL) hairpin through the internet gateway, which SNATs the source to that same public
// IP. Those are still on-box requests — an off-box attacker cannot forge them, because they'd have
// to complete a TCP handshake from an address that routes back to us.
export function isSelfAddr(ip, selfIps) {
  const s = normalizeIp(ip);
  if (!s) return false;
  for (const self of selfIps || []) if (normalizeIp(self) === s) return true;
  return false;
}

// Cookie Domain so ONE `?k=` grant covers every bug host and all three portal ports:
// "eng-1.54.1.2.3.nip.io" -> "54.1.2.3.nip.io". Only for *.nip.io (our preview scheme); anything
// else gets a host-scoped cookie, which is the safe default.
export function cookieDomain(host) {
  const h = String(host || '').split(':')[0].toLowerCase();
  // Anchor on the <ip>.nip.io tail (dotted or nip.io's dashed form) rather than counting labels —
  // the bare host is already 6 labels, so a label count can't tell "with bug prefix" from "without".
  const m = /(\d{1,3}(?:\.\d{1,3}){3}\.nip\.io|(?:\d{1,3}-){3}\d{1,3}\.nip\.io)$/.exec(h);
  if (!m || m[1] === h) return null;                // not a preview host, or already the bare <ip>.nip.io
  return m[1];
}

export function buildSetCookie(secret, host) {
  const dom = cookieDomain(host);
  return [
    `${COOKIE_NAME}=${cookieValue(secret)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${COOKIE_MAX_AGE}`,
    ...(dom ? [`Domain=${dom}`] : []),
  ].join('; ');
}

// Same URL minus the ?k= param, so the token stops living in the address bar / referer / history.
export function stripToken(url) {
  const u = new URL(String(url || '/'), 'http://x');
  u.searchParams.delete(TOKEN_PARAM);
  const qs = u.searchParams.toString();
  return u.pathname + (qs ? `?${qs}` : '');
}

export const DENY_BODY = '<!doctype html><meta charset="utf-8"><title>preview access required</title>'
  + '<body style="font:14px/1.5 system-ui;margin:3rem auto;max-width:34rem;color:#333">'
  + '<h1 style="font-size:1.1rem">Preview access required</h1>'
  + '<p>Open this URL once with the access token appended (<code>?k=&lt;token&gt;</code>). '
  + 'The token is on the runner in <code>.linear-autofix/.env</code>.</p>';

/**
 * The whole gate, as one pure decision.
 *
 * Returns exactly one of:
 *   { action: 'allow',  reason }                       - serve the request
 *   { action: 'grant',  setCookie, location, reason }  - 302 to `location` with `setCookie`
 *   { action: 'deny',   status: 401, reason }          - serve DENY_BODY, nothing else
 *
 * Deliberately identical for every bug id and every path: the 401 must not reveal whether a preview
 * exists. Note that X-Forwarded-For is NOT consulted anywhere — the proxy is the edge, so a header
 * would be attacker-controlled and would turn the private-range allowlist into a bypass.
 */
export function decideAccess({ secret, url, host, cookieHeader, remoteAddress, selfIps } = {}) {
  if (isPrivateAddr(remoteAddress)) return { action: 'allow', reason: 'private' };
  if (isSelfAddr(remoteAddress, selfIps)) return { action: 'allow', reason: 'self' };

  const token = String(secret || '');
  // Fail closed: a missing PREVIEW_ACCESS_TOKEN must never silently re-open the ports to the
  // internet. On-box work (above) still runs; everything else is refused.
  if (!token) return { action: 'deny', status: 401, reason: 'unconfigured' };

  const cookie = parseCookies(cookieHeader)[COOKIE_NAME];
  if (cookie && safeEqual(cookie, cookieValue(token))) return { action: 'allow', reason: 'cookie' };

  const supplied = new URL(String(url || '/'), 'http://x').searchParams.get(TOKEN_PARAM);
  if (supplied !== null && safeEqual(supplied, token)) {
    return { action: 'grant', setCookie: buildSetCookie(token, host), location: stripToken(url), reason: 'token' };
  }
  return { action: 'deny', status: 401, reason: 'no-token' };
}
