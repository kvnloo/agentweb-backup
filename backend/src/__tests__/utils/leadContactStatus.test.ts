import { isDoNotContact, getDoNotContactReason } from '../../utils/leadContactStatus';

describe('leadContactStatus utils', () => {
  describe('isDoNotContact', () => {
    it('returns true when contactStatus is do-not-contact', () => {
      expect(isDoNotContact({ contactStatus: 'do-not-contact' })).toBe(true);
    });

    it('returns true when contactStatus is unsubscribed', () => {
      expect(isDoNotContact({ contactStatus: 'unsubscribed' })).toBe(true);
    });

    it('returns true for legacy unsubscribedFromGroupEmail flag', () => {
      expect(isDoNotContact({ unsubscribedFromGroupEmail: true })).toBe(true);
    });

    it('returns false for active lead', () => {
      expect(isDoNotContact({ contactStatus: 'active' })).toBe(false);
    });

    it('returns false when no relevant flags set', () => {
      expect(isDoNotContact({})).toBe(false);
    });
  });

  describe('getDoNotContactReason', () => {
    it('returns null for active lead', () => {
      expect(getDoNotContactReason({ contactStatus: 'active' })).toBeNull();
    });

    it('returns reason with note when contactStatusNote is present', () => {
      const result = getDoNotContactReason({
        contactStatus: 'do-not-contact',
        contactStatusReason: 'opted-out',
        contactStatusNote: 'User requested removal',
      });
      expect(result).toContain('Do Not Contact');
      expect(result).toContain('User requested removal');
    });

    it('returns reason without note when contactStatusNote is absent', () => {
      const result = getDoNotContactReason({
        contactStatus: 'do-not-contact',
        contactStatusReason: 'opted-out',
      });
      expect(result).toContain('Do Not Contact');
      expect(result).not.toContain(':');
    });

    it('returns Unsubscribed label for unsubscribed status', () => {
      const result = getDoNotContactReason({ contactStatus: 'unsubscribed' });
      expect(result).toContain('Unsubscribed');
    });

    it('returns legacy message for unsubscribedFromGroupEmail', () => {
      const result = getDoNotContactReason({ unsubscribedFromGroupEmail: true });
      expect(result).toBe('Unsubscribed from group email');
    });
  });
});
