/**
 * ENG-2991: short-lived signed tokens for the public subscriber flows, so that a task id and an email address alone are never enough to act
 * for someone else:
 *  - `confirm-subscribe`: sent in the confirmation email after someone asks to join a task's updates (double opt-in; nothing is stored until
 *    the person confirms from the link). Bound to the task and the lower-cased address, and to when it was issued.
 *  - `resubscribe`: handed back by the unsubscribe call, so the "undo" on the unsubscribe page works for the person who just unsubscribed and
 *    cannot be used by anyone else to re-enable mail to an address that opted out. Bound to the task, the address exactly as stored (rows are
 *    case-sensitive, so `A@x.com` and `a@x.com` are different rows) and the random `optOutNonce` the unsubscribe wrote on the row: a repeat
 *    unsubscribe, a new opt-out, or being put back changes or ends it, so an old token no longer matches the row. (The nonce, not the opt-out
 *    time, because the time is the record of when the person opted out and a rule about confirmation links depends on it.)
 * Each token expires. They are signed with a key derived (HMAC) from the app's JWT secret but different from it, so a subscriber link can
 * never be accepted as a login token, nor a login token as a subscriber link.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';

const CONFIRM_TTL = '48h';
const RESUBSCRIBE_TTL = '24h';

const norm = (email: string) => String(email).trim().toLowerCase();

/** The signing key for subscriber links (exported so tests can mint tokens of any age). */
export function subscriberTokenKey(): Buffer {
  return crypto.createHmac('sha256', getJwtSecret()).update('agentweb:subscriber-links:v1').digest();
}

export function signConfirmToken(taskId: string, email: string): string {
  return jwt.sign({ purpose: 'confirm-subscribe', taskId: String(taskId), email: norm(email) }, subscriberTokenKey(), {
    algorithm: 'HS256',
    expiresIn: CONFIRM_TTL as any,
  });
}

/**
 * For the confirmation link, which carries only the token: what it was minted for and when (`issuedAtMs`), or null when it is invalid or
 * expired. The time lets a link sent before the person unsubscribed be refused afterwards.
 */
export function readConfirmToken(token: unknown): { taskId: string; email: string; issuedAtMs: number } | null {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = jwt.verify(token, subscriberTokenKey(), { algorithms: ['HS256'] }) as any;
    if (decoded?.purpose !== 'confirm-subscribe' || typeof decoded?.taskId !== 'string' || typeof decoded?.email !== 'string') return null;
    return { taskId: decoded.taskId, email: decoded.email, issuedAtMs: typeof decoded.iat === 'number' ? decoded.iat * 1000 : 0 };
  } catch {
    return null;
  }
}

/** The undo token for one opt-out: `optOutNonce` is the nonce the unsubscribe wrote on the row, as stored. */
export function signResubscribeToken(taskId: string, email: string, optOutNonce: string): string {
  return jwt.sign({ purpose: 'resubscribe', taskId: String(taskId), email: String(email), optOutNonce: String(optOutNonce) }, subscriberTokenKey(), {
    algorithm: 'HS256',
    expiresIn: RESUBSCRIBE_TTL as any,
  });
}

/** What an undo token was minted for, or null when it is invalid, expired or not an undo token. */
export function readResubscribeToken(token: unknown): { taskId: string; email: string; optOutNonce: string } | null {
  if (typeof token !== 'string' || !token) return null;
  try {
    const decoded = jwt.verify(token, subscriberTokenKey(), { algorithms: ['HS256'] }) as any;
    if (decoded?.purpose !== 'resubscribe') return null;
    if (typeof decoded.taskId !== 'string' || typeof decoded.email !== 'string' || typeof decoded.optOutNonce !== 'string' || !decoded.optOutNonce) return null;
    return { taskId: decoded.taskId, email: decoded.email, optOutNonce: decoded.optOutNonce };
  } catch {
    return null;
  }
}
