import { decideSendEligibility, partitionRecipients } from '../utils/sendEligibility';

const facts = {
  unsubscribed: ['unsub@x.com'],
  doNotEmail: [' DNE@X.com '],
  hardBounced: ['hard@x.com'],
  complained: ['spam@x.com'],
  softBounced: ['soft@x.com'],
};

describe('decideSendEligibility', () => {
  it('allows a clean recipient', () => {
    expect(decideSendEligibility('ok@x.com', facts)).toEqual({ send: true });
  });

  it.each([
    ['unsub@x.com', 'unsubscribed'],
    ['dne@x.com', 'do_not_email'],
    ['hard@x.com', 'hard_bounce'],
    ['spam@x.com', 'complaint'],
    ['not-an-email', 'invalid_address'],
    ['', 'invalid_address'],
    ['a@b..com', 'invalid_address'],
    ['a@.b.com', 'invalid_address'],
    ['a;b@example.com', 'invalid_address'],
    ['a@-example.com', 'invalid_address'],
    ['a@example-.com', 'invalid_address'],
    ['.a@example.com', 'invalid_address'],
    ['a.@example.com', 'invalid_address'],
    ['a'.repeat(65) + '@example.com', 'invalid_address'],
    ['a@' + 'b'.repeat(63) + '.' + 'c'.repeat(63) + '.' + 'd'.repeat(63) + '.' + 'e'.repeat(63) + '.com', 'invalid_address'],
  ])('suppresses %s as %s', (email, reason) => {
    expect(decideSendEligibility(email, facts)).toEqual({ send: false, reason });
  });

  it('compares case-insensitively and trims whitespace', () => {
    expect(decideSendEligibility('  UNSUB@X.COM ', facts)).toEqual({ send: false, reason: 'unsubscribed' });
    expect(decideSendEligibility({ email: 'Hard@X.com' }, facts)).toEqual({ send: false, reason: 'hard_bounce' });
  });

  it('does not suppress on soft bounce alone', () => {
    expect(decideSendEligibility('soft@x.com', facts)).toEqual({ send: true });
  });

  it('treats an absent facts object as no suppressions', () => {
    expect(decideSendEligibility('ok@x.com', {})).toEqual({ send: true });
  });
});

describe('partitionRecipients', () => {
  it('returns empty lists for an empty batch', () => {
    expect(partitionRecipients([], facts)).toEqual({ sendable: [], suppressed: [] });
  });

  it('partitions with per-recipient reasons and preserves input order', () => {
    const rs = [{ email: 'a@x.com' }, { email: 'spam@x.com' }, { email: 'soft@x.com' }, { email: 'DNE@x.com' }, { email: 'b@x.com' }];
    expect(partitionRecipients(rs, facts)).toEqual({
      sendable: [rs[0], rs[2], rs[4]],
      suppressed: [
        { recipient: rs[1], reason: 'complaint' },
        { recipient: rs[3], reason: 'do_not_email' },
      ],
    });
  });
});

describe('local-part dot rules', () => {
  it.each(['a..b@example.com', '.a@example.com', 'a.@example.com'])('rejects %s', (addr) => {
    expect(decideSendEligibility(addr, {})).toEqual({ send: false, reason: 'invalid_address' });
  });
});
