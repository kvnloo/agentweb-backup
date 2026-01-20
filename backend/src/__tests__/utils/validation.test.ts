import { validateEmail } from '../../utils/validation';

describe('validation utils', () => {
  describe('validateEmail', () => {
    it('should return true for valid email addresses', () => {
      expect(validateEmail('test@example.com')).toBe(true);
      expect(validateEmail('user.name@domain.com')).toBe(true);
      expect(validateEmail('user+tag@example.org')).toBe(true);
      expect(validateEmail('test123@test.co.uk')).toBe(true);
    });

    it('should return false for invalid email addresses', () => {
      expect(validateEmail('')).toBe(false);
      expect(validateEmail('invalid')).toBe(false);
      expect(validateEmail('missing@domain')).toBe(false);
      expect(validateEmail('@nodomain.com')).toBe(false);
      expect(validateEmail('spaces in@email.com')).toBe(false);
      expect(validateEmail('no@domain@twice.com')).toBe(false);
    });
  });
});
