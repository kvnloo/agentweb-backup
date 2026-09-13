/**
 * Protects the signed-assertion claim contract — a security-critical invariant
 * once real customer Gmail access depends on it: sub is the RAW user id (never
 * the "ext:"-prefixed token form), jti is unique per assertion, and exp-iat
 * stays within the vendor's documented ceiling.
 */
import crypto from 'crypto';
import { signAgenticFabriqAssertion, verifyAgenticFabriqAssertionForTests } from '../assertion';

function generateEd25519PemPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

describe('signAgenticFabriqAssertion', () => {
  const { publicKeyPem, privateKeyPem } = generateEd25519PemPair();

  it('produces a compact JWS verifiable with the paired public key', () => {
    const jws = signAgenticFabriqAssertion({ appId: 'app_1', rawUserId: 'user_8412', privateKeyPem });
    const claims = verifyAgenticFabriqAssertionForTests(jws, publicKeyPem);
    expect(claims.iss).toBe('app_1');
    expect(claims.sub).toBe('user_8412');
    expect(claims.aud).toBe('agentic-fabriq');
  });

  it('sub is the RAW user id, never the ext:-prefixed token form', () => {
    expect(() =>
      signAgenticFabriqAssertion({ appId: 'app_1', rawUserId: 'ext:user_8412', privateKeyPem }),
    ).toThrow(TypeError);
  });

  it('jti is unique across two calls for the same user (single-use, per the vendor spec)', () => {
    const first = verifyAgenticFabriqAssertionForTests(
      signAgenticFabriqAssertion({ appId: 'app_1', rawUserId: 'user_8412', privateKeyPem }),
      publicKeyPem,
    );
    const second = verifyAgenticFabriqAssertionForTests(
      signAgenticFabriqAssertion({ appId: 'app_1', rawUserId: 'user_8412', privateKeyPem }),
      publicKeyPem,
    );
    expect(first.jti).not.toBe(second.jti);
  });

  it('exp - iat stays within the 60s ceiling (uses 30s for clock-skew headroom)', () => {
    const claims = verifyAgenticFabriqAssertionForTests(
      signAgenticFabriqAssertion({ appId: 'app_1', rawUserId: 'user_8412', privateKeyPem }),
      publicKeyPem,
    );
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
    expect(claims.exp - claims.iat).toBe(30);
  });

  it('fails verification against a DIFFERENT keypair (proves the signature is real, not decorative)', () => {
    const jws = signAgenticFabriqAssertion({ appId: 'app_1', rawUserId: 'user_8412', privateKeyPem });
    const { publicKeyPem: wrongPublicKey } = generateEd25519PemPair();
    expect(() => verifyAgenticFabriqAssertionForTests(jws, wrongPublicKey)).toThrow();
  });

  it('rejects a non-Ed25519 private key with a clear error, not a cryptic crypto exception', () => {
    const { privateKey: rsaKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsaKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => signAgenticFabriqAssertion({ appId: 'app_1', rawUserId: 'user_8412', privateKeyPem: rsaPem })).toThrow(
      /Ed25519/,
    );
  });
});
