import { encryptConnectToken, decryptConnectToken, redactToken } from '../stripeConnectCrypto';

describe('stripeConnectCrypto', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CONNECT_TOKEN_ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-only';
    // JWT_SECRET remains set by test setup; we rely on CONNECT_TOKEN_ENCRYPTION_KEY taking priority
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('round trip', () => {
    it('encrypts and decrypts a token successfully', () => {
      const plaintext = 'sk_test_51ABCxyz_example_stripe_connect_access_token';
      const enc = encryptConnectToken(plaintext);
      expect(enc).not.toBe(plaintext);
      expect(decryptConnectToken(enc)).toBe(plaintext);
    });

    it('produces different ciphertext for same plaintext (unique IV)', () => {
      const plaintext = 'rt_live_refresh_token_value';
      const a = encryptConnectToken(plaintext);
      const b = encryptConnectToken(plaintext);
      expect(a).not.toEqual(b);
      expect(decryptConnectToken(a)).toBe(plaintext);
      expect(decryptConnectToken(b)).toBe(plaintext);
    });

    it('round-trips long tokens', () => {
      const plaintext = 'x'.repeat(4096);
      expect(decryptConnectToken(encryptConnectToken(plaintext))).toBe(plaintext);
    });
  });

  describe('tamper resistance', () => {
    it('rejects a ciphertext with a flipped bit in the auth tag', () => {
      const enc = encryptConnectToken('sensitive-token');
      const buf = Buffer.from(enc, 'base64');
      buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
      const tampered = buf.toString('base64');
      expect(() => decryptConnectToken(tampered)).toThrow();
    });

    it('rejects a ciphertext encrypted under a different key', () => {
      const enc = encryptConnectToken('k1-token');
      process.env.CONNECT_TOKEN_ENCRYPTION_KEY = 'different-key-used-for-decrypt-attempt';
      expect(() => decryptConnectToken(enc)).toThrow();
    });

    it('rejects a too-short payload', () => {
      expect(() => decryptConnectToken('AAAA')).toThrow(/too short/);
    });
  });

  describe('input validation', () => {
    it('rejects empty plaintext', () => {
      expect(() => encryptConnectToken('')).toThrow(/non-empty/);
    });

    it('rejects empty ciphertext', () => {
      expect(() => decryptConnectToken('')).toThrow(/non-empty/);
    });

    it('falls back to JWT_SECRET when CONNECT_TOKEN_ENCRYPTION_KEY is unset', () => {
      delete process.env.CONNECT_TOKEN_ENCRYPTION_KEY;
      process.env.JWT_SECRET = 'jwt-fallback-secret-for-connect';
      const plaintext = 'fallback-test-token';
      expect(decryptConnectToken(encryptConnectToken(plaintext))).toBe(plaintext);
    });

    it('throws when neither key is set', () => {
      delete process.env.CONNECT_TOKEN_ENCRYPTION_KEY;
      delete process.env.JWT_SECRET;
      expect(() => encryptConnectToken('x')).toThrow(/CONNECT_TOKEN_ENCRYPTION_KEY/);
    });
  });

  describe('redactToken', () => {
    it('redacts short tokens as ***', () => {
      expect(redactToken('short')).toBe('***');
    });

    it('redacts long tokens preserving first/last 4 chars', () => {
      expect(redactToken('sk_test_abcdefghij1234567890')).toBe('sk_t…7890');
    });

    it('handles null/undefined/empty', () => {
      expect(redactToken(null)).toBe('<empty>');
      expect(redactToken(undefined)).toBe('<empty>');
      expect(redactToken('')).toBe('<empty>');
    });
  });
});
