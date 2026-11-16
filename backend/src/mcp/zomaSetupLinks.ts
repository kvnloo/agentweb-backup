/**
 * ENG-2496 — browser-journey links for Zoma setup.
 *
 * Paths are relative to the backend origin. The browser carries a short signed token between
 * steps (after Meta, after the account picker, Stripe's success/cancel return) instead of
 * relying on an AgentWeb portal session, which may belong to a different account.
 *
 * These tokens never carry a userId: the user always comes from the device item the token
 * names. They are signed with a key DERIVED from JWT_SECRET (never the raw secret), so a Zoma
 * link token can never verify as an AgentWeb auth token, nor the reverse.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwt';

export const ZOMA_META_CALLBACK_PATH = '/api/zoma/meta/callback';
export const ZOMA_META_SELECT_PATH = '/api/zoma/meta/select';
export const ZOMA_CONTINUE_PATH = '/api/zoma/continue';
export const ZOMA_DONE_PATH = '/api/zoma/done';

export type ZomaLinkPurpose = 'continue' | 'pick_meta_account';

export interface ZomaLinkClaims {
  purpose: ZomaLinkPurpose;
  /** deviceId (sha256 of the device_code) of the setup this link belongs to. */
  zoma: string;
  /** pick_meta_account only: the token session from finalize + the accounts offered. */
  tokenSessionId?: string;
  accounts?: Array<{ account_id: string; name: string; currency: string; account_status: number }>;
}

export interface ZomaLinkCodec {
  sign(claims: ZomaLinkClaims, expiresInSec: number): string;
  verify(token: unknown, purpose: ZomaLinkPurpose): ZomaLinkClaims | null;
}

export function makeZomaLinkCodec(rootSecret: () => string): ZomaLinkCodec {
  const key = () => crypto.createHash('sha256').update(`zoma-setup-link:v1:${rootSecret()}`).digest('hex');
  return {
    sign: (claims, expiresInSec) => jwt.sign(claims, key(), { algorithm: 'HS256', expiresIn: expiresInSec }),
    verify(token, purpose) {
      if (typeof token !== 'string' || !token) return null;
      try {
        const claims = jwt.verify(token, key(), { algorithms: ['HS256'] }) as ZomaLinkClaims;
        return claims.purpose === purpose && typeof claims.zoma === 'string' && /^[0-9a-f]{64}$/.test(claims.zoma) ? claims : null;
      } catch {
        return null;
      }
    },
  };
}

export const defaultZomaLinkCodec = makeZomaLinkCodec(getJwtSecret);
