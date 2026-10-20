import {
  buildSuppressionList,
  checkSuppression,
  filterRecipients,
  normalizeEmail,
} from '../dripSuppressionList';

describe('ENG-2554 do-not-email suppression', () => {
  it('ENG-2557 accepts punycode (xn--) TLDs', () => {
    expect(normalizeEmail('User@Example.XN--P1AI')).toBe('user@example.xn--p1ai');
    expect(checkSuppression(buildSuppressionList([]), 'user@example.xn--p1ai')).toEqual({ suppressed: false });
  });

  it('AC1 normalizes and rejects malformed addresses', () => {
    expect(normalizeEmail('  Jane.Doe@Acme.COM ')).toBe('jane.doe@acme.com');
    for (const bad of ['', 'no-at', '@acme.com', 'a@b', 'a@@b.com', 'a b@c.com', '.a@b.com', 'a..b@c.com', 42, null]) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  it('AC2 builds exact and domain entries, reporting malformed ones', () => {
    const l = buildSuppressionList(['X@Y.com', '@Acme.com', '*@foo.io', 'junk', '@bad', 7]);
    expect([...l.addresses]).toEqual(['x@y.com']);
    expect([...l.domains].sort()).toEqual(['acme.com', 'foo.io']);
    expect(l.rejected).toEqual(['junk', '@bad', '7']);
  });

  it('AC3 reports reason and fails closed on invalid recipients', () => {
    const l = buildSuppressionList(['x@y.com', '@acme.com']);
    expect(checkSuppression(l, 'X@y.com')).toEqual({ suppressed: true, reason: 'exact' });
    expect(checkSuppression(l, 'bob@acme.com')).toEqual({ suppressed: true, reason: 'domain' });
    expect(checkSuppression(l, 'ok@else.com')).toEqual({ suppressed: false });
    expect(checkSuppression(l, 'garbage')).toEqual({ suppressed: true, reason: 'invalid_address' });
    expect(checkSuppression(l, undefined)).toEqual({ suppressed: true, reason: 'invalid_address' });
  });

  it('AC4 domain match is exact, no suffix or subdomain bleed', () => {
    const l = buildSuppressionList(['@acme.com']);
    expect(checkSuppression(l, 'x@notacme.com').suppressed).toBe(false);
    expect(checkSuppression(l, 'x@acme.com.evil').suppressed).toBe(false);
    expect(checkSuppression(l, 'x@mail.acme.com').suppressed).toBe(false);
  });

  it('AC5 partitions recipients in order with dedupe', () => {
    const l = buildSuppressionList(['b@x.com', '@spam.io']);
    const r = filterRecipients(l, ['a@x.com', 'B@x.com', 'A@X.com', 'c@spam.io', 'bad', 'd@x.com', 'b@x.com']);
    expect(r.allowed).toEqual(['a@x.com', 'd@x.com']);
    expect(r.suppressed).toEqual([
      { email: 'b@x.com', reason: 'exact' },
      { email: 'c@spam.io', reason: 'domain' },
      { email: 'bad', reason: 'invalid_address' },
    ]);
  });
});
