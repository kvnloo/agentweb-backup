/**
 * ENG-2553 (ENG-2167 Phase 1 compliance): signed unsubscribe token and
 * RFC 8058 one-click List-Unsubscribe headers. Pure — no I/O, not yet wired
 * into a send path. Every invalid input fails closed.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export interface UnsubscribePayload {
  orgId: string;
  contactId: string;
  sequenceId?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function requireSecret(secret: string): void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('unsubscribe secret is required');
  }
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function mac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function signUnsubscribeToken(payload: UnsubscribePayload, secret: string): string {
  requireSecret(secret);
  if (!isId(payload?.orgId) || !isId(payload?.contactId)) {
    throw new Error('orgId and contactId are required');
  }
  if (payload.sequenceId !== undefined && !isId(payload.sequenceId)) {
    throw new Error('sequenceId must be a non-empty string when present');
  }
  const clean: UnsubscribePayload = { orgId: payload.orgId, contactId: payload.contactId };
  if (payload.sequenceId !== undefined) clean.sequenceId = payload.sequenceId;
  const body = b64url(Buffer.from(JSON.stringify(clean), 'utf8'));
  return `${body}.${b64url(mac(body, secret))}`;
}

export function verifyUnsubscribeToken(token: string, secret: string): UnsubscribePayload | null {
  if (typeof secret !== 'string' || secret.length === 0) return null;
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) {
    return null;
  }
  const [body, sig] = parts;
  const expected = mac(body, secret);
  const given = fromB64url(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(fromB64url(body).toString('utf8'));
    if (!parsed || !isId(parsed.orgId) || !isId(parsed.contactId)) return null;
    if (parsed.sequenceId !== undefined && !isId(parsed.sequenceId)) return null;
    const out: UnsubscribePayload = { orgId: parsed.orgId, contactId: parsed.contactId };
    if (parsed.sequenceId !== undefined) out.sequenceId = parsed.sequenceId;
    return out;
  } catch {
    return null;
  }
}

export interface ListUnsubscribeInput {
  baseUrl: string;
  token: string;
  mailto?: string;
}

const CRLF = /[\r\n]/;

export function buildListUnsubscribeHeaders(input: ListUnsubscribeInput): Record<string, string> {
  const { baseUrl, token, mailto } = input ?? ({} as ListUnsubscribeInput);
  if (typeof baseUrl !== 'string' || CRLF.test(baseUrl)) throw new Error('invalid baseUrl');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('invalid baseUrl');
  }
  if (url.protocol !== 'https:') throw new Error('baseUrl must be https');
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('invalid token');
  url.searchParams.set('t', token);
  const entries = [`<${url.toString()}>`];
  if (mailto !== undefined) {
    if (typeof mailto !== 'string' || CRLF.test(mailto) || !/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(mailto)) {
      throw new Error('invalid mailto');
    }
    // ENG-2557: encode the local part so reserved chars (e.g. '?', '&', '%') cannot start the
    // query or change the recipient.
    const at = mailto.lastIndexOf('@');
    const encoded = `${encodeURIComponent(mailto.slice(0, at))}@${mailto.slice(at + 1)}`;
    entries.push(`<mailto:${encoded}?subject=unsubscribe>`);
  }
  return {
    'List-Unsubscribe': entries.join(', '),
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
