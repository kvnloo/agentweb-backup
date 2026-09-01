import { getGroupEmailRecipientIssue, isEligibleGroupEmailRecipient } from '../../utils/groupEmailRecipientValidation';

describe('getGroupEmailRecipientIssue', () => {
  it('flags a missing/invalid domain (no TLD) as malformed', () => {
    expect(getGroupEmailRecipientIssue('harsha@updates')).toBe('malformed');
  });

  it('flags a repeated-dot local part as malformed', () => {
    expect(getGroupEmailRecipientIssue('harsha..vankayalapati@agentweb.pro')).toBe('malformed');
  });

  it('flags a provider-disallowed example.com address as a test domain', () => {
    expect(getGroupEmailRecipientIssue('queue-verify@example.com')).toBe('test-domain');
  });

  it('allows a well-formed company-domain address', () => {
    expect(getGroupEmailRecipientIssue('harsha@agentweb.pro')).toBeNull();
  });

  it('flags an address with no @ as malformed', () => {
    expect(getGroupEmailRecipientIssue('not-an-email')).toBe('malformed');
  });

  it('flags an empty/missing address as malformed', () => {
    expect(getGroupEmailRecipientIssue('')).toBe('malformed');
    expect(getGroupEmailRecipientIssue(undefined)).toBe('malformed');
  });

  it('flags each reserved test TLD, not just the exact example.* domains', () => {
    expect(getGroupEmailRecipientIssue('user@foo.test')).toBe('test-domain');
    expect(getGroupEmailRecipientIssue('user@bar.example')).toBe('test-domain');
    expect(getGroupEmailRecipientIssue('user@baz.invalid')).toBe('test-domain');
    expect(getGroupEmailRecipientIssue('user@qux.localhost')).toBe('test-domain');
  });

  // A non-string truthy email is reachable via lead-creation paths with no
  // email type check upstream. Must not throw, and must be treated as
  // malformed since it can never have valid email syntax.
  it('does not throw and flags a non-string truthy email as malformed', () => {
    expect(() => getGroupEmailRecipientIssue(12345 as unknown as string)).not.toThrow();
    expect(getGroupEmailRecipientIssue(12345 as unknown as string)).toBe('malformed');
    expect(getGroupEmailRecipientIssue(['user@agentweb.pro'] as unknown as string)).toBe('malformed');
    expect(getGroupEmailRecipientIssue({ email: 'user@agentweb.pro' } as unknown as string)).toBe('malformed');
  });
});

describe('isEligibleGroupEmailRecipient', () => {
  it('is false for malformed and test-domain addresses, true for valid ones', () => {
    expect(isEligibleGroupEmailRecipient('harsha@updates')).toBe(false);
    expect(isEligibleGroupEmailRecipient('harsha..v@agentweb.pro')).toBe(false);
    expect(isEligibleGroupEmailRecipient('queue-verify@example.com')).toBe(false);
    expect(isEligibleGroupEmailRecipient('harsha@agentweb.pro')).toBe(true);
  });
});
