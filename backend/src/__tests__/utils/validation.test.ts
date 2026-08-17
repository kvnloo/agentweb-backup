import { validateEmail, isGroupEmailIneligible, isEmailSyntaxValid, isReservedTestDomainEmail } from '../../utils/validation';

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

    it('flags the remaining RFC 2606 reserved domains as ineligible', () => {
      expect(isGroupEmailIneligible('user@example.net')).toBe(true);
      expect(isGroupEmailIneligible('user@example.org')).toBe(true);
      expect(isGroupEmailIneligible('user@example.edu')).toBe(true);
    });

    it('flags addresses under each reserved test TLD as ineligible', () => {
      expect(isGroupEmailIneligible('user@foo.test')).toBe(true);
      expect(isGroupEmailIneligible('user@bar.example')).toBe(true);
      expect(isGroupEmailIneligible('user@baz.invalid')).toBe(true);
      expect(isGroupEmailIneligible('user@qux.localhost')).toBe(true);
    });

    it('does not flag a valid work address as ineligible', () => {
      expect(isGroupEmailIneligible('jane.doe@acmecorp.com')).toBe(false);
    });

    it('does not flag a missing email as ineligible (handled by a separate no-email bucket)', () => {
      expect(isGroupEmailIneligible(undefined)).toBe(false);
      expect(isGroupEmailIneligible('')).toBe(false);
    });

    // ENG-1194 code review: a non-string truthy email (number/array/object) is
    // reachable via POST /lists/:listId/leads, which passes req.body straight
    // to createLead with no email type check. Must not throw, and is treated
    // as ineligible since it can never have valid email syntax.
    it('does not throw and flags a non-string truthy email as ineligible', () => {
      expect(isGroupEmailIneligible(12345 as unknown as string)).toBe(true);
      expect(isGroupEmailIneligible(['user@acmecorp.com'] as unknown as string)).toBe(true);
      expect(isGroupEmailIneligible({ email: 'user@acmecorp.com' } as unknown as string)).toBe(true);
    });
  });

  // ENG-1194 code review: these previously called .trim() on the raw input
  // with only a falsy-guard, so a truthy non-string threw a TypeError.
  describe('non-string input handling', () => {
    it('isEmailSyntaxValid returns false instead of throwing for a non-string', () => {
      expect(() => isEmailSyntaxValid(12345 as unknown as string)).not.toThrow();
      expect(isEmailSyntaxValid(12345 as unknown as string)).toBe(false);
      expect(isEmailSyntaxValid(['a@b.com'] as unknown as string)).toBe(false);
      expect(isEmailSyntaxValid({} as unknown as string)).toBe(false);
    });

    it('isReservedTestDomainEmail returns false instead of throwing for a non-string', () => {
      expect(() => isReservedTestDomainEmail(12345 as unknown as string)).not.toThrow();
      expect(isReservedTestDomainEmail(12345 as unknown as string)).toBe(false);
      expect(isReservedTestDomainEmail(['a@b.com'] as unknown as string)).toBe(false);
      expect(isReservedTestDomainEmail({} as unknown as string)).toBe(false);
    });
  });
});
