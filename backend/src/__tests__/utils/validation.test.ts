import { validateEmail, isGroupEmailIneligible } from '../../utils/validation';

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

  // ENG-1194: shared preview/send eligibility check — malformed and
  // provider-disallowed test-domain addresses must be flagged ineligible so
  // preview counts match what the send actually queues.
  describe('isGroupEmailIneligible', () => {
    it('flags a missing/invalid TLD as ineligible', () => {
      expect(isGroupEmailIneligible('user@localhost')).toBe(true);
    });

    it('flags a repeated-dot local part as ineligible', () => {
      expect(isGroupEmailIneligible('john..doe@domain.com')).toBe(true);
    });

    it('flags a repeated-dot domain as ineligible', () => {
      expect(isGroupEmailIneligible('user@domain..com')).toBe(true);
    });

    it('flags the provider-disallowed example.com test domain as ineligible', () => {
      expect(isGroupEmailIneligible('user@example.com')).toBe(true);
    });

    it('does not flag a valid work address as ineligible', () => {
      expect(isGroupEmailIneligible('jane.doe@acmecorp.com')).toBe(false);
    });

    it('does not flag a missing email as ineligible (handled by a separate no-email bucket)', () => {
      expect(isGroupEmailIneligible(undefined)).toBe(false);
      expect(isGroupEmailIneligible('')).toBe(false);
    });
  });
});
