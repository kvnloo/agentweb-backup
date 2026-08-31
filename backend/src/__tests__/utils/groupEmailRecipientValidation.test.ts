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
});

describe('isEligibleGroupEmailRecipient', () => {
  it('is false for malformed and test-domain addresses, true for valid ones', () => {
    expect(isEligibleGroupEmailRecipient('harsha@updates')).toBe(false);
    expect(isEligibleGroupEmailRecipient('harsha..v@agentweb.pro')).toBe(false);
    expect(isEligibleGroupEmailRecipient('queue-verify@example.com')).toBe(false);
    expect(isEligibleGroupEmailRecipient('harsha@agentweb.pro')).toBe(true);
  });
});
