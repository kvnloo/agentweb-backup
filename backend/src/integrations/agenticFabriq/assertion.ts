/**
 * Ed25519 signed-assertion support (auth_level: app_asserted -> app_signed).
 *
 * OPTIONAL for the spike — only exercised if AF_PRIVATE_KEY is configured and
 * "Require signed assertions" is later enabled in the console. The shared
 * X-App-Id/X-App-Secret pair proves which APP is calling; this proves which
 * USER too, so it matters more once real customer Gmail data is in play than
 * it does for Harsha's own spike account — built now so it's not a second
 * gated piece of work if the spike is approved to widen.
 *
 * Deliberately implemented with plain Node `crypto` rather than pulling in
 * `jsonwebtoken` for one call shape: this repo has a known Node 26 / jest /
 * jsonwebtoken local-load break on this machine (see the Mac-specific note in
 * project memory), and Ed25519 signing needs no library beyond what Node ships.
 *
 * Claims — ALL required, exactly as documented:
 *   iss = app_id
 *   sub = RAW user id ("user_8412", never the "ext:"-prefixed token form)
 *   aud = "agentic-fabriq"
 *   jti = unique per assertion (single-use, claimed server-side in Redis)
 *   iat, exp — exp-iat <= 60s; this module uses 30s for clock-skew headroom,
 *              per the vendor's own recommendation.
 */

import crypto from 'crypto';
import { randomUUID } from 'crypto';

const ASSERTION_TTL_SECONDS = 30; // <= 60s ceiling, vendor-recommended value

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export interface AgenticFabriqAssertionClaims {
  iss: string;
  sub: string;
  aud: 'agentic-fabriq';
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Builds and signs a compact JWS (header.payload.signature, alg EdDSA) for the
 * X-App-Assertion header. `privateKeyPem` must be an Ed25519 private key in
 * PKCS8 PEM form (the "private half shown ONCE" from the console's "Generate
 * key" step).
 */
export function signAgenticFabriqAssertion(params: {
  appId: string;
  rawUserId: string;
  privateKeyPem: string;
}): string {
  const { appId, rawUserId, privateKeyPem } = params;
  if (!appId) throw new TypeError('signAgenticFabriqAssertion: appId is required.');
  if (!rawUserId) throw new TypeError('signAgenticFabriqAssertion: rawUserId is required.');
  if (rawUserId.startsWith('ext:')) {
    // The token uses the ext: prefix, the assertion does not — copying it across
    // is the exact documented trap. Fail loudly rather than send a wrong sub.
    throw new TypeError(
      `signAgenticFabriqAssertion: rawUserId looks like the token's "ext:"-prefixed ` +
      `sub claim, not a raw user id. The assertion's sub must be the raw id without that prefix.`,
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims: AgenticFabriqAssertionClaims = {
    iss: appId,
    sub: rawUserId,
    aud: 'agentic-fabriq',
    jti: randomUUID(),
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
  };

  const header = { alg: 'EdDSA', typ: 'JWT' };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(
      `signAgenticFabriqAssertion: AF_PRIVATE_KEY must be an Ed25519 key, got "${privateKey.asymmetricKeyType}".`,
    );
  }
  // Ed25519/EdDSA in Node's crypto.sign is a one-shot signature over the raw
  // message with the `algorithm` argument set to null (no separate digest step).
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);

  return `${signingInput}.${base64url(signature)}`;
}

/** Test/verification helper — not used on the production request path (AF verifies server-side). */
export function verifyAgenticFabriqAssertionForTests(
  compactJws: string,
  publicKeyPem: string,
): AgenticFabriqAssertionClaims {
  const [headerB64, payloadB64, sigB64] = compactJws.split('.');
  if (!headerB64 || !payloadB64 || !sigB64) {
    throw new Error('Malformed assertion: expected header.payload.signature.');
  }
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(sigB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const publicKey = crypto.createPublicKey(publicKeyPem);
  const ok = crypto.verify(null, Buffer.from(signingInput), publicKey, signature);
  if (!ok) throw new Error('Assertion signature verification failed.');
  return JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
