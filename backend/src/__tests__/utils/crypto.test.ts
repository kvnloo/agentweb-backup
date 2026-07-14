import { encryptPassword, decryptPassword } from '../../utils/crypto';
import jwt from 'jsonwebtoken';

describe('crypto utils', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.JWT_SECRET = 'test-secret-key-must-be-long-enough';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('encryptPassword and decryptPassword', () => {
    it('should encrypt and decrypt a password correctly', () => {
      const password = 'my-secret-password';
      const userId = 'user-123';

      const encrypted = encryptPassword(password, userId);
      const decrypted = decryptPassword(encrypted);

      expect(decrypted.password).toBe(password);
      expect(decrypted.userId).toBe(userId);
    });

    it('should fail to decrypt invalid data', () => {
      expect(() => {
        decryptPassword('invalid-base64-string');
      }).toThrow('Failed to decrypt password');
    });

    it('should fail to decrypt tampered data', () => {
       const password = 'password';
       const userId = 'user';
       const encrypted = encryptPassword(password, userId);

       // Tamper with the encrypted string (change last char)
       const tampered = encrypted.substring(0, encrypted.length - 1) + 'a';

       expect(() => {
         decryptPassword(tampered);
       }).toThrow('Failed to decrypt password');
    });

    it('should fail to decrypt when JWT_SECRET changed between encrypt and decrypt', () => {
      process.env.JWT_SECRET = 'secret-a';
      jest.resetModules();
      const cryptoA = require('../../utils/crypto');
      const encrypted = cryptoA.encryptPassword('password', 'user');

      process.env.JWT_SECRET = 'secret-b';
      jest.resetModules();
      const cryptoB = require('../../utils/crypto');
      expect(() => cryptoB.decryptPassword(encrypted)).toThrow('Failed to decrypt password');
    });
  });

  describe('fail-closed when JWT_SECRET is not configured', () => {
    it('encryptPassword throws when JWT_SECRET is missing', () => {
      delete process.env.JWT_SECRET;
      jest.resetModules();
      const { encryptPassword: encrypt } = require('../../utils/crypto');
      expect(() => encrypt('password', 'user')).toThrow(/JWT_SECRET is not set/);
    });

    it('encryptPassword throws when JWT_SECRET is an empty string', () => {
      process.env.JWT_SECRET = '';
      jest.resetModules();
      const { encryptPassword: encrypt } = require('../../utils/crypto');
      expect(() => encrypt('password', 'user')).toThrow(/JWT_SECRET is not set/);
    });

    it('decryptPassword throws when JWT_SECRET is missing', () => {
      process.env.JWT_SECRET = 'temp-secret';
      jest.resetModules();
      const { encryptPassword: encrypt } = require('../../utils/crypto');
      const encrypted = encrypt('password', 'user');

      delete process.env.JWT_SECRET;
      jest.resetModules();
      const { decryptPassword: decrypt } = require('../../utils/crypto');
      // decryptPassword wraps all internal errors in a generic message (pre-existing behavior).
      expect(() => decrypt(encrypted)).toThrow('Failed to decrypt password');
    });
  });

  describe('golden vector (proves the derived key is unchanged across the getJwtSecret() refactor)', () => {
    // Generated with JWT_SECRET='golden-vector-secret-v1' via
    // encryptPassword('S3cur3Pass!', 'user-golden-1') on the pre-refactor implementation
    // (process.env.JWT_SECRET! instead of getJwtSecret()).
    const GOLDEN_SECRET = 'golden-vector-secret-v1';
    const GOLDEN_CIPHERTEXT =
      'hlsTGQAyO+PD5sr6qa85aBkVeTRENImAD+COTqJ7Lfr97gjql3FP74wzBOD2PpMOmTTcJT5+5My0E8xtErMjJOV+kAjLUIu34oGuuBlCXxYyIKjgfcDJv5bRuidndSCL0xC7Bcr3E3z1XlI4p0WeD9BTbEynj/jYVa/ZnCX7Z5Xq0kpymQwr1dzGc2iUJJB/w9o/GMe2iCqJVgwdz3jrt4u4QHCotxnT/6cvafQLCnjOR+qOJfG3lZsgWgNwOBH/N1jQ4GyCS0GsJ6u0';

    it('still decrypts a pre-refactor ciphertext to the original plaintext', () => {
      process.env.JWT_SECRET = GOLDEN_SECRET;
      jest.resetModules();
      const { decryptPassword: decrypt } = require('../../utils/crypto');
      const decrypted = decrypt(GOLDEN_CIPHERTEXT);
      expect(decrypted.password).toBe('S3cur3Pass!');
      expect(decrypted.userId).toBe('user-golden-1');
    });
  });
});
