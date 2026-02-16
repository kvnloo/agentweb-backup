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
  });
});
