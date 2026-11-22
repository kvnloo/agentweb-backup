/**
 * ENG-2338: the Luma key survives the real encrypt -> decrypt round trip, and the stored
 * form never contains it. lumaApi.test.ts mocks crypto, so this is the only test that
 * runs the real thing.
 */
process.env.JWT_SECRET = 'test-jwt-secret-for-testing';

import { encryptPassword, decryptPassword } from '../utils/crypto';

describe('Luma API key storage format', () => {
  const key = 'luma-secret-key-123';

  it('round-trips through the real encryption', () => {
    const stored = encryptPassword(key, 'user-1');
    expect(decryptPassword(stored)).toMatchObject({ password: key, userId: 'user-1' });
  });

  it('does not contain the plaintext key, and differs on every encryption', () => {
    const a = encryptPassword(key, 'user-1');
    const b = encryptPassword(key, 'user-1');
    expect(a).not.toContain(key);
    expect(Buffer.from(a, 'base64').toString('utf8')).not.toContain(key);
    expect(a).not.toEqual(b);
  });

  it('rejects a tampered ciphertext instead of returning a wrong key', () => {
    const buf = Buffer.from(encryptPassword(key, 'user-1'), 'base64');
    buf[20] ^= 0xff;
    expect(() => decryptPassword(buf.toString('base64'))).toThrow();
  });
});
