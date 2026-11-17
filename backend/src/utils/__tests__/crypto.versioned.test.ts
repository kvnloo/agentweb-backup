import crypto from 'crypto';
import {
  CREDENTIAL_CIPHERTEXT_V2_PREFIX,
  decryptPassword,
  encryptPassword,
  encryptPasswordV2,
} from '../crypto';

const KEK = crypto.randomBytes(32).toString('base64');

describe('crypto versioned credential ciphertext (ENG-3119)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env = { ...env, JWT_SECRET: 'jwt-secret-a-0123456789abcdef0123456789' };
    delete process.env.CREDENTIAL_KEK;
  });
  afterAll(() => {
    process.env = env;
  });

  it('1: legacy unprefixed ciphertext still decrypts with CREDENTIAL_KEK unset', () => {
    const legacy = encryptPassword('hunter2', 'user-1');
    expect(decryptPassword(legacy)).toMatchObject({ password: 'hunter2', userId: 'user-1' });
  });

  it('1: legacy ciphertext still decrypts when CREDENTIAL_KEK is set', () => {
    const legacy = encryptPassword('hunter2', 'user-1');
    process.env.CREDENTIAL_KEK = KEK;
    expect(decryptPassword(legacy)).toMatchObject({ password: 'hunter2', userId: 'user-1' });
  });

  it('2: v2 ciphertext decrypts with CREDENTIAL_KEK and survives a JWT_SECRET rotation', () => {
    process.env.CREDENTIAL_KEK = KEK;
    const v2 = encryptPasswordV2('s3cret', 'user-2');
    expect(v2.startsWith(CREDENTIAL_CIPHERTEXT_V2_PREFIX)).toBe(true);
    process.env.JWT_SECRET = 'jwt-secret-b-rotated-zzzzzzzzzzzzzzzzzzzz';
    expect(decryptPassword(v2)).toEqual({ password: 's3cret', userId: 'user-2' });
  });

  it('3: v2 ciphertext with CREDENTIAL_KEK unset fails explicitly', () => {
    process.env.CREDENTIAL_KEK = KEK;
    const v2 = encryptPasswordV2('s3cret', 'user-2');
    delete process.env.CREDENTIAL_KEK;
    expect(() => decryptPassword(v2)).toThrow(/CREDENTIAL_KEK is not set/);
  });

  it('3: v2 ciphertext with the wrong CREDENTIAL_KEK fails', () => {
    process.env.CREDENTIAL_KEK = KEK;
    const v2 = encryptPasswordV2('s3cret', 'user-2');
    process.env.CREDENTIAL_KEK = crypto.randomBytes(32).toString('base64');
    expect(() => decryptPassword(v2)).toThrow(/Failed to decrypt password \(v2\)/);
  });

  it('3: a v2 prefix on a legacy body never falls back to the JWT_SECRET key', () => {
    const legacy = encryptPassword('hunter2', 'user-1');
    process.env.CREDENTIAL_KEK = KEK;
    expect(() => decryptPassword(CREDENTIAL_CIPHERTEXT_V2_PREFIX + legacy)).toThrow(/v2/);
    delete process.env.CREDENTIAL_KEK;
    expect(() => decryptPassword(CREDENTIAL_CIPHERTEXT_V2_PREFIX + legacy)).toThrow(/CREDENTIAL_KEK is not set/);
  });

  it('3: unknown version prefix fails explicitly, never via the JWT_SECRET key', () => {
    const legacy = encryptPassword('hunter2', 'user-1');
    expect(() => decryptPassword('v3:' + legacy)).toThrow(/Unknown credential ciphertext version: v3/);
    expect(() => decryptPassword('v1:' + legacy)).toThrow(/Unknown credential ciphertext version: v1/);
  });

  it('3: malformed CREDENTIAL_KEK is rejected', () => {
    process.env.CREDENTIAL_KEK = Buffer.from('too-short').toString('base64');
    expect(() => encryptPasswordV2('x', 'y')).toThrow(/32 bytes/);
  });

  it('4: encryptPassword still emits unprefixed base64 (iv16 | ct | tag16)', () => {
    process.env.CREDENTIAL_KEK = KEK;
    const out = encryptPassword('hunter2', 'user-1');
    expect(out).not.toContain(':');
    expect(out).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(out, 'base64').length).toBeGreaterThan(32);
  });
});
