import { parseCookieHeader } from '../../utils/cookieHeaderParser';

describe('parseCookieHeader', () => {
  describe('failure cases', () => {
    it('throws on empty string', () => {
      expect(() => parseCookieHeader('', 'rankai.ai')).toThrow(/empty/i);
    });

    it('throws on whitespace-only string', () => {
      expect(() => parseCookieHeader('   \n\t  ', 'rankai.ai')).toThrow(/empty/i);
    });

    it('throws when a segment has no "=" (malformed)', () => {
      expect(() => parseCookieHeader('session=abc; garbage', 'rankai.ai')).toThrow(/malformed|invalid/i);
    });

    it('throws when a segment has an empty name before "=" (e.g. "=value")', () => {
      expect(() => parseCookieHeader('session=abc; =bareval', 'rankai.ai')).toThrow(/malformed cookie segment \(missing name\)/i);
    });

    it('throws when the header parses to zero valid pairs (semicolons only)', () => {
      expect(() => parseCookieHeader(';;;', 'rankai.ai')).toThrow(/empty|no valid/i);
    });

    it('throws when input exceeds the size cap', () => {
      const huge = 'a=' + 'x'.repeat(21 * 1024);
      expect(() => parseCookieHeader(huge, 'rankai.ai')).toThrow(/too large|size/i);
    });

    it('gives a guided error (not a generic "malformed" one) when the whole input has no "=" at all — the bare-value mistake', () => {
      // Real-world case: a user pastes just a cookie's VALUE (copied from DevTools
      // Application/Storage tab's Value column) instead of "name=value" (from the
      // Network tab's cookie request header). e.g. a raw LinkedIn li_at token.
      const bareValue = 'AQEDASb4dPAEWdFlAAABn2pU7G8AAAGfw5KF600AtLpf70SRax7BtNC53yM0XiICAKBLPguFfDttjepnLv0JCHwsyil7DTcaFyM_ASn0FnUuDTNlknKH5kxjqekfmYPSStirUmWe5SEz29STmDENYver';
      expect(() => parseCookieHeader(bareValue, 'linkedin.com')).toThrow(/looks like you pasted just the cookie's value/i);
      expect(() => parseCookieHeader(bareValue, 'linkedin.com')).toThrow(/name=value/);
    });

    it('still gives the plain malformed-segment error when SOME segments are valid but one is broken', () => {
      // Distinguishes "entirely bare value" (guided message) from "one bad segment
      // among otherwise-valid ones" (a real typo, not the bare-value mistake).
      expect(() => parseCookieHeader('session=abc; garbage', 'rankai.ai')).toThrow(/malformed cookie segment/i);
      expect(() => parseCookieHeader('session=abc; garbage', 'rankai.ai')).not.toThrow(/looks like you pasted/i);
    });
  });

  describe('success cases', () => {
    it('parses a single cookie', () => {
      const result = parseCookieHeader('session=abc123', 'rankai.ai');
      expect(result).toEqual([
        expect.objectContaining({ name: 'session', value: 'abc123', domain: '.rankai.ai', path: '/', secure: true }),
      ]);
      expect(result[0].expires).toBeGreaterThan(Date.now() / 1000);
    });

    it('parses multiple cookies separated by "; "', () => {
      const result = parseCookieHeader('session=abc123; other=xyz789', 'rankai.ai');
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ name: 'session', value: 'abc123' });
      expect(result[1]).toMatchObject({ name: 'other', value: 'xyz789' });
    });

    it('splits each segment on the FIRST "=" only, preserving "=" characters inside the value', () => {
      const result = parseCookieHeader('token=abc.def=ghi', 'rankai.ai');
      expect(result).toEqual([
        expect.objectContaining({ name: 'token', value: 'abc.def=ghi' }),
      ]);
    });

    it('trims whitespace around segments, names, and values', () => {
      const result = parseCookieHeader('  session = abc123 ;  other=xyz789  ', 'rankai.ai');
      expect(result.map((c) => ({ name: c.name, value: c.value }))).toEqual([
        { name: 'session', value: 'abc123' },
        { name: 'other', value: 'xyz789' },
      ]);
    });

    it('tolerates a trailing semicolon', () => {
      const result = parseCookieHeader('session=abc123;', 'rankai.ai');
      expect(result).toHaveLength(1);
    });

    it('last-wins on duplicate cookie names in one paste', () => {
      const result = parseCookieHeader('session=first; session=second', 'rankai.ai');
      expect(result).toHaveLength(1);
      expect(result[0].value).toBe('second');
    });

    it('lowercases the domain and prefixes it with a leading dot', () => {
      const result = parseCookieHeader('session=abc123', 'RankAI.AI');
      expect(result[0].domain).toBe('.rankai.ai');
    });
  });
});
