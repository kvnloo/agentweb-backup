/**
 * ENG-2110: the `loginId` of a hosted sign-in is a sealed, self-describing token instead of a key into one process's memory.
 *
 * A pending sign-in used to exist only in the memory of the backend instance that started it, so a deploy (a new instance replaces
 * the old one many times a day) or a second instance answered the user's `complete` with 409 `login_not_found`. The token carries what
 * `complete` needs (owner, provider, connection id, the host's login reference, reconnect or not, expiry), so any instance can finish it.
 *
 * AES-256-GCM, so the client can neither read nor change it (the login reference stays server-side, as before). The key is derived
 * from the backend's existing JWT secret with a purpose label (no new secret to provision); rotating that secret just makes pending
 * sign-ins answer `login_not_found`, i.e. "start again". The token is not a credential: using it still needs the owner's own session,
 * and the single-use sign-in code is checked by the login host, which also refuses a second `complete` for the same attempt.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";
import { getJwtSecret } from "../../config/jwt";

export interface SignInTokenPayload {
  userId: string;
  /** The `:provider` route key (HOSTED_PROVIDERS). */
  provider: string;
  connectionId: string;
  loginRef: string;
  reconnect: boolean;
  expiresAtMs: number;
}

const VERSION = 1;
const AAD = Buffer.from("agentweb/hosted-signin/v1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Longest token the routes accept (a token is ~300 chars). */
export const MAX_SIGNIN_TOKEN_CHARS = 1024;

function key(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), AAD, 32));
}

/** What identifies an attempt, whatever spelling of its token the client sends. */
export function signInKey(connectionId: string, loginRef: string): string {
  return `${connectionId}\u0000${loginRef}`;
}

export function sealSignInToken(p: SignInTokenPayload, secret: string = getJwtSecret()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify({ v: VERSION, u: p.userId, p: p.provider, c: p.connectionId, l: p.loginRef, r: p.reconnect, e: p.expiresAtMs }), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url");
}

/** The payload, or undefined for anything that is not a valid, unexpired token made with this secret. Never throws. */
export function openSignInToken(token: unknown, nowMs: number, secret?: string): SignInTokenPayload | undefined {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_SIGNIN_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
    const raw = Buffer.from(token, "base64url");
    // base64url decoding is lenient (several spellings decode to the same bytes): accept only the one spelling we issue.
    if (raw.toString("base64url") !== token) return undefined;
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", key(secret ?? getJwtSecret()), raw.subarray(0, IV_BYTES));
    decipher.setAAD(AAD);
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const j = JSON.parse(Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8")) as Record<string, unknown>;
    if (j.v !== VERSION || typeof j.u !== "string" || typeof j.p !== "string" || typeof j.c !== "string" || typeof j.l !== "string" || typeof j.r !== "boolean" || typeof j.e !== "number") return undefined;
    if (!(j.e > nowMs)) return undefined;
    return { userId: j.u, provider: j.p, connectionId: j.c, loginRef: j.l, reconnect: j.r, expiresAtMs: j.e };
  } catch {
    return undefined;
  }
}
